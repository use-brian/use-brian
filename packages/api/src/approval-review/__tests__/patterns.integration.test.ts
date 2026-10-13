/**
 * Approval pattern lineages from real human decisions against a migration-
 * replayed PostgreSQL 18: three distinct human executions qualify; one chain,
 * a denial, a definition change, different parameters or a human-only action
 * do not; revocation requires fresh evidence; inspection is source-filtered.
 * Runs only through scripts/crm/local-fixture.mjs. Fictional identities.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { assignReviewer } from '../assignment.js'
import { getPattern, listPatterns, revokePattern } from '../patterns.js'
import {
  approveThreeTimes, briefFixture, grantConfigure, key, makeWorkflow, patternRows, pendingStepApproval, person, sendStep, setWorkflowStep, store,
} from './fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function setup() {
  const f = await briefFixture()
  const workflowId = await makeWorkflow(f)
  return { f, workflowId }
}

describe('[COMP:api/approval-review-patterns] human approval patterns (real PG + RLS)', () => {
  it('A03: three distinct human-approved executions activate one lineage', async () => {
    const { f, workflowId } = await setup()
    const ids = await approveThreeTimes(f, workflowId)
    const rows = await patternRows(f.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'active', version: 1 })
    const support = await pool.query('SELECT approval_id, chain_key, decision FROM approval_pattern_support WHERE pattern_id = $1 ORDER BY decided_at', [rows[0].id])
    expect(support.rows.map((r) => r.approval_id)).toEqual(ids)
  })

  it('A03: approvals within one execution chain count once', async () => {
    const { f, workflowId } = await setup()
    const first = await pendingStepApproval(f, workflowId)
    await store.respond(first.approval.id, 'approved', f.people.lead)
    for (let i = 0; i < 3; i++) {
      const again = await pendingStepApproval(f, workflowId, { runId: first.runId })
      await store.respond(again.approval.id, 'approved', f.people.lead)
    }
    expect((await patternRows(f.workspaceId))[0]).toMatchObject({ status: 'proposed' })
    // A replayed respond is idempotent and adds no support.
    expect(await store.respond(first.approval.id, 'approved', f.people.lead)).toBeNull()
    expect((await pool.query('SELECT count(*)::int n FROM approval_pattern_support WHERE approval_id = $1', [first.approval.id])).rows[0].n).toBe(1)
  })

  it('A03/A08: a human denial suspends the lineage; only revocation plus fresh evidence requalifies', async () => {
    const { f, workflowId } = await setup()
    await approveThreeTimes(f, workflowId)
    const denied = await pendingStepApproval(f, workflowId)
    await store.respond(denied.approval.id, 'rejected', f.people.lead, 'Fictional wrong channel')
    let rows = await patternRows(f.workspaceId)
    expect(rows[0]).toMatchObject({ status: 'suspended', suspended_reason: 'unresolved_denial' })
    // More approvals (or time) do not clear a denial.
    await approveThreeTimes(f, workflowId)
    expect((await patternRows(f.workspaceId))[0]).toMatchObject({ status: 'suspended' })

    await revokePattern(person(f.people.lead), f.workspaceId, rows[0].id, { reason: 'Fictional reset' })
    const next = await pendingStepApproval(f, workflowId)
    await store.respond(next.approval.id, 'approved', f.people.lead)
    rows = await patternRows(f.workspaceId)
    expect(rows.map((r) => [r.status, r.version])).toEqual([['revoked', 1], ['proposed', 2]])
    await approveThreeTimes(f, workflowId)
    expect((await patternRows(f.workspaceId))[1]).toMatchObject({ status: 'active', version: 2 })
  })

  it('A04/A08: a changed step definition suspends the old lineage and starts a new one', async () => {
    const { f, workflowId } = await setup()
    await approveThreeTimes(f, workflowId)
    await setWorkflowStep(workflowId, sendStep({ arguments: { channel: '#fictional-all', text: '{{vars.summary}}' } }))
    const after = await pendingStepApproval(f, workflowId)
    await store.respond(after.approval.id, 'approved', f.people.lead)
    const rows = await patternRows(f.workspaceId)
    expect(rows.map((r) => [r.status, r.suspended_reason])).toEqual([['suspended', 'definition_changed'], ['proposed', null]])
  })

  it('A04: different parameters, executor identity or approver policy build different lineages', async () => {
    const { f, workflowId } = await setup()
    await approveThreeTimes(f, workflowId)
    const other = await pendingStepApproval(f, workflowId, { args: { channel: '#fictional-ops', text: 'A different fictional digest' } })
    await store.respond(other.approval.id, 'approved', f.people.lead)
    const viaOps = await pendingStepApproval(f, workflowId, { executor: f.assistants.ops })
    await store.respond(viaOps.approval.id, 'approved', f.people.lead)
    expect((await patternRows(f.workspaceId)).map((r) => r.status)).toEqual(['active', 'proposed', 'proposed'])
    // An explicit varying-field policy keys a new lineage: it needs its own three approvals.
    await grantConfigure(f.assistants.ops, f.people.owner)
    await assignReviewer(person(f.people.lead), f.workspaceId, {
      reviewerAssistantId: f.assistants.ops, scopeKind: 'workflow', scopeId: workflowId, idempotencyKey: key(),
      parameterPolicy: { text: { rule: 'text', maxLength: 80 } },
    })
    const varying = await pendingStepApproval(f, workflowId)
    await store.respond(varying.approval.id, 'approved', f.people.lead)
    expect((await patternRows(f.workspaceId)).map((r) => r.status)).toEqual(['active', 'proposed', 'proposed', 'proposed'])
  })

  it('A05: human-only actions never become patterns', async () => {
    const { f } = await setup()
    const payWorkflow = await makeWorkflow(f, { step: sendStep({ toolName: 'stripeCreatePayment', arguments: { amount: 5 } }) })
    for (let i = 0; i < 3; i++) {
      const { approval } = await pendingStepApproval(f, payWorkflow, { args: { amount: 5 } })
      await pool.query(`UPDATE pending_approvals SET tool_name = 'stripeCreatePayment' WHERE id = $1`, [approval.id])
      await store.respond(approval.id, 'approved', f.people.lead)
    }
    expect(await patternRows(f.workspaceId)).toEqual([])
  })

  it('A09: pattern inspection is source-filtered and revocation needs a human with standing', async () => {
    const { f, workflowId } = await setup()
    await approveThreeTimes(f, workflowId)
    const [p] = await listPatterns(person(f.people.lead), f.workspaceId)
    expect(p).toMatchObject({ status: 'active', support: { approvedChains: 3, required: 3, contradicted: false } })
    const detail = await getPattern(person(f.people.lead), f.workspaceId, p.id)
    expect(detail.supportRefs).toHaveLength(3)
    await expect(revokePattern(person(f.people.lead, 'mcp'), f.workspaceId, p.id)).rejects.toMatchObject({ code: 'human_intent_required' })
    await expect(revokePattern(person(f.people.member), f.workspaceId, p.id)).rejects.toMatchObject({ status: expect.any(Number) })
    await expect(revokePattern(person(f.people.lead), f.workspaceId, p.id, { expectedRevision: p.revision + 5 })).rejects.toMatchObject({ code: 'stale_revision' })
    const revoked = await revokePattern(person(f.people.lead), f.workspaceId, p.id, { expectedRevision: p.revision })
    expect(revoked).toMatchObject({ status: 'revoked', revokedByUserId: f.people.lead })
  })
})
