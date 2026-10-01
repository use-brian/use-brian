/** Current destination-audience authorization for restricted output. [COMP:api/delivery-authority] */
import {
  intersectAccessCeilings,
  type AccessCeiling,
  type DeliveryAudienceDenialDetail,
  type ScopeEvidence,
} from '@use-brian/core'
import { parseTopicChannelId } from '@use-brian/channels'
import type { ChannelIntegrationStore, DeliveryAudienceBinding } from '../db/channel-integrations.js'
import { findSessionByChannel, findSessionById, isSharedAudienceSession, type Session } from '../db/sessions.js'
import { findAssistantById } from '../db/users.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { resolveLiveAccessCeilingSystem } from './resolve-turn-scope.js'
import { scopeEvidenceFailureOf, validateAudienceScopeEvidence, type ScopeEvidenceFailure } from './caller-evidence.js'
import { roomAudienceCeiling } from '../routes/_room-binding.js'

export type DeliveryAudienceInput = {
  workspaceId: string
  assistantId: string
  userId: string
  channelType: string
  channelId: string
  channelIntegrationId?: string
  sessionId?: string
  recipientType?: 'individual' | 'group'
  /**
   * How the recipient was resolved for this turn. A guest (channel DM from a
   * non-member, public API / share-link visitor) is `external`; a published
   * full-scope lane is `assistant`. Default `member`. Judging a guest as a
   * member refuses every turn, because the strict member lookup can never
   * find them.
   */
  recipientMode?: 'member' | 'external' | 'assistant'
  /**
   * Set ONLY by a live channel turn in a group, where `userId` is the verified
   * human who just spoke there. An owner or admin speaking in an approved
   * group may receive their own personal context in the reply: who else is in
   * that group is the group admin's responsibility, not a reason to refuse.
   * Workflows, relays and replays never set it, so they stay at the binding.
   */
  groupSpeaker?: boolean
  scopeEvidence?: ScopeEvidence
}

/**
 * Why a destination was refused, for choosing the user-facing explanation.
 * Deliberately coarse: it never names the Team, Project or clearance that
 * failed, so a refusal cannot become an existence oracle.
 */
export type { DeliveryAudienceDenialDetail } from '@use-brian/core'

/**
 * The exact rule that refused, for logs and analytics only. Unlike `detail`
 * it may be fine-grained, because it never reaches the model or the client;
 * without it every refusal reads the same and the incident behind it cannot
 * be told from a policy decision or a database timeout.
 */
export type DeliveryAudienceDiagnostic =
  | ScopeEvidenceFailure
  | 'session_missing'
  | 'session_assistant_missing'
  | 'session_not_owner'
  | 'member_not_found'
  | 'member_ceiling_error'
  | 'binding_audience_mismatch'
  | 'binding_expired'
  | 'binding_approver_not_admin'
  | 'binding_recipient_conflict'
  | 'no_binding_ceiling'

type Denial = {
  allowed: false
  reason: 'delivery_audience_unverified'
  detail?: DeliveryAudienceDenialDetail
  diagnostic?: DeliveryAudienceDiagnostic
}

export type DeliveryAudienceDecision =
  | { allowed: true; evidence: ScopeEvidence }
  | Denial

export type DeliveryAudienceEnvelopeDecision =
  | {
      allowed: true
      ceiling: AccessCeiling
      source: 'member' | 'binding' | 'public'
    }
  | Denial

export type AuthorizeDeliveryAudience = (
  input: DeliveryAudienceInput,
) => Promise<DeliveryAudienceDecision>

export type ResolveDeliveryAudienceEnvelope = (
  input: DeliveryAudienceInput,
) => Promise<DeliveryAudienceEnvelopeDecision>

export class DeliveryAudienceUnverifiedError extends Error {
  readonly reason = 'delivery_audience_unverified'
  readonly retrySafe = false
  readonly detail: DeliveryAudienceDenialDetail | undefined
  /** Internal only; see `DeliveryAudienceDiagnostic`. */
  readonly diagnostic: DeliveryAudienceDiagnostic | undefined
  constructor(detail?: DeliveryAudienceDenialDetail, diagnostic?: DeliveryAudienceDiagnostic) {
    super('The current destination is not authorized for this response.')
    this.name = 'DeliveryAudienceUnverifiedError'
    this.detail = detail
    this.diagnostic = diagnostic
  }
}

export function isDeliveryAudienceUnverifiedError(
  error: unknown,
): error is DeliveryAudienceUnverifiedError {
  return typeof error === 'object' && error !== null
    && (error as { reason?: unknown }).reason === 'delivery_audience_unverified'
}

type Dependencies = {
  integrationStore?: ChannelIntegrationStore
  now?: () => number
  findAssistant?: typeof findAssistantById
  findSession?: typeof findSessionById
  findChannelSession?: typeof findSessionByChannel
  getWorkspaceRole?: typeof getWorkspaceRoleSystem
  resolveLiveAccess?: typeof resolveLiveAccessCeilingSystem
  validateEvidence?: typeof validateAudienceScopeEvidence
}

function denial(detail?: DeliveryAudienceDenialDetail, diagnostic?: DeliveryAudienceDiagnostic): Denial {
  return {
    allowed: false,
    reason: 'delivery_audience_unverified',
    ...(detail ? { detail } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  }
}

function denied(detail?: DeliveryAudienceDenialDetail, diagnostic?: DeliveryAudienceDiagnostic): DeliveryAudienceDecision {
  return denial(detail, diagnostic)
}

function envelopeDenied(detail?: DeliveryAudienceDenialDetail, diagnostic?: DeliveryAudienceDiagnostic): DeliveryAudienceEnvelopeDecision {
  return denial(detail, diagnostic)
}

function externalAudienceType(channelType: string, channelId: string): 'individual' | 'group' | null {
  const bare = parseTopicChannelId(channelId).chatId
  if (channelType === 'telegram') return bare.startsWith('-') ? 'group' : 'individual'
  if (channelType === 'slack') return bare.startsWith('D') ? 'individual' : /^[CG]/.test(bare) ? 'group' : null
  if (channelType === 'whatsapp') {
    if (bare.endsWith('@g.us')) return 'group'
    if (bare.endsWith('@s.whatsapp.net') || /^\+?\d{8,15}$/.test(bare)) return 'individual'
  }
  return null
}

function bindingCeiling(
  workspaceId: string,
  binding: DeliveryAudienceBinding,
): AccessCeiling {
  return {
    workspaceId,
    userId: binding.recipientUserId ?? '',
    clearance: binding.clearance,
    compartments: [...binding.compartments],
    mutationCompartments: [...binding.compartments],
    projectIds: [...binding.projectIds],
    visibilityAssistantIds: null,
  }
}

type CeilingResult =
  | { ceiling: AccessCeiling; diagnostic?: undefined }
  | { ceiling: null; diagnostic: DeliveryAudienceDiagnostic }

/**
 * A workspace member as a RECIPIENT. Labels (clearance, Teams, Projects) stay
 * capped by the answering assistant, whose reads produced the evidence; the
 * assistant-visibility axis is dropped because assistants are readers, not
 * audiences. A member receiving on their own screen, DM, or (as an owner or admin)
 * an approved group they are speaking in may see any of their assistants' rows (decision D2). Consults keep the
 * axis: there the receiver IS an assistant (`validateCallerScopeEvidence`).
 */
async function memberCeiling(
  workspaceId: string,
  assistantId: string,
  userId: string,
  deps: Required<Pick<Dependencies, 'findAssistant' | 'resolveLiveAccess'>>,
  mode: DeliveryAudienceInput['recipientMode'] = 'member',
): Promise<CeilingResult> {
  const assistant = await deps.findAssistant(assistantId)
  if (!assistant || (assistant.workspaceId ?? '') !== workspaceId) {
    return { ceiling: null, diagnostic: 'session_assistant_missing' }
  }
  try {
    const ceiling = await deps.resolveLiveAccess({ userId, assistant, workspaceId, memberMode: mode })
    return { ceiling: { ...ceiling, visibilityAssistantIds: null } }
  } catch (error) {
    // A lost membership and a failed lookup both refuse, but only one of them
    // is a policy answer. Keep the cause in the log, never in the response.
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'context_not_available' || (error as Error)?.message === 'authority_unavailable') {
      return { ceiling: null, diagnostic: 'member_not_found' }
    }
    console.warn('[delivery-authority] member ceiling lookup failed:', (error as Error)?.message ?? error)
    return { ceiling: null, diagnostic: 'member_ceiling_error' }
  }
}

async function validate(
  evidence: ScopeEvidence,
  ceiling: AccessCeiling,
  validateEvidence: typeof validateAudienceScopeEvidence,
): Promise<DeliveryAudienceDecision> {
  try {
    return { allowed: true, evidence: await validateEvidence(evidence, ceiling) }
  } catch (error) {
    const diagnostic = scopeEvidenceFailureOf(error) ?? 'verification_error'
    if (diagnostic === 'verification_error') {
      const cause = (error as { cause?: unknown } | null)?.cause ?? error
      console.warn('[delivery-authority] evidence verification failed:', (cause as Error)?.message ?? cause)
    }
    return denied(undefined, diagnostic)
  }
}

async function integrationForTarget(
  input: DeliveryAudienceInput,
  store: ChannelIntegrationStore | undefined,
) {
  if (!store) return null
  return input.channelIntegrationId
    ? store.getCredentialsForAssistantIntegrationSystem(
        input.workspaceId,
        input.assistantId,
        input.channelIntegrationId,
        input.channelType,
        input.channelId,
      )
    : store.getCredentialsForAssistantSystem(input.assistantId, input.channelType)
}

function resolvedDependencies(dependencies: Dependencies) {
  return {
    now: dependencies.now ?? Date.now,
    findAssistant: dependencies.findAssistant ?? findAssistantById,
    findSession: dependencies.findSession ?? findSessionById,
    findChannelSession: dependencies.findChannelSession ?? findSessionByChannel,
    getWorkspaceRole: dependencies.getWorkspaceRole ?? getWorkspaceRoleSystem,
    resolveLiveAccess: dependencies.resolveLiveAccess ?? resolveLiveAccessCeilingSystem,
    validateEvidence: dependencies.validateEvidence ?? validateAudienceScopeEvidence,
    integrationStore: dependencies.integrationStore,
  }
}

async function resolveEnvelope(
  input: DeliveryAudienceInput,
  deps: ReturnType<typeof resolvedDependencies>,
): Promise<DeliveryAudienceEnvelopeDecision> {
  if (input.channelType === 'web' || input.channelType === 'notification') {
    const member = await memberCeiling(input.workspaceId, input.assistantId, input.userId, deps, input.recipientMode)
    return member.ceiling
      ? { allowed: true, ceiling: member.ceiling, source: 'member' }
      : envelopeDenied(undefined, member.diagnostic)
  }

  const inferredType = input.recipientType ?? externalAudienceType(input.channelType, input.channelId)
  if (inferredType === 'individual' && input.recipientType !== 'group') {
    const personalSession = await deps.findChannelSession({
      assistantId: input.assistantId,
      userId: input.userId,
      channelType: input.channelType,
      channelId: input.channelId,
    })
    if (personalSession && !isSharedAudienceSession(personalSession)) {
      const member = await memberCeiling(input.workspaceId, input.assistantId, input.userId, deps, input.recipientMode)
      if (member.ceiling) return { allowed: true, ceiling: member.ceiling, source: 'member' }
    }
  }

  const integration = await integrationForTarget(input, deps.integrationStore)
  const parsed = parseTopicChannelId(input.channelId)
  const bindings = integration?.config?.deliveryAudienceBindings?.filter((candidate) =>
    candidate.version === 1
    && (candidate.channelId === input.channelId || candidate.channelId === parsed.chatId),
  ) ?? []
  if (bindings.length === 0) {
    return {
      allowed: true,
      source: 'public',
      ceiling: {
        workspaceId: input.workspaceId,
        // This is an anonymous recipient. Keeping the actor empty is how the
        // final evidence check rejects personal rows even when the sender is a
        // workspace member.
        userId: '',
        clearance: 'public',
        compartments: [],
        mutationCompartments: [],
        projectIds: [],
        visibilityAssistantIds: null,
      },
    }
  }
  let ceiling: AccessCeiling | null = null
  for (const binding of bindings) {
    if (inferredType && binding.audienceType !== inferredType) return envelopeDenied(undefined, 'binding_audience_mismatch')
    if (binding.expiresAt) {
      const expiresAt = Date.parse(binding.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= deps.now()) return envelopeDenied(undefined, 'binding_expired')
    }
    const approverRole = await deps.getWorkspaceRole(binding.approvedByUserId, input.workspaceId)
    if (approverRole !== 'owner' && approverRole !== 'admin') return envelopeDenied(undefined, 'binding_approver_not_admin')

    let candidate = bindingCeiling(input.workspaceId, binding)
    if (binding.recipientUserId) {
      if (binding.audienceType !== 'individual') return envelopeDenied(undefined, 'binding_audience_mismatch')
      const current = await memberCeiling(
        input.workspaceId,
        input.assistantId,
        binding.recipientUserId,
        deps,
      )
      if (!current.ceiling) return envelopeDenied(undefined, current.diagnostic)
      candidate = intersectAccessCeilings(candidate, current.ceiling)
    }
    // A topic may inherit its parent-chat cap, but neither array order nor a
    // duplicate entry may widen it. Every applicable envelope participates.
    if (ceiling && ceiling.userId !== candidate.userId) return envelopeDenied(undefined, 'binding_recipient_conflict')
    ceiling = ceiling ? intersectAccessCeilings(ceiling, candidate) : candidate
  }
  if (!ceiling) return envelopeDenied(undefined, 'no_binding_ceiling')
  if (inferredType === 'group' && !ceiling.userId) {
    const speaker = await groupSpeakerCeiling(input, ceiling, deps)
    if (speaker) return { allowed: true, ceiling: speaker, source: 'binding' }
  }
  return { allowed: true, ceiling, source: 'binding' }
}

/**
 * An owner or admin speaking in an approved group gets their own personal
 * context, still capped by the group's approved labels and their own live
 * access. Anyone else (members, guests) stays at the shared binding, which
 * reads only unowned rows. A failed lookup degrades to that shared ceiling
 * rather than refusing the turn.
 */
async function groupSpeakerCeiling(
  input: DeliveryAudienceInput,
  shared: AccessCeiling,
  deps: ReturnType<typeof resolvedDependencies>,
): Promise<AccessCeiling | null> {
  if (!input.groupSpeaker || !input.userId || (input.recipientMode ?? 'member') !== 'member') return null
  const role = await deps.getWorkspaceRole(input.userId, input.workspaceId)
  if (role !== 'owner' && role !== 'admin') return null
  const member = await memberCeiling(input.workspaceId, input.assistantId, input.userId, deps)
  if (!member.ceiling) {
    console.warn('[delivery-authority] group speaker kept at the shared ceiling:', member.diagnostic)
    return null
  }
  return intersectAccessCeilings({ ...shared, userId: input.userId }, member.ceiling)
}

/** Resolve the current recipient ceiling before prompt/tool assembly. */
export function createDeliveryAudienceEnvelopeResolver(
  dependencies: Dependencies = {},
): ResolveDeliveryAudienceEnvelope {
  const deps = resolvedDependencies(dependencies)
  return (input) => resolveEnvelope(input, deps)
}

/**
 * Resolve and validate the audience immediately before output persistence/send.
 * The returned denial is intentionally opaque: hidden Team/Project names never
 * become an existence oracle in a delivery error.
 */
export function createDeliveryAudienceAuthorizer(dependencies: Dependencies = {}): AuthorizeDeliveryAudience {
  const deps = resolvedDependencies(dependencies)

  return async (input) => {
    const evidence = input.scopeEvidence ?? {}

    // An explicit origin session is an independent sink. Authorize it even
    // when the same relay also pushes to an external provider conversation.
    if (input.sessionId) {
      const session = await deps.findSession(input.sessionId)
      if (!session) return denied(undefined, 'session_missing')
      const owner = await deps.findAssistant(session.assistantId)
      if (!owner || (owner.workspaceId ?? '') !== input.workspaceId) {
        return denied(undefined, 'session_assistant_missing')
      }
      let ceiling: AccessCeiling
      if (isSharedAudienceSession(session)) {
        ceiling = roomAudienceCeiling(input.workspaceId, session)
      } else {
        if (session.userId !== input.userId) return denied(undefined, 'session_not_owner')
        // An owner's personal thread (decision D2): its audience is the owner,
        // resolved through the ANSWERING assistant, which on the doc dock may
        // differ from the session's bound one.
        const member = await memberCeiling(input.workspaceId, input.assistantId, session.userId, deps, input.recipientMode)
        if (!member.ceiling) return denied(undefined, member.diagnostic)
        ceiling = member.ceiling
      }
      const sink = await validate(evidence, ceiling, deps.validateEvidence)
      if (!sink.allowed) return denied(undefined, sink.diagnostic)
    }

    const envelope = await resolveEnvelope(input, deps)
    if (!envelope.allowed) return denied(envelope.detail, envelope.diagnostic)
    const decision = await validate(evidence, envelope.ceiling, deps.validateEvidence)
    if (decision.allowed) return decision
    return denied(envelope.source === 'public' ? 'unbound' : 'evidence_exceeds_audience', decision.diagnostic)
  }
}
