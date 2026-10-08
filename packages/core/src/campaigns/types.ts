/** Canonical campaign command/read ports. [COMP:campaigns/contracts] */
import { createHash } from 'node:crypto'
import type {
  CampaignEmailMetadata,
  CampaignTrustedConversion,
  CampaignUtm,
  CampaignChannel,
} from '@use-brian/shared/campaigns'

export type CampaignActor = Readonly<{
  kind: 'user' | 'assistant' | 'brain_key' | 'oauth_token' | 'home_app' | 'workflow' | 'system_job'
  userId?: string
  assistantId?: string
  credentialId?: string
  sessionId?: string
}>

export type CampaignAuthority = Readonly<{
  role: 'owner' | 'admin' | 'member'
  canRead: boolean
  canWrite: boolean
  canConfigure: boolean
  canSend: boolean
  allowedCampaignIds?: readonly string[]
  allowedSiteIds?: readonly string[]
}>

export type CampaignContext = Readonly<{
  workspaceId: string
  actor: CampaignActor
  authority: CampaignAuthority
}>

export type CampaignCommand =
  | { kind: 'save_campaign'; campaignId?: string; name: string; objective: string; timezone: string; primaryConversion: string; startsAt?: string | null; endsAt?: string | null; expectedVersion?: number }
  | { kind: 'archive_campaign'; campaignId: string }
  | { kind: 'attach_content'; campaignId: string; sessionId: string; channel: CampaignChannel; placementKind: 'body' | 'first_comment' | 'profile' | 'email_body'; placementKey: string }
  | { kind: 'record_manual_publication'; placementId: string; permalink: string; publishedAt: string; approvedRevision: number }
  | { kind: 'create_link'; campaignId: string; placementId: string; destination: string; utm: CampaignUtm; existingAttribution: 'reject' | 'replace' | 'retain' }
  | { kind: 'set_link_enabled'; linkId: string; enabled: boolean }
  | { kind: 'save_site'; siteId?: string; expectedVersion?: number; name: string; allowedOrigins: string[]; conversionDefinitions: Array<{ key: 'signup_completed' | 'enquiry_submitted' | 'activation_completed'; label: string; enabled: boolean }>; storageMode: 'none' | 'first_party'; cookieDomain?: string | null; siteGroupKey?: string | null; rawRetentionDays: number; aggregateRetentionMonths: number }
  | { kind: 'record_conversion'; conversion: CampaignTrustedConversion }
  | { kind: 'send_test'; campaignId: string; placementId: string; approvedRevision: number; contactId: string; deliveryId: string }
  | { kind: 'prepare_dispatch'; campaignId: string; placementId: string; approvedRevision: number; metadata: CampaignEmailMetadata; scheduledAt?: string | null; recipients: Array<{ contactId: string; address: string; personalization: Record<string, string>; eligibility: Record<string, unknown> }> }
  | { kind: 'schedule_dispatch'; dispatchId: string; scheduledAt: string }
  | { kind: 'pause_dispatch' | 'cancel_dispatch'; dispatchId: string }

export type CampaignCommandRequest = Readonly<{
  idempotencyKey: string
  command: CampaignCommand
}>

export type CampaignCommandReceipt = Readonly<{
  idempotencyKey: string
  fingerprint: string
  replayed: boolean
  result: Record<string, unknown>
}>

export type CampaignServicePort = {
  execute(context: CampaignContext, request: CampaignCommandRequest): Promise<CampaignCommandReceipt>
}

export type CampaignReadPort = {
  listCampaigns(workspaceId: string, filters?: { state?: string; limit?: number; cursor?: string }): Promise<Record<string, unknown>[]>
  getCampaign(workspaceId: string, campaignId: string): Promise<Record<string, unknown> | null>
  listLinks(workspaceId: string, campaignId: string): Promise<Record<string, unknown>[]>
  getTrackingSetup(workspaceId: string, siteId?: string): Promise<Record<string, unknown>>
  getResults(workspaceId: string, campaignId: string, filters?: Record<string, unknown>): Promise<Record<string, unknown>>
  getAttribution(workspaceId: string, campaignId: string, filters?: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Scoped to what `actor` may read: hidden contacts and evidence never shape the audience. */
  previewAudience(workspaceId: string, input: Record<string, unknown>, actor: CampaignActor): Promise<Record<string, unknown>>
  previewEmail(workspaceId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>
}

export class CampaignError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'forbidden' | 'conflict' | 'unavailable' | 'rate_limited',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'CampaignError'
  }
}

function sortForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForFingerprint)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortForFingerprint(child)]))
  }
  return value
}

export function campaignRequestFingerprint(command: CampaignCommand): string {
  return createHash('sha256').update(JSON.stringify(sortForFingerprint(command))).digest('hex')
}

export function requireCampaignAuthority(
  context: CampaignContext,
  action: 'read' | 'write' | 'configure' | 'send',
  resource?: { campaignId?: string; siteId?: string },
): void {
  const allowed = action === 'read' ? context.authority.canRead
    : action === 'write' ? context.authority.canWrite
      : action === 'configure' ? context.authority.canConfigure
        : context.authority.canSend
  if (!allowed) throw new CampaignError('forbidden', `Campaign ${action} authority is required.`)
  if (resource?.campaignId && context.authority.allowedCampaignIds
    && !context.authority.allowedCampaignIds.includes(resource.campaignId)) {
    throw new CampaignError('forbidden', 'The campaign is outside this credential scope.')
  }
  if (resource?.siteId && context.authority.allowedSiteIds
    && !context.authority.allowedSiteIds.includes(resource.siteId)) {
    throw new CampaignError('forbidden', 'The site is outside this credential scope.')
  }
}
