import { externalInputSchema } from './contracts.js'
import type { PendingApproval } from '../db/pending-approvals-store.js'

/** Display-only projection of the frozen request; never tool invocation input. */
export type ExternalActionConfirmation = {
  method?: 'question'
  allowCustom?: boolean
  approvalId: string
  title: string
  message?: string
  options?: string[]
  expiresAt: string
}

export function externalActionConfirmation(row: PendingApproval): ExternalActionConfirmation | null {
  if (row.kind !== 'external_action' || row.status !== 'pending' ||
      !(row.expiresAt instanceof Date) || !Number.isFinite(row.expiresAt.getTime()) ||
      row.expiresAt.getTime() <= Date.now()) return null
  const payload: unknown = row.approvalPayload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const request = (payload as Record<string, unknown>).request
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const body = request as Record<string, unknown>
  if (body.method === 'question') {
    const parsed = externalInputSchema.shape.request.safeParse(body)
    if (!parsed.success || parsed.data.method !== 'question') return null
    return { approvalId: row.id, ...parsed.data, expiresAt: row.expiresAt.toISOString() }
  }
  if ((body.method !== 'confirm' && body.method !== 'select') || typeof body.title !== 'string' ||
      (body.message !== undefined && typeof body.message !== 'string')) return null
  if (body.method === 'select' && (!Array.isArray(body.options) || body.options.length !== 2 ||
      body.options[0] !== 'Allow once' || body.options[1] !== 'Deny')) return null
  if (body.method === 'confirm' && body.options !== undefined) return null
  return {
    approvalId: row.id,
    title: body.title,
    ...(body.message !== undefined ? { message: body.message as string } : {}),
    ...(body.method === 'select' ? { options: ['Allow once', 'Deny'] } : {}),
    expiresAt: row.expiresAt.toISOString(),
  }
}
