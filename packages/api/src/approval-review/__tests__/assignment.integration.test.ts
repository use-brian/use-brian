/**
 * Explicit reviewer assignment against a migration-replayed PostgreSQL 18
 * with real RLS: no reviewer by default (even for a configure-enabled
 * primary), human-only authoring, delegation rights, reviewer configure and
 * source admission, idempotency, revision checks, revocation and
 * source-filtered reads. Runs only through scripts/crm/local-fixture.mjs.
 * Fictional identities.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { listAssignmentsForViewer } from '../../db/approval-review-store.js'
import { assignReviewer, changeAssignment, revokeAssignment } from '../assignment.js'
import { effectiveAssignmentFor } from '../patterns.js'
import { loadRequestFacts } from '../source.js'
import { briefFixture, grantConfigure, key, makeWorkflow, pendingStepApproval, person, revokeConfigure, store } from './fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function setup() {
  const f = await briefFixture()
  await grantConfigure(f.assistants.ops, f.people.owner)
  const workflowId = await makeWorkflow(f)
  return { f, workflowId }
}
const wfAssign = (reviewer: string, workflowId: string, over: Record<string, unknown> = {}) =>
  ({ reviewerAssistantId: reviewer, scopeKind: 'workflow', scopeId: workflowId, idempotencyKey: key(), ...over })

describe('[COMP:api/approval-review-assignment] explicit reviewer assignment (real PG + RLS)', () => {
  it('A01: no reviewer by default, even for a configure-enabled primary assistant', async () => {
    const { f, workflowId } = await setup()
    await grantConfigure(f.assistants.brian, f.people.owner)
    const { approval } = await pendingStepApproval(f, workflowId)
    expect(await effectiveAssignmentFor(await loadRequestFacts(approval))).toBeNull()
    expect((await pool.query('SELECT count(*)::int n FROM approval_review_assignments WHERE workspace_id = $1', [f.workspaceId])).rows[0].n).toBe(0)
  })

  it('A01: an explicit workflow default applies to its owner-approved requests; a request override wins', async () => {
    const { f, workflowId } = await setup()
    await grantConfigure(f.assistants.brian, f.people.owner)
    const made = await assignReviewer(person(f.people.lead), f.workspaceId, wfAssign(f.assistants.ops, workflowId))
    expect(made).toMatchObject({ outcome: 'created', assignment: { delegatorUserId: f.people.lead, reviewerAssistantId: f.assistants.ops, origin: 'ui', status: 'active', revision: 1 } })
    const { approval } = await pendingStepApproval(f, workflowId)
    expect((await effectiveAssignmentFor(await loadRequestFacts(approval)))?.id).toBe(made.assignment.id)
    const override = await assignReviewer(person(f.people.lead, 'chat'), f.workspaceId, {
      reviewerAssistantId: f.assistants.brian, scopeKind: 'request', scopeId: approval.id, idempotencyKey: key(),
    })
    expect(override.assignment.origin).toBe('chat')
    expect((await effectiveAssignmentFor(await loadRequestFacts(approval)))?.id).toBe(override.assignment.id)
    // A request approved by someone else never inherits this human's default.
    const { approval: other } = await pendingStepApproval(f, workflowId, { approver: f.people.member })
    expect(await effectiveAssignmentFor(await loadRequestFacts(other))).toBeNull()
  })

  it('A13: only an authenticated human can assign; MCP and unattended callers cannot fabricate delegation', async () => {
    const { f, workflowId } = await setup()
    await expect(assignReviewer(person(f.people.lead, 'mcp'), f.workspaceId, wfAssign(f.assistants.ops, workflowId)))
      .rejects.toMatchObject({ code: 'human_intent_required', status: 403 })
    await expect(assignReviewer({ userId: f.people.lead, origin: 'chat', human: false }, f.workspaceId, wfAssign(f.assistants.ops, workflowId)))
      .rejects.toMatchObject({ code: 'human_intent_required' })
    // A caller-supplied actor or human flag in the payload is refused by the strict schema.
    await expect(assignReviewer(person(f.people.lead), f.workspaceId, { ...wfAssign(f.assistants.ops, workflowId), delegatorUserId: f.people.owner, human: true }))
      .rejects.toMatchObject({ code: 'invalid_input', status: 400 })
  })

  it('A02: the reviewer must hold configure; granting configure never appoints a reviewer', async () => {
    const { f, workflowId } = await setup()
    await expect(assignReviewer(person(f.people.lead), f.workspaceId, wfAssign(f.assistants.brian, workflowId)))
      .rejects.toMatchObject({ code: 'reviewer_lacks_configure', status: 422 })
    await expect(assignReviewer(person(f.people.lead), f.workspaceId, wfAssign(randomUUID(), workflowId)))
      .rejects.toMatchObject({ code: 'reviewer_unavailable' })
  })

  it('A02/A09: a reviewer outside the request Project or above its clearance is not admitted', async () => {
    const { f, workflowId } = await setup()
    const { approval } = await pendingStepApproval(f, workflowId, { projectIds: [f.projectId] })
    await expect(assignReviewer(person(f.people.lead), f.workspaceId, { reviewerAssistantId: f.assistants.ops, scopeKind: 'request', scopeId: approval.id, idempotencyKey: key() }))
      .rejects.toMatchObject({ code: 'reviewer_not_admitted' })
    const { approval: secret } = await pendingStepApproval(f, workflowId)
    await pool.query(`UPDATE pending_approvals SET approval_payload = approval_payload || '{"sensitivity":"confidential"}' WHERE id = $1`, [secret.id])
    await expect(assignReviewer(person(f.people.lead), f.workspaceId, { reviewerAssistantId: f.assistants.ops, scopeKind: 'request', scopeId: secret.id, idempotencyKey: key() }))
      .rejects.toMatchObject({ code: 'reviewer_not_admitted' })
  })

  it('only the delegating human (the approver / owner) may delegate; others are refused without leaking existence', async () => {
    const { f, workflowId } = await setup()
    const { approval } = await pendingStepApproval(f, workflowId)
    // A member who can read the request but is not its approver cannot delegate it.
    await expect(assignReviewer(person(f.people.member), f.workspaceId, { reviewerAssistantId: f.assistants.ops, scopeKind: 'request', scopeId: approval.id, idempotencyKey: key() }))
      .rejects.toMatchObject({ status: expect.any(Number) })
    expect(['delegation_not_yours', 'not_found']).toContain(
      await assignReviewer(person(f.people.member), f.workspaceId, { reviewerAssistantId: f.assistants.ops, scopeKind: 'request', scopeId: approval.id, idempotencyKey: key() })
        .catch((e) => e.code))
    await expect(assignReviewer(person(f.people.member), f.workspaceId, wfAssign(f.assistants.ops, workflowId)))
      .rejects.toMatchObject({ code: 'delegation_not_yours' })
    const stranger = randomUUID()
    await pool.query(`INSERT INTO users(id,auth_provider_id,name) VALUES($1,$2,'Fictional stranger')`, [stranger, stranger])
    await expect(assignReviewer(person(stranger), f.workspaceId, wfAssign(f.assistants.ops, workflowId))).rejects.toMatchObject({ code: 'not_found', status: 404 })
    await expect(assignReviewer(person(f.people.lead), f.workspaceId, wfAssign(f.assistants.ops, randomUUID()))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('replays an idempotency key, refuses a different payload under it, and keeps one active reviewer per scope', async () => {
    const { f, workflowId } = await setup()
    const body = wfAssign(f.assistants.ops, workflowId)
    const first = await assignReviewer(person(f.people.lead), f.workspaceId, body)
    expect(await assignReviewer(person(f.people.lead), f.workspaceId, body)).toMatchObject({ outcome: 'duplicate', assignment: { id: first.assignment.id } })
    await expect(assignReviewer(person(f.people.lead), f.workspaceId, { ...body, parameterPolicy: { text: { rule: 'text', maxLength: 10 } } }))
      .rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 })
    await expect(assignReviewer(person(f.people.lead), f.workspaceId, wfAssign(f.assistants.ops, workflowId)))
      .rejects.toMatchObject({ code: 'assignment_exists', status: 409 })
  })

  it('changes are revision-checked and delegator-only; revocation is audited and stops the default', async () => {
    const { f, workflowId } = await setup()
    await grantConfigure(f.assistants.brian, f.people.owner)
    const { assignment } = await assignReviewer(person(f.people.lead), f.workspaceId, wfAssign(f.assistants.ops, workflowId))
    await expect(changeAssignment(person(f.people.owner), f.workspaceId, assignment.id, { expectedRevision: 1, reviewerAssistantId: f.assistants.brian }))
      .rejects.toMatchObject({ code: 'delegation_not_yours' })
    const changed = await changeAssignment(person(f.people.lead), f.workspaceId, assignment.id, { expectedRevision: 1, reviewerAssistantId: f.assistants.brian })
    expect(changed).toMatchObject({ revision: 2, reviewerAssistantId: f.assistants.brian })
    await expect(changeAssignment(person(f.people.lead), f.workspaceId, assignment.id, { expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'stale_revision', status: 409 })
    await revokeConfigure(f.assistants.ops)
    await expect(changeAssignment(person(f.people.lead), f.workspaceId, assignment.id, { expectedRevision: 2, reviewerAssistantId: f.assistants.ops }))
      .rejects.toMatchObject({ code: 'reviewer_lacks_configure' })

    await expect(revokeAssignment(person(f.people.member), f.workspaceId, assignment.id)).rejects.toMatchObject({ code: 'delegation_not_yours' })
    await expect(revokeAssignment(person(f.people.lead, 'mcp'), f.workspaceId, assignment.id)).rejects.toMatchObject({ code: 'human_intent_required' })
    const revoked = await revokeAssignment(person(f.people.owner), f.workspaceId, assignment.id, { reason: 'Fictional rotation' })
    expect(revoked).toMatchObject({ status: 'revoked', revokedByUserId: f.people.owner, revokeReason: 'Fictional rotation' })
    const { approval } = await pendingStepApproval(f, workflowId)
    expect(await effectiveAssignmentFor(await loadRequestFacts(approval))).toBeNull()
    const audit = await pool.query(`SELECT event_type FROM workspace_audit_log WHERE workspace_id = $1 AND subject_id = $2 ORDER BY created_at`, [f.workspaceId, assignment.id])
    expect(audit.rows.map((r) => r.event_type)).toEqual(['approval_review.assigned', 'approval_review.assignment_changed', 'approval_review.assignment_revoked'])
  })

  it('A09: assignment reads follow the scope source (a private task assignment is invisible to others)', async () => {
    const { f } = await setup()
    const task = (await pool.query(`INSERT INTO tasks (workspace_id, title, user_id, created_by_user_id) VALUES ($1,'Fictional private chore',$2,$2) RETURNING id`, [f.workspaceId, f.people.lead])).rows[0].id
    const { assignment } = await assignReviewer(person(f.people.lead), f.workspaceId, { reviewerAssistantId: f.assistants.ops, scopeKind: 'task', scopeId: task, idempotencyKey: key() })
    expect((await listAssignmentsForViewer(f.people.lead, f.workspaceId)).map((a) => a.id)).toContain(assignment.id)
    expect((await listAssignmentsForViewer(f.people.outsider, f.workspaceId)).map((a) => a.id)).not.toContain(assignment.id)
    await expect(revokeAssignment(person(f.people.outsider), f.workspaceId, assignment.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('A14: the request lane leaves normal human approval untouched', async () => {
    const { f, workflowId } = await setup()
    const { approval } = await pendingStepApproval(f, workflowId)
    const done = await store.respond(approval.id, 'approved', f.people.lead)
    expect(done).toMatchObject({ status: 'approved', respondedBy: f.people.lead, resolutionOrigin: 'human' })
    const ev = await pool.query(`SELECT count(*)::int n FROM decision_events WHERE source_id = $1 AND event_kind = 'approval.decided'`, [approval.id])
    expect(ev.rows[0].n).toBe(1)
  })
})
