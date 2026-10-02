import { describe, expect, it } from 'vitest'
import { HelperTimingSchema, HelperTimingEventSchema, type HelperTimingEvent } from '../helper-timing.js'
const span = { phase: 'request', startUs: 100, endUs: 160, durationUs: 60, status: 'returned' }
const timing = { version: 1, instanceId: '12345678-1234-4234-8234-123456789012', clockId: '12345678-1234-4234-8234-123456789013', requestId: 'request-1', method: 'execute', spans: [span] }
describe('private helper source timing', () => {
  it('accepts source intervals and nested actual API invocation, not delivery claims', () => {
    expect(HelperTimingSchema.parse(timing)).toEqual(timing)
    expect(HelperTimingSchema.safeParse({ ...timing, spans: [span, { ...span, phase: 'api_invoke', startUs: 120, durationUs: 40, status: 'failed' }] }).success).toBe(true)
  })
  it('strictly bounds integer source times and durations (no bool coercion)', () => {
    for (const key of ['startUs', 'endUs', 'durationUs']) for (const value of [true, false, '100', 0.5, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(HelperTimingSchema.safeParse({ ...timing, spans: [{ ...span, [key]: value }] }).success).toBe(false)
    }
    for (const bad of [{ endUs: 99 }, { durationUs: 59 }, { startUs: 0, endUs: 900_000_001, durationUs: 900_000_001 }]) {
      expect(HelperTimingSchema.safeParse({ ...timing, spans: [{ ...span, ...bad }] }).success).toBe(false)
    }
  })
  it('rejects content, unknown enums, invalid IDs and unbounded/misnested spans', () => {
    for (const key of ['values', 'refs', 'labels', 'targets', 'frames', 'goals', 'credentials', 'errors', 'contentHash']) {
      expect(HelperTimingSchema.safeParse({ ...timing, [key]: 'secret' }).success).toBe(false)
      expect(HelperTimingSchema.safeParse({ ...timing, spans: [{ ...span, [key]: 'secret' }] }).success).toBe(false)
    }
    for (const bad of [{ instanceId: 'not-a-uuid' }, { clockId: 'x'.repeat(300) }, { requestId: 'x'.repeat(257) }, { method: 'emit' }, { version: true }, { spans: [] }, { spans: [span, span, span] }, { spans: [{ ...span, phase: 'delivered' }] }, { spans: [{ ...span, status: 'drained' }] }, { spans: [span, { ...span, phase: 'api_scroll', startUs: 90, durationUs: 70 }] }, { method: 'capture' }, { method: 'start', spans: [{ ...span, phase: 'observe_request' }] }]) {
      expect(HelperTimingSchema.safeParse({ ...timing, ...bad }).success).toBe(false)
    }
  })
})

describe('canonical callback envelope', () => {
  const correlation = { sessionId: timing.instanceId, epoch: 0, commandId: timing.clockId }
  const complete = { requestId: timing.requestId, method: timing.method, droppedBefore: 0, state: 'complete', timing, correlation }
  const incomplete = { requestId: timing.requestId, method: timing.method, droppedBefore: 65535, state: 'incomplete', reason: 'absent' }
  it('accepts both variants, optional correlation and every missing-evidence reason', () => {
    expect(HelperTimingEventSchema.parse(complete)).toEqual(complete)
    for (const reason of ['absent', 'invalid', 'lost_response']) {
      expect(HelperTimingEventSchema.safeParse({ ...incomplete, reason }).success).toBe(true)
    }
    expect(HelperTimingEventSchema.safeParse({ ...complete, correlation: { sessionId: timing.instanceId, epoch: Number.MAX_SAFE_INTEGER } }).success).toBe(true)
  })
  it('requires all variant fields and rejects cross-variant/extra fields', () => {
    for (const event of [complete, incomplete]) {
      for (const key of Object.keys(event).filter(k => k !== 'correlation')) {
        const bad: Record<string, unknown> = { ...event }; delete bad[key]
        expect(HelperTimingEventSchema.safeParse(bad).success, key).toBe(false)
      }
      expect(HelperTimingEventSchema.safeParse({ ...event, content: 'forbidden' }).success).toBe(false)
    }
    for (const bad of [{ ...complete, reason: 'absent' }, { ...incomplete, timing }, { ...complete, state: 'other' }]) {
      expect(HelperTimingEventSchema.safeParse(bad).success).toBe(false)
    }
  })
  it('rejects invalid identities, mismatch, counters and correlation without coercion', () => {
    for (const bad of [
      ...['', 'a b', 'a'.repeat(257), true].map(requestId => ({ requestId })),
      { method: 'capture' }, { method: 'start' }, { requestId: 'other' },
      ...[-1, 65536, 0.5, true, '0', NaN, Infinity].map(droppedBefore => ({ droppedBefore })),
      ...[null, {}, { ...correlation, sessionId: 'bad' }, { ...correlation, commandId: 'bad' }, { ...correlation, extra: 1 },
        ...[-1, 0.5, true, '0', Infinity, Number.MAX_SAFE_INTEGER + 1].map(epoch => ({ ...correlation, epoch }))].map(correlation => ({ correlation })),
      { timing: { ...timing, spans: [{ ...span, durationUs: 1 }] } },
    ]) expect(HelperTimingEventSchema.safeParse({ ...complete, ...bad }).success).toBe(false)
  })
  it('parses detached data without weakening the readonly callback type', () => {
    const input = structuredClone(complete)
    const parsed: HelperTimingEvent = HelperTimingEventSchema.parse(input)
    input.correlation.epoch = 99; input.timing.spans[0].durationUs = 999
    expect(parsed.correlation?.epoch).toBe(0)
    if (parsed.state === 'complete') expect(parsed.timing.spans[0].durationUs).toBe(60)
  })
})
