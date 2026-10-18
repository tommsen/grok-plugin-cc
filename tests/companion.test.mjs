import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { createFakeGrok, createTempDir, createTempGitRepo, runCompanion } from "./helpers.mjs";

let tempDir;
let fake;
let repoDir;
let baseEnv;

before(() => {
  tempDir = createTempDir();
  fake = createFakeGrok(tempDir);
  ({ repoDir } = createTempGitRepo(tempDir));
  baseEnv = {
    ...fake.env,
    CLAUDE_PLUGIN_DATA: path.join(tempDir, "plugin-data"),
    XAI_API_KEY: "xai-test-key"
  };
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function runJson(args, env = {}) {
  const result = runCompanion([...args, "--json"], { cwd: repoDir, env: { ...baseEnv, ...env } });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("setup reports ready with fake grok and API key", () => {
  const report = runJson(["setup"]);
  assert.equal(report.ready, true);
  assert.equal(report.grok.available, true);
  assert.equal(report.auth.method, "api-key");
});

test("review runs against a dirty working tree and stores a job", () => {
  fs.writeFileSync(path.join(repoDir, "app.js"), "console.log('reviewed');\n");
  const payload = runJson(["review"]);

  assert.equal(payload.review, "Review");
  assert.equal(payload.result.verdict, "approve");
  assert.equal(payload.grokSessionId, "fake-session-json");

  const reviewCall = fake.readCalls().find((call) => call.includes("--json-schema"));
  assert.ok(reviewCall, "grok should be invoked with --json-schema");
  assert.ok(reviewCall.includes("--tools"), "review must pass the read-only tool allowlist");
  const promptIndex = reviewCall.indexOf("-p");
  assert.match(reviewCall[promptIndex + 1], /adversarial|rigorous code review/i);

  const status = runJson(["status"]);
  assert.equal(status.jobs[0].status, "completed");
  assert.equal(status.jobs[0].jobClass, "review");
});

test("adversarial review forwards focus text into the prompt", () => {
  const payload = runJson(["adversarial-review", "challenge", "the", "retry", "design"]);
  assert.equal(payload.review, "Adversarial Review");

  const calls = fake.readCalls();
  const lastReview = [...calls].reverse().find((call) => call.includes("--json-schema"));
  const prompt = lastReview[lastReview.indexOf("-p") + 1];
  assert.match(prompt, /challenge the retry design/);
  assert.match(prompt, /adversarial/i);
});

test("task runs foreground, records grok session, and resume-last reuses it", () => {
  const payload = runJson(["task", "investigate", "the", "flaky", "test"]);
  assert.equal(payload.status, 0);
  assert.equal(payload.grokSessionId, "fake-session-stream");

  const candidate = runJson(["task-resume-candidate"]);
  assert.equal(candidate.available, true);
  assert.equal(candidate.candidate.grokSessionId, "fake-session-stream");

  runJson(["task", "--resume-last", "keep", "going"]);
  const calls = fake.readCalls();
  const resumed = [...calls].reverse().find((call) => call.includes("--resume"));
  assert.equal(resumed[resumed.indexOf("--resume") + 1], "fake-session-stream");
});

// The fake grok cannot tell us whether this machine can enforce a sandbox, so
// the env override stands in for the machine. Both shapes are covered on
// purpose: CI images and plain Debian/Ubuntu/WSL do not ship bubblewrap, and a
// suite that only ever saw the sandboxed machine is why #1 shipped.
test("task --write switches to the workspace sandbox", () => {
  runJson(["task", "--write", "fix", "the", "bug"], { GROK_COMPANION_SANDBOX: "on" });
  const calls = fake.readCalls();
  const writeCall = [...calls].reverse().find((call) => call.includes("--sandbox"));
  assert.equal(writeCall[writeCall.indexOf("--sandbox") + 1], "workspace");
});

test("task --write refuses on a machine with no sandbox enforcer", () => {
  const result = runCompanion(["task", "--write", "fix", "the", "bug", "--json"], {
    cwd: repoDir,
    env: { ...baseEnv, GROK_COMPANION_SANDBOX: "off" }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /workspace sandbox/);
  assert.match(result.stderr, /bubblewrap/, "the message has to carry the fix");
});

test("task read-only still runs with no sandbox enforcer", () => {
  const payload = runJson(["task", "look", "around"], { GROK_COMPANION_SANDBOX: "off" });
  assert.ok(payload);
  const call = [...fake.readCalls()].reverse().find((c) => c.includes("--disallowed-tools"));
  assert.ok(call, "the deny list is still the guard");
  assert.ok(!call.includes("--sandbox"), "an unenforceable sandbox flag must not be sent");
});

test("background task queues a job that the worker completes", async () => {
  const payload = runJson(["task", "--background", "long", "running", "investigation"]);
  assert.equal(payload.status, "queued");

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshot = runJson(["status", payload.jobId]);
    if (snapshot.job.status === "completed") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const finished = runJson(["status", payload.jobId]);
  assert.equal(finished.job.status, "completed", JSON.stringify(finished.job));

  const result = runJson(["result", payload.jobId]);
  assert.equal(result.storedJob.payload.grokSessionId, "fake-session-stream");
});

test("result without id returns the latest finished job", () => {
  const result = runJson(["result"]);
  assert.ok(result.job.id);
  assert.notEqual(result.job.status, "running");
});

test("cancel refuses when nothing is active", () => {
  const result = runCompanion(["cancel"], { cwd: repoDir, env: baseEnv });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No active jobs/);
});

test("transfer imports the transcript recorded by the session hook", () => {
  const fakeHome = path.join(tempDir, "home");
  const projectsDir = path.join(fakeHome, ".claude", "projects", "-tmp-repo");
  fs.mkdirSync(projectsDir, { recursive: true });
  const transcript = path.join(projectsDir, "11111111-2222-3333-4444-555555555555.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: "hi" })}\n`);

  const payload = runJson(["transfer"], {
    HOME: fakeHome,
    GROK_COMPANION_TRANSCRIPT_PATH: transcript
  });
  assert.equal(payload.grokSessionId, "fake-imported-session");
  assert.equal(payload.resumeCommand, "grok --resume fake-imported-session");

  const importCall = fake.readCalls().find((call) => call[0] === "import");
  assert.ok(importCall.includes(transcript));
});

test("transfer rejects transcripts outside ~/.claude/projects", () => {
  const fakeHome = path.join(tempDir, "home");
  const outside = path.join(tempDir, "outside.jsonl");
  fs.writeFileSync(outside, "{}\n");

  const result = runCompanion(["transfer", "--source", outside], {
    cwd: repoDir,
    env: { ...baseEnv, HOME: fakeHome }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from/);
});

test("a cancelled grok run makes the companion exit non-zero", () => {
  const result = runCompanion(["task", "look", "around", "--json"], {
    cwd: repoDir,
    env: { ...baseEnv, FAKE_GROK_STREAM_OUTPUT: `${JSON.stringify({ type: "end", stopReason: "Cancelled", sessionId: "s" })}\n` }
  });
  assert.notEqual(result.status, 0, "Claude must see the failure in the exit code");
  assert.equal(JSON.parse(result.stdout).stopReason, "Cancelled");
});

test("setup degrades gracefully when grok is missing", () => {
  const emptyBin = path.join(tempDir, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  const nodeDir = path.dirname(process.execPath);
  const report = runJson(["setup"], { PATH: `${emptyBin}${path.delimiter}${nodeDir}` });
  assert.equal(report.ready, false);
  assert.equal(report.grok.available, false);
  assert.match(report.nextSteps.join(" "), /Install the Grok CLI/);
});
