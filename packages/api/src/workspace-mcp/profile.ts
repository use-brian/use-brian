import { bindWorkspaceCredentialDelegation } from '@use-brian/core'
import { assertSourceModelInputAuthority, assertSourceModelOutputAuthority } from '../application-platform/model-source-authority.js'
import { createWorkspaceMcpContextTools, readWorkspaceMcpSelection, workspaceContextControlNames } from './contexts.js'
/** Native registry composition and verified issuance for workspace MCP. [COMP:api/workspace-mcp] */
import { executeWorkspaceMcpOperation, getWorkspaceOperation } from './operations.js'
import { randomUUID } from 'node:crypto'
import { ContextScopeAccumulator, executionToolContext, filterToolsByCapabilities, minSensitivity,
  type CapabilityStore, type Tool, type ToolContext } from '@use-brian/core'
import { findOrCreateWorkspaceMcpSession } from '../db/sessions.js'
import { queryWithRLS, runWithAgentAccess } from '../db/client.js'
import { findAssistantById, getWorkspacePrimaryAssistant } from '../db/users.js'
import { resolveExecutionContextSystem } from '../context-scope/execution-context.js'
import { snapshotWorkspaceMcpConsent, type WorkspaceMcpConsent } from './consent.js'
import { restoreWorkspaceMcpDelegation, captureWorkspaceMcpDelegation } from './delegation.js'
import { createWorkspaceMcpApprovals } from './approvals.js'
import type { PendingApprovalsStore } from '../db/pending-approvals-store.js'
import { createWorkspaceMcpRuns, workspaceRunControlNames } from './runs.js'
import type { WorkspaceTurnBinding, WorkspaceTurnInput, WorkspaceTurnResult } from './native-turn.js'

type IssueInput = {
  actorUserId: string
  authSessionId: string | undefined
  workspaceId?: string
  assistantId?: string
  readOnly: boolean
  contextGroupId: string | null
  contextProjectId: string | null
  maxClearance?: 'public' | 'internal' | 'confidential' | null
  expiresInDays?: number
}

export function createWorkspaceMcpProfile(deps: {
  nativeTools: ReadonlyMap<string, Tool>
  capabilityStore: CapabilityStore
  approvalsStore?: PendingApprovalsStore
  rawWrites?: ReadonlyMap<string, Tool>
  runNativeTurn?: (input: WorkspaceTurnInput, binding: WorkspaceTurnBinding) => Promise<WorkspaceTurnResult>
  /** Uses the native injector; it must enforce the snapshot on dynamic dispatch. */
  injectTools?: (tools: Map<string, Tool>, context: ToolContext, consent?: WorkspaceMcpConsent) => Promise<Record<string, string>>
}) {
  const compose = async (context: ToolContext, consent?: WorkspaceMcpConsent) => runWithAgentAccess(context.executionContext!.security.access, async () => {
    const tools = new Map(deps.nativeTools)
    tools.set(getWorkspaceOperation.name, getWorkspaceOperation)
    for (const [name, tool] of createWorkspaceMcpContextTools(async () => {
      if (!consent) throw new Error('workspace_mcp_consent_required')
      return consent
    })) tools.set(name, tool)
    for (const [name, tool] of runs?.tools ?? []) tools.set(name, tool)
    const connectorBindings = await deps.injectTools?.(tools, context, consent) ?? {}
    // Generic dispatchers require their own immutable connector envelope.
    // Direct canonical connector operations are independently enumerated.
    tools.delete('mcp_call')
    tools.delete('mcp_search')
    return { tools: filterToolsByCapabilities(tools, context.activeCapabilities ?? new Set()), connectorBindings }
  })
  const approvals: ReturnType<typeof createWorkspaceMcpApprovals> | undefined = deps.approvalsStore ? createWorkspaceMcpApprovals({ store: deps.approvalsStore,
    rawWrites: deps.rawWrites, toolsFor: async (context, consent) => (await compose(context, consent)).tools,
    restore: async (parent): Promise<{ context: ToolContext; consent: WorkspaceMcpConsent }> => {
      const { context, consent } = await restoreWorkspaceMcpDelegation(parent, deps.capabilityStore)
      return { context: await profile.prepareContext(context, consent, parent.selectionId), consent }
    },
  }) : undefined
  const restore = async (parent: Parameters<typeof restoreWorkspaceMcpDelegation>[0]): Promise<{ context: ToolContext; consent: WorkspaceMcpConsent }> => {
    const { context, consent } = await restoreWorkspaceMcpDelegation(parent, deps.capabilityStore)
    return { context: await profile.prepareContext(context, consent, parent.selectionId), consent }
  }
  const runs = deps.runNativeTurn ? createWorkspaceMcpRuns({ run: deps.runNativeTurn, restore, approvalsStore: deps.approvalsStore,
    prepareApproval: approvals?.prepareRun }) : undefined
  const profile = {
    runWorker: runs,
    respondToApproval: approvals?.respond,
    executeOperation: (invocation: Parameters<typeof executeWorkspaceMcpOperation>[0]) => workspaceContextControlNames.has(invocation.name) || runs && workspaceRunControlNames.has(invocation.name)
      ? invocation.execute() : executeWorkspaceMcpOperation({ ...invocation,
      prepare: approvals ? (contextId, operationId) => approvals.prepare(invocation.context, contextId, operationId) : undefined }),
    async prepareContext(base: ToolContext, consent: WorkspaceMcpConsent, handle?: unknown): Promise<ToolContext> {
      const original = base.executionContext
      if (!original || original.identity.kind !== 'programmatic' || !['brain_key', 'assistant_key', 'oauth_token'].includes(original.identity.principal.kind) || !base.workspaceId) throw new Error('workspace_mcp_authority_required')
      await original.security.authority.assertCurrent()
      const assistant = await findAssistantById(base.assistantId)
      if (!assistant || assistant.id !== consent.assistantId || assistant.workspaceId !== base.workspaceId) throw new Error('workspace_mcp_assistant_unavailable')
      const selection = handle === undefined ? undefined : await readWorkspaceMcpSelection(base, handle)
      if (selection && (consent.contextGroupId && selection.context_group_id !== consent.contextGroupId
        || consent.contextProjectId && selection.context_project_id !== consent.contextProjectId)) throw new Error('workspace_mcp_context_unavailable')
      let selectedScope = { activeGroupId: base.activeGroupId ?? null, activeProjectId: base.activeProjectId ?? null,
        writeCompartments: original.security.writeDefaults.compartments, clearance: original.security.access.clearance }
      if (selection) {
        const selected = await resolveExecutionContextSystem({ userId: base.userId, workspaceId: base.workspaceId, assistant,
          key: { contextGroupId: selection.context_group_id, contextProjectId: selection.context_project_id },
          identity: original.identity, ownership: original.ownership, attribution: original.attribution,
          lifecycle: { ...original.lifecycle, sessionPersisted: false }, maximumAccess: original.security.ceiling,
          sharedAudience: true, credentialCurrent: async () => { try { await original.security.authority.assertCurrent(); return true } catch { return false } },
        })
        selectedScope = { ...selected.turnScope, clearance: selected.executionContext.security.access.clearance }
        if ((selectedScope.activeGroupId ?? null) !== selection.context_group_id || (selectedScope.activeProjectId ?? null) !== selection.context_project_id) throw new Error('workspace_mcp_context_unavailable')
      }
      const session = await findOrCreateWorkspaceMcpSession({ assistantId: assistant.id, userId: base.userId,
        workspaceId: base.workspaceId, channelType: base.channelType,
        channelId: `workspace-mcp:${original.identity.principal.kind}:${original.identity.principal.credentialId}${selection ? `:${selection.selection_id}` : ''}`,
        visibility: 'workspace', effectiveClearance: selectedScope.clearance,
        contextGroupId: selectedScope.activeGroupId ?? null, contextProjectId: selectedScope.activeProjectId ?? null,
        contextCompartments: selectedScope.writeCompartments,
      }, { kind: original.identity.principal.kind as 'brain_key' | 'assistant_key' | 'oauth_token', id: original.identity.principal.credentialId, selectionId: selection?.selection_id })
      const { executionContext, turnScope } = await resolveExecutionContextSystem({
        userId: base.userId, workspaceId: base.workspaceId, assistant, session, sessionAuthority: session,
        identity: original.identity, ownership: original.ownership, attribution: original.attribution,
        lifecycle: { ...original.lifecycle, sessionId: session.id, sessionPersisted: true,
          channelId: session.channelId, channelType: session.channelType },
        maximumAccess: original.security.ceiling, sharedAudience: true,
        credentialCurrent: async () => { try { await original.security.authority.assertCurrent(); return true } catch { return false } },
      })
      const prepared: ToolContext = { ...base, ...executionToolContext(executionContext, { appId: base.appId }),
        assertModelInputAuthority: assertSourceModelInputAuthority, assertModelOutputAuthority: assertSourceModelOutputAuthority,
        scopeAccumulator: new ContextScopeAccumulator({ compartments: turnScope.writeCompartments, projectIds: turnScope.writeProjectIds }),
        sessionId: session.id, sessionPersisted: true, activeGroupId: turnScope.activeGroupId, activeProjectId: turnScope.activeProjectId }
      bindWorkspaceCredentialDelegation(executionContext, await captureWorkspaceMcpDelegation(prepared))
      return prepared
    },
    toolsFor: async (context: ToolContext, consent?: WorkspaceMcpConsent) => (await compose(context, consent)).tools,
    async issue(input: IssueInput): Promise<WorkspaceMcpConsent> {
      if (!input.authSessionId) throw new Error('workspace_mcp_native_consent_required')
      const assistant = input.assistantId ? await findAssistantById(input.assistantId)
        : input.workspaceId ? await getWorkspacePrimaryAssistant(input.actorUserId, input.workspaceId) : null
      if (!assistant?.workspaceId || input.workspaceId && assistant.workspaceId !== input.workspaceId) {
        throw new Error('workspace_mcp_assistant_unavailable')
      }
      const workspaceId = assistant.workspaceId
      const proof = await queryWithRLS<{ permitted: boolean }>(input.actorUserId,
        'SELECT programmatic_configuration_actor($1,$2,$3) AS permitted',
        [workspaceId, input.actorUserId, input.authSessionId])
      if (proof.rows[0]?.permitted !== true) throw new Error('workspace_mcp_native_consent_required')
      const days = input.expiresInDays ?? 30
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('workspace_mcp_expiry_invalid')
      const { executionContext, turnScope } = await resolveExecutionContextSystem({
        userId: input.actorUserId, workspaceId, assistant, sharedAudience: true,
        key: { contextGroupId: input.contextGroupId, contextProjectId: input.contextProjectId },
        identity: { kind: 'programmatic', principal: { kind: 'assistant_key', credentialId: randomUUID(), actorUserId: input.actorUserId },
          credentialOwnerUserId: input.actorUserId },
        ownership: { kind: 'workspace', workspaceId },
        lifecycle: { sessionId: randomUUID(), sessionPersisted: false, channelType: 'programmatic',
          channelId: 'mcp-consent-preview', abortSignal: new AbortController().signal },
      })
      const context: ToolContext = { ...executionToolContext(executionContext, { appId: assistant.id }),
        activeCapabilities: new Set(await deps.capabilityStore.listActive(assistant.id)),
        activeGroupId: turnScope.activeGroupId, activeProjectId: turnScope.activeProjectId,
        scopeAccumulator: new ContextScopeAccumulator() }
      const [groups, projects, assistants, composed] = await Promise.all([
        queryWithRLS<{ compartment_key: string }>(input.actorUserId,
          "SELECT compartment_key FROM workspace_groups WHERE workspace_id=$1 AND status='active'", [workspaceId]),
        queryWithRLS<{ id: string }>(input.actorUserId,
          "SELECT id FROM workspace_projects WHERE workspace_id=$1 AND status='active'", [workspaceId]),
        queryWithRLS<{ id: string }>(input.actorUserId,
          'SELECT id FROM assistants WHERE workspace_id=$1', [workspaceId]),
        compose(context),
      ])
      await executionContext.security.authority.assertCurrent()
      const consent = snapshotWorkspaceMcpConsent({ context, tools: composed.tools, connectorBindings: composed.connectorBindings, readOnly: input.readOnly,
        availableCompartments: groups.rows.map(row => row.compartment_key),
        availableProjectIds: projects.rows.map(row => row.id),
        availableAssistantIds: assistants.rows.map(row => row.id),
        contextGroupId: input.contextGroupId, contextProjectId: input.contextProjectId,
        expiresAt: new Date(Date.now() + days * 86_400_000) })
      if (input.maxClearance) consent.maxClearance = minSensitivity(consent.maxClearance, input.maxClearance)
      return consent
    },
  }
  return profile
}
export type WorkspaceMcpProfile = ReturnType<typeof createWorkspaceMcpProfile>
