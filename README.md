<div align="center">

<img src="assets/mascot.png" alt="Use Brian" width="132" />

# Use Brian

### Brain, agent, workflows, and docs.

**You make the calls. It does the rest.**

[usebrian.ai](https://usebrian.ai) · [Docs](https://usebrian.ai/docs) · [Hosted app](https://app.usebrian.ai) · [Services](https://studio.usebrian.ai)

[![CI](https://github.com/use-brian/use-brian/actions/workflows/ci.yml/badge.svg)](https://github.com/use-brian/use-brian/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/use-brian/use-brian)](https://github.com/use-brian/use-brian/stargazers)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

</div>

---

Every other AI meets you for the first time, every time. You re-explain your
whole company every morning, like the guy in Memento.

Use Brian is an open-source, self-hosted AI company brain for solo founders,
indie hackers, and small teams. It runs on your machine, learns how your work
actually happens, and then does the work: drafts the reply, runs the workflow,
files the doc, updates the record. You stay on the decisions. It handles the
rest.

## What it does

- **Brain.** Remembers your company (people, deals, decisions, the mess you drop
  on it) and builds a knowledge graph you can open and read. Chats, emails, and
  meeting recordings all land here.
- **Agent.** A chat that acts through your own tools and connectors. You make
  the call, it does the rest: research, draft, send, update. It can even drive
  your own signed-in browser through the My Browser extension, one permitted
  tab at a time.
- **Workflows.** Multi-step automations that run on a schedule or a trigger,
  with conditions and approvals. Set the rule once, it runs without you.
- **Docs & Office.** A collaborative canvas where the work lands and the agent
  writes back: pages, documents, presentations, and spreadsheets, with PDF
  export and public share links.
- **Channels.** It answers where you already talk: web, desktop app, Telegram,
  Slack, Discord, WhatsApp, WeChat, Microsoft Teams, Feishu, and email.
- **Dreams.** While you are away it consolidates what it learned and rewrites a
  **SOUL**: an evolving portrait of how you think, work, and decide. The better
  it knows you, the closer the rest lands to your own call. Yes, about you. On
  by default.

## Quick start

**Prerequisites:** Node 22+, pnpm 10+, and either an eligible ChatGPT
subscription or one supported model credential (a free
[Gemini API key](https://aistudio.google.com/apikey) works). Optional: `ffmpeg`
on `PATH` for recording and video ingestion, LibreOffice for PDF export.

```bash
git clone https://github.com/use-brian/use-brian.git
cd use-brian
pnpm install
pnpm dev                    # choose ChatGPT or an API-key backend; opens your browser
```

That is it. There is no step three. The store defaults to an embedded PGLite
database under `~/.usebrian/`; point `DATABASE_URL` at a local Postgres if you
prefer a container. Files live in the durable `~/.usebrian/files` directory.
Every self-host override is documented in [`.env.example`](./.env.example).

### Container images

Prebuilt images for the independently deployable services are published to the
[GitHub Container Registry](https://github.com/orgs/use-brian/packages). Pull a
service with:

```bash
docker pull ghcr.io/use-brian/doc-sync:latest
```

| Service | Image |
|---|---|
| API + workers | `ghcr.io/use-brian/api` |
| Authenticated app | `ghcr.io/use-brian/app-web` |
| Auth web | `ghcr.io/use-brian/auth-web` |
| Browser relay | `ghcr.io/use-brian/browser-relay` |
| Discord connector | `ghcr.io/use-brian/discord-connector` |
| Document sync | `ghcr.io/use-brian/doc-sync` |
| Feishu connector | `ghcr.io/use-brian/feishu-connector` |
| WhatsApp connector | `ghcr.io/use-brian/wa-connector` |
| WeChat connector | `ghcr.io/use-brian/wechat-connector` |
| WeChat desktop bridge | `ghcr.io/use-brian/wechat-desktop-bridge` |

Use `latest` for the current `main` build, `develop` for the development branch,
`v*` tags for releases, or `sha-<commit>` to pin an exact build. The API image
listens on port `4000` and requires a migrated PostgreSQL database. The app image
listens on port `3003`. Configure it at container startup with `API_DOMAIN`,
`DOC_SYNC_DOMAIN`, `APP_DOMAIN`, and `USEBRIAN_EDITION`; use `API_URL` separately
for its private server-to-server API address. The server injects the allowlisted
public values into the initial HTML, so changing domains requires recreating the
container and reloading the page, not rebuilding the image. Desktop applications,
browser extensions, and the Firefox native companion remain native installable
artifacts rather than server containers.

```yaml
app-web:
  image: ghcr.io/use-brian/app-web:latest
  environment:
    APP_DOMAIN: app.brian.customer.example
    API_DOMAIN: api.brian.customer.example
    DOC_SYNC_DOMAIN: docs.brian.customer.example
    API_URL: http://api:4000
    USEBRIAN_EDITION: oss
```

Public runtime options are allowlisted before they reach browser JavaScript:

| Variable | Purpose |
|---|---|
| `APP_DOMAIN` | Public app hostname and default app-host classification |
| `API_DOMAIN` | Public HTTPS API hostname |
| `DOC_SYNC_DOMAIN` | Public WSS document-sync hostname |
| `APP_HOSTS` | Additional comma-separated app hostnames or `.suffix` matchers |
| `USEBRIAN_EDITION` | `hosted`, `oss`, or `outpost` UI capabilities |
| `PUBLIC_APP_URL` | Marketing and primary web application URL override |
| `PUBLIC_API_URL` | Explicit public API URL override, including scheme |
| `PUBLIC_DISPLAY_API_URL` | Absolute API URL rendered in copied configuration |
| `PUBLIC_DOC_SYNC_URL` | Explicit public document-sync URL override |
| `PUBLIC_PRIMARY_AUTH_URL` | Public primary authentication origin |
| `PUBLIC_BROWSER_EXTENSION_ID` | Browser extension id override |
| `GOOGLE_CLIENT_ID` | Public Google OAuth client id |
| `PUBLIC_GOOGLE_API_KEY` | Referrer-restricted Google browser API key |
| `GOOGLE_PROJECT_NUMBER` | Google Drive Picker project number |
| `NOTION_CLIENT_ID` | Public Notion OAuth client id |
| `FATHOM_CLIENT_ID` | Public Fathom OAuth client id |
| `PUBLIC_FATHOM_AUTHORIZE_URL` | Fathom authorization endpoint override |

Only these public values are serialized. Database URLs, OAuth client secrets,
JWTs, connector secrets, and encryption keys remain server-only.

### Your data stays yours

The brain, the store, and the canvas stay local. Model requests go only to the
backend you configure; connectors and upgraded search providers make outbound
calls only when you opt into them. Your local database and files are not moved
to a Brian-hosted service.

### Model backends

| Backend | Status | Authentication |
|---|---|---|
| Gemini via Google AI Studio | Supported | `GEMINI_API_KEY` |
| Gemini via Vertex AI | Supported | GCP workload or service-account credentials |
| Qwen / DeepSeek via DashScope | Supported | `DASHSCOPE_API_KEY` |
| Your own OpenAI-compatible endpoint | Supported | Base URL + key, added in the app |
| ChatGPT / Codex subscription | **Beta** | Sign in with ChatGPT; no API key |
| Claude outage fallback | Optional | `ANTHROPIC_API_KEY` |

The ChatGPT lane uses Codex-managed OAuth and live model discovery (design:
[`docs/plans/chatgpt-codex-oauth.md`](./docs/plans/chatgpt-codex-oauth.md)).
It stays Beta until release validation passes on the supported OS matrix.

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

Out of the box it can remember, search the web, and manage your tasks, docs,
and Office files. Drop a meeting recording on it and the decisions land in the
brain. The brain is the point: the more you drop in, the sharper the rest gets.

### What it asks before doing

You make the calls, so it governs every tool by what that tool does, fail-closed:

- **Reads run on their own** (search, list, fetch). Looking things up is free.
- **Writes ask first** (send, create, update), until you tell it "always" for one.
- **Destructive actions stay blocked** (delete, revoke, cancel) until you turn
  them on per tool.

A fresh install reads and drafts freely, but it cannot send an email or delete an
event without you. You set the policy per tool in the app.

## Channels

Every channel is configured in the app under **Studio → Channels**.

| Channel | Setup |
|---|---|
| Web + desktop app | Ships in the box |
| Telegram | Your own bot token; webhook needs a public HTTPS tunnel |
| Slack | Your own Slack app; same tunnel |
| Discord | Your own bot; no tunnel, a local Gateway bridge ships in the box |
| WhatsApp | Personal number via a QR-paired local bridge, or the official Cloud API with your Meta app |
| WeChat | Personal account via a QR-paired local bridge |
| Microsoft Teams | Your own Microsoft Entra app |
| Feishu / Lark | Your own Feishu app |
| Email | An IMAP mailbox it reads, files, and replies from |

## Connectors

Gmail, Google Calendar, Google Drive, Notion, GitHub, Fathom, Shopify,
WordPress, Google Search Console, and Microsoft 365 ship built in, and any MCP
server can be added as a custom connector. Google, Notion, and Fathom need your
own OAuth app keys in `.env`; the rest connect inside the app. The same
read / write / destructive policy above applies to every connector tool.

The My Browser extension pairs Chrome or Firefox; for Firefox on a headless
server, see [`apps/firefox-companion/README.md`](./apps/firefox-companion/README.md).

## More keys, more reach

One model key is the floor, not the ceiling. Each key below is optional, and
each is a service you choose to talk to, so nothing turns on by itself.

| Capability | Key(s) to set | What you get |
|---|---|---|
| Web search | `BRAVE_SEARCH_API_KEY`, `SERPER_API_KEY`, `SERPAPI_API_KEY`, `TAVILY_API_KEY`, or `BAIDU_SEARCH_API_KEY` | Upgrade the search tool past the free DuckDuckGo fallback; Baidu adds Chinese-language and mainland-China coverage |
| Page fetches | `JINA_API_KEY` | Cleaner page reads via Jina Reader (works keyless at lower limits) |
| Read X / Twitter | `TWITTER_BEARER_TOKEN` | Read x.com permalinks through the official X API v2 |
| X search | `XAI_API_KEY` | Fall back to xAI Grok and enable the `xSearch` tool |
| Model fallback | `FALLBACK_PROVIDER_ENABLED=true` + `ANTHROPIC_API_KEY` | Keep running if your main backend is unavailable |

Every key is documented in [`.env.example`](./.env.example).

## What's in the box

| Layer | What it does |
|---|---|
| **Engine** | Query loop, tool executor, compaction, provider abstraction. |
| **Brain** | Memory, hybrid retrieval (RRF + MMR), an entity / edge / task graph, a knowledge base, and the consolidation / dreaming loop with SOUL synthesis. |
| **Agent** | A chat loop that uses your tools and connectors to do the work, not describe it. |
| **Workflows** | Multi-step automations with schedules, triggers, conditions, and approvals. |
| **Docs & Office** | The collaborative canvas plus documents, presentations, and spreadsheets (local sync sidecar; LibreOffice-rendered PDF export). |
| **Channels** | Adapters for every channel above, plus a bridge protocol for custom channels. |
| **API + MCP** | A public API and an MCP server, so your other agents and tools can use the brain too. |
| **App** | The web and desktop frontend. |

## Hosted, and hands-on help

The hosted version at [usebrian.ai](https://usebrian.ai) is the same product,
run for you: sign in at [app.usebrian.ai](https://app.usebrian.ai), nothing to
keep alive, and when you add teammates the app offers a one-click migration
from your self-host, no re-entry.

Prefer it wired into your company for you?
[Brian Studio](https://studio.usebrian.ai) is the services arm: AI ops audits,
implementation, and training from the team that builds Use Brian. Details at
[studio.usebrian.ai](https://studio.usebrian.ai), or write to
[sales@usebrian.ai](mailto:sales@usebrian.ai).

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
