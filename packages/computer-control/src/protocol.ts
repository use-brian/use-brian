import { z } from 'zod'

export const NATIVE_PROTOCOL = 'native-computer-v1' as const
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
export const MAX_SESSION_MS = 15 * 60_000
export const MAX_OBSERVATION_AGE_MS = 5_000
const id = z.string().min(1).max(256)
const text = z.string().max(4096)
const epoch = z.number().int().nonnegative()
const timestamp = z.number().int().nonnegative()
export const BoundsSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive().max(32768), height: z.number().positive().max(32768) }).strict()
export const TargetSchema = z.object({ appId: id, processId: z.number().int().positive(), processInstanceId: id, windowId: id, windowInstanceId: id }).strict()
// Local discovery only. Never use this schema for grants, actions or observations.
export const DiscoveredTargetSchema = TargetSchema.extend({ displayName: z.string().max(256).optional() }).strict()
export const IdentitySchema = z.object({ deploymentId: id, userId: id, workspaceId: id, deviceId: id, sessionId: id, conversationId: id, taskId: id }).strict()
export const GrantSchema = z.object({
  protocol: z.literal(NATIVE_PROTOCOL), identity: IdentitySchema, grantId: id,
  epoch, expiresAt: timestamp, targets: z.array(TargetSchema).min(1).max(8),
  allowControl: z.boolean(), allowCapture: z.boolean(),
  requester: z.string().min(1).max(200), goal: z.string().min(1).max(2000),
}).strict()
export const CapabilitiesSchema = z.object({
  protocol: z.literal(NATIVE_PROTOCOL), platform: z.enum(['darwin', 'win32', 'linux', 'unsupported']),
  axRead: z.boolean(), semanticActions: z.boolean(), windowCapture: z.boolean(), input: z.boolean(),
  visualInvokeVersion: z.literal(1).optional(),
  accessibilityPermission: z.enum(['granted', 'denied', 'unknown']),
  capturePermission: z.enum(['granted', 'denied', 'unknown']),
  limitations: z.array(z.string().max(300)).max(20),
}).strict()
export const AxNodeSchema = z.object({
  ref: id, parentRef: id.optional(), role: z.string().max(100), name: text,
  value: text.optional(), enabled: z.boolean(), focused: z.boolean(), selected: z.boolean(),
  sensitive: z.boolean(), actions: z.array(z.enum(['invoke', 'setValue', 'select', 'scroll', 'focus'])).max(5),
  bounds: BoundsSchema.optional(),
}).strict()
export const FrameSchema = z.object({
  id, mimeType: z.literal('image/png'), data: z.string().max(3 * 1024 * 1024),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  bounds: BoundsSchema, displayLayoutVersion: id,
}).strict()
export const ObservationSchema = z.object({
  identity: IdentitySchema, epoch, id, capturedAt: timestamp, monotonicMs: z.number().nonnegative(),
  target: TargetSchema, foreground: z.boolean(), bounds: BoundsSchema, displayLayoutVersion: id,
  completeness: z.enum(['complete', 'partial', 'unavailable']),
  nodes: z.array(AxNodeSchema).max(500), frame: FrameSchema.optional(),
  captureCohort: z.literal('public-shapes-v1').optional(),
}).strict().superRefine((value, ctx) => {
  if (value.nodes.some(node => node.sensitive && (node.value !== undefined || node.name !== '' || node.actions.length > 0))) {
    ctx.addIssue({ code: 'custom', message: 'Secure nodes must be redacted before transmission' })
  }
})
export const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('observe'), target: TargetSchema }).strict(),
  z.object({ kind: z.literal('capture'), target: TargetSchema, observationId: id }).strict(),
  z.object({ kind: z.literal('focus'), target: TargetSchema, observationId: id }).strict(),
  z.object({ kind: z.literal('invoke'), target: TargetSchema, observationId: id, ref: id }).strict(),
  z.object({ kind: z.literal('setValue'), target: TargetSchema, observationId: id, ref: id, text: text }).strict(),
  z.object({ kind: z.literal('select'), target: TargetSchema, observationId: id, ref: id }).strict(),
  z.object({ kind: z.literal('scroll'), target: TargetSchema, observationId: id, ref: id, deltaY: z.number().int().min(-600).max(600) }).strict(),
  z.object({ kind: z.literal('click'), target: TargetSchema, observationId: id, frameId: id, x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() }).strict(),
  z.object({ kind: z.literal('visualInvoke'), target: TargetSchema, observationId: id, frameId: id, x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() }).strict(),
  z.object({ kind: z.literal('key'), target: TargetSchema, observationId: id, key: z.enum(['Tab', 'Shift+Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Enter']) }).strict(),
])
// Private helper approval response. The model proposes a point; only native
// resolution may supply this exact invoke target for the local approval dialog.
export const VisualApprovalSchema = z.object({
  bindingId: id, commandId: id, frameId: id,
  action: z.object({ kind: z.literal('invoke'), target: TargetSchema, observationId: id, ref: id }).strict(),
}).strict()
export type NativeVisualApproval = z.infer<typeof VisualApprovalSchema>
export const CommandSchema = z.object({
  protocol: z.literal(NATIVE_PROTOCOL), identity: IdentitySchema, grantId: id, epoch,
  commandId: id, deadlineAt: timestamp, action: ActionSchema,
}).strict()
export const ReceiptSchema = z.object({
  commandId: id, outcome: z.enum(['not_executed', 'executed', 'execution_unknown']),
  code: z.enum(['ok', 'denied', 'stopped', 'expired', 'stale_observation', 'wrong_target', 'unsupported', 'approval_required', 'cancelled', 'transport_error', 'helper_error']),
  observation: ObservationSchema.optional(),
}).strict()
export const StateSchema = z.enum(['unavailable', 'permission_required', 'ready', 'awaiting_local_consent', 'active', 'awaiting_action_approval', 'paused_for_user', 'stopped', 'ended'])
export const StatusSchema = z.object({
  protocol: z.literal(NATIVE_PROTOCOL), state: StateSchema, epoch,
  capabilities: CapabilitiesSchema, identity: IdentitySchema.optional(), expiresAt: timestamp.optional(),
}).strict()
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.literal(NATIVE_PROTOCOL), token: z.string().min(1).max(8192) }).strict(),
  z.object({ type: z.literal('status'), status: StatusSchema }).strict(),
  z.object({ type: z.literal('receipt'), receipt: ReceiptSchema }).strict(),
  z.object({ type: z.literal('heartbeat') }).strict(),
])
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), identity: IdentitySchema }).strict(),
  z.object({ type: z.literal('command'), command: CommandSchema }).strict(),
  z.object({ type: z.literal('revoke') }).strict(),
])
export type NativeIdentity = z.infer<typeof IdentitySchema>
export type DiscoveredTarget = z.infer<typeof DiscoveredTargetSchema>
export type NativeTarget = z.infer<typeof TargetSchema>
export type NativeGrant = z.infer<typeof GrantSchema>
export type NativeCapabilities = z.infer<typeof CapabilitiesSchema>
export type NativeObservation = z.infer<typeof ObservationSchema>
export type NativeAction = z.infer<typeof ActionSchema>
export type NativeCommand = z.infer<typeof CommandSchema>
export type NativeReceipt = z.infer<typeof ReceiptSchema>
export type NativeStatus = z.infer<typeof StatusSchema>
export type NativeFrame = z.infer<typeof FrameSchema>
export type NativeBounds = z.infer<typeof BoundsSchema>

export function sameIdentity(a: NativeIdentity, b: NativeIdentity): boolean {
  return (Object.keys(IdentitySchema.shape) as (keyof NativeIdentity)[]).every(key => a[key] === b[key])
}
export function sameTarget(a: NativeTarget, b: NativeTarget): boolean {
  return (Object.keys(TargetSchema.shape) as (keyof NativeTarget)[]).every(key => a[key] === b[key])
}
export function framePoint(frame: NativeFrame, x: number, y: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new Error('Point outside capture')
  return { x: frame.bounds.x + x * frame.bounds.width / frame.width, y: frame.bounds.y + y * frame.bounds.height / frame.height }
}
export function parseMessage(raw: string): unknown {
  if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) throw new Error('Native message too large')
  return JSON.parse(raw) as unknown
}
