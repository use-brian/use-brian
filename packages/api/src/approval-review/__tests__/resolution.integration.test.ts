/**
 * Delegated resolution through the canonical claim against a migration-
 * replayed PostgreSQL 18: resolved only on an exact active human pattern with
 * an explicit configure-holding reviewer; human-only categories, missing or
 * changed authority, and races leave the request with its human; the receipt
 * forges no human evidence; consumers revalidate current authority and use
 * the original executor. Fake tools only, real services and RLS.
 * Runs only through scripts/crm/local-fixture.mjs. Fictional identities.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolContext } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbWorkflowRunStore, createDbWorkflowStore } from '../../db/workflow-store.js'
import { createWorkspaceAuditStore } from '../../db/workspace-audit-store.js'
import { readBrowserSendApprovalStatus } from '../../db/pending-approvals-store.js'
import { continueDelegatedWorkflowApproval, type ApprovalBridgeDeps } from '../../workflow/approval.js'
import { assignReviewer, revokeAssignment } from '../assignment.js'
import { captureHumanDecisionSupport, revokePattern } from '../patterns.js'
import { reviewApprovalRequest, type ReviewConsumers } from '../resolution.js'
import { consumeDelegatedReceipt, validateDelegatedReceipt } from '../consumption.js'
import {
  approveThreeTimes, briefFixture, grantConfigure, key, makeWorkflow, patternRows, pendingStepApproval, person, revokeConfigure,
  sendStep, setWorkflowStep, store, type BriefFixture,
} from './fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

const none: ReviewConsumers = {}
const review = (f: BriefFixture, approvalId: string, consumers: ReviewConsumers = none, over: Partial<Parameters<typeof reviewApprovalRequest>[0]> = {}) =>
  reviewApprovalRequest({ workspaceId: f.workspaceId, approvalId, trigger: 'requested', requester: { kind: 'human', userId: f.people.lead }, ...over }, consumers)

/** Workflow default reviewer (ops, configure) set by the approver, plus three human approvals. */
async function qualified(opts: { reviewer?: 'ops' | 'brian' } = {}) {
  const f = await briefFixture()
  await grantConfigure(f.assistants.ops, f.people.owner)
  const workflowId = await makeWorkflow(f)
  const { assignment } = await assignReviewer(person(f.people.lead), f.workspaceId, {
    reviewerAssistantId: f.assistants[opts.reviewer ?? 'ops'], scopeKind: 'workflow', scopeId: workflowId, idempotencyKey: key(),
  })
  const support = await approveThreeTimes(f, workflowId)
  return { f, workflowId, assignment, support }
}

const status = async (id: string) => (await pool.query('SELECT status, resolution_origin, responded_by FROM pending_approvals WHERE id = $1', [id])).rows[0]

function bridge(f: BriefFixture, calls: ToolContext[]): ApprovalBridgeDeps {
  const tool = {
    name: 'slackPostMessage', description: 'fake', inputSchema: z.object({}).passthrough(),
    execute: vi.fn(async (_input: unknown, ctx: ToolContext) => { calls.push(ctx); return { data: { posted: true } } }),
  }
  return {
    approvalsStore: store, auditStore: createWorkspaceAuditStore(), workflowStore: createDbWorkflowStore(), runStore: createDbWorkflowRunStore(),
    buildToolRegistry: async () => new Map([['slackPostMessage', tool]]) as never,
    resolvePrimary: vi.fn(async () => f.assistants.brian),
    deliveries: async () => {},
    executorDeps: {} as never,
  }
}

describe('[COMP:api/approval-review-resolution] delegated resolution (real PG + RLS)', () => {
  it('A06: resolves an exact active pattern with a delegated receipt and no forged human evidence', async () => {
    const { f, workflowId, assignment, support } = await qualified()
    const { approval } = await pendingStepApproval(f, workflowId)
    const consumed = vi.fn(async () => ({ status: 'completed' }))
    const r = await review(f, approval.id, { workflowStep: consumed }, { explanation: 'Fictional: same digest as the last three' })
    expect(r).toMatchObject({ outcome: 'resolved', replay: false, consumer: { status: 'completed' } })
    if (r.outcome !== 'resolved') throw new Error('unreachable')
    expect(r.receipt).toMatchObject({ reviewerAssistantId: f.assistants.ops, delegatorUserId: f.people.lead, assignmentId: assignment.id, assignmentRevision: 1, patternVersion: 1 })
    expect([...r.receipt.supportApprovalIds].sort()).toEqual([...support].sort())
    expect(await status(approval.id)).toEqual({ status: 'approved', resolution_origin: 'delegated_assistant', responded_by: null })
    expect(consumed).toHaveBeenCalledTimes(1)
    // No human decision event, no pattern support, no task allowance renewal.
    expect((await pool.query(`SELECT count(*)::int n FROM decision_events WHERE source_id = $1`, [approval.id])).rows[0].n).toBe(0)
    expect((await pool.query(`SELECT count(*)::int n FROM approval_pattern_support WHERE approval_id = $1`, [approval.id])).rows[0].n).toBe(0)
    const audit = (await pool.query(`SELECT actor_user_id, details FROM workspace_audit_log WHERE subject_id = $1 AND event_type = 'approval_review.delegated_decision'`, [approval.id])).rows[0]
    expect(audit).toMatchObject({ actor_user_id: null, details: { origin: 'delegated_assistant', reviewerAssistantId: f.assistants.ops } })
    const attempt = (await pool.query(`SELECT outcome, explanation FROM approval_review_attempts WHERE approval_id = $1`, [approval.id])).rows
    expect(attempt).toEqual([{ outcome: 'resolved', explanation: 'Fictional: same digest as the last three' }])
  })

  it('A01/A04: no assignment, an unqualified pattern or a mismatch leaves the request pending with reasons', async () => {
    const f = await briefFixture()
    const workflowId = await makeWorkflow(f)
    await approveThreeTimes(f, workflowId)
    const { approval } = await pendingStepApproval(f, workflowId)
    expect(await review(f, approval.id)).toMatchObject({ outcome: 'needs_human', reasons: ['no_assignment'] })

    const q = await qualified()
    const other = await pendingStepApproval(q.f, q.workflowId, { args: { channel: '#fictional-ops', text: 'A different fictional digest' } })
    expect(await review(q.f, other.approval.id)).toMatchObject({ outcome: 'needs_human', reasons: ['no_active_pattern'] })
    const wrongExecutor = await pendingStepApproval(q.f, q.workflowId, { executor: q.f.assistants.ops })
    expect(await review(q.f, wrongExecutor.approval.id)).toMatchObject({ outcome: 'needs_human', reasons: ['no_active_pattern'] })
    for (const id of [approval.id, other.approval.id, wrongExecutor.approval.id]) expect((await status(id)).status).toBe('pending')
  })

  it('A02: the reviewer must currently hold configure, and only the assigned reviewer may run its tool path', async () => {
    const { f, workflowId } = await qualified()
    const { approval } = await pendingStepApproval(f, workflowId)
    expect(await review(f, approval.id, none, { trigger: 'reviewer_tool', requester: { kind: 'assistant', assistantId: f.assistants.brian } }))
      .toMatchObject({ outcome: 'blocked', reasons: ['reviewer_not_assigned'] })
    await revokeConfigure(f.assistants.ops)
    expect(await review(f, approval.id)).toMatchObject({ outcome: 'needs_human', reasons: ['reviewer_lacks_configure'] })
    expect((await status(approval.id)).status).toBe('pending')
  })

  it('A05: human-only actions stay human even with an assignment and an active pattern', async () => {
    const f = await briefFixture()
    await grantConfigure(f.assistants.ops, f.people.owner)
    const payWorkflow = await makeWorkflow(f, { step: sendStep({ toolName: 'stripeCreatePayment', arguments: { amount: 5 } }) })
    await assignReviewer(person(f.people.lead), f.workspaceId, { reviewerAssistantId: f.assistants.ops, scopeKind: 'workflow', scopeId: payWorkflow, idempotencyKey: key() })
    const { approval } = await pendingStepApproval(f, payWorkflow, { args: { amount: 5 } })
    await pool.query(`UPDATE pending_approvals SET tool_name = 'stripeCreatePayment' WHERE id = $1`, [approval.id])
    // Even a (forged) active lineage for the exact key cannot authorize it.
    await pool.query(`INSERT INTO approval_patterns (workspace_id, pattern_key, procedure_kind, procedure_id, step_key, action_kind, identity_key, descriptor, status, version, activated_at)
      VALUES ($1, 'forged', 'workflow', $2, 'send', 'stripeCreatePayment', 'x', '{}', 'active', 1, now() - interval '400 days')`, [f.workspaceId, payWorkflow])
    expect(await review(f, approval.id)).toMatchObject({ outcome: 'needs_human', reasons: ['human_only:payment'] })
    expect((await status(approval.id)).status).toBe('pending')
  })

  it('A07: one canonical decision wins any race; replays return the receipt; denials are never overwritten', async () => {
    const { f, workflowId } = await qualified()
    const ai = await pendingStepApproval(f, workflowId)
    const first = await review(f, ai.approval.id)
    expect(first.outcome).toBe('resolved')
    expect(await store.respond(ai.approval.id, 'rejected', f.people.lead)).toBeNull()
    const again = await review(f, ai.approval.id)
    expect(again).toMatchObject({ outcome: 'resolved', replay: true })
    if (first.outcome === 'resolved' && again.outcome === 'resolved') expect(again.receipt.id).toBe(first.receipt.id)
    const used = first.outcome === 'resolved' ? first.receipt.idempotencyKey : ''
    const third = await pendingStepApproval(f, workflowId)
    await expect(review(f, third.approval.id, none, { idempotencyKey: used })).rejects.toMatchObject({ code: 'idempotency_conflict' })

    // A concurrent human denial and AI review: exactly one outcome lands.
    const raced = await pendingStepApproval(f, workflowId)
    const [human] = await Promise.all([store.respond(raced.approval.id, 'rejected', f.people.lead), review(f, raced.approval.id).catch(() => null)])
    const final = await status(raced.approval.id)
    const receipt = (await pool.query('SELECT count(*)::int n FROM approval_delegated_resolutions WHERE approval_id = $1', [raced.approval.id])).rows[0].n
    if (human) expect([final.status, final.resolution_origin, receipt]).toEqual(['rejected', 'human', 0])
    else expect([final.status, final.resolution_origin, receipt]).toEqual(['approved', 'delegated_assistant', 1])

    // A human denial is final for its request, and it suspends the pattern (D43).
    const denied = await pendingStepApproval(f, workflowId)
    await store.respond(denied.approval.id, 'rejected', f.people.lead, 'Fictional not today')
    expect(await review(f, denied.approval.id)).toMatchObject({ outcome: 'blocked', reasons: ['not_pending'] })
    expect((await status(denied.approval.id)).status).toBe('rejected')
    expect((await patternRows(f.workspaceId))[0]).toMatchObject({ status: 'suspended', suspended_reason: 'unresolved_denial' })
    const after = await pendingStepApproval(f, workflowId)
    expect(await review(f, after.approval.id)).toMatchObject({ outcome: 'needs_human', reasons: ['pattern_suspended'] })
  })

  it('A08: no routine pattern expiry; revocation, changed definition, lost configure or lost access stop consumption', async () => {
    const { f, workflowId, assignment } = await qualified()
    await pool.query(`UPDATE approval_patterns SET activated_at = now() - interval '3 years', support_since = now() - interval '3 years' WHERE workspace_id = $1`, [f.workspaceId])
    await pool.query(`UPDATE approval_pattern_support SET decided_at = now() - interval '3 years' WHERE workspace_id = $1`, [f.workspaceId])
    const resolveOne = async () => {
      const { approval } = await pendingStepApproval(f, workflowId)
      const r = await review(f, approval.id)
      expect(r.outcome).toBe('resolved')
      return (await store.getByIdSystem(approval.id))!
    }
    const a1 = await resolveOne()
    expect((await validateDelegatedReceipt(a1)).ok).toBe(true)
    await revokeConfigure(f.assistants.ops)
    expect(await validateDelegatedReceipt(a1)).toMatchObject({ ok: false, reason: 'reviewer_lacks_configure' })
    await grantConfigure(f.assistants.ops, f.people.owner)
    // Once invalidated, a receipt stays invalid even if conditions are restored.
    expect(await validateDelegatedReceipt(a1)).toMatchObject({ ok: false, reason: 'reviewer_lacks_configure' })

    const a2 = await resolveOne()
    await setWorkflowStep(workflowId, sendStep({ arguments: { channel: '#fictional-all', text: '{{vars.summary}}' } }))
    expect(await validateDelegatedReceipt(a2)).toMatchObject({ ok: false, reason: 'mismatch:definition_changed' })
    await setWorkflowStep(workflowId, sendStep())

    const a3 = await resolveOne()
    await revokeAssignment(person(f.people.lead), f.workspaceId, assignment.id)
    expect(await validateDelegatedReceipt(a3)).toMatchObject({ ok: false, reason: 'assignment_revoked' })

    const { assignment: again } = await assignReviewer(person(f.people.lead), f.workspaceId, { reviewerAssistantId: f.assistants.ops, scopeKind: 'workflow', scopeId: workflowId, idempotencyKey: key() })
    expect(again.status).toBe('active')
    const a4 = await resolveOne()
    const [pattern] = (await patternRows(f.workspaceId)).filter((p) => p.status === 'active')
    await revokePattern(person(f.people.lead), f.workspaceId, pattern.id)
    expect(await validateDelegatedReceipt(a4)).toMatchObject({ ok: false, reason: 'pattern_revoked' })
    // Revocation is not silently restored: a new request needs fresh human evidence.
    const { approval: fresh } = await pendingStepApproval(f, workflowId)
    expect(await review(f, fresh.id)).toMatchObject({ outcome: 'needs_human' })

    // Pending-request expiry still works.
    const expiring = await pendingStepApproval(f, workflowId)
    await pool.query(`UPDATE pending_approvals SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expiring.approval.id])
    expect(await review(f, expiring.approval.id)).toMatchObject({ outcome: 'blocked', reasons: ['expired'] })
  })

  it('A10: the workflow continuation uses the original executor, never the primary, and revalidates before the effect', async () => {
    const { f, workflowId } = await qualified()
    const calls: ToolContext[] = []
    const deps = bridge(f, calls)
    const consumers: ReviewConsumers = {
      workflowStep: (approval, receipt) => continueDelegatedWorkflowApproval(deps, approval, receipt.delegatorUserId, async () => {
        const c = await consumeDelegatedReceipt((await store.getByIdSystem(approval.id))!)
        return c.ok ? { ok: true } : { ok: false, reason: c.reason }
      }),
    }
    const { approval, runId } = await pendingStepApproval(f, workflowId)
    const r = await review(f, approval.id, consumers)
    expect(r).toMatchObject({ outcome: 'resolved', consumer: { status: 'completed', runId } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ assistantId: f.assistants.brian, userId: f.people.lead, workspaceId: f.workspaceId })
    expect(deps.resolvePrimary).not.toHaveBeenCalled()
    expect((await pool.query('SELECT consumed_at IS NOT NULL AS c FROM approval_delegated_resolutions WHERE approval_id = $1', [approval.id])).rows[0].c).toBe(true)

    // Authority lost between claim and consumption: no effect, an attributable failure.
    const late = await pendingStepApproval(f, workflowId)
    const claimed = await review(f, late.approval.id)
    expect(claimed.outcome).toBe('resolved')
    await revokeConfigure(f.assistants.ops)
    const out = await consumers.workflowStep!((await store.getByIdSystem(late.approval.id))!, (claimed as unknown as { receipt: never }).receipt)
    expect(out).toMatchObject({ status: 'failed' })
    expect(calls).toHaveLength(1)
    const step = (await pool.query('SELECT status, error FROM workflow_step_runs WHERE id = $1', [late.stepRunId])).rows[0]
    expect(step).toMatchObject({ status: 'failed', error: { reason: 'delegated_authority_lost' } })
  })

  it('A10: a browser terminal send is approved for the runner only while its receipt validates', async () => {
    const f = await briefFixture()
    await grantConfigure(f.assistants.ops, f.people.owner)
    const skillId = randomUUID()
    await pool.query(`INSERT INTO browser_skills (id, workspace_id, name, site, code, contract, origin, created_by, version)
      VALUES ($1,$2,'Fictional timesheet','hr.fictional.example','pass','{"terminalSends":[]}','assistant',$3,2)`, [skillId, f.workspaceId, f.people.lead])
    const payload = { skillId, skillVersion: 2, skillName: 'Fictional timesheet', profileId: randomUUID(), profileName: 'Fictional', site: 'hr.fictional.example', ref: 'e7', label: 'Submit timesheet', description: 'Submit the weekly timesheet' }
    const send = (p: Record<string, unknown> = payload) => store.createBrowserSkillSend({ workspaceId: f.workspaceId, approverUserId: f.people.lead, payload: p })
    await assignReviewer(person(f.people.lead), f.workspaceId, { reviewerAssistantId: f.assistants.ops, scopeKind: 'browser_skill', scopeId: skillId, idempotencyKey: key() })
    for (let i = 0; i < 3; i++) {
      const row = await send()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const flipped = (await client.query(`UPDATE pending_approvals SET status = 'approved', responded_by = $2, responded_at = now(), resolution_origin = 'human' WHERE id = $1 RETURNING id`, [row.id, f.people.lead])).rows[0]
        expect(flipped).toBeTruthy()
        await captureHumanDecisionSupport(client, { ...row, status: 'approved' }, 'approved', f.people.lead)
        await client.query('COMMIT')
      } finally { client.release() }
    }
    expect((await patternRows(f.workspaceId)).map((p) => p.status)).toEqual(['active'])
    const ceiling = await send({ ...payload, ceiling: 'payment' })
    expect(await review(f, ceiling.id)).toMatchObject({ outcome: 'needs_human' })
    const next = await send()
    expect((await review(f, next.id)).outcome).toBe('resolved')
    expect(await readBrowserSendApprovalStatus(store, next.id)).toBe('approved')
    const later = await send()
    expect((await review(f, later.id)).outcome).toBe('resolved')
    const [pattern] = await patternRows(f.workspaceId)
    await revokePattern(person(f.people.lead), f.workspaceId, pattern.id)
    expect(await readBrowserSendApprovalStatus(store, later.id)).toBe('unavailable')
  })
})
