import { z } from 'zod'

/** Private diagnostic envelope only; never command authority or delivery evidence.
 * Times are integer microseconds in a helper-instance-local monotonic domain.
 * A returned API invocation is NOT proof of OS delivery or target mutation.
 * A missing response supplies no completion, non-dispatch or drain evidence.
 */
export const HelperMethodSchema = z.enum(['capabilities', 'listTargets', 'start', 'beginApproval', 'endApproval', 'execute'])
export type HelperMethod = z.infer<typeof HelperMethodSchema>
const tick = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const requestId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/)
const phase = z.enum(['request', 'observe_request', 'capture_request', 'api_set_value', 'api_invoke', 'api_select', 'api_scroll'])
export const HelperTimingSpanSchema = z.object({
  phase,
  startUs: tick,
  endUs: tick,
  durationUs: tick.max(900_000_000),
  status: z.enum(['returned', 'failed']),
}).strict().superRefine((span, ctx) => {
  if (span.endUs < span.startUs || span.endUs - span.startUs !== span.durationUs) ctx.addIssue({ code: 'custom', message: 'Invalid source interval' })
})
export const HelperTimingSchema = z.object({
  version: z.literal(1),
  instanceId: z.string().uuid(),
  clockId: z.string().uuid(),
  requestId,
  method: HelperMethodSchema,
  spans: z.array(HelperTimingSpanSchema).min(1).max(2),
}).strict().superRefine((timing, ctx) => {
  const [request, api] = timing.spans
  if (!request || !['request', 'observe_request', 'capture_request'].includes(request.phase)
    || (timing.method !== 'execute' && request.phase !== 'request')
    || (api && (timing.method !== 'execute' || request.phase !== 'request' || !api.phase.startsWith('api_')
      || api.startUs < request.startUs || api.endUs > request.endUs))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid phase nesting' })
  }
})
export type HelperTiming = z.infer<typeof HelperTimingSchema>

/** Runtime validation of the full private callback envelope. Callers handling
 * untrusted in-process objects must bound/copy descriptors before parsing;
 * Zod is not an accessor/proxy sandbox. No fields here confer authority.
 */
export const HelperTimingCorrelationSchema = z.object({
  sessionId: z.string().uuid(),
  epoch: tick,
  commandId: z.string().uuid().optional(),
}).strict()
const eventBase = {
  requestId,
  method: HelperMethodSchema,
  correlation: HelperTimingCorrelationSchema.optional(),
  droppedBefore: z.number().int().min(0).max(65535),
}
export const HelperTimingEventSchema = z.discriminatedUnion('state', [
  z.object({ ...eventBase, state: z.literal('complete'), timing: HelperTimingSchema }).strict(),
  z.object({ ...eventBase, state: z.literal('incomplete'), reason: z.enum(['absent', 'invalid', 'lost_response']) }).strict(),
]).superRefine((event, ctx) => {
  if (event.state === 'complete' && (event.timing.requestId !== event.requestId || event.timing.method !== event.method)) {
    ctx.addIssue({ code: 'custom', message: 'Timing does not match callback envelope' })
  }
})

/** Main-owned correlation, never populated from diagnostic/helper content. */
export type HelperTimingCorrelation = Readonly<z.infer<typeof HelperTimingCorrelationSchema>>
/** 'complete' means a validated returned DTO only, NOT a complete evidence
 * collection, dispatch/drain assertion or native acceptance. Omitted API spans
 * do not establish non-dispatch. droppedBefore > 0 marks collection loss.
 */
export type HelperTimingEvent = Readonly<{
  requestId: string
  method: HelperMethod
  correlation?: HelperTimingCorrelation
  /** Bounded count of omitted events (busy callback or invalid envelope). */
  droppedBefore: number
} & ({ state: 'complete'; timing: Readonly<Omit<HelperTiming, 'spans'>> & { readonly spans: readonly Readonly<HelperTiming['spans'][number]>[] } }
  | { state: 'incomplete'; reason: 'absent' | 'invalid' | 'lost_response' })>
