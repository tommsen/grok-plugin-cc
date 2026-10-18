---
description: Ask Grok which plausible bugs in the current change the tests would let through, as predictions for Claude to verify
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus text]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok test-gap review through the companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- Grok runs with a read-only tool allowlist (no shell, no write tools). It predicts mutations that the tests would let through; it runs nothing.
- Your job is to run the review and return Grok's output verbatim. Every gap is a prediction ("Vorhersage, nicht gemessen").

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground without asking.
- If the raw arguments include `--background`, run in a Claude background task without asking.
- Otherwise, estimate the review size the same way as `/grok:review` and use `AskUserQuestion` exactly once with `Wait for results` and `Run in background`, recommended option first with `(Recommended)` suffix. Recommend waiting only for clearly tiny reviews.

Foreground flow (run with `Bash`, passing `timeout: 600000`: 10 minutes, the maximum; the default of 120000 ms would cut Grok off mid-run):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" test-gaps "$ARGUMENTS"
```
- Return the command stdout verbatim.

Background flow:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" test-gaps "$ARGUMENTS"`,
  description: "Grok test-gap review",
  run_in_background: true
})
```
- Tell the user: "Grok test-gap review started in the background. I will report when it finishes."

After the output:
- Offer to verify the gaps with the highest confidence by actually running each mutation (change the line, run the named tests, restore the file). Only a run turns a prediction into a finding.
