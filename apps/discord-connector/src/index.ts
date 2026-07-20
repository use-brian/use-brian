/**
 * discord-connector — holds Discord Gateway WebSocket connections and relays
 * inbound MESSAGE_CREATE events to brian-api over HTTP.
 *
 * Inbound-only: outbound sends go API → Discord REST directly (Discord REST is
 * plain HTTPS), so this service has no /send route — only lifecycle control
 * (/connect, /disconnect, /status). The architectural twin is apps/wa-connector,
 * but Discord needs no GCS credential store (the bot token is the credential and
 * lives in the API's `channel_integrations`).
 *
 * See docs/architecture/channels/discord.md.
 */

import express from 'express'
import { connectorSecretMatches } from './auth.js'
import { getEnv } from './env.js'
import { createGatewayManager } from './gateway-manager.js'

const env = getEnv()
const app = express()
app.use(express.json())

// ── Health check (no auth) ────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// ── Auth: shared secret on every other route (constant-time, fail-closed) ──
app.use((req, res, next) => {
  if (!connectorSecretMatches(req.headers['x-connector-secret'], env.DISCORD_CONNECTOR_SECRET)) {
    res.status(401).json({ error: 'Invalid or missing X-Connector-Secret' })
    return
  }
  next()
})

const manager = createGatewayManager({
  apiUrl: env.USEBRIAN_API_URL,
  connectorSecret: env.DISCORD_CONNECTOR_SECRET,
})

// ── Lifecycle routes ──────────────────────────────────────────

// Open (or replace) a gateway connection for a channel's bot.
app.post('/connect/:channelId', (req, res) => {
  const { channelId } = req.params
  const { botToken, botUserId } = (req.body ?? {}) as { botToken?: string; botUserId?: string }
  if (!botToken) {
    res.status(400).json({ error: 'botToken is required' })
    return
  }
  const managed = manager.connect(channelId, { botToken, botUserId })
  res.json({ channelId: managed.channelId, status: managed.status })
})

app.post('/disconnect/:channelId', (req, res) => {
  manager.disconnect(req.params.channelId)
  res.json({ ok: true })
})

app.get('/status/:channelId', (req, res) => {
  const managed = manager.getStatus(req.params.channelId)
  if (!managed) {
    res.status(404).json({ error: 'not_connected' })
    return
  }
  res.json(managed)
})

// ── Start server ──────────────────────────────────────────────
const server = app.listen(env.PORT, async () => {
  console.log(`discord-connector listening on port ${env.PORT}`)
  try {
    await manager.restoreAll()
  } catch (err) {
    console.error('Failed to restore gateway connections:', err)
  }
})

// ── Graceful shutdown ─────────────────────────────────────────
function shutdown(): void {
  console.log('Shutting down discord-connector...')
  server.close()
  manager.disconnectAll()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
