import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import express from 'express'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CRM_INTEGRATION_OPERATIONS, CRM_INTEGRATION_RESOURCE_CATALOG, type AssociationServicePort, type CrmIntegrationGrant,
  type CrmOperationsCommand, type CrmOperationsContext } from '@use-brian/core'
import { createCrmOperationsService } from '../service.js'
import { createDbCrmOperationsStore } from '../../db/crm-operations-store.js'
import { createCrmIntegrationStore } from '../../db/crm-integration-store.js'
import { createCrmReferenceReadStore } from '../../db/crm-business-reference-store.js'
import { crmIntegrationRoutes } from '../../routes/crm-integration.js'
import { updateEntity } from '../../db/entities-store.js'
import { mutationActorAccess } from '../../db/access-predicate.js'
import { getAppPool, getPool } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const adapterModule = await import(new URL('../../../../../scripts/crm/reference-erp-adapter.mjs', import.meta.url).href)
const { ReferenceErpAdapter, LegacyWriterRetired, ErpBridgeError } = adapterModule
const FIXTURE = JSON.parse(readFileSync(new URL('../../../../../scripts/crm/fixtures/professional-services-erp.v1.json', import.meta.url), 'utf8'))

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
const keys = createCrmIntegrationStore(pool, appPool)
const references = createCrmReferenceReadStore(((sql: string, values: unknown[]) => pool.query(sql, values)) as never)
let server: Server, baseUrl = ''
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/crm/integration', crmIntegrationRoutes({ credentials: keys, service, association: {} as AssociationServicePort }))
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  await Promise.all([pool.end(), appPool.end(), getAppPool().end(), getPool().end()])
})

const ALL: CrmIntegrationGrant[] = CRM_INTEGRATION_OPERATIONS.map((operation) => ({ operation,
  selectors: Object.fromEntries(CRM_INTEGRATION_RESOURCE_CATALOG[operation].map((dimension) => [dimension, 'all'])) }))

async function fixture() {
  const workspaceId = randomUUID()
  const users = Object.fromEntries(FIXTURE.users.map((user: { legacyUserId: string }) => [user.legacyUserId, randomUUID()])) as Record<string, string>
  for (const id of Object.values(users)) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [id])
  const owner = users['u-partner']!
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional ERP bridge fixture',$2)", [workspaceId, owner])
  for (const user of FIXTURE.users as Array<{ legacyUserId: string; role: string }>) {
    await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)',
      [workspaceId, users[user.legacyUserId], user.role, user.role === 'member' ? 'internal' : 'confidential'])
  }
  const roles = Object.fromEntries((FIXTURE.users as Array<{ legacyUserId: string; role: string }>).map((user) => [users[user.legacyUserId]!, user.role])) as Record<string, 'owner' | 'admin' | 'member'>
  const ctx = (userId: string): CrmOperationsContext => ({ workspaceId, actor: { kind: 'user', userId },
    authority: { role: roles[userId]!, canWrite: true, canConfigure: roles[userId] !== 'member', trustedIdentitySources: [] } })
  const exec = (userId: string, command: Record<string, unknown>) => service.execute(ctx(userId), { operationId: randomUUID(), ...command } as CrmOperationsCommand)
  for (const preset of FIXTURE.referencePresets) await exec(owner, { kind: 'save_reference_definition', definition: preset })
  for (const [catalog, entries] of Object.entries(FIXTURE.catalogs)) await exec(owner, { kind: 'save_engagement_catalog', catalog, expectedVersion: 0, entries })
  for (const [subject, policy] of Object.entries(FIXTURE.reviewPolicies)) await exec(owner, { kind: 'save_governance_policy', subject, expectedVersion: 0, policy })
  const assistantId = randomUUID()
  await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional ERP bridge assistant','primary','confidential')", [assistantId, workspaceId])
  const key = await keys.create(workspaceId, owner, { label: 'Fictional ERP bridge', expiresAt: '2099-01-01T00:00:00Z', grants: ALL,
    departmentBinding: { departmentIds: [], cap: 'confidential', assistantId } })
  const adapter = new ReferenceErpAdapter({ baseUrl, token: key.oneTimeSecret, fixture: FIXTURE })
  const enroll = (legacyUserId: string) => exec(users[legacyUserId]!, { kind: 'enroll_erp_viewer', bindingKey: FIXTURE.binding.bindingKey, legacyUserId })
  return { workspaceId, users, owner, exec, ctx, adapter, key, enroll }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const count = async (sql: string, values: unknown[]) => (await pool.query<{ n: number }>(sql, values)).rows[0]!.n

function totals(kind: 'quotedFee' | 'confirmedFee') {
  const out: Record<string, number> = {}
  for (const row of FIXTURE.engagements) if (row[kind]) out[row[kind].currency] = (out[row[kind].currency] ?? 0) + Number(row[kind].amount)
  return out
}
async function migrated(f: Fixture) {
  const result = await f.adapter.migrate()
  expect(result.confirmed).not.toBeNull()
  await f.adapter.syncProjections()
  return result
}

describe('[COMP:crm/erp-bridge] ERP bridge through the supported HTTP API on PostgreSQL', () => {
  it('E1 maps legacy identities one-to-one, keeps former codes findable and projects engagements without fees', async () => {
    const f = await fixture()
    // A same-named company already in the CRM is reported, never merged.
    const existing = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,attributes,sensitivity)
      VALUES($1,$2,'company','Example Lantern Studio Limited',$3,'manual','{}','internal')`, [existing, f.workspaceId, f.owner])
    const { staged, confirmed } = await f.adapter.migrate()
    expect(staged.report.counts).toEqual({ client: { create: 3, update: 0, unchanged: 0 }, engagement: { create: 4, update: 0, unchanged: 0 } })
    expect(staged.report.conflicts).toEqual([])
    expect(staged.report.possibleDuplicates).toEqual([{ legacyType: 'client', legacyId: 'CL-300', existingTargetId: existing }])
    expect(confirmed.outcome.mappedTotals).toEqual({ client: 3, engagement: 4 })
    expect(await count("SELECT count(*)::int AS n FROM entities WHERE workspace_id=$1 AND kind='company' AND display_name='Example Lantern Studio Limited'", [f.workspaceId])).toBe(2)
    const lookup = await f.adapter.resolve('engagement', 'EN-2')
    expect(lookup.mapping).toMatchObject({ legacyType: 'engagement', legacyId: 'EN-2', targetKind: 'deal', status: 'active' })
    expect(lookup.projection).toMatchObject({ subjectKind: 'deal', name: 'Example Harbour tax filing 2026', workStatus: 'not_started', legacyIds: ['EN-2'],
      codes: { current: [{ definitionKey: 'job-code', value: 'J-0002' }], former: [{ definitionKey: 'job-code', value: 'TX-26-OLD' }] },
      client: { name: 'Example Harbour Trading Limited', codes: { current: [{ definitionKey: 'client-code', value: 'C-0100' }] }, legacyIds: ['CL-100'] } })
    // The former code still finds the same canonical record.
    const former = await references.lookup(f.workspaceId, { userId: f.owner }, { q: 'TX-26-OLD', match: 'exact', includeFormer: true, limit: 50 })
    expect(former.references[0]).toMatchObject({ targetId: lookup.mapping.targetId, status: 'retired' })
    // Re-staging the same export changes nothing.
    const again = await f.adapter.stage()
    expect(again.report.counts).toEqual({ client: { create: 0, update: 0, unchanged: 3 }, engagement: { create: 0, update: 0, unchanged: 4 } })
    expect(again.recordsHash).toBe(f.adapter.exportRecords().exportHash)
    // Timesheets resolve through the fee-free projection.
    const synced = await f.adapter.syncProjections()
    expect(synced.applied.length).toBeGreaterThanOrEqual(7)
    expect(f.adapter.timesheetLookup('T-2')).toMatchObject({ hours: '1.25', engagementLegacyId: 'EN-2',
      engagement: { code: 'J-0002', formerCodes: ['TX-26-OLD'], client: 'Example Harbour Trading Limited', tombstone: false } })
    const feed = JSON.stringify([...f.adapter.projections.values()])
    for (const amount of ['48000', '45000', '12500', '8800', '9000']) expect(feed).not.toContain(amount)
    const exported = f.adapter.exportEngagements()
    expect(exported.header).toEqual(['Job code', 'Engagement', 'Client code', 'Client', 'Status', 'Service', 'Period'])
    expect(exported.rows[0]).toEqual(['J-0001', 'Example Harbour annual audit 2026', 'C-0100', 'Example Harbour Trading Limited', 'fieldwork', 'audit', 'FY2026'])
    expect(JSON.stringify(exported)).not.toMatch(/45000|48000/)
  })

  it('E2 reconciles uncertain creates by operation id, deduplicates replayed receipts and resyncs reordered versions', async () => {
    const f = await fixture()
    await migrated(f)
    await f.enroll('u-staff')
    // The first response is lost after the CRM committed: the retry with the same id returns the receipt.
    let dropped = false
    const flaky = new ReferenceErpAdapter({ baseUrl, token: f.key.oneTimeSecret, fixture: FIXTURE, fetchImpl: async (url: URL, init: RequestInit) => {
      const response = await fetch(url, init)
      if (!dropped && init.method === 'POST') { dropped = true; return new Response(JSON.stringify({ error: 'upstream_timeout' }), { status: 502 }) }
      return response
    } })
    const request = await flaky.requestBilling('u-staff', 'EN-1', '10000', 'HKD', 'Fictional interim billing')
    expect(dropped).toBe(true)
    expect(request.state).toBe('review')
    expect(await count('SELECT count(*)::int AS n FROM crm_billing_requests WHERE workspace_id=$1', [f.workspaceId])).toBe(1)
    // Replayed receipts are duplicates; an out-of-order version asks for a resync.
    const { mapping } = await f.adapter.resolve('engagement', 'EN-1')
    const events = (await pool.query<{ seq: string; version: number }>('SELECT seq::text,version FROM crm_projection_events WHERE workspace_id=$1 AND subject_id=$2 ORDER BY version',
      [f.workspaceId, mapping.targetId])).rows
    const replay = await f.adapter.command({ kind: 'record_projection_receipt', bindingKey: FIXTURE.binding.bindingKey,
      receipts: events.map((event) => ({ eventSeq: event.seq, subjectId: mapping.targetId, version: event.version })) })
    expect(replay.record.outcomes.every((outcome: { outcome: string }) => outcome.outcome === 'duplicate')).toBe(true)
    // Two changes in the CRM; the consumer sees only the later one first.
    await f.exec(f.owner, { kind: 'update_engagement_tracking', dealId: mapping.targetId, expectedVersion: 1, tracking: { workStatus: 'review' } })
    await f.exec(f.owner, { kind: 'update_engagement_tracking', dealId: mapping.targetId, expectedVersion: 2, tracking: { workStatus: 'complete' } })
    const latest = (await pool.query<{ seq: string; version: number }>('SELECT seq::text,version FROM crm_projection_events WHERE workspace_id=$1 AND subject_id=$2 ORDER BY version DESC LIMIT 2',
      [f.workspaceId, mapping.targetId])).rows
    const reordered = await f.adapter.command({ kind: 'record_projection_receipt', bindingKey: FIXTURE.binding.bindingKey,
      receipts: [{ eventSeq: latest[0]!.seq, subjectId: mapping.targetId, version: latest[0]!.version }] })
    expect(reordered.record.outcomes[0]).toMatchObject({ outcome: 'resync_required', expectedVersion: latest[1]!.version })
    await expect(f.adapter.command({ kind: 'record_projection_receipt', bindingKey: FIXTURE.binding.bindingKey,
      resynced: [{ subjectId: mapping.targetId, version: latest[0]!.version + 5 }] })).rejects.toMatchObject({ code: 'invalid_input' })
    const resynced = await f.adapter.resync(mapping.targetId)
    expect(resynced).toEqual({ subjectId: mapping.targetId, version: latest[0]!.version })
    expect(f.adapter.timesheetLookup('T-1').engagement.workStatus).toBe('complete')
    // Recoding in the CRM keeps history: the time entry follows the new code and keeps the old one.
    const active = (await pool.query<{ id: string; version: number }>("SELECT id,version FROM crm_business_references WHERE target_id=$1 AND status='active'", [mapping.targetId])).rows[0]!
    await f.exec(f.owner, { kind: 'replace_business_reference', referenceId: active.id, expectedVersion: active.version, reason: 'Fictional recode', value: 'J-0101' })
    await f.adapter.syncProjections()
    expect(f.adapter.timesheetLookup('T-1')).toMatchObject({ entryId: 'T-1', hours: '3.5', engagementLegacyId: 'EN-1',
      engagement: { code: 'J-0101', formerCodes: ['J-0001'] } })
    // A receipt that names a different version than the logged event is refused.
    await expect(f.adapter.command({ kind: 'record_projection_receipt', bindingKey: FIXTURE.binding.bindingKey,
      receipts: [{ eventSeq: latest[0]!.seq, subjectId: mapping.targetId, version: 1 }] })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('E3 stages counts, amounts and conflicts that match the source, confirms only the reviewed report and refuses stale confirmations', async () => {
    const f = await fixture()
    const { staged } = await f.adapter.migrate()
    const fees = (kind: string) => Object.fromEntries(staged.report.fees.filter((row: { kind: string }) => row.kind === kind).map((row: { currency: string; total: string }) => [row.currency, Number(row.total)]))
    expect(fees('confirmed')).toEqual(totals('confirmedFee'))
    expect(fees('quoted')).toEqual(totals('quotedFee'))
    const stored = (await pool.query<{ currency: string; total: string }>(`SELECT currency,sum(amount)::text AS total FROM crm_commercial_values WHERE workspace_id=$1
      AND value_kind='confirmed' AND status='current' AND amount IS NOT NULL GROUP BY currency ORDER BY currency`, [f.workspaceId])).rows
    expect(Object.fromEntries(stored.map((row) => [row.currency, Number(row.total)]))).toEqual(totals('confirmedFee'))
    // A legacy edit becomes a reviewed update, not a new record.
    await f.adapter.legacyWrite('engagement', 'EN-3', { confirmedFee: { amount: '9100', currency: 'USD' } })
    await f.adapter.legacyWrite('client', 'CL-200', { name: 'Example Orchard Group Limited' })
    const delta = await f.adapter.migrate()
    expect(delta.staged.report.counts).toEqual({ client: { create: 0, update: 1, unchanged: 2 }, engagement: { create: 0, update: 1, unchanged: 3 } })
    expect(delta.staged.report.rows.find((row: { legacyId: string }) => row.legacyId === 'EN-3').changes).toEqual(['confirmedFee'])
    const deal = (await f.adapter.resolve('engagement', 'EN-3')).mapping.targetId
    expect((await pool.query("SELECT version,amount::text FROM crm_commercial_values WHERE deal_id=$1 AND value_kind='confirmed' AND status='current'", [deal])).rows)
      .toEqual([{ version: 2, amount: '9100.000000' }])
    // Conflicts are reported and nothing is written.
    const before = await count("SELECT count(*)::int AS n FROM entities WHERE workspace_id=$1 AND kind IN('company','deal')", [f.workspaceId])
    const conflicted = await f.adapter.command({ kind: 'stage_erp_import', bindingKey: FIXTURE.binding.bindingKey, records: {
      clients: [{ legacyId: 'CL-900', name: 'Example Duplicate Code Limited', code: 'C-0100' }],
      engagements: [{ legacyId: 'EN-900', clientLegacyId: 'CL-404', name: 'Orphan engagement', serviceCategory: 'payroll' }] } })
    expect(conflicted.record.report.conflicts.map((row: { legacyId: string; reason: string }) => `${row.legacyId}:${row.reason}`).sort())
      .toEqual(['CL-900:code_reserved', 'EN-900:catalog_key_invalid', 'EN-900:client_missing'])
    await expect(f.adapter.command({ kind: 'confirm_erp_import', importId: conflicted.record.importId, expectedReportHash: conflicted.record.reportHash }))
      .rejects.toMatchObject({ details: { reason: 'import_conflicts' } })
    expect(await count("SELECT count(*)::int AS n FROM entities WHERE workspace_id=$1 AND kind IN('company','deal')", [f.workspaceId])).toBe(before)
    // A confirmation is bound to the report that was reviewed and to the CRM state it describes.
    await f.adapter.legacyWrite('client', 'CL-300', { name: 'Example Lantern Studio Group' })
    const reviewed = await f.adapter.stage()
    await expect(f.adapter.command({ kind: 'confirm_erp_import', importId: reviewed.importId, expectedReportHash: 'a'.repeat(64) }))
      .rejects.toMatchObject({ details: { reason: 'stale_import' } })
    const company = (await f.adapter.resolve('client', 'CL-300')).mapping.targetId
    await updateEntity(f.owner, company, { displayName: 'Example Lantern Studio Group' }, mutationActorAccess(f.owner, f.workspaceId))
    await expect(f.adapter.command({ kind: 'confirm_erp_import', importId: reviewed.importId, expectedReportHash: reviewed.reportHash }))
      .rejects.toMatchObject({ details: { reason: 'stale_import' } })
  })

  it('E4 freezes legacy writes, refuses a stale commit, commits once and runs every retained journey through the CRM', async () => {
    const f = await fixture()
    await migrated(f)
    for (const user of ['u-staff', 'u-manager', 'u-finance']) await f.enroll(user)
    // A legacy edit after the last import is the delta the commit must include.
    await f.adapter.legacyWrite('engagement', 'EN-4', { workStatus: 'fieldwork' })
    const prepared = await f.adapter.prepareCutover()
    expect(prepared).toMatchObject({ writerState: 'frozen', reconciliation: { exportHashMatches: false, reconciled: false } })
    await expect(f.adapter.legacyWrite('engagement', 'EN-4', { workStatus: 'complete' })).rejects.toBeInstanceOf(LegacyWriterRetired)
    const { exportHash, counts } = f.adapter.exportRecords()
    const operationId = randomUUID()
    await expect(f.adapter.command({ kind: 'commit_erp_cutover', cutoverId: prepared.cutoverId, expectedVersion: 1, finalSource: { counts, exportHash } }, { operationId }))
      .rejects.toMatchObject({ details: { reason: 'stale_cutover' } })
    const { committed, delta } = await f.adapter.commitCutover(prepared)
    expect(delta.staged.report.counts.engagement.update).toBe(1)
    expect(committed).toMatchObject({ state: 'committed', writerState: 'brian', reconciliation: { reconciled: true, brianCounts: { client: 3, engagement: 4 } } })
    await expect(f.adapter.legacyWrite('client', 'CL-100', { name: 'Late legacy edit' })).rejects.toMatchObject({ state: 'brian' })
    await expect(f.adapter.stage()).rejects.toMatchObject({ details: { reason: 'writer_retired' } })
    await expect(f.adapter.command({ kind: 'commit_erp_cutover', cutoverId: prepared.cutoverId, expectedVersion: 2, finalSource: { counts, exportHash } }))
      .rejects.toMatchObject({ code: 'invalid_transition' })

    const covered = new Set<string>()
    // client_master + engagement_master: source ids resolve to canonical records.
    const client = await f.adapter.resolve('client', 'CL-100')
    expect(client.projection).toMatchObject({ subjectKind: 'company', name: 'Example Harbour Trading Limited' })
    covered.add('client_master').add('engagement_master')
    // change_requests: an associate proposes, a manager approves, all as enrolled viewers.
    const proposed = await f.adapter.requestEngagementChange('u-staff', 'EN-1', { engagement: { financialPeriod: 'FY2026-27' } })
    expect(proposed.state).toBe('submitted')
    await expect(f.adapter.decide('u-staff', proposed, 'approve')).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await f.adapter.decide('u-manager', proposed, 'approve')).state).toBe('approved')
    expect((await f.adapter.engagement('u-manager', 'EN-1')).financialPeriod).toBe('FY2026-27')
    await f.adapter.updateTracking('u-staff', 'EN-1', { workStatus: 'review' })
    covered.add('change_requests')
    // protected_fees: an internal-clearance associate never sees them; the engagement still carries them.
    const staffView = await f.adapter.request('GET', '/operations/engagements', { viewer: 'u-staff', query: { dealId: client.projection && (await f.adapter.resolve('engagement', 'EN-1')).mapping.targetId, includeCommercialValues: true } })
    expect(staffView.engagements[0].commercialValues).toEqual([])
    covered.add('protected_fees')
    // billing_handoff: reviewer then finance, then an external invoice closes the request; the balance follows.
    const billing = await f.adapter.requestBilling('u-staff', 'EN-1', '10000', 'HKD', 'Fictional first instalment')
    const reviewed = await f.adapter.decideBilling('u-manager', billing, 'approve')
    await expect(f.adapter.decideBilling('u-manager', reviewed, 'approve')).rejects.toMatchObject({ details: { reason: 'same_reviewer' } })
    const ready = await f.adapter.decideBilling('u-finance', reviewed, 'approve')
    expect(ready.state).toBe('ready_to_bill')
    await f.exec(f.owner, { kind: 'save_seller_profile', seller: { sellerKey: 'firm', legalName: 'Example Firm Limited', displayName: 'Example Firm' } })
    const account = (await f.exec(f.owner, { kind: 'save_customer_account', account: { sellerKey: 'firm', companyId: client.mapping.targetId, label: 'Harbour account' } })).record.account as { id: string }
    await f.adapter.recordExternalInvoice('u-finance', { accountId: account.id, provider: 'example-ledger', remoteId: 'INV-EXT-1', number: 'HL-2026-0001', issueDate: '2026-06-30',
      currency: 'HKD', total: '10000', allocations: [{ engagementLegacyId: 'EN-1', amount: '10000', billingRequestId: ready.id }] })
    const balance = await f.adapter.billableBalance('u-finance', 'CL-100')
    const en1 = (await f.adapter.resolve('engagement', 'EN-1')).mapping.targetId
    expect(balance.deals.find((row: { dealId: string }) => row.dealId === en1)).toMatchObject({ confirmedFee: { amount: '45000' }, unbilled: { currency: 'HKD', amount: '35000' } })
    covered.add('billing_handoff')
    // recurring_successors: one successor per period, repeatable.
    const next = await f.adapter.createNextPeriod('u-manager', ['EN-1'], { key: '2027', periodStart: '2027-01-01', periodEnd: '2027-12-31', financialPeriod: 'FY2027', deadline: null })
    expect(next.outcomes.filter((row: { outcome: string }) => row.outcome === 'created')).toHaveLength(1)
    expect((await f.adapter.createNextPeriod('u-manager', ['EN-1'], { key: '2027', periodStart: '2027-01-01', periodEnd: '2027-12-31', financialPeriod: 'FY2027', deadline: null }))
      .outcomes[0].outcome).toBe('existing')
    covered.add('recurring_successors')
    // imports_exports + engagement_projection: the retained timesheet and export read the projection.
    await f.adapter.syncProjections()
    expect(f.adapter.timesheetLookup('T-1').engagement).toMatchObject({ code: 'J-0001', workStatus: 'review' })
    expect(f.adapter.exportEngagements().rows.some((row: string[]) => row[0] === 'J-0004' && row[4] === 'fieldwork')).toBe(true)
    covered.add('imports_exports').add('engagement_projection')
    expect([...covered].sort()).toEqual(FIXTURE.retirement.map((row: { row: string }) => row.row).sort())
    // Under the commercial assurance harness, record the local writer-retirement evidence.
    const evidence = process.env.BRIAN_ASSURANCE_REPORT_DIR
    if (evidence) {
      mkdirSync(path.join(evidence, 'artifacts'), { recursive: true, mode: 0o700 })
      writeFileSync(path.join(evidence, 'artifacts', 'erp-cutover.json'), JSON.stringify({ schema: 'crm-erp-cutover-evidence-v1', committed,
        legacyWriterAfterCommit: 'refused', stageAfterCommit: 'writer_retired', retainedJourneys: [...covered].sort() }, null, 2), { mode: 0o600 })
    }
    // Revocation: a viewer who leaves the workspace can no longer act.
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.users['u-staff']])
    await expect(f.adapter.updateTracking('u-staff', 'EN-1', { workStatus: 'complete' })).rejects.toBeInstanceOf(ErpBridgeError)
    await expect(f.adapter.request('GET', '/operations/engagements', { viewer: 'u-unknown', query: {} })).rejects.toMatchObject({ code: 'not_authorized' })
  })
})
