/**
 * Fan-out for Office job progress pointers.
 *
 * Migration 738's triggers publish `office_job_events` on every insert into
 * `office_generation_events` and every status/stage/error change on
 * `office_generation_jobs`, from any writer on any instance. This module
 * registers that channel on the process's shared LISTEN connection
 * (`../db/notify-listener.ts`, no new connection) and fans each pointer out to
 * the per-job streams open on this instance. Payloads are ids only; a stream
 * re-reads the job and its events through the access projection.
 *
 * It also forwards a coalesced `office` workspace primitive to this instance's
 * local workspace-stream subscribers, so the Office home list stale-marks
 * instead of waiting for renewal. Every instance receives the NOTIFY itself,
 * so the forward dispatches locally and never re-notifies.
 *
 * Single-process mode (embedded PGLite does not propagate NOTIFY): the store
 * and the transactional writers call `dispatchOfficeJobLocal` after their
 * write, which is a no-op elsewhere.
 *
 * Spec: docs/architecture/features/office.md -> "Live job progress".
 * [COMP:api/office-job-stream]
 */
import { registerNotifyChannel, startNotifyListener, unregisterNotifyChannel } from '../db/notify-listener.js'
import { dispatchBrainChangeLocal } from '../brain-stream/sse-fanout.js'

export const OFFICE_JOB_CHANNEL = 'office_job_events'

export type OfficeJobPointer = { jobId: string; workspaceId?: string; seq?: number | null }
type Listener = (pointer: OfficeJobPointer) => void

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Leading-edge window for the workspace `office` primitive. */
const SPINE_COALESCE_MS = 1_000

const listeners = new Map<string, Set<Listener>>()
const spineSentAt = new Map<string, number>()
let started = false

function singleProcess(): boolean {
  return process.env.USEBRIAN_SINGLE_PROCESS === '1'
}

/** Parse a NOTIFY payload into a pointer; anything else is dropped. */
export function parseOfficeJobPointer(payload: string): OfficeJobPointer | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>
    if (typeof value.jobId !== 'string' || !UUID_RE.test(value.jobId)) return null
    const workspaceId = typeof value.workspaceId === 'string' && UUID_RE.test(value.workspaceId) ? value.workspaceId : undefined
    const seq = typeof value.seq === 'number' && Number.isInteger(value.seq) ? value.seq : null
    return { jobId: value.jobId, workspaceId, seq }
  } catch {
    return null
  }
}

function dispatch(pointer: OfficeJobPointer, now = Date.now()): void {
  for (const listener of listeners.get(pointer.jobId) ?? []) {
    try {
      listener(pointer)
    } catch (error) {
      console.warn('[office-job-bus] listener threw:', error)
    }
  }
  if (!pointer.workspaceId) return
  const last = spineSentAt.get(pointer.workspaceId) ?? 0
  if (now - last < SPINE_COALESCE_MS) return
  spineSentAt.set(pointer.workspaceId, now)
  dispatchBrainChangeLocal({ workspaceId: pointer.workspaceId, primitive: 'office', rowId: pointer.jobId, action: 'update' })
}

function handleNotification(payload: string): void {
  const pointer = parseOfficeJobPointer(payload)
  if (pointer) dispatch(pointer)
}

/** Register the channel on the shared LISTEN connection. Idempotent; called at boot and on first subscribe. */
export function startOfficeJobEventBus(): void {
  if (started) return
  started = true
  if (singleProcess()) return
  registerNotifyChannel(OFFICE_JOB_CHANNEL, handleNotification)
  startNotifyListener()
}

export function subscribeOfficeJob(jobId: string, listener: Listener): () => void {
  let set = listeners.get(jobId)
  if (!set) listeners.set(jobId, set = new Set())
  set.add(listener)
  startOfficeJobEventBus()
  return () => {
    set!.delete(listener)
    if (!set!.size) listeners.delete(jobId)
  }
}

/** Single-process stand-in for the trigger NOTIFY; a no-op where LISTEN works. */
export function dispatchOfficeJobLocal(pointer: OfficeJobPointer): void {
  if (singleProcess()) dispatch(pointer)
}

/** Test teardown. */
export async function _resetOfficeJobEventBus(): Promise<void> {
  listeners.clear()
  spineSentAt.clear()
  if (started && !singleProcess()) await unregisterNotifyChannel(OFFICE_JOB_CHANNEL)
  started = false
}
