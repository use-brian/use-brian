# E2B Browser Template

This optional template enables the cloud backend for Browser Profiles. My
Browser works without E2B.

## Prerequisites

- An E2B account and API key.
- E2B CLI 2.x: `npm install -g @e2b/cli`, then `e2b auth login`.

## Build

From the OSS repository root:

```bash
cd scripts/e2b-template
e2b template create use-brian-computer \
  --cpu-count 4 --memory-mb 4096 \
  -c 'HOME=/home/user AGENT_BROWSER_SESSION_NAME=main agent-browser open about:blank' \
  --ready-cmd 'HOME=/home/user AGENT_BROWSER_SESSION_NAME=main agent-browser get url'
```

The command prints the template ID. Configure:

```dotenv
E2B_API_KEY=your-api-key
E2B_TEMPLATE_ID=your-template-id
BROWSER_VAULT_ENCRYPTION_KEY=base64-of-32-random-bytes
```

`pnpm start` generates and persists `BROWSER_VAULT_ENCRYPTION_KEY` when it is
unset. For a separately deployed API, generate it with
`openssl rand -base64 32`. Do not rotate it without intentionally discarding
saved browser sessions and credentials.

`BROWSER_USE_MODEL` optionally selects the watched `browserExplore` model. The
API otherwise chooses a low-cost model for the configured Anthropic or Gemini
credential.

## Verify

After any image or agent-browser update, create a sandbox and verify:

1. `HOME=/home/user AGENT_BROWSER_SESSION_NAME=main agent-browser get url`
   returns `about:blank` without a cold Chromium launch.
2. `unshare -rn python3 -I` cannot reach the network.
3. Plain Python imports `pandas`, `numpy`, and `browser_use`.
4. `agent-browser snapshot -i`, click, type, screenshot, state save, and state
   restore match `packages/core/src/sandbox/providers/e2b/agent-browser-cli.ts`.

## Smoke Test

1. Create a cloud Browser Profile and enable it for an assistant.
2. Open a login page from Profile Management.
3. Sign in in Take-Over and save the session.
4. Start a new browse as the same profile and confirm it remains signed in.
