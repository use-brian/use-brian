/** Display-only protocol. No callbacks, tool names or caller-supplied authority. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { PROACTIVE_DELIVERY_TRANSPORTS } from '../session-kind.js'

const bounded = (max: number) => z.string().min(1).max(max).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s))
const sourceSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceId: z.string().uuid(), assistantId: z.string().uuid(), approverUserId: z.string().uuid(),
  channelType: z.enum(['web', ...PROACTIVE_DELIVERY_TRANSPORTS]), channelId: bounded(512),
  channelIntegrationId: z.string().uuid().optional(),
}).strict()
export type ExternalApprovalSource = z.infer<typeof sourceSchema>
export function parseExternalApprovalSources(raw?: string): ExternalApprovalSource[] {
  if (raw === undefined) return []
  try {
    const sources = z.array(sourceSchema).max(100).parse(JSON.parse(raw))
    if (new Set(sources.map(s => s.id)).size !== sources.length || new Set(sources.map(s => s.tokenSha256)).size !== sources.length) throw new Error()
    return sources
  } catch { throw new Error('Invalid BRIAN_EXTERNAL_APPROVAL_SOURCES configuration') }
}
export function authenticateSource(sources: ExternalApprovalSource[], header?: string): ExternalApprovalSource | null {
  if (!header || !/^Bearer [!-~]{16,4096}$/.test(header)) return null
  const digest = createHash('sha256').update(header.slice(7)).digest()
  return sources.find(s => timingSafeEqual(Buffer.from(s.tokenSha256, 'hex'), digest)) ?? null
}
const requestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('confirm'), title: bounded(16384), message: bounded(32768).optional() }).strict(),
  z.object({ method: z.literal('select'), title: bounded(16384), message: bounded(32768).optional(), options: z.tuple([z.literal('Allow once'), z.literal('Deny')]) }).strict(),
])
export const externalRequestIdSchema = bounded(200).refine(s => /^[a-zA-Z0-9_.:-]+$/.test(s))
export const externalInputSchema = z.object({
  externalRequestId: externalRequestIdSchema,
  taskId: bounded(200), sessionId: bounded(200), request: requestSchema,
  expiresAt: z.string().datetime({ offset: true }),
}).strict()
export type ExternalApprovalInput = z.infer<typeof externalInputSchema>
export const ackSchema = z.object({ status: z.enum(['applied', 'stale', 'failed']) }).strict()
export type AckStatus = z.infer<typeof ackSchema>['status']
export function normalizeExternalInput(raw: unknown): { input: ExternalApprovalInput; payloadHash: string } {
  const p = externalInputSchema.parse(raw)
  const request = { method: p.request.method, title: p.request.title,
    ...(p.request.message !== undefined ? { message: p.request.message } : {}),
    ...(p.request.method === 'select' ? { options: p.request.options } : {}) } as ExternalApprovalInput['request']
  const input = { externalRequestId: p.externalRequestId, taskId: p.taskId, sessionId: p.sessionId, request, expiresAt: new Date(p.expiresAt).toISOString() }
  return { input, payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex') }
}
/** Pins all configured authority/destination, but permits token rotation. */
export function sourceBinding(source: ExternalApprovalSource): string {
  return createHash('sha256').update(JSON.stringify([source.id, source.workspaceId, source.assistantId, source.approverUserId,
    source.channelType, source.channelId, source.channelIntegrationId ?? null])).digest('hex')
}
