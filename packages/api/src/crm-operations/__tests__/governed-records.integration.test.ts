import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import type { CrmOperationsCommand, CrmOperationsContext } from '@use-brian/core'
import { createCrmOperationsService } from '../service.js'
import { createDbCrmOperationsStore } from '../../db/crm-operations-store.js'
import { createCrmGovernedReadStore } from '../../db/crm-governed-store.js'
import { updateDeal } from '../../db/crm.js'
import { updateEntity } from '../../db/entities-store.js'
import { mutationActorAccess } from '../../db/access-predicate.js'
import { getAppPool, getPool } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
const reads = createCrmGovernedReadStore(((sql: string, values: unknown[]) => pool.query(sql, values)) as never)
afterAll(async () => { await pool.end(); await getAppPool().end(); await getPool().end() })

async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), admin = randomUUID(), member = randomUUID()
  for (const user of [owner, admin, member]) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional governed fixture',$2)", [workspaceId, owner])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'admin','confidential'),($1,$4,'member','internal')`,
    [workspaceId, owner, admin, member])
  const roles: Record<string, 'owner' | 'admin' | 'member'> = { [owner]: 'owner', [admin]: 'admin', [member]: 'member' }
  const entity = async (kind: 'company' | 'deal', name: string, attributes: Record<string, unknown> = {}) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,attributes,sensitivity)
      VALUES($1,$2,$3,$4,$5,'manual',$6::jsonb,'internal')`, [id, workspaceId, kind, name, owner, JSON.stringify(attributes)])
    return id
  }
  const ctx = (userId: string): CrmOperationsContext => ({
    workspaceId, actor: { kind: 'user', userId },
    authority: { role: roles[userId]!, canWrite: true, canConfigure: roles[userId] !== 'member', trustedIdentitySources: [] },
  })
  const exec = (userId: string, command: Record<string, unknown>) =>
    service.execute(ctx(userId), { operationId: randomUUID(), ...command } as CrmOperationsCommand)
  const company = await entity('company', 'Example Client Limited')
  const deal = await entity('deal', 'Example annual engagement', { company_id: company })
  await exec(owner, { kind: 'save_engagement_catalog', catalog: 'service_category', expectedVersion: 0,
    entries: [{ key: 'audit', label: 'Audit' }, { key: 'advisory', label: 'Advisory' }] })
  await exec(owner, { kind: 'save_engagement_catalog', catalog: 'work_status', expectedVersion: 0,
    entries: [{ key: 'not_started', label: 'Not started' }, { key: 'fieldwork', label: 'Fieldwork' }, { key: 'complete', label: 'Complete' }] })
  return { workspaceId, owner, admin, member, entity, exec, ctx, company, deal }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

const request = (result: { record: Record<string, unknown> }) => result.record.request as { id: string; version: number; revision: number; state: string }
async function displayName(id: string) {
  return (await pool.query<{ display_name: string }>('SELECT display_name FROM entities WHERE id=$1 AND valid_to IS NULL', [id])).rows[0]?.display_name
}
async function decisions(requestId: string) {
  return (await pool.query<{ revision: number; decision: string; reason: string | null }>(
    'SELECT revision,decision,reason FROM crm_change_request_decisions WHERE request_id=$1 ORDER BY created_at,id', [requestId])).rows
}
async function draft(f: Fixture, userId: string, target: Record<string, unknown>, changes: Record<string, unknown>) {
  const saved = request(await f.exec(userId, { kind: 'save_change_request', target, changes }))
  return request(await f.exec(userId, { kind: 'submit_change_request', requestId: saved.id, expectedVersion: saved.version }))
}
async function policy(f: Fixture, subject: string, value: Record<string, unknown>) {
  const current = (await reads.listCatalogs(f.workspaceId)).policies.find((row) => row.subject === subject) as { version: number }
  await f.exec(f.owner, { kind: 'save_governance_policy', subject, expectedVersion: current.version, policy: value })
}

describe('[COMP:crm/governed-records] governed client and engagement changes on PostgreSQL', () => {
  it('G1 submits, returns, resubmits as a new revision and applies on review; direct application keeps the evidence', async () => {
    const f = await fixture()
    const submitted = await draft(f, f.member, { kind: 'company', id: f.company }, { name: 'Example Client Holdings Limited' })
    expect(submitted).toMatchObject({ state: 'submitted', revision: 1 })
    expect(await displayName(f.company)).toBe('Example Client Limited')
    // A member is not a reviewer.
    await expect(f.exec(f.member, { kind: 'decide_change_request', requestId: submitted.id, expectedRevision: 1, decision: 'approve' }))
      .rejects.toMatchObject({ code: 'not_authorized' })
    const returned = request(await f.exec(f.owner, { kind: 'decide_change_request', requestId: submitted.id, expectedRevision: 1, decision: 'return', reason: 'Use the registered name.' }))
    expect(returned.state).toBe('returned')
    const revised = request(await f.exec(f.member, { kind: 'save_change_request', requestId: submitted.id, expectedVersion: returned.version,
      target: { kind: 'company', id: f.company }, changes: { name: 'Example Client (Holdings) Limited' } }))
    const resubmitted = request(await f.exec(f.member, { kind: 'submit_change_request', requestId: submitted.id, expectedVersion: revised.version }))
    expect(resubmitted).toMatchObject({ state: 'submitted', revision: 2 })
    // A decision against the superseded revision is stale.
    await expect(f.exec(f.owner, { kind: 'decide_change_request', requestId: submitted.id, expectedRevision: 1, decision: 'approve' }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale_version', currentRevision: 2 } })
    const approved = await f.exec(f.owner, { kind: 'decide_change_request', requestId: submitted.id, expectedRevision: 2, decision: 'approve' })
    expect(request(approved).state).toBe('approved')
    expect(await displayName(f.company)).toBe('Example Client (Holdings) Limited')
    expect(await decisions(submitted.id)).toEqual([
      { revision: 1, decision: 'returned', reason: 'Use the registered name.' }, { revision: 2, decision: 'approved', reason: null }])
    const detail = await reads.getChangeRequest(f.workspaceId, { userId: f.owner }, submitted.id) as { revisions: Array<{ revision: number; currentSnapshot: Record<string, unknown>; changes: Record<string, unknown> }> }
    expect(detail.revisions.map((revision) => [revision.revision, revision.currentSnapshot.name, revision.changes.name])).toEqual([
      [1, 'Example Client Limited', 'Example Client Holdings Limited'], [2, 'Example Client Limited', 'Example Client (Holdings) Limited']])
    // Revisions are immutable evidence.
    await expect(pool.query("UPDATE crm_change_request_revisions SET payload_hash=repeat('0',64) WHERE request_id=$1", [submitted.id]))
      .rejects.toMatchObject({ message: expect.stringContaining('crm_commercial_record_append_only') })
    // An owner applies directly; approval-time references are assigned in the same transaction.
    await f.exec(f.owner, { kind: 'save_reference_definition', definition: { definitionKey: 'client-code', label: 'Client code', targetKinds: ['company'],
      assignmentMode: 'native', assignmentEvent: 'approval', namespaceKey: 'client-codes', format: [{ kind: 'literal', text: 'CL-' }, { kind: 'counter', width: 4 }] } })
    const direct = await draft(f, f.owner, { kind: 'company' }, { name: 'Example New Client Limited', domain: 'new-client.example', assignReferences: [{ definitionKey: 'client-code' }] })
    expect(direct.state).toBe('approved')
    const created = (await pool.query<{ applied_target_id: string }>('SELECT applied_target_id FROM crm_change_requests WHERE id=$1', [direct.id])).rows[0]!.applied_target_id
    expect(await displayName(created)).toBe('Example New Client Limited')
    expect((await pool.query('SELECT printable_value FROM crm_business_references WHERE target_id=$1', [created])).rows).toEqual([{ printable_value: 'CL-0001' }])
    expect(await decisions(direct.id)).toEqual([{ revision: 1, decision: 'applied_direct', reason: null }])
    // A replayed submit returns the committed result without a second apply.
    const operationId = randomUUID()
    const again = request(await f.exec(f.owner, { kind: 'save_change_request', target: { kind: 'company', id: created }, changes: { domain: 'client.example' } }))
    const first = await service.execute(f.ctx(f.owner), { kind: 'submit_change_request', operationId, requestId: again.id, expectedVersion: again.version })
    const replay = await service.execute(f.ctx(f.owner), { kind: 'submit_change_request', operationId, requestId: again.id, expectedVersion: again.version })
    expect(replay).toMatchObject({ duplicate: true, record: first.record })
    expect((await decisions(again.id)).length).toBe(1)
  })

  it('G2 fails stale reviews and forbidden self-review atomically, then recovers by return and resubmit', async () => {
    const f = await fixture()
    await f.exec(f.owner, { kind: 'save_reference_definition', definition: { definitionKey: 'job-code', label: 'Job code', targetKinds: ['deal'],
      assignmentMode: 'native', assignmentEvent: 'approval', namespaceKey: 'job-codes', format: [{ kind: 'literal', text: 'JOB-' }, { kind: 'counter', width: 3 }] } })
    const submitted = await draft(f, f.member, { kind: 'deal', id: f.deal }, { engagement: { serviceCategory: 'audit', periodStart: '2026-01-01', periodEnd: '2026-12-31' },
      assignReferences: [{ definitionKey: 'job-code' }] })
    // The deal changes underneath the review.
    await updateEntity(f.owner, f.deal, { displayName: 'Example annual engagement (renamed)' }, mutationActorAccess(f.owner, f.workspaceId))
    await expect(f.exec(f.admin, { kind: 'decide_change_request', requestId: submitted.id, expectedRevision: 1, decision: 'approve' }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale_review' } })
    // Nothing moved: no engagement, no reference, no counter, no decision, state unchanged.
    expect((await pool.query('SELECT 1 FROM crm_engagement_extensions WHERE deal_id=$1', [f.deal])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM crm_business_references WHERE target_id=$1', [f.deal])).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM crm_number_partitions p JOIN crm_number_series s ON s.id=p.series_id
      JOIN crm_reference_definitions d ON d.id=s.definition_id WHERE d.workspace_id=$1 AND d.definition_key='job-code' AND p.allocated_count>0`, [f.workspaceId])).rowCount).toBe(0)
    expect(await decisions(submitted.id)).toEqual([])
    expect(request({ record: (await reads.getChangeRequest(f.workspaceId, { userId: f.owner }, submitted.id))! }).state).toBe('submitted')
    // Recover: return, resubmit against current values, approve.
    const returned = request(await f.exec(f.admin, { kind: 'decide_change_request', requestId: submitted.id, expectedRevision: 1, decision: 'return', reason: 'Record changed; resubmit.' }))
    const again = request(await f.exec(f.member, { kind: 'submit_change_request', requestId: submitted.id, expectedVersion: returned.version }))
    await f.exec(f.admin, { kind: 'decide_change_request', requestId: submitted.id, expectedRevision: again.revision, decision: 'approve' })
    const engagement = (await reads.listEngagements(f.workspaceId, { userId: f.owner }, { dealId: f.deal, includeCommercialValues: false, limit: 50 })).engagements[0]
    expect(engagement).toMatchObject({ serviceCategory: 'audit', periodStart: '2026-01-01', periodEnd: '2026-12-31', trackingVersion: 1 })
    expect((await pool.query('SELECT printable_value FROM crm_business_references WHERE target_id=$1', [f.deal])).rows).toEqual([{ printable_value: 'JOB-001' }])

    // Self-review is refused when the policy forbids it, and another reviewer may decide.
    await policy(f, 'client_change', { mode: 'single_review', directRoles: [], allowSelfReview: false })
    const own = await draft(f, f.owner, { kind: 'company', id: f.company }, { domain: 'client.example' })
    expect(own.state).toBe('submitted')
    await expect(f.exec(f.owner, { kind: 'decide_change_request', requestId: own.id, expectedRevision: 1, decision: 'approve' }))
      .rejects.toMatchObject({ code: 'not_authorized', details: { reason: 'self_review' } })
    expect(await decisions(own.id)).toEqual([])
    await f.exec(f.admin, { kind: 'decide_change_request', requestId: own.id, expectedRevision: 1, decision: 'approve' })
    expect((await pool.query("SELECT attributes->>'domain' AS domain FROM entities WHERE id=$1 AND valid_to IS NULL", [f.company])).rows[0]).toEqual({ domain: 'client.example' })
    // Unknown catalog keys are typed refusals with the valid values.
    await expect(draft(f, f.member, { kind: 'deal', id: f.deal }, { engagement: { workStatus: 'paused' } }))
      .rejects.toMatchObject({ code: 'catalog_key_invalid', details: { validValues: ['not_started', 'fieldwork', 'complete'] } })
    // Only the author withdraws.
    const pending = await draft(f, f.member, { kind: 'company', id: f.company }, { name: 'Withdrawn name' })
    await expect(f.exec(f.admin, { kind: 'withdraw_change_request', requestId: pending.id, expectedVersion: pending.version, reason: 'Not mine' }))
      .rejects.toMatchObject({ code: 'not_authorized' })
    expect(request(await f.exec(f.member, { kind: 'withdraw_change_request', requestId: pending.id, expectedVersion: pending.version, reason: 'No longer needed' })).state).toBe('withdrawn')
  })

  it('G3 keeps protected values out of generic writers, extraction and ordinary deal reads', async () => {
    const f = await fixture()
    const set = await f.exec(f.owner, { kind: 'set_commercial_values', dealId: f.deal,
      values: [{ valueKind: 'quoted', expectedVersion: 0, amount: '12000.00', currency: 'HKD' }, { valueKind: 'confirmed', expectedVersion: 0, amount: '10500.50', currency: 'HKD' }],
      evidence: { source: 'engagement letter', reason: 'Signed fee' } })
    expect((set.record.values as Array<{ amount: string }>).map((value) => value.amount)).toEqual(['12000.000000', '10500.500000'])
    // Generic deal updates, attribute patches and extraction-style writes have no path to the protected subrecords.
    await updateDeal(f.owner, f.deal, { amount: 1, closeDate: new Date('2026-06-30') }, undefined, mutationActorAccess(f.owner, f.workspaceId))
    await updateEntity(f.owner, f.deal, { attributes: { company_id: f.company, confirmed_fee: '1', quoted_fee: '1', amount: 1 } }, mutationActorAccess(f.owner, f.workspaceId))
    const values = (await pool.query("SELECT value_kind,amount::text,version FROM crm_commercial_values WHERE deal_id=$1 AND status='current' ORDER BY value_kind", [f.deal])).rows
    expect(values).toEqual([{ value_kind: 'confirmed', amount: '10500.500000', version: 1 }, { value_kind: 'quoted', amount: '12000.000000', version: 1 }])
    // A member (internal clearance) sees the engagement but not the confidential fees, and cannot set them.
    const memberView = (await reads.listEngagements(f.workspaceId, { userId: f.member }, { dealId: f.deal, includeCommercialValues: true, limit: 50 })).engagements[0] as { commercialValues: unknown[] }
    expect(memberView.commercialValues).toEqual([])
    const ownerView = (await reads.listEngagements(f.workspaceId, { userId: f.owner }, { dealId: f.deal, includeCommercialValues: true, limit: 50 })).engagements[0] as { commercialValues: Array<{ valueKind: string; amount: string }> }
    expect(ownerView.commercialValues.map((value) => [value.valueKind, value.amount])).toEqual([['confirmed', '10500.5'], ['quoted', '12000']])
    expect((await reads.listEngagements(f.workspaceId, { userId: f.owner }, { dealId: f.deal, includeCommercialValues: false, limit: 50 })).engagements[0]).not.toHaveProperty('commercialValues')
    await expect(f.exec(f.member, { kind: 'set_commercial_values', dealId: f.deal, values: [{ valueKind: 'confirmed', expectedVersion: 1, amount: '1', currency: 'HKD' }],
      evidence: { source: 'chat', reason: 'Lower it' } })).rejects.toMatchObject({ code: 'not_authorized' })
    // Corrections are versioned with evidence; a stale version is refused; unknown stays null rather than zero.
    await expect(f.exec(f.owner, { kind: 'set_commercial_values', dealId: f.deal, values: [{ valueKind: 'confirmed', expectedVersion: 0, amount: '9000', currency: 'HKD' }],
      evidence: { source: 'chat', reason: 'Stale' } })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale_version' } })
    await f.exec(f.owner, { kind: 'set_commercial_values', dealId: f.deal, values: [{ valueKind: 'outsource', expectedVersion: 0, amount: null, currency: 'HKD' }],
      evidence: { source: 'engagement letter', reason: 'No subcontractor agreed yet' } })
    expect((await pool.query("SELECT amount FROM crm_commercial_values WHERE deal_id=$1 AND value_kind='outsource'", [f.deal])).rows).toEqual([{ amount: null }])
    await f.exec(f.owner, { kind: 'set_commercial_values', dealId: f.deal, values: [{ valueKind: 'confirmed', expectedVersion: 1, amount: '11000', currency: 'HKD' }],
      evidence: { source: 'variation letter', reason: 'Scope increase' } })
    const history = (await pool.query("SELECT version,status,amount::text,evidence->>'reason' AS reason FROM crm_commercial_values WHERE deal_id=$1 AND value_kind='confirmed' ORDER BY version", [f.deal])).rows
    expect(history).toEqual([{ version: 1, status: 'superseded', amount: '10500.500000', reason: 'Signed fee' }, { version: 2, status: 'current', amount: '11000.000000', reason: 'Scope increase' }])
  })

  it('G4 lets tracking and team edits leave hidden fees intact and refuses tracking edits on stale versions', async () => {
    const f = await fixture()
    await f.exec(f.owner, { kind: 'set_commercial_values', dealId: f.deal, values: [{ valueKind: 'confirmed', expectedVersion: 0, amount: '8800', currency: 'HKD' }],
      evidence: { source: 'engagement letter', reason: 'Signed fee' } })
    // The member cannot read the fee and edits only tracking.
    await f.exec(f.member, { kind: 'update_engagement_tracking', dealId: f.deal, expectedVersion: 0, tracking: { workStatus: 'fieldwork', participantIds: [f.member] } })
    await f.exec(f.member, { kind: 'update_engagement_tracking', dealId: f.deal, expectedVersion: 1, tracking: { deadline: '2026-09-30', ownerUserId: f.member } })
    await expect(f.exec(f.member, { kind: 'update_engagement_tracking', dealId: f.deal, expectedVersion: 1, tracking: { workStatus: 'complete' } }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale_version', currentVersion: 2 } })
    const engagement = (await reads.listEngagements(f.workspaceId, { userId: f.owner }, { dealId: f.deal, includeCommercialValues: true, limit: 50 })).engagements[0] as Record<string, unknown>
    expect(engagement).toMatchObject({ workStatus: 'fieldwork', deadline: '2026-09-30', ownerUserId: f.member, participantIds: [f.member], trackingVersion: 2 })
    expect((engagement.commercialValues as Array<{ amount: string; version: number }>)).toMatchObject([{ amount: '8800', version: 1 }])
    // Work status is delivery progress; it does not move the sales stage.
    expect((await pool.query("SELECT attributes->>'stage' AS stage FROM entities WHERE id=$1 AND valid_to IS NULL", [f.deal])).rows[0]).toEqual({ stage: null })
    // Governed engagement changes cannot carry fees, and generic reads cannot see them.
    await expect(draft(f, f.member, { kind: 'deal', id: f.deal }, { engagement: { confirmedFee: '1' } })).rejects.toBeTruthy()
    expect(JSON.stringify((await reads.listEngagements(f.workspaceId, { userId: f.member }, { dealId: f.deal, includeCommercialValues: false, limit: 50 })).engagements)).not.toContain('8800')
  })
})
