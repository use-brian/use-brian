/** Current destination-audience authorization for restricted output. [COMP:api/delivery-authority] */
import {
  intersectAccessCeilings,
  type AccessCeiling,
  type ScopeEvidence,
} from '@use-brian/core'
import { parseTopicChannelId } from '@use-brian/channels'
import type { ChannelIntegrationStore, DeliveryAudienceBinding } from '../db/channel-integrations.js'
import { findSessionByChannel, findSessionById, type Session } from '../db/sessions.js'
import { findAssistantById } from '../db/users.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { resolveLiveAccessCeilingSystem } from './resolve-turn-scope.js'
import { validateAudienceScopeEvidence } from './caller-evidence.js'
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
  scopeEvidence?: ScopeEvidence
}

export type DeliveryAudienceDecision =
  | { allowed: true; evidence: ScopeEvidence }
  | { allowed: false; reason: 'delivery_audience_unverified' }

export type DeliveryAudienceEnvelopeDecision =
  | {
      allowed: true
      ceiling: AccessCeiling
      source: 'member' | 'binding' | 'public'
    }
  | { allowed: false; reason: 'delivery_audience_unverified' }

export type AuthorizeDeliveryAudience = (
  input: DeliveryAudienceInput,
) => Promise<DeliveryAudienceDecision>

export type ResolveDeliveryAudienceEnvelope = (
  input: DeliveryAudienceInput,
) => Promise<DeliveryAudienceEnvelopeDecision>

export class DeliveryAudienceUnverifiedError extends Error {
  readonly reason = 'delivery_audience_unverified'
  readonly retrySafe = false
  constructor() {
    super('The current destination is not authorized for this response.')
    this.name = 'DeliveryAudienceUnverifiedError'
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

function denied(): DeliveryAudienceDecision {
  return { allowed: false, reason: 'delivery_audience_unverified' }
}

function envelopeDenied(): DeliveryAudienceEnvelopeDecision {
  return { allowed: false, reason: 'delivery_audience_unverified' }
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

async function memberCeiling(
  workspaceId: string,
  assistantId: string,
  userId: string,
  deps: Required<Pick<Dependencies, 'findAssistant' | 'resolveLiveAccess'>>,
): Promise<AccessCeiling | null> {
  const assistant = await deps.findAssistant(assistantId)
  if (!assistant || (assistant.workspaceId ?? '') !== workspaceId) return null
  try {
    return await deps.resolveLiveAccess({ userId, assistant, workspaceId })
  } catch {
    return null
  }
}

async function validate(
  evidence: ScopeEvidence,
  ceiling: AccessCeiling,
  validateEvidence: typeof validateAudienceScopeEvidence,
): Promise<DeliveryAudienceDecision> {
  try {
    return { allowed: true, evidence: await validateEvidence(evidence, ceiling) }
  } catch {
    return denied()
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
    const ceiling = await memberCeiling(input.workspaceId, input.assistantId, input.userId, deps)
    return ceiling ? { allowed: true, ceiling, source: 'member' } : envelopeDenied()
  }

  const inferredType = input.recipientType ?? externalAudienceType(input.channelType, input.channelId)
  if (inferredType === 'individual' && input.recipientType !== 'group') {
    const personalSession = await deps.findChannelSession({
      assistantId: input.assistantId,
      userId: input.userId,
      channelType: input.channelType,
      channelId: input.channelId,
    })
    if (personalSession && personalSession.visibility !== 'workspace' && personalSession.mode !== 'draft') {
      const ceiling = await memberCeiling(input.workspaceId, input.assistantId, input.userId, deps)
      if (ceiling) return { allowed: true, ceiling, source: 'member' }
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
    if (inferredType && binding.audienceType !== inferredType) return envelopeDenied()
    if (binding.expiresAt) {
      const expiresAt = Date.parse(binding.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= deps.now()) return envelopeDenied()
    }
    const approverRole = await deps.getWorkspaceRole(binding.approvedByUserId, input.workspaceId)
    if (approverRole !== 'owner' && approverRole !== 'admin') return envelopeDenied()

    let candidate = bindingCeiling(input.workspaceId, binding)
    if (binding.recipientUserId) {
      if (binding.audienceType !== 'individual') return envelopeDenied()
      const current = await memberCeiling(
        input.workspaceId,
        input.assistantId,
        binding.recipientUserId,
        deps,
      )
      if (!current) return envelopeDenied()
      candidate = intersectAccessCeilings(candidate, current)
    }
    // A topic may inherit its parent-chat cap, but neither array order nor a
    // duplicate entry may widen it. Every applicable envelope participates.
    if (ceiling && ceiling.userId !== candidate.userId) return envelopeDenied()
    ceiling = ceiling ? intersectAccessCeilings(ceiling, candidate) : candidate
  }
  return ceiling
    ? { allowed: true, ceiling, source: 'binding' }
    : envelopeDenied()
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
      if (!session) return denied()
      const owner = await deps.findAssistant(session.assistantId)
      if (!owner || (owner.workspaceId ?? '') !== input.workspaceId) return denied()
      const shared = session.visibility === 'workspace' || session.mode === 'draft'
      const ceiling = shared
        ? roomAudienceCeiling(input.workspaceId, session)
        : session.userId === input.userId
          ? await memberCeiling(input.workspaceId, session.assistantId, session.userId, deps)
          : null
      if (!ceiling || !(await validate(evidence, ceiling, deps.validateEvidence)).allowed) return denied()
    }

    const envelope = await resolveEnvelope(input, deps)
    return envelope.allowed
      ? validate(evidence, envelope.ceiling, deps.validateEvidence)
      : denied()
  }
}
