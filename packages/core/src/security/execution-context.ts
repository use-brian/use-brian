import type { CurrentAuthorityBoundary, ToolContext } from '../tools/types.js'
import type { AccessContext, AssistantKind } from './access-context.js'
import {
  intersectAccessCeilings,
  pinAccessCeiling,
  type AccessCeiling,
} from './access-ceiling.js'
import { scopeGrantContains, type ScopeEvidence, type ScopeGrant } from './context-scope.js'
import type { Sensitivity } from './sensitivity.js'

export type AttendedExecutionIdentity = {
  kind: 'attended'
  principal:
    | { kind: 'workspace_member'; userId: string }
    | { kind: 'verified_channel_guest'; userId: string; provider: string; externalId: string }
}

export type DelegatedExecutionIdentity = {
  kind: 'delegated'
  actorUserId: string
  delegationId: string
  parentCeiling: AccessCeiling
}

export type ProgrammaticExecutionIdentity = {
  kind: 'programmatic'
  principal:
    | { kind: 'brain_key' | 'oauth_token' | 'home_app'; credentialId: string; actorUserId?: string }
    | { kind: 'public_share'; credentialId: string; actorUserId: string }
  credentialOwnerUserId: string
}

export type SystemExecutionPurpose =
  | 'scheduled_job'
  | 'workflow'
  | 'worker'
  | 'ingest'
  | 'session_resume'
  | 'maintenance'

export type SystemExecutionIdentity = {
  kind: 'system'
  purpose: SystemExecutionPurpose
  jobId: string
}

export type ExecutionIdentity =
  | AttendedExecutionIdentity
  | DelegatedExecutionIdentity
  | ProgrammaticExecutionIdentity
  | SystemExecutionIdentity

export type ExecutionOwnership =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'personal'; ownerUserId: string }

export type ResolvedExecutionAccess = AccessContext & {
  workspaceId: string
  userId: string
  assistantId: string
  assistantKind: AssistantKind
  clearance: Sensitivity
  compartments: ScopeGrant
  mutationCompartments: ScopeGrant
  projectIds: ScopeGrant
  visibilityAssistantIds: ScopeGrant
}

export type ExecutionSecurityContext = {
  access: ResolvedExecutionAccess
  ceiling: AccessCeiling
  writeDefaults: { compartments: string[]; projectIds: string[] }
  provenance: ScopeEvidence
  authority: CurrentAuthorityBoundary
}

export type ExecutionLifecycle = {
  abortSignal: AbortSignal
  sessionId: string
  channelType: string
  channelId: string
  /**
   * The wire carrying the turn (`web`, `telegram`, ...), when it differs from
   * the session's stored `channelType` (an anchored web thread). Transport
   * capabilities (documents, views) read it; absent = `channelType`.
   */
  transport?: string
}

export type ExecutionSurfaceCapabilities = {
  systemRead?: true
  clientSelfMemory?: { compartment: string }
  readOnly?: true
}

export type ExecutionAttribution = {
  billingUserId?: string
  credentialOwnerUserId?: string
}

export type ExecutionContext = {
  identity: ExecutionIdentity
  ownership: ExecutionOwnership
  assistant: { id: string; kind: AssistantKind }
  security: ExecutionSecurityContext
  lifecycle: ExecutionLifecycle
  surface: ExecutionSurfaceCapabilities
  attribution: ExecutionAttribution
}

export type CreateExecutionContextInput = {
  identity: ExecutionIdentity
  ownership: ExecutionOwnership
  access: ResolvedExecutionAccess
  writeDefaults: { compartments: readonly string[]; projectIds: readonly string[] }
  provenance?: ScopeEvidence
  authority: CurrentAuthorityBoundary
  lifecycle: ExecutionLifecycle
  surface?: ExecutionSurfaceCapabilities
  attribution?: ExecutionAttribution
}

function required(value: string, field: string): string {
  if (!value.trim()) throw new Error(`execution_context_invalid:${field}`)
  return value
}

function canonical(values: readonly string[]): string[] {
  if (values.some((value) => !value.trim())) {
    throw new Error('execution_context_invalid:write_defaults')
  }
  return [...new Set(values)].sort()
}

function validateIdentity(identity: ExecutionIdentity, actorUserId: string): void {
  if (identity.kind === 'attended') {
    required(identity.principal.userId, 'principal')
    if (identity.principal.userId !== actorUserId) throw new Error('execution_actor_mismatch')
    if (identity.principal.kind === 'verified_channel_guest') {
      required(identity.principal.provider, 'provider')
      required(identity.principal.externalId, 'external_id')
    }
  } else if (identity.kind === 'delegated') {
    required(identity.actorUserId, 'actor')
    required(identity.delegationId, 'delegation')
    if (identity.actorUserId !== actorUserId) throw new Error('execution_actor_mismatch')
  } else if (identity.kind === 'programmatic') {
    required(identity.principal.credentialId, 'credential')
    required(identity.credentialOwnerUserId, 'credential_owner')
  } else {
    required(identity.jobId, 'job')
  }
}

/** Validate and freeze the facts every production execution must carry. */
export function createExecutionContext(input: CreateExecutionContextInput): ExecutionContext {
  required(input.access.userId, 'actor')
  required(input.access.assistantId, 'assistant')
  validateIdentity(input.identity, input.access.userId)

  if (input.ownership.kind === 'workspace') {
    required(input.ownership.workspaceId, 'workspace')
    if (input.ownership.workspaceId !== input.access.workspaceId) {
      throw new Error('execution_ownership_mismatch')
    }
  } else {
    required(input.ownership.ownerUserId, 'owner')
    if (input.access.workspaceId !== '') throw new Error('execution_ownership_mismatch')
  }

  let ceiling = pinAccessCeiling(input.access)
  if (input.identity.kind === 'delegated') {
    ceiling = intersectAccessCeilings(ceiling, input.identity.parentCeiling)
  }

  const writeCompartments = canonical(input.writeDefaults.compartments)
  const writeProjectIds = canonical(input.writeDefaults.projectIds)
  if (!scopeGrantContains(ceiling.mutationCompartments, writeCompartments)) {
    throw new Error('execution_write_default_outside_mutation_grant')
  }
  if (!scopeGrantContains(ceiling.projectIds, writeProjectIds)) {
    throw new Error('execution_write_default_outside_project_grant')
  }

  const surface = input.surface ?? {}
  if (surface.systemRead && !input.access.systemRead) {
    throw new Error('execution_surface_mismatch:system_read')
  }
  if (surface.clientSelfMemory) {
    if (input.identity.kind !== 'programmatic') {
      throw new Error('execution_surface_mismatch:client_self_memory')
    }
    if (input.access.clientSelfMemory?.compartment !== surface.clientSelfMemory.compartment) {
      throw new Error('execution_surface_mismatch:client_self_memory')
    }
  }

  const access: ResolvedExecutionAccess = {
    ...input.access,
    ...(ceiling.departmentRead ? { departmentRead: ceiling.departmentRead } : {}),
    clearance: ceiling.clearance,
    compartments: ceiling.compartments,
    mutationCompartments: ceiling.mutationCompartments,
    projectIds: ceiling.projectIds,
    visibilityAssistantIds: ceiling.visibilityAssistantIds,
  }

  return Object.freeze({
    identity: input.identity,
    ownership: input.ownership,
    assistant: Object.freeze({ id: access.assistantId, kind: access.assistantKind }),
    security: Object.freeze({
      access: Object.freeze(access),
      ceiling: Object.freeze(ceiling),
      writeDefaults: Object.freeze({
        compartments: Object.freeze(writeCompartments) as unknown as string[],
        projectIds: Object.freeze(writeProjectIds) as unknown as string[],
      }),
      provenance: Object.freeze(structuredClone(input.provenance ?? {})),
      authority: input.authority,
    }),
    lifecycle: Object.freeze(input.lifecycle),
    surface: Object.freeze(surface),
    attribution: Object.freeze(input.attribution ?? {}),
  })
}

/** One adapter projection for code that still consumes flat ToolContext fields. */
export function executionToolContext(
  execution: ExecutionContext,
  base: Pick<ToolContext, 'appId'>,
): Pick<ToolContext,
  | 'userId'
  | 'workspaceActorUserId'
  | 'assistantId'
  | 'sessionId'
  | 'appId'
  | 'channelType'
  | 'channelId'
  | 'transport'
  | 'attended'
  | 'workspaceId'
  | 'assistantKind'
  | 'visibilityAssistantIds'
  | 'abortSignal'
  | 'authority'
  | 'clearance'
  | 'compartments'
  | 'mutationCompartments'
  | 'projectIds'
  | 'assistantClearance'
  | 'assistantCompartments'
  | 'assistantDefaultCompartments'
  | 'assistantProjectIds'
  | 'assistantDefaultProjectIds'
  | 'systemRead'
  | 'clientSelfMemory'
  | 'executionContext'
> {
  const { access } = execution.security
  const attendedActor = execution.identity.kind === 'attended'
    && execution.identity.principal.kind === 'workspace_member'
    ? execution.identity.principal.userId
    : undefined
  return {
    userId: access.userId,
    workspaceActorUserId: attendedActor,
    assistantId: access.assistantId,
    sessionId: execution.lifecycle.sessionId,
    appId: base.appId,
    channelType: execution.lifecycle.channelType,
    channelId: execution.lifecycle.channelId,
    transport: execution.lifecycle.transport ?? execution.lifecycle.channelType,
    attended: execution.identity.kind === 'attended',
    workspaceId: execution.ownership.kind === 'workspace' ? execution.ownership.workspaceId : null,
    assistantKind: access.assistantKind,
    visibilityAssistantIds: access.visibilityAssistantIds,
    abortSignal: execution.lifecycle.abortSignal,
    authority: execution.security.authority,
    clearance: access.clearance,
    compartments: access.compartments,
    mutationCompartments: access.mutationCompartments,
    projectIds: access.projectIds,
    assistantClearance: access.clearance,
    assistantCompartments: access.compartments,
    assistantDefaultCompartments: execution.security.writeDefaults.compartments,
    assistantProjectIds: access.projectIds,
    assistantDefaultProjectIds: execution.security.writeDefaults.projectIds,
    systemRead: execution.surface.systemRead,
    clientSelfMemory: execution.surface.clientSelfMemory,
    executionContext: execution,
  }
}
