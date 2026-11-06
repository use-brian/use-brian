/** Native human review with the original MCP parent ceiling. [COMP:api/workspace-mcp] */
import type { Tool, ToolContext } from '@use-brian/core'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { authSessionStore } from '../db/auth-session-store.js'
import { query, queryWithRLS } from '../db/client.js'
import type { PendingApproval, PendingApprovalsStore } from '../db/pending-approvals-store.js'
import { assertSourceModelInputAuthority } from '../application-platform/model-source-authority.js'
import { executeWorkspaceNativeTool } from './catalog.js'
import { captureWorkspaceMcpDelegation, type WorkspaceMcpDelegation } from './delegation.js'
import { executeWorkspaceMcpOperation } from './operations.js'
import type { WorkspaceMcpConsent } from './consent.js'
import { randomUUID, createHash } from 'node:crypto'

export type WorkspaceApprovalDecision = {
  approval: PendingApproval
  userId: string
  authSessionId?: string
  authVersion?: number
  decision: 'approved' | 'rejected'
  reason?: string
}

export function createWorkspaceMcpApprovals(deps: {
  store: PendingApprovalsStore
  restore: (parent: WorkspaceMcpDelegation) => Promise<{ context: ToolContext; consent: WorkspaceMcpConsent }>
  toolsFor: (context: ToolContext, consent: WorkspaceMcpConsent) => Promise<Map<string, Tool>>
  rawWrites?: ReadonlyMap<string, Tool>
}) {
  const service = {
    async prepareRun(context: ToolContext, contextId: string, runId: string) {
      context.createToolInvocationApproval = async params => {
        const operationId = randomUUID()
        await queryWithRLS(context.userId, `INSERT INTO workspace_mcp_operations(context_id,id,operation_name,argument_hash,status,evidence,run_id)
          VALUES($1,$2,$3,$4,'running',$5,$6)`, [contextId, operationId, params.toolName,
          createHash('sha256').update(JSON.stringify(params.toolInput)).digest('hex'), JSON.stringify(context.scopeAccumulator!.evidence), runId])
        // A separate context object keeps the run's callback available for a
        // later approval; the authority and source accumulator remain shared.
        const child = { ...context }
        await service.prepare(child, contextId, operationId)
        const approvalId = await child.createToolInvocationApproval!(params)
        const receipt = { isError: false, content: [{ type: 'text', text: 'Human review required.' }],
          structuredContent: { status: 'waiting_approval', operationId, approvalId, retrySafe: false } }
        await queryWithRLS(context.userId, `UPDATE workspace_mcp_operations SET status='waiting_approval',result=$3,evidence=$4
          WHERE context_id=$1 AND id=$2`, [contextId, operationId, JSON.stringify(receipt), JSON.stringify(context.scopeAccumulator!.evidence)])
        return approvalId
      }
    },
    async prepare(context: ToolContext, contextId: string, operationId: string) {
      const parent = await captureWorkspaceMcpDelegation(context)
      await queryWithRLS(context.userId,
        'UPDATE workspace_mcp_operations SET delegation=$3::jsonb WHERE context_id=$1 AND id=$2',
        [contextId, operationId, JSON.stringify(parent)])
      context.createToolInvocationApproval = async params => {
        await context.authority!.assertCurrent()
        await assertSourceModelInputAuthority(context)
        const approval = await deps.store.createToolInvocation({
          workspaceId: parent.workspaceId, blockingSessionId: parent.sessionId,
          originatingAssistantId: parent.assistantId, approverUserId: parent.userId,
          toolName: params.toolName, arguments: params.toolInput,
          approvalPayload: { description: params.description, displayLines: params.displayLines,
            allowPersistentApproval: false, workspaceMcpOperation: true },
          deliveryChannelType: 'web', expiresAt: params.expiresAt,
        })
        const linked = await queryWithRLS(context.userId,
          `UPDATE workspace_mcp_operations SET approval_id=$3,evidence=$4::jsonb
           WHERE context_id=$1 AND id=$2 AND approval_id IS NULL RETURNING id`,
          [contextId, operationId, approval.id, JSON.stringify(context.scopeAccumulator!.evidence)])
        if (!linked.rowCount) throw new Error('workspace_mcp_approval_already_prepared')
        return approval.id
      }
    },
    async respond(input: WorkspaceApprovalDecision): Promise<CallToolResult> {
      const fail = (code: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: code }],
        structuredContent: { status: 'failed', code, retrySafe: false } })
      const { approval, userId, authSessionId, authVersion } = input
      if (!authSessionId || authVersion === undefined || approval.approverUserId !== userId
        || approval.approvalPayload.workspaceMcpOperation !== true || approval.kind !== 'tool_invocation'
        || !await authSessionStore.validateAccess({ userId, sessionId: authSessionId, authVersion })) return fail('native_human_review_required')
      const row = (await query<{ id: string; context_id: string; operation_name: string; delegation: WorkspaceMcpDelegation; run_id: string | null }>(
        `SELECT o.id,o.context_id,o.operation_name,o.delegation,o.run_id FROM workspace_mcp_operations o
         JOIN workspace_mcp_contexts c ON c.id=o.context_id
         WHERE o.approval_id=$1 AND c.user_id=$2 AND c.workspace_id=$3`, [approval.id, userId, approval.workspaceId])).rows[0]
      if (!row?.delegation || row.delegation.sessionId !== approval.blockingSessionId
        || row.delegation.assistantId !== approval.originatingAssistantId || row.operation_name !== approval.toolName) return fail('approval_parent_unavailable')
      if (approval.status !== 'pending' && approval.status !== input.decision) return fail('approval_already_settled')
      try {
        // Restore before recording approval. A human click cannot revive an
        // expired key or convert an old delegation into an owner session.
        const { context, consent } = await deps.restore(row.delegation)
        if (context.sessionId !== row.delegation.sessionId || !consent.operationNames.includes(row.operation_name)) return fail('approval_parent_unavailable')
        const result = await executeWorkspaceMcpOperation({ context, name: row.operation_name, input: approval.arguments,
          operationId: row.id, resumeApprovalId: approval.id,
          execute: async () => {
            if (approval.expiresAt && approval.expiresAt.getTime() <= Date.now()) return fail('approval_expired')
            if (row.run_id) {
              const parent = context.authority!
              const assertCurrent = async () => {
                await parent.assertCurrent()
                if ((await queryWithRLS(userId, `SELECT 1 FROM workspace_mcp_runs WHERE id=$1 AND context_id=$2
                  AND status='waiting_approval' AND NOT cancel_requested`, [row.run_id, row.context_id])).rowCount !== 1) throw new Error('workspace_mcp_run_unavailable')
              }
              const authority = { ...parent, assertCurrent, async execute<T>(effect: () => Promise<T>) {
                await assertCurrent(); const result = await parent.execute(effect); await assertCurrent(); return result
              } }
              context.authority = authority
              context.executionContext = { ...context.executionContext!, security: { ...context.executionContext!.security, authority } }
              await assertCurrent()
            }
            if (!await authSessionStore.validateAccess({ userId, sessionId: authSessionId, authVersion })) return fail('native_human_review_required')
            const settled = approval.status === 'pending'
              ? await deps.store.respond(approval.id, input.decision, userId, input.reason)
              : await deps.store.getById(userId, approval.id)
            if (!settled || settled.status !== input.decision || settled.resolutionOrigin !== 'human'
              || settled.respondedBy !== userId) return fail('approval_already_settled')
            if (input.decision === 'rejected') return fail('approval_rejected')
            const tools = await deps.toolsFor(context, consent)
            const exposed = tools.get(row.operation_name)
            if (!exposed) return fail('operation_unavailable')
            const selected = deps.rawWrites?.get(row.operation_name) ?? exposed
            context.approvedStagedWrite = { approvalId: approval.id, approverUserId: userId, authSessionId }
            context.createToolInvocationApproval = async params => {
              if (params.toolName !== approval.toolName || JSON.stringify(params.toolInput) !== JSON.stringify(approval.arguments)) throw new Error('approval_arguments_changed')
              return approval.id
            }
            return context.authority!.execute(() => executeWorkspaceNativeTool(selected, context, approval.arguments, {
              resolve() {}, waitForDecision: async () => {
                await context.authority!.assertCurrent()
                if (!await authSessionStore.validateAccess({ userId, sessionId: authSessionId, authVersion })) throw new Error('native_human_review_required')
                return { decision: 'allow' }
              },
            }))
          },
        })
        return result
      } catch { return fail('approval_parent_unavailable') }
    },
  }
  return service
}
