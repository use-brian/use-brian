import { normalizeExternalInput, sourceBinding, type AckStatus, type ExternalApprovalInput, type ExternalApprovalSource } from './contracts.js'
export class ExternalApprovalError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export type ExternalApprovalState = {
  approvalId: string; externalRequestId: string; status: 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded'
  expiresAt: string; payloadHash: string; ackStatus?: AckStatus
}
export interface ExternalApprovalStore {
  /** Implementations serialize by (source,id), recheck authority and insert both rows atomically. */
  create(source: ExternalApprovalSource, input: ExternalApprovalInput, hash: string): Promise<{ state: ExternalApprovalState; created: boolean }>
  read(source: ExternalApprovalSource, id: string): Promise<ExternalApprovalState | null>
  ack(source: ExternalApprovalSource, id: string, status: AckStatus): Promise<ExternalApprovalState | null>
  cancel(source: ExternalApprovalSource, id: string): Promise<ExternalApprovalState | null>
  decide(source: ExternalApprovalSource, approvalId: string, userId: string, decision: 'approved' | 'rejected'): Promise<ExternalApprovalState | null>
  sourceForApproval(id: string): Promise<{ sourceId: string; binding: string } | null>
}
export type HumanApprovalActor = { userId: string; human: boolean; origin: 'ui' | 'channel' | 'model' | 'delegated'; grantAlways?: boolean; channelId?: string; channelIntegrationId?: string }
export class ExternalApprovalService {
  constructor(public sources: ExternalApprovalSource[], public store: ExternalApprovalStore,
    private notify?: (source: ExternalApprovalSource, state: ExternalApprovalState) => Promise<void>) {}
  async create(source: ExternalApprovalSource, raw: unknown) {
    const { input, payloadHash } = normalizeExternalInput(raw)
    const result = await this.store.create(source, input, payloadHash)
    // Notification outcome is never delivery evidence and never changes a decision.
    if (result.created) await this.notify?.(source, result.state).catch(() => {})
    return result.state
  }
  async resolve(id: string, decision: 'approved' | 'rejected', actor: HumanApprovalActor) {
    if (!actor.human || !['ui', 'channel'].includes(actor.origin) || actor.grantAlways) throw new ExternalApprovalError(403, 'Human one-time decision required')
    const binding = await this.store.sourceForApproval(id)
    const source = binding && this.sources.find(s => s.id === binding.sourceId && sourceBinding(s) === binding.binding)
    if (!source || source.approverUserId !== actor.userId) throw new ExternalApprovalError(404, 'Approval unavailable')
    if (actor.origin === 'channel' && (source.channelType === 'web' || !source.channelIntegrationId
      || actor.channelId !== source.channelId || actor.channelIntegrationId !== source.channelIntegrationId)) {
      throw new ExternalApprovalError(404, 'Approval unavailable')
    }
    const state = await this.store.decide(source, id, actor.userId, decision)
    if (!state) throw new ExternalApprovalError(404, 'Approval unavailable')
    return state
  }
}
let configured: ExternalApprovalService | undefined
export function configureExternalApprovals(service: ExternalApprovalService) { configured = service }
export function externalApprovals(): ExternalApprovalService {
  if (!configured) throw new ExternalApprovalError(404, 'External approvals disabled')
  return configured
}
