import { z } from 'zod'

/** Metadata only: never command authority, content, credentials, or content hashes. */
export const NativeTraceBindingSchema = z.object({ sessionId: z.string().uuid(), epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
export const NativeTraceCommandSchema = z.object({ commandId: z.string().uuid(), actionKind: z.enum(['observe', 'capture', 'focus', 'invoke', 'setValue', 'select', 'scroll', 'click', 'visualInvoke', 'key']) }).strict()
export const NativeTraceMetadataSchema = z.object({
  event: z.enum(['command_admission', 'approval_wait', 'authority_check', 'helper_rpc_wait', 'helper_rpc_settlement', 'stop_requested', 'local_gate_revoked', 'helper_lifetime_barrier', 'trace_incomplete']),
  outcome: z.enum(['started', 'admitted', 'denied', 'replayed', 'resolved', 'failed', 'cancelled', 'late_resolved', 'late_failed', 'revoked', 'incomplete']),
  operation: z.enum(['grant', 'action', 'local', 'remote', 'capabilities', 'start', 'begin_approval', 'end_approval', 'execute', 'kill']).optional(),
  durationMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  command: NativeTraceCommandSchema.optional(),
}).strict()

/** Canonical broker observer envelope. These are broker-source monotonic times:
 * RPC wait/settlement is callback arrival, stop_requested is broker Stop entry,
 * local_gate_revoked confirms the local gate is closed, and the lifetime barrier
 * resolves only on helper exit/never-spawned proof. None establishes physical
 * activation, OS delivery, local AX execution time, or fixture/target drain.
 * Clock IDs identify domains, not synchronization with helper or OS clocks.
 */
export const NativeBrokerTraceEventSchema = NativeTraceMetadataSchema.extend({
  ...NativeTraceBindingSchema.shape,
  source: z.literal('desktop_broker'), sourceId: z.string().uuid(), clockId: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  elapsedMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER), incomplete: z.boolean(),
}).strict()
export type NativeTraceBinding = Readonly<z.infer<typeof NativeTraceBindingSchema>>
export type NativeTraceCommand = Readonly<z.infer<typeof NativeTraceCommandSchema>>
export type NativeTraceMetadata = Readonly<Omit<z.infer<typeof NativeTraceMetadataSchema>, 'command'> & { command?: NativeTraceCommand }>
export type NativeBrokerTraceEvent = Readonly<Omit<z.infer<typeof NativeBrokerTraceEventSchema>, 'command'> & { command?: NativeTraceCommand }>
