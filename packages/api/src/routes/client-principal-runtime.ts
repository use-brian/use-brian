/**
 * Reusable external-client execution authority.
 *
 * The public HTTP turn and principal-bound workflow consults must derive the
 * same shadow identity, memory exception, and immutable key tool ceiling. Keep
 * those decisions here so a new entry point cannot approximate the boundary
 * with prompt text.
 *
 * Spec: docs/architecture/features/public-api.md -> "Reusable
 * client-principal runtime".
 * [COMP:api/client-principal-runtime]
 */

import { canRead, clientCompartment } from '@use-brian/core'
import type { ApiKeyRow, ApiKeyStore, ApiKeyToolPolicy } from '../db/api-key-store.js'
import { isExternalPrincipal } from '../db/external-principal.js'
import {
  findOrCreateUser,
  findUserByEmail,
  type User,
} from '../db/users.js'

export type ResolvedExternalClientIdentity = {
  user: User
  identified: boolean
  external: boolean
}

export type ResolvedApiKeyClientPrincipal = ResolvedExternalClientIdentity & {
  key: Pick<ApiKeyRow, 'id' | 'assistantId' | 'scope' | 'audience' | 'toolPolicy' | 'status'>
  externalUserId: string
  clientSelfMemory: { compartment: string }
  writeCompartments: string[]
}

/** Error with a stable workflow/API reason that callers can surface typed. */
function principalError(message: string, reason: string): Error {
  return Object.assign(new Error(message), { reason })
}

/**
 * Resolve the durable external shadow shared by every client-facing entry
 * point. Claims are inputs to THIS call only; no pairing/contact row is read
 * back as authority.
 */
export async function resolveExternalClientIdentity(params: {
  identityNamespace: string
  externalUserId: string
  externalUserName?: string
  claimedEmail?: string | null
  identified?: boolean
}): Promise<ResolvedExternalClientIdentity> {
  const authProviderId = `${params.identityNamespace}:${params.externalUserId}`
  const wantsIdentified = params.identified === true || !!params.claimedEmail
  let user: User

  if (wantsIdentified && params.claimedEmail) {
    const existing = await findUserByEmail(params.claimedEmail)
    if (existing) {
      user = existing
    } else {
      ;({ user } = await findOrCreateUser({
        authProvider: 'channel',
        authProviderId,
        email: params.claimedEmail,
        name: params.externalUserName,
      }))
    }
  } else {
    ;({ user } = await findOrCreateUser({
      authProvider: 'channel',
      authProviderId,
      name: params.externalUserName ?? (wantsIdentified ? undefined : `api:${params.externalUserId}`),
    }))
  }

  return {
    user,
    identified: wantsIdentified,
    external: isExternalPrincipal(user),
  }
}

/** The memory-only exact client projection. No other resource consumes it. */
export function resolveClientSelfMemory(params: {
  isExternal: boolean
  isIdentified: boolean
  assistantKind: 'primary' | 'standard' | 'app'
  assistantClearance: 'public' | 'internal' | 'confidential'
  workspaceId: string | null
  externalUserId: string
}): { compartment: string } | null {
  if (
    !params.isExternal
    || !params.isIdentified
    || !params.workspaceId
    || params.assistantKind === 'primary'
    || !canRead(params.assistantClearance, 'internal')
  ) return null
  return { compartment: clientCompartment(params.externalUserId) }
}

/**
 * Resolve a stored workflow binding against the live key on every consult.
 * The key secret is never needed: the workflow already runs inside the
 * trusted server and the row is the immutable capability configuration.
 */
export async function resolveApiKeyClientPrincipal(params: {
  apiKeyStore: Pick<ApiKeyStore, 'getByIdSystem'>
  apiKeyId: string
  externalUserId: string
  assistant: {
    id: string
    workspaceId: string | null
    kind: 'primary' | 'standard' | 'app'
    clearance: 'public' | 'internal' | 'confidential'
  }
}): Promise<ResolvedApiKeyClientPrincipal> {
  const key = await params.apiKeyStore.getByIdSystem(params.apiKeyId)
  if (!key || key.status !== 'active') {
    throw principalError('The workflow client API key is missing or revoked.', 'client_principal_key_inactive')
  }
  if (key.audience !== 'external' || key.scope !== 'chat') {
    throw principalError(
      'The workflow client API key must be an external chat key.',
      'client_principal_key_incompatible',
    )
  }
  if (key.assistantId !== params.assistant.id) {
    throw principalError(
      'The workflow client API key does not belong to the target assistant.',
      'client_principal_assistant_mismatch',
    )
  }

  const identity = await resolveExternalClientIdentity({
    identityNamespace: `api:${key.id}`,
    externalUserId: params.externalUserId,
    identified: true,
  })
  const clientSelfMemory = resolveClientSelfMemory({
    isExternal: identity.external,
    isIdentified: identity.identified,
    assistantKind: params.assistant.kind,
    assistantClearance: params.assistant.clearance,
    workspaceId: params.assistant.workspaceId,
    externalUserId: params.externalUserId,
  })
  if (!identity.external || !clientSelfMemory) {
    throw principalError(
      'The target assistant cannot provide the external-client self-memory surface.',
      'client_principal_assistant_incompatible',
    )
  }

  return {
    ...identity,
    key: {
      id: key.id,
      assistantId: key.assistantId,
      scope: key.scope,
      audience: key.audience,
      toolPolicy: key.toolPolicy,
      status: key.status,
    },
    externalUserId: params.externalUserId,
    clientSelfMemory,
    writeCompartments: [clientSelfMemory.compartment],
  }
}

/** Apply the key's immutable public-research ceiling to an entry point. */
export function applyPublicResearchToolCeiling<T>(params: {
  tools: Map<string, T>
  toolPolicy: ApiKeyToolPolicy | undefined
  internalScope: boolean
  allowPublicResearch: boolean
}): boolean {
  if (params.toolPolicy !== 'public_research' || params.internalScope) return false
  const allowed = params.allowPublicResearch
    ? new Set(['webSearch', 'urlReader'])
    : new Set<string>()
  for (const name of params.tools.keys()) {
    if (!allowed.has(name)) params.tools.delete(name)
  }
  return true
}
