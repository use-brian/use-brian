/**
 * Real-time session-event bus — in-process + cross-instance pub/sub over a
 * session's turn lifecycle. Generic session infra: the doc-comment
 * live-reconnect feature (`doc_thread` turns, `GET /api/sessions/:id/stream`)
 * subscribes to it, and the feed-distribution draft feature rides the same
 * events. Event shapes live in `session-event-port.ts`.
 *
 * Wires three jobs into one module:
 *
 *   1. **Cross-instance fan-out.** A dedicated `pg.Client` (outside the
 *      pool) holds `LISTEN session_event` for the lifetime of the
 *      Cloud Run instance. Whenever a route emits an event for a session,
 *      every instance with a subscriber for that sessionId receives the
 *      NOTIFY and pushes the SSE frame.
 *
 *   2. **Local in-process fan-out.** The producer instance does not wait
 *      for the NOTIFY round-trip — `emit()` dispatches to local
 *      subscribers immediately and then fires the NOTIFY for remote
 *      instances. This keeps perceived latency low for the common case
 *      where producer + watcher land on the same instance.
 *
 *   3. **Presence.** Subscribers are tracked per (sessionId, userId)
 *      with `lastSeen` and `isTyping` flags. NOTIFY is only emitted on
 *      state transitions (a user's local presence count flips 0→1 or
 *      1→0, or `isTyping` changes). A 10s sweep timer detects unclean
 *      disconnects (lastSeen > 30s old) and synthesises a leave.
 *
 * NOTIFY payloads cap at ~8KB; large payloads are sent as thin pointers
 * (`{event, sessionId, sequenceNum}`) and the receiving instance fetches
 * via `getSessionMessages` before fanning out.
 *
 * See docs/architecture/features/doc-comments.md → "Live turn reconnect".
 */

import pg from 'pg'
import { getPool, query } from './db/client.js'
import { getSessionMessages } from './db/sessions.js'
// The event TYPES live in the port (so route builders can reference them as an
// injected dependency). Re-exported below for consumers that import them here.
import type { SessionEvent, ViewerPresence } from './session-event-port.js'

const CHANNEL = 'session_event'

/**
 * Single-process mode (the OSS local boot — one api process on embedded
 * PGLite). The bus is already local-first: `emit`/`emitPresence` call
 * `dispatchToLocal` BEFORE the cross-instance NOTIFY, so a lone process needs
 * neither the dedicated `LISTEN` connection nor the `pg_notify` round-trips —
 * both would only hold/contend the single PGLite connection for fan-out that
 * has no second instance to reach. The launcher sets SIDANCLAW_SINGLE_PROCESS=1.
 * See docs/plans/oss-local-brain-wedge.md §12.4/§12.7.
 */
const SINGLE_PROCESS = process.env.SIDANCLAW_SINGLE_PROCESS === '1'

/** Soft cap on NOTIFY payload size in bytes — Postgres hard limit is 8000. */
const NOTIFY_PAYLOAD_BUDGET = 6_500

/** Stale presence threshold; sweep emits leave when `lastSeen` exceeds this. */
const PRESENCE_STALE_MS = 30_000

/** Sweep interval. */
const SWEEP_INTERVAL_MS = 10_000

// SessionEvent + ViewerPresence are defined in the OPEN port (./session-event-port);
// re-exported here so existing importers keep working unchanged.
export type { SessionEvent, ViewerPresence } from './session-event-port.js'

type Subscriber = {
  sessionId: string
  userId: string
  name: string | null
  cb: (event: SessionEvent) => void
}

type PresenceEntry = {
  name: string | null
  lastSeen: number  // epoch ms
  isTyping: boolean
  /** count of local Subscriber rows for this user (multi-tab dedupe). */
  connections: number
}

let listenerClient: pg.Client | null = null
let listenerStatus: 'idle' | 'connecting' | 'listening' | 'reconnecting' = 'idle'
let reconnectTimer: NodeJS.Timeout | null = null
let sweepTimer: NodeJS.Timeout | null = null
let backoffMs = 1_000

const subscribers = new Set<Subscriber>()
/** Per-session presence: sessionId → userId → entry. */
const presence = new Map<string, Map<string, PresenceEntry>>()

function buildClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.DATABASE_URL })
}

async function startListener(): Promise<void> {
  if (listenerStatus === 'connecting' || listenerStatus === 'listening') return
  listenerStatus = 'connecting'

  const client = buildClient()
  listenerClient = client

  client.on('notification', (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return
    let parsed: { kind: SessionEvent['kind']; sessionId: string; payload?: unknown; pointer?: { sequenceNum: number } }
    try {
      parsed = JSON.parse(msg.payload)
    } catch {
      return
    }
    if (!parsed.sessionId || !parsed.kind) return

    if (parsed.pointer) {
      // Large payload — fetch before fanout.
      void hydrateAndDispatch(parsed.sessionId, parsed.kind, parsed.pointer.sequenceNum)
      return
    }

    dispatchToLocal({ kind: parsed.kind, sessionId: parsed.sessionId, payload: parsed.payload } as SessionEvent)
  })

  client.on('error', (err) => {
    console.warn('[session-event-bus] listener error, will reconnect:', err.message)
    scheduleReconnect()
  })
  client.on('end', () => {
    if (listenerStatus !== 'reconnecting') {
      console.warn('[session-event-bus] listener ended unexpectedly')
      scheduleReconnect()
    }
  })

  try {
    await client.connect()
    await client.query(`LISTEN ${CHANNEL}`)
    listenerStatus = 'listening'
    backoffMs = 1_000
    console.log(`[session-event-bus] LISTEN ${CHANNEL} active`)
  } catch (err) {
    console.warn('[session-event-bus] failed to start listener:', err)
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (listenerStatus === 'reconnecting') return
  listenerStatus = 'reconnecting'

  if (listenerClient) {
    listenerClient.removeAllListeners()
    listenerClient.end().catch(() => {})
    listenerClient = null
  }

  const delay = backoffMs
  backoffMs = Math.min(backoffMs * 2, 30_000)

  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    listenerStatus = 'idle'
    void startListener()
  }, delay)
}

function dispatchToLocal(event: SessionEvent): void {
  for (const sub of subscribers) {
    if (sub.sessionId !== event.sessionId) continue
    try {
      sub.cb(event)
    } catch (err) {
      console.warn('[session-event-bus] subscriber callback threw:', err)
    }
  }
}

/**
 * Hydrate a NOTIFY pointer (sessionId + sequenceNum) into a full
 * `assistant_message_saved` / `user_message_saved` event by fetching the
 * row from the DB. Used when the original payload exceeded the NOTIFY
 * payload budget.
 */
async function hydrateAndDispatch(
  sessionId: string,
  kind: SessionEvent['kind'],
  sequenceNum: number,
): Promise<void> {
  if (kind !== 'user_message_saved' && kind !== 'assistant_message_saved') return
  try {
    const rows = await getSessionMessages(sessionId, { fromSequence: sequenceNum, limit: 1 })
    const row = rows.find((r) => r.sequenceNum === sequenceNum)
    if (!row) return
    if (kind === 'user_message_saved') {
      dispatchToLocal({
        kind,
        sessionId,
        payload: {
          id: row.id,
          sequenceNum: row.sequenceNum,
          senderUserId: row.senderUserId,
          content: row.content,
        },
      })
    } else {
      dispatchToLocal({
        kind,
        sessionId,
        payload: {
          id: row.id,
          sequenceNum: row.sequenceNum,
          content: row.content,
        },
      })
    }
  } catch (err) {
    console.warn('[session-event-bus] hydrate failed:', err)
  }
}

function presenceSnapshot(sessionId: string): ViewerPresence[] {
  const map = presence.get(sessionId)
  if (!map) return []
  const out: ViewerPresence[] = []
  for (const [userId, entry] of map) {
    out.push({
      userId,
      name: entry.name,
      isTyping: entry.isTyping,
      lastSeen: new Date(entry.lastSeen).toISOString(),
    })
  }
  return out
}

function emitPresence(sessionId: string): void {
  const event: SessionEvent = {
    kind: 'presence',
    sessionId,
    payload: { viewers: presenceSnapshot(sessionId) },
  }
  // Local-first; cross-instance via NOTIFY.
  dispatchToLocal(event)
  void publishNotify(event)
}

async function publishNotify(event: SessionEvent): Promise<void> {
  // Single-process: local subscribers already saw the event via dispatchToLocal;
  // there is no second instance to NOTIFY, so skip the pg_notify round-trip.
  if (SINGLE_PROCESS) return
  try {
    const fullPayload = { kind: event.kind, sessionId: event.sessionId, payload: event.payload }
    const json = JSON.stringify(fullPayload)
    if (json.length <= NOTIFY_PAYLOAD_BUDGET) {
      await query('SELECT pg_notify($1, $2)', [CHANNEL, json])
      return
    }
    // Oversized — send a pointer instead. Only message-saved events have a
    // sequenceNum we can hydrate from; everything else gets dropped here.
    if (event.kind === 'user_message_saved' || event.kind === 'assistant_message_saved') {
      const pointerJson = JSON.stringify({
        kind: event.kind,
        sessionId: event.sessionId,
        pointer: { sequenceNum: event.payload.sequenceNum },
      })
      await query('SELECT pg_notify($1, $2)', [CHANNEL, pointerJson])
      return
    }
    console.warn(
      '[session-event-bus] event too large to NOTIFY and not hydratable; dropping cross-instance fan-out',
      event.kind,
    )
  } catch (err) {
    // NOTIFY failures are non-fatal — local subscribers already saw the event.
    console.warn('[session-event-bus] notify failed (non-fatal):', err)
  }
}

function startSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [sessionId, viewers] of presence) {
      let changed = false
      for (const [userId, entry] of viewers) {
        // Skip entries with active local connections — those are kept fresh
        // by `subscribe`'s touch-on-event path. The sweep is just for
        // unclean disconnects where the connection map is already cleared.
        if (entry.connections > 0) continue
        if (now - entry.lastSeen > PRESENCE_STALE_MS) {
          viewers.delete(userId)
          changed = true
        }
      }
      if (changed) {
        if (viewers.size === 0) presence.delete(sessionId)
        emitPresence(sessionId)
      }
    }
  }, SWEEP_INTERVAL_MS)
  // Don't keep the event loop alive just for the sweep timer in tests/scripts.
  sweepTimer.unref?.()
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Boot-time entry point. Idempotent — safe to call multiple times.
 * Wired in `apps/api/src/index.ts` so the LISTEN connection is up
 * before the first SSE subscriber connects.
 */
export function startSessionEventBus(): void {
  // Single-process boot skips the dedicated LISTEN connection entirely (no
  // cross-instance fan-out to receive). The local-dispatch + presence sweep
  // below is the whole bus in that mode.
  if (!SINGLE_PROCESS && listenerStatus === 'idle') {
    void startListener()
  }
  startSweep()
}

/**
 * Subscribe an SSE client to a session. The callback fires for
 * every event for that session, including events produced on a
 * different Cloud Run instance. Returns an unsubscribe function the
 * caller should invoke on disconnect.
 *
 * Subscribing a new (sessionId, userId) pair joins the presence set
 * for the session and emits a `presence` event to other watchers; the
 * last connection for a user leaving emits the corresponding leave.
 */
export function subscribeSessionEvents(params: {
  sessionId: string
  userId: string
  name: string | null
  cb: (event: SessionEvent) => void
}): () => void {
  const sub: Subscriber = {
    sessionId: params.sessionId,
    userId: params.userId,
    name: params.name,
    cb: params.cb,
  }
  subscribers.add(sub)
  startSessionEventBus()

  let perSession = presence.get(params.sessionId)
  if (!perSession) {
    perSession = new Map()
    presence.set(params.sessionId, perSession)
  }
  const existing = perSession.get(params.userId)
  if (existing) {
    existing.connections += 1
    existing.lastSeen = Date.now()
  } else {
    perSession.set(params.userId, {
      name: params.name,
      lastSeen: Date.now(),
      isTyping: false,
      connections: 1,
    })
    emitPresence(params.sessionId)
  }

  return () => {
    subscribers.delete(sub)
    const map = presence.get(params.sessionId)
    if (!map) return
    const entry = map.get(params.userId)
    if (!entry) return
    entry.connections -= 1
    if (entry.connections <= 0) {
      map.delete(params.userId)
      if (map.size === 0) presence.delete(params.sessionId)
      emitPresence(params.sessionId)
    }
  }
}

/**
 * Update a viewer's typing state. NOTIFY only fires on transitions.
 * No-op when the user has no active connection for the session — a
 * typing beacon from a viewer who hasn't subscribed is meaningless.
 */
export function setSessionTyping(params: {
  sessionId: string
  userId: string
  isTyping: boolean
}): void {
  const map = presence.get(params.sessionId)
  if (!map) return
  const entry = map.get(params.userId)
  if (!entry) return
  entry.lastSeen = Date.now()
  if (entry.isTyping === params.isTyping) return
  entry.isTyping = params.isTyping
  emitPresence(params.sessionId)
}

/**
 * Publish an event from a route. Local subscribers see it immediately;
 * remote instances receive it via NOTIFY. Called only for sessions that
 * have live watchers (doc-comment threads, feed drafts) so plain chat
 * traffic doesn't pay the cost of this bus.
 */
export function publishSessionEvent(event: SessionEvent): void {
  // Refresh lastSeen for the producing user too — they're clearly present.
  if (
    event.kind === 'user_message_saved' &&
    event.payload.senderUserId
  ) {
    const map = presence.get(event.sessionId)
    const entry = map?.get(event.payload.senderUserId)
    if (entry) entry.lastSeen = Date.now()
  }
  if (event.kind === 'turn_started' || event.kind === 'turn_completed') {
    const map = presence.get(event.sessionId)
    const entry = map?.get(event.payload.senderUserId)
    if (entry) entry.lastSeen = Date.now()
  }
  dispatchToLocal(event)
  void publishNotify(event)
}

/** Snapshot of viewer presence for a session — used by SSE on initial connect. */
export function getSessionPresence(sessionId: string): ViewerPresence[] {
  return presenceSnapshot(sessionId)
}

// ── Test helpers ──────────────────────────────────────────────────

/** Test helper — number of currently-attached subscribers. */
export function _getSessionSubscriberCount(): number {
  return subscribers.size
}

/** Test helper — graceful shutdown for vitest cleanup. */
export async function _shutdownSessionEventBus(): Promise<void> {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  if (listenerClient) {
    listenerClient.removeAllListeners()
    await listenerClient.end().catch(() => {})
    listenerClient = null
  }
  listenerStatus = 'idle'
  subscribers.clear()
  presence.clear()
  void getPool
}
