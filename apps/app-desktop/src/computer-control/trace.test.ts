import { NativeBrokerTraceEventSchema as SharedBrokerSchema } from '@use-brian/computer-control/broker-trace.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { NativeBrokerTrace, NativeBrokerTraceEventSchema, TRACE_DELIVERY_TIMEOUT_MS, TRACE_EVENT_LIMIT, TRACE_QUEUE_LIMIT, type NativeBrokerObserverFactory, type NativeBrokerTraceEvent, type NativeTraceMetadata } from './trace.js'
const binding = () => ({ sessionId: randomUUID(), epoch: 1 })
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())
describe('trusted broker trace transport', () => {
  it('re-exports the canonical shared runtime validator', () => { expect(NativeBrokerTraceEventSchema).toBe(SharedBrokerSchema) })
  it('is default-off and rejects non-UUID or extra scope instead of copying private identity', async () => {
    const factory = vi.fn(() => vi.fn())
    expect(NativeBrokerTrace.create(undefined, binding())).toBeUndefined()
    expect(NativeBrokerTrace.create(factory, { sessionId: 'secret-account', epoch: 1 })).toBeUndefined()
    expect(NativeBrokerTrace.create(factory, { ...binding(), token: 'secret' } as never)).toBeUndefined()
    await flush(); expect(factory).not.toHaveBeenCalled()
  })
  it('projects strict immutable bounded metadata with generated source/clock IDs and monotonic sequence', async () => {
    const events: NativeBrokerTraceEvent[] = []
    const scope = binding()
    const factory = vi.fn(received => { expect(Object.isFrozen(received)).toBe(true); expect(Object.keys(received).sort()).toEqual(['epoch', 'sessionId']); return (event: NativeBrokerTraceEvent) => { events.push(event) } })
    const trace = NativeBrokerTrace.create(factory, scope)!
    const command = { commandId: randomUUID(), actionKind: 'observe' as const }
    trace.record({ event: 'command_admission', outcome: 'admitted', command })
    command.actionKind = 'capture' as never
    trace.record({ event: 'local_gate_revoked', outcome: 'revoked', durationMs: 0.1 })
    expect(factory).not.toHaveBeenCalled() // no callback in a broker critical section
    await flush()
    expect(events).toHaveLength(2)
    for (const event of events) expect(NativeBrokerTraceEventSchema.parse(event)).toEqual(event)
    expect(events.map(e => e.sequence)).toEqual([1, 2])
    expect(events[1].elapsedMs).toBeGreaterThanOrEqual(events[0].elapsedMs)
    expect(events[0]).toMatchObject({ source: 'desktop_broker', ...scope, command: { actionKind: 'observe' }, incomplete: false })
    expect(events[0].sourceId).toMatch(/^[0-9a-f-]{36}$/); expect(events[0].clockId).toMatch(/^[0-9a-f-]{36}$/)
    expect(Object.isFrozen(events[0])).toBe(true); expect(Object.isFrozen(events[0].command)).toBe(true)
    expect(trace.health()).toEqual({ incomplete: false, dropped: 0, pending: 0 })
  })
  it('drops unexpected fields, raw identifiers, nonfinite timings and unknown enums without leaking errors or content', async () => {
    const events: NativeBrokerTraceEvent[] = []
    const trace = NativeBrokerTrace.create(() => e => { events.push(e) }, binding())!
    for (const extra of ['label', 'target', 'ref', 'goal', 'text', 'frame', 'token', 'error', 'hash', 'auth']) {
      trace.record({ event: 'stop_requested', outcome: 'started', [extra]: 'private-sentinel' } as NativeTraceMetadata)
    }
    trace.record({ event: 'secret-event', outcome: 'failed' } as never)
    trace.record({ event: 'stop_requested', outcome: 'started', durationMs: Infinity })
    trace.record({ event: 'command_admission', outcome: 'admitted', command: { commandId: 'secret-command', actionKind: 'observe' } })
    await flush()
    expect(trace.health().incomplete).toBe(true)
    expect(events).toHaveLength(1); expect(events[0].event).toBe('trace_incomplete')
    expect(JSON.stringify(events)).not.toMatch(/private-sentinel|secret-event|secret-command/)
  })
  it('bounds overflow/backpressure and marks the stream incomplete once delivery recovers', async () => {
    let release!: () => void
    const events: NativeBrokerTraceEvent[] = []
    const trace = NativeBrokerTrace.create(() => async e => { events.push(e); if (events.length === 1) await new Promise<void>(resolve => { release = resolve }) }, binding())!
    trace.record({ event: 'stop_requested', outcome: 'started' }); await flush()
    for (let i = 0; i < TRACE_QUEUE_LIMIT * 3; i++) trace.record({ event: 'authority_check', outcome: 'resolved' })
    expect(trace.health().pending).toBeLessThanOrEqual(TRACE_QUEUE_LIMIT)
    expect(trace.health().incomplete).toBe(true)
    release(); for (let i = 0; i < 30; i++) await flush()
    expect(events.at(-1)).toMatchObject({ event: 'trace_incomplete', incomplete: true })
    expect(events).toHaveLength(TRACE_QUEUE_LIMIT + 1)
  })
  it('has a lifetime event cap, not just a queue bound', async () => {
    const events: NativeBrokerTraceEvent[] = []
    const trace = NativeBrokerTrace.create(() => e => { events.push(e) }, binding())!
    for (let i = 0; i < TRACE_EVENT_LIMIT + 10; i++) { trace.record({ event: 'authority_check', outcome: 'resolved' }); await flush() }
    expect(events).toHaveLength(TRACE_EVENT_LIMIT + 1)
    expect(events.at(-1)?.event).toBe('trace_incomplete')
  })
  it.each(['throw', 'reject', 'hang'] as const)('isolates %s from factory and observer without unhandled rejection', async failure => {
    vi.useFakeTimers()
    const fail = () => { if (failure === 'throw') throw new Error('private-error'); return failure === 'reject' ? Promise.reject(new Error('private-error')) : new Promise<never>(() => {}) }
    for (const factory of [fail as NativeBrokerObserverFactory, () => fail]) {
      const trace = NativeBrokerTrace.create(factory, binding())!
      expect(() => trace.record({ event: 'stop_requested', outcome: 'started' })).not.toThrow()
      await flush(); await vi.advanceTimersByTimeAsync(TRACE_DELIVERY_TIMEOUT_MS + 1); await flush()
      expect(trace.health().incomplete).toBe(true)
      expect(trace.health().pending).toBe(0)
    }
  })
})
