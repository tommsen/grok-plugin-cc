#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  getGrokAuthStatus,
  getGrokAvailability,
  importClaudeSession,
  runGrokHeadless
} from "./lib/grok.mjs";
import {
  appendLogLine,
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  createJobLogFile,
  createJobRecord,
  createProgressReporter,
  filterJobsForCurrentClaudeSession,
  findLatestResumableTaskJob,
  getCurrentClaudeSessionId,
  isActiveJobStatus,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  runTrackedJob,
  sortJobsNewestFirst
} from "./lib/jobs.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  listJobs,
  nowIso,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { renderCancelReport, renderJobStatusReport, renderReviewResult, renderSetupReport, renderStatusReport, renderStoredJobResult, renderTaskResult, renderTransferResult } from "./lib/render.mjs";
import { resolveClaudeSessionPath } from "./lib/transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_CONTINUE_PROMPT = "Continue the previous task from where it stopped.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs setup [--json]",
      "  node scripts/grok-companion.mjs review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [focus text]",
      "  node scripts/grok-companion.mjs adversarial-review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [focus text]",
      "  node scripts/grok-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <level>] [prompt]",
      "  node scripts/grok-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/grok-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/grok-companion.mjs result [job-id] [--json]",
      "  node scripts/grok-companion.mjs cancel [job-id] [--json]",
      "  node scripts/grok-companion.mjs task-resume-candidate [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: { C: "cwd", m: "model", ...(config.aliasMap ?? {}) }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function normalizeEffort(effort) {
  if (effort == null || String(effort).trim() === "") {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!VALID_EFFORTS.has(normalized)) {
    throw new Error(`Unsupported reasoning effort "${effort}". Use one of: ${[...VALID_EFFORTS].join(", ")}.`);
  }
  return normalized;
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function ensureGrokAvailable(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Grok CLI is not installed. Install it with `curl -fsSL https://x.ai/cli/install.sh | bash` (or `npm install -g @xai-official/grok`), then rerun /grok:setup."
    );
  }
  return availability;
}

function readReviewSchema() {
  return JSON.parse(fs.readFileSync(REVIEW_SCHEMA_PATH, "utf8"));
}

function parseStructuredOutput(result) {
  if (result.structuredOutput && typeof result.structuredOutput === "object") {
    return { result: result.structuredOutput, rawOutput: result.text, parseError: null };
  }
  const failure = result.error?.message ?? "grok returned no structured output.";
  return { result: null, rawOutput: result.text ?? "", parseError: failure };
}

// --- setup ---------------------------------------------------------------

async function buildSetupReport(cwd) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const grokStatus = getGrokAvailability(cwd);
  const authStatus = getGrokAuthStatus();

  const nextSteps = [];
  if (!grokStatus.available) {
    nextSteps.push("Install the Grok CLI: `curl -fsSL https://x.ai/cli/install.sh | bash` or `npm install -g @xai-official/grok`.");
  }
  if (grokStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Sign in with `!grok login` (or `!grok login --device-auth` on machines without a browser).");
    nextSteps.push("Alternatively export an API key from console.x.ai as `XAI_API_KEY`.");
  }

  return {
    ready: nodeStatus.available && grokStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    grok: grokStatus,
    auth: authStatus,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const report = await buildSetupReport(resolveCommandCwd(options));
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

// --- review --------------------------------------------------------------

function buildReviewPrompt(templateName, reviewKind, context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  return interpolateTemplate(template, {
    REVIEW_KIND: reviewKind,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

async function executeReviewRun(request) {
  ensureGrokAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, { base: request.base, scope: request.scope });
  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(request.templateName, request.reviewName, context, request.focusText ?? "");

  const result = await runGrokHeadless(context.repoRoot, {
    prompt,
    model: request.model,
    mode: "review",
    jsonSchema: readReviewSchema(),
    onProgress: request.onProgress
  });

  const parsed = parseStructuredOutput(result);
  const payload = {
    review: request.reviewName,
    target,
    grokSessionId: result.sessionId,
    context: { repoRoot: context.repoRoot, branch: context.branch, summary: context.summary, inputMode: context.inputMode },
    grok: { status: result.status, stopReason: result.stopReason, warning: result.warning, stderr: result.stderr },
    result: parsed.result,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError
  };

  return {
    exitStatus: result.status,
    grokSessionId: result.sessionId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: request.reviewName,
      targetLabel: context.target.label,
      grokSessionId: result.sessionId,
      warning: result.warning
    }),
    summary: parsed.result?.summary ?? parsed.parseError ?? `${request.reviewName} finished.`,
    jobTitle: `Grok ${request.reviewName}`,
    jobClass: "review"
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  const progress = createProgressReporter({ logFile, workspaceRoot: job.workspaceRoot, jobId: job.id });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });

  const job = createJobRecord({
    prefix: "review",
    kind: config.kind,
    title: `Grok ${config.reviewName}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${config.reviewName} of ${target.label}`
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        templateName: config.templateName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

// --- task ----------------------------------------------------------------

function buildTaskRunMetadata({ prompt, resumeLast }) {
  const title = resumeLast ? "Grok Resume" : "Grok Task";
  return {
    title,
    summary: shorten(prompt || (resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task"))
  };
}

function resolveLatestTaskGrokSession(workspaceRoot, options = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /grok:status before continuing it.`);
  }
  return findLatestResumableTaskJob(visibleJobs)?.grokSessionId ?? null;
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGrokAvailable(request.cwd);

  let resumeSessionId = null;
  if (request.resumeLast) {
    resumeSessionId = resolveLatestTaskGrokSession(workspaceRoot, { excludeJobId: request.jobId });
    if (!resumeSessionId) {
      throw new Error("No previous Grok task session was found for this repository.");
    }
  }

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, or use --resume-last.");
  }

  const result = await runGrokHeadless(workspaceRoot, {
    prompt: request.prompt || DEFAULT_CONTINUE_PROMPT,
    model: request.model,
    effort: request.effort,
    resumeSessionId,
    mode: request.write ? "task-write" : "task-read",
    onProgress: request.onProgress
  });

  const taskMetadata = buildTaskRunMetadata({ prompt: request.prompt, resumeLast: request.resumeLast });
  const failureMessage = result.error?.message ?? null;
  const rendered = renderTaskResult(
    { rawOutput: result.text, failureMessage, grokSessionId: result.sessionId, warning: result.warning },
    { title: taskMetadata.title, jobId: request.jobId ?? null, write: Boolean(request.write) }
  );

  return {
    exitStatus: result.status,
    grokSessionId: result.sessionId,
    payload: {
      status: result.status,
      stopReason: result.stopReason,
      warning: result.warning,
      grokSessionId: result.sessionId,
      rawOutput: result.text
    },
    rendered,
    summary: firstMeaningfulLine(result.text, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  return positionals.join(" ").trim();
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "grok-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const effort = normalizeEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  if (resumeLast && options.fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });

  const job = createJobRecord({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });

  const request = {
    cwd,
    model: options.model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId: job.id
  };

  if (options.background) {
    ensureGrokAvailable(cwd);
    if (!prompt && !resumeLast) {
      throw new Error("Provide a prompt, a prompt file, or use --resume-last.");
    }

    const logFile = createJobLogFile(workspaceRoot, job.id, job.title);
    appendLogLine(logFile, "Queued for background execution.");
    const child = spawnDetachedTaskWorker(cwd, job.id);
    const queuedRecord = {
      ...job,
      status: "queued",
      phase: "queued",
      pid: child.pid ?? null,
      logFile,
      request
    };
    writeJobFile(workspaceRoot, job.id, queuedRecord);
    upsertJob(workspaceRoot, queuedRecord);

    const payload = { jobId: job.id, status: "queued", title: job.title, summary: job.summary, logFile };
    outputResult(
      options.json
        ? payload
        : `${job.title} started in the background as ${job.id}. Check /grok:status ${job.id} for progress.\n`,
      options.json
    );
    return;
  }

  await runForegroundCommand(job, (progress) => executeTaskRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const logFile = storedJob.logFile ?? createJobLogFile(workspaceRoot, storedJob.id, storedJob.title);
  const progress = createProgressReporter({ logFile, workspaceRoot, jobId: storedJob.id });
  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () => executeTaskRun({ ...request, onProgress: progress }),
    { logFile }
  );
}

// --- transfer ------------------------------------------------------------

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  ensureGrokAvailable(cwd);
  const sourcePath = resolveClaudeSessionPath(cwd, { source: options.source });
  const imported = await importClaudeSession(cwd, sourcePath);

  const payload = {
    grokSessionId: imported.sessionId,
    messageCount: imported.messageCount ?? null,
    sourcePath,
    resumeCommand: `grok --resume ${imported.sessionId}`
  };
  outputResult(options.json ? payload : renderTransferResult(payload), options.json);
}

// --- status / result / cancel ---------------------------------------------

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    outputResult(options.json ? snapshot : renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveResultJob(cwd, positionals[0] ?? "");
  const storedJob = readStoredJob(workspaceRoot, job.id);
  outputResult(options.json ? { job, storedJob } : renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId: getCurrentClaudeSessionId(),
    candidate: candidate
      ? {
          id: candidate.id,
          status: candidate.status,
          title: candidate.title ?? null,
          summary: candidate.summary ?? null,
          grokSessionId: candidate.grokSessionId,
          completedAt: candidate.completedAt ?? null
        }
      : null
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputResult(options.json ? payload : rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveCancelableJob(cwd, positionals[0] ?? "");
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const record = {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  };
  writeJobFile(workspaceRoot, job.id, { ...existing, ...job, ...record, cancelledAt: completedAt });
  upsertJob(workspaceRoot, record);

  const payload = { jobId: job.id, status: "cancelled", title: job.title };
  outputResult(options.json ? payload : renderCancelReport({ ...job, ...record }), options.json);
}

// --- main ------------------------------------------------------------------

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReviewCommand(argv, { reviewName: "Review", templateName: "review", kind: "review" });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review",
        templateName: "adversarial-review",
        kind: "adversarial-review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
