---
description: Check whether the Grok CLI is installed and authenticated for the Grok companion
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(npm:*), Bash(curl:*), AskUserQuestion
---

Check the Grok companion prerequisites.

Raw slash-command arguments:
`$ARGUMENTS`

Flow:

1. Run (the `--probe` makes one paid grok call, about $0.03, because only a real answer proves the sign-in):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --probe "$ARGUMENTS"
```
2. Return the command stdout verbatim.
3. If the report says the Grok CLI is missing and npm is available, use `AskUserQuestion` once to offer installing it with `npm install -g @xai-official/grok`. Only install after the user confirms.
4. If the live probe failed or the login file is missing, tell the user to run `!grok login` (or `!grok login --device-auth` on machines without a browser). Do not suggest `XAI_API_KEY`: the grok CLI authenticates from `~/.grok/auth.json`.
5. Do not run `grok login` yourself; it is interactive.
