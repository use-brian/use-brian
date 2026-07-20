// The WhatsApp channel is ACTIVE in two models: BYON (a workspace's own number,
// read-only group ingest + optional bot mode) and the official shared business
// number (DM responder + group ingest of groups the bot is added to).
// See docs/architecture/channels/whatsapp.md.
import express from 'express'
import { connectorSecretMatches } from './auth.js'
import { getEnv } from './env.js'
import { createSocketManager } from './socket-manager.js'
import { connectRoutes } from './routes/connect.js'
import { sendRoutes } from './routes/send.js'
import { editRoutes } from './routes/edit.js'
import { disconnectRoutes } from './routes/disconnect.js'
import { statusRoutes } from './routes/status.js'
import { groupsRoutes } from './routes/groups.js'
import { leaveRoutes } from './routes/leave.js'
import { typingRoutes } from './routes/typing.js'
import { reactRoutes } from './routes/react.js'
import { connectionsRoutes } from './routes/connections.js'
import { Storage } from '@google-cloud/storage'
import pg from 'pg'

const env = getEnv()
const app = express()

app.use(express.json())

// ── Health check (no auth) ────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// ── Auth middleware for all other routes (constant-time, fail-closed) ──
app.use((req, res, next) => {
  if (!connectorSecretMatches(req.headers['x-connector-secret'], env.WA_CONNECTOR_SECRET)) {
    res.status(401).json({ error: 'Invalid or missing X-Connector-Secret' })
    return
  }
  next()
})

// ── Initialize GCS + Postgres + socket manager ───────────────
// GCS persists official responder channels; Postgres persists BYON ingest
// channels (table `wa_auth_state`). The pool is null when DATABASE_URL is
// unset — BYON connects then 503 while official channels keep working.
const storage = new Storage()
const bucket = storage.bucket(env.GCS_BUCKET_NAME)

const pool = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL }) : null
if (!pool) {
  console.warn('[wa-connector] DATABASE_URL unset — BYON (Postgres) credential persistence disabled')
}

const socketManager = createSocketManager({
  bucket,
  pool,
  apiUrl: env.USEBRIAN_API_URL,
  connectorSecret: env.WA_CONNECTOR_SECRET,
})

// ── Mount routes ─────────────────────────────────────────────
app.use('/connect', connectRoutes(socketManager))
app.use('/send', sendRoutes(socketManager))
app.use('/edit', editRoutes(socketManager))
app.use('/disconnect', disconnectRoutes(socketManager))
app.use('/status', statusRoutes(socketManager))
app.use('/groups', groupsRoutes(socketManager))
app.use('/leave', leaveRoutes(socketManager))
app.use('/typing', typingRoutes(socketManager))
app.use('/react', reactRoutes(socketManager))
app.use('/connections', connectionsRoutes(socketManager))

// ── Start server ─────────────────────────────────────────────
const server = app.listen(env.PORT, async () => {
  console.log(`wa-connector listening on port ${env.PORT}`)

  // Restore previously connected sockets: official from GCS, BYON from Postgres
  try {
    await socketManager.restoreAll()
    console.log('Restored sockets from stored credentials')
  } catch (err) {
    console.error('Failed to restore sockets:', err)
  }
})

// ── Graceful shutdown ────────────────────────────────────────
async function shutdown() {
  console.log('Shutting down wa-connector...')
  server.close()
  await socketManager.disconnectAll()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
