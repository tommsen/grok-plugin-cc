import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
export const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "grok");
export const COMPANION_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-companion.mjs");

export function createTempDir(prefix = "grok-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const FAKE_GROK_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");

const argv = process.argv.slice(2);
if (process.env.FAKE_GROK_CALLS_FILE) {
  fs.appendFileSync(process.env.FAKE_GROK_CALLS_FILE, JSON.stringify(argv) + "\\n");
}

// The companion deletes its prompt file once grok exits, so the fake keeps a
// copy for tests that need to see what was handed over.
const promptFileIndex = argv.indexOf("--prompt-file");
if (promptFileIndex !== -1 && process.env.FAKE_GROK_PROMPT_COPY) {
  fs.copyFileSync(argv[promptFileIndex + 1], process.env.FAKE_GROK_PROMPT_COPY);
}

const exitCode = Number(process.env.FAKE_GROK_EXIT_CODE || "0");

if (argv.includes("--version") || argv[0] === "version") {
  console.log("grok 0.2.93 (fake)");
  process.exit(exitCode);
}

if (argv[0] === "import") {
  const output = process.env.FAKE_GROK_IMPORT_OUTPUT ||
    JSON.stringify({ sessionId: "fake-imported-session", outcome: "imported", messageCount: 9 });
  console.log(output);
  process.exit(exitCode);
}

const formatIndex = argv.indexOf("--output-format");
const format = formatIndex === -1 ? "plain" : argv[formatIndex + 1];

if (format === "json") {
  if (process.env.FAKE_GROK_JSON_OUTPUT) {
    console.log(process.env.FAKE_GROK_JSON_OUTPUT);
  } else {
    const hasSchema = argv.includes("--json-schema");
    const body = {
      text: hasSchema
        ? JSON.stringify({ verdict: "approve", summary: "Looks safe.", findings: [], next_steps: [] })
        : "fake grok response",
      stopReason: "EndTurn",
      sessionId: "fake-session-json",
      requestId: "fake-request"
    };
    if (hasSchema) {
      body.structuredOutput = JSON.parse(body.text);
    }
    console.log(JSON.stringify(body));
  }
  process.exit(exitCode);
}

if (format === "streaming-json") {
  if (process.env.FAKE_GROK_STREAM_OUTPUT) {
    process.stdout.write(process.env.FAKE_GROK_STREAM_OUTPUT);
  } else {
    console.log(JSON.stringify({ type: "thought", data: "thinking about it" }));
    console.log(JSON.stringify({ type: "text", data: "fake " }));
    console.log(JSON.stringify({ type: "text", data: "stream response" }));
    console.log(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "fake-session-stream" }));
  }
  process.exit(exitCode);
}

console.log("fake plain response");
process.exit(exitCode);
`;

export function createFakeGrok(baseDir) {
  const binDir = path.join(baseDir, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, "grok");
  fs.writeFileSync(binPath, FAKE_GROK_SOURCE, { mode: 0o755 });
  const callsFile = path.join(baseDir, "fake-grok-calls.jsonl");

  return {
    binDir,
    binPath,
    callsFile,
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_GROK_CALLS_FILE: callsFile
    },
    readCalls() {
      if (!fs.existsSync(callsFile)) {
        return [];
      }
      return fs
        .readFileSync(callsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
  };
}

export function createTempGitRepo(baseDir) {
  const repoDir = path.join(baseDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
  };
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoDir, "app.js"), "console.log('hello');\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "initial commit"]);
  return { repoDir, git };
}

export function runCompanion(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}
