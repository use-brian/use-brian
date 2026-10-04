import { describe, expect, it } from 'vitest'
import { NativeBrokerTraceEventSchema, NativeTraceMetadataSchema } from '../broker-trace.ts'
const uuid = '12345678-1234-4234-8234-123456789012'
const event = { source: 'desktop_broker', sourceId: uuid, clockId: uuid, sessionId: uuid, epoch: 1, sequence: 1, elapsedMs: 0.25, incomplete: false,
  event: 'helper_rpc_wait', outcome: 'resolved', operation: 'execute', durationMs: 0.125, command: { commandId: uuid, actionKind: 'observe' } }
describe('canonical broker source envelope', () => {
  it('accepts every existing event/outcome without inventing OS delivery or clock alignment evidence', () => {
    for (const name of NativeTraceMetadataSchema.shape.event.options) for (const outcome of NativeTraceMetadataSchema.shape.outcome.options) {
      expect(NativeBrokerTraceEventSchema.parse({ ...event, event: name, outcome })).toEqual({ ...event, event: name, outcome })
    }
    expect(NativeBrokerTraceEventSchema.safeParse({ ...event, command: undefined, operation: undefined, durationMs: undefined }).success).toBe(true)
  })
  it('allows visual invocation metadata without capturing its point or binding', () => {
    const command = { commandId: uuid, actionKind: 'visualInvoke' }
    expect(NativeBrokerTraceEventSchema.parse({ ...event, command }).command).toEqual(command)
    for (const key of ['x', 'y', 'frameId', 'bindingId', 'ref', 'target']) {
      expect(NativeBrokerTraceEventSchema.safeParse({ ...event, command: { ...command, [key]: 'private' } }).success).toBe(false)
    }
  })
  it('requires the full source, scope, sequence and clock envelope', () => {
    for (const key of ['source', 'sourceId', 'clockId', 'sessionId', 'epoch', 'sequence', 'elapsedMs', 'incomplete', 'event', 'outcome']) {
      const missing = { ...event } as Record<string, unknown>; delete missing[key]
      expect(NativeBrokerTraceEventSchema.safeParse(missing).success).toBe(false)
    }
    for (const key of ['sourceId', 'clockId', 'sessionId']) expect(NativeBrokerTraceEventSchema.safeParse({ ...event, [key]: 'private-identity' }).success).toBe(false)
  })
  it('rejects content, unknown fields/enums and false physical/delivery/drain claims', () => {
    for (const key of ['label', 'target', 'ref', 'goal', 'text', 'frame', 'token', 'error', 'hash', 'auth']) {
      expect(NativeBrokerTraceEventSchema.safeParse({ ...event, [key]: 'secret' }).success).toBe(false)
      expect(NativeBrokerTraceEventSchema.safeParse({ ...event, command: { ...event.command, [key]: 'secret' } }).success).toBe(false)
    }
    for (const patch of [{ source: 'os' }, { event: 'physical_activation' }, { event: 'fixture_drain' }, { outcome: 'delivered' }, { operation: 'os_dispatch' }, { command: { ...event.command, actionKind: 'shell' } }]) expect(NativeBrokerTraceEventSchema.safeParse({ ...event, ...patch }).success).toBe(false)
  })
  it('bounds numeric metadata without coercion, allowing fractional monotonic milliseconds', () => {
    for (const key of ['epoch', 'sequence', 'elapsedMs', 'durationMs']) for (const value of [NaN, Infinity, -1, true, '1', Number.MAX_SAFE_INTEGER + 1]) expect(NativeBrokerTraceEventSchema.safeParse({ ...event, [key]: value }).success).toBe(false)
    for (const key of ['epoch', 'sequence']) for (const value of [0, 0.5]) expect(NativeBrokerTraceEventSchema.safeParse({ ...event, [key]: value }).success).toBe(false)
    expect(NativeBrokerTraceEventSchema.safeParse({ ...event, incomplete: 'false' }).success).toBe(false)
  })
})
