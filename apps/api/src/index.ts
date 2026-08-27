/**
 * Open standalone entry for the Use Brian HTTP API (`@use-brian/api-open`).
 *
 * This is the single-player, one-key local product entrypoint. It imports ZERO
 * closed code: no `@use-brian/api-platform`, no `@use-brian/shared-server`, no
 * `getEnv()`. It reads the handful of values the open composition needs straight
 * from `process.env` (with local defaults), then calls `bootOpenApi()` with
 * open implementations for the seams standalone needs (including the local
 * COGS usage recorder). Every closed seam keeps its safe default (allow-all
 * credit gate, inert feed hooks). The brain
 * still dreams (consolidation runs on the local timer); billing and
 * feed-distribution are simply absent. Connectors and the BYO messaging
 * channels (Telegram / Slack / Discord-with-bridge) ARE part of the open
 * composition — bootOpenApi mounts them when CHANNEL_CREDENTIAL_KEY is set
 * (migrations 280 + 307 create their storage in the OSS schema).
 *
 * See the open-core split (repo CLAUDE.md; plan in git history) §12.7 (one-command parity boot).
 */

import dotenv from 'dotenv'
import { bootOpenApi, type OpenApiEnv } from '@use-brian/api/boot.js'
import { buildEpisodeIngestors } from '@use-brian/api/build-episode-ingestors.js'
import { buildOpenChannelHosts } from '@use-brian/api/channel-hosts.js'
import { loadLocalProviderPreference } from '@use-brian/api/local-provider-preference.js'
import { createBrowserCredentialStore } from '@use-brian/api/db/browser-credential-store.js'
import { createBrowserProfileStore } from '@use-brian/api/db/browser-profile-store.js'
import { createBrowserSessionVault } from '@use-brian/api/db/browser-session-vault.js'
import { createBrowserSkillGrantStore } from '@use-brian/api/db/browser-skill-grant-store.js'
import { createOssUsageStore } from '@use-brian/api/db/oss-usage-store.js'
import { createSandboxTaskStore } from '@use-brian/api/db/sandbox-task-store.js'
import { parseStrictBoolean } from '@use-brian/api/auth/outpost-auth-config.js'

dotenv.config()

// API-key providers are optional in OSS. With none configured, boot still
// starts the isolated Codex runtime and the authenticated local Settings route
// so the owner can choose "Sign in with ChatGPT" without first inventing a
// placeholder API key.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY
const USEBRIAN_PREFERRED_PROVIDER =
  process.env.USEBRIAN_PREFERRED_PROVIDER || (await loadLocalProviderPreference()) || undefined

// JWT_SECRET is auto-generated + persisted by the launcher; for a bare boot we
// fall back to a process-local random one (sessions don't survive a restart,
// which is fine for a single-process dev boot).
const JWT_SECRET = process.env.JWT_SECRET || (await import('node:crypto')).randomUUID()

// Validate before using the mechanically graded default forms below. The
// canonical expressions keep OSS/hosted defaults visible to `pnpm check`; this
// guard still rejects every value outside true/false/1/0.
parseStrictBoolean(process.env.OUTPOST_AUTH_EMAIL_ENABLED, 'OUTPOST_AUTH_EMAIL_ENABLED', true)
parseStrictBoolean(process.env.OUTPOST_AUTH_OIDC_ENABLED, 'OUTPOST_AUTH_OIDC_ENABLED', false)

const env: OpenApiEnv = {
  GEMINI_API_KEY,
  VERTEX_PROJECT_ID,
  VERTEX_LOCATION: process.env.VERTEX_LOCATION,
  VERTEX_SERVICE_ACCOUNT_JSON: process.env.VERTEX_SERVICE_ACCOUNT_JSON,
  JWT_SECRET,
  NODE_ENV: process.env.NODE_ENV || 'development',
  API_URL: process.env.API_URL || 'http://localhost:4000',
  APP_URL: process.env.APP_URL || 'http://localhost:3003',
  AUTHED_APP_URL: process.env.AUTHED_APP_URL,
  AUTH_PORTAL_URL: process.env.AUTH_PORTAL_URL,
  OUTPOST_AUTH_EMAIL_ENABLED: !['false', '0'].includes(
    (process.env.OUTPOST_AUTH_EMAIL_ENABLED ?? '').trim().toLowerCase(),
  ),
  OUTPOST_AUTH_OIDC_ENABLED: process.env.OUTPOST_AUTH_OIDC_ENABLED === 'true'
    || process.env.OUTPOST_AUTH_OIDC_ENABLED === '1',
  OUTPOST_OIDC_ISSUER_URL: process.env.OUTPOST_OIDC_ISSUER_URL,
  OUTPOST_OIDC_CLIENT_ID: process.env.OUTPOST_OIDC_CLIENT_ID,
  OUTPOST_OIDC_CLIENT_SECRET: process.env.OUTPOST_OIDC_CLIENT_SECRET,
  OUTPOST_OIDC_PROVIDER_NAME: process.env.OUTPOST_OIDC_PROVIDER_NAME,
  OUTPOST_AUTH_BRIDGE_SECRET: process.env.OUTPOST_AUTH_BRIDGE_SECRET,
  GMAIL_SMTP_USER: process.env.GMAIL_SMTP_USER,
  GMAIL_SMTP_APP_PASSWORD: process.env.GMAIL_SMTP_APP_PASSWORD,
  EMAIL_FROM_ADDRESS: process.env.EMAIL_FROM_ADDRESS,
  SUPPORT_DIAGNOSTICS_ENABLED: !['false', '0'].includes(
    (process.env.BRIAN_SUPPORT_DIAGNOSTICS_ENABLED ?? '').trim().toLowerCase(),
  ),
  PORT: process.env.PORT,
  // Default ON, matching the hosted `boolFlag(true)` and the documented
  // default in docs/architecture/media/transcription.md. This is an OPS KILL
  // SWITCH, never an opt-in: until 2026-07-29 the open entry spelled it
  // `=== 'true'`, so every self-host booted with voice transcription OFF and
  // silently dropped every Telegram voice note (nothing in .env.example or
  // deploy-brian ever set it). Graded by `pnpm check` (invariants/oss-env-defaults).
  VOICE_TRANSCRIPTION_ENABLED: !['false', '0'].includes(
    (process.env.VOICE_TRANSCRIPTION_ENABLED ?? '').trim().toLowerCase(),
  ),
  VOICE_TRANSCRIPTION_MODEL: process.env.VOICE_TRANSCRIPTION_MODEL,
  FALLBACK_PROVIDER_ENABLED: process.env.FALLBACK_PROVIDER_ENABLED === 'true',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  GOOGLE_MAPS_SERVER_API_KEY: process.env.GOOGLE_MAPS_SERVER_API_KEY,
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  USEBRIAN_PREFERRED_PROVIDER,
  DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL,
  DASHSCOPE_VISION_MODEL: process.env.DASHSCOPE_VISION_MODEL,
  DASHSCOPE_ASR_MODEL: process.env.DASHSCOPE_ASR_MODEL,
  DASHSCOPE_LONG_MODEL: process.env.DASHSCOPE_LONG_MODEL,
  DASHSCOPE_FILETRANS_MODEL: process.env.DASHSCOPE_FILETRANS_MODEL,
  GCS_FILES_BUCKET: process.env.GCS_FILES_BUCKET,
  LOCAL_FILES_DIR: process.env.LOCAL_FILES_DIR,
  LOCAL_FILES_PUBLIC_URL: process.env.LOCAL_FILES_PUBLIC_URL,
  LOCAL_FILESYSTEM_SOURCES_ENABLED: process.env.LOCAL_FILESYSTEM_SOURCES_ENABLED === 'true',
  // Default ON (2026-07-23): the skill curator is core self-improving-brain
  // value, so it runs unless a deploy opts out with an explicit false/0.
  // Spend is bounded (active sessions only, 10-turn nudge, 10 ops/day cap).
  SKILLS_AUTO_GEN_ENABLED: !['false', '0'].includes(
    (process.env.SKILLS_AUTO_GEN_ENABLED ?? '').trim().toLowerCase(),
  ),
  BROWSER_RELAY_URL: process.env.BROWSER_RELAY_URL,
  BROWSER_RELAY_SECRET: process.env.BROWSER_RELAY_SECRET,
  E2B_API_KEY: process.env.E2B_API_KEY,
  E2B_TEMPLATE_ID: process.env.E2B_TEMPLATE_ID,
  BROWSER_USE_MODEL: process.env.BROWSER_USE_MODEL,
  COMPUTER_USE_UNATTENDED_ENABLED: process.env.COMPUTER_USE_UNATTENDED_ENABLED === 'true',
  // AES-GCM key for connector credentials at rest. The launcher generates +
  // persists it; absent (bare `node index.js` boot) → connectors can't store
  // credentials, every other surface is unaffected. Also encrypts BYO channel
  // bot credentials (channel_integrations) — with it set, Studio → Channels
  // connect + the Telegram/Slack webhooks work locally.
  CHANNEL_CREDENTIAL_KEY: process.env.CHANNEL_CREDENTIAL_KEY,
  // Optional paid managed Feed plane. Point this at the hosted API origin;
  // leaving it unset preserves the complete local manual-posting path.
  MANAGED_FEED_CLOUD_URL:
    process.env.MANAGED_FEED_CLOUD_URL ?? 'https://api.usebrian.ai',
  // Optional self-hosted Discord Gateway bridge (see .env.example). Both set →
  // the Discord connect endpoint + /internal/discord inbound are live; unset →
  // Discord connect returns 503, Telegram/Slack unaffected.
  DISCORD_CONNECTOR_URL: process.env.DISCORD_CONNECTOR_URL,
  DISCORD_CONNECTOR_SECRET: process.env.DISCORD_CONNECTOR_SECRET,
  FEISHU_CONNECTOR_URL: process.env.FEISHU_CONNECTOR_URL,
  FEISHU_CONNECTOR_SECRET: process.env.FEISHU_CONNECTOR_SECRET,
  // Optional self-hosted WhatsApp bridge. The launcher starts one locally and
  // supplies both values; bare API boots leave WhatsApp unavailable when unset.
  WA_CONNECTOR_URL: process.env.WA_CONNECTOR_URL,
  WA_CONNECTOR_SECRET: process.env.WA_CONNECTOR_SECRET,
  // Optional local WeChat iLink bridge. The launcher starts it and supplies
  // both values so Studio QR pairing and inbound polling are available.
  WECHAT_CONNECTOR_URL: process.env.WECHAT_CONNECTOR_URL,
  WECHAT_CONNECTOR_SECRET: process.env.WECHAT_CONNECTOR_SECRET,
  BRIAN_MESSAGE_STORE_URL: process.env.BRIAN_MESSAGE_STORE_URL,
  BRIAN_MESSAGE_STORE_HMAC_SECRET: process.env.BRIAN_MESSAGE_STORE_HMAC_SECRET,
  LLM_PROVIDER_KEY_ENCRYPTION_KEY: process.env.LLM_PROVIDER_KEY_ENCRYPTION_KEY,
}

// Wire the OPEN Pipeline B episode ingestors so brain distillation (doc-page
// "Sync to brain", brain-MCP ingestToBrain, chat compaction) runs locally. This
// is the one closed seam the open edition fills with an open impl over the same
// store graph — see packages/api/src/build-episode-ingestors.ts.
const browserEncryptionKey = process.env.BROWSER_VAULT_ENCRYPTION_KEY
  ? Buffer.from(process.env.BROWSER_VAULT_ENCRYPTION_KEY, 'base64')
  : null
const browserCredentialEncryptionKey = process.env.BROWSER_CREDENTIAL_ENCRYPTION_KEY
  ? Buffer.from(process.env.BROWSER_CREDENTIAL_ENCRYPTION_KEY, 'base64')
  : null

const { start } = await bootOpenApi({
  env,
  runWorkers: true,
  ports: {
    usageStore: createOssUsageStore(),
    buildEpisodeIngestors,
    buildChannelHosts: buildOpenChannelHosts,
    browserProfileStore: createBrowserProfileStore(),
    browserSkillGrantStore: createBrowserSkillGrantStore(),
    sandboxTaskStore: createSandboxTaskStore(),
    browserSessionVault: browserEncryptionKey
      ? createBrowserSessionVault({ encryptionKey: browserEncryptionKey })
      : undefined,
    browserCredentialStore: browserCredentialEncryptionKey
      ? createBrowserCredentialStore({ encryptionKey: browserCredentialEncryptionKey })
      : undefined,
  },
})
await start()
