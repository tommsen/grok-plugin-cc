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
- `--write`, `--model`, `--effort` are forwarded to `task` unchanged. Without `--write` the edit tools are removed and the OS sandbox is read-only where the platform can enforce it, but Grok keeps its shell, so the request text must say it is read only (step 2).
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
2. Write the task text verbatim to a file with the Write tool (your scratchpad directory if the session has one, otherwise the system temp directory). Do not put it on the command line. When `--write` is NOT present, append the line `Read only. Do not modify any file.` after the task text. With `--resume-last` and no task text, do not write a file and omit `--prompt-file`; the companion then sends its default continue prompt.
3. Build the command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task [--prompt-file "<path>"] [--write] [--resume-last] [--model <model>] [--effort <level>]
```

4. Foreground (`--wait`, or neither flag): run it with `Bash`, passing `timeout: 600000` (10 minutes, the maximum; the default of 120000 ms would cut Grok off). Work expected to take longer runs with `run_in_background: true` instead (step 5). Return the stdout verbatim. No paraphrase, no commentary, no follow-up work.
5. Background (`--background`): run the same command with `Bash` and `run_in_background: true`. Tell the user: "Grok rescue started in the background. I will report when it finishes." When the notification arrives, return the output verbatim.
6. A non-zero exit is a failure. If Grok is missing or the run was cancelled, tell the user to run `/grok:setup`.
