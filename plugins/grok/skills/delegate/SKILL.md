---
name: delegate
description: Use when a second opinion from Grok (xAI) would help - a design or plan to challenge, a stuck diagnosis, a root-cause hunt, test gaps to predict, or a self-contained task to hand off. Calls the Grok companion directly through Bash (no subagent), read-only unless the user asks for edits.
---

# Delegating to Grok

Grok runs through the companion script of this plugin. Call it directly with
`Bash` from the main conversation. Never wrap it in a subagent: a subagent that
only forwards one Bash call cost about 200,000 Claude tokens per run (measured
2026-09-27); the direct call costs none.

## What Grok is good at (measured in a double-blind comparison, 2026-09-27)

- **Adversary.** Predicting which mutation breaks which test - and which test
  stays green against every mutation. Ask for exactly that; it is the most
  valuable part of an answer. For a diff, run `/grok:test-gaps`; then run the
  top predicted mutations yourself (change the line, run the named tests,
  restore the file) before reporting any of them as a finding.
- **Not a measurer.** Grok predicts, Claude measures. Before passing on a claim
  of Grok's as a finding, verify it: run the mutation, read the cited line.
- **No project history.** Grok does not know this project's rules. Write them
  into the request, or tell Grok to read `CLAUDE.md` / `AGENTS.md` first.

## How to hand over a request

1. Write the request to a file with the Write tool: your scratchpad directory
   if the session has one, otherwise the system temp directory. Never put a
   long request on the command line - Windows caps it at 32,767 characters.
   The request must contain:
   - the question or task and what a good answer looks like,
   - the relevant paths (Grok can read the repository itself; do not paste
     whole files),
   - "Read CLAUDE.md and AGENTS.md at the repository root first, if present,
     and treat their rules as binding.",
   - for anything that is not an explicit edit request: "Read only. Do not
     modify any file."
   - never credentials, tokens or the value of any secret variable.
2. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task --prompt-file "<path>"
   ```

   - Add `--write` **only** when the user explicitly asked Grok to change files.
     Without it the edit tools are removed and the OS sandbox is read-only
     where the platform can enforce it, but Grok keeps its shell - so the
     request itself must say "Read only. Do not modify any file."
   - Add `--resume-last` to continue the previous Grok task of this repository.
   - Leave `--model` and `--effort` unset unless the user names them.
3. Foreground or background:
   - Short, bounded question: run in the foreground with `timeout: 600000`
     (10 minutes, the maximum) on the `Bash` call; the default of 120000 ms
     would cut Grok off mid-run.
   - Open-ended, long, or expected to take more than 10 minutes: `Bash` with
     `run_in_background: true` and the same command. You are notified when
     Grok finishes; keep working meanwhile.
   - Must outlive this Claude session: add `--background` to the companion
     call; collect it later with `/grok:status` and `/grok:result`.
4. A non-zero exit means Grok failed, even if some text came back. A
   `Cancelled` run usually means the sign-in is broken: tell the user to run
   `/grok:setup`; never run `grok login` yourself.

## Cost

Every call costs real money (about $0.03 base load per call, measured
2026-10-18) and sends the request and any file Grok reads to xAI. Bundle a
question into one call instead of following up several times.
