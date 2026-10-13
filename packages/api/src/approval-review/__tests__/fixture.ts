/**
 * Test-only seeding for the approval-review DB suites. Builds on the Brief
 * fixture (isolated workspace, shared Project, Department, fictional people,
 * a primary `brian` and a standard `ops` assistant). Fictional identities
 * only; runs only through scripts/crm/local-fixture.mjs.
 */
import { randomUUID } from 'node:crypto'
import { getPool } from '../../db/client.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { briefFixture, type BriefFixture } from '../../briefs/__tests__/fixture.js'
import type { ReviewActor } from '../common.js'

export { briefFixture, type BriefFixture }
export const store = createPendingApprovalsStore()
const q = (sql: string, values: unknown[] = []) => getPool().query(sql, values)

export const person = (userId: string, origin: ReviewActor['origin'] = 'ui'): ReviewActor => ({ userId, origin, human: origin !== 'mcp' })

export async function grantConfigure(assistantId: string, by: string) {
  await q(`INSERT INTO assistant_capabilities (assistant_id, capability, granted_by_user_id) VALUES ($1, 'configure', $2)`, [assistantId, by])
}
export async function revokeConfigure(assistantId: string) {
  await q(`UPDATE assistant_capabilities SET revoked_at = now() WHERE assistant_id = $1 AND capability = 'configure' AND revoked_at IS NULL`, [assistantId])
}

export const sendStep = (over: Record<string, unknown> = {}) => ({
  id: 'send', type: 'tool_call', toolName: 'slackPostMessage',
  arguments: { channel: '#fictional-ops', text: '{{vars.summary}}' }, approval: { required: true }, ...over,
})

export async function makeWorkflow(f: BriefFixture, opts: { createdBy?: string; step?: Record<string, unknown> } = {}) {
  const definition = { startStepId: 'send', steps: [opts.step ?? sendStep()] }
  const r = await q(`INSERT INTO workflows (workspace_id, created_by, name, definition) VALUES ($1,$2,'Fictional ops digest',$3) RETURNING id`,
    [f.workspaceId, opts.createdBy ?? f.people.lead, JSON.stringify(definition)])
  return r.rows[0].id as string
}

export async function setWorkflowStep(workflowId: string, step: Record<string, unknown>) {
  await q(`UPDATE workflows SET definition = $2 WHERE id = $1`, [workflowId, JSON.stringify({ startStepId: 'send', steps: [step] })])
}

/** One workflow run paused on its approval-gated step, with its pending request. */
export async function pendingStepApproval(f: BriefFixture, workflowId: string, opts: {
  approver?: string
  executor?: string
  args?: Record<string, unknown>
  runId?: string
  description?: string
  projectIds?: string[]
} = {}) {
  const approver = opts.approver ?? f.people.lead
  const runId = opts.runId ?? (await q(
    `INSERT INTO workflow_runs (workflow_id, workspace_id, triggered_by, trigger_kind, status, current_step_id, context_project_ids)
     VALUES ($1,$2,$3,'manual','awaiting_input','send',$4) RETURNING id`, [workflowId, f.workspaceId, approver, opts.projectIds ?? []])).rows[0].id as string
  // Model an executor-produced scope envelope, preserving the run's actual context.
  await q(`UPDATE workflow_runs SET vars = jsonb_build_object('__contextScopeEvidence', jsonb_build_object('sensitivity','internal',
    'compartments', context_compartments, 'projectIds', context_project_ids)) WHERE id = $1`, [runId])
  const stepRunId = (await q(
    `INSERT INTO workflow_step_runs (run_id, step_id, step_type, status) VALUES ($1,'send','tool_call','running') RETURNING id`, [runId])).rows[0].id as string
  const approval = await store.create({
    workspaceId: f.workspaceId, workflowRunId: runId, workflowStepRunId: stepRunId,
    originatingAssistantId: opts.executor ?? f.assistants.brian, toolName: 'slackPostMessage',
    arguments: opts.args ?? { channel: '#fictional-ops', text: 'Daily fictional digest' },
    approverUserId: approver, deliveryChannelType: 'web',
    ...(opts.description ? { approvalPayload: { displayLines: [opts.description] } } : {}),
  })
  return { approval, runId, stepRunId }
}

/** Three distinct human-approved executions of the same step (D43). */
export async function approveThreeTimes(f: BriefFixture, workflowId: string, opts: { args?: Record<string, unknown>; approver?: string } = {}) {
  const ids: string[] = []
  for (let i = 0; i < 3; i++) {
    const { approval } = await pendingStepApproval(f, workflowId, opts)
    await store.respond(approval.id, 'approved', opts.approver ?? f.people.lead)
    ids.push(approval.id)
  }
  return ids
}

export async function patternRows(workspaceId: string) {
  return (await q(`SELECT id, status, version, suspended_reason FROM approval_patterns WHERE workspace_id = $1 ORDER BY created_at`, [workspaceId])).rows as Array<{ id: string; status: string; version: number; suspended_reason: string | null }>
}

export const key = () => `test-${randomUUID()}`
