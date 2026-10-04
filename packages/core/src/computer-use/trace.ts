import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'

// Shared with native durable accounting; never accept URLs or diagnostic text.
export const NativeModelIdSchema = z.string().max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@+-]*$/)
  .refine(value => !value.includes('://') && (!value.startsWith('custom:') || z.string().uuid().safeParse(value.slice(7)).success))
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const money = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const NativeInferenceLifecycleSchema = z.object({
  attemptId: z.string().uuid(), invocationState: z.enum(['pending', 'settled']), interrupted: z.boolean(),
  requestedModel: NativeModelIdSchema, model: NativeModelIdSchema.nullable(),
  providerKind: z.enum(['custom', 'openai', 'anthropic', 'gemini', 'openrouter', 'typesafe', 'other']),
  lane: z.enum(['text', 'vision', 'decision']), outcome: z.enum(['pending', 'ok', 'failed']),
  operation: z.enum(['plan', 'decompose', 'next-action', 'verify-progress', 'ground']),
  stage: z.enum(['direct', 'primary_decision', 'llm_only', 'generation', 'uncertainty_review', 'operational_failover', 'shadow_legacy']),
  perceptionPath: z.enum(['ax', 'vision']),
  fallbackReason: z.enum(['none', 'generation_required', 'uncertain', 'inconsistent']).nullable(),
  disposition: z.enum(['complete', 'follow_up', 'unavailable']).nullable(),
  /** Existing adapter lifecycle duration; not provider network timing or a callback-derived span. */
  durationMs: count.nullable(),
  usage: z.object({ inputTokens: count, outputTokens: count, cacheReadTokens: count.optional(), cacheWriteTokens: count.optional() }).strict().nullable(),
  incurredCostUsd: money.nullable(), estimatedBilledCostUsd: money.nullable(),
  providerKeySource: z.enum(['user', 'platform']),
}).strict().superRefine((v, ctx) => {
  if ((v.lane === 'decision') !== (v.stage === 'primary_decision') || (v.lane === 'vision') !== (v.perceptionPath === 'vision')
    || (v.lane === 'vision') !== (v.operation === 'ground') || (v.invocationState === 'settled' && v.outcome === 'pending')
    || (v.interrupted && v.outcome === 'ok')) ctx.addIssue({ code: 'custom', message: 'Inconsistent invocation metadata' })
})
export type NativeInferenceLifecycle = Readonly<z.infer<typeof NativeInferenceLifecycleSchema>>
const inferencePhase = { plan: 'generation', decompose: 'decomposition', 'next-action': 'selection', 'verify-progress': 'verification', ground: 'vision-grounding' } as const
const correlationSchema = z.object({ runId: z.string().uuid(), spanId: z.string().uuid(), clockId: z.string().uuid() }).strict()

const phaseSchema = z.enum(['run', 'observation-rpc', 'capture-rpc', 'effect-rpc', 'generation', 'selection', 'decomposition', 'verification', 'vision-grounding'])
const actionSchema = z.enum(['observe', 'capture', 'invoke', 'select', 'setValue', 'scroll', 'key', 'click', 'visualInvoke', 'focus'])
const poisonSchema = z.enum(['overflow', 'invalid_clock', 'invalid_metadata', 'observer_failed', 'observer_backpressure'])
const terminalSchema = z.enum(['completed', 'paused', 'cancelled', 'execution_unknown', 'unavailable'])
const timestampSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()

/** Strict, content-free wire shape. RPC settlement is not an OS/helper dispatch
 * timestamp; high-level model spans are not actual provider invocation timings. */
export const NativeTraceEventSchema = z.object({
  version: z.literal(1), source: z.literal('core-process'),
  runId: z.string().uuid(), spanId: z.string().uuid(), clockId: z.string().uuid(),
  sequence: z.number().int().positive().max(2048), step: z.number().int().min(0).max(1000).nullable(),
  kind: z.enum(['run-start', 'span-start', 'span-interrupted', 'span-settled', 'run-terminal', 'evidence-poisoned', 'inference-update']),
  phase: phaseSchema, scope: z.enum(['rpc', 'high-level', 'adapter-lifecycle']),
  commandId: z.string().uuid().nullable(), actionKind: actionSchema.nullable(),
  atMs: timestampSchema, durationMs: timestampSchema,
  outcome: z.enum(['started', 'fulfilled', 'rejected', 'interrupted', 'completed', 'paused', 'cancelled', 'execution_unknown', 'unavailable', 'poisoned']),
  late: z.boolean(), evidence: z.enum(['valid', 'poisoned']), poisonReason: poisonSchema.nullable(),
  inference: NativeInferenceLifecycleSchema.optional(),
  drain: z.literal('not_observed'),
}).strict().superRefine((event, ctx) => {
  const inference = event.kind === 'inference-update'
  if (inference) {
    if (!event.inference || event.scope !== 'adapter-lifecycle' || event.phase === 'run' || event.phase.endsWith('-rpc')
      || event.phase !== inferencePhase[event.inference.operation] || event.step === null
      || event.commandId !== null || event.actionKind !== null || event.atMs !== null || event.durationMs !== event.inference.durationMs
      || event.poisonReason !== null || event.outcome !== (event.inference.interrupted ? 'interrupted' : event.inference.invocationState === 'pending' ? 'started' : event.inference.outcome === 'ok' ? 'fulfilled' : 'rejected'))
      ctx.addIssue({ code: 'custom', message: 'Invalid invocation event' })
    return
  }
  if (event.inference !== undefined) ctx.addIssue({ code: 'custom', message: 'Unexpected invocation metadata' })
  const rpc = event.phase.endsWith('-rpc')
  const runEvent = event.kind === 'run-start' || event.kind === 'run-terminal' || event.kind === 'evidence-poisoned'
  const outcomeValid = event.kind === 'span-settled' ? event.outcome === 'fulfilled' || event.outcome === 'rejected'
    : event.kind === 'span-interrupted' ? event.outcome === 'interrupted'
    : event.kind === 'run-terminal' ? terminalSchema.safeParse(event.outcome).success
    : event.kind === 'evidence-poisoned' ? event.outcome === 'poisoned'
    : event.outcome === 'started'
  if (!outcomeValid || runEvent !== (event.phase === 'run') || (rpc ? event.scope !== 'rpc' || !event.commandId || !event.actionKind : event.scope !== 'high-level' || event.commandId !== null || event.actionKind !== null)
    || (event.phase === 'observation-rpc' && event.actionKind !== 'observe')
    || (event.phase === 'capture-rpc' && event.actionKind !== 'capture')
    || (event.phase === 'effect-rpc' && (event.actionKind === 'observe' || event.actionKind === 'capture'))
    || (event.durationMs !== null && event.atMs === null)
    || ((event.kind === 'span-start' || event.kind === 'run-start') && event.durationMs !== null)
    || (event.kind === 'evidence-poisoned' && (event.evidence !== 'poisoned' || !event.poisonReason || event.atMs !== null || event.durationMs !== null))
    || (event.kind !== 'evidence-poisoned' && event.poisonReason !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent native trace metadata' })
  }
})
export type NativeTraceEvent = Readonly<z.infer<typeof NativeTraceEventSchema>>
export type NativeTracePhase = Exclude<z.infer<typeof phaseSchema>, 'run'>
export type NativeTraceCorrelation = Readonly<{ runId: string; spanId: string; clockId: string }>
export type NativeRunObserver = (event: NativeTraceEvent) => void | Promise<void>
export type NativeTraceSpan = Readonly<{
  correlation: NativeTraceCorrelation
  /** Logical wait ended; the underlying promise may still be running. */
  interrupt(): void
  /** Records only settlement of the wrapped promise, including late settlement. */
  settle(outcome: 'fulfilled' | 'rejected'): void
}>
export type NativeRunTraceOptions = {
  /** Trusted source-local monotonic clock, injectable for tests; never wall time. */
  clock?: () => number
  /** Bounded ephemeral metadata buffer; default 512, supported range 16..2048. */
  maxEvents?: number
}

const spanMetadataSchema = z.object({
  phase: phaseSchema.exclude(['run']), step: z.number().int().min(0).max(1000),
  commandId: z.string().uuid().nullable(), actionKind: actionSchema.nullable(),
}).strict().superRefine((v, ctx) => {
  const rpc = v.phase.endsWith('-rpc')
  if (rpc !== (v.commandId !== null && v.actionKind !== null)
    || (!rpc && (v.commandId !== null || v.actionKind !== null))
    || (v.phase === 'observation-rpc' && v.actionKind !== 'observe')
    || (v.phase === 'capture-rpc' && v.actionKind !== 'capture')
    || (v.phase === 'effect-rpc' && (v.actionKind === 'observe' || v.actionKind === 'capture'))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid span metadata' })
  }
})

/** Metadata producer only. Observers receive frozen event copies, never this object
 * or task/authority handles. No logging/persistence or scheduling of task work.
 * Callback delivery is detached and bounded; pending observer promises are NOT a
 * drain signal. Snapshots can acquire late settlements/poison after logical terminal.
 * A synchronous callback that blocks the JS thread cannot be preempted. */
export class NativeRunTrace {
  readonly #ids = Object.freeze({ runId: randomUUID(), clockId: randomUUID(), rootSpanId: randomUUID() })
  get runId(): string { return this.#ids.runId }
  get clockId(): string { return this.#ids.clockId }
  private get rootSpanId(): string { return this.#ids.rootSpanId }
  private readonly events: NativeTraceEvent[] = []
  private readonly poisons = new Set<z.infer<typeof poisonSchema>>()
  private readonly maxEvents: number
  private readonly clock: () => number
  private lastClock: number | undefined
  private clockInvalid = false
  private started = false
  private ended = false
  private startAt: number | null = null
  private readonly spans = new Map<string, { phase: NativeTracePhase; step: number }>()
  private readonly invocations = new Map<string, { spanId: string; inference: NativeInferenceLifecycle }>()
  private pendingSpans = 0
  private pendingObservers = 0
  private deliveryDisabled = false

  constructor(private readonly observer?: NativeRunObserver, options: NativeRunTraceOptions = {}) {
    this.clock = options.clock ?? (() => performance.now())
    const max = options.maxEvents ?? 512
    this.maxEvents = Number.isInteger(max) && max >= 16 && max <= 2048 ? max : 512
    if (this.maxEvents !== max) this.invalidate('invalid_metadata')
  }

  private time(): number | null {
    if (this.clockInvalid) return null
    try {
      const now = this.clock()
      if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER || (this.lastClock !== undefined && now < this.lastClock)) throw new Error()
      this.lastClock = now
      return now
    } catch {
      this.clockInvalid = true
      this.invalidate('invalid_clock')
      return null
    }
  }
  private duration(start: number | null, end: number | null): number | null {
    return this.clockInvalid || start === null || end === null ? null : end - start
  }
  private record(fields: Pick<NativeTraceEvent, 'kind' | 'spanId' | 'phase' | 'step' | 'commandId' | 'actionKind' | 'atMs' | 'durationMs' | 'outcome'> & { inference?: NativeInferenceLifecycle },
    poisonReason: NativeTraceEvent['poisonReason'] = null, control = false, deliver = true): boolean {
    // Reserve room for each fixed poison reason and the logical terminal record.
    if (!control && this.events.length >= this.maxEvents - 8) { this.invalidate('overflow'); return false }
    if (this.events.length >= this.maxEvents) return false
    const event: NativeTraceEvent = Object.freeze({
      version: 1, source: 'core-process', runId: this.runId, clockId: this.clockId,
      sequence: this.events.length + 1, ...fields, scope: fields.inference ? 'adapter-lifecycle' : fields.phase.endsWith('-rpc') ? 'rpc' : 'high-level',
      late: this.ended && fields.kind !== 'run-terminal', evidence: this.poisons.size ? 'poisoned' : 'valid', poisonReason, drain: 'not_observed',
    })
    this.events.push(event)
    if (deliver && this.observer && !this.deliveryDisabled) {
      if (this.pendingObservers >= 8) {
        this.deliveryDisabled = true
        this.invalidate('observer_backpressure')
      } else {
        this.pendingObservers++
        queueMicrotask(() => {
          try {
            // Neither the callback nor its returned promise is awaited by task work.
            Promise.resolve(this.observer!(event)).then(
              () => { this.pendingObservers-- },
              () => { this.pendingObservers--; this.deliveryDisabled = true; this.invalidate('observer_failed') },
            )
          } catch {
            this.pendingObservers--; this.deliveryDisabled = true; this.invalidate('observer_failed')
          }
        })
      }
    }
    return true
  }
  invalidate(reason: z.infer<typeof poisonSchema>): void {
    const parsed = poisonSchema.safeParse(reason)
    const safe = parsed.success ? parsed.data : 'invalid_metadata'
    if (this.poisons.has(safe)) return
    this.poisons.add(safe)
    this.record({ kind: 'evidence-poisoned', spanId: this.rootSpanId, phase: 'run', step: null, commandId: null, actionKind: null,
      atMs: null, durationMs: null, outcome: 'poisoned' }, safe, true, safe !== 'observer_failed' && safe !== 'observer_backpressure')
  }
  startRun(): void {
    if (this.started || this.ended) return
    this.started = true
    this.startAt = this.time()
    this.record({ kind: 'run-start', spanId: this.rootSpanId, phase: 'run', step: null, commandId: null, actionKind: null,
      atMs: this.startAt, durationMs: null, outcome: 'started' })
  }
  startSpan(phase: NativeTracePhase, step: number, command?: { commandId: string; actionKind: z.infer<typeof actionSchema> }): NativeTraceSpan | undefined {
    if (this.ended) return undefined
    this.startRun()
    let parsed: ReturnType<typeof spanMetadataSchema.safeParse>
    try { parsed = spanMetadataSchema.safeParse({ phase, step, commandId: command?.commandId ?? null, actionKind: command?.actionKind ?? null }) }
    catch { this.invalidate('invalid_metadata'); return undefined }
    if (!parsed.success) { this.invalidate('invalid_metadata'); return undefined }
    const meta = parsed.data, spanId = randomUUID(), start = this.time()
    if (!this.record({ ...meta, kind: 'span-start', spanId, atMs: start, durationMs: null, outcome: 'started' })) return undefined
    this.spans.set(spanId, { phase, step })
    this.pendingSpans++
    let settled = false, interrupted = false
    return Object.freeze({
      correlation: Object.freeze({ runId: this.runId, spanId, clockId: this.clockId }),
      interrupt: () => {
        if (interrupted) return
        interrupted = true
        const now = this.time()
        this.record({ ...meta, kind: 'span-interrupted', spanId, atMs: now, durationMs: this.duration(start, now), outcome: 'interrupted' })
      },
      settle: (outcome: 'fulfilled' | 'rejected') => {
        if (settled) return
        settled = true; this.pendingSpans--
        if (outcome !== 'fulfilled' && outcome !== 'rejected') { this.invalidate('invalid_metadata'); return }
        const now = this.time()
        this.record({ ...meta, kind: 'span-settled', spanId, atMs: now, durationMs: this.duration(start, now), outcome })
      },
    })
  }
  /** Hydra request.runId is the existing phase span ID, not a new invocation ID. */
  correlationForSpan(spanId: string): NativeTraceCorrelation | undefined {
    if (!this.spans.has(spanId)) return undefined
    return Object.freeze({ runId: this.runId, clockId: this.clockId, spanId })
  }
  /** Existing accounting calls this with its stable invocation ID and source
   * duration. No callback timestamps are manufactured as provider timing.
   * Invalid/conflicting evidence is rejected, never repaired or used for work. */
  recordInference(correlation: unknown, metadata: unknown): void {
    try {
      const c = correlationSchema.parse(correlation), parsed = NativeInferenceLifecycleSchema.parse(metadata)
      const span = this.spans.get(c.spanId)
      const phase = inferencePhase[parsed.operation]
      if (c.runId !== this.runId || c.clockId !== this.clockId || !span || span.phase !== phase) throw new Error()
      const previous = this.invocations.get(parsed.attemptId)
      if (!previous && (parsed.invocationState !== 'pending' || this.ended)) throw new Error()
      if (previous) {
        const old = previous.inference
        if (previous.spanId !== c.spanId || (['requestedModel', 'lane', 'stage', 'operation', 'providerKeySource', 'perceptionPath'] as const).some(k => old[k] !== parsed[k])
          || (old.model !== null && old.model !== parsed.model)
          || (old.providerKind !== parsed.providerKind && !(old.model === null && parsed.model !== null))
          || (old.interrupted && !parsed.interrupted) || (old.durationMs !== null && (parsed.durationMs === null || parsed.durationMs < old.durationMs))) throw new Error()
        if (JSON.stringify(old) === JSON.stringify(parsed)) return
        if (old.invocationState === 'settled') throw new Error()
      }
      const inference = Object.freeze({ ...parsed, usage: parsed.usage === null ? null : Object.freeze({ ...parsed.usage }) })
      if (!this.record({ kind: 'inference-update', spanId: c.spanId, phase: span.phase, step: span.step,
        commandId: null, actionKind: null, atMs: null, durationMs: inference.durationMs, inference,
        outcome: inference.interrupted ? 'interrupted' : inference.invocationState === 'pending' ? 'started' : inference.outcome === 'ok' ? 'fulfilled' : 'rejected' })) return
      this.invocations.set(inference.attemptId, Object.freeze({ spanId: c.spanId, inference }))
    } catch { this.invalidate('invalid_metadata') }
  }
  terminal(outcome: z.infer<typeof terminalSchema>, step: number): void {
    if (this.ended) return
    this.startRun()
    if (!terminalSchema.safeParse(outcome).success || !Number.isInteger(step) || step < 0 || step > 1000) { this.invalidate('invalid_metadata'); return }
    const now = this.time()
    this.ended = true
    this.record({ kind: 'run-terminal', spanId: this.rootSpanId, phase: 'run', step, commandId: null, actionKind: null,
      atMs: now, durationMs: this.duration(this.startAt, now), outcome }, null, true)
  }
  snapshot() {
    return Object.freeze({ runId: this.runId, clockId: this.clockId, evidence: this.poisons.size ? 'poisoned' as const : 'valid' as const,
      poisonReasons: Object.freeze([...this.poisons]), logicalTerminal: this.ended, drain: 'not_observed' as const,
      // Counts cover accepted metadata only, never proof of provider/helper/oracle drain.
      pendingInvocations: [...this.invocations.values()].filter(v => v.inference.invocationState === 'pending').length,
      invocations: Object.freeze([...this.invocations.values()]), pendingSpans: this.pendingSpans, pendingObserverCallbacks: this.pendingObservers, events: Object.freeze([...this.events]) })
  }
}
