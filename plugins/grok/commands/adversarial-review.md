---
description: Run a steerable adversarial Grok review that challenges the implementation and design
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus text]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Grok review through the companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only. Grok runs with a read-only tool allowlist (no shell, no write tools).
- It challenges the chosen implementation, design, and assumptions; it does not fix code.
- Your only job is to run the review and return Grok's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size the same way as `/grok:review` and use `AskUserQuestion` exactly once with `Wait for results` and `Run in background`, recommended option first with `(Recommended)` suffix. Recommend waiting only for clearly tiny reviews.

Argument handling:
- Preserve the user's arguments exactly.
- Positional text after the flags is the adversarial focus (for example: "challenge whether this caching design survives concurrent writers"). Forward it as-is.

Foreground flow:
- Run with `Bash`, passing `timeout: 600000` (10 minutes, the maximum; the default of 120000 ms would cut Grok off mid-run):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is. No commentary, no fixes.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Grok adversarial review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching, tell the user: "Grok adversarial review started in the background. Check `/grok:status` for progress."
