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

export function getGrokAuthStatus() {
  if (process.env.XAI_API_KEY) {
    return { loggedIn: true, method: "api-key" };
  }

  const authFile = path.join(resolveGrokHome(), "auth.json");
  try {
    const stat = fs.statSync(authFile);
    if (stat.isFile() && stat.size > 2) {
      return { loggedIn: true, method: "oauth", authFile };
    }
  } catch {
    // No cached credentials.
  }
  return { loggedIn: false, method: null, authFile };
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
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: `grok produced unparseable output: ${truncate(raw, 400)}` };
  }
}

function parseStreamEvents(stdout, onProgress) {
  const result = { text: "", sessionId: null, stopReason: null, errorMessage: null };
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
    const streamResult = { text: "", sessionId: null, stopReason: null, errorMessage: null };

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

    child.on("error", (error) => {
      resolve({
        status: 1,
        text: "",
        sessionId: null,
        stopReason: null,
        structuredOutput: null,
        stderr,
        error: { message: `Failed to start grok: ${error.message}` }
      });
    });

    child.on("close", (code) => {
      const status = code ?? 1;

      if (streaming) {
        if (streamBuffer.trim()) {
          try {
            applyStreamEvent(streamResult, JSON.parse(streamBuffer.trim()), options.onProgress);
          } catch {
            // Trailing partial line; ignore.
          }
        }
        const failure = streamResult.errorMessage ?? (status !== 0 ? truncate(stderr.trim(), 400) || `grok exited with status ${status}` : null);
        resolve({
          status,
          text: streamResult.text,
          sessionId: streamResult.sessionId,
          stopReason: streamResult.stopReason,
          structuredOutput: null,
          stderr,
          error: failure ? { message: failure } : null
        });
        return;
      }

      const parsed = parseSingleJsonResult(stdout);
      if (parsed.error) {
        resolve({
          status: status || 1,
          text: "",
          sessionId: null,
          stopReason: null,
          structuredOutput: null,
          stderr,
          error: { message: status !== 0 ? truncate(stderr.trim(), 400) || parsed.error : parsed.error }
        });
        return;
      }

      const value = parsed.value;
      if (value.type === "error") {
        resolve({
          status: status || 1,
          text: "",
          sessionId: null,
          stopReason: null,
          structuredOutput: null,
          stderr,
          error: { message: String(value.message ?? "grok reported an error.") }
        });
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

      resolve({
        status,
        text: String(value.text ?? ""),
        sessionId: value.sessionId ?? null,
        stopReason: value.stopReason ?? null,
        structuredOutput,
        stderr,
        error: status !== 0 ? { message: truncate(stderr.trim(), 400) || `grok exited with status ${status}` } : null
      });
    });
  });
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
