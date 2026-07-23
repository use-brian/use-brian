<div align="center">

<img src="assets/mascot.png" alt="Use Brian" width="132" />

# Use Brian

### Brain, agent, workflows, and docs.

**You make the calls. It does the rest.**

[![CI](https://github.com/use-brian/use-brian/actions/workflows/ci.yml/badge.svg)](https://github.com/use-brian/use-brian/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/use-brian/use-brian)](https://github.com/use-brian/use-brian/stargazers)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

</div>

---

Every other AI meets you for the first time, every time. You re-explain your
whole company every morning, like the guy in Memento.

Use Brian is an open, self-hosted AI for solo founders, indie hackers, and small
teams. It runs on your machine, learns how your work actually happens, and then
does the work: drafts the reply, runs the workflow, files the doc, updates the
record. You stay on the decisions. It handles the rest.

## What it does

- **Brain.** Remembers your company (people, deals, decisions, the mess you drop
  on it) and builds a knowledge graph you can open and read.
- **Agent.** A chat that acts through your own tools and connectors. You make the
  call, it does the rest: research, draft, send, update.
- **Workflows.** Multi-step automations that run on a schedule or a trigger, with
  conditions and approvals. Set the rule once, it runs without you.
- **Docs.** A collaborative canvas where the work lands and the agent writes back.
  Notion-style, synced on your machine.
- **Dreams.** While you are away it consolidates what it learned and rewrites a
  **SOUL**: an evolving portrait of how you think, work, and decide. The better it
  knows you, the closer the rest lands to your own call. Yes, about you. On by
  default.

## Quick start

**Prerequisites:** Node 22+, pnpm 10+, and a free Gemini API key
([get one here](https://aistudio.google.com/apikey)).
Recording and video ingestion also requires `ffmpeg` and `ffprobe` on `PATH`
(`brew install ffmpeg`, `apt install ffmpeg`, or the equivalent for your OS).

```bash
git clone https://github.com/use-brian/use-brian.git
cd use-brian
export GEMINI_API_KEY=...   # or let the launcher prompt you; persisted under ~/.usebrian/
pnpm install
pnpm dev                    # api + canvas + web + Discord/WhatsApp bridges; opens your browser
```

That is it. There is no step three. The store defaults to an embedded PGLite
database under `~/.usebrian/`; point `DATABASE_URL` at a local Postgres if you
prefer a container. Self-host overrides live in [`.env.example`](./.env.example).
Binary data can stay local too: set `LOCAL_FILES_DIR` to a durable directory and
workspace files, recordings, avatars, and channel media use it. Browser uploads,
public media, and audio/video seeking use short-lived signed API URLs, so GCS is
optional.

DashScope long-recording transcription fetches input by URL. To keep persistent
storage local, expose only the signed transfer endpoint through a public HTTPS
reverse proxy and set its origin separately:

```env
LOCAL_FILES_DIR=/absolute/path/to/use-brian-files
LOCAL_FILES_PUBLIC_URL=https://files.example.com
```

For example, a Cloudflare Tunnel ingress can restrict the public hostname to
that endpoint while leaving the rest of the API local:

```yaml
ingress:
  - hostname: files.example.com
    path: ^/api/local-files$
    service: http://localhost:4000
  - service: http_status:404
```

Read and write grants are HMAC-signed with `JWT_SECRET`, expire after their
requested TTL, and bind the object key and action (plus MIME for writes).

### If the web app dies with "JavaScript heap out of memory"

Turbopack's dev cache under `apps/app-web/.next` is keyed by a generation id,
and a Next.js upgrade starts a fresh one without reclaiming the old. Left alone
it grows across upgrades until `next-server` is holding gigabytes before it
compiles anything, and app-web hits its heap cap on the next compile.

`pnpm dev` prunes generations untouched for 7 days on every boot (keeping the
live one) and warns when the remaining cache passes 4 GB. If app-web still dies,
clear it outright - it is regenerable build output:

```bash
rm -rf apps/app-web/.next
```

Raising the heap cap is the wrong fix here: with a clean cache the dev server
idles around 320 MB and peaks near 190 MB of JS heap after compiling a dozen
routes, so a cap in the low gigabytes is already generous.

### Your data stays yours

**0** external services. **1** model key. The brain, the store, and the canvas
all stay local; the only outbound call Use Brian makes is to the Gemini API with
your own key. Nothing else about your work leaves your machine.

## How you use it

`pnpm dev` opens the app with a chat dock on every screen. That is the main way
in. Talk to it in plain language; it remembers, and it acts. Three things to try
in the first five minutes:

1. **Tell it something.** "We are going with Postgres over Mongo, mostly for the
   JSON support, Raph pushed for it." It files the decision, the reason, and who
   was involved into the brain. No forms.
2. **Ask it to do something.** "Draft a changelog note for that decision and save
   it as a doc." It writes to the canvas and runs your connected tools, asking
   first before anything that sends or changes data.
3. **Set a rule once.** "Every Monday at 9am, summarize last week's decisions."
   That becomes a workflow that runs on a schedule without you.

Out of the box it can remember, search the web, and manage your tasks and docs.
Connectors like Gmail, Calendar, and Notion switch on when you add their keys.
The brain is the point: the more you drop in, the sharper the rest gets.

Telegram and Slack bots are configured under **Studio → Channels** and need a
public HTTPS tunnel to the local API webhook port (`4000`). Discord needs no
inbound tunnel: the local launcher starts its open Gateway bridge on port `8090`.
WhatsApp BYON also needs no tunnel: choose WhatsApp under **Studio → Channels**,
scan the QR code, and the local bridge on port `8091` persists the pairing across
restarts. Set `WA_CONNECTOR_URL` and `WA_CONNECTOR_SECRET` only when using an
external bridge instead.

### What it asks before doing

You make the calls, so it governs every tool by what that tool does, fail-closed:

- **Reads run on their own** (search, list, fetch). Looking things up is free.
- **Writes ask first** (send, create, update), until you tell it "always" for one.
- **Destructive actions stay blocked** (delete, revoke, cancel) until you turn
  them on per tool.

A fresh install reads and drafts freely, but it cannot send an email or delete an
event without you. You set the policy per tool in the app.

## More keys, more reach

That one Gemini key is the floor, not the ceiling. Each key below is optional, and
each is a service you choose to talk to, so nothing turns on by itself. Drop them
into `.env` or `~/.usebrian/`.

| Capability | Key(s) to set | What you get |
|---|---|---|
| Web search | `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, or `SERPER_API_KEY` | Upgrade the search tool past the free DuckDuckGo fallback (Brave, Tavily tuned for AI, or Serper Google results) |
| Page fetches | `JINA_API_KEY` | Cleaner page reads via Jina Reader (works keyless at lower limits) |
| Read X / Twitter | `TWITTER_BEARER_TOKEN` | Read x.com permalinks through the official X API v2 |
| X search | `XAI_API_KEY` | Fall back to xAI Grok and enable the `xSearch` tool (profiles, search, non-permalink URLs) |
| Model fallback | `FALLBACK_PROVIDER_ENABLED=true` + `ANTHROPIC_API_KEY` | Keep running if Gemini is unavailable |
| Google connector | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Calendar, Gmail, and Drive via your own OAuth app |
| Notion connector | `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` | Notion via your own OAuth app |
| Fathom connector | `FATHOM_CLIENT_ID` / `FATHOM_CLIENT_SECRET` | Fathom via your own OAuth app |
| GitHub connector | Personal Access Token (entered in the UI) | GitHub, no env key needed |

Connector client id / secret can also live in `~/.usebrian/connectors.config.json`.
Every key is documented in [`.env.example`](./.env.example).

## What's in the box

| Layer | What it does |
|---|---|
| **Engine** | Query loop, tool executor, compaction, provider abstraction. |
| **Brain** | Memory, hybrid retrieval (RRF + MMR), an entity / edge / task graph, a knowledge base, and the consolidation / dreaming loop with SOUL synthesis. |
| **Agent** | A chat loop that uses your tools and connectors to do the work, not describe it. |
| **Workflows** | Multi-step automations that run on a schedule or a trigger, with conditions and approvals. |
| **Docs** | A collaborative document surface, the canvas, where the work lands (runs a local sync sidecar). |
| **App** | The desktop and web frontend. |

## Growing into a team

Use Brian is single-player by design, like most of your actual work. When you add
a teammate, the app offers a one-click migration to the hosted version, no
re-entry. The paywall is a capability (a shared, always-on team graph that cannot
exist single-player), never a nag.

## License

**AGPLv3** ([`LICENSE`](./LICENSE)): real, OSI and FSF approved open source with a
network-copyleft clause. Run a modified Use Brian as a hosted service and you
publish your changes. We will be reading. A commercial license is available for
orgs that cannot accept AGPL, powered by the [CLA](./CLA.md) every contributor
signs.

## Contributing & security

Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) (CLA + how we work). For
vulnerabilities, see [`SECURITY.md`](./SECURITY.md), and please do not open a
public issue.

## Star the repo

If this resonates, [star it](https://github.com/use-brian/use-brian). It helps
more people find their own brain. Or star it because your current AI has the
memory of a goldfish. Either way.
