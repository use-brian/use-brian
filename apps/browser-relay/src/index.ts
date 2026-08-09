/**
 * browser-relay — the computer-use local-mode bridge (spec:
 * docs/architecture/engine/computer-use.md §4).
 *
 * Terminates the browser extension's WebSocket (`/ext`), verifies P1.3
 * pairing tokens, holds the in-memory `userId → connection` registry, and
 * exposes `POST /internal/browser/command` for the api's relay transport.
 * **Single-instance** on Cloud Run (min=max=1) — the registry is process
 * memory, the wa/discord-connector deployment shape.
 */

import { createServer } from 'node:http'
import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  signBrowserExtSessionToken,
  verifyBrowserExtHelloToken,
} from '@use-brian/api/auth/browser-ext-pair-token.js'
import { relaySecretMatches } from './auth.js'
import { getEnv } from './env.js'
import { BrowserRelay } from './relay.js'
import { InternalCommandRequestSchema } from './protocol.js'

const env = getEnv()
const app = express()
app.use(express.json({ limit: '1mb' }))

const relay = new BrowserRelay({
  verifyPairingToken: (token) => verifyBrowserExtHelloToken(token, env.JWT_SECRET),
  mintSessionToken: (identity) => signBrowserExtSessionToken(identity, env.JWT_SECRET),
})

// ── Health check (no auth) ────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', connections: relay.connectionCount() })
})

// ── Auth: shared secret on every /internal route ──────────────
app.use('/internal', (req, res, next) => {
  if (!relaySecretMatches(req.headers['x-relay-secret'], env.BROWSER_RELAY_SECRET)) {
    res.status(401).json({ error: 'Invalid or missing X-Relay-Secret' })
    return
  }
  next()
})

// ── Command routing (P1.4) ────────────────────────────────────
app.post('/internal/browser/command', async (req, res) => {
  const parsed = InternalCommandRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'userId and op are required' })
    return
  }
  const result = await relay.dispatchCommand(parsed.data)
  res.json(result)
})

app.get('/internal/browser/status/:userId', (req, res) => {
  res.json(relay.connectionStatus(req.params.userId))
})

// ── WebSocket endpoint for extensions ─────────────────────────
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ext', maxPayload: 8 * 1024 * 1024 })

wss.on('connection', (socket: WebSocket) => {
  socket.on('message', (raw) => relay.handleMessage(socket, raw as Buffer))
  socket.on('close', () => relay.handleDisconnect(socket))
  socket.on('error', () => relay.handleDisconnect(socket))
})

const sweep = setInterval(() => relay.sweepDead(), 30_000)

server.listen(env.PORT, env.HOST, () => {
  console.log(`browser-relay listening on ${env.HOST}:${env.PORT}`)
})

// ── Graceful shutdown ─────────────────────────────────────────
function shutdown(): void {
  console.log('Shutting down browser-relay...')
  clearInterval(sweep)
  wss.close()
  server.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
