import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeRunTrace, type NativeTraceEvent } from '@use-brian/core'
import { PassiveNativeObserverHost, PASSIVE_OBSERVER_LIMITS as L } from './observer-host.js'
import type { PassiveHost } from '../../../../scripts/native-computer-eval/main-driver.js'

const binding = { sessionId: '00000000-0000-4000-8000-000000000001', epoch: 1 }
let hosts: PassiveNativeObserverHost[]
beforeEach(() => { vi.useFakeTimers(); hosts = [] })
afterEach(() => { hosts.forEach(h => h.dispose()); vi.useRealTimers() })
function host() { const h = new PassiveNativeObserverHost(); hosts.push(h); return h }
function event(sequence = 1): NativeTraceEvent {
  const trace = new NativeRunTrace(); trace.startRun()
  return { ...trace.snapshot().events[0]!, sequence }
}
async function tick() { await vi.advanceTimersByTimeAsync(10) }

it('is structurally PassiveHost compatible; unmatched starts stay default-off and cannot attach late', async () => {
  const h = host(), compatible: PassiveHost = h
  expect(compatible).toBe(h)
  expect(h.nativeComputerObserverFactory(binding)).toBeUndefined()
  await expect(h.attachObserver(binding, vi.fn())).rejects.toThrow('unavailable')
})
it('copies exact binding; duplicate, wrong scope and consumed registration never rebind', async () => {
  const h = host(), sink = vi.fn(), factory = vi.fn((_binding: typeof binding) => sink), mutable = { ...binding }
  const a = await h.attachObserver(mutable, factory)
  mutable.epoch = 99
  await expect(h.attachObserver(binding, factory)).rejects.toThrow()
  expect(h.nativeComputerObserverFactory({ ...binding, epoch: 2 })).toBeUndefined()
  expect(h.nativeComputerObserverFactory({ ...binding, sessionId: '00000000-0000-4000-8000-000000000002' })).toBeUndefined()
  const source = h.nativeComputerObserverFactory(binding)!
  expect(h.nativeComputerObserverFactory(binding)).toBeUndefined()
  source(event())
  expect(factory).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
  await tick()
  expect(factory).toHaveBeenCalledExactlyOnceWith(binding)
  expect(Object.isFrozen(factory.mock.calls[0]![0])).toBe(true)
  expect(sink).toHaveBeenCalledTimes(1)
  a.detach(); source(event(2)); await tick()
  await expect(h.attachObserver(binding, factory)).rejects.toThrow()
  expect(sink).toHaveBeenCalledTimes(1)
  expect(a.health()).toEqual({ state: 'incomplete', reason: 'detached', drain: 'not_observed' })
})
it('explicit detach closes generation and old handles/callbacks cannot touch a new epoch', async () => {
  const h = host(), old = vi.fn(), fresh = vi.fn()
  const a = await h.attachObserver(binding, () => old)
  const source = h.nativeComputerObserverFactory(binding)!
  a.detach()
  const next = { ...binding, epoch: 2 }
  await h.attachObserver(next, () => fresh)
  const newer = h.nativeComputerObserverFactory(next)!
  source(event()); newer(event()); a.detach()
  await tick()
  expect(old).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledTimes(1)
})
it('allows replacement only before start and old detach/abort cannot close replacement', async () => {
  const h = host(), controller = new AbortController(), sink = vi.fn()
  const old = await h.attachObserver(binding, vi.fn(), controller.signal)
  old.detach()
  await h.attachObserver(binding, () => sink)
  old.detach(); controller.abort()
  h.nativeComputerObserverFactory(binding)!(event()); await tick()
  expect(sink).toHaveBeenCalledTimes(1)
})
it('copies and freezes canonical events before detached delivery', async () => {
  const h = host(), sink = vi.fn()
  await h.attachObserver(binding, () => sink)
  const original = event()
  h.nativeComputerObserverFactory(binding)!(original)
  ;(original as { outcome: string }).outcome = 'private'
  await tick()
  expect(sink.mock.calls[0]![0].outcome).toBe('started')
  expect(Object.isFrozen(sink.mock.calls[0]![0])).toBe(true)
})
it.each(['extra', 'getter', 'oversize', 'nested', 'wrong-run', 'gap'] as const)('rejects %s metadata without sink delivery', async kind => {
  const h = host(), sink = vi.fn(), getter = vi.fn(() => 'private')
  const a = await h.attachObserver(binding, () => sink)
  const source = h.nativeComputerObserverFactory(binding)!
  const e = { ...event() } as Record<string, unknown>
  if (kind === 'extra') e.secret = 'private'
  if (kind === 'getter') Object.defineProperty(e, 'outcome', { get: getter, enumerable: true })
  if (kind === 'oversize') e.runId = 'x'.repeat(10000)
  if (kind === 'nested') e.inference = { usage: { deeper: { deeper: {} } } }
  if (kind === 'gap') e.sequence = 2
  if (kind === 'wrong-run') { source(event()); e.sequence = 2 }
  source(e as NativeTraceEvent); await tick()
  expect(getter).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
  expect(a.health().reason).toBe('invalid_metadata')
})
it('rejects binding extras/accessors/unsafe epochs and pre-aborted attachment', async () => {
  const h = host(), getter = vi.fn(() => 1)
  await expect(h.attachObserver({ ...binding, epoch: Number.MAX_SAFE_INTEGER + 1 }, vi.fn())).rejects.toThrow()
  await expect(h.attachObserver({ ...binding, extra: true } as typeof binding, vi.fn())).rejects.toThrow()
  await expect(h.attachObserver({ sessionId: binding.sessionId, get epoch() { return getter() } }, vi.fn())).rejects.toThrow()
  await expect(h.attachObserver(binding, vi.fn(), AbortSignal.abort())).rejects.toThrow()
  expect(getter).not.toHaveBeenCalled()
})
it('saturates a bounded queue conservatively without invoking the factory inline', async () => {
  const h = host(), factory = vi.fn(() => vi.fn()), a = await h.attachObserver(binding, factory)
  const source = h.nativeComputerObserverFactory(binding)!, e = event()
  for (let sequence = 1; sequence <= L.queueEvents + 1; sequence++) source({ ...e, sequence })
  expect(a.health().reason).toBe('capacity')
  await tick(); expect(factory).not.toHaveBeenCalled()
})
it.each(['factory', 'sink'] as const)('times out hung %s and discards late completion', async stage => {
  const h = host(), sink = vi.fn(), late = vi.fn()
  let resolve!: (value: typeof sink) => void
  const hung = new Promise<typeof sink>(r => { resolve = r })
  const factory = stage === 'factory' ? () => hung : () => () => hung.then(() => undefined)
  const a = await h.attachObserver(binding, factory), source = h.nativeComputerObserverFactory(binding)!
  source(event()); await vi.advanceTimersByTimeAsync(L.callbackMs + 10)
  expect(a.health().reason).toBe('timeout')
  resolve(late); await tick(); source(event(2)); await tick()
  expect(late).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
})
it.each(['factory', 'sink'] as const)('contains rejected %s', async stage => {
  const h = host(), reject = () => Promise.reject(new Error('private'))
  const a = await h.attachObserver(binding, stage === 'factory' ? reject : () => reject)
  h.nativeComputerObserverFactory(binding)!(event()); await tick()
  expect(a.health().reason).toBe(stage === 'factory' ? 'factory_failed' : 'callback_failed')
})
it('abort during pending factory discards late sink forever', async () => {
  const h = host(), c = new AbortController(), sink = vi.fn()
  let resolve!: (value: typeof sink) => void
  const a = await h.attachObserver(binding, () => new Promise(r => { resolve = r }), c.signal)
  const source = h.nativeComputerObserverFactory(binding)!
  source(event()); await tick(); c.abort(); resolve(sink); await tick()
  source(event(2)); await tick()
  expect(sink).not.toHaveBeenCalled(); expect(a.health().reason).toBe('detached')
})
it('expires registrations and the whole owner without dropping late-start tombstones', async () => {
  const h = host(), sink = vi.fn(), a = await h.attachObserver(binding, () => sink)
  const source = h.nativeComputerObserverFactory(binding)!
  await vi.advanceTimersByTimeAsync(L.registrationMs)
  source(event()); expect(a.health().reason).toBe('expired')
  await expect(h.attachObserver(binding, () => sink)).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(L.lifetimeMs)
  expect(h.health().reason).toBe('expired')
  expect(h.nativeComputerObserverFactory({ ...binding, epoch: 2 })).toBeUndefined()
  await expect(h.attachObserver({ ...binding, epoch: 2 }, () => sink)).rejects.toThrow()
})
it('bounds cumulative registrations including detached generations', async () => {
  const h = host()
  for (let i = 0; i < L.registrations; i++) (await h.attachObserver(binding, vi.fn())).detach()
  await expect(h.attachObserver(binding, vi.fn())).rejects.toThrow()
  expect(h.health().reason).toBe('capacity')
})
it('fails closed when unmatched started-binding history fills, without throwing into execution', async () => {
  const h = host(), factory = vi.fn(), a = await h.attachObserver(binding, factory)
  for (let epoch = 2; epoch <= L.startedBindings + 2; epoch++) expect(h.nativeComputerObserverFactory({ ...binding, epoch })).toBeUndefined()
  expect(h.nativeComputerObserverFactory(binding)).toBeUndefined()
  expect(h.health().reason).toBe('capacity'); expect(a.health().reason).toBe('capacity')
  await tick(); expect(factory).not.toHaveBeenCalled()
})

function inferenceEvent(start: NativeTraceEvent, sequence: number): NativeTraceEvent {
  return { ...start, sequence, kind: 'inference-update', scope: 'adapter-lifecycle', phase: 'generation', step: 0, atMs: null,
    inference: { attemptId: binding.sessionId, invocationState: 'pending', interrupted: false,
      requestedModel: 'm'.repeat(200), model: 'm'.repeat(200), providerKind: 'openai', lane: 'text', outcome: 'pending',
      operation: 'plan', stage: 'direct', perceptionPath: 'ax', fallbackReason: null, disposition: null,
      durationMs: null, usage: { inputTokens: 1, outputTokens: 0 }, incurredCostUsd: null, estimatedBilledCostUsd: null, providerKeySource: 'user' } }
}
it('copies nested canonical inference metadata, not mutable producer references', async () => {
  const h = host(), sink = vi.fn()
  await h.attachObserver(binding, () => sink)
  const source = h.nativeComputerObserverFactory(binding)!, start = event(), update = inferenceEvent(start, 2)
  source(start); source(update)
  update.inference!.usage!.inputTokens = 99
  await tick()
  const received = sink.mock.calls[1]![0]
  expect(received.inference.usage.inputTokens).toBe(1)
  expect(Object.isFrozen(received.inference)).toBe(true)
  expect(Object.isFrozen(received.inference.usage)).toBe(true)
})
it('bounds total accepted event count even when the queue is continuously consumed', async () => {
  const h = host(), sink = vi.fn(), a = await h.attachObserver(binding, () => sink)
  const source = h.nativeComputerObserverFactory(binding)!, start = event()
  for (let sequence = 1; sequence <= L.events + 1; sequence++) { source({ ...start, sequence }); await tick() }
  expect(a.health().reason).toBe('capacity')
  expect(sink.mock.calls.length).toBeLessThanOrEqual(L.events)
})
it('bounds total metadata bytes before the event quota for larger canonical events', async () => {
  const h = host(), sink = vi.fn(), a = await h.attachObserver(binding, () => sink)
  const source = h.nativeComputerObserverFactory(binding)!, start = event()
  source(start); await tick()
  for (let sequence = 2; sequence <= L.events; sequence++) {
    source(inferenceEvent(start, sequence)); await tick()
    if (a.health().reason) break
  }
  expect(a.health().reason).toBe('capacity')
  expect(sink.mock.calls.length).toBeLessThan(L.events)
})
it('detaches a pending sink wait; old rejection cannot close a new generation', async () => {
  const h = host(), fresh = vi.fn()
  let reject!: (reason: Error) => void
  const a = await h.attachObserver(binding, () => () => new Promise<void>((_, r) => { reject = r }))
  const old = h.nativeComputerObserverFactory(binding)!
  old(event()); await tick(); a.detach()
  const next = { ...binding, epoch: 2 }
  const b = await h.attachObserver(next, () => fresh)
  h.nativeComputerObserverFactory(next)!(event())
  reject(new Error('private')); old(event(2)); await tick()
  expect(a.health().reason).toBe('detached'); expect(b.health().reason).toBeNull()
  expect(fresh).toHaveBeenCalledTimes(1)
})

it.each(['health', 'producer', 'start', 'delivery'] as const)('enforces wall-clock registration expiry before timer dispatch: %s', async stage => {
  const h = host(), sink = vi.fn(), factory = vi.fn(() => sink)
  const a = await h.attachObserver(binding, factory)
  const source = stage === 'start' ? undefined : h.nativeComputerObserverFactory(binding)!
  if (stage === 'delivery') source!(event())
  vi.setSystemTime(Date.now() + L.registrationMs)
  if (stage === 'producer') source!(event())
  if (stage === 'start') expect(h.nativeComputerObserverFactory(binding)).toBeUndefined()
  if (stage === 'delivery') await tick()
  expect(a.health()).toEqual({ state: 'incomplete', reason: 'expired', drain: 'not_observed' })
  await tick(); expect(factory).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
})
