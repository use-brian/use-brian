/**
 * Postgres LISTEN/NOTIFY fan-out for the brain realtime stream.
 *
 * Mirrors the feed inbox SSE pattern (`../feed/sse-fanout.ts`). Subscribers
 * register a callback against a `workspaceId`; whenever a writer calls
 * `notifyBrainChange({ workspaceId, primitive, rowId?, action })`, the
 * Postgres NOTIFY fans out to every interested subscriber across this
 * process — and across every other Cloud Run instance.
 *
 * The LISTEN side rides the process-wide shared connection
 * (`../db/notify-listener.ts`), which owns connect, reconnect-with-backoff, and
 * re-subscribe. This module used to hold its own `pg.Client`; three fan-out
 * modules each doing that put six dedicated connections against a 22-slot
 * fleet budget. See that module's header for the incident.
 *
 * Spec: docs/architecture/platform/realtime-sync.md.
 *
 * [COMP:api/brain-stream-fanout]
 */
import { registerNotifyChannel, startNotifyListener, unregisterNotifyChannel } from '../db/notify-listener.js'

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

const subscribers = new Set<Subscriber>()

/** Shared-connection handler for `brain_events`. Parses, then dispatches locally. */
function handleBrainNotification(payload: string): void {
  let parsed: BrainChangePayload
  try {
    parsed = JSON.parse(payload) as BrainChangePayload
  } catch {
    return
  }
  if (!parsed.workspaceId) return
  dispatchBrainChangeLocal(parsed)
}

/**
 * Boot-time entry point. Idempotent — safe to call multiple times. Wired in
 * `apps/api/src/index.ts` before the server starts accepting traffic so the
 * brain stream has a live LISTEN by the time the first client connects.
 */
export function startBrainStreamFanout(): void {
  // Single-process boot skips the LISTEN connection entirely — writes reach
  // local subscribers directly via dispatchBrainChangeLocal (see notify.ts).
  if (SINGLE_PROCESS) return
  registerNotifyChannel(BRAIN_CHANNEL, handleBrainNotification)
  startNotifyListener()
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

/**
 * Test helper — graceful shutdown for vitest cleanup. Deregisters only THIS
 * module's channel; the shared connection closes itself once the last channel
 * goes, so tearing this fan-out down never silences the others.
 */
export async function _shutdownBrainStreamFanout(): Promise<void> {
  await unregisterNotifyChannel(BRAIN_CHANNEL)
  subscribers.clear()
}
