# wechat-desktop-bridge

Mirrors a **personal WeChat account** into a Use Brian **custom channel**. It runs
the `agent-wechat` container (the official WeChat Linux desktop client driven
headlessly) next to a small Node 22 service that speaks the Use Brian bridge
protocol: login state and the pairing QR go up to Studio, every DM and group
message the account receives goes into the chat archive (and to an assistant
when routed), and replies go out as the account.

Spec: `docs/architecture/channels/wechat-desktop.md` (this app) and
`docs/architecture/channels/custom-channel.md` (the protocol).

> This is part of the open self-host tree (`use-brian/apps/wechat-desktop-bridge`).
> A **container runtime is a hard requirement**: the `agent-wechat` side runs
> the WeChat Linux client and is distributed only as a container needing
> `SYS_PTRACE` + `seccomp=unconfined` (Docker, or any OCI runtime such as
> Podman). There is no bare-metal WeChat-client path. It runs on a Linux box
> the operator controls (personal account, own machine).

## Box setup

Requirements: a Linux box (x86_64, 2 vCPU / 4 GB is plenty) with outbound
HTTPS, Docker Engine 24+ and the compose plugin. No inbound port is needed.

1. Install Docker (`https://docs.docker.com/engine/install/`) and make sure
   `docker compose version` works.
2. Clone both open repositories as siblings. The compose stack builds the
   audited runtime source from `brian-message-store/agent-wechat`:

   ```sh
   git clone https://github.com/use-brian/brian-message-store
   git clone https://github.com/use-brian/use-brian
   cd use-brian/apps/wechat-desktop-bridge
   ```

   If the repositories are not siblings, set `AGENT_WECHAT_SOURCE` in `.env`
   to the absolute path of the standalone `agent-wechat` directory.
3. Create the container token:

   ```sh
   openssl rand -hex 32 > agent-wechat-token
   chmod 600 agent-wechat-token
   ```

4. In Use Brian: **Studio -> Channels -> + Add channel -> Custom**, kind
   `wechat-desktop`, pick the default assistant. Copy the three values the
   panel shows once: the **channel id**, the **bridge token** (`ubc_...`) and
   the **API URL**.
5. `cp .env.example .env` and fill in:

   ```
   BRIAN_API_URL=https://api.usebrian.ai
   BRIAN_CHANNEL_ID=<channel id from Studio>
   BRIAN_BRIDGE_TOKEN=<ubc_ token from Studio>
   AGENT_WECHAT_TOKEN=<contents of ./agent-wechat-token>
   ```

6. Start the stack:

   ```sh
   GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown) \
   BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
   docker compose up -d --build
   ```

7. Open the channel's detail panel in Studio. Within about a minute the card
   shows **Scan the QR with WeChat on your phone**. Scan it with the phone
   that owns the account and confirm on the phone. The card flips to
   **connected** with the account label and the bridge build stamp.

`docker compose logs -f bridge` shows what the bridge is doing. A wrong token
or channel id exits immediately with one sentence saying so; fix `.env` and
`docker compose up -d` again.

## Day-to-day

- **Upgrades:** pull both repositories, then `docker compose build --pull &&
  docker compose up -d`. The WeChat session usually survives (it lives in the
  `agent-wechat-*` volumes); if not, Studio shows a fresh QR.
- **Backups:** the two `agent-wechat-*` volumes hold the desktop session and
  the message store; the `bridge-data` volume holds `bridge-state.json` (the
  per-chat cursors). Losing the cursors costs at most one poll window of
  replay per chat, because cursors re-seed at each chat's current last
  message.
- **Disconnect / re-pair:** Studio -> channel -> Disconnect logs the desktop
  client out. The bridge then stops re-opening the login flow until it is
  restarted: `docker compose restart bridge` and scan again from Studio.
- **One account per stack.** WeChat allows one desktop login per account; a
  second bridge against the same account logs the first one out. Run one
  compose stack (and one custom channel) per account, on separate
  directories so the volumes and `.env` do not collide.
- **First boot and history:** by default the bridge does not replay existing
  history into the live channel (`BACKFILL_ON_FIRST_BOOT=false`). Set it to
  `true` before the first start only if you really want the whole backlog
  delivered through the live pipeline.

## What the channel does out of the box

Every sender is an unverified (tier-2) shadow user. Groups answer only when
the account is @-mentioned; DMs are answered for every sender unless you set
an allowlist. Until the assistant's persona is trusted, set the channel's
access mode to **allowlist** with your own test contact. Messages you send
from your phone are archived, never answered.

## Posture

The account owner must personally scan the Studio QR and confirm the desktop
login on their device. The container approach (desktop-client automation) is
outside WeChat's sanctioned surfaces. An operator may host a stack for another
consenting owner only as a dedicated instance with separate runtime directory,
tokens, cursor state, volumes, ports, containers, and service units. Never pool
credentials or message data, expose the agent-wechat endpoint, or operate this
as a multi-tenant WeChat service. The sanctioned bot channel is a different
thing (`docs/architecture/channels/wechat.md`) and is preferred when a separate
bot contact is acceptable.

## Development

```sh
pnpm --filter @use-brian/wechat-desktop-bridge test
pnpm --filter @use-brian/wechat-desktop-bridge typecheck
pnpm --filter @use-brian/wechat-desktop-bridge dev   # needs a .env in this directory
```

The Docker image builds from this directory alone (`npm install` against
`package.json`); the app imports no workspace packages on purpose so it can
run on a box that has nothing else from the monorepo.
