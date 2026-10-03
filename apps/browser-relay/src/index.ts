import { nativeReadinessHandler } from './native-readiness.js'
import { NativeRelay } from './native-relay.js'
import { verifyNativeToken } from '@use-brian/api/auth/native-computer-token.js'
import { GrantSchema, sameIdentity } from '@use-brian/computer-control/protocol.js'
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
const nativeEnabled = process.env.NATIVE_COMPUTER_ENABLED === 'true'
const native = new NativeRelay(token => verifyNativeToken(token, env.JWT_SECRET))

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
// Parse only after shared-secret authentication. A 4 MiB upload is ~5.34 MiB
// of base64; leave room for its command envelope while staying below WS's 8 MiB cap.
app.post('/internal/browser/command', express.json({ limit: '6mb' }), async (req, res) => {
  const parsed = InternalCommandRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'userId, browserProfileId, and op are required' })
    return
  }
  const result = await relay.dispatchCommand(parsed.data)
  res.json(result)
})

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

app.get('/internal/native-computer/readiness', nativeReadinessHandler(nativeEnabled))

app.use('/internal/native-computer', (_req, res, next) => {
  if (!nativeEnabled) { res.sendStatus(404); return }
  next()
})
app.post('/internal/native-computer/register', express.json({ limit: '32kb' }), (req, res) => {
  try {
    const grant = GrantSchema.parse(req.body.grant)
    const claims = verifyNativeToken(req.body.token, env.JWT_SECRET)
    if (!claims || !sameIdentity(claims.identity, grant.identity) || claims.grantId !== grant.grantId || claims.epoch !== grant.epoch || claims.exp !== grant.expiresAt) { res.sendStatus(403); return }
    native.register(grant, claims.jti); res.json({ ok: true })
  } catch { res.sendStatus(409) }
})
app.post('/internal/native-computer/command', express.json({ limit: '32kb' }), async (req, res) => {
  try { res.json(await native.dispatch(req.body)) } catch { res.sendStatus(400) }
})
app.get('/internal/native-computer/sessions/:id', (req, res) => { native.sweep(); res.json(native.status(req.params.id)) })
app.delete('/internal/native-computer/sessions/:id', (req, res) => { native.revoke(req.params.id); res.json({ ok: true }) })

// ── WebSocket endpoint for extensions ─────────────────────────
const server = createServer(app)
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
const nativeWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
server.on('upgrade', (request, socket, head) => {
  const path = new URL(request.url ?? '/', 'http://relay').pathname
  const target = path === '/ext' ? wss : nativeEnabled && path === '/native-computer-v1' ? nativeWss : null
  if (!target) { socket.destroy(); return }
  target.handleUpgrade(request, socket, head, ws => target.emit('connection', ws, request))
})
nativeWss.on('connection', (socket: WebSocket) => {
  const helloTimeout = setTimeout(() => socket.close(4401, 'hello timeout'), 5000)
  socket.once('message', () => clearTimeout(helloTimeout))
  socket.on('message', raw => native.handle(socket, raw.toString()))
  socket.on('close', () => { clearTimeout(helloTimeout); native.disconnect(socket) })
  socket.on('error', () => native.disconnect(socket))
})

wss.on('connection', (socket: WebSocket, request) => {
  socket.on('message', (raw) => relay.handleMessage(socket, raw as Buffer, request.headers.origin))
  socket.on('close', () => relay.handleDisconnect(socket))
  socket.on('error', () => relay.handleDisconnect(socket))
})

const sweep = setInterval(() => { relay.sweepDead(); native.sweep() }, 5000)

server.listen(env.PORT, env.HOST, () => {
  console.log(`browser-relay listening on ${env.HOST}:${env.PORT}`)
})

// ── Graceful shutdown ─────────────────────────────────────────
function shutdown(): void {
  console.log('Shutting down browser-relay...')
  clearInterval(sweep)
  nativeWss.close()
  wss.close()
  server.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
