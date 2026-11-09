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
  decide(source: ExternalApprovalSource, approvalId: string, userId: string, decision: 'approved' | 'rejected', actor?: HumanApprovalActor): Promise<ExternalApprovalState | null>
  sourceForApproval(id: string): Promise<{ sourceId: string; binding: string } | null>
}
/** Live workspace registration lookup; implementations must not cache authority. */
export interface ExternalApprovalSourceRegistry {
  get(id: string): Promise<ExternalApprovalSource | null>
  authenticate(header?: string): Promise<ExternalApprovalSource | null>
}
export type HumanApprovalActor = { userId: string; human: boolean; origin: 'ui' | 'channel' | 'model' | 'delegated'; grantAlways?: boolean; channelId?: string; channelIntegrationId?: string; threadRef?: string; providerUserId?: string; authSessionId?: string }
export class ExternalApprovalService {
  constructor(public sources: ExternalApprovalSourceRegistry, public store: ExternalApprovalStore,
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
    const source = binding && await this.sources.get(binding.sourceId)
    if (!source || !binding || sourceBinding(source) !== binding.binding || (source.audience !== 'conversation_members' && source.approverUserId !== actor.userId)) throw new ExternalApprovalError(404, 'Approval unavailable')
    if (actor.origin === 'channel' && (source.channelType === 'web' || !source.channelIntegrationId
      || actor.channelId !== source.channelId || actor.channelIntegrationId !== source.channelIntegrationId
      || (source.audience === 'conversation_members' && actor.threadRef !== source.threadRef))) {
      throw new ExternalApprovalError(404, 'Approval unavailable')
    }
    if (source.audience === 'conversation_members' && actor.origin === 'ui' && !actor.authSessionId) {
      throw new ExternalApprovalError(403, 'Authenticated human session required')
    }
    const state = source.audience === 'conversation_members'
      ? await this.store.decide(source, id, actor.userId, decision, actor)
      : await this.store.decide(source, id, actor.userId, decision)
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
