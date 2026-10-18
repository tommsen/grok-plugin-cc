# Changelog

## Unreleased

Grok can no longer start work that outlives a run.

- Default rescues and `--write` runs also deny `scheduler_*`, `workflow`,
  `spawn_subagent`, `kill_command_or_subagent`, `get_command_or_subagent_output`
  and the media tools (`image_gen`, `image_edit`, `image_to_video`,
  `reference_to_video`); all were present in a measured tool list (grok 1.0.46,
  2026-10-18).
- The proposal check is whitespace-strict first and falls back to
  `--ignore-whitespace` only when needed; the output reports which was used and
  the apply command it shows matches.

Grok can no longer reach configured MCP servers from the companion.

- `--tools` only allowlists built-in tools: with the review allowlist Grok still
  had `search_tool`/`use_tool` and `search_tool` returned real MCP tools
  (measured 2026-10-18, grok 1.0.46). Every mode now passes
  `--disallowed-tools` with both; Grok then reported only `read_file`,
  `list_dir` and `grep`.

Grok can implement without writing.

- New `task --propose` / `/grok:rescue --propose`: Grok runs with the review
  allowlist (no shell, no edit tools) and returns a unified diff. The companion
  stores it, dry-runs `git apply --check`, and applies nothing; Claude reviews,
  applies and tests. A patch that does not apply fails the run. The check is
  whitespace-strict first; only when it fails does the companion retry with
  `--ignore-whitespace` (an LF patch against CRLF files) and say so.
- The `grok:delegate` skill uses proposals for implementation tasks by default;
  `--write` stays for when Grok itself should edit files.

Grok as an adversary to the tests.

- New `/grok:test-gaps`: predicts mutations of the change that every test would
  let through, with the tests that stay green and those that would break; each
  gap is marked as a prediction (Grok found four gaps Claude missed in a
  double-blind comparison on 2026-09-27, but ran no mutation itself).
- All review prompts tell Grok to read `CLAUDE.md` and `AGENTS.md` first and to
  treat their rules as review criteria.

Grok is called without a subagent.

- The `grok:grok-rescue` subagent is gone. It forwarded one Bash call and cost
  about 200,000 Claude tokens per rescue (measured 2026-09-27); `/grok:rescue`
  now calls the companion directly, with the request in a file.
- New skill `grok:delegate`: lets Claude hand work to Grok on its own
  initiative the same way — request as a file, no edit tools unless the user asks
  for edits, background via Bash. `--background` runs while the Claude session
  is open and is cancelled when it ends.
- New `/grok:ask`: a second opinion without edit tools (Grok keeps its shell,
  read only by instruction) that Claude weighs and verifies.
- The plugin-structure tests read CRLF checkouts.

`setup` no longer reports a sign-in it cannot prove.

- The grok CLI authenticates from `~/.grok/auth.json`; `XAI_API_KEY` is shown
  as set but no longer counts as a sign-in (the CLI ignored it in a measurement
  on 2026-09-27).
- `setup --probe` makes one real call (about $0.03) and reports its cost; only
  that verifies the sign-in. `/grok:setup` runs with the probe.

Aborted runs no longer pass as empty successes.

- grok exits 0 when it aborts a run (a failed sign-in returns
  `stopReason: "Cancelled"` with empty text). The companion now treats
  `cancelled`, `error` and `refusal` — compared without case or underscores —
  and empty answers as failures and exits non-zero. In task (streaming) runs a
  turn limit is passed through as a visible warning; a review that hits the turn
  limit fails with exit 1. The failure message names the session. grok reports the limit as `cancelled` with
  `num_turns` equal to `--max-turns` (measured), so that combination is the
  warning, not the failure.
- Plain text printed before the JSON body (device login) is skipped.
- The run result now carries `warning` and `costUsd`.

Fixed reviews of large diffs failing before Grok started.

- `/grok:review` and `/grok:adversarial-review` passed the whole prompt,
  diff included, as the `-p` argument. Windows caps the command line at 32767
  characters, so any diff past ~32 KB died with `spawn ENAMETOOLONG`; Linux
  hits `E2BIG` past 128 KiB per argument.
- Prompts longer than 8000 characters now go through `--prompt-file` (a
  private temp file, removed when Grok exits, also on spawn failure). Shorter
  prompts keep `-p`. Applies to tasks too, since they share the runner.
- Checked against grok 1.0.46: `--prompt-file` keeps UTF-8 intact and works
  with `--resume`; grok rejects `-p` and `--prompt-file` together, so only
  one is ever sent.

## 0.1.1 - 2026-08-25

Fixed a start-up failure on Linux machines without a sandbox enforcer.

- `--sandbox` is no longer sent unconditionally. Grok's Linux enforcer is
  bubblewrap, which plain Debian/Ubuntu and WSL images do not ship, and grok
  1.0.3 **refuses to start** when it is missing rather than warning and
  continuing — so every sandboxed invocation failed with exit 1 and empty
  stdout. Reported with a live repro by @roy7 in #1.
- A read-leaning rescue now drops the flag and keeps its tool deny list, which
  is the guard that never needed the kernel. `--write` refuses instead, because
  there the workspace sandbox is the only thing bounding edits; the error names
  `apt install -y bubblewrap`.
- `GROK_COMPANION_SANDBOX=on|off` overrides the probe.
- `--sandbox` is no longer re-sent on `--resume`. A profile that differs from
  the session's saved one is a hard error, and omitting it is always accepted.
- Security Model in the README documented the opposite behaviour (silent
  degradation under Landlock), which was true of older Grok releases and is not
  true of 1.0.3.

## 0.1.0 - 2026-07-12

Initial release.

- `/grok:review` and `/grok:adversarial-review`: structured, read-only code
  reviews via Grok headless mode with `--json-schema` output and a
  `read_file,grep,list_dir` tool allowlist.
- `/grok:rescue` + `grok:grok-rescue` subagent: task delegation with
  read-leaning defaults, `--write` opt-in, `--resume`/`--fresh` session
  routing, and background execution.
- `/grok:transfer`: import the current Claude Code transcript into Grok via
  `grok import` and print the `grok --resume` handoff command.
- `/grok:status`, `/grok:result`, `/grok:cancel`: per-workspace job control.
- `/grok:setup`: prerequisite and auth checks.
- Session lifecycle hooks record the transcript path and clean up background
  jobs at session end.
