/**
 * browser-relay — the computer-use local-mode bridge (spec:
 * docs/architecture/engine/computer-use.md §4).
 *
 * Terminates the browser extension's WebSocket (`/ext`), verifies P1.3
 * pairing tokens, holds the in-memory `(userId, browserProfileId) → connection`
 * registry, and
 * exposes `POST /internal/browser/command` for the api's relay transport.
 * **Single-instance** on Cloud Run (min=max=1) — the registry is process
 * memory, the wa/discord-connector deployment shape.
 */

import { createServer } from 'node:http'
import express, { type Request, type Response } from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  signBrowserExtSessionToken,
  verifyBrowserExtHelloToken,
} from '@use-brian/api/auth/browser-ext-pair-token.js'
import { createBrowserAuthorityClient, relaySecretMatches } from './auth.js'
import { getEnv } from './env.js'
import { BrowserRelay } from './relay.js'
import { InternalCommandRequestSchema } from './protocol.js'

const env = getEnv()
const app = express()

const relay = new BrowserRelay({
  authorize: createBrowserAuthorityClient(env.BROWSER_AUTHORITY_API_URL),
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
// Parse only after shared-secret authentication. A 4 MiB upload is ~5.34 MiB
// of base64; leave room for its command envelope while staying below WS's 8 MiB cap.
const commandHandler = (taskBound: boolean) => async (req: Request, res: Response) => {
  const parsed = InternalCommandRequestSchema.safeParse(req.body)
  if (!parsed.success || (taskBound && !parsed.data.taskId)) {
    res.status(400).json({ error: taskBound ? 'userId, browserProfileId, taskId, and op are required' : 'userId, browserProfileId, and op are required' })
    return
  }
  const result = await relay.dispatchCommand(parsed.data)
  res.json(result)
}
app.post('/internal/browser/command', express.json({ limit: '6mb' }), commandHandler(false))
// A separate path makes old relays reject bound commands before any effect.
app.post('/internal/browser/task-command', express.json({ limit: '6mb' }), commandHandler(true))

app.get('/internal/browser/status/:userId', (req, res) => {
  res.json(
    relay.connectionStatus(req.params.userId, {
      ...(typeof req.query.browserProfileId === 'string'
        ? { browserProfileId: req.query.browserProfileId }
        : {}),
      ...(typeof req.query.workspaceId === 'string' ? { workspaceId: req.query.workspaceId } : {}),
    }),
  )
})

// ── WebSocket endpoint for extensions ─────────────────────────
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ext', maxPayload: 8 * 1024 * 1024 })

wss.on('connection', (socket: WebSocket, request) => {
  socket.on('message', (raw) => {
    void relay.handleMessage(socket, raw as Buffer, request.headers.origin).catch(() => {
      relay.handleDisconnect(socket)
      socket.close(4401, 'authority unavailable')
    })
  })
  socket.on('close', () => relay.handleDisconnect(socket))
  socket.on('error', () => relay.handleDisconnect(socket))
})

let renewing = false
const sweep = setInterval(() => {
  relay.sweepDead()
  if (renewing) return
  renewing = true
  void relay.renewAuthority().finally(() => { renewing = false })
}, 15_000)

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
