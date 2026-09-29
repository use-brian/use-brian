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
  --cpu-count 4 --memory-mb 4096
```

Do not add a start command or ready command. Chromium starts on the first real
browser operation so compute-only sandboxes do not allocate it. The command
prints the template ID. Configure:

```dotenv
E2B_API_KEY=your-api-key
E2B_TEMPLATE_ID=your-template-id
BROWSER_VAULT_ENCRYPTION_KEY=base64-of-32-random-bytes
BROWSER_CREDENTIAL_ENCRYPTION_KEY=another-base64-32-byte-key
```

`pnpm start` generates and persists both encryption keys when they are unset.
For a separately deployed API, generate each with `openssl rand -base64 32`.
Do not rotate either key without intentionally discarding the data it protects.

`JEV_ULTRAFAST_MODEL` optionally selects the TypeSafe wire model used by the
primary watched explorer (default `jev-1.13.0`). `BROWSER_USE_MODEL` optionally
selects the Jev text-helper and Browser Use fallback model. The API otherwise
prefers a low-cost OpenAI-compatible Gemini or DashScope credential so both
paths work; Anthropic remains a Browser Use-only fallback.

## Verify

After any image or agent-browser update, create a sandbox and verify:

1. A newly created sandbox has no Chromium process.
2. `HOME=/home/user AGENT_BROWSER_SESSION_NAME=main agent-browser open about:blank`
   starts Chromium; a following `agent-browser get url` returns `about:blank`.
3. `unshare -rn python3 -I` cannot reach the network.
4. Python is 3.12+; system Python imports `pandas`, `numpy`, and
   `jev_ultrafast`, while `/opt/browser-use-venv/bin/python` imports
   `browser_use`. The split is required because their exact Browser Harness
   pins conflict.
5. With `BU_CDP_WS` set from `agent-browser get cdp-url`, Jev Ultrafast's
   Browser Harness attaches to that Chromium rather than starting another one.
6. A Jev failure before any action invokes Browser Use; a failure after an
   executed action returns partial failure without replaying the goal.
7. `agent-browser snapshot -i`, click, type, screenshot, state save, and state
   restore match `packages/core/src/sandbox/providers/e2b/agent-browser-cli.ts`.

## Smoke Test

1. Create a cloud Browser Profile and enable it for an assistant.
2. Open a login page from Profile Management.
3. Sign in in Take-Over and save the session.
4. Start a new browse as the same profile and confirm it remains signed in.
