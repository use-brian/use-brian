/**
 * Per-job Office progress stream: `GET /api/office/jobs/:jobId/stream`.
 *
 * Office job progress reaches the browser by push. On open the stream gates
 * through the same access projection as `GET /jobs/:jobId` (an ineligible
 * caller gets 404, no existence signal), sends one `job` frame plus every
 * persisted event after `Last-Event-ID` / `?afterSeq` (each `id: <seq>`), and
 * then follows the job-event bus. A bus pointer is never forwarded: the stream
 * re-reads the job and the events after its last sent seq through the
 * projection. A terminal status sends `done` and closes; the 25s heartbeat
 * re-runs the projection (and catches up a missed pointer), and a denial sends
 * `revoked` and closes. A non-terminal job whose lease lapsed is woken for its
 * initiator on open and on every heartbeat, so a stalled job resumes when
 * anyone looks at it. The lifetime is bounded by SSE_MAX_LIFETIME_MS +/-20%;
 * the client resumes losslessly from `Last-Event-ID`.
 *
 * Spec: docs/architecture/features/office.md -> "Live job progress".
 * [COMP:api/office-job-stream]
 */
import { Router, type Response } from 'express'
import { z } from 'zod'
import { SSE_MAX_LIFETIME_MS } from './brain-stream.js'
import { subscribeOfficeJob, type OfficeJobPointer } from '../office/job-event-bus.js'
import { readOfficeProjection } from '../db/office-read-projection.js'
import { officeJobBody } from './office-jobs.js'
import type { OfficeGenerationEventRow, OfficeGenerationJobRow } from '../db/office-generation.js'

const HEARTBEAT_MS = 25_000
/** Retry after a projection that changed between its two reads (a concurrent write). */
const CHANGED_RETRY_MS = 250
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export type OfficeJobStreamRead =
  | { kind: 'ok'; job: OfficeGenerationJobRow; body: Record<string, unknown>; events: OfficeGenerationEventRow[] }
  | { kind: 'denied' }
  | { kind: 'changed' }

export type OfficeJobStreamDeps = {
  /** Access-projected read of the job body and its events after `afterSeq`. */
  read(userId: string, jobId: string, afterSeq: number): Promise<OfficeJobStreamRead>
  subscribe?(jobId: string, listener: (pointer: OfficeJobPointer) => void): () => void
  /** Run the worker for this job kind as the job's initiator. */
  wake?(job: OfficeGenerationJobRow): void
  maxLifetimeMs?: number
  heartbeatMs?: number
  now?(): number
}

/** A non-terminal job nobody is working: lease lapsed, or queued with no live lease. */
export function officeJobNeedsWake(job: Pick<OfficeGenerationJobRow, 'status' | 'leaseExpiresAt'>, now: number): boolean {
  if (job.status !== 'running' && job.status !== 'queued') return false
  if (!job.leaseExpiresAt) return true
  return new Date(job.leaseExpiresAt).getTime() < now
}

function lastEventId(raw: unknown): number {
  return z.coerce.number().int().min(0).catch(0).parse(raw ?? 0)
}

export function officeJobStreamRoutes(deps: OfficeJobStreamDeps): Router {
  const router = Router()
  const subscribe = deps.subscribe ?? subscribeOfficeJob
  const maxLifetimeMs = deps.maxLifetimeMs ?? SSE_MAX_LIFETIME_MS
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
  const now = deps.now ?? Date.now

  router.get('/jobs/:jobId/stream', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const jobId = String(req.params.jobId)
    let lastSeq = Math.max(lastEventId(req.headers['last-event-id']), lastEventId(req.query.afterSeq))

    let first = await deps.read(userId, jobId, lastSeq)
    if (first.kind === 'changed') first = await deps.read(userId, jobId, lastSeq)
    if (first.kind !== 'ok') return void res.status(first.kind === 'denied' ? 404 : 409).json({ error: first.kind === 'denied' ? 'Office job not found' : 'office_projection_changed' })

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    // Past this point the stream speaks only in SSE events.
    let open = true
    let lastJob = ''
    const write = (chunk: string) => {
      if (!open || res.writableEnded) return
      try { res.write(chunk) } catch { cleanup() }
    }
    const frame = (event: string, data: unknown, id?: number) =>
      write(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

    const publish = (read: Extract<OfficeJobStreamRead, { kind: 'ok' }>) => {
      const job = JSON.stringify(read.body)
      if (job !== lastJob) {
        lastJob = job
        frame('job', read.body)
      }
      for (const event of read.events) {
        if (event.seq <= lastSeq) continue
        lastSeq = event.seq
        frame('event', event, event.seq)
      }
      if (TERMINAL.has(read.job.status)) {
        frame('done', { status: read.job.status })
        cleanup()
        return
      }
      if (deps.wake && officeJobNeedsWake(read.job, now())) deps.wake(read.job)
    }

    // One refresh at a time; pointers arriving mid-refresh fold into one more.
    let running = false
    let again = false
    let retry: NodeJS.Timeout | null = null
    const refresh = (): void => {
      if (!open) return
      if (running) { again = true; return }
      running = true
      void deps.read(userId, jobId, lastSeq).then((read) => {
        if (!open) return
        if (read.kind === 'denied') {
          frame('revoked', {})
          cleanup()
        } else if (read.kind === 'changed') {
          retry ??= setTimeout(() => { retry = null; refresh() }, CHANGED_RETRY_MS)
        } else publish(read)
      }).catch(() => {
        // A transient read failure: the next pointer or heartbeat retries.
      }).finally(() => {
        running = false
        if (again) { again = false; refresh() }
      })
    }

    const unsubscribe = subscribe(jobId, () => refresh())
    const heartbeat = setInterval(() => {
      write(': ping\n\n')
      refresh()
    }, heartbeatMs)
    heartbeat.unref?.()
    const lifetime = setTimeout(() => {
      write(': cycle\n\n')
      cleanup()
    }, Math.round(maxLifetimeMs * (0.8 + Math.random() * 0.4)))
    lifetime.unref?.()

    function cleanup(): void {
      if (!open) return
      open = false
      clearInterval(heartbeat)
      clearTimeout(lifetime)
      if (retry) clearTimeout(retry)
      unsubscribe()
      endQuietly(res)
    }
    req.on('close', cleanup)
    res.on('error', cleanup)

    publish(first)
  })

  return router
}

/** Event pages per read; a job writes tens of events, so this bound is never reached in practice. */
const MAX_EVENT_PAGES = 20
const EVENT_PAGE = 500

/** Production reader: the same access projection as `GET /jobs/:jobId`. */
export function officeJobStreamRead(store: {
  get(userId: string, jobId: string): Promise<OfficeGenerationJobRow | null>
  listEvents(userId: string, jobId: string, afterSeq: number): Promise<OfficeGenerationEventRow[]>
  latestEvent(userId: string, jobId: string): Promise<OfficeGenerationEventRow | null>
}): OfficeJobStreamDeps['read'] {
  return async (userId, jobId, afterSeq) => {
    let job: OfficeGenerationJobRow | null = null
    let events: OfficeGenerationEventRow[] = []
    const reply = await readOfficeProjection(userId, async () => {
      job = await store.get(userId, jobId)
      if (!job) return { status: 404, body: { error: 'Office job not found' } }
      events = []
      let after = afterSeq
      for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const rows = await store.listEvents(userId, jobId, after)
        events.push(...rows)
        if (rows.length < EVENT_PAGE) break
        after = rows[rows.length - 1]!.seq
      }
      const latest = events.at(-1) ?? await store.latestEvent(userId, jobId)
      return { workspaceId: job.workspaceId, body: await officeJobBody(userId, job, latest) }
    })
    if (reply.status === 409) return { kind: 'changed' }
    if ((reply.status ?? 200) >= 400 || !job) return { kind: 'denied' }
    return { kind: 'ok', job, body: reply.body as Record<string, unknown>, events }
  }
}

function endQuietly(res: Response): void {
  try { res.end() } catch { /* socket already closed */ }
}
