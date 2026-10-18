---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to Grok
argument-hint: "[--background|--wait] [--resume|--fresh] [--write] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [what Grok should investigate, solve, or continue]"
allowed-tools: Bash(node:*), Write, AskUserQuestion
---

Hand the user's request to Grok through the companion script. Call it directly
with `Bash`; do not use a subagent.

Raw user request:
$ARGUMENTS

Flags:

- `--background` / `--wait` choose how you run the command (below). Do not forward them.
- `--write`, `--model`, `--effort` are forwarded to `task` unchanged. Without `--write` Grok runs read-only.
- `--resume` means forward `--resume-last`; `--fresh` means do not. With either flag, do not ask.
- Everything else is the task text.

Resume check (only when neither `--resume` nor `--fresh` is present):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task-resume-candidate --json
```

- If it reports `available: true`, use `AskUserQuestion` exactly once with `Continue current Grok session` and `Start a new Grok session`. Put `(Recommended)` on continue when the request is clearly a follow-up ("continue", "keep going", "apply the top fix", "dig deeper"), otherwise on new.
- Continue → forward `--resume-last`. New → do not.
- If it reports `available: false`, do not ask.

Hand-over:

1. If there is no task text and no `--resume-last`, ask what Grok should investigate or fix.
2. Write the task text verbatim to a file with the Write tool (your scratchpad directory if the session has one, otherwise the system temp directory). Do not put it on the command line.
3. Build the command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task --prompt-file "<path>" [--write] [--resume-last] [--model <model>] [--effort <level>]
```

4. Foreground (`--wait`, or neither flag): run it with `Bash` and return its stdout verbatim. No paraphrase, no commentary, no follow-up work.
5. Background (`--background`): run the same command with `Bash` and `run_in_background: true`. Tell the user: "Grok rescue started in the background. I will report when it finishes." When the notification arrives, return the output verbatim.
6. A non-zero exit is a failure. If Grok is missing or the run was cancelled, tell the user to run `/grok:setup`.
