/**
 * wechat-connector — holds iLink long-poll sessions (and QR pairing sessions)
 * and relays inbound WeChat DMs to brian-api over HTTP.
 *
 * Inbound-only: outbound sends go API → iLink REST directly (plain HTTPS), so
 * this service has no /send route — only pairing (/pair/*) and lifecycle
 * control (/connect, /disconnect, /status). The architectural twin is
 * apps/discord-connector; like Discord there is no GCS credential store (the
 * bot token + base URL are the credentials and live in the API's
 * `channel_integrations`). Single-instance (min=max=1, no CPU throttling):
 * iLink allows exactly one poller per bot account (exclusive lock), and the
 * loops live in process memory.
 *
 * See docs/architecture/channels/wechat.md.
 */

import express from 'express'
import { connectorSecretMatches } from './auth.js'
import { getEnv } from './env.js'
import { createPollerManager } from './poller-manager.js'
import { createPairingManager } from './pairing-manager.js'

const env = getEnv()
const app = express()
app.use(express.json())

// ── Health check (no auth) ────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// ── Auth: shared secret on every other route (constant-time, fail-closed) ──
app.use((req, res, next) => {
  if (!connectorSecretMatches(req.headers['x-connector-secret'], env.WECHAT_CONNECTOR_SECRET)) {
    res.status(401).json({ error: 'Invalid or missing X-Connector-Secret' })
    return
  }
  next()
})

const pollers = createPollerManager({
  apiUrl: env.USEBRIAN_API_URL,
  connectorSecret: env.WECHAT_CONNECTOR_SECRET,
})
const pairings = createPairingManager()

// ── QR pairing routes ─────────────────────────────────────────

app.post('/pair/start', async (_req, res) => {
  try {
    const started = await pairings.start()
    res.status(201).json(started)
  } catch (err) {
    console.error('[wechat-connector] pair/start failed:', err)
    res.status(502).json({ error: 'Failed to fetch a login QR from iLink' })
  }
})

app.get('/pair/:pairingId/status', (req, res) => {
  const snapshot = pairings.getStatus(req.params.pairingId)
  if (!snapshot) {
    res.status(404).json({ error: 'unknown_pairing' })
    return
  }
  res.json(snapshot)
})

app.post('/pair/:pairingId/verify-code', (req, res) => {
  const { code } = (req.body ?? {}) as { code?: string }
  if (!code || !code.trim()) {
    res.status(400).json({ error: 'code is required' })
    return
  }
  if (!pairings.submitVerifyCode(req.params.pairingId, code)) {
    res.status(404).json({ error: 'unknown_pairing' })
    return
  }
  res.json({ ok: true })
})

// ── Lifecycle routes ──────────────────────────────────────────

// Start (or replace) the long-poll loop for a channel's bot.
app.post('/connect/:channelId', (req, res) => {
  const { channelId } = req.params
  const { botToken, baseUrl, getUpdatesBuf } = (req.body ?? {}) as {
    botToken?: string
    baseUrl?: string
    getUpdatesBuf?: string
  }
  if (!botToken || !baseUrl) {
    res.status(400).json({ error: 'botToken and baseUrl are required' })
    return
  }
  const managed = pollers.connect(channelId, { botToken, baseUrl, getUpdatesBuf })
  res.json({ channelId: managed.channelId, status: managed.status })
})

app.post('/disconnect/:channelId', (req, res) => {
  pollers.disconnect(req.params.channelId)
  res.json({ ok: true })
})

app.get('/status/:channelId', (req, res) => {
  const managed = pollers.getStatus(req.params.channelId)
  if (!managed) {
    res.status(404).json({ error: 'not_connected' })
    return
  }
  res.json(managed)
})

// ── Start server ──────────────────────────────────────────────
const server = app.listen(env.PORT, async () => {
  console.log(`wechat-connector listening on port ${env.PORT}`)
  try {
    await pollers.restoreAll()
  } catch (err) {
    console.error('Failed to restore wechat pollers:', err)
  }
})

// ── Graceful shutdown ─────────────────────────────────────────
function shutdown(): void {
  console.log('Shutting down wechat-connector...')
  server.close()
  pairings.stopAll()
  pollers.disconnectAll()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
