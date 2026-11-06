/** Explicit credential-bound logical work selection. [COMP:api/workspace-mcp] */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildTool, intersectAccessCeilings, scopeGrantContains, type ToolContext } from '@use-brian/core'
import { queryWithRLS } from '../db/client.js'
import { workspaceMcpMaximum, type WorkspaceMcpConsent } from './consent.js'
import { resolveLiveAccessCeilingSystem } from '../context-scope/resolve-turn-scope.js'
import { findAssistantById } from '../db/users.js'
import { createDbContextScopeStore } from '../db/context-scope-store.js'

export const DEFAULT_WORKSPACE_MCP_SELECTION = '00000000-0000-0000-0000-000000000000'
export function workspaceMcpConversationPath(workspaceId: string, sessionId: string) {
  return `/w/${encodeURIComponent(workspaceId)}/chat?${new URLSearchParams({ v: 'workspace', s: sessionId })}`
}
export function workspaceMcpContextBinding(context: ToolContext) {
  const identity = context.executionContext?.identity
  if (identity?.kind !== 'programmatic' || !['brain_key', 'assistant_key', 'oauth_token'].includes(identity.principal.kind)) throw new Error('workspace_mcp_authority_required')
  const prefix = `workspace-mcp:${identity.principal.kind}:${identity.principal.credentialId}`
  const channel = context.executionContext!.lifecycle.channelId
  const suffix = channel?.startsWith(`${prefix}:`) ? channel.slice(prefix.length + 1) : undefined
  if (suffix && !z.string().uuid().safeParse(suffix).success) throw new Error('workspace_mcp_context_unavailable')
  return { column: identity.principal.kind === 'brain_key' ? 'brain_key_id' : identity.principal.kind === 'oauth_token' ? 'oauth_authorization_id' : 'api_key_id',
    id: identity.principal.credentialId, selectionId: suffix ?? DEFAULT_WORKSPACE_MCP_SELECTION }
}
export type WorkspaceContextSelection = { selection_id: string; context_group_id: string | null; context_project_id: string | null; invalidated: boolean }
export async function readWorkspaceMcpSelection(context: ToolContext, handle: unknown) {
  const selection = z.string().uuid().parse(handle)
  const key = workspaceMcpContextBinding(context)
  const row = (await queryWithRLS<WorkspaceContextSelection>(context.userId,
    `SELECT selection_id,context_group_id,context_project_id,invalidated FROM workspace_mcp_contexts
     WHERE selection_id=$1 AND ${key.column}=$2 AND user_id=$3 AND workspace_id=$4 AND assistant_id=$5`,
    [selection, key.id, context.userId, context.workspaceId, context.assistantId])).rows[0]
  // Selection is metadata, also needed to inspect/cancel retained work. The
  // operation boundary and delegated runtime still reject invalidated sources.
  if (!row) throw new Error('workspace_mcp_context_unavailable')
  return row
}
export function createWorkspaceMcpContextTools(consentFor: (context: ToolContext) => Promise<WorkspaceMcpConsent>) {
  const create = buildTool({ name: 'createWorkspaceContext',
    description: 'Start fresh work in an admitted Department or Project. Returns a contextId for params._meta["usebrian.ai/context-id"] on subsequent discovery and calls. Does not reset old evidence, pending work or approvals.',
    inputSchema: z.object({ groupId: z.string().uuid().nullable().optional(), projectId: z.string().uuid().nullable().optional() }).strict(),
    isReadOnly: true,
    async execute(input, context) {
      const consent = await consentFor(context), key = workspaceMcpContextBinding(context)
      const groupId = input.groupId === undefined ? context.activeGroupId ?? consent.contextGroupId : input.groupId
      const projectId = input.projectId === undefined ? context.activeProjectId ?? consent.contextProjectId : input.projectId
      if (consent.contextGroupId && groupId !== consent.contextGroupId || consent.contextProjectId && projectId !== consent.contextProjectId
        || projectId && !consent.projectIds.includes(projectId)) throw new Error('workspace_mcp_context_unavailable')
      const assistant = await findAssistantById(context.assistantId)
      if (!assistant || assistant.workspaceId !== context.workspaceId) throw new Error('workspace_mcp_context_unavailable')
      // Selection is authority metadata. It never runs effects with a broader
      // nested caller projection; the new request materializes its own session.
      const current = await resolveLiveAccessCeilingSystem({ userId: context.userId, assistant,
        workspaceId: context.workspaceId!, key: { contextGroupId: groupId, contextProjectId: projectId } })
      const maximum = intersectAccessCeilings(current, workspaceMcpMaximum(consent, context.workspaceId!, context.userId))
      if (groupId) {
        const group = await createDbContextScopeStore().getTeamSystem(context.workspaceId!, groupId)
        if (!group || group.status !== 'active' || !scopeGrantContains(maximum.mutationCompartments, [group.compartmentKey])) throw new Error('workspace_mcp_context_unavailable')
      }
      if (projectId && !scopeGrantContains(maximum.projectIds, [projectId])) throw new Error('workspace_mcp_context_unavailable')
      await context.authority!.assertCurrent()
      const id = randomUUID()
      await queryWithRLS(context.userId, `INSERT INTO workspace_mcp_contexts(id,selection_id,workspace_id,user_id,assistant_id,${key.column},context_group_id,context_project_id)
        VALUES($1,$1,$2,$3,$4,$5,$6,$7)`, [id, context.workspaceId, context.userId, context.assistantId, key.id, groupId, projectId])
      return { data: { contextId: id, groupId, projectId } }
    },
  })
  const inspect = buildTool({ name: 'getWorkspaceContext', description: 'Inspect the selected connection context and its native conversation reference. No source content is returned.',
    inputSchema: z.object({}).strict(), isReadOnly: true,
    async execute(_input, context) {
      const key = workspaceMcpContextBinding(context)
      return { data: { contextId: key.selectionId === DEFAULT_WORKSPACE_MCP_SELECTION ? null : key.selectionId,
        sessionId: context.sessionId, workspaceId: context.workspaceId, assistantId: context.assistantId,
        openPath: workspaceMcpConversationPath(context.workspaceId!, context.sessionId),
        groupId: context.activeGroupId ?? null, projectId: context.activeProjectId ?? null } }
    } })
  return new Map([create, inspect].map(tool => [tool.name, tool]))
}
export const workspaceContextControlNames = new Set(['createWorkspaceContext', 'getWorkspaceContext'])
