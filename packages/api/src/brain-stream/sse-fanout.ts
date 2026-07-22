/**
 * Postgres LISTEN/NOTIFY fan-out for the brain realtime stream.
 *
 * Mirrors the feed inbox SSE pattern (`../feed/sse-fanout.ts`). One dedicated
 * `pg.Client` per process holds the LISTEN connection (LISTEN binds to a
 * single connection — pool checkouts can't carry it). Subscribers register a
 * callback against a `workspaceId`; whenever a writer calls
 * `notifyBrainChange({ workspaceId, primitive, rowId?, action })`, the
 * Postgres NOTIFY fans out to every interested subscriber across this
 * process — and across every other Cloud Run instance.
 *
 * Reconnect is exponential-backoff (1s → 30s cap). On reconnect we re-issue
 * LISTEN so we resume receiving events.
 *
 * Spec: docs/architecture/platform/realtime-sync.md.
 *
 * [COMP:api/brain-stream-fanout]
 */
import pg from 'pg'

export const BRAIN_CHANNEL = 'brain_events'

/**
 * Single-process mode (OSS local boot — one api process on embedded PGLite).
 * Unlike the session-event bus, the brain stream is NOT local-first: writes
 * emit only `pg_notify` and subscribers receive only via the LISTEN connection.
 * The PGLite socket server does not propagate LISTEN/NOTIFY, so in single-
 * process mode the writer dispatches straight into local subscribers (same
 * process) via `dispatchBrainChangeLocal`, and the LISTEN connection is skipped.
 * The launcher sets USEBRIAN_SINGLE_PROCESS=1. See oss-local-brain-wedge §12.4/§12.7.
 */
const SINGLE_PROCESS = process.env.USEBRIAN_SINGLE_PROCESS === '1'

export function isSingleProcessBrainStream(): boolean {
  return SINGLE_PROCESS
}

/** Dispatch a brain-change payload into the local in-process subscribers. */
export function dispatchBrainChangeLocal(payload: BrainChangePayload): void {
  if (!payload.workspaceId) return
  for (const sub of subscribers) {
    if (sub.workspaceId === payload.workspaceId) {
      try {
        sub.cb(payload)
      } catch (err) {
        console.warn('[brain-stream] subscriber callback threw:', err)
      }
    }
  }
}

/**
 * The workspace-change vocabulary. Brain rows were the original scope; the
 * 2026-07 realtime-sync generalization (docs/plans/realtime-sync-audit.md)
 * added the orchestration/governance primitives — workflow, workflow_run,
 * approval, skill, scheduled_job — which emit from their db stores (bounded
 * write rates), unlike brain primitives which emit at user-facing write
 * surfaces only (hot ingest loops share their stores). Unknown primitives
 * must be ignored by clients, so widening here is additive.
 */
export type BrainPrimitive =
  | 'memory'
  | 'task'
  | 'contact'
  | 'company'
  | 'deal'
  | 'file'
  | 'entity'
  | 'edge'
  | 'kb_chunk'
  | 'workflow'
  | 'workflow_run'
  | 'approval'
  | 'skill'
  | 'scheduled_job'
  | 'deck'
  | 'assistant'

/** Alias reflecting the widened, workspace-wide scope. */
export type WorkspacePrimitive = BrainPrimitive

export type BrainChangeAction = 'create' | 'update' | 'delete'

export type BrainChangePayload = {
  workspaceId: string
  primitive: BrainPrimitive
  rowId?: string
  action: BrainChangeAction
}

export type BrainSubscriber = (payload: BrainChangePayload) => void

type Subscriber = {
  workspaceId: string
  cb: BrainSubscriber
}

let listenerClient: pg.Client | null = null
let listenerStatus: 'idle' | 'connecting' | 'listening' | 'reconnecting' = 'idle'
let reconnectTimer: NodeJS.Timeout | null = null
let backoffMs = 1_000
const subscribers = new Set<Subscriber>()

function buildClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.DATABASE_URL })
}

async function startListener(): Promise<void> {
  if (listenerStatus === 'connecting' || listenerStatus === 'listening') return
  listenerStatus = 'connecting'

  const client = buildClient()
  listenerClient = client

  client.on('notification', (msg) => {
    if (msg.channel !== BRAIN_CHANNEL || !msg.payload) return
    let parsed: BrainChangePayload
    try {
      parsed = JSON.parse(msg.payload) as BrainChangePayload
    } catch {
      return
    }
    if (!parsed.workspaceId) return
    dispatchBrainChangeLocal(parsed)
  })

  client.on('error', (err) => {
    console.warn('[brain-stream] listener error, will reconnect:', err.message)
    scheduleReconnect()
  })
  client.on('end', () => {
    if (listenerStatus !== 'reconnecting') {
      console.warn('[brain-stream] listener ended unexpectedly')
      scheduleReconnect()
    }
  })

  try {
    await client.connect()
    await client.query(`LISTEN ${BRAIN_CHANNEL}`)
    listenerStatus = 'listening'
    backoffMs = 1_000
    console.log(`[brain-stream] LISTEN ${BRAIN_CHANNEL} active`)
  } catch (err) {
    console.warn('[brain-stream] failed to start listener:', err)
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

/**
 * Boot-time entry point. Idempotent — safe to call multiple times. Wired in
 * `apps/api/src/index.ts` before the server starts accepting traffic so the
 * brain stream has a live LISTEN by the time the first client connects.
 */
export function startBrainStreamFanout(): void {
  // Single-process boot skips the LISTEN connection entirely — writes reach
  // local subscribers directly via dispatchBrainChangeLocal (see notify.ts).
  if (!SINGLE_PROCESS && listenerStatus === 'idle') {
    void startListener()
  }
}

/**
 * Subscribe to brain change events for a workspace. Returns the
 * unsubscribe function — call it on SSE-client disconnect to free the
 * slot.
 */
export function subscribeToBrainChanges(
  workspaceId: string,
  cb: BrainSubscriber,
): () => void {
  const sub: Subscriber = { workspaceId, cb }
  subscribers.add(sub)
  // Lazy-start the listener so tests / scripts that don't open SSE don't pay
  // the cost. First subscriber wins; later subscribers are no-ops.
  startBrainStreamFanout()
  return () => {
    subscribers.delete(sub)
  }
}

/** Test helper — number of currently-attached subscribers. */
export function _getBrainSubscriberCount(): number {
  return subscribers.size
}

/** Test helper — dispatch a payload directly into local subscribers without going through Postgres. */
export function _dispatchLocalForTests(payload: BrainChangePayload): void {
  dispatchBrainChangeLocal(payload)
}

/** Test helper — graceful shutdown for vitest cleanup. */
export async function _shutdownBrainStreamFanout(): Promise<void> {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (listenerClient) {
    listenerClient.removeAllListeners()
    await listenerClient.end().catch(() => {})
    listenerClient = null
  }
  listenerStatus = 'idle'
  subscribers.clear()
}
