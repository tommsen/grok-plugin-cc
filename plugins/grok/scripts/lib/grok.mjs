import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { binaryAvailable } from "./process.mjs";

export const GROK_BIN = process.env.GROK_COMPANION_GROK_BIN || "grok";

// Verified against grok 0.2.x tool IDs. `--tools` is an allowlist: reviews get
// read-only repo access with no shell, no writes, and no subagents, enforced
// regardless of whether the OS sandbox (Landlock/Seatbelt) is available.
export const REVIEW_TOOL_ALLOWLIST = "read_file,grep,list_dir";
// Investigation tasks keep the shell for running tests/git, but lose the
// direct file-mutation tools. Combined with `--sandbox read-only` (kernel
// enforced where available) this keeps default rescues from editing files.
export const TASK_READ_DISALLOWED_TOOLS = "search_replace,write";

const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_TURNS = 50;

// Prompts longer than this go to grok through `--prompt-file` instead of `-p`.
// Windows caps the whole command line at 32767 UTF-16 units, and a review
// prompt carries the full diff, so anything past ~32 KB died in spawn() with
// ENAMETOOLONG before grok ever ran. The cap counts after quoting, which can
// double backslashes and quotes, and the JSON schema and flags need room too
// -- hence a margin far below the hard limit. Linux has its own per-argument
// cap (128 KiB), so the file route is used on every platform. Short prompts
// keep `-p`, so nothing changes for them.
export const PROMPT_ARG_MAX_CHARS = 8000;

export function shouldUsePromptFile(prompt) {
  return String(prompt ?? "").length > PROMPT_ARG_MAX_CHARS;
}

// Writes the prompt to a private temp directory and returns its path plus a
// cleanup function. UTF-8, no BOM: grok reads the file verbatim.
export function writePromptFile(prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-companion-prompt-"));
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, String(prompt ?? ""), { encoding: "utf8", mode: 0o600 });
  return {
    file,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// grok exits 0 even when it aborted the run: a failed device login came back
// as {"text": "", "stopReason": "Cancelled"} with exit status 0 (measured
// 2026-08-10, Projects/Grok). The CLI also mixes spellings -- "end_turn" next
// to "Cancelled" -- so reasons are compared after normalising.
const FAILURE_STOP_REASONS = new Set(["cancelled", "error", "refusal"]);

export function normalizeStopReason(value) {
  return String(value ?? "").replace(/[_\s-]/g, "").toLowerCase();
}

const TURN_LIMIT_WARNING = "grok hit its turn limit; the answer may be incomplete.";

// Decides whether a run that exited cleanly actually produced an answer.
// `failure` turns the run into an error; `warning` is passed through to the
// caller without failing it.
//
// The turn limit has no stopReason of its own. Measured 2026-10-18 with
// `--max-turns 1`: streaming-json ends with exit 0, stopReason "cancelled"
// (lowercase) and num_turns equal to the limit; json mode exits 1 with
// "Error: max turns reached" on stderr. "cancelled" is also what an aborted
// sign-in returns, so the stopReason alone cannot tell them apart -- num_turns
// reaching maxTurns does. "maxturns" stays recognised in case another grok
// build spells it out.
export function classifyCompletion({ stopReason, text, structuredOutput, numTurns, maxTurns }) {
  const normalized = normalizeStopReason(stopReason);
  const hasText = String(text ?? "").trim() !== "";
  const hitTurnLimit =
    normalized === "maxturns" ||
    (normalized === "cancelled" && Number.isFinite(numTurns) && Number.isFinite(maxTurns) && numTurns >= maxTurns);

  if (hitTurnLimit && (hasText || structuredOutput)) {
    return { failure: null, warning: TURN_LIMIT_WARNING };
  }
  if (hitTurnLimit) {
    return { failure: "grok hit its turn limit before it produced an answer.", warning: null };
  }
  if (FAILURE_STOP_REASONS.has(normalized)) {
    const hint =
      normalized === "cancelled" ? " Cancelled usually means grok could not authenticate; run /grok:setup." : "";
    return { failure: `grok stopped the run (stopReason: ${stopReason}).${hint}`, warning: null };
  }
  if (!hasText && !structuredOutput) {
    return { failure: `grok returned an empty response (stopReason: ${stopReason ?? "none"}).`, warning: null };
  }
  return { failure: null, warning: null };
}

// grok enforces `--sandbox` with a per-platform kernel mechanism, and on Linux
// that mechanism is bubblewrap. When `bwrap` is missing grok does not warn and
// continue -- it refuses to start:
//
//   error: this sandbox could not enforce its deny list on Linux: bwrap exec
//   failed: No such file or directory (os error 2). Install bubblewrap with
//   `apt install -y bubblewrap`. Refusing to start with denied paths
//   unprotected.
//
// Exit 1, empty stdout. Plain Debian/Ubuntu and WSL images do not ship it, so
// every sandboxed invocation failed on those machines with the cause several
// layers from the symptom. Reported by @roy7 in #1 with a live repro.
//
// macOS (Seatbelt) and Windows need no extra package, so only Linux is probed.
const LINUX_SANDBOX_ENFORCER = "bwrap";

// GROK_COMPANION_SANDBOX overrides the probe: "off" for a machine that cannot
// install the enforcer, "on" for a distro that enforces through something the
// probe does not recognise. Unset means probe.
export function sandboxEnforcerAvailable(platform = process.platform) {
  const override = String(process.env.GROK_COMPANION_SANDBOX ?? "").toLowerCase();
  if (["0", "off", "false", "none"].includes(override)) {
    return false;
  }
  if (["1", "on", "true", "force"].includes(override)) {
    return true;
  }
  if (platform !== "linux") {
    return true;
  }
  return binaryAvailable(LINUX_SANDBOX_ENFORCER, ["--version"]).available;
}

export const SANDBOX_MISSING_HINT =
  `the Linux sandbox enforcer (${LINUX_SANDBOX_ENFORCER}) is not installed; ` +
  "install it with `apt install -y bubblewrap` (or the equivalent for your distro)";

export function getGrokAvailability(cwd) {
  const status = binaryAvailable(GROK_BIN, ["--version"], { cwd });
  return {
    available: status.available,
    version: status.version,
    bin: GROK_BIN
  };
}

export function resolveGrokHome() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

// The grok CLI authenticates from ~/.grok/auth.json (`grok login`). Measured on
// 2026-09-27: it ran without XAI_API_KEY and also with a deliberately invalid
// key, so the variable is reported but never counted as a sign-in. Whether a
// key alone works without auth.json is not measured -- only a live probe
// (probeGrokAuth) settles whether grok can actually answer.
export function getGrokAuthStatus() {
  const apiKeySet = Boolean(process.env.XAI_API_KEY);
  const authFile = path.join(resolveGrokHome(), "auth.json");
  try {
    const stat = fs.statSync(authFile);
    if (stat.isFile() && stat.size > 2) {
      return { loggedIn: true, method: "oauth", authFile, apiKeySet };
    }
  } catch {
    // No cached credentials.
  }
  return { loggedIn: false, method: null, authFile, apiKeySet };
}

function buildBaseEnv(extraEnv = {}) {
  return {
    ...process.env,
    GROK_DISABLE_AUTOUPDATER: "1",
    ...extraEnv
  };
}

function truncate(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export function buildHeadlessArgs(options = {}) {
  const args = [];
  const resuming = Boolean(options.resumeSessionId);
  // Injectable so the unit suite can exercise both machines. Callers leave it
  // unset and get the real probe.
  const sandboxed = options.sandboxEnforced ?? sandboxEnforcerAvailable();

  if (resuming) {
    args.push("--resume", String(options.resumeSessionId));
  }
  // grok rejects `-p` together with `--prompt-file`, so exactly one is passed.
  if (options.promptFile) {
    args.push("--prompt-file", String(options.promptFile));
  } else {
    args.push("-p", String(options.prompt ?? ""));
  }
  args.push("--no-auto-update");

  if (options.model) {
    args.push("-m", String(options.model));
  }
  if (options.effort) {
    args.push("--effort", String(options.effort));
  }
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  if (maxTurns) {
    args.push("--max-turns", String(maxTurns));
  }

  if (options.jsonSchema) {
    // --json-schema implies --output-format json; the response object carries
    // a validated `structuredOutput` field.
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
    args.push("--output-format", "json");
  } else {
    args.push("--output-format", "streaming-json");
  }

  switch (options.mode) {
    case "review":
      args.push("--tools", REVIEW_TOOL_ALLOWLIST);
      args.push("--always-approve");
      break;
    case "task-read":
      // The deny list is the primary guard here and does not need the kernel,
      // so a machine without the enforcer still runs -- with one belt instead
      // of two. Dropping the flag is what keeps grok from refusing to start.
      if (sandboxed && !resuming) {
        args.push("--sandbox", "read-only");
      }
      args.push("--disallowed-tools", TASK_READ_DISALLOWED_TOOLS);
      args.push("--always-approve");
      break;
    case "task-write":
      // Here the sandbox is the only thing keeping writes inside the
      // workspace. Degrading silently would hand an agent the whole disk, so
      // this fails with the fix in the message instead.
      if (!sandboxed) {
        throw new Error(
          `grok task-write needs a workspace sandbox and ${SANDBOX_MISSING_HINT}.`
        );
      }
      if (!resuming) {
        args.push("--sandbox", "workspace");
      }
      args.push("--always-approve");
      break;
    default:
      throw new Error(`Unknown grok run mode: ${options.mode}`);
  }

  return args;
}

function parseSingleJsonResult(stdout) {
  const raw = String(stdout ?? "").trim();
  if (!raw) {
    return { error: "grok produced no output." };
  }
  // The device-login flow prints plain text before the JSON body, so parse
  // from the first line that opens an object.
  const start = raw.search(/^\{/m);
  const body = start > 0 ? raw.slice(start) : raw;
  try {
    return { value: JSON.parse(body) };
  } catch {
    return { error: `grok produced unparseable output: ${truncate(raw, 400)}` };
  }
}

function newStreamResult() {
  return { text: "", sessionId: null, stopReason: null, errorMessage: null, numTurns: null, costUsd: null };
}

function parseStreamEvents(stdout, onProgress) {
  const result = newStreamResult();
  for (const line of String(stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    applyStreamEvent(result, event, onProgress);
  }
  return result;
}

function applyStreamEvent(result, event, onProgress) {
  switch (event.type) {
    case "text":
      result.text += String(event.data ?? "");
      break;
    case "thought":
      onProgress?.({ phase: "thinking", detail: truncate(event.data, 160) });
      break;
    case "end":
      result.sessionId = event.sessionId ?? result.sessionId;
      result.stopReason = event.stopReason ?? result.stopReason;
      // The end event carries the turn count and cost (measured 2026-10-18).
      result.numTurns = Number.isFinite(event.num_turns) ? event.num_turns : result.numTurns;
      result.costUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : result.costUsd;
      break;
    case "error":
      result.errorMessage = String(event.message ?? "grok reported an error.");
      break;
    default:
      break;
  }
}

export function runGrokHeadless(cwd, options = {}) {
  const promptFile = shouldUsePromptFile(options.prompt) ? writePromptFile(options.prompt) : null;
  let args;
  try {
    args = buildHeadlessArgs({ ...options, promptFile: promptFile?.file });
  } catch (error) {
    promptFile?.cleanup();
    throw error;
  }
  const streaming = !options.jsonSchema;

  return new Promise((rawResolve) => {
    // Every exit path goes through here, so the prompt file never outlives
    // the run. `error` and `close` can both fire; cleanup is idempotent.
    const resolve = (value) => {
      promptFile?.cleanup();
      rawResolve(value);
    };
    // spawn() throws synchronously for some failures (ENAMETOOLONG among
    // them) instead of emitting `error`; catch it so the prompt file is
    // still removed, then rethrow -- the promise rejects as it did before.
    let child;
    try {
      child = spawn(GROK_BIN, args, {
        cwd,
        env: buildBaseEnv(options.env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      promptFile?.cleanup();
      throw error;
    }

    let stdout = "";
    let stderr = "";
    let streamBuffer = "";
    const streamResult = newStreamResult();

    options.onProgress?.({ phase: "started", detail: `grok pid ${child.pid}` });

    child.stdout.on("data", (chunk) => {
      const data = chunk.toString();
      stdout += data;
      if (!streaming) {
        return;
      }
      streamBuffer += data;
      let newlineIndex = streamBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = streamBuffer.slice(0, newlineIndex).trim();
        streamBuffer = streamBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            applyStreamEvent(streamResult, JSON.parse(line), options.onProgress);
          } catch {
            // Ignore non-JSON noise on stdout.
          }
        }
        newlineIndex = streamBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString();
      }
    });

    // Every result carries the same fields, so callers never test for
    // undefined. `stderr` is read at call time, after it has been collected.
    // This goes through the cleaning `resolve` above, never `rawResolve`.
    const finish = (fields) =>
      resolve({
        status: 1,
        text: "",
        sessionId: null,
        stopReason: null,
        structuredOutput: null,
        stderr,
        warning: null,
        costUsd: null,
        error: null,
        ...fields
      });

    child.on("error", (error) => {
      finish({ error: { message: `Failed to start grok: ${error.message}` } });
    });

    child.on("close", (code) => {
      const status = code ?? 1;
      const exitFailure = status !== 0 ? truncate(stderr.trim(), 400) || `grok exited with status ${status}` : null;

      if (streaming) {
        if (streamBuffer.trim()) {
          try {
            applyStreamEvent(streamResult, JSON.parse(streamBuffer.trim()), options.onProgress);
          } catch {
            // Trailing partial line; ignore.
          }
        }
        const completion = classifyCompletion({
          stopReason: streamResult.stopReason,
          text: streamResult.text,
          numTurns: streamResult.numTurns,
          maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS
        });
        const failure = streamResult.errorMessage ?? exitFailure ?? completion.failure;
        finish({
          // A failure must never look like success to the caller's exit code.
          status: failure && status === 0 ? 1 : status,
          text: streamResult.text,
          sessionId: streamResult.sessionId,
          stopReason: streamResult.stopReason,
          warning: failure ? null : completion.warning,
          costUsd: streamResult.costUsd,
          error: failure ? { message: failure } : null
        });
        return;
      }

      const parsed = parseSingleJsonResult(stdout);
      if (parsed.error) {
        finish({ status: status || 1, error: { message: exitFailure || parsed.error } });
        return;
      }

      const value = parsed.value;
      if (value.type === "error") {
        finish({ status: status || 1, error: { message: String(value.message ?? "grok reported an error.") } });
        return;
      }

      let structuredOutput = value.structuredOutput ?? null;
      if (!structuredOutput && options.jsonSchema && typeof value.text === "string") {
        try {
          structuredOutput = JSON.parse(value.text);
        } catch {
          structuredOutput = null;
        }
      }

      const completion = classifyCompletion({
        stopReason: value.stopReason,
        text: value.text,
        structuredOutput,
        numTurns: value.num_turns,
        maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS
      });
      const failure = exitFailure ?? completion.failure;
      finish({
        status: failure && status === 0 ? 1 : status,
        text: String(value.text ?? ""),
        sessionId: value.sessionId ?? null,
        stopReason: value.stopReason ?? null,
        structuredOutput,
        warning: failure ? null : completion.warning,
        costUsd: typeof value.total_cost_usd === "number" ? value.total_cost_usd : null,
        error: failure ? { message: failure } : null
      });
    });
  });
}

// A real, cheap round trip (~$0.03, measured 2026-10-18). A schema forces the
// JSON output format, which is the one that reports total_cost_usd.
const AUTH_PROBE_PROMPT = 'Reply with the JSON object {"answer":"OK"} and nothing else.';
const AUTH_PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } }
};

export async function probeGrokAuth(cwd) {
  const result = await runGrokHeadless(cwd, {
    prompt: AUTH_PROBE_PROMPT,
    mode: "review",
    jsonSchema: AUTH_PROBE_SCHEMA,
    maxTurns: 2
  });
  return {
    ok: result.status === 0 && !result.error,
    stopReason: result.stopReason,
    costUsd: result.costUsd,
    error: result.error?.message ?? null
  };
}

export function importClaudeSession(cwd, transcriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(GROK_BIN, ["import", "--json", transcriptPath], {
      cwd,
      env: buildBaseEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString();
      }
    });
    child.on("error", (error) => {
      reject(new Error(`Failed to start grok import: ${error.message}`));
    });
    child.on("close", (code) => {
      const records = String(stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const imported = records.find((record) => record.outcome === "imported");
      if (imported) {
        resolve(imported);
        return;
      }

      const skipped = records.find((record) => record.outcome && record.outcome !== "imported");
      const detail = skipped?.error || truncate(stderr.trim(), 400) || `grok import exited with status ${code}`;
      reject(new Error(`grok could not import the Claude session: ${detail}`));
    });
  });
}
