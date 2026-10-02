import { passiveObserverHealth, type PassiveObserverHealth, type PassiveObserverReason as Reason } from '@use-brian/computer-control/passive-observer.js'
export type { PassiveObserverHealth } from '@use-brian/computer-control/passive-observer.js'
import { NativeTraceEventSchema, type NativeRunObserver, type NativeTraceEvent } from '@use-brian/core'
import { NativeObserverBindingSchema, type NativeObserverBinding, type NativeRunObserverFactory } from './composition.js'

/** Deliberately fixed, process-local evidence limits, not execution limits. */
export const PASSIVE_OBSERVER_LIMITS = Object.freeze({
  registrations: 32, startedBindings: 128, queueEvents: 16, queueBytes: 32_768,
  events: 512, bytes: 262_144, eventBytes: 4096, callbackMs: 100,
  registrationMs: 60_000, lifetimeMs: 300_000,
})
export type PassiveObserverSinkFactory = (binding: NativeObserverBinding) => NativeRunObserver | undefined | Promise<NativeRunObserver | undefined>
export type PassiveObserverAttachment = Readonly<{ detach(): void; health(): PassiveObserverHealth }>

/** Copy data descriptors before schema parsing: no getters, extras via prototype,
 * arrays, cycles, or unbounded strings/depth. Reflection on a Proxy can itself run
 * JS: this is NOT a sandbox for hostile proxies or synchronous blocking code. */
function copyData(input: unknown): unknown {
  let nodes = 0, chars = 0
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 96 || depth > 3) throw new Error()
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || value === undefined) return value
    if (typeof value === 'string') {
      chars += value.length
      if (value.length > 200 || chars > 2048) throw new Error()
      return value
    }
    if (typeof value !== 'object') throw new Error()
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
function bindingCopy(input: unknown): NativeObserverBinding {
  return Object.freeze(NativeObserverBindingSchema.parse(copyData(input)))
}
function key(binding: NativeObserverBinding): string { return `${binding.sessionId}:${binding.epoch}` }
function timer(callback: () => void, ms: number) {
  const handle = setTimeout(callback, ms)
  handle.unref?.()
  return handle
}
type Registration = {
  binding: NativeObserverBinding; expiresAt: number; factory?: PassiveObserverSinkFactory; sink?: NativeRunObserver
  closed: boolean; started: boolean; busy: boolean; reason: Reason | null
  queue: { event: NativeTraceEvent; bytes: number }[]; queuedBytes: number; events: number; bytes: number
  runId?: string; clockId?: string; sequence: number
  expiry?: ReturnType<typeof setTimeout>; scheduled?: ReturnType<typeof setTimeout>
  cancelWait?: () => void; removeAbort?: () => void
}

/** Trusted in-process passive attachment owner. Pass nativeComputerObserverFactory
 * to OpenApiPorts explicitly; constructing this owner enables no task or Stop port.
 * Sinks run on detached timers, never inline in source/attach/detach calls. Hung
 * promises are time-bounded, but synchronous JS (including Proxy traps) cannot be
 * preempted. Only trusted code may attach. No drain, publication, or success claim.
 * A spent/expired owner stays closed: do not rotate owners to recover evidence for
 * an already started run. Lifetime quotas also bound retained hung continuations. */
export class PassiveNativeObserverHost {
  private readonly registrations = new Map<string, Registration>()
  private readonly started = new Set<string>()
  private used = 0
  private closed: Reason | null = null
  private readonly expiresAt = Date.now() + PASSIVE_OBSERVER_LIMITS.lifetimeMs
  private readonly lifetime = timer(() => this.close('expired'), PASSIVE_OBSERVER_LIMITS.lifetimeMs)

  private live(): boolean {
    if (!this.closed && Date.now() >= this.expiresAt) this.close('expired')
    return !this.closed
  }
  health(): PassiveObserverHealth { this.live(); return passiveObserverHealth(this.closed) }
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
    r.factory = undefined; r.sink = undefined; r.queue.length = 0; r.queuedBytes = 0
    if (this.registrations.get(key(r.binding)) === r) this.registrations.delete(key(r.binding))
  }

  async attachObserver(binding: NativeObserverBinding, factory: PassiveObserverSinkFactory, signal?: AbortSignal): Promise<PassiveObserverAttachment> {
    const safe = bindingCopy(binding), id = key(safe)
    if (!this.live() || signal?.aborted || typeof factory !== 'function' || this.started.has(id) || this.registrations.has(id)) throw new Error('Passive observer attachment unavailable')
    if (this.used >= PASSIVE_OBSERVER_LIMITS.registrations) {
      this.close('capacity'); throw new Error('Passive observer attachment unavailable')
    }
    this.used++
    const r: Registration = { binding: safe, expiresAt: Date.now() + PASSIVE_OBSERVER_LIMITS.registrationMs, factory, closed: false, started: false, busy: false, reason: null, queue: [], queuedBytes: 0, events: 0, bytes: 0, sequence: 0 }
    this.registrations.set(id, r)
    r.expiry = timer(() => this.end(r, 'expired'), PASSIVE_OBSERVER_LIMITS.registrationMs)
    const detach = () => this.end(r, 'detached')
    if (signal) {
      signal.addEventListener('abort', detach, { once: true })
      r.removeAbort = () => signal.removeEventListener('abort', detach)
      if (signal.aborted) detach()
    }
    return Object.freeze({ detach, health: () => { this.active(r); return passiveObserverHealth(r.reason) } })
  }

  /** Composition calls this only after durable claim. Even unmatched starts are
   * remembered so a later attachment cannot capture only the tail of a run. */
  readonly nativeComputerObserverFactory: NativeRunObserverFactory = binding => {
    if (!this.live()) return undefined
    let safe: NativeObserverBinding
    try { safe = bindingCopy(binding) } catch { return undefined }
    const id = key(safe)
    if (this.started.has(id)) return undefined
    if (this.started.size >= PASSIVE_OBSERVER_LIMITS.startedBindings) { this.close('capacity'); return undefined }
    this.started.add(id)
    const r = this.registrations.get(id)
    if (!r || !this.active(r) || r.started) return undefined
    r.started = true
    this.schedule(r)
    return event => {
      if (!this.active(r)) return
      try {
        const parsed = NativeTraceEventSchema.parse(copyData(event))
        const bytes = Buffer.byteLength(JSON.stringify(parsed))
        if (bytes > PASSIVE_OBSERVER_LIMITS.eventBytes) throw new Error()
        if ((r.runId && (r.runId !== parsed.runId || r.clockId !== parsed.clockId)) || parsed.sequence !== r.sequence + 1 || (!r.runId && parsed.kind !== 'run-start')) throw new Error()
        if (r.queue.length >= PASSIVE_OBSERVER_LIMITS.queueEvents || r.queuedBytes + bytes > PASSIVE_OBSERVER_LIMITS.queueBytes || r.events >= PASSIVE_OBSERVER_LIMITS.events || r.bytes + bytes > PASSIVE_OBSERVER_LIMITS.bytes) { this.end(r, 'capacity'); return }
        if (parsed.inference) {
          if (parsed.inference.usage) Object.freeze(parsed.inference.usage)
          Object.freeze(parsed.inference)
        }
        r.runId = parsed.runId; r.clockId = parsed.clockId; r.sequence = parsed.sequence
        r.events++; r.bytes += bytes; r.queuedBytes += bytes
        r.queue.push({ event: Object.freeze(parsed), bytes })
        this.schedule(r)
      } catch { this.end(r, 'invalid_metadata') }
    }
  }

  private active(r: Registration): boolean {
    if (!r.closed && Date.now() >= r.expiresAt) this.end(r, 'expired')
    return !r.closed && this.live()
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
      const deadline = timer(() => this.end(r, 'timeout'), PASSIVE_OBSERVER_LIMITS.callbackMs)
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
      if (!this.active(r)) return
      if (typeof sink !== 'function') { this.end(r, 'factory_failed'); return }
      r.sink = sink
    }
    const item = r.queue.shift()
    if (item && r.sink && this.active(r)) {
      r.queuedBytes -= item.bytes
      const sink = r.sink
      await this.invoke(r, () => sink(item.event), 'callback_failed')
    }
    r.busy = false
    if (r.queue.length) this.schedule(r)
  }
}
