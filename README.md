<div align="center">

# Grok plugin for Claude Code

**Use xAI's [Grok CLI](https://x.ai/cli) from inside Claude Code — code reviews, task delegation, session handoff.**

10 commands · 1 skill · 0 runtime dependencies · Node 18.18+ · Apache-2.0

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
- `/grok:test-gaps` — predicts which mutations of your change the tests would let through, for Claude to verify by running them
- `/grok:rescue` — delegate investigation or fixes to Grok, foreground or background, resumable across calls; called directly through Bash, no subagent
- `/grok:ask` — a read-only second opinion on a question; Claude weighs and verifies the answer
- Skill `grok:delegate` — lets Claude hand work to Grok on its own initiative the same cheap way (request as a file, read-only unless asked)
- `/grok:transfer` — import the current Claude Code conversation into Grok and continue it there
- `/grok:status`, `/grok:result`, `/grok:cancel` — job control for background work
- `/grok:setup` — prerequisite and auth checks

## Install

Requirements: **Node.js 18.18+** and the **Grok CLI** signed in with an xAI account via `grok login`. Usage contributes to your Grok usage limits.

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

The review is read-only by construction: Grok runs with a tool allowlist of `read_file`, `grep`, and `list_dir` — no shell, no write tools, no subagents — and without its MCP gateway tools (`search_tool`, `use_tool`; see [Security Model](#security-model)). Findings come back as structured JSON validated against a schema and are rendered verbatim.

All review prompts tell Grok to read `CLAUDE.md` and `AGENTS.md` at the repository root first and to treat their rules as review criteria.

### `/grok:adversarial-review`

Same targeting as `/grok:review`, but the prompt instructs Grok to break confidence in the change: attack trust boundaries, data-loss paths, race conditions, rollback safety, and hidden assumptions.

```bash
/grok:adversarial-review
/grok:adversarial-review --base main challenge whether this caching design survives concurrent writers
/grok:adversarial-review --background look for race conditions
```

### `/grok:test-gaps`

Grok as an adversary to your tests: it predicts which plausible mutations of the changed code every existing test would let through, names the tests that stay green and the ones that would break, and suggests a test per gap. Same targeting and flags as `/grok:review`.

```bash
/grok:test-gaps
/grok:test-gaps --base main focus on the cleanup paths
```

Every gap is marked "Vorhersage, nicht gemessen" (prediction, not measured). In a double-blind comparison on 2026-09-27 Grok found four test gaps Claude missed, but ran no mutation itself — so Claude offers to run the top predictions before any of them counts as a finding.

### `/grok:rescue`

Hands a task to Grok. Claude writes the request to a file and calls the companion directly through Bash — no subagent, which saved about 200,000 Claude tokens per call in a measurement on 2026-09-27.

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

You can also just ask: "Ask Grok to redesign the database connection to be more resilient." The `grok:delegate` skill then makes the same direct call.

#### Proposals: Grok implements, Claude applies

```bash
/grok:rescue --propose fix the off-by-one in lib/jobs.mjs
```

With `--propose` Grok runs with the review allowlist (`read_file`, `grep`, `list_dir` — no shell, no edit tools) and returns a unified diff instead of editing. The companion stores it next to the job, dry-runs it with `git apply --check` (whitespace-strict first; only if that fails, once more with `--ignore-whitespace`, which the output then reports), and applies nothing. Claude then reviews the patch, applies it with exactly the command the output shows (with `--ignore-whitespace` only when it was needed, e.g. an LF patch against CRLF files; then it checks line endings and `git diff`), and runs the tests. A patch that does not apply makes the run fail. The proposal prompt requires Grok to read the files before it answers; a progress note with an empty patch counts as a failed run. Claude runs only test commands it would choose itself and rejects proposals that list commands which install, download, or write outside the repository. A follow-up with `--resume-last --propose` keeps the no-shell allowlist (measured 2026-10-18). `--propose` and `--write` are mutually exclusive; the `grok:delegate` skill uses `--propose` for implementation tasks unless you ask Grok to edit files itself.

### `/grok:ask`

A read-only second opinion. Claude writes the question with the relevant paths to a file, Grok reads the repository itself, and Claude weighs the answer — agreeing, disagreeing, and checking every claim about the code against the code.

```bash
/grok:ask Is the retry loop in lib/jobs.mjs safe when two workers start at once?
```

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

**MCP servers are blocked in every mode.** `--tools` only allowlists Grok's *built-in* tools. Measured on 2026-10-18 (grok 1.0.46): with `--tools read_file,grep,list_dir` Grok still listed `search_tool` and `use_tool`, and `search_tool` returned tools of the MCP servers configured in the user's Grok — some of which delete data, load paid data or run JavaScript in a browser page. The companion therefore also passes `--disallowed-tools search_tool,use_tool` (merged into the existing deny list for `rescue`) in every mode, so Grok cannot reach those servers. With that flag Grok reported only `read_file`, `list_dir` and `grep`.

The review commands are unaffected either way: their allowlist removes the shell entirely, so it holds everywhere, containers included. If you need hard guarantees for rescues, install the enforcer or run them in a disposable environment.

## When to use · When to skip

Use it when you already work in Claude Code, have a Grok sign-in (`grok login`), and want a second model's review or a place to hand off tasks without leaving your session.

Skip it if:

- **You don't use Grok.** The plugin is a wrapper around your local `grok` binary and account; without them it does nothing.
- **You only want Claude-native review.** Claude Code's built-in review needs no plugin — this adds a *second* opinion from a different model, not a replacement.
- **You need kernel-hard write isolation for rescues inside containers.** See the caveat above; use a disposable environment instead.

## Grok Integration

The plugin wraps the Grok CLI's headless mode (`grok -p` with `--output-format json|streaming-json`). It uses the global `grok` binary and your existing `~/.grok` configuration and login. Reviews use `--json-schema` for validated structured output; task delegation records the Grok session ID so follow-ups can `--resume` it.

Model and effort defaults come from your own Grok config (`~/.grok/config.toml`).

Prompts longer than 8000 characters — in practice every review of a sizeable diff — are handed over with `--prompt-file` instead of `-p`, through a private temp file that is removed when Grok exits. Windows caps the whole command line at 32767 characters and Linux caps a single argument at 128 KiB; passing the diff inline failed with `spawn ENAMETOOLONG` / `E2BIG` before Grok ever ran. Short prompts still use `-p`.

grok exits 0 even when it aborts a run, so the companion reads `stopReason` instead of trusting the exit code: `Cancelled`, `error` and `refusal` (compared without case or underscores) and empty answers count as failures and make the companion exit non-zero. Hitting the turn limit is reported as a warning above the answer. grok has no stop reason of its own for the limit: in streaming mode it ends with `cancelled` and `num_turns` equal to `--max-turns`, which the companion recognises.

## FAQ

**Do I need a separate Grok account?** No. The plugin uses your local Grok CLI sign-in from `grok login` (`~/.grok/auth.json`). `XAI_API_KEY` is not used by the CLI. `/grok:setup` proves the sign-in with one real call (about $0.03).

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
