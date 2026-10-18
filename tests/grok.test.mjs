import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  PROMPT_ARG_MAX_CHARS,
  REVIEW_TOOL_ALLOWLIST,
  TASK_READ_DISALLOWED_TOOLS,
  buildHeadlessArgs,
  classifyCompletion,
  normalizeStopReason,
  sandboxEnforcerAvailable,
  importClaudeSession,
  runGrokHeadless,
  shouldUsePromptFile,
  writePromptFile
} from "../plugins/grok/scripts/lib/grok.mjs";
import { createFakeGrok, createTempDir } from "./helpers.mjs";

let tempDir;
let fake;
let savedPath;

before(() => {
  tempDir = createTempDir();
  fake = createFakeGrok(tempDir);
  savedPath = process.env.PATH;
  process.env.PATH = fake.env.PATH;
  process.env.FAKE_GROK_CALLS_FILE = fake.env.FAKE_GROK_CALLS_FILE;
});

after(() => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_GROK_CALLS_FILE;
  delete process.env.FAKE_GROK_JSON_OUTPUT;
  delete process.env.FAKE_GROK_STREAM_OUTPUT;
  delete process.env.FAKE_GROK_EXIT_CODE;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function pairValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

test("review mode enforces the read-only tool allowlist", () => {
  const args = buildHeadlessArgs({ prompt: "review this", mode: "review", jsonSchema: { type: "object" } });
  assert.equal(pairValue(args, "--tools"), REVIEW_TOOL_ALLOWLIST);
  assert.equal(pairValue(args, "--output-format"), "json");
  assert.ok(args.includes("--json-schema"));
  assert.ok(args.includes("--always-approve"));
  assert.ok(!args.includes("--sandbox"), "review must rely on the allowlist, not the sandbox");
});

test("task-read mode combines sandbox and write-tool denylist", () => {
  const args = buildHeadlessArgs({ prompt: "investigate", mode: "task-read", sandboxEnforced: true });
  assert.equal(pairValue(args, "--sandbox"), "read-only");
  assert.equal(pairValue(args, "--disallowed-tools"), TASK_READ_DISALLOWED_TOOLS);
  assert.equal(pairValue(args, "--output-format"), "streaming-json");
});

test("task-write mode uses the workspace sandbox", () => {
  const args = buildHeadlessArgs({
    prompt: "fix it", mode: "task-write", model: "grok-4", effort: "high", sandboxEnforced: true
  });
  assert.equal(pairValue(args, "--sandbox"), "workspace");
  assert.equal(pairValue(args, "-m"), "grok-4");
  assert.equal(pairValue(args, "--effort"), "high");
});

// Without a kernel enforcer grok refuses to start rather than warning, so a
// flag we cannot back up is a flag we must not send. #1.
test("task-read drops the sandbox when the enforcer is missing, and keeps the deny list", () => {
  const args = buildHeadlessArgs({ prompt: "investigate", mode: "task-read", sandboxEnforced: false });
  assert.ok(!args.includes("--sandbox"), "an unenforceable sandbox flag must not be sent");
  assert.equal(pairValue(args, "--disallowed-tools"), TASK_READ_DISALLOWED_TOOLS,
    "the tool-level guard is what still stops writes");
});

test("task-write refuses rather than running unsandboxed", () => {
  assert.throws(
    () => buildHeadlessArgs({ prompt: "fix it", mode: "task-write", sandboxEnforced: false }),
    /needs a workspace sandbox.*bubblewrap/s,
    "the workspace sandbox is the only guard on writes; degrading it silently is worse than failing"
  );
});

// Passing a profile that differs from the session's saved one is a hard error,
// and omitting it on resume is always accepted. So never re-assert it.
test("resuming does not re-assert a sandbox profile", () => {
  for (const mode of ["task-read", "task-write"]) {
    const args = buildHeadlessArgs({
      prompt: "continue", mode, resumeSessionId: "abc123", sandboxEnforced: true
    });
    assert.ok(!args.includes("--sandbox"), `${mode} must not re-send --sandbox on resume`);
  }
});

test("the enforcer probe honours GROK_COMPANION_SANDBOX", () => {
  const saved = process.env.GROK_COMPANION_SANDBOX;
  try {
    process.env.GROK_COMPANION_SANDBOX = "off";
    assert.equal(sandboxEnforcerAvailable("darwin"), false);
    process.env.GROK_COMPANION_SANDBOX = "on";
    assert.equal(sandboxEnforcerAvailable("linux"), true);
    delete process.env.GROK_COMPANION_SANDBOX;
    assert.equal(sandboxEnforcerAvailable("darwin"), true, "only Linux needs a package");
  } finally {
    if (saved === undefined) delete process.env.GROK_COMPANION_SANDBOX;
    else process.env.GROK_COMPANION_SANDBOX = saved;
  }
});

test("resume flag precedes the prompt", () => {
  const args = buildHeadlessArgs({ prompt: "continue", mode: "task-read", resumeSessionId: "abc123" });
  assert.ok(args.indexOf("--resume") < args.indexOf("-p"));
  assert.equal(pairValue(args, "--resume"), "abc123");
});

test("a prompt file replaces -p and still follows --resume", () => {
  const args = buildHeadlessArgs({
    prompt: "ignored when a file is given",
    promptFile: "/tmp/prompt.md",
    mode: "task-read",
    resumeSessionId: "abc123"
  });
  // grok refuses `-p` and `--prompt-file` together.
  assert.equal(args.includes("-p"), false);
  assert.equal(pairValue(args, "--prompt-file"), "/tmp/prompt.md");
  assert.ok(args.indexOf("--resume") < args.indexOf("--prompt-file"));
});

test("only prompts past the limit go through a file", () => {
  assert.equal(shouldUsePromptFile("x".repeat(PROMPT_ARG_MAX_CHARS)), false);
  assert.equal(shouldUsePromptFile("x".repeat(PROMPT_ARG_MAX_CHARS + 1)), true);
  assert.equal(shouldUsePromptFile(undefined), false);
});

test("writePromptFile keeps UTF-8 intact and cleanup removes it", () => {
  const text = "Prüfe Größe — ✓";
  const handle = writePromptFile(text);
  const bytes = fs.readFileSync(handle.file);
  assert.notEqual(bytes[0], 0xef, "no UTF-8 BOM");
  assert.equal(bytes.toString("utf8"), text);
  handle.cleanup();
  assert.equal(fs.existsSync(path.dirname(handle.file)), false);
  handle.cleanup(); // idempotent
});

test("runGrokHeadless hands an oversized prompt over as a file and removes it", async () => {
  // 200k chars exceeds both the Windows command-line cap (32767) and the Linux
  // per-argument cap (128 KiB): with `-p` this dies in spawn on either system.
  const prompt = `review start ${"diff line\n".repeat(20000)} review end`;
  const copy = path.join(tempDir, "prompt-copy.md");
  process.env.FAKE_GROK_PROMPT_COPY = copy;
  try {
    const result = await runGrokHeadless(tempDir, { prompt, mode: "review", jsonSchema: { type: "object" } });
    assert.equal(result.status, 0, result.error?.message);
    assert.equal(result.structuredOutput.verdict, "approve");
  } finally {
    delete process.env.FAKE_GROK_PROMPT_COPY;
  }

  const call = fake.readCalls().at(-1);
  assert.equal(call.includes("-p"), false);
  const handedOver = pairValue(call, "--prompt-file");
  assert.ok(handedOver, "grok should get --prompt-file");
  assert.equal(fs.readFileSync(copy, "utf8"), prompt);
  assert.equal(fs.existsSync(handedOver), false, "prompt file must be gone after the run");
});

test("runGrokHeadless keeps -p for short prompts", async () => {
  await runGrokHeadless(tempDir, { prompt: "short", mode: "task-read" });
  const call = fake.readCalls().at(-1);
  assert.equal(pairValue(call, "-p"), "short");
  assert.equal(call.includes("--prompt-file"), false);
});

test("unknown mode is rejected", () => {
  assert.throws(() => buildHeadlessArgs({ prompt: "x", mode: "yolo-everything" }), /Unknown grok run mode/);
});

test("runGrokHeadless parses streaming output", async () => {
  const result = await runGrokHeadless(tempDir, { prompt: "hello", mode: "task-read" });
  assert.equal(result.status, 0);
  assert.equal(result.text, "fake stream response");
  assert.equal(result.sessionId, "fake-session-stream");
  assert.equal(result.error, null);
});

test("runGrokHeadless parses structured output in schema mode", async () => {
  const result = await runGrokHeadless(tempDir, {
    prompt: "review",
    mode: "review",
    jsonSchema: { type: "object" }
  });
  assert.equal(result.status, 0);
  assert.equal(result.sessionId, "fake-session-json");
  assert.equal(result.structuredOutput.verdict, "approve");
});

test("runGrokHeadless surfaces error objects from grok", async () => {
  process.env.FAKE_GROK_JSON_OUTPUT = JSON.stringify({ type: "error", message: "Couldn't start session" });
  process.env.FAKE_GROK_EXIT_CODE = "1";
  const result = await runGrokHeadless(tempDir, {
    prompt: "review",
    mode: "review",
    jsonSchema: { type: "object" }
  });
  delete process.env.FAKE_GROK_JSON_OUTPUT;
  delete process.env.FAKE_GROK_EXIT_CODE;
  assert.notEqual(result.status, 0);
  assert.match(result.error.message, /Couldn't start session/);
});

test("stop reasons are compared without case or underscores", () => {
  assert.equal(normalizeStopReason("end_turn"), "endturn");
  assert.equal(normalizeStopReason("Cancelled"), "cancelled");
  assert.equal(normalizeStopReason("MaxTurns"), "maxturns");
  assert.equal(normalizeStopReason(undefined), "");
});

test("classifyCompletion fails aborted and empty runs and warns on the turn limit", () => {
  assert.match(classifyCompletion({ stopReason: "Cancelled", text: "" }).failure, /Cancelled[\s\S]*\/grok:setup/);
  assert.match(classifyCompletion({ stopReason: "refusal", text: "no" }).failure, /refusal/);
  assert.match(classifyCompletion({ stopReason: "end_turn", text: "  " }).failure, /empty response/);
  assert.equal(classifyCompletion({ stopReason: "end_turn", text: "", structuredOutput: { a: 1 } }).failure, null);
  const limited = classifyCompletion({ stopReason: "max_turns", text: "partial" });
  assert.equal(limited.failure, null);
  assert.match(limited.warning, /turn limit/);
  assert.deepEqual(classifyCompletion({ stopReason: "end_turn", text: "ok" }), { failure: null, warning: null });
});

// Measured 2026-10-18 with grok 0.2.x and --max-turns 1: the turn limit does
// not come back as "max_turns" but as stopReason "cancelled" (lowercase), the
// same word an aborted login produces. Only num_turns tells them apart.
test("classifyCompletion tells a turn limit from an aborted sign-in by num_turns", () => {
  const limited = classifyCompletion({ stopReason: "cancelled", text: "partial", numTurns: 50, maxTurns: 50 });
  assert.equal(limited.failure, null);
  assert.match(limited.warning, /turn limit/);
  // Turn limit reached before any answer text: still the turn limit, but nothing to show.
  const empty = classifyCompletion({ stopReason: "cancelled", text: "", numTurns: 50, maxTurns: 50 });
  assert.match(empty.failure, /turn limit/);
  assert.doesNotMatch(empty.failure, /\/grok:setup/);
  // Cancelled well below the limit keeps the sign-in hint.
  assert.match(classifyCompletion({ stopReason: "cancelled", text: "", numTurns: 0, maxTurns: 50 }).failure, /\/grok:setup/);
  // No turn count reported: cannot claim a turn limit.
  assert.match(classifyCompletion({ stopReason: "cancelled", text: "partial" }).failure, /\/grok:setup/);
});

// grok exits 0 even when it aborted the run (measured 2026-08-10 in
// Projects/Grok: failed device login -> stopReason "Cancelled", empty text).
test("runGrokHeadless treats a cancelled run that exits 0 as a failure", async () => {
  process.env.FAKE_GROK_JSON_OUTPUT = JSON.stringify({ text: "", stopReason: "Cancelled", sessionId: "s-cancel" });
  try {
    const result = await runGrokHeadless(tempDir, { prompt: "review", mode: "review", jsonSchema: { type: "object" } });
    assert.notEqual(result.status, 0);
    assert.match(result.error.message, /Cancelled/);
    // The empty-answer rule would also fail this run; pin the abort rule itself.
    assert.match(result.error.message, /stopped the run/);
  } finally {
    delete process.env.FAKE_GROK_JSON_OUTPUT;
  }
});

test("runGrokHeadless treats an empty streamed answer as a failure", async () => {
  process.env.FAKE_GROK_STREAM_OUTPUT = `${JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "s-empty" })}\n`;
  try {
    const result = await runGrokHeadless(tempDir, { prompt: "hello", mode: "task-read" });
    assert.notEqual(result.status, 0);
    assert.match(result.error.message, /empty response/);
  } finally {
    delete process.env.FAKE_GROK_STREAM_OUTPUT;
  }
});

test("runGrokHeadless passes a turn-limit warning through", async () => {
  process.env.FAKE_GROK_STREAM_OUTPUT =
    [
      { type: "text", data: "partial" },
      { type: "end", stopReason: "max_turns", sessionId: "s-max" }
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n";
  try {
    const result = await runGrokHeadless(tempDir, { prompt: "hello", mode: "task-read" });
    assert.equal(result.status, 0);
    assert.equal(result.error, null);
    assert.match(result.warning, /turn limit/);
  } finally {
    delete process.env.FAKE_GROK_STREAM_OUTPUT;
  }
});

// The shape below is the real end event measured 2026-10-18 at --max-turns 1:
// exit 0, stopReason "cancelled", num_turns equal to the limit, cost attached.
test("runGrokHeadless reports a streamed turn limit as a warning and keeps the cost", async () => {
  process.env.FAKE_GROK_STREAM_OUTPUT =
    [
      { type: "text", data: "partial" },
      { type: "end", stopReason: "cancelled", sessionId: "s-limit", num_turns: 3, total_cost_usd: 0.0607 }
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n";
  try {
    const result = await runGrokHeadless(tempDir, { prompt: "hello", mode: "task-read", maxTurns: 3 });
    assert.equal(result.status, 0, result.error?.message);
    assert.equal(result.error, null);
    assert.match(result.warning, /turn limit/);
    assert.equal(result.text, "partial");
    assert.equal(result.costUsd, 0.0607);
  } finally {
    delete process.env.FAKE_GROK_STREAM_OUTPUT;
  }
});

test("runGrokHeadless skips login chatter printed before the JSON and reports cost", async () => {
  process.env.FAKE_GROK_JSON_OUTPUT =
    "Open https://accounts.x.ai/device and enter ABCD-1234\n" +
    JSON.stringify({
      text: "{}",
      structuredOutput: { verdict: "approve" },
      stopReason: "end_turn",
      sessionId: "s-login",
      total_cost_usd: 0.031
    });
  try {
    const result = await runGrokHeadless(tempDir, { prompt: "review", mode: "review", jsonSchema: { type: "object" } });
    assert.equal(result.status, 0, result.error?.message);
    assert.equal(result.structuredOutput.verdict, "approve");
    assert.equal(result.costUsd, 0.031);
  } finally {
    delete process.env.FAKE_GROK_JSON_OUTPUT;
  }
});

test("importClaudeSession resolves imported record", async () => {
  const record = await importClaudeSession(tempDir, "/fake/path/session.jsonl");
  assert.equal(record.outcome, "imported");
  assert.equal(record.sessionId, "fake-imported-session");
});

test("importClaudeSession rejects skipped imports", async () => {
  process.env.FAKE_GROK_IMPORT_OUTPUT = JSON.stringify({
    sessionId: "x",
    outcome: "skipped",
    error: "Empty session"
  });
  await assert.rejects(() => importClaudeSession(tempDir, "/fake/empty.jsonl"), /Empty session/);
  delete process.env.FAKE_GROK_IMPORT_OUTPUT;
});
