/**
 * apps/doc-sync — the doc realtime-collaboration sync service.
 *
 * A dedicated, single-instance (Cloud Run min=max=1) Hocuspocus Yjs
 * WebSocket server. It is the one authoritative in-memory holder per live
 * page document: it authenticates + clearance-gates each connection, lazily
 * loads a doc from Postgres on first activation, broadcasts CRDT updates to
 * all peers (human tabs + the server-side AI client), and persists a debounced
 * snapshot. See docs/architecture/features/doc.md → "Real-time collaboration".
 *
 * Reuses `@sidanclaw/api` (auth + DB pool) and `@sidanclaw/doc-model` (the
 * shared schema + encode). The testable logic lives in `auth-hook.ts`,
 * `clearance-gate.ts`, `persistence.ts`; this file is the wiring.
 */

import dotenv from 'dotenv'
import { resolve } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import { Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import { getPool, query, queryWithRLS } from '@sidanclaw/api/db/client.js'
import {
  applyOpsToYDoc,
  FRAGMENT_FIELD,
  healBlockIds,
  yDocToSnapshot,
  deriveRunStep,
  deriveRunBlockId,
  type DocOp,
  type AssistantRunChannel,
} from '@sidanclaw/doc-model'
import { resolveAuth } from './auth-hook.js'
import { assertPageAccess, type RlsQuery } from './clearance-gate.js'
import {
  loadPageUpdate,
  maybeEnqueueBrainIngest,
  storePageSnapshot,
  type SysQuery,
} from './persistence.js'
import { bridgeConnection } from './ws-bridge.js'
import { createRunRegistry, type RunRegistry } from './run-registry.js'

// Local dev: load the monorepo-root .env (the service runs from
// apps/doc-sync, so the default cwd .env isn't where the shared
// JWT_SECRET / DATABASE_URL live). In prod, env comes from the platform and
// this is a no-op. Mirrors packages/api/scripts/migrate.ts.
dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '.env') })

const PORT = parseInt(process.env.PORT || '8080', 10)
const JWT_SECRET = process.env.JWT_SECRET
const DOC_SYNC_SECRET = process.env.DOC_SYNC_SECRET
// API base for the reverse-direction auto-on-save brain-ingest enqueue
// (doc-sync → API `/internal/ingest-page`). Authed with the SAME DOC_SYNC_SECRET
// the API→doc-sync `/internal/apply` direction uses (see persistence.ts +
// packages/api/src/doc/internal-ingest-route.ts). Unset → the auto-ingest path
// is simply off (manual ingest still works through the API directly).
const API_INTERNAL_URL = process.env.API_INTERNAL_URL
// Cooldown between auto-enqueues of one page. Mirrors INGEST_COOLDOWN_MS in
// packages/api/src/doc/internal-ingest-route.ts (the API re-gates, but a local
// gate avoids a POST on every 2s debounce).
const BRAIN_INGEST_COOLDOWN_MS = 5 * 60 * 1000

if (!JWT_SECRET) {
  console.error('[doc-sync] JWT_SECRET is required. Refusing to start.')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('[doc-sync] DATABASE_URL is required. Refusing to start.')
  process.exit(1)
}

// Adapters from the pure helpers' injected-query shape to the real pool.
const rlsQuery: RlsQuery = (userId, sql, params) =>
  queryWithRLS(userId, sql, params as unknown[]).then((r) => r.rows as never[])
const sysQuery: SysQuery = (sql, params) =>
  query(sql, params as unknown[]).then((r) => r.rows as never[])

// Forward declaration so the `connected` hook (defined inside the Hocuspocus
// config) can reach the run registry, which is created *after* the instance
// because its publisher needs `hocuspocus`. No connection can fire before the
// server starts listening at the bottom of this file, so it's always assigned.
let runRegistry: RunRegistry

const hocuspocus = new Hocuspocus({
  name: 'doc-sync',
  quiet: true,
  // Persist ~2s after the last edit, but at least every 10s under sustained
  // typing, so an ungraceful crash loses at most the debounce window.
  debounce: 2000,
  maxDebounce: 10000,
  unloadImmediately: false,

  // Late-joiner seeding for assistant-run presence: when a tab connects, re-assert
  // any active run for its page into the document's awareness so the newcomer sees
  // "working" immediately (covers a run triggered from Telegram/Slack while no
  // browser was open). Idempotent — republish on an idle page broadcasts nothing.
  async connected(data) {
    runRegistry.republish(data.documentName)
  },

  async onAuthenticate(data) {
    const auth = resolveAuth({
      token: data.token,
      jwtSecret: JWT_SECRET,
      syncSecret: DOC_SYNC_SECRET,
    })
    if (auth.kind === 'reject') throw new Error(`unauthorized: ${auth.reason}`)
    if (auth.kind === 'service') return { service: true as const }
    // End-user: enforce the page clearance gate + resolve the member's role
    // before joining the doc.
    const access = await assertPageAccess({
      userId: auth.userId,
      pageId: data.documentName,
      query: rlsQuery,
    })
    // Phase 3 write-filter (§13 D2): view/comment members join the live doc
    // READ-ONLY — Hocuspocus's MessageReceiver drops their doc-mutating updates
    // server-side (awareness/presence still flow; comments go via REST, not
    // Yjs). edit/full stay read-write; the service connection (returned above)
    // is never gated.
    data.connectionConfig.readOnly = access.role === 'view' || access.role === 'comment'
    return {
      userId: auth.userId,
      workspaceId: access.workspaceId,
      clearance: access.clearance,
      role: access.role,
    }
  },

  async onLoadDocument(data) {
    const update = await loadPageUpdate({ pageId: data.documentName, query: sysQuery })
    if (update) Y.applyUpdate(data.document, update)
    // Stamp missing blockIds (and heal forks) the moment the doc becomes
    // live, before any client or AI read derives ids from it — editor-created
    // nodes carry `blockId: null` and would otherwise get a different
    // fabricated id on every conversion. See healBlockIds + the same call in
    // storePageSnapshot.
    const ydoc = data.document as unknown as Y.Doc
    ydoc.transact(() => healBlockIds(ydoc.getXmlFragment(FRAGMENT_FIELD)))
    return data.document
  },

  async onStoreDocument(data) {
    const { page } = await storePageSnapshot({
      pageId: data.documentName,
      ydoc: data.document as unknown as Y.Doc,
      query: sysQuery,
    })
    // Auto-on-save brain-ingest enqueue (canvas-brain-distillation.md
    // deviation). Best-effort, fire-and-forget, gated by the per-page toggle +
    // dedup + cooldown inside the helper — never blocks / breaks this store.
    // Off unless BOTH the API URL and the shared secret are configured.
    if (API_INTERNAL_URL && DOC_SYNC_SECRET) {
      void maybeEnqueueBrainIngest({
        pageId: data.documentName,
        page,
        query: sysQuery,
        config: {
          apiBaseUrl: API_INTERNAL_URL,
          syncSecret: DOC_SYNC_SECRET,
          cooldownMs: BRAIN_INGEST_COOLDOWN_MS,
        },
      })
    }
  },
})

/**
 * Assistant-run presence registry — the authoritative per-page record of "an
 * assistant is working here". `apps/api`'s chat route opens/heartbeats/closes a
 * run via the `/internal/run/*` endpoints below; the publisher writes the state
 * into the live document's Yjs awareness (`setLocalStateField('assistantRun',
 * …)`) so every connected tab — and, via the `connected` hook above,
 * late-joiners — sees it. `null` clears the field → the client reads idle. A
 * page with no loaded document has no tabs to notify, so the publisher no-ops
 * there; the `connected` hook re-asserts the state when a tab eventually opens.
 */
runRegistry = createRunRegistry({
  publish(pageId, state) {
    const doc = hocuspocus.documents.get(pageId)
    if (!doc) return
    doc.awareness.setLocalStateField('assistantRun', state)
  },
})

// TTL safety-net: drop any run whose heartbeat lapsed (a turn that crashed
// without sending `end`) so a page never shows "working" forever.
const runSweepTimer = setInterval(() => {
  try {
    runRegistry.sweep()
  } catch (err) {
    console.error('[doc-sync] run sweep error', err)
  }
}, 30_000)
runSweepTimer.unref()

/**
 * Internal apply endpoint — the server-side AI write path. The chat route's
 * `DocGateway` POSTs `{ pageId, ops }` here (gated by the shared
 * `DOC_SYNC_SECRET`). We open a direct connection to the authoritative
 * in-memory doc (loading it if no human is connected), apply the ops via the
 * shared `applyOpsToYDoc`, then Hocuspocus broadcasts the update to every
 * connected human tab and persists the debounced snapshot. This keeps the AI
 * and humans on ONE document — no `saved_views.page` divergence.
 *
 * NOTE (web-QA): the live broadcast + persistence of an AI apply needs a
 * running service + a connected browser to verify end-to-end; the op→doc
 * transform itself is unit-tested in `@sidanclaw/doc-model` (`apply-ops`).
 */
async function handleInternalApply(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!DOC_SYNC_SECRET || req.headers['x-doc-sync-secret'] !== DOC_SYNC_SECRET) {
    res.writeHead(401)
    res.end()
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk
  let payload: { pageId?: string; ops?: DocOp[] }
  try {
    payload = JSON.parse(body || '{}')
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid json' }))
    return
  }
  const { pageId, ops } = payload
  if (!pageId || !Array.isArray(ops)) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'pageId and ops[] required' }))
    return
  }

  // openDirectConnection bypasses onAuthenticate (this is a trusted service
  // call already gated by the secret) but still runs onLoadDocument, so an
  // unopened page is loaded (or encoded from legacy) before we mutate it.
  const connection = await hocuspocus.openDirectConnection(pageId, { service: true })
  try {
    let result: { idMap: Record<string, string>; skipped: { opIndex: number; reason: string }[] } = {
      idMap: {},
      skipped: [],
    }
    // Authoritative post-apply page, derived from the live in-memory doc this
    // service just mutated. Returned alongside idMap/skipped so `patchPage`
    // builds its delta + outline (and re-anchor signal) from the TRUE live state
    // instead of re-reading the debounced `documents.snapshot_json` — that
    // snapshot lags this service's ~2s persistence debounce, so mid-loop reads
    // showed the model a stale page and it re-targeted already-deleted blocks
    // until it gave up with a confabulated reply (prod incident 2026-06-11,
    // session d98e2acd). Captured inside the SAME transaction as the apply so a
    // concurrent human edit can't slip between mutate and read.
    let snapshot: { page: unknown; title: string } = { page: { blocks: [] }, title: '' }
    await connection.transact((doc) => {
      const yDoc = doc as unknown as import('yjs').Doc
      result = applyOpsToYDoc(yDoc, ops)
      snapshot = yDocToSnapshot(yDoc)
    })
    // Heartbeat the page's assistant run with a coarse, client-localized step
    // derived from the ops that just landed — perfectly in sync with the blocks
    // appearing in the doc. No-ops if no run is open for this page (e.g. a
    // human-initiated apply outside a tracked turn).
    runRegistry.progress({
      pageId,
      step: deriveRunStep(ops),
      blockId: deriveRunBlockId(ops),
      toolName: 'patchPage',
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({ ...result, page: snapshot.page, title: snapshot.title }),
    )
  } finally {
    await connection.disconnect()
  }
}

/** Shared `DOC_SYNC_SECRET` gate for the internal (server-to-server) routes. */
function isInternalAuthorized(req: IncomingMessage): boolean {
  return (
    !!DOC_SYNC_SECRET && req.headers['x-doc-sync-secret'] === DOC_SYNC_SECRET
  )
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) body += chunk
  return JSON.parse(body || '{}')
}

/**
 * Internal assistant-run presence endpoint — twins of `/internal/apply`. The
 * chat route's `DocGateway` POSTs run lifecycle here (secret-gated):
 *   - `/internal/run/start`    { pageId, actor{id,name,color?}, channel? }
 *   - `/internal/run/progress` { pageId, step?, toolName?, blockId? }
 *   - `/internal/run/end`      { pageId }
 * Each mutates the in-memory registry, which publishes the state into the
 * page's Yjs awareness for all connected tabs.
 */
async function handleInternalRun(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isInternalAuthorized(req)) {
    res.writeHead(401)
    res.end()
    return
  }
  const action = (req.url ?? '').slice('/internal/run/'.length).split(/[?/]/)[0]
  let payload: {
    pageId?: string
    actor?: { id?: string; name?: string; color?: string }
    channel?: string
    step?: unknown
    toolName?: string
    blockId?: string
  }
  try {
    payload = (await readJsonBody(req)) as typeof payload
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid json' }))
    return
  }
  const { pageId } = payload
  if (!pageId || typeof pageId !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'pageId required' }))
    return
  }
  if (action === 'start') {
    const a = payload.actor
    if (!a || typeof a.id !== 'string' || typeof a.name !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'actor {id,name} required' }))
      return
    }
    runRegistry.start({
      pageId,
      actor: { id: a.id, name: a.name, color: a.color },
      channel: (payload.channel as AssistantRunChannel) ?? 'unknown',
    })
  } else if (action === 'progress') {
    runRegistry.progress({
      pageId,
      step: payload.step as never,
      toolName: payload.toolName,
      blockId: payload.blockId,
    })
  } else if (action === 'end') {
    runRegistry.end(pageId)
  } else {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

// Plain HTTP server for the Cloud Run health probe, the internal AI apply
// endpoint, and the WS upgrade to Hocuspocus.
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url && req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  if (req.method === 'POST' && req.url && req.url.startsWith('/internal/apply')) {
    handleInternalApply(req, res).catch((err) => {
      console.error('[doc-sync] /internal/apply error', err)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'apply failed' }))
    })
    return
  }
  if (req.method === 'POST' && req.url && req.url.startsWith('/internal/run/')) {
    handleInternalRun(req, res).catch((err) => {
      console.error('[doc-sync] /internal/run error', err)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'run failed' }))
    })
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ noServer: true })
httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    // `ws` WebSocket + node IncomingMessage satisfy Hocuspocus's structural
    // WebSocketLike/Request at runtime; the lib's nominal types differ.
    //
    // Hocuspocus v4's `handleConnection` RETURNS a ClientConnection and
    // attaches no socket listeners — we must forward message/close ourselves
    // or the socket stays open-but-unread and the client loops "Reconnecting…".
    // See `ws-bridge.ts` for the full rationale.
    const connection = hocuspocus.handleConnection(ws as never, request as never)
    bridgeConnection(connection as never, ws, (err) =>
      console.error('[doc-sync] ws connection error', err),
    )
  })
})

httpServer.listen(PORT, () => {
  console.log(`[doc-sync] listening on :${PORT}`)
  // One-time signal so a silent auto-ingest is diagnosable: env unset here means
  // the enqueue never fires (distinct from a per-page toggle being off).
  console.log(
    API_INTERNAL_URL && DOC_SYNC_SECRET
      ? `[doc-sync] auto brain-ingest ENABLED → ${API_INTERNAL_URL}/internal/ingest-page`
      : '[doc-sync] auto brain-ingest DISABLED (API_INTERNAL_URL / DOC_SYNC_SECRET unset)',
  )
})

// Graceful shutdown: flush pending debounced stores so a redeploy on the
// single instance loses nothing, then close.
let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(runSweepTimer)
  console.log(`[doc-sync] ${signal} — flushing pending document stores`)
  try {
    hocuspocus.flushPendingStores()
    // Give the flush a moment to complete its async writes, then drop peers.
    await new Promise((r) => setTimeout(r, 1500))
    hocuspocus.closeConnections()
  } catch (err) {
    console.error('[doc-sync] shutdown error', err)
  }
  await getPool().end().catch(() => {})
  httpServer.close(() => process.exit(0))
  // Hard exit if close hangs.
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
