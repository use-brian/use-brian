import { workspaceMcpContextBinding } from './contexts.js'
/** Durable native-operation receipts and retained sources. [COMP:api/workspace-mcp] */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildTool, boundScopeSources, resolveWriteScope, type ScopeEvidence, type ToolContext } from '@use-brian/core'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { addSessionMessage } from '../db/sessions.js'
import { bindWorkspaceMcpPublication } from '../db/session-context-revisions.js'
import { getAppPool, queryWithRLS } from '../db/client.js'
import { assertSourceModelInputAuthority, assertSourceModelOutputAuthority } from '../application-platform/model-source-authority.js'

type Invocation = { context: ToolContext; name: string; input: unknown; operationId?: string; isReadOnly?: boolean; execute: () => Promise<CallToolResult>
  /** Host-only continuation, never populated from MCP input. */
  resumeApprovalId?: string
  prepare?: (contextId: string, operationId: string) => Promise<void>
}
type ContextRow = { id: string; evidence: ScopeEvidence; invalidated: boolean }
type ReceiptRow = { id: string; operation_name: string; argument_hash: string; status: string; result: CallToolResult | null; evidence: ScopeEvidence; approval_id: string | null; resumed_at: Date | null }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
function reply(code: string, message: string, operationId?: string, retrySafe = false): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }], structuredContent: {
    status: code === 'operation_uncertain' ? 'uncertain' : 'failed', code, message, retrySafe, ...(operationId ? { operationId } : {}),
  } }
}
function binding(context: ToolContext) {
  const identity = context.executionContext?.identity
  if (identity?.kind !== 'programmatic' || !['brain_key', 'assistant_key', 'oauth_token'].includes(identity.principal.kind)
    || !context.workspaceId || !context.scopeAccumulator) throw new Error('workspace_mcp_authority_required')
  return workspaceMcpContextBinding(context)
}

/** One credential is a conservative retained-context boundary across reconnects. */
export async function executeWorkspaceMcpOperation(invocation: Invocation): Promise<CallToolResult> {
  const { context, execute, name, input } = invocation
  const key = binding(context), operationId = invocation.operationId ?? randomUUID()
  if (!z.string().uuid().safeParse(operationId).success) return reply('invalid_operation_id', 'operation-id must be a UUID.')
  const hash = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
  const lock = await getAppPool().connect()
  const lockKey = `workspace-mcp:${key.column}:${key.id}:${key.selectionId}`
  let locked = false, contextId: string | undefined, started = false
  try {
    locked = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lockKey])).rows[0]?.locked === true
    if (!locked) return reply('connection_busy', 'Another operation is running on this connection. Retry with the same operation-id.', operationId, true)
    await context.authority!.assertCurrent()
    const selected = await queryWithRLS<ContextRow>(context.userId,
      `INSERT INTO workspace_mcp_contexts(workspace_id,user_id,assistant_id,${key.column},selection_id) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(${key.column},selection_id) DO UPDATE SET updated_at=now()
       WHERE workspace_mcp_contexts.user_id=EXCLUDED.user_id AND workspace_mcp_contexts.workspace_id=EXCLUDED.workspace_id
         AND workspace_mcp_contexts.assistant_id=EXCLUDED.assistant_id
       RETURNING id,evidence,invalidated`, [context.workspaceId, context.userId, context.assistantId, key.id, key.selectionId])
    const state = selected.rows[0]
    if (!state || state.invalidated) return reply('context_unavailable', 'The connection context is no longer authorized.', operationId)
    contextId = state.id
    bindWorkspaceMcpPublication(context.executionContext!)
    context.scopeAccumulator!.note(state.evidence)
    try { await assertSourceModelInputAuthority(context) }
    catch {
      await queryWithRLS(context.userId, 'UPDATE workspace_mcp_contexts SET invalidated=true WHERE id=$1', [contextId])
      return reply('context_unavailable', 'Previously accessed sources are no longer authorized for this connection.', operationId)
    }
    const prior = (await queryWithRLS<ReceiptRow>(context.userId,
      'SELECT * FROM workspace_mcp_operations WHERE context_id=$1 AND id=$2', [contextId, operationId])).rows[0]
    if (prior) {
      if (prior.operation_name !== name || (!invocation.resumeApprovalId && prior.argument_hash !== hash)
        || invocation.resumeApprovalId && prior.approval_id !== invocation.resumeApprovalId) return reply('operation_id_conflict', 'This operation-id already belongs to different arguments.', operationId)
      context.scopeAccumulator!.note(prior.evidence)
      await assertSourceModelOutputAuthority(context)
      await context.authority!.assertCurrent()
      if (invocation.resumeApprovalId && prior.status === 'waiting_approval' && !prior.resumed_at) {
        const claimed = await queryWithRLS(context.userId,
          "UPDATE workspace_mcp_operations SET status='running',result=NULL,resumed_at=now() WHERE context_id=$1 AND id=$2 AND status='waiting_approval' AND resumed_at IS NULL RETURNING id",
          [contextId, operationId])
        if (!claimed.rowCount) return reply('operation_uncertain', 'The review continuation is already claimed. Inspect its receipt.', operationId)
      } else {
        if (!prior.result) return reply('operation_uncertain', 'Execution started but no final receipt was recorded. Check the native outcome before starting another operation.', operationId)
        return prior.result
      }
    } else {
      if (invocation.resumeApprovalId) return reply('operation_unavailable', 'The originating operation is unavailable.', operationId)
      await queryWithRLS(context.userId,
        `INSERT INTO workspace_mcp_operations(context_id,id,operation_name,argument_hash,status,evidence)
         VALUES($1,$2,$3,$4,'running',$5::jsonb)`, [contextId, operationId, name, hash, JSON.stringify(context.scopeAccumulator!.evidence)])
    }
    started = true
    await invocation.prepare?.(contextId, operationId)
    if (!invocation.isReadOnly && !invocation.resumeApprovalId) {
      const execution = context.executionContext!, accumulator = context.scopeAccumulator!
      const access = execution.security.access
      const stamp = resolveWriteScope({ sensitivity: access.clearance,
        baseCompartments: execution.security.writeDefaults.compartments,
        baseProjectIds: execution.security.writeDefaults.projectIds, evidence: accumulator,
        compartmentGrant: access.mutationCompartments, projectGrant: access.projectIds })
      const scope = { ...stamp, workspaceId: access.workspaceId, userId: null, assistantId: null }
      // This is content-free input attribution, not a derived reply. Native
      // incoming-message storage owns the scoped input insert; the complete
      // retained roots remain in the operation accumulator for domain effects.
      const observation = await addSessionMessage({
        sessionId: context.sessionId, role: 'user', senderUserId: null, scope,
        content: [{ type: 'text', text: `External MCP operation ${name} (${operationId}); input SHA-256 ${hash}.` }],
      })
      accumulator.note({ sources: boundScopeSources(observation) })
      await queryWithRLS(context.userId, 'UPDATE workspace_mcp_contexts SET evidence=$2::jsonb WHERE id=$1',
        [contextId, JSON.stringify(accumulator.evidence)])
    }
    const result = await execute()
    await assertSourceModelOutputAuthority(context)
    await context.authority!.assertCurrent()
    const reported = result.structuredContent?.status
    const status = result.structuredContent?.code === 'operation_interrupted' ? 'uncertain'
      : reported === 'waiting_approval' || reported === 'waiting_input' ? reported : result.isError ? 'failed' : 'succeeded'
    const receipt = { ...result, structuredContent: { ...result.structuredContent, status, operationId, retrySafe: false } }
    // Evidence must reach durable storage before any result leaves the server.
    await queryWithRLS(context.userId, 'UPDATE workspace_mcp_contexts SET evidence=$2::jsonb,updated_at=now() WHERE id=$1',
      [contextId, JSON.stringify(context.scopeAccumulator!.evidence)])
    await queryWithRLS(context.userId,
      'UPDATE workspace_mcp_operations SET status=$3,result=$4::jsonb,evidence=$5::jsonb,completed_at=now() WHERE context_id=$1 AND id=$2',
      [contextId, operationId, status, JSON.stringify(receipt), JSON.stringify(context.scopeAccumulator!.evidence)])
    await context.authority!.assertCurrent()
    return receipt
  } catch (error) {
    console.warn('[workspace-mcp] operation boundary refused', { stage: started ? 'execution' : 'admission',
      code: typeof error === 'object' && error ? (error as { code?: string; reason?: string }).code ?? (error as { reason?: string }).reason ?? 'unavailable' : 'unavailable' })
    if (contextId) {
      // Preserve known evidence even when an effect or delivery was interrupted.
      // A failed proof cannot be revived by a later permission restoration.
      await queryWithRLS(context.userId,
        'UPDATE workspace_mcp_contexts SET evidence=$2::jsonb,invalidated=true,updated_at=now() WHERE id=$1',
        [contextId, JSON.stringify(context.scopeAccumulator!.evidence)]).catch(() => {})
    }
    return reply(started ? 'operation_uncertain' : 'context_unavailable',
      started ? 'The operation was interrupted. Check the native outcome before retrying.' : 'The connection context could not be verified.', operationId)
  } finally {
    let discard = false
    try { if (locked) await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]) }
    catch { discard = true }
    lock.release(discard)
  }
}

export const getWorkspaceOperation = buildTool({
  name: 'getWorkspaceOperation', description: 'Inspect a workspace MCP operation receipt by operationId. Does not retry or repeat the operation.',
  inputSchema: z.object({ operationId: z.string().uuid() }), isReadOnly: true,
  execute: async ({ operationId }, context) => {
    const key = binding(context)
    const row = (await queryWithRLS<ReceiptRow & { invalidated: boolean }>(context.userId,
      `SELECT o.*,c.invalidated FROM workspace_mcp_operations o JOIN workspace_mcp_contexts c ON c.id=o.context_id
       WHERE o.id=$1 AND c.${key.column}=$2 AND c.workspace_id=$3 AND c.assistant_id=$4 AND c.selection_id=$5`,
      [operationId, key.id, context.workspaceId, context.assistantId, key.selectionId])).rows[0]
    if (!row || row.invalidated) return { isError: true, data: { error: 'operation_unavailable' } }
    context.scopeAccumulator!.note(row.evidence)
    await assertSourceModelOutputAuthority(context)
    return { data: { operationId, operation: row.operation_name,
      status: row.result ? row.status : 'uncertain', result: row.result, retrySafe: false }, scopeEvidence: row.evidence }
  },
})
