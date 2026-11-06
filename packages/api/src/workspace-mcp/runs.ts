import { bindWorkspaceCredentialDelegation, workspaceCredentialDelegation } from '@use-brian/core'
import { workspaceMcpContextBinding, workspaceMcpConversationPath } from './contexts.js'
/** Durable native turns with their original credential parent. [COMP:api/workspace-mcp] */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type ToolContext, type ScopeEvidence } from '@use-brian/core'
import { sanitizeDeliveryText } from '@use-brian/shared'
import { query, queryWithRLS } from '../db/client.js'
import { bindWorkspaceMcpPublication } from '../db/session-context-revisions.js'
import { readAttendedSessionHistory } from '../routes/attended-session-context.js'
import { assertSourceModelOutputAuthority } from '../application-platform/model-source-authority.js'
import { captureWorkspaceMcpDelegation, type WorkspaceMcpDelegation } from './delegation.js'
import { executeWorkspaceMcpOperation } from './operations.js'
import type { WorkspaceMcpConsent } from './consent.js'
import type { WorkspaceTurnBinding, WorkspaceTurnInput, WorkspaceTurnResult } from './native-turn.js'
import type { PendingApprovalsStore } from '../db/pending-approvals-store.js'

const inputSchema = z.object({ message: z.string().min(1).max(200_000),
  workspaceFileIds: z.array(z.string().uuid()).max(32).optional(),
  fileIds: z.array(z.string().uuid()).max(32).optional(), attachedRecordingIds: z.array(z.string().uuid()).max(32).optional(),
  model: z.string().max(200).optional(), mode: z.enum(['default', 'research']).optional() }).strict()
type Run = { id: string; context_id: string; session_id: string; turn_operation_id: string; delegation: WorkspaceMcpDelegation;
  created_at: Date; updated_at: Date;
  input: WorkspaceTurnInput; status: string; result: WorkspaceTurnResult | null; claim_token: string | null;
  cancel_requested: boolean; evidence: ScopeEvidence; invalidated: boolean }
type Deps = {
  approvalsStore?: PendingApprovalsStore
  restore(parent: WorkspaceMcpDelegation): Promise<{ context: ToolContext; consent: WorkspaceMcpConsent }>
  run(input: WorkspaceTurnInput, binding: WorkspaceTurnBinding): Promise<WorkspaceTurnResult>
  prepareApproval?(context: ToolContext, contextId: string, runId: string): Promise<void>
}
export const workspaceRunControlNames = new Set(['listBrianRuns', 'getBrianRun', 'cancelBrianRun'])
function keyBinding(context: ToolContext) {
  const identity = context.executionContext?.identity
  if (identity?.kind !== 'programmatic' || !['brain_key', 'assistant_key', 'oauth_token'].includes(identity.principal.kind)) throw new Error('workspace_mcp_parent_required')
  return workspaceMcpContextBinding(context)
}
function summary(row: Run) {
  return { runId: row.id, sessionId: row.session_id, status: row.status, cancelRequested: row.cancel_requested,
    openPath: workspaceMcpConversationPath(row.delegation.workspaceId, row.session_id),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    retrySafe: false, ...(row.result?.approvalIds?.length ? { approvalIds: row.result.approvalIds } : {}),
    ...(row.result?.questionIds?.length ? { questionIds: row.result.questionIds } : {}) }
}
async function readRun(context: ToolContext, id: string): Promise<Run> {
  const key = keyBinding(context)
  await context.authority!.assertCurrent()
  const row = (await queryWithRLS<Run>(context.userId, `SELECT r.*,c.evidence,c.invalidated FROM workspace_mcp_runs r
    JOIN workspace_mcp_contexts c ON c.id=r.context_id
    WHERE r.id=$1 AND c.${key.column}=$2 AND c.workspace_id=$3 AND c.assistant_id=$4 AND r.session_id=$5`,
  [id, key.id, context.workspaceId, context.assistantId, context.sessionId])).rows[0]
  if (!row) throw new Error('workspace_mcp_run_unavailable')
  await context.authority!.assertCurrent()
  return row
}

export function createWorkspaceMcpRuns(deps: Deps) {
  const runBrian = buildTool({ name: 'runBrian', description: 'Ask Brian to work in this connection’s native workspace conversation. Returns a durable runId immediately; inspect with getBrianRun and fetch final replies with getBrianRunResult. Reconnect does not repeat work. workspaceFileIds attaches admitted workspace files (up to 20 MiB each); fileIds references existing native chat attachments.',
    inputSchema, isReadOnly: false,
    execute: async (input, context) => {
      const parent = await captureWorkspaceMcpDelegation(context), key = keyBinding(context)
      const state = (await queryWithRLS<{ id: string }>(context.userId,
        `SELECT id FROM workspace_mcp_contexts WHERE ${key.column}=$1 AND user_id=$2 AND workspace_id=$3 AND assistant_id=$4 AND selection_id=$5 AND NOT invalidated`,
        [key.id, context.userId, context.workspaceId, context.assistantId, key.selectionId])).rows[0]
      if (!state) throw new Error('workspace_mcp_context_unavailable')
      const row = (await queryWithRLS<Run>(context.userId, `INSERT INTO workspace_mcp_runs(context_id,session_id,delegation,input)
        VALUES($1,$2,$3,$4) ON CONFLICT(context_id) WHERE status IN('queued','running','waiting_approval','waiting_input') DO NOTHING RETURNING *`,
      [state.id, context.sessionId, JSON.stringify(parent), JSON.stringify(input)])).rows[0]
      if (!row) return { isError: true, data: { code: 'run_already_active', message: 'Finish or cancel the active run before submitting another message.' } }
      return { data: summary(row) }
    } })
  const getBrianRun = buildTool({ name: 'getBrianRun', description: 'Inspect safe status and pending review references for a Brian run without retrieving its source content.',
    inputSchema: z.object({ runId: z.string().uuid() }).strict(), isReadOnly: true,
    execute: async ({ runId }, context) => ({ data: summary(await readRun(context, runId)) }) })
  const listBrianRuns = buildTool({ name: 'listBrianRuns', description: 'Recover Brian run references after reconnecting or losing a receipt. Lists status-only history in this credential’s selected conversation, newest first. Use nextCursor for older runs. Returns no submitted text or replies.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20), cursor: z.string().uuid().optional() }).strict(), isReadOnly: true,
    execute: async ({ limit, cursor }, context) => {
      const key = keyBinding(context)
      await context.authority!.assertCurrent()
      const before = cursor ? await readRun(context, cursor) : undefined
      const rows = (await queryWithRLS<Run>(context.userId, `SELECT r.* FROM workspace_mcp_runs r
        JOIN workspace_mcp_contexts c ON c.id=r.context_id
        WHERE c.${key.column}=$1 AND c.workspace_id=$2 AND c.assistant_id=$3 AND r.session_id=$4
          AND ($5::uuid IS NULL OR (r.created_at,r.id)<($6::timestamptz,$5::uuid))
        ORDER BY r.created_at DESC,r.id DESC LIMIT $7`,
      [key.id, context.workspaceId, context.assistantId, context.sessionId, before?.id ?? null, before?.created_at ?? null, limit + 1])).rows
      await context.authority!.assertCurrent()
      return { data: { runs: rows.slice(0, limit).map(summary), ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.id } : {}) } }
    } })
  const cancelBrianRun = buildTool({ name: 'cancelBrianRun', description: 'Request cooperative cancellation of a Brian run. Does not undo completed effects. A cancelled in-flight operation can have an uncertain outcome; inspect its native history before retrying.',
    inputSchema: z.object({ runId: z.string().uuid() }).strict(), isReadOnly: false,
    execute: async ({ runId }, context) => {
      const row = await readRun(context, runId)
      await queryWithRLS(context.userId, `UPDATE workspace_mcp_runs SET cancel_requested=true,
        status=CASE WHEN status IN('queued','waiting_approval','waiting_input') THEN 'cancelled' ELSE status END,updated_at=now()
        WHERE id=$1 AND context_id=$2 AND status IN('queued','running','waiting_approval','waiting_input')`, [runId, row.context_id])
      const cancelled = await readRun(context, runId)
      if (cancelled.status === 'cancelled') {
        for (const id of [...cancelled.result?.approvalIds ?? [], ...cancelled.result?.questionIds ?? []]) {
          const pending = await deps.approvalsStore?.getById(context.userId, id)
          if (pending?.blockingSessionId === cancelled.session_id && pending.status === 'pending') {
            await deps.approvalsStore?.expireById(id)
          }
        }
      }
      return { data: summary(cancelled) }
    } })
  const getBrianRunResult = buildTool({ name: 'getBrianRunResult', description: 'Read final persisted Brian replies after a run completes. Rechecks current source access and excludes private reasoning and turns containing tool calls.',
    inputSchema: z.object({ runId: z.string().uuid() }).strict(), isReadOnly: true,
    execute: async ({ runId }, context) => {
      const row = await readRun(context, runId)
      if (row.invalidated) throw new Error('workspace_mcp_context_unavailable')
      if (['queued', 'running'].includes(row.status)) return { data: summary(row) }
      context.scopeAccumulator!.note(row.evidence)
      bindWorkspaceMcpPublication(context.executionContext!)
      const messages = await readAttendedSessionHistory({ execution: context.executionContext!, accumulator: context.scopeAccumulator! }, row.session_id)
      const ids = new Set(row.result?.messageIds ?? [])
      const replies = messages.flatMap(message => {
        if (!ids.has(message.id) || message.role !== 'assistant') return []
        const parsed = z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).safeParse(message.content)
        if (!parsed.success || parsed.data.some(block => block.type === 'tool_use')) return []
        return [{ id: message.id, text: sanitizeDeliveryText(parsed.data.flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n')) }]
      })
      const questions = []
      for (const id of row.result?.questionIds ?? []) {
        const question = await deps.approvalsStore?.getById(context.userId, id)
        if (!question || question.kind !== 'question' || question.blockingSessionId !== row.session_id
          || question.approvalPayload.workspaceMcpRunId !== row.id) throw new Error('workspace_mcp_question_unavailable')
        questions.push({ questionId: id, question: question.approvalPayload.question,
          options: question.approvalPayload.options, status: question.status, expiresAt: question.expiresAt })
      }
      await assertSourceModelOutputAuthority(context)
      await context.authority!.assertCurrent()
      return { data: { ...summary(row), replies,...(row.result?.research?.length?{research:row.result.research}:{}), ...(questions.length ? { questions } : {}) }, scopeEvidence: context.scopeAccumulator!.evidence }
    } })
  const continueBrianRun = buildTool({ name: 'continueBrianRun', description: 'Continue a Brian run after its human reviews have completed. Uses the same conversation and original credential; completed actions are observed, never replayed by this operation.',
    inputSchema: z.object({ runId: z.string().uuid(), message: z.string().max(100_000).optional(), answer: z.string().trim().min(1).max(8000).optional() }).strict(), isReadOnly: false,
    execute: async ({ runId, message, answer }, context) => {
      const row = await readRun(context, runId)
      if (!['waiting_approval', 'waiting_input'].includes(row.status) || row.cancel_requested || row.invalidated) return { isError: true, data: { code: 'run_not_waiting' } }
      await deps.restore(row.delegation)
      let observation: string
      if (row.status === 'waiting_input') {
        const ids = row.result?.questionIds ?? []
        if (ids.length !== 1 || !deps.approvalsStore) throw new Error('workspace_mcp_question_unavailable')
        let question = await deps.approvalsStore.getById(context.userId, ids[0])
        if (!question || question.kind !== 'question' || question.approvalPayload.workspaceMcpRunId !== runId
          || question.expiresAt && question.expiresAt.getTime() <= Date.now()) return { isError: true, data: { code: 'question_unavailable' } }
        if (answer && question.status === 'pending') {
          question = await context.authority!.execute(() => deps.approvalsStore!.recordExternalQuestionAnswer(ids[0], answer, runId))
        }
        if (!question || question.status !== 'approved' || !question.answerText) return { isError: true, data: { code: 'answer_required' } }
        observation = 'The pending ordinary question was answered. This answer grants no additional permission.\n' + question.answerText
      } else {
      const approvals = row.result?.approvalIds ?? []
      const completed = (await queryWithRLS<{ approval_id: string; status: string; result: unknown }>(context.userId,
        'SELECT approval_id,status,result FROM workspace_mcp_operations WHERE run_id=$1 AND approval_id=ANY($2::uuid[])', [runId, approvals])).rows
      if (!approvals.length || completed.length !== approvals.length || completed.some(item => !['succeeded', 'failed'].includes(item.status))) {
        return { isError: true, data: { code: 'review_not_complete', approvalIds: approvals } }
      }
      observation = 'Previously requested actions have completed human review. The following are their recorded outcomes. Use these observations without repeating the completed actions.\n' + JSON.stringify(completed).slice(0, 64_000)
      }
      const next = { ...row.input, message: observation + (message ? '\nFollow-up request:\n' + message : '\nContinue the original request using these outcomes.') }
      const changed = await queryWithRLS<Run>(context.userId, `UPDATE workspace_mcp_runs SET input=$3,status='queued',turn_operation_id=gen_random_uuid(),
        claim_token=NULL,updated_at=now() WHERE id=$1 AND context_id=$2 AND status=$4 AND NOT cancel_requested RETURNING *`,
        [runId, row.context_id, JSON.stringify(next), row.status])
      return changed.rows[0] ? { data: summary(changed.rows[0]) } : { isError: true, data: { code: 'run_changed' } }
    } })

  let timer: ReturnType<typeof setInterval> | undefined, active: Promise<void> | undefined
  let stopped = false, controller: AbortController | undefined
  async function processOne() {
    await query(`UPDATE workspace_mcp_runs r SET status='failed',updated_at=now()
      WHERE r.status IN('waiting_approval','waiting_input') AND EXISTS(
        SELECT 1 FROM pending_approvals p WHERE
          (p.id::text IN(SELECT jsonb_array_elements_text(coalesce(r.result->'approvalIds','[]'::jsonb)))
           OR p.id::text IN(SELECT jsonb_array_elements_text(coalesce(r.result->'questionIds','[]'::jsonb))))
          AND (p.status='expired' OR p.expires_at<=now() OR p.kind='question' AND p.status='rejected'))`)
    const ready = (await query<Run>(`SELECT r.* FROM workspace_mcp_runs r WHERE r.status IN('waiting_approval','waiting_input')
      AND NOT r.cancel_requested AND (
        r.status='waiting_approval' AND jsonb_array_length(coalesce(r.result->'approvalIds','[]'::jsonb))>0
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.result->'approvalIds') AS pending(approval_id)
          WHERE NOT EXISTS(SELECT 1 FROM workspace_mcp_operations o WHERE o.run_id=r.id AND o.approval_id::text=pending.approval_id AND o.status IN('succeeded','failed')))
        OR r.status='waiting_input' AND jsonb_array_length(coalesce(r.result->'questionIds','[]'::jsonb))=1
        AND EXISTS(SELECT 1 FROM pending_approvals p WHERE p.id::text=r.result->'questionIds'->>0 AND p.status='approved'))
      ORDER BY r.updated_at LIMIT 1`)).rows[0]
    if (ready) {
      try {
        const { context } = await deps.restore(ready.delegation)
        const receipt = await executeWorkspaceMcpOperation({ context, name: 'continueBrianRun', input: { runId: ready.id },
          execute: async () => {
            const result = await continueBrianRun.execute({ runId: ready.id }, context)
            return { isError: result.isError, content: [{ type: 'text', text: result.isError ? 'Continuation unavailable.' : 'Continuation queued.' }] }
          } })
        if (receipt.isError && receipt.structuredContent?.code !== 'connection_busy') {
          await query("UPDATE workspace_mcp_runs SET status='failed',updated_at=now() WHERE id=$1 AND status IN('waiting_approval','waiting_input')", [ready.id])
        }
      } catch {
        await query("UPDATE workspace_mcp_runs SET status='failed',updated_at=now() WHERE id=$1 AND status IN('waiting_approval','waiting_input')", [ready.id])
      }
    }
    // A claimed turn may have committed effects. Never reclaim/replay it.
    await query(`WITH stale AS (UPDATE workspace_mcp_runs SET status='uncertain',updated_at=now()
      WHERE status='running' AND heartbeat_at<now()-interval '2 minutes' RETURNING context_id)
      UPDATE workspace_mcp_contexts SET invalidated=true WHERE id IN(SELECT context_id FROM stale)`)
    const token = randomUUID()
    const job = (await query<Run>(`UPDATE workspace_mcp_runs SET status='running',claim_token=$1,heartbeat_at=now(),updated_at=now()
      WHERE id=(SELECT id FROM workspace_mcp_runs WHERE status='queued' AND NOT cancel_requested
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [token])).rows[0]
    if (!job) return
    const abort = new AbortController(); controller = abort
    let heartbeatBusy = false
    const current = async () => (await query(`SELECT 1 FROM workspace_mcp_runs WHERE id=$1 AND claim_token=$2
      AND status='running' AND NOT cancel_requested AND heartbeat_at>now()-interval '2 minutes'`, [job.id, token])).rowCount === 1
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return
      heartbeatBusy = true
      void query(`UPDATE workspace_mcp_runs SET heartbeat_at=now() WHERE id=$1 AND claim_token=$2 AND status='running'
        AND NOT cancel_requested AND heartbeat_at>now()-interval '2 minutes' RETURNING id`, [job.id, token]).then(result => { if (!result.rowCount) abort.abort() })
        .catch(() => abort.abort()).finally(() => { heartbeatBusy = false })
    }, 5000)
    heartbeat.unref?.()
    try {
      const { context, consent } = await deps.restore(job.delegation)
      if (context.sessionId !== job.session_id || !consent.operationNames.includes('runBrian')) throw new Error('workspace_mcp_parent_unavailable')
      const parentAuthority = context.authority!
      const assertCurrent = async () => { abort.signal.throwIfAborted(); await parentAuthority.assertCurrent(); if (!await current()) throw new Error('workspace_mcp_run_stopped'); abort.signal.throwIfAborted() }
      // The worker's liveness only narrows the original parent authority.
      const authority = { ...parentAuthority, assertCurrent, async execute<T>(effect: () => Promise<T>): Promise<T> {
        await assertCurrent(); const result = await parentAuthority.execute(effect); await assertCurrent(); return result
      } }
      context.authority = authority
      const workspaceParent = workspaceCredentialDelegation(context.executionContext)
      context.executionContext = { ...context.executionContext!, security: { ...context.executionContext!.security, authority } }
      if (!workspaceParent) throw new Error('workspace_mcp_parent_required')
      bindWorkspaceCredentialDelegation(context.executionContext,workspaceParent)
      if (deps.approvalsStore) context.createPendingQuestion = async params => {
        await authority.assertCurrent()
        const question = await deps.approvalsStore!.createQuestion({ workspaceId: context.workspaceId!, blockingSessionId: context.sessionId,
          originatingAssistantId: context.assistantId, approverUserId: context.userId, workspaceMcpRunId: job.id,
          question: params.question, toolUseId: params.toolUseId, options: params.options, allowCustom: params.allowCustom,
          deliveryChannelType: 'web', expiresAt: params.expiresAt })
        return question.id
      }
      const receipt = await executeWorkspaceMcpOperation({ context, name: 'runBrian', input: job.input, operationId: job.turn_operation_id,
        prepare: async contextId => { await deps.prepareApproval?.(context, contextId, job.id) },
        execute: async () => {
          const result = await deps.run(inputSchema.parse(job.input), { context, consent, abortSignal: abort.signal })
          return { isError: result.status === 'failed', content: [{ type: 'text' as const, text: result.status }],
            structuredContent: { status: result.status, data: result } }
        } })
      if (receipt.structuredContent?.code === 'connection_busy') {
        await query("UPDATE workspace_mcp_runs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'queued' END,claim_token=NULL,updated_at=now() WHERE id=$1 AND claim_token=$2 AND status='running'", [job.id, token])
        return
      }
      const result = receipt.structuredContent?.data as WorkspaceTurnResult | undefined
      const status = receipt.structuredContent?.status === 'uncertain' ? 'uncertain' : result?.status ?? 'failed'
      await query(`UPDATE workspace_mcp_runs SET status=$3,result=$4,updated_at=now() WHERE id=$1 AND claim_token=$2 AND status='running'`,
        [job.id, token, status, result ? JSON.stringify(result) : null])
    } catch {
      await query("UPDATE workspace_mcp_runs SET status='failed',updated_at=now() WHERE id=$1 AND claim_token=$2 AND status='running'", [job.id, token])
    } finally { clearInterval(heartbeat); controller = undefined }
  }
  const tick = () => {
    if (active || stopped) return active ?? Promise.resolve()
    active = processOne().catch(error => console.warn('[workspace-mcp] run queue unavailable', { code: typeof error === 'object' && error ? error.code ?? 'unavailable' : 'unavailable' })).finally(() => { active = undefined })
    return active
  }
  return { tools: new Map([runBrian, listBrianRuns, getBrianRun, cancelBrianRun, getBrianRunResult, continueBrianRun].map(tool => [tool.name, tool])), tick,
    start() { if (timer) return; stopped = false; timer = setInterval(() => void tick(), 1000); timer.unref?.(); void tick() },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; controller?.abort(); await active },
  }
}
