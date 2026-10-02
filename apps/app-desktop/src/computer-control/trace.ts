import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { NativeTraceBindingSchema, NativeTraceMetadataSchema, NativeBrokerTraceEventSchema, type NativeTraceBinding, type NativeTraceCommand, type NativeTraceMetadata, type NativeBrokerTraceEvent } from '@use-brian/computer-control/broker-trace.js'
export { NativeTraceBindingSchema, NativeTraceCommandSchema, NativeTraceMetadataSchema, NativeBrokerTraceEventSchema, type NativeTraceBinding, type NativeTraceCommand, type NativeTraceMetadata, type NativeBrokerTraceEvent } from '@use-brian/computer-control/broker-trace.js'

// A broker clock, not an OS input/AX clock. No wall-clock or cross-process alignment is implied.
const clockId = randomUUID()
export type NativeBrokerObserver = (event: NativeBrokerTraceEvent) => void | Promise<void>
/** Trusted main constructor only. No renderer, model, environment variable or IPC configuration. */
export type NativeBrokerObserverFactory = (binding: NativeTraceBinding) => NativeBrokerObserver | Promise<NativeBrokerObserver>
export const TRACE_QUEUE_LIMIT = 64
export const TRACE_EVENT_LIMIT = 2048
export const TRACE_DELIVERY_TIMEOUT_MS = 1000

/** Bounded, detached, metadata-only delivery. Nothing here authorizes work or releases a lease.
 * A hung observer/factory disables delivery; incomplete remains visible through health().
 * On recoverable backpressure/failure a single marker follows the queued events. */
export class NativeBrokerTrace {
  private readonly sourceId = randomUUID()
  private readonly origin = performance.now()
  private sequence = 0
  private queue: NativeBrokerTraceEvent[] = []
  private observer?: NativeBrokerObserver
  private initialized = false
  private scheduled = false
  private busy = false
  private disabled = false
  private incomplete = false
  private dropped = 0
  private markerNeeded = false
  private constructor(private readonly binding: NativeTraceBinding, private readonly factory: NativeBrokerObserverFactory) {}
  static create(factory: NativeBrokerObserverFactory | undefined, binding: NativeTraceBinding): NativeBrokerTrace | undefined {
    if (!factory) return undefined
    const parsed = NativeTraceBindingSchema.safeParse(binding)
    if (!parsed.success) return undefined
    return new NativeBrokerTrace(Object.freeze(parsed.data), factory)
  }
  health(): Readonly<{ incomplete: boolean; dropped: number; pending: number }> {
    return Object.freeze({ incomplete: this.incomplete, dropped: this.dropped, pending: this.queue.length + Number(this.busy && this.initialized) })
  }
  record(metadata: NativeTraceMetadata): void {
    if (this.disabled) return
    const parsed = NativeTraceMetadataSchema.safeParse(metadata)
    if (!parsed.success || this.sequence >= TRACE_EVENT_LIMIT || this.queue.length + Number(this.busy && this.initialized) >= TRACE_QUEUE_LIMIT) {
      this.lose(); this.schedule(); return
    }
    this.queue.push(this.event(parsed.data)); this.schedule()
  }
  private event(metadata: NativeTraceMetadata): NativeBrokerTraceEvent {
    const parsed = NativeBrokerTraceEventSchema.parse({ ...metadata, ...this.binding,
      source: 'desktop_broker', sourceId: this.sourceId, clockId, sequence: ++this.sequence,
      elapsedMs: Math.max(0, performance.now() - this.origin), incomplete: this.incomplete })
    return Object.freeze({ ...parsed, ...(parsed.command ? { command: Object.freeze(parsed.command) } : {}) })
  }

  private lose(): void {
    if (!this.incomplete) this.markerNeeded = true
    this.incomplete = true
    this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1)
  }
  private schedule(): void {
    if (this.disabled || this.scheduled || this.busy) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.pump() })
  }
  // Attach both settlement handlers immediately. Telemetry promises never escape to the broker.
  private detached<T>(invoke: () => T | Promise<T>, done: (value: T) => void): void {
    this.busy = true
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true; this.lose(); this.disabled = true; this.busy = false; this.queue = []
    }, TRACE_DELIVERY_TIMEOUT_MS)
    timer.unref()
    Promise.resolve().then(invoke).then(value => {
      if (settled) return
      settled = true; clearTimeout(timer); this.busy = false
      done(value); this.schedule()
    }, () => {
      if (settled) return
      settled = true; clearTimeout(timer); this.busy = false; this.lose()
      if (!this.initialized) { this.disabled = true; this.queue = [] }
      this.schedule()
    })
  }
  private pump(): void {
    if (this.disabled || this.busy) return
    if (!this.initialized) {
      this.detached(() => this.factory(this.binding), observer => {
        if (typeof observer !== 'function') { this.lose(); this.disabled = true; this.queue = []; return }
        this.observer = observer; this.initialized = true
      })
      return
    }
    let event = this.queue.shift()
    if (!event && this.markerNeeded) {
      this.markerNeeded = false
      event = this.event({ event: 'trace_incomplete', outcome: 'incomplete' })
    }
    if (!event) return
    // Previously queued records also disclose a known gap, without mutating delivered records.
    const delivered = Object.freeze({ ...event, incomplete: this.incomplete })
    this.detached(() => this.observer!(delivered), () => {})
  }
}
