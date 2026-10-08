# Self-hosting reference

The [README](../README.md) gets you running with `pnpm dev`. This page covers
everything past that: model backends, optional keys, channel setup, and the
prebuilt container images. Every environment variable is also documented in
[`.env.example`](../.env.example).

## Local defaults

| Thing | Default | Override |
|---|---|---|
| Database | Embedded PGLite under `~/.usebrian/` | `DATABASE_URL` pointing at PostgreSQL |
| Files | `~/.usebrian/files` | Storage connectors (GCS, S3-compatible, local directory) in the app |
| Recording and video ingestion | Needs `ffmpeg` and `ffprobe` on `PATH` | |
| PDF export | Needs LibreOffice (`soffice`) on `PATH` | |

Model requests go only to the backend you configure. Connectors and upgraded
search providers make outbound calls only when you turn them on. Your local
database and files are never moved to a Brian-hosted service.

## Model backends

| Backend | Status | Authentication |
|---|---|---|
| Gemini via Google AI Studio | Supported | `GEMINI_API_KEY` |
| Gemini via Vertex AI | Supported | GCP workload or service-account credentials |
| Qwen / DeepSeek via DashScope | Supported | `DASHSCOPE_API_KEY` |
| Your own OpenAI-compatible endpoint | Supported | Base URL + key, added in the app |
| ChatGPT / Codex subscription | **Beta** | Sign in with ChatGPT; no API key |
| Claude outage fallback | Optional | `FALLBACK_PROVIDER_ENABLED=true` + `ANTHROPIC_API_KEY` |

The ChatGPT lane uses Codex-managed OAuth and live model discovery (design:
[`plans/chatgpt-codex-oauth.md`](./plans/chatgpt-codex-oauth.md)). It stays
Beta until release validation passes on the supported OS matrix.

TypeSafe Jev is an optional classifier for small typed decisions, not a chat
backend. `TYPESAFE_API_KEY` registers its transport, but every operation stays
LLM-only until the deployment supplies an operation-specific, version-matched
recorded evaluation profile and explicitly selects bounded shadow or hybrid
routing. The key alone changes no production decision path.

## Optional keys

Each key is a service you choose to talk to. Nothing turns on by itself.

| Capability | Key(s) | What you get |
|---|---|---|
| Web search | `BRAVE_SEARCH_API_KEY`, `SERPER_API_KEY`, `SERPAPI_API_KEY`, `TAVILY_API_KEY`, or `BAIDU_SEARCH_API_KEY` | Upgrades search past the free DuckDuckGo fallback; Baidu adds Chinese-language and mainland-China coverage |
| Page fetches | `JINA_API_KEY` | Cleaner page reads via Jina Reader (works keyless at lower limits) |
| Read X / Twitter | `TWITTER_BEARER_TOKEN` | Reads x.com permalinks through the official X API v2 |
| X search | `XAI_API_KEY` | Falls back to xAI Grok and enables the `xSearch` tool |
| Google, Notion, Fathom connectors | Their OAuth client id + secret | Your own OAuth apps; every other connector connects inside the app |

## Channels

Every channel is configured in the app under **Studio → Channels**.

| Channel | Setup |
|---|---|
| Web + desktop app | Ships in the box |
| Telegram | Your own bot token; the webhook needs a public HTTPS tunnel. See [Telegram channels](./telegram-channels.md) |
| Slack | Your own Slack app; same tunnel |
| Discord | Your own bot; no tunnel, a local Gateway bridge ships in the box |
| WhatsApp | Personal number via a QR-paired local bridge, or the official Cloud API with your Meta app |
| WeChat | Personal account via a QR-paired local bridge, or the [desktop bridge](../apps/wechat-desktop-bridge/README.md) |
| Microsoft Teams | Your own Microsoft Entra app |
| Feishu / Lark | Your own Feishu app |
| Email | An IMAP mailbox it reads, files, and replies from |

The My Browser extension pairs Chrome or Firefox. For Firefox on a headless
server, see [`apps/firefox-companion/README.md`](../apps/firefox-companion/README.md).

## Container images

Prebuilt images for the independently deployable services are published to the
[GitHub Container Registry](https://github.com/orgs/use-brian/packages):

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

Tags: `latest` for the current `main` build, `develop` for the development
branch, `v*` for releases, or `sha-<commit>` to pin an exact build. Desktop
apps, browser extensions, and the Firefox native companion stay native
installable artifacts, not containers.

- **API image:** listens on port `4000` and requires a migrated PostgreSQL
  database.
- **App image:** listens on port `3003` and is configured at container start,
  not build time. The server injects allowlisted public values into the initial
  HTML, so changing domains means recreating the container and reloading the
  page, never rebuilding the image. Use `API_URL` for its private
  server-to-server API address.

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

### App runtime variables

Only these values are serialized into browser JavaScript. Database URLs, OAuth
client secrets, JWTs, connector secrets, and encryption keys stay server-only.

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

## Moving to hosted

When you add teammates, the app offers a one-click migration from your
self-host to [app.usebrian.ai](https://app.usebrian.ai), with no re-entry.
