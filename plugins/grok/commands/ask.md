---
description: Ask Grok for a second opinion on a question about this project (no edit tools; Grok keeps its shell, read only by instruction) and weigh its answer
argument-hint: "<question for Grok>"
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(git:*)
---

Get a second opinion from Grok on:

**$ARGUMENTS**

1. Work out which files and context the question needs. Grok can read the repository itself, so list paths instead of pasting whole files; paste only short excerpts that matter.
2. Write the request to a file with the Write tool (your scratchpad directory if the session has one, otherwise the system temp directory). It must contain:
   - the question and what a useful answer looks like,
   - the relevant paths and excerpts,
   - "Read CLAUDE.md and AGENTS.md at the repository root first, if present, and treat their rules as binding.",
   - "Read only. Do not modify any file.",
   - never credentials or the value of any secret.
3. Run in the foreground, passing `timeout: 600000` (10 minutes, the maximum) on the `Bash` call; the default of 120000 ms would cut Grok off. If the question needs Grok to read many files, run it with `run_in_background: true` instead and report when the notification arrives:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task --prompt-file "<path>"
```

   Never add `--write`. One call costs about $0.03; ask everything in one go.
4. A non-zero exit means the run failed. A `Cancelled` run usually means the sign-in is broken: tell the user to run `/grok:setup`; do not run `grok login`.
5. Report Grok's answer and weigh it: where you agree, where you do not, and why. Verify every claim about the code against the code before repeating it, and mark what you checked and what you did not.

Do not change the project in this command unless the user explicitly asks.
