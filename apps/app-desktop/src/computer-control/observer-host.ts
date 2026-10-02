import { passiveObserverHealth, type PassiveObserverHealth, type PassiveObserverReason as Reason } from '@use-brian/computer-control/passive-observer.js'
export type { PassiveObserverHealth } from '@use-brian/computer-control/passive-observer.js'
import { NativeTraceBindingSchema, NativeBrokerTraceEventSchema, type NativeTraceBinding, type NativeBrokerTraceEvent, type NativeBrokerObserverFactory } from './trace.js'
import { HelperTimingCorrelationSchema, HelperTimingEventSchema, type HelperTimingEvent } from '@use-brian/computer-control/helper-timing.js'
import type { HelperTimingOptions } from './helper-client.js'

/** Deliberately fixed, process-local evidence limits, not execution limits. */
export const PASSIVE_DESKTOP_OBSERVER_LIMITS = Object.freeze({
  registrations: 32, startedBindings: 128, queueEvents: 16, queueBytes: 32_768,
  events: 512, bytes: 262_144, eventBytes: 4096, callbackMs: 100,
  registrationMs: 60_000, lifetimeMs: 300_000,
})
type Kind = 'broker' | 'helper'
type Event = NativeBrokerTraceEvent | HelperTimingEvent
type Sink = (event: Event) => void | Promise<void>
type SinkFactory = (binding: NativeTraceBinding) => Sink | Promise<Sink>
export type PassiveObserverAttachment = Readonly<{ detach(): void; health(): PassiveObserverHealth }>
export type PassiveDesktopObserverHealth = PassiveObserverHealth & Readonly<{
  /** Saturated counts only, never content or evidence assigned to a scope. */
  uncorrelated: number; lost: number; scopeEvidence: 'missing'
}>

/** Copy data descriptors before schema parsing: no getters, extras via prototype,
 * non-span arrays, cycles, or unbounded strings/depth. Reflection on a Proxy can itself run
 * JS: this is NOT a sandbox for hostile proxies or synchronous blocking code. */
function copyData(input: unknown): unknown {
  let nodes = 0, chars = 0
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 96 || depth > 5) throw new Error()
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || value === undefined) return value
    if (typeof value === 'string') {
      chars += value.length
      if (value.length > 256 || chars > 2048) throw new Error()
      return value
    }
    if (typeof value !== 'object') throw new Error()
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 2 || Reflect.ownKeys(value).length !== value.length + 1) throw new Error()
      const items: unknown[] = []
      for (let i = 0; i < value.length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, String(i))
        if (!d || !('value' in d) || !d.enumerable) throw new Error()
        items.push(copy(d.value, depth + 1))
      }
      return Object.freeze(items)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error()
    const keys = Reflect.ownKeys(value)
    if (keys.length > 32) throw new Error()
    const result = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 40) throw new Error()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error()
      result[key] = copy(descriptor.value, depth + 1)
    }
    return Object.freeze(result)
  }
  return copy(input, 0)
}
function bindingCopy(input: unknown): NativeTraceBinding {
  return Object.freeze(NativeTraceBindingSchema.parse(copyData(input)))
}
function key(binding: NativeTraceBinding): string { return `${binding.sessionId}:${binding.epoch}` }
function timer(callback: () => void, ms: number) {
  const handle = setTimeout(callback, ms)
  handle.unref?.()
  return handle
}
type Registration = {
  kind: Kind; binding: NativeTraceBinding; expiresAt: number; factory?: SinkFactory; sink?: Sink
  closed: boolean; started: boolean; busy: boolean; reason: Reason | null
  queue: { event: Event; bytes: number }[]; queuedBytes: number; events: number; bytes: number
  sourceId?: string; clockId?: string; sequence: number; lastTime: number; requests: Set<string>
  expiry?: ReturnType<typeof setTimeout>; scheduled?: ReturnType<typeof setTimeout>
  cancelWait?: () => void; removeAbort?: () => void
}

/** Trusted in-process desktop attachment owner; inject observerFactory and
 * helperTimingObserver explicitly into NativeIntegrationOptions. Default absent.
 * No bootstrap, execution, helper launch or Stop authority. Installed broker
 * ports DO create broker traces even when unmatched (a noop callback is required).
 * Factories/sinks run on detached timers, never inline with producers or Stop.
 * Trusted synchronous JS and Proxy traps cannot be preempted. Cancellation only
 * abandons our wait. All evidence stays incomplete; no drain/publication claim.
 * Do not rotate spent owners to recover tails of already-started streams. */
export class PassiveDesktopObserverHost {
  private readonly registrations = new Map<string, Registration>()
  private readonly started = new Set<string>()
  private used = 0
  private uncorrelated = 0
  private lost = 0
  private closed: Reason | null = null
  private readonly expiresAt = Date.now() + PASSIVE_DESKTOP_OBSERVER_LIMITS.lifetimeMs
  private readonly lifetime = timer(() => this.close('expired'), PASSIVE_DESKTOP_OBSERVER_LIMITS.lifetimeMs)

  private live(): boolean {
    if (!this.closed && Date.now() >= this.expiresAt) this.close('expired')
    return !this.closed
  }
  health(): PassiveDesktopObserverHealth { this.live(); return Object.freeze({ ...passiveObserverHealth(this.closed), uncorrelated: this.uncorrelated, lost: this.lost, scopeEvidence: 'missing' as const }) }
  private close(reason: Reason): void {
    if (this.closed) return
    this.closed = reason
    clearTimeout(this.lifetime)
    for (const registration of this.registrations.values()) this.end(registration, reason)
    this.started.clear()
  }
  dispose(): void { this.close('detached') }
  private end(r: Registration, reason: Reason): void {
    if (r.closed) return
    r.closed = true; r.reason = reason
    clearTimeout(r.expiry); clearTimeout(r.scheduled)
    r.cancelWait?.(); r.removeAbort?.()
    r.cancelWait = undefined; r.removeAbort = undefined
    r.factory = undefined; r.sink = undefined; r.queue.length = 0; r.queuedBytes = 0; r.requests.clear()
    if (this.registrations.get(`${r.kind}:${key(r.binding)}`) === r) this.registrations.delete(`${r.kind}:${key(r.binding)}`)
  }

  attachBrokerObserver(binding: NativeTraceBinding, factory: NativeBrokerObserverFactory, signal?: AbortSignal): Promise<PassiveObserverAttachment> {
    return this.attach('broker', binding, factory as SinkFactory, undefined, signal)
  }
  attachHelperTimingObserver(binding: NativeTraceBinding, callback: HelperTimingOptions['onMetadata'], signal?: AbortSignal): Promise<PassiveObserverAttachment> {
    return this.attach('helper', binding, undefined, callback as Sink, signal)
  }
  private async attach(kind: Kind, binding: NativeTraceBinding, factory?: SinkFactory, sink?: Sink, signal?: AbortSignal): Promise<PassiveObserverAttachment> {
    const safe = bindingCopy(binding), id = `${kind}:${key(safe)}`
    if (!this.live() || signal?.aborted || typeof (factory ?? sink) !== 'function' || this.started.has(id) || this.registrations.has(id)) throw new Error('Passive observer attachment unavailable')
    if (this.used >= PASSIVE_DESKTOP_OBSERVER_LIMITS.registrations) {
      this.close('capacity'); throw new Error('Passive observer attachment unavailable')
    }
    this.used++
    const r: Registration = { kind, binding: safe, expiresAt: Date.now() + PASSIVE_DESKTOP_OBSERVER_LIMITS.registrationMs, factory, sink, lastTime: 0, requests: new Set(), closed: false, started: false, busy: false, reason: null, queue: [], queuedBytes: 0, events: 0, bytes: 0, sequence: 0 }
    this.registrations.set(id, r)
    r.expiry = timer(() => this.end(r, 'expired'), PASSIVE_DESKTOP_OBSERVER_LIMITS.registrationMs)
    const detach = () => this.end(r, 'detached')
    if (signal) {
      signal.addEventListener('abort', detach, { once: true })
      r.removeAbort = () => signal.removeEventListener('abort', detach)
      if (signal.aborted) detach()
    }
    return Object.freeze({ detach, health: () => { this.active(r); return passiveObserverHealth(r.reason) } })
  }

  private start(kind: Kind, binding: NativeTraceBinding): Registration | undefined {
    if (!this.live()) return
    const id = `${kind}:${key(binding)}`
    if (this.started.has(id)) return
    if (this.started.size >= PASSIVE_DESKTOP_OBSERVER_LIMITS.startedBindings) { this.close('capacity'); return }
    this.started.add(id)
    const r = this.registrations.get(id)
    if (!r || !this.active(r)) return
    r.started = true
    return r
  }
  private active(r: Registration): boolean {
    if (!r.closed && Date.now() >= r.expiresAt) this.end(r, 'expired')
    return !r.closed && this.live()
  }
  readonly observerFactory: NativeBrokerObserverFactory = binding => {
    let safe: NativeTraceBinding
    try { safe = bindingCopy(binding) } catch { return () => {} }
    const r = this.start('broker', safe)
    if (!r) return () => {}
    this.schedule(r)
    return event => {
      if (!this.active(r)) return
      try {
        const parsed = NativeBrokerTraceEventSchema.parse(copyData(event))
        if (key(parsed) !== key(r.binding) || parsed.sequence !== r.sequence + 1
          || (r.sourceId && (r.sourceId !== parsed.sourceId || r.clockId !== parsed.clockId))
          || parsed.elapsedMs < r.lastTime) throw new Error()
        if (parsed.incomplete || parsed.event === 'trace_incomplete') { this.end(r, 'source_loss'); return }
        r.sourceId = parsed.sourceId; r.clockId = parsed.clockId; r.sequence = parsed.sequence; r.lastTime = parsed.elapsedMs
        this.enqueue(r, parsed)
      } catch { this.end(r, 'invalid_metadata') }
    }
  }
  /** Correlation is captured by the existing helper request, never inferred from
   * an active registration. Discovery/capabilities without scope are counts only.
   * Global invalid/loss counts cannot be assigned to any particular collection. */
  readonly helperTimingObserver: HelperTimingOptions['onMetadata'] = event => {
    if (!this.live()) return
    let binding: NativeTraceBinding | undefined
    try {
      // Copy scope independently first: an oversized or accessor-bearing timing
      // must not permit a later attachment to capture only this scope's tail.
      const descriptor = event && typeof event === 'object' ? Object.getOwnPropertyDescriptor(event, 'correlation') : undefined
      if (descriptor) {
        if (!('value' in descriptor) || !descriptor.enumerable) throw new Error()
        if (descriptor.value !== undefined) {
          const correlation = HelperTimingCorrelationSchema.parse(copyData(descriptor.value))
          binding = bindingCopy({ sessionId: correlation.sessionId, epoch: correlation.epoch })
        }
      }
    } catch { this.lost = Math.min(65535, this.lost + 1); return }
    // Remember a safely copied scope even when the rest of its envelope is bad.
    const existing = binding ? this.registrations.get(`helper:${key(binding)}`) : undefined
    const r = binding ? (existing?.started ? existing : this.start('helper', binding)) : undefined
    let parsed: HelperTimingEvent
    try {
      parsed = HelperTimingEventSchema.parse(copyData(event))
      if (binding ? !parsed.correlation || key(parsed.correlation) !== key(binding) : parsed.correlation !== undefined) throw new Error()
    }
    catch { this.lost = Math.min(65535, this.lost + 1); if (r) this.end(r, 'invalid_metadata'); return }
    if (!binding) {
      this.uncorrelated = Math.min(65535, this.uncorrelated + 1)
      this.lost = Math.min(65535, this.lost + parsed.droppedBefore + Number(parsed.state === 'incomplete'))
      return
    }
    if (!r || !this.active(r)) return
    if (parsed.droppedBefore || parsed.state === 'incomplete') { this.end(r, 'source_loss'); return }
    const timing = parsed.timing, span = timing.spans[0]!
    if ((r.sourceId && (r.sourceId !== timing.instanceId || r.clockId !== timing.clockId))
      || span.startUs < r.lastTime || r.requests.has(parsed.requestId)) { this.end(r, 'invalid_metadata'); return }
    r.sourceId = timing.instanceId; r.clockId = timing.clockId; r.lastTime = span.endUs
    // Lifetime event quota bounds this history, including failed/closed streams.
    if (r.requests.size >= PASSIVE_DESKTOP_OBSERVER_LIMITS.events) { this.end(r, 'capacity'); return }
    r.requests.add(parsed.requestId)
    this.enqueue(r, parsed)
  }
  private enqueue(r: Registration, event: Event): void {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (bytes > PASSIVE_DESKTOP_OBSERVER_LIMITS.eventBytes) { this.end(r, 'invalid_metadata'); return }
    if (r.queue.length >= PASSIVE_DESKTOP_OBSERVER_LIMITS.queueEvents || r.queuedBytes + bytes > PASSIVE_DESKTOP_OBSERVER_LIMITS.queueBytes
      || r.events >= PASSIVE_DESKTOP_OBSERVER_LIMITS.events || r.bytes + bytes > PASSIVE_DESKTOP_OBSERVER_LIMITS.bytes) { this.end(r, 'capacity'); return }
    const freeze = (value: object): void => { for (const v of Object.values(value)) if (v && typeof v === 'object') freeze(v); Object.freeze(value) }
    freeze(event)
    r.events++; r.bytes += bytes; r.queuedBytes += bytes
    r.queue.push({ event, bytes }); this.schedule(r)
  }

  private schedule(r: Registration): void {
    if (r.closed || r.busy || r.scheduled) return
    r.scheduled = timer(() => { r.scheduled = undefined; void this.deliver(r) }, 0)
  }
  private async invoke<T>(r: Registration, call: () => T | Promise<T>, failure: Reason): Promise<T | undefined> {
    // Cancellation settles our wait, not the sink's work. Late results discarded.
    return new Promise<T | undefined>(resolve => {
      let settled = false
      const finish = (value?: T) => {
        if (settled) return
        settled = true; clearTimeout(deadline); r.cancelWait = undefined; resolve(value)
      }
      const deadline = timer(() => this.end(r, 'timeout'), PASSIVE_DESKTOP_OBSERVER_LIMITS.callbackMs)
      r.cancelWait = () => finish()
      try {
        Promise.resolve(call()).then(value => finish(r.closed ? undefined : value), () => { this.end(r, failure); finish() })
      } catch { this.end(r, failure); finish() }
    })
  }
  private async deliver(r: Registration): Promise<void> {
    if (!this.active(r)) return
    r.busy = true
    if (r.factory) {
      const factory = r.factory; r.factory = undefined
      const sink = await this.invoke(r, () => factory(r.binding), 'factory_failed')
      if (r.closed) return
      if (typeof sink !== 'function') { this.end(r, 'factory_failed'); return }
      r.sink = sink
    }
    const item = r.queue.shift()
    if (item && r.sink && !r.closed) {
      r.queuedBytes -= item.bytes
      const sink = r.sink
      await this.invoke(r, () => sink(item.event), 'callback_failed')
    }
    r.busy = false
    if (r.queue.length) this.schedule(r)
  }
}
