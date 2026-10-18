<div align="center">

# Grok plugin for Claude Code

**Use xAI's [Grok CLI](https://x.ai/cli) from inside Claude Code — code reviews, task delegation, session handoff.**

8 commands · 1 rescue subagent · 0 runtime dependencies · Node 18.18+ · Apache-2.0

[![CI](https://github.com/thevibeworks/grok-plugin-cc/actions/workflows/ci.yml/badge.svg)](https://github.com/thevibeworks/grok-plugin-cc/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Install](#install) · [Usage](#usage) · [Proof](#proof) · [Security model](#security-model) · [FAQ](#faq)

<sub>AI agents / LLMs: read <a href="llms.txt">llms.txt</a> — a one-fetch summary of what this is, how to install it, and every command.</sub>

</div>

This is the Grok counterpart to OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc): same workflow, same command shapes, driven by the Grok CLI's headless mode instead of the Codex app server.

> Unofficial community plugin by [thevibeworks](https://github.com/thevibeworks). Not affiliated with xAI or Anthropic.

## What You Get

- `/grok:review` — read-only Grok code review of your working tree or branch, returned as structured findings (severity, file:line, confidence, recommendation)
- `/grok:adversarial-review` — a steerable challenge review that attacks the design, not just the code
- `/grok:rescue` — delegate investigation or fixes to Grok, foreground or background, resumable across calls
- `/grok:transfer` — import the current Claude Code conversation into Grok and continue it there
- `/grok:status`, `/grok:result`, `/grok:cancel` — job control for background work
- `/grok:setup` — prerequisite and auth checks

## Install

Requirements: **Node.js 18.18+** and the **Grok CLI** signed in with an xAI account (or an `XAI_API_KEY` from [console.x.ai](https://console.x.ai)). Usage contributes to your Grok usage limits.

Add the marketplace and install in Claude Code:

```bash
/plugin marketplace add thevibeworks/grok-plugin-cc
/plugin install grok@grok-cc
```

Reload plugins, then check prerequisites:

```bash
/grok:setup
```

If the Grok CLI is missing:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash   # or: npm install -g @xai-official/grok
grok login                                       # or: grok login --device-auth (headless machines)
```

One simple first run:

```bash
/grok:review
/grok:status
/grok:result
```

## Proof

We planted two bugs in a scratch repo — a percent-scale error (`cents - cents * percent` under a "percent arrives as 0-100" comment) and a refund function that deletes the whole pending-refund queue — and ran `/grok:review`. Verbatim excerpt:

```
Verdict: needs-attention

No-ship: discount math still treats percent as a fraction while the comment
says 0-100, and refund wipes every pending refund.

### 1. [critical] Discount formula ignores 0-100 percent contract
- Location: pay.js:1-5
- Confidence: 95%

### 2. [high] refund deletes all pendingRefunds unconditionally
- Location: pay.js:6-10
- Confidence: 88%
```

Both planted bugs, correct locations, and a session ID to reopen the run in Grok (`grok --resume <id>`). One demo transcript, not a benchmark — review quality is Grok's; what this plugin guarantees is the wiring and the enforcement around it.

Reproduce:

```bash
npm test    # 52 tests, no dependencies: flag assembly (incl. the read-only
            # allowlist), job state, git context collection, rendering, and an
            # end-to-end companion run against a fake grok binary
```

Or plant your own bug: make a repo dirty, run `/grok:review`, and check that the process never receives shell or write tools (`ps` shows `--tools read_file,grep,list_dir`).

## Usage

### `/grok:review`

Runs a Grok code review on your current work.

- `--base <ref>` reviews your branch against a base branch
- `--scope working-tree|branch` forces the target instead of auto-detection
- `--wait` / `--background` choose the execution mode up front
- optional trailing text focuses the review (e.g. `/grok:review pay special attention to error handling`)

```bash
/grok:review
/grok:review --base main
/grok:review --background
```

The review is read-only by construction: Grok runs with a tool allowlist of `read_file`, `grep`, and `list_dir` — no shell, no write tools, no subagents. Findings come back as structured JSON validated against a schema and are rendered verbatim.

### `/grok:adversarial-review`

Same targeting as `/grok:review`, but the prompt instructs Grok to break confidence in the change: attack trust boundaries, data-loss paths, race conditions, rollback safety, and hidden assumptions.

```bash
/grok:adversarial-review
/grok:adversarial-review --base main challenge whether this caching design survives concurrent writers
/grok:adversarial-review --background look for race conditions
```

### `/grok:rescue`

Hands a task to Grok through the `grok:grok-rescue` subagent.

```bash
/grok:rescue investigate why the tests started failing
/grok:rescue fix the failing test with the smallest safe patch
/grok:rescue --resume apply the top fix from the last run
/grok:rescue --model grok-4 --effort high investigate the flaky integration test
/grok:rescue --background investigate the regression
```

- Default rescues run read-leaning: Grok keeps its shell for running tests and git, but loses the direct file-edit tools and runs under Grok's `read-only` OS sandbox where the kernel can enforce one (see [Security Model](#security-model) — on Linux that means `bwrap` is installed).
- `--write` switches to a write-capable run under Grok's `workspace` sandbox.
- `--resume` continues the latest rescue session for this repo; `--fresh` forces a new one. Without either flag the plugin offers to continue when a resumable session exists.
- Model and reasoning effort default to Grok's own choices; pass `--model` / `--effort` to override.

You can also just ask: "Ask Grok to redesign the database connection to be more resilient."

### `/grok:transfer`

Imports the current Claude Code conversation into Grok (via `grok import`) and prints a `grok --resume <session-id>` command so you can continue the same context in the Grok TUI.

```bash
/grok:transfer
/grok:transfer --source ~/.claude/projects/<project>/<session-id>.jsonl
```

The plugin's `SessionStart` hook supplies the current transcript path automatically; `--source` is a manual override. Sources must live under `~/.claude/projects`.

### `/grok:status`, `/grok:result`, `/grok:cancel`

Job control for background work:

```bash
/grok:status              # running and recent jobs for this repo
/grok:status task-abc123  # one job in detail
/grok:result              # stored output of the latest finished job
/grok:result task-abc123
/grok:cancel task-abc123
```

Results include the Grok session ID, so any finished or cancelled run can be reopened directly in Grok with `grok --resume <session-id>`.

## Security Model

Three different enforcement layers, applied per command:

| Command            | Enforcement                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `review` / `adversarial-review` | Tool allowlist (`read_file,grep,list_dir`): no shell, no writes, no subagents. Holds everywhere, including containers. |
| `rescue` (default) | Grok `read-only` OS sandbox + file-edit tools removed. Shell stays available for tests/git. |
| `rescue --write`   | Grok `workspace` sandbox, auto-approved tools. |

Caveat worth knowing: Grok's OS sandbox needs a kernel enforcer, and on Linux that is now **bubblewrap** (`bwrap`), which plain Debian/Ubuntu and WSL images do not ship. Older Grok releases used Landlock and degraded silently when it was unavailable; **grok 1.0.3 does the opposite and refuses to start** rather than run with an unenforced deny list — reported with a live repro in [#1](https://github.com/thevibeworks/grok-plugin-cc/issues/1).

So the plugin probes before it asks:

| Machine | `rescue` (read-leaning) | `rescue --write` |
| --- | --- | --- |
| enforcer present | `--sandbox read-only` + deny list | `--sandbox workspace` |
| enforcer missing | runs, **deny list only** — the flag is dropped because sending it would just fail | **refuses**, and names the fix |

The asymmetry is deliberate. A read-leaning rescue's primary guard is the tool deny list, which needs no kernel, so losing the sandbox costs one belt out of two. For `--write` the sandbox is the *only* thing keeping edits inside the workspace, and degrading that silently would hand an agent the whole disk — so it fails with `apt install -y bubblewrap` in the message.

Override the probe with `GROK_COMPANION_SANDBOX=on|off` if your distro enforces through something we do not recognise, or if you have decided to accept the risk.

The review commands are unaffected either way: their allowlist removes the shell entirely, so it holds everywhere, containers included. If you need hard guarantees for rescues, install the enforcer or run them in a disposable environment.

## When to use · When to skip

Use it when you already work in Claude Code, have Grok (subscription or `XAI_API_KEY`), and want a second model's review or a place to hand off tasks without leaving your session.

Skip it if:

- **You don't use Grok.** The plugin is a wrapper around your local `grok` binary and account; without them it does nothing.
- **You only want Claude-native review.** Claude Code's built-in review needs no plugin — this adds a *second* opinion from a different model, not a replacement.
- **You need kernel-hard write isolation for rescues inside containers.** See the caveat above; use a disposable environment instead.

## Grok Integration

The plugin wraps the Grok CLI's headless mode (`grok -p` with `--output-format json|streaming-json`). It uses the global `grok` binary and your existing `~/.grok` configuration and login. Reviews use `--json-schema` for validated structured output; task delegation records the Grok session ID so follow-ups can `--resume` it.

Model and effort defaults come from your own Grok config (`~/.grok/config.toml`).

Prompts longer than 8000 characters — in practice every review of a sizeable diff — are handed over with `--prompt-file` instead of `-p`, through a private temp file that is removed when Grok exits. Windows caps the whole command line at 32767 characters and Linux caps a single argument at 128 KiB; passing the diff inline failed with `spawn ENAMETOOLONG` / `E2BIG` before Grok ever ran. Short prompts still use `-p`.

## FAQ

**Do I need a separate Grok account?** No. The plugin uses your local Grok CLI authentication — browser login or `XAI_API_KEY`.

**Does it use a separate runtime?** No. It shells out to the same `grok` binary you use directly, with the same config, credentials, and repository checkout.

**Where does job state live?** Under Claude's plugin data directory (or the OS temp dir as fallback), scoped per workspace. `SessionEnd` cleans up still-running jobs started by that Claude session.

## Development

```bash
npm test   # node --test, zero dependencies
```

## Credits

Architecture, command UX, and the adversarial-review stance closely follow OpenAI's excellent [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0) — if you use Codex, install that one too. Built on xAI's [Grok CLI](https://x.ai/cli), whose headless mode (`--json-schema`, session resume, `grok import`) made this plugin small. See [NOTICE](NOTICE).

## License

Apache-2.0
