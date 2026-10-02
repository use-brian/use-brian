import { PassiveObserverHealthSchema } from '@use-brian/computer-control/passive-observer.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { PassiveDesktopObserverHost, PASSIVE_DESKTOP_OBSERVER_LIMITS as L } from '../computer-control/observer-host.js'
import { NativeBrokerTrace, type NativeBrokerTraceEvent, type NativeTraceBinding } from '../computer-control/trace.js'
import type { HelperTimingEvent } from '@use-brian/computer-control/helper-timing.js'
import type { NativeIntegrationOptions } from '../native-computer-integration.js'
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
import { PrivatePipeHelper } from '../computer-control/helper-client.js'
const binding = (): NativeTraceBinding => ({ sessionId: randomUUID(), epoch: 1 })
const sourceId = randomUUID(), clockId = randomUUID()
const broker = (b: NativeTraceBinding, sequence = 1): NativeBrokerTraceEvent => ({ ...b, source: 'desktop_broker', sourceId, clockId, sequence, elapsedMs: sequence, incomplete: false, event: 'command_admission', outcome: 'admitted' })
const helper = (b?: NativeTraceBinding, n = 1): HelperTimingEvent => ({ requestId: `r${n}`, method: 'execute', droppedBefore: 0, ...(b ? { correlation: b } : {}), state: 'complete', timing: { version: 1, instanceId: sourceId, clockId, requestId: `r${n}`, method: 'execute', spans: [{ phase: 'observe_request', startUs: n * 10, endUs: n * 10 + 5, durationUs: 5, status: 'returned' }] } })
let h: PassiveDesktopObserverHost
beforeEach(() => { vi.useFakeTimers(); h = new PassiveDesktopObserverHost() })
afterEach(() => { h.dispose(); vi.useRealTimers(); vi.restoreAllMocks() })
const flush = () => vi.advanceTimersByTimeAsync(10)
describe('passive desktop attachment owner', () => {
  it('matches trusted constructor ports and real broker delivery, detached and immutable', async () => {
    const ports: Pick<NativeIntegrationOptions, 'observerFactory' | 'helperTimingObserver'> = h
    const b = binding(), original = { ...b }, sink = vi.fn(), factory = vi.fn((_binding: NativeTraceBinding) => sink)
    const a = await h.attachBrokerObserver(b, factory)
    const trace = NativeBrokerTrace.create(ports.observerFactory, b)!
    ;(b as { epoch: number }).epoch = 2 // registration and trace both own copies
    trace.record({ event: 'stop_requested', outcome: 'started' })
    expect(factory).not.toHaveBeenCalled(); await flush()
    expect(factory).toHaveBeenCalledWith(original); expect(Object.isFrozen(factory.mock.calls[0]![0])).toBe(true)
    expect(sink).toHaveBeenCalledOnce(); expect(sink.mock.calls[0]![0]).toMatchObject(original)
    expect(Object.isFrozen(sink.mock.calls[0]![0])).toBe(true)
    expect(a.health()).toEqual({ state: 'incomplete', reason: null, drain: 'not_observed' })
    a.detach(); trace.record({ event: 'local_gate_revoked', outcome: 'revoked' }); await flush(); expect(sink).toHaveBeenCalledOnce()
  })
  it('allows replacement only before source start; abort and late callbacks never retag', async () => {
    const b = binding(), old = vi.fn(), next = vi.fn(), abort = new AbortController()
    const a = await h.attachBrokerObserver(b, () => old, abort.signal); abort.abort()
    expect(a.health().reason).toBe('detached')
    const replacement = await h.attachBrokerObserver(b, () => next)
    const callback = await h.observerFactory(b); callback(broker(b)); replacement.detach()
    await expect(h.attachBrokerObserver(b, () => old)).rejects.toThrow()
    const other = { ...b, epoch: 2 }; await h.attachBrokerObserver(other, () => old)
    callback(broker(b, 2)); await flush(); expect(old).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled()
  })
  it('remembers unmatched starts and returns a noop without claiming trace absence', async () => {
    const b = binding(); expect(NativeBrokerTrace.create(h.observerFactory, b)).toBeDefined()
    const cb = await h.observerFactory(b); expect(typeof cb).toBe('function'); cb(broker(b))
    await expect(h.attachBrokerObserver(b, () => vi.fn())).rejects.toThrow()
    h.helperTimingObserver(helper(b)); await expect(h.attachHelperTimingObserver(b, vi.fn())).rejects.toThrow()
  })
  it('keeps helper scope/epoch separate, discards detached generations and copies nested spans', async () => {
    const b = binding(), c = { ...b, epoch: 2 }, one = vi.fn(), two = vi.fn()
    const a = await h.attachHelperTimingObserver(b, one); await h.attachHelperTimingObserver(c, two)
    const event = helper(b); h.helperTimingObserver(event)
    if (event.state === 'complete') (event.timing.spans[0] as { durationUs: number }).durationUs = 999
    expect(one).not.toHaveBeenCalled(); await flush()
    expect(one.mock.calls[0]![0].timing.spans[0].durationUs).toBe(5)
    expect(Object.isFrozen(one.mock.calls[0]![0].timing.spans[0])).toBe(true)
    a.detach(); h.helperTimingObserver(helper(b, 2)); h.helperTimingObserver(helper(c)); await flush()
    expect(one).toHaveBeenCalledOnce(); expect(two).toHaveBeenCalledOnce()
    await expect(h.attachHelperTimingObserver(b, one)).rejects.toThrow()
  })
  it('retains only saturated global uncorrelated/loss counts, never assigns discovery to a registration', async () => {
    const b = binding(), sink = vi.fn(); await h.attachHelperTimingObserver(b, sink)
    for (let i = 0; i < 65537; i++) h.helperTimingObserver({ requestId: 'private', method: 'listTargets', state: 'incomplete', reason: 'absent', droppedBefore: 65535 })
    await flush(); expect(sink).not.toHaveBeenCalled()
    expect(h.health()).toMatchObject({ uncorrelated: 65535, lost: 65535, scopeEvidence: 'missing', drain: 'not_observed' })
    expect(JSON.stringify(h.health())).not.toContain('private')
    h.helperTimingObserver(helper(b)); await flush(); expect(sink).toHaveBeenCalledOnce()
  })
  it.each(['gap', 'clock', 'source', 'scope', 'backwards', 'loss', 'missing'] as const)('closes broker on %s', async bad => {
    const b = binding(), a = await h.attachBrokerObserver(b, () => vi.fn()), cb = await h.observerFactory(b)
    cb(broker(b)); await flush()
    const e = { ...broker(b, 2), ...(bad === 'gap' ? { sequence: 3 } : bad === 'clock' ? { clockId: randomUUID() } : bad === 'source' ? { sourceId: randomUUID() } : bad === 'scope' ? { epoch: 2 } : bad === 'backwards' ? { elapsedMs: 0 } : bad === 'loss' ? { incomplete: true } : { source: undefined }) }
    cb(e as never); expect(a.health().reason).toBe(bad === 'loss' ? 'source_loss' : 'invalid_metadata')
  })
  it.each(['clock', 'source', 'backwards', 'duplicate', 'drop', 'absent', 'missing'] as const)('closes helper on %s', async bad => {
    const b = binding(), a = await h.attachHelperTimingObserver(b, vi.fn())
    h.helperTimingObserver(helper(b)); await flush()
    const e = helper(b, bad === 'duplicate' || bad === 'backwards' ? 1 : 2) as any
    if (bad === 'clock') e.timing.clockId = randomUUID()
    if (bad === 'source') e.timing.instanceId = randomUUID()
    if (bad === 'drop') e.droppedBefore = 1
    if (bad === 'absent') { e.state = 'incomplete'; e.reason = 'absent'; delete e.timing }
    if (bad === 'missing') delete e.timing.spans
    h.helperTimingObserver(e)
    expect(a.health().reason).toBe(['drop', 'absent'].includes(bad) ? 'source_loss' : 'invalid_metadata')
  })
  it.each(['getter', 'prototype', 'oversize', 'cycle', 'extra', 'array-getter'] as const)('rejects bounded descriptor hazards: %s', async bad => {
    const b = binding(), a = await h.attachBrokerObserver(b, () => vi.fn()), cb = await h.observerFactory(b), getter = vi.fn()
    const e: any = { ...broker(b) }
    if (bad === 'getter') Object.defineProperty(e, 'sequence', { enumerable: true, get: getter })
    if (bad === 'prototype') Object.setPrototypeOf(e, { private: true })
    if (bad === 'oversize') e.private = 'x'.repeat(10000)
    if (bad === 'cycle') e.private = e
    if (bad === 'extra') e.private = 'content'
    if (bad === 'array-getter') { e.private = []; Object.defineProperty(e.private, '0', { enumerable: true, get: getter }) }
    cb(e); expect(getter).not.toHaveBeenCalled(); expect(a.health().reason).toBe('invalid_metadata')
  })
  it('rejects malformed bindings without invoking accessors and records safely scoped invalid starts', async () => {
    const get = vi.fn(); const b = binding()
    await expect(h.attachBrokerObserver(Object.defineProperty({}, 'sessionId', { enumerable: true, get }) as never, () => vi.fn())).rejects.toThrow()
    expect(get).not.toHaveBeenCalled()
    for (const invalid of [{ ...b, epoch: 0 }, { ...b, extra: true }, { ...b, sessionId: 'no' }]) await expect(h.attachHelperTimingObserver(invalid, vi.fn())).rejects.toThrow()
    h.helperTimingObserver({ ...helper(b), private: true } as never)
    await expect(h.attachHelperTimingObserver(b, vi.fn())).rejects.toThrow()
  })
  it.each(['factory-reject', 'factory-hang', 'sink-reject', 'sink-hang'] as const)('bounds %s and discards late settlements', async failure => {
    const b = binding(), sink = vi.fn(); let resolve!: (v: typeof sink) => void
    const hanging = new Promise<typeof sink>(r => { resolve = r })
    const fail = () => failure.endsWith('reject') ? Promise.reject(new Error('private')) : hanging
    const a = await h.attachBrokerObserver(b, failure.startsWith('factory') ? fail : () => fail as never)
    const cb = await h.observerFactory(b); cb(broker(b)); await vi.advanceTimersByTimeAsync(L.callbackMs + 10)
    expect(a.health().reason).toBe(failure.endsWith('hang') ? 'timeout' : failure.startsWith('factory') ? 'factory_failed' : 'callback_failed')
    resolve(sink); cb(broker(b, 2)); await flush(); expect(sink).not.toHaveBeenCalled()
  })
  it('bounds queue, lifetime registration and unmatched start capacity', async () => {
    const b = binding(), a = await h.attachBrokerObserver(b, () => vi.fn()), cb = await h.observerFactory(b)
    for (let i = 1; i <= L.queueEvents + 1; i++) cb(broker(b, i))
    expect(a.health().reason).toBe('capacity')
    for (let i = 1; i < L.registrations; i++) (await h.attachHelperTimingObserver(binding(), vi.fn())).detach()
    await expect(h.attachHelperTimingObserver(binding(), vi.fn())).rejects.toThrow(); expect(h.health().reason).toBe('capacity')
    h.dispose(); h = new PassiveDesktopObserverHost()
    for (let i = 0; i <= L.startedBindings; i++) h.observerFactory(binding())
    expect(h.health().reason).toBe('capacity')
  })
  it('bounds total broker events even when the queue is always drained', async () => {
    const b = binding(), sink = vi.fn(), a = await h.attachBrokerObserver(b, () => sink), cb = await h.observerFactory(b)
    for (let i = 1; i <= L.events; i++) { cb(broker(b, i)); await flush() }
    expect(sink).toHaveBeenCalledTimes(L.events)
    cb(broker(b, L.events + 1)); expect(a.health().reason).toBe('capacity')
  })
  it('bounds helper total bytes independently of total events and queue size', async () => {
    const b = binding(), sink = vi.fn(), a = await h.attachHelperTimingObserver(b, sink)
    for (let i = 1; i <= L.events && a.health().reason === null; i++) {
      const e = helper(b, i) as any
      e.requestId = `${i}_${'x'.repeat(240)}`; e.timing.requestId = e.requestId
      h.helperTimingObserver(e); await flush()
    }
    expect(a.health().reason).toBe('capacity'); expect(sink.mock.calls.length).toBeLessThan(L.events)
    expect(sink.mock.calls.length).toBeGreaterThan(L.queueEvents)
  })
  it('bounds helper queue and prevents started-binding reattachment after overflow', async () => {
    const b = binding(), sink = vi.fn(), a = await h.attachHelperTimingObserver(b, sink)
    for (let i = 1; i <= L.queueEvents + 1; i++) h.helperTimingObserver(helper(b, i))
    expect(a.health().reason).toBe('capacity'); await flush(); expect(sink).not.toHaveBeenCalled()
    await expect(h.attachHelperTimingObserver(b, sink)).rejects.toThrow()
  })
  it('rejects repeated broker starts without redirecting the original callback', async () => {
    const b = binding(), sink = vi.fn(); await h.attachBrokerObserver(b, () => sink)
    const first = await h.observerFactory(b), second = await h.observerFactory(b)
    second(broker(b)); await flush(); expect(sink).not.toHaveBeenCalled()
    first(broker(b)); await flush(); expect(sink).toHaveBeenCalledOnce()
  })
  it('rejects nested helper getters/prototypes/oversize without content retention or callback access', async () => {
    const b = binding(), sink = vi.fn(), getter = vi.fn(); await h.attachHelperTimingObserver(b, sink)
    const e = helper(b) as any
    Object.defineProperty(e.timing.spans[0], 'durationUs', { enumerable: true, get: getter })
    h.helperTimingObserver(e)
    const proto = helper(b) as any; Object.setPrototypeOf(proto.timing, { private: true }); h.helperTimingObserver(proto)
    h.helperTimingObserver({ ...helper(b), requestId: 'private'.repeat(1000) })
    await flush(); expect(getter).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
    expect(h.health().lost).toBe(3); expect(JSON.stringify(h.health())).not.toContain('private')
  })
  it('expires idle registrations and the owner and denies late source callbacks', async () => {
    const b = binding(), sink = vi.fn(), a = await h.attachHelperTimingObserver(b, sink)
    await vi.advanceTimersByTimeAsync(L.registrationMs); expect(a.health().reason).toBe('expired')
    h.helperTimingObserver(helper(b)); await expect(h.attachHelperTimingObserver(b, sink)).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(L.lifetimeMs); expect(h.health().reason).toBe('expired'); expect(sink).not.toHaveBeenCalled()
  })
})

it('real PrivatePipeHelper callback path keeps discovery global and captured command scope immutable (synthetic pipe, no OS launch)', async () => {
  vi.useRealTimers()
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  let request!: { id: string; method: string }
  const child = Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(chunk: Buffer, _, done) { request = JSON.parse(chunk.subarray(4).toString()); done() } }), kill: () => { queueMicrotask(() => child.emit('exit', null)); return true } })
  mocked.spawn.mockReturnValue(child)
  const peer = new PrivatePipeHelper('/synthetic/helper', () => {}, 4000, { enabled: true, onMetadata: h.helperTimingObserver })
  const b = binding(), sink = vi.fn(); await h.attachHelperTimingObserver(b, sink)
  const tick = () => new Promise<void>(r => setTimeout(r, 15))
  function respond(result: unknown, diagnostics?: unknown, extra = {}) {
    const body = Buffer.from(JSON.stringify({ id: request.id, ok: true, result, diagnostics, ...extra })), header = Buffer.alloc(4)
    header.writeUInt32BE(body.length); child.stdout.write(Buffer.concat([header, body]))
  }
  try {
    const cap = peer.capabilities(); respond({ protocol: 'native-computer-v1', platform: 'darwin', axRead: true, semanticActions: true, windowCapture: false, input: false, accessibilityPermission: 'granted', capturePermission: 'denied', limitations: [] }, undefined, { diagnosticsVersion: 1 }); await cap; await tick()
    const discovery = peer.listTargets(); respond([]); await discovery; await tick()
    expect(sink).not.toHaveBeenCalled(); expect(h.health().uncorrelated).toBeGreaterThan(0)
    const command = { protocol: 'native-computer-v1' as const, identity: { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'device', sessionId: b.sessionId, conversationId: 'c', taskId: 't' }, grantId: 'g', epoch: b.epoch, commandId: randomUUID(), deadlineAt: Date.now() + 1000, action: { kind: 'observe' as const, target: { appId: 'editor', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' } } }
    const pending = peer.execute(command, 'lease'); command.identity.sessionId = randomUUID(); command.epoch = 9
    const e = helper(b); if (e.state !== 'complete') throw new Error()
    respond({ commandId: command.commandId, outcome: 'executed', code: 'ok' }, { ...e.timing, requestId: request.id, method: request.method })
    await pending; await tick(); await tick()
    expect(sink).toHaveBeenCalledOnce(); expect(sink.mock.calls[0]![0].correlation).toMatchObject(b)
  } finally { await peer.kill(); Object.defineProperty(process, 'platform', platform) }
})

 it('attachment loss uses the shared strict contract, not aggregate owner diagnostics', async () => {
  const b = binding(), a = await h.attachBrokerObserver(b, () => vi.fn())
  const source = await h.observerFactory(b)
  source(broker(b)); await flush()
  source({ ...broker(b, 2), incomplete: true })
  expect(PassiveObserverHealthSchema.parse(a.health())).toEqual({ state: 'incomplete', reason: 'source_loss', drain: 'not_observed' })
  expect(PassiveObserverHealthSchema.safeParse(h.health()).success).toBe(false)
 })
