/** Display-only protocol. No callbacks, tool names or caller-supplied authority. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { PROACTIVE_DELIVERY_TRANSPORTS } from '../session-kind.js'

const bounded = (max: number) => z.string().min(1).max(max).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s))
export type ExternalApprovalSource = {
  id: string; tokenSha256: string; workspaceId: string; assistantId: string; approverUserId: string | null
  /** Absent on legacy person-bound registrations. */
  audience?: 'conversation_members'
  destinationSessionId?: string
  channelType: 'web' | (typeof PROACTIVE_DELIVERY_TRANSPORTS)[number]
  channelId: string; channelIntegrationId?: string; threadRef?: string
}
export const externalAnswerSchema = bounded(32768).refine(answer => answer.trim().length > 0)
export const questionRequestSchema = z.object({
  method: z.literal('question'), title: bounded(16384), message: bounded(32768).optional(),
  options: z.array(bounded(2048).refine(option => option.trim().length > 0)).min(1).max(20).refine(options => new Set(options).size === options.length).optional(),
  allowCustom: z.boolean().optional(),
}).strict()
const requestSchema = z.discriminatedUnion('method', [
  questionRequestSchema,
  z.object({ method: z.literal('confirm'), title: bounded(16384), message: bounded(32768).optional() }).strict(),
  z.object({ method: z.literal('select'), title: bounded(16384), message: bounded(32768).optional(), options: z.tuple([z.literal('Allow once'), z.literal('Deny')]) }).strict(),
])
export const externalRequestIdSchema = bounded(200).refine(s => /^[a-zA-Z0-9_.:-]+$/.test(s))
export const externalInputSchema = z.object({
  externalRequestId: externalRequestIdSchema,
  taskId: bounded(200), sessionId: bounded(200), request: requestSchema.refine(r => r.method !== 'question' || r.options !== undefined || r.allowCustom !== false, { message: 'Text questions require custom answers' }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict()
export type ExternalApprovalInput = z.infer<typeof externalInputSchema>
export const ackSchema = z.object({ status: z.enum(['applied', 'stale', 'failed']) }).strict()
export type AckStatus = z.infer<typeof ackSchema>['status']
export function normalizeExternalInput(raw: unknown): { input: ExternalApprovalInput; payloadHash: string } {
  const p = externalInputSchema.parse(raw)
  const request = { method: p.request.method, title: p.request.title,
    ...(p.request.message !== undefined ? { message: p.request.message } : {}),
    ...(p.request.method === 'select' ? { options: p.request.options } : {}),
    ...(p.request.method === 'question' ? {
      ...(p.request.options !== undefined ? { options: p.request.options } : {}),
      ...(p.request.allowCustom !== undefined ? { allowCustom: p.request.allowCustom } : {}),
    } : {}) } as ExternalApprovalInput['request']
  const input = { externalRequestId: p.externalRequestId, taskId: p.taskId, sessionId: p.sessionId, request, expiresAt: new Date(p.expiresAt).toISOString() }
  return { input, payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex') }
}
/** Pins all configured authority/destination, but permits token rotation. */
export function sourceBinding(source: ExternalApprovalSource): string {
  const binding = [source.id, source.workspaceId, source.assistantId, source.approverUserId,
    source.channelType, source.channelId, source.channelIntegrationId ?? null]
  // Never change existing request bindings during an upgrade.
  if (source.audience === 'conversation_members') binding.push('conversation_members:v1', source.destinationSessionId ?? null, source.threadRef ?? null)
  return createHash('sha256').update(JSON.stringify(binding)).digest('hex')
}
