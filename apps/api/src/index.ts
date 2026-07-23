/**
 * Open standalone entry for the Use Brian HTTP API (`@use-brian/api-open`).
 *
 * This is the single-player, one-key local product entrypoint. It imports ZERO
 * closed code: no `@use-brian/api-platform`, no `@use-brian/shared-server`, no
 * `getEnv()`. It reads the handful of values the open composition needs straight
 * from `process.env` (with local defaults), then calls `bootOpenApi()` with no
 * ports — every closed seam falls back to its safe default (allow-all credit
 * gate, no-op usage recorder, inert feed hooks). The brain
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

dotenv.config()

// The `gemini` provider can be backed by AI Studio (GEMINI_API_KEY) or Vertex
// (VERTEX_PROJECT_ID), and a deployment can run Qwen-only via DASHSCOPE_API_KEY.
// Require at least one usable LLM credential rather than GEMINI_API_KEY
// specifically — a region where Google blocks the AI Studio developer API
// (e.g. Hong Kong) has no such key and reaches Gemini via Vertex instead.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY
if (!GEMINI_API_KEY && !VERTEX_PROJECT_ID && !DASHSCOPE_API_KEY) {
  console.error(
    '[api-open] No LLM credential set. Provide GEMINI_API_KEY (AI Studio), ' +
    'VERTEX_PROJECT_ID (Vertex AI), or DASHSCOPE_API_KEY (Qwen), then restart.',
  )
  process.exit(1)
}

// JWT_SECRET is auto-generated + persisted by the launcher; for a bare boot we
// fall back to a process-local random one (sessions don't survive a restart,
// which is fine for a single-process dev boot).
const JWT_SECRET = process.env.JWT_SECRET || (await import('node:crypto')).randomUUID()

const env: OpenApiEnv = {
  GEMINI_API_KEY,
  VERTEX_PROJECT_ID,
  VERTEX_LOCATION: process.env.VERTEX_LOCATION,
  VERTEX_SERVICE_ACCOUNT_JSON: process.env.VERTEX_SERVICE_ACCOUNT_JSON,
  JWT_SECRET,
  NODE_ENV: process.env.NODE_ENV || 'development',
  API_URL: process.env.API_URL || 'http://localhost:4000',
  APP_URL: process.env.APP_URL || 'http://localhost:3003',
  PORT: process.env.PORT,
  VOICE_TRANSCRIPTION_ENABLED: process.env.VOICE_TRANSCRIPTION_ENABLED === 'true',
  VOICE_TRANSCRIPTION_MODEL: process.env.VOICE_TRANSCRIPTION_MODEL,
  FALLBACK_PROVIDER_ENABLED: process.env.FALLBACK_PROVIDER_ENABLED === 'true',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL,
  GCS_FILES_BUCKET: process.env.GCS_FILES_BUCKET,
  LOCAL_FILES_DIR: process.env.LOCAL_FILES_DIR,
  LOCAL_FILES_PUBLIC_URL: process.env.LOCAL_FILES_PUBLIC_URL,
  LOCAL_FILESYSTEM_SOURCES_ENABLED: true,
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
  COMPUTER_USE_UNATTENDED_ENABLED: process.env.COMPUTER_USE_UNATTENDED_ENABLED === 'true',
  // AES-GCM key for connector credentials at rest. The launcher generates +
  // persists it; absent (bare `node index.js` boot) → connectors can't store
  // credentials, every other surface is unaffected. Also encrypts BYO channel
  // bot credentials (channel_integrations) — with it set, Studio → Channels
  // connect + the Telegram/Slack webhooks work locally.
  CHANNEL_CREDENTIAL_KEY: process.env.CHANNEL_CREDENTIAL_KEY,
  // Optional self-hosted Discord Gateway bridge (see .env.example). Both set →
  // the Discord connect endpoint + /internal/discord inbound are live; unset →
  // Discord connect returns 503, Telegram/Slack unaffected.
  DISCORD_CONNECTOR_URL: process.env.DISCORD_CONNECTOR_URL,
  DISCORD_CONNECTOR_SECRET: process.env.DISCORD_CONNECTOR_SECRET,
  // Optional self-hosted WhatsApp bridge. The launcher starts one locally and
  // supplies both values; bare API boots leave WhatsApp unavailable when unset.
  WA_CONNECTOR_URL: process.env.WA_CONNECTOR_URL,
  WA_CONNECTOR_SECRET: process.env.WA_CONNECTOR_SECRET,
}

// Wire the OPEN Pipeline B episode ingestors so brain distillation (doc-page
// "Sync to brain", brain-MCP ingestToBrain, chat compaction) runs locally. This
// is the one closed seam the open edition fills with an open impl over the same
// store graph — see packages/api/src/build-episode-ingestors.ts.
const { start } = await bootOpenApi({
  env,
  runWorkers: true,
  ports: { buildEpisodeIngestors, buildChannelHosts: buildOpenChannelHosts },
})
await start()
