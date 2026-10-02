import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { NativeRunTrace, NativeTraceEventSchema, type NativeTraceEvent, type NativeInferenceLifecycle } from './trace.js'

const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }

describe('bounded metadata-only native trace', () => {
  it('generates immutable identities, sequence and source-local timings with a strict content-free shape', async () => {
    let now = 100
    const received: NativeTraceEvent[] = []
    const trace = new NativeRunTrace(event => { received.push(event) }, { clock: () => now })
    trace.startRun(); now = 110
    const commandId = randomUUID()
    const span = trace.startSpan('effect-rpc', 2, { commandId, actionKind: 'setValue' })!
    now = 145; span.settle('fulfilled'); now = 160; trace.terminal('completed', 3)
    await flush()
    expect(received.map(e => e.sequence)).toEqual([1, 2, 3, 4])
    expect(received.map(e => e.durationMs)).toEqual([null, null, 35, 60])
    expect(received[1]).toMatchObject({ source: 'core-process', phase: 'effect-rpc', scope: 'rpc', step: 2, commandId, actionKind: 'setValue' })
    expect(received[3]).toMatchObject({ kind: 'run-terminal', outcome: 'completed', drain: 'not_observed' })
    expect(span.correlation.spanId).toBe(received[1]!.spanId)
    expect(new Set([trace.runId, trace.clockId, span.correlation.spanId]).size).toBe(3)
    for (const event of received) {
      expect(NativeTraceEventSchema.safeParse(event).success).toBe(true)
      expect(Object.isFrozen(event)).toBe(true)
      expect(NativeTraceEventSchema.safeParse({ ...event, goal: 'private' }).success).toBe(false)
    }
    expect(Object.isFrozen(span.correlation)).toBe(true)
    expect(Object.isFrozen(trace.snapshot())).toBe(true)
    expect(Object.isFrozen(trace.snapshot().events)).toBe(true)
    expect(() => Object.assign(trace, { runId: 'injected' })).toThrow()
    expect(trace.snapshot()).toMatchObject({ logicalTerminal: true, pendingSpans: 0, pendingObserverCallbacks: 0, evidence: 'valid' })
  })
  it('separates interruption, logical terminal and late settlement without claiming drain', () => {
    let now = 1
    const trace = new NativeRunTrace(undefined, { clock: () => now })
    const span = trace.startSpan('generation', 0)!
    now = 5; span.interrupt(); span.interrupt()
    now = 8; trace.terminal('cancelled', 0)
    expect(trace.snapshot()).toMatchObject({ pendingSpans: 1, logicalTerminal: true, drain: 'not_observed' })
    now = 20; span.settle('rejected'); span.settle('fulfilled')
    trace.terminal('completed', 1)
    expect(trace.startSpan('selection', 1)).toBeUndefined()
    const events = trace.snapshot().events
    expect(events.map(e => e.kind)).toEqual(['run-start', 'span-start', 'span-interrupted', 'run-terminal', 'span-settled'])
    expect(events.at(-1)).toMatchObject({ late: true, outcome: 'rejected', durationMs: 19, drain: 'not_observed' })
  })
  it.each(['NaN', 'Infinity', 'backwards', 'throws'] as const)('poisons %s clocks explicitly and never fabricates zero durations', invalid => {
    let bad = false
    const trace = new NativeRunTrace(undefined, { clock: () => {
      if (!bad) return 10
      if (invalid === 'throws') throw new Error('private-clock-error')
      return invalid === 'backwards' ? 9 : invalid === 'NaN' ? NaN : Infinity
    } })
    const span = trace.startSpan('verification', 0)!
    bad = true; span.settle('fulfilled'); trace.terminal('completed', 0)
    const snapshot = trace.snapshot()
    expect(snapshot).toMatchObject({ evidence: 'poisoned', poisonReasons: ['invalid_clock'] })
    expect(snapshot.events.find(e => e.kind === 'evidence-poisoned')).toMatchObject({ atMs: null, durationMs: null, poisonReason: 'invalid_clock' })
    expect(snapshot.events.at(-1)).toMatchObject({ atMs: null, durationMs: null })
    expect(snapshot.events.find(e => e.kind === 'span-settled')).toMatchObject({ atMs: null, durationMs: null })
    expect(JSON.stringify(snapshot)).not.toContain('private-clock-error')
  })
  it('bounds overflow, preserves an explicit poison and terminal, and never silently trims', () => {
    const trace = new NativeRunTrace(undefined, { maxEvents: 16 })
    for (let i = 0; i < 100; i++) trace.startSpan('selection', i)?.settle('fulfilled')
    trace.terminal('paused', 100)
    const snapshot = trace.snapshot()
    expect(snapshot.events.length).toBeLessThanOrEqual(16)
    expect(snapshot.poisonReasons).toContain('overflow')
    expect(snapshot.events.filter(e => e.poisonReason === 'overflow')).toHaveLength(1)
    expect(snapshot.events.at(-1)).toMatchObject({ kind: 'run-terminal', evidence: 'poisoned', drain: 'not_observed' })
  })
  it('rejects invalid/freeform metadata without leaking it', () => {
    const trace = new NativeRunTrace()
    expect(trace.startSpan('private-goal' as never, 0)).toBeUndefined()
    expect(trace.startSpan('effect-rpc', 0, { commandId: 'private-ref', actionKind: 'click' })).toBeUndefined()
    expect(trace.startSpan('capture-rpc', 0, { commandId: randomUUID(), actionKind: 'key' })).toBeUndefined()
    expect(trace.startSpan('generation', -1)).toBeUndefined()
    expect(trace.snapshot().poisonReasons).toEqual(['invalid_metadata'])
    expect(JSON.stringify(trace.snapshot())).not.toMatch(/private-goal|private-ref/)
  })
  it.each(['throws', 'rejects', 'hangs'] as const)('never awaits observer that %s, and bounds detached delivery', async mode => {
    const observer = vi.fn(() => {
      if (mode === 'throws') throw new Error('private-observer-error')
      if (mode === 'rejects') return Promise.reject(new Error('private-observer-error'))
      return new Promise<void>(() => {})
    })
    const trace = new NativeRunTrace(observer)
    trace.startSpan('generation', 0)?.settle('fulfilled')
    trace.terminal('completed', 0)
    await flush()
    expect(trace.snapshot().logicalTerminal).toBe(true)
    if (mode !== 'hangs') expect(trace.snapshot().poisonReasons).toContain('observer_failed')
    expect(JSON.stringify(trace.snapshot())).not.toContain('private-observer-error')
    const backpressure = new NativeRunTrace(observer)
    for (let i = 0; i < 20; i++) backpressure.startSpan('selection', i)?.settle('fulfilled')
    await flush()
    expect(backpressure.snapshot().pendingObserverCallbacks).toBeLessThanOrEqual(8)
    expect(backpressure.snapshot().poisonReasons).toContain('observer_backpressure')
  })
})


const invocation = (): NativeInferenceLifecycle => ({
  attemptId: randomUUID(), requestedModel: 'requested-alias', model: null, invocationState: 'pending', interrupted: false,
  providerKind: 'other', lane: 'text', operation: 'plan', stage: 'direct', perceptionPath: 'ax',
  fallbackReason: 'none', disposition: null, outcome: 'pending', durationMs: 0, usage: null,
  incurredCostUsd: null, estimatedBilledCostUsd: null, providerKeySource: 'platform',
})
describe('actual invocation metadata, not provider network spans', () => {
  it('upserts immutable accounting copies, source durations and late settlement without claiming drain', async () => {
    const received: NativeTraceEvent[] = [], trace = new NativeRunTrace(e => { received.push(e) }, { clock: () => 90000 })
    const span = trace.startSpan('generation', 2)!, first = invocation()
    trace.recordInference(span.correlation, first)
    trace.recordInference(span.correlation, first)
    const pending = { ...first, model: 'actual-wire', providerKind: 'openai', interrupted: true, outcome: 'failed', durationMs: 37 }
    trace.recordInference(span.correlation, pending)
    span.interrupt(); trace.terminal('cancelled', 2)
    expect(trace.snapshot()).toMatchObject({ pendingInvocations: 1, pendingSpans: 1, logicalTerminal: true, drain: 'not_observed' })
    await flush()
    const settled = { ...pending, invocationState: 'settled', durationMs: 500, usage: { inputTokens: 5, outputTokens: 2 }, incurredCostUsd: 0.1, estimatedBilledCostUsd: 0.1 }
    trace.recordInference(span.correlation, settled)
    trace.recordInference(span.correlation, settled)
    settled.usage.inputTokens = 999
    await flush()
    const events = received.filter(e => e.kind === 'inference-update')
    expect(events).toHaveLength(3)
    expect(events.map(e => e.durationMs)).toEqual([0, 37, 500])
    expect(events.at(-1)).toMatchObject({ scope: 'adapter-lifecycle', atMs: null, late: true, evidence: 'valid', inference: { usage: { inputTokens: 5 }, attemptId: first.attemptId } })
    expect(trace.snapshot()).toMatchObject({ pendingInvocations: 0, pendingSpans: 1, drain: 'not_observed' })
    expect(trace.snapshot().invocations).toHaveLength(1)
    for (const event of events) {
      expect(NativeTraceEventSchema.safeParse(event).success).toBe(true)
      expect(Object.isFrozen(event.inference)).toBe(true)
      if (event.inference!.usage) expect(Object.isFrozen(event.inference!.usage)).toBe(true)
    }
    expect(Object.isFrozen(trace.snapshot().invocations[0])).toBe(true)
  })
  it.each(['run', 'clock', 'span', 'phase', 'requestedModel', 'lane', 'stage', 'operation', 'providerKeySource', 'actualModel', 'settled', 'raw', 'bad-cost', 'backwards'] as const)('rejects conflicting %s evidence rather than inventing attempts', conflict => {
    const trace = new NativeRunTrace(), span = trace.startSpan('generation', 0)!
    const first = { ...invocation(), model: 'actual-wire' }
    trace.recordInference(span.correlation, first)
    const correlation = { ...span.correlation }, next: Record<string, unknown> = { ...first, durationMs: 10 }
    if (conflict === 'run') correlation.runId = randomUUID()
    else if (conflict === 'clock') correlation.clockId = randomUUID()
    else if (conflict === 'span') correlation.spanId = trace.startSpan('generation', 0)!.correlation.spanId
    else if (conflict === 'phase') { correlation.spanId = trace.startSpan('selection', 0)!.correlation.spanId; next.attemptId = randomUUID() }
    else if (conflict === 'actualModel') next.model = 'conflicting-model'
    else if (conflict === 'raw') next.raw = 'private-secret'
    else if (conflict === 'bad-cost') next.incurredCostUsd = Infinity
    else if (conflict === 'backwards') next.durationMs = -1
    else if (conflict === 'settled') {
      trace.recordInference(span.correlation, { ...first, invocationState: 'settled', outcome: 'ok' })
      next.invocationState = 'settled'; next.outcome = 'ok'; next.usage = { inputTokens: 20, outputTokens: 1 }
    } else next[conflict] = conflict === 'providerKeySource' ? 'user' : conflict === 'lane' ? 'vision' : conflict === 'operation' ? 'ground' : conflict === 'stage' ? 'llm_only' : 'another-alias'
    trace.recordInference(correlation, next)
    expect(trace.snapshot()).toMatchObject({ evidence: 'poisoned', poisonReasons: ['invalid_metadata'] })
    expect(trace.snapshot().invocations).toHaveLength(1)
    expect(trace.snapshot().invocations[0]!.inference).toMatchObject({ model: 'actual-wire', usage: null })
    expect(JSON.stringify(trace.snapshot())).not.toContain('private-secret')
  })
  it('does not fabricate admission or drain for unknown/late invocation identities', () => {
    const trace = new NativeRunTrace(), span = trace.startSpan('generation', 0)!
    trace.recordInference(span.correlation, { ...invocation(), invocationState: 'settled', outcome: 'ok' })
    trace.terminal('completed', 0)
    trace.recordInference(span.correlation, invocation())
    expect(trace.snapshot()).toMatchObject({ evidence: 'poisoned', invocations: [], drain: 'not_observed' })
  })
  it('bounds invocation storage and pending observers without awaiting them', async () => {
    const trace = new NativeRunTrace(() => new Promise(() => {}), { maxEvents: 16 })
    const span = trace.startSpan('generation', 0)!
    for (let n = 0; n < 50; n++) trace.recordInference(span.correlation, invocation())
    trace.terminal('paused', 0); await flush()
    expect(trace.snapshot().events.length).toBeLessThanOrEqual(16)
    expect(trace.snapshot().invocations.length).toBeLessThan(16)
    expect(trace.snapshot().pendingObserverCallbacks).toBeLessThanOrEqual(8)
    expect(trace.snapshot().poisonReasons).toContain('overflow')
    expect(trace.snapshot().logicalTerminal).toBe(true)
  })
})
