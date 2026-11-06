import { workspaceMcpContextBinding, DEFAULT_WORKSPACE_MCP_SELECTION } from './contexts.js'
/** Durable parent proof for workspace MCP continuations. [COMP:api/workspace-mcp] */
import { createHash } from 'node:crypto'
import { WorkspaceCredentialDelegationSchema, bindWorkspaceCredentialDelegation, intersectAccessCeilings, ContextScopeAccumulator, executionToolContext, type CapabilityStore, type ToolContext } from '@use-brian/core'
import { findSessionById } from '../db/sessions.js'
import { query } from '../db/client.js'
import { findAssistantById } from '../db/users.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { resolveExecutionContextSystem } from '../context-scope/execution-context.js'
import { readWorkspaceMcpConsent, workspaceMcpMaximum } from './consent.js'

export type WorkspaceMcpDelegation = import('@use-brian/core').WorkspaceCredentialDelegation

type Parent = { actor: string; workspace: string; owner: string; assistant: string; fingerprint: string; consent: unknown; status: string; audience?: string }
async function readParent(kind: WorkspaceMcpDelegation['kind'], id: string): Promise<Parent | null> {
  // Only credential metadata crosses this trusted lookup. The secret hash is
  // reduced to a revision digest and never persisted in a continuation.
  if (kind === 'oauth_token') {
    const row = (await query<Parent>(`SELECT k.user_id AS actor,w.id AS workspace,w.owner_user_id AS owner,a.id AS assistant,
      'active' AS status,k.audience,k.workspace_mcp_consent AS consent,
      jsonb_build_array(k.id,k.client_id,k.user_id,k.workspace_id,k.scope,k.audience,k.bound_assistant_id,k.workspace_mcp_consent)::text AS fingerprint
      FROM oauth_authorizations k JOIN oauth_clients c ON c.client_id=k.client_id AND c.revoked_at IS NULL
      JOIN assistants a ON a.id=(k.workspace_mcp_consent->>'assistantId')::uuid AND a.workspace_id=k.workspace_id
      JOIN workspaces w ON w.id=k.workspace_id WHERE k.id=$1 AND k.revoked_at IS NULL
      AND (k.audience='brain' AND a.kind='primary' OR k.audience='assistant' AND k.bound_assistant_id=a.id)`,[id])).rows[0]
    return row ? { ...row, fingerprint: createHash('sha256').update(row.fingerprint).digest('hex') } : null
  }
  const brain = kind === 'brain_key'
  const row = (await query<Parent>(`
    SELECT coalesce(k.issuer_user_id,k.created_by) AS actor, w.id AS workspace,
      w.owner_user_id AS owner, a.id AS assistant, k.status,
      k.workspace_mcp_consent AS consent,
      (to_jsonb(k)-'last_used_at'-'created_at'-'key_prefix')::text AS fingerprint
    FROM ${brain ? 'brain_keys' : 'api_keys'} k
    JOIN assistants a ON ${brain ? "a.id=(k.workspace_mcp_consent->>'assistantId')::uuid AND a.workspace_id=k.workspace_id AND a.kind='primary'" : 'a.id=k.assistant_id'}
    JOIN workspaces w ON w.id=a.workspace_id WHERE k.id=$1`, [id])).rows[0]
  if (!row || row.status !== 'active' || !row.actor || !row.consent) return null
  return { ...row, fingerprint: createHash('sha256').update(row.fingerprint).digest('hex') }
}

export async function captureWorkspaceMcpDelegation(context: ToolContext): Promise<WorkspaceMcpDelegation> {
  const execution = context.executionContext, identity = execution?.identity
  if (!execution || identity?.kind !== 'programmatic' || !['brain_key','assistant_key','oauth_token'].includes(identity.principal.kind)
    || !context.workspaceId || context.sessionPersisted !== true) throw new Error('workspace_mcp_parent_required')
  await execution.security.authority.assertCurrent()
  const row = await readParent(identity.principal.kind as WorkspaceMcpDelegation['kind'], identity.principal.credentialId)
  if (!row || row.actor !== context.userId || row.workspace !== context.workspaceId || row.assistant !== context.assistantId
    || !readWorkspaceMcpConsent(row.consent)) throw new Error('workspace_mcp_parent_unavailable')
  await execution.security.authority.assertCurrent()
  return { kind: identity.principal.kind as WorkspaceMcpDelegation['kind'], credentialId: identity.principal.credentialId, revision: row.fingerprint,
    ...(workspaceMcpContextBinding(context).selectionId !== DEFAULT_WORKSPACE_MCP_SELECTION ? { selectionId: workspaceMcpContextBinding(context).selectionId } : {}),
    userId: context.userId, workspaceId: context.workspaceId, assistantId: context.assistantId, sessionId: context.sessionId }
}

export async function restoreWorkspaceMcpDelegation(parent: WorkspaceMcpDelegation, capabilities: CapabilityStore): Promise<{ context: ToolContext; consent: import('./consent.js').WorkspaceMcpConsent }> {
  parent = WorkspaceCredentialDelegationSchema.parse(parent)
  const constraints = await Promise.all((parent.constraints ?? []).map(item => restoreWorkspaceMcpDelegation(item,capabilities)))
  if (constraints.some(item => item.context.userId !== parent.userId || item.context.workspaceId !== parent.workspaceId)) throw new Error('workspace_mcp_parent_mismatch')
  const column = parent.kind === 'brain_key' ? 'brain_key_id' : parent.kind === 'oauth_token' ? 'oauth_authorization_id' : 'api_key_id'
  const readContext = async () => (await query<{id:string;invalidated:boolean;evidence:import('@use-brian/core').ScopeEvidence}>(
    `SELECT id,invalidated,evidence FROM workspace_mcp_contexts WHERE ${column}=$1 AND selection_id=$2 AND user_id=$3 AND workspace_id=$4 AND assistant_id=$5`,
    [parent.credentialId,parent.selectionId ?? DEFAULT_WORKSPACE_MCP_SELECTION,parent.userId,parent.workspaceId,parent.assistantId])).rows[0]
  const saved = await readContext()
  const session = await findSessionById(parent.sessionId)
  const channel = `workspace-mcp:${parent.kind}:${parent.credentialId}${parent.selectionId ? `:${parent.selectionId}` : ''}`
  if (!saved || saved.invalidated || !session || session.assistantId !== parent.assistantId || session.userId !== parent.userId
    || session.channelId !== channel) throw new Error('workspace_mcp_context_unavailable')
  const current = async () => {
    const row = await readParent(parent.kind, parent.credentialId)
    if (!row || row.fingerprint !== parent.revision || row.actor !== parent.userId
      || row.workspace !== parent.workspaceId || row.assistant !== parent.assistantId) return null
    try { if (!readWorkspaceMcpConsent(row.consent)) return null } catch { return null }
    const state = await readContext()
    if (!state || state.invalidated) return null
    try {
      for (const constraint of constraints) await constraint.context.authority!.assertCurrent()

    } catch {
      await query('UPDATE workspace_mcp_contexts SET invalidated=true WHERE id=$1',[saved.id])
      return null
    }
    return await getWorkspaceRoleSystem(parent.userId, parent.workspaceId) ? row : null
  }
  const row = await current()
  if (!row) throw new Error('workspace_mcp_parent_unavailable')
  const originalConsent = readWorkspaceMcpConsent(row.consent)!
  const consent = { ...originalConsent,
    operationNames: originalConsent.operationNames.filter(name => constraints.every(item => item.consent.operationNames.includes(name))),
    connectorBindings: Object.fromEntries(Object.entries(originalConsent.connectorBindings).filter(([id,hash]) => constraints.every(item => item.consent.connectorBindings[id] === hash))),
  }
  let maximum = workspaceMcpMaximum(consent,parent.workspaceId,parent.userId)
  for (const constraint of constraints) maximum = intersectAccessCeilings(maximum,constraint.context.executionContext!.security.ceiling)
  const assistant = await findAssistantById(parent.assistantId)
  if (!assistant || assistant.workspaceId !== parent.workspaceId) throw new Error('workspace_mcp_parent_unavailable')
  const { executionContext, turnScope } = await resolveExecutionContextSystem({
    userId: parent.userId, assistant, workspaceId: parent.workspaceId,
    session, sessionAuthority: session, sharedAudience: true, maximumAccess: maximum,
    provenance: saved.evidence,
    credentialCurrent: async () => !!await current(),
    identity: { kind: 'programmatic', principal: { kind: parent.kind, credentialId: parent.credentialId, actorUserId: parent.userId },
      credentialOwnerUserId: row.owner },
    ownership: { kind: 'workspace', workspaceId: parent.workspaceId },
    lifecycle: { abortSignal: new AbortController().signal, sessionId: parent.sessionId, sessionPersisted: true,
      channelType: session.channelType, channelId: channel },
    attribution: { credentialOwnerUserId: row.owner, billingUserId: row.owner },
  })
  bindWorkspaceCredentialDelegation(executionContext,parent)
  const context: ToolContext = { ...executionToolContext(executionContext, { appId: assistant.id }),
    activeCapabilities: new Set(await capabilities.listActive(assistant.id)),
    activeGroupId: turnScope.activeGroupId, activeProjectId: turnScope.activeProjectId,
    scopeAccumulator: new ContextScopeAccumulator({ compartments: turnScope.writeCompartments, projectIds: turnScope.writeProjectIds }) }
  context.scopeAccumulator!.note(saved.evidence)
  for (const constraint of constraints) context.scopeAccumulator!.note(constraint.context.scopeAccumulator!.evidence)
  await executionContext.security.authority.assertCurrent()
  return { context, consent }
}
