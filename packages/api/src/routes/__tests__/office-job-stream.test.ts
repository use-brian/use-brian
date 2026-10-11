/**
 * Per-job Office progress stream + job-event bus.
 * Component tag: [COMP:api/office-job-stream].
 *
 * The route runs against a real ephemeral http server and is read with fetch.
 * The bus runs for real; only the shared LISTEN connection is mocked, so a
 * NOTIFY payload "from another instance" is delivered by invoking the handler
 * the bus registered on it.
 *
 * Spec: docs/architecture/features/office.md -> "Live job progress".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const notify = vi.hoisted(() => ({ handlers: new Map<string, (payload: string) => void>() }))
vi.mock('../../db/notify-listener.js', () => ({
  registerNotifyChannel: (channel: string, handler: (payload: string) => void) => notify.handlers.set(channel, handler),
  startNotifyListener: () => undefined,
  unregisterNotifyChannel: async (channel: string) => { notify.handlers.delete(channel) },
}))
const spine = vi.hoisted(() => ({ dispatched: [] as unknown[] }))
vi.mock('../../brain-stream/sse-fanout.js', () => ({
  dispatchBrainChangeLocal: (payload: unknown) => { spine.dispatched.push(payload) },
}))

import { officeJobNeedsWake, officeJobStreamRoutes, type OfficeJobStreamDeps, type OfficeJobStreamRead } from '../office-job-stream.js'
import { _resetOfficeJobEventBus, parseOfficeJobPointer } from '../../office/job-event-bus.js'
import type { OfficeGenerationEventRow, OfficeGenerationJobRow } from '../../db/office-generation.js'

const JOB = '33333333-3333-4333-8333-333333333333'
const WS = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'

function jobRow(patch: Partial<OfficeGenerationJobRow> = {}): OfficeGenerationJobRow {
  return {
    id: JOB, workspaceId: WS, artifactId: 'a', initiatedByUserId: USER, assistantId: null, jobKind: 'create',
    status: 'running', stage: 'grounding', brief: {}, authorityProjection: {}, templateVersionId: null,
    baseArtifactVersion: 0, checkpoint: {}, checkpointVersion: 1, leaseToken: 'lease',
    leaseExpiresAt: new Date(Date.now() + 60_000), cancelRequestedAt: null, errorCode: null,
    createdAt: new Date(), updatedAt: new Date(), ...patch,
  }
}
function event(seq: number, code = 'office.job.context_grounded'): OfficeGenerationEventRow {
  return { id: `e${seq}`, jobId: JOB, seq, code, params: {}, actorType: 'system', safeNarration: code, createdAt: new Date() }
}

/** A mutable fake job + event log behind the injected access-projected read. */
function world() {
  const state = { job: jobRow(), events: [] as OfficeGenerationEventRow[], denied: false, reads: 0 }
  const read: OfficeJobStreamDeps['read'] = async (_user, _job, afterSeq): Promise<OfficeJobStreamRead> => {
    state.reads++
    if (state.denied) return { kind: 'denied' }
    return { kind: 'ok', job: state.job, body: { id: state.job.id, status: state.job.status }, events: state.events.filter(e => e.seq > afterSeq) }
  }
  return { state, read }
}

type Frame = { event: string; id?: string; data: unknown }
let servers: http.Server[] = []

async function open(deps: OfficeJobStreamDeps, headers: Record<string, string> = {}, query = '') {
  const app = express()
  app.use((req, _res, next) => { (req as { userId?: string }).userId = USER; next() })
  app.use('/api/office', officeJobStreamRoutes(deps))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/api/office/jobs/${JOB}/stream${query}`, { headers, signal: controller.signal })
  const frames: Frame[] = []
  let closed = false
  const pump = (async () => {
    if (!response.body) return
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let at: number
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          const frame: Frame = { event: '', data: null }
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) frame.event = line.slice(7)
            else if (line.startsWith('id: ')) frame.id = line.slice(4)
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
            else if (line.startsWith(': ')) frame.event = `:${line.slice(2)}`
          }
          frames.push(frame)
        }
      }
    } catch { /* aborted */ }
    closed = true
  })()
  return {
    response, frames, controller,
    get closed() { return closed },
    async until(predicate: () => boolean, ms = 2_000) {
      const started = Date.now()
      while (!predicate()) {
        if (Date.now() - started > ms) throw new Error(`timed out; frames: ${JSON.stringify(frames)}`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    },
    async done() { controller.abort(); await pump },
  }
}

beforeEach(async () => {
  await _resetOfficeJobEventBus()
  notify.handlers.clear()
  spine.dispatched = []
})
afterEach(async () => {
  for (const server of servers) server.closeAllConnections?.()
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  servers = []
})

describe('[COMP:api/office-job-stream] per-job stream', () => {
  it('404s an ineligible caller without opening a stream', async () => {
    const { state, read } = world()
    state.denied = true
    const stream = await open({ read })
    expect(stream.response.status).toBe(404)
    expect(stream.response.headers.get('content-type')).not.toContain('text/event-stream')
    await stream.done()
  })

  it('sends the job frame and every event after Last-Event-ID, each with its seq as id', async () => {
    const { state, read } = world()
    state.events = [event(1), event(2), event(3), event(4)]
    const stream = await open({ read }, { 'Last-Event-ID': '2' })
    await stream.until(() => stream.frames.filter(f => f.event === 'event').length === 2)
    expect(stream.frames[0]).toMatchObject({ event: 'job', data: { id: JOB, status: 'running' } })
    expect(stream.frames.filter(f => f.event === 'event').map(f => f.id)).toEqual(['3', '4'])
    await stream.done()
  })

  it('resumes from ?afterSeq and never repeats or skips a seq across pointers', async () => {
    const { state, read } = world()
    state.events = [event(1), event(2)]
    const stream = await open({ read }, {}, '?afterSeq=1')
    await stream.until(() => stream.frames.some(f => f.id === '2'))
    state.events.push(event(3))
    const handler = notify.handlers.get('office_job_events')!
    handler(JSON.stringify({ jobId: JOB, workspaceId: WS, seq: 3 }))
    handler(JSON.stringify({ jobId: JOB, workspaceId: WS, seq: 3 }))
    state.events.push(event(4))
    handler(JSON.stringify({ jobId: JOB, workspaceId: WS, seq: 4 }))
    await stream.until(() => stream.frames.some(f => f.id === '4'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stream.frames.filter(f => f.event === 'event').map(f => f.id)).toEqual(['2', '3', '4'])
    await stream.done()
  })

  it('delivers an event committed on another instance through the bus pointer', async () => {
    const { state, read } = world()
    const stream = await open({ read })
    await stream.until(() => stream.frames.some(f => f.event === 'job'))
    // Another instance's commit: the trigger NOTIFY reaches this instance's
    // shared LISTEN connection, which hands the raw payload to the bus.
    state.events.push(event(1, 'office.job.started'))
    notify.handlers.get('office_job_events')!(JSON.stringify({ jobId: JOB, workspaceId: WS, seq: 1 }))
    await stream.until(() => stream.frames.some(f => f.event === 'event'))
    expect(stream.frames.find(f => f.event === 'event')).toMatchObject({ id: '1', data: { code: 'office.job.started' } })
    await stream.done()
  })

  it('sends done and closes when the job reaches a terminal status', async () => {
    const { state, read } = world()
    const stream = await open({ read })
    await stream.until(() => stream.frames.some(f => f.event === 'job'))
    state.job = jobRow({ status: 'completed', leaseExpiresAt: null })
    state.events.push(event(1, 'office.job.completed'))
    notify.handlers.get('office_job_events')!(JSON.stringify({ jobId: JOB, workspaceId: WS, seq: null }))
    await stream.until(() => stream.closed)
    expect(stream.frames.map(f => f.event)).toEqual(['job', 'job', 'event', 'done'])
    expect(stream.frames.at(-1)!.data).toEqual({ status: 'completed' })
  })

  it('keeps a needs_input job open for its resume', async () => {
    const { state, read } = world()
    state.job = jobRow({ status: 'needs_input', leaseExpiresAt: null })
    const stream = await open({ read })
    await stream.until(() => stream.frames.some(f => f.event === 'job'))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stream.closed).toBe(false)
    expect(stream.frames.some(f => f.event === 'done')).toBe(false)
    await stream.done()
  })

  it('sends revoked and closes when the heartbeat re-check denies the reader', async () => {
    const { state, read } = world()
    const stream = await open({ read, heartbeatMs: 20 })
    await stream.until(() => stream.frames.some(f => f.event === 'job'))
    state.denied = true
    await stream.until(() => stream.closed)
    expect(stream.frames.at(-1)!.event).toBe('revoked')
  })

  it('wakes a job whose lease lapsed when someone subscribes', async () => {
    const { state, read } = world()
    state.job = jobRow({ status: 'running', leaseExpiresAt: new Date(Date.now() - 1_000) })
    const wake = vi.fn()
    const stream = await open({ read, wake })
    await stream.until(() => wake.mock.calls.length > 0)
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ id: JOB, initiatedByUserId: USER }))
    await stream.done()
  })

  it('does not wake a job with a live lease', async () => {
    const { read } = world()
    const wake = vi.fn()
    const stream = await open({ read, wake })
    await stream.until(() => stream.frames.some(f => f.event === 'job'))
    expect(wake).not.toHaveBeenCalled()
    await stream.done()
  })

  it('bounds its own lifetime with a clean cycle end', async () => {
    const { read } = world()
    const stream = await open({ read, maxLifetimeMs: 40 })
    await stream.until(() => stream.closed)
    expect(stream.frames.at(-1)!.event).toBe(':cycle')
  })
})

describe('[COMP:api/office-job-stream] job-event bus', () => {
  it('parses id-only pointers and drops anything else', () => {
    expect(parseOfficeJobPointer(JSON.stringify({ jobId: JOB, workspaceId: WS, seq: 7 }))).toEqual({ jobId: JOB, workspaceId: WS, seq: 7 })
    expect(parseOfficeJobPointer(JSON.stringify({ jobId: JOB, seq: null }))).toEqual({ jobId: JOB, workspaceId: undefined, seq: null })
    expect(parseOfficeJobPointer('{"jobId":"not-a-uuid"}')).toBeNull()
    expect(parseOfficeJobPointer('nope')).toBeNull()
  })

  it('forwards one coalesced office primitive per workspace to local spine subscribers', async () => {
    const { read } = world()
    const stream = await open({ read })
    await stream.until(() => stream.frames.some(f => f.event === 'job'))
    const handler = notify.handlers.get('office_job_events')!
    handler(JSON.stringify({ jobId: JOB, workspaceId: WS, seq: 1 }))
    handler(JSON.stringify({ jobId: JOB, workspaceId: WS, seq: 2 }))
    expect(spine.dispatched).toEqual([{ workspaceId: WS, primitive: 'office', rowId: JOB, action: 'update' }])
    await stream.done()
  })

  it('treats a lapsed running lease and an unleased queued job as needing a wake', () => {
    const now = Date.now()
    expect(officeJobNeedsWake({ status: 'running', leaseExpiresAt: new Date(now - 1) }, now)).toBe(true)
    expect(officeJobNeedsWake({ status: 'queued', leaseExpiresAt: null }, now)).toBe(true)
    expect(officeJobNeedsWake({ status: 'running', leaseExpiresAt: new Date(now + 1_000) }, now)).toBe(false)
    expect(officeJobNeedsWake({ status: 'needs_input', leaseExpiresAt: null }, now)).toBe(false)
    expect(officeJobNeedsWake({ status: 'completed', leaseExpiresAt: null }, now)).toBe(false)
  })
})
