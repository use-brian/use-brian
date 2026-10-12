import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import type { CrmOperationsCommand, CrmOperationsContext } from '@use-brian/core'
import { createCrmOperationsService } from '../service.js'
import { createDbCrmOperationsStore } from '../../db/crm-operations-store.js'
import { createCrmReferenceReadStore } from '../../db/crm-business-reference-store.js'
import { getAppPool, getPool } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 })
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP, max: 4 })
const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
const reads = createCrmReferenceReadStore((sql, values) => pool.query(sql, values as unknown[]))
afterAll(async () => { await pool.end(); await app.end(); await getAppPool().end(); await getPool().end() })

async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), member = randomUUID()
  for (const user of [owner, member]) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional references fixture',$2)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')", [workspaceId, owner, member])
  const entity = async (kind: 'company' | 'deal', name: string, attributes: Record<string, unknown> = {}, sensitivity = 'internal') => {
    const id = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,attributes,sensitivity)
      VALUES($1,$2,$3,$4,$5,'manual',$6::jsonb,$7)`, [id, workspaceId, kind, name, owner, JSON.stringify(attributes), sensitivity])
    return id
  }
  const ctx = (userId: string, role: 'owner' | 'member' = userId === owner ? 'owner' : 'member'): CrmOperationsContext => ({
    workspaceId, actor: { kind: 'user', userId },
    authority: { role, canWrite: true, canConfigure: role === 'owner', trustedIdentitySources: [] },
  })
  const run = (userId: string, command: Record<string, unknown>) => service.execute(ctx(userId), command as CrmOperationsCommand)
  return { workspaceId, owner, member, entity, ctx, run }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function schemes(f: Fixture) {
  const customer = await f.run(f.owner, { kind: 'save_reference_definition', operationId: randomUUID(), definition: {
    definitionKey: 'customer', label: 'Customer code', targetKinds: ['company'], assignmentMode: 'native', namespaceKey: 'customer-codes',
    format: [{ kind: 'literal', text: 'C-' }, { kind: 'counter', width: 5 }], counterStart: 42, changePolicy: 'correctable',
  } })
  const engagement = await f.run(f.owner, { kind: 'save_reference_definition', operationId: randomUUID(), definition: {
    definitionKey: 'engagement', label: 'Engagement code', targetKinds: ['deal'], assignmentMode: 'native', namespaceKey: 'engagement-codes',
    format: [{ kind: 'parent', definitionKey: 'customer' }, { kind: 'literal', text: '-' }, { kind: 'category' }, { kind: 'literal', text: '-' },
      { kind: 'date', part: 'yyyy' }, { kind: 'literal', text: '-' }, { kind: 'counter', width: 3 }],
    partitionDimensions: ['business_year', 'parent_target', 'service_category'],
    categories: [{ key: 'advisory', code: 'ADVISORY', label: 'Advisory' }, { key: 'audit', code: 'AUDIT', label: 'Audit' }],
    timezone: 'Asia/Hong_Kong', counterStart: 1,
  } })
  return { customer: customer.record as { id: string; version: number }, engagement: engagement.record as { id: string; version: number } }
}

const value = (result: { record: Record<string, unknown> }) => (result.record.reference as { value: string }).value

describe('[COMP:crm/business-references] business references on PostgreSQL', () => {
  it('R1 configures two distinct reference schemes and formats composite values deterministically', async () => {
    const f = await fixture()
    await schemes(f)
    const company = await f.entity('company', 'Example Holdings')
    const deal = await f.entity('deal', 'Example advisory', { company_id: company })
    const code = await f.run(f.owner, { kind: 'assign_business_reference', operationId: randomUUID(), definitionKey: 'customer', target: { kind: 'company', id: company } })
    expect(value(code)).toBe('C-00042')
    const missingDate = f.run(f.owner, { kind: 'assign_business_reference', operationId: randomUUID(), definitionKey: 'engagement',
      target: { kind: 'deal', id: deal }, categoryKey: 'advisory' })
    await expect(missingDate).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'business_date_required' } })
    // An instant converts in the definition timezone, never the host clock.
    const engagement = await f.run(f.owner, { kind: 'assign_business_reference', operationId: randomUUID(), definitionKey: 'engagement',
      target: { kind: 'deal', id: deal }, categoryKey: 'advisory', businessDate: '2025-12-31T17:30:00Z' })
    expect(value(engagement)).toBe('C-00042-ADVISORY-2026-001')
    const reference = engagement.record.reference as { parentSnapshot: { value: string }; partitionKey: string }
    expect(reference.parentSnapshot.value).toBe('C-00042')
    expect(reference.partitionKey).toBe(`year=2026|parent=${company}|category=advisory`)
    const preview = await reads.preview(f.workspaceId, { userId: f.owner }, { definitionKey: 'engagement', targetId: deal, businessDate: '2026-02-01', categoryKey: 'audit' })
    expect(preview).toMatchObject({ reserves: false, explanation: { maskedExample: 'C-00042-AUDIT-2026-###' } })
    const after = await pool.query("SELECT count(*)::int AS n FROM crm_business_references WHERE workspace_id=$1", [f.workspaceId])
    expect(after.rows[0].n).toBe(2)
  })

  it('R2 allocates unique values under concurrent connections and rolls the counter back with a failed transaction', async () => {
    const f = await fixture()
    await schemes(f)
    const companies = await Promise.all(Array.from({ length: 12 }, (_, index) => f.entity('company', `Concurrent ${index}`)))
    const results = await Promise.all(companies.map((id) => f.run(f.owner, { kind: 'assign_business_reference', operationId: randomUUID(),
      definitionKey: 'customer', target: { kind: 'company', id } })))
    const values = results.map(value).sort()
    expect(new Set(values).size).toBe(12)
    expect(values).toEqual(Array.from({ length: 12 }, (_, index) => `C-${String(42 + index).padStart(5, '0')}`))
    // A reserved value in the next counter position fails the allocation; the whole transaction rolls back.
    const blocker = await f.entity('company', 'Imported legacy')
    await f.run(f.owner, { kind: 'import_business_references', operationId: randomUUID(), definitionKey: 'customer',
      rows: [{ target: { kind: 'company', id: blocker }, value: 'C-00054' }] })
    const before = await pool.query('SELECT next_value::int AS next FROM crm_number_partitions p JOIN crm_number_series s ON s.id=p.series_id WHERE p.workspace_id=$1', [f.workspaceId])
    const victim = await f.entity('company', 'Collision victim')
    await expect(f.run(f.owner, { kind: 'assign_business_reference', operationId: randomUUID(), definitionKey: 'customer',
      target: { kind: 'company', id: victim } })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'reference_collision' } })
    const after = await pool.query('SELECT next_value::int AS next FROM crm_number_partitions p JOIN crm_number_series s ON s.id=p.series_id WHERE p.workspace_id=$1', [f.workspaceId])
    expect(after.rows[0].next).toBe(before.rows[0].next)
    expect((await pool.query('SELECT count(*)::int AS n FROM crm_business_references WHERE workspace_id=$1 AND target_id=$2', [f.workspaceId, victim])).rows[0].n).toBe(0)
    // The reviewed counter bootstrap moves past the legacy value; it can never move backwards.
    await f.run(f.owner, { kind: 'import_business_references', operationId: randomUUID(), definitionKey: 'customer', partitionCounters: [{ partitionKey: 'all', nextValue: 60 }] })
    expect(value(await f.run(f.owner, { kind: 'assign_business_reference', operationId: randomUUID(), definitionKey: 'customer', target: { kind: 'company', id: victim } }))).toBe('C-00060')
    await expect(f.run(f.owner, { kind: 'import_business_references', operationId: randomUUID(), definitionKey: 'customer',
      partitionCounters: [{ partitionKey: 'all', nextValue: 10 }] })).rejects.toMatchObject({ details: { reason: 'import_conflicts' } })
    await expect(pool.query("UPDATE crm_number_partitions SET next_value=1 WHERE workspace_id=$1", [f.workspaceId])).rejects.toThrow(/forward_only/)
  })

  it('R3 replays one assignment across actor and operation-key changes without a second allocation', async () => {
    const f = await fixture()
    await schemes(f)
    const company = await f.entity('company', 'Replay Limited')
    const operationId = randomUUID()
    const command = { kind: 'assign_business_reference', operationId, definitionKey: 'customer', target: { kind: 'company', id: company } }
    const first = await f.run(f.owner, command)
    expect(first).toMatchObject({ created: true, duplicate: false })
    expect(await f.run(f.owner, command)).toMatchObject({ duplicate: true, record: { reference: { value: value(first) } } })
    await expect(f.run(f.member, command)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(f.run(f.owner, { ...command, businessDate: '2026-01-01' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const otherKey = await f.run(f.member, { ...command, operationId: randomUUID() })
    expect(otherKey).toMatchObject({ duplicate: true, record: { reference: { value: value(first) } } })
    // Concurrent different keys for one new target serialize on the target lock.
    const second = await f.entity('company', 'Race Limited')
    const raced = await Promise.all([f.owner, f.member, f.owner].map((user) => f.run(user, { kind: 'assign_business_reference',
      operationId: randomUUID(), definitionKey: 'customer', target: { kind: 'company', id: second } })))
    expect(new Set(raced.map(value)).size).toBe(1)
    expect(raced.filter((result) => result.created)).toHaveLength(1)
    const allocations = await pool.query('SELECT allocated_count::int AS n FROM crm_number_partitions WHERE workspace_id=$1', [f.workspaceId])
    expect(allocations.rows[0].n).toBe(2)
    const receipts = await pool.query('SELECT count(*)::int AS n FROM crm_operation_receipts WHERE workspace_id=$1 AND operation_id=$2', [f.workspaceId, operationId])
    expect(receipts.rows[0].n).toBe(1)
  })

  it('R4 keeps recoded, retired and composite values reserved and resolves former codes to the same record', async () => {
    const f = await fixture()
    await schemes(f)
    const company = await f.entity('company', 'Original Name Limited')
    const deal = await f.entity('deal', 'Composite engagement', { company_id: company })
    const original = await f.run(f.owner, { kind: 'assign_business_reference', operationId: randomUUID(), definitionKey: 'customer', target: { kind: 'company', id: company } })
    const engagement = await f.run(f.owner, { kind: 'assign_business_reference', operationId: randomUUID(), definitionKey: 'engagement',
      target: { kind: 'deal', id: deal }, categoryKey: 'audit', businessDate: '2026-03-01' })
    await pool.query("UPDATE entities SET display_name='Renamed Holdings' WHERE id=$1", [company])
    const ref = original.record.reference as { id: string; version: number; value: string }
    const replaced = await f.run(f.owner, { kind: 'replace_business_reference', operationId: randomUUID(), referenceId: ref.id,
      expectedVersion: ref.version, reason: 'Customer recoded after review' })
    const current = replaced.record.reference as { value: string; targetId: string }
    expect(current.value).toBe('C-00043')
    const former = await reads.lookup(f.workspaceId, { userId: f.owner }, { q: 'c-00042', match: 'exact', includeFormer: true, limit: 50 })
    expect(former.references).toMatchObject([{ targetId: company, targetName: 'Renamed Holdings', status: 'replaced', value: 'C-00042' }])
    const prefix = await reads.lookup(f.workspaceId, { userId: f.owner }, { q: 'C-0004', match: 'prefix', definitionKey: 'customer', includeFormer: true, limit: 50 })
    expect(new Set(prefix.references.map((row) => row.targetId))).toEqual(new Set([company]))
    // The composite keeps its snapshot; renaming or recoding the parent never recomputes it.
    const kept = await reads.lookup(f.workspaceId, { userId: f.owner }, { targetId: deal, match: 'exact', includeFormer: true, limit: 50 })
    expect(kept.references[0]).toMatchObject({ value: value(engagement), parentSnapshot: { value: 'C-00042' } })
    // Former, retired and composite values stay reserved.
    const other = await f.entity('company', 'Another Limited')
    await expect(f.run(f.owner, { kind: 'import_business_references', operationId: randomUUID(), definitionKey: 'customer',
      rows: [{ target: { kind: 'company', id: other }, value: 'c-00042' }] })).rejects.toMatchObject({ details: { reason: 'import_conflicts' } })
    const currentRef = replaced.record.reference as { id: string; version: number }
    await f.run(f.owner, { kind: 'retire_business_reference', operationId: randomUUID(), referenceId: currentRef.id, expectedVersion: currentRef.version, reason: 'Relationship ended' })
    await expect(f.run(f.owner, { kind: 'import_business_references', operationId: randomUUID(), definitionKey: 'customer',
      rows: [{ target: { kind: 'company', id: other }, value: 'C-00043' }] })).rejects.toMatchObject({ details: { reason: 'import_conflicts' } })
    const history = await reads.history(f.workspaceId, { userId: f.owner }, currentRef.id)
    expect(history?.history.map((row) => row.action)).toEqual(['assigned', 'replaced', 'retired'])
    // Definition edits keep counters and refuse settings that would renumber assigned values.
    const definitions = await reads.listDefinitions(f.workspaceId, { userId: f.owner, canConfigure: true })
    const customer = definitions.definitions.find((row) => row.definitionKey === 'customer') as { id: string; version: number }
    await expect(f.run(f.owner, { kind: 'save_reference_definition', operationId: randomUUID(), definitionId: customer.id, expectedVersion: customer.version,
      definition: { definitionKey: 'customer', label: 'Customer code', targetKinds: ['company'], assignmentMode: 'native', namespaceKey: 'customer-codes',
        format: [{ kind: 'literal', text: 'C-' }, { kind: 'counter', width: 5 }], counterStart: 1, changePolicy: 'correctable' } }))
      .rejects.toMatchObject({ details: { reason: 'definition_frozen' } })
    await f.run(f.owner, { kind: 'save_reference_definition', operationId: randomUUID(), definitionId: customer.id, expectedVersion: customer.version,
      definition: { definitionKey: 'customer', label: 'Customer code', targetKinds: ['company'], assignmentMode: 'native', namespaceKey: 'customer-codes',
        format: [{ kind: 'literal', text: 'CU-' }, { kind: 'counter', width: 5 }], counterStart: 42, changePolicy: 'correctable' } })
    expect(value(await f.run(f.owner, { kind: 'assign_business_reference', operationId: randomUUID(), definitionKey: 'customer', target: { kind: 'company', id: other } }))).toBe('CU-00044')
  })

  it('refuses writes through generic and unauthorized paths and hides codes on records outside scope', async () => {
    const f = await fixture()
    await schemes(f)
    const restricted = await f.entity('company', 'Restricted Limited', {}, 'confidential')
    await f.run(f.owner, { kind: 'assign_business_reference', operationId: randomUUID(), definitionKey: 'customer', target: { kind: 'company', id: restricted } })
    await expect(f.run(f.member, { kind: 'assign_business_reference', operationId: randomUUID(), definitionKey: 'customer',
      target: { kind: 'company', id: restricted } })).rejects.toMatchObject({ code: 'not_found' })
    const hidden = await reads.lookup(f.workspaceId, { userId: f.member }, { q: 'C-00042', match: 'exact', includeFormer: true, limit: 50 })
    expect(hidden.references).toEqual([])
    await expect(f.run(f.member, { kind: 'save_reference_definition', operationId: randomUUID(), definition: {
      definitionKey: 'sneaky', label: 'Sneaky', targetKinds: ['company'], assignmentMode: 'manual', namespaceKey: 'sneaky' } }))
      .rejects.toMatchObject({ code: 'not_authorized' })
    const client = await app.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true)", [f.owner])
      const updated = await client.query("UPDATE crm_business_references SET status_reason='edited' WHERE workspace_id=$1", [f.workspaceId])
      expect(updated.rowCount).toBe(0)
      await expect(client.query(`INSERT INTO crm_business_references(workspace_id,definition_id,definition_version,target_kind,target_id,printable_value,normalized_value,origin,operation_id,assigned_by_kind,assigned_by_id)
        SELECT workspace_id,id,1,'company',$2,'X-1','x-1','manual',$2,'user','x' FROM crm_reference_definitions WHERE workspace_id=$1 LIMIT 1`, [f.workspaceId, randomUUID()]))
        .rejects.toThrow(/row-level security/)
    } finally { await client.query('ROLLBACK'); client.release() }
    const events = await pool.query("SELECT event_type,subject_kind FROM crm_domain_event_outbox WHERE workspace_id=$1", [f.workspaceId])
    expect(events.rows).toEqual([{ event_type: 'crm.reference.assigned', subject_kind: 'company' }])
  })
})
