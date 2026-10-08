/** Segment matching admits the contact and every rule dependency before rows or counts. */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createDbCrmSegmentStore } from '../crm-segment-store.js'
import { loadAssociationOrderScope } from '../../association/source-scope.js'
import { getPool } from '../client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), custodian = randomUUID(), purposeId = randomUUID()
  const cedar = randomUUID(), harbor = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text),($2::uuid,$2::text)', [userId, custodian])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional segment workspace',$2)", [workspaceId, custodian])
  await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [workspaceId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [workspaceId, custodian, userId])
  for (const [id, name] of [[cedar, 'Cedar'], [harbor, 'Harbor']]) {
    await pool.query(`INSERT INTO workspace_groups(id,workspace_id,kind,name,created_by,compartment_key,key)
      VALUES($1::uuid,$2,'team',$3,$4,$5,$1::text)`, [id, workspaceId, name, custodian, `team:${id}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,$3,'team',$4)", [workspaceId, `team:${id}`, name, id])
  }
  // The negative actor reads Cedar only; the custodian (not the actor) provisions everything.
  await pool.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin)
    VALUES($1,$2,'user',$3,'confidential','store')`, [workspaceId, cedar, userId])
  const contact = async (name: string, department: string) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,source,created_by_user_id,sensitivity,compartments)
      VALUES($1,$2,'person',$3,'manual',$4,'confidential',$5)`, [id, workspaceId, name, custodian, [`team:${department}`]])
    return id
  }
  await pool.query(`INSERT INTO crm_consent_purposes(id,workspace_id,purpose_key,label,active_wording_version,wording_snapshot,wording_hash)
    VALUES($1,$2,'updates','Updates','1','Fixture wording',repeat('a',64))`, [purposeId, workspaceId])
  /** Consent captured under `sourceContact`'s protection, which may differ from the subject's. */
  const consent = async (subject: string, sourceContact: string, action: 'granted' | 'withdrawn', at: string) => {
    const evidence = await loadAssociationOrderScope(pool, workspaceId, [sourceContact])
    await pool.query(`INSERT INTO association_consent_events(workspace_id,contact_id,purpose,purpose_id,action,wording_version,source,occurred_at,scope_snapshot,scope_sources)
      VALUES($1,$2,'updates',$3,$4,'1','fixture',$5,$6::jsonb,$7::jsonb)`,
    [workspaceId, subject, purposeId, action, at, JSON.stringify(evidence.scope), JSON.stringify(evidence.sources)])
  }
  const segment = async (key: string, rule: Record<string, unknown>) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO crm_segments(id,workspace_id,segment_key,name,entity_kind,predicate)
      VALUES($1,$2,$3,$3,'person',$4)`, [id, workspaceId, key, JSON.stringify({ type: 'group', combinator: 'and', items: [{ type: 'rule', ...rule }] })])
    return id
  }
  return { workspaceId, userId, cedar, harbor, contact, consent, segment }
}

describe('[COMP:crm/segments] Departmental segment preview', () => {
  afterAll(async () => { await Promise.all([pool.end(), getPool().end()]) })

  it('withholds hidden contacts and hidden deciding evidence from rows, counts and negative rules', async () => {
    const f = await fixture()
    const visible = await f.contact('Fictional Cedar reader', f.cedar)
    const hidden = await f.contact('Fictional Harbor contact', f.harbor)
    const mixed = await f.contact('Fictional Cedar mixed', f.cedar)
    const silent = await f.contact('Fictional Cedar silent', f.cedar)
    await f.consent(visible, visible, 'granted', '2026-01-01T00:00:00Z')
    await f.consent(hidden, hidden, 'granted', '2026-01-01T00:00:00Z')
    // An older readable grant must never stand in for a newer unreadable withdrawal.
    await f.consent(mixed, mixed, 'granted', '2026-01-01T00:00:00Z')
    await f.consent(mixed, hidden, 'withdrawn', '2026-02-01T00:00:00Z')
    const granted = await f.segment('granted', { family: 'consent', field: 'updates', operator: 'eq', value: 'granted' })
    const withdrawn = await f.segment('withdrawn', { family: 'consent', field: 'updates', operator: 'eq', value: 'withdrawn' })
    const none = await f.segment('none', { family: 'consent', field: 'updates', operator: 'is_empty' })
    const store = createDbCrmSegmentStore()
    const actor = { credentialKind: 'user' as const, credentialId: f.userId }

    const positive = await store.previewSegment(f.workspaceId, granted, {}, actor)
    expect(positive.rows.map(row => row.id)).toEqual([visible])
    expect(positive.count).toBe(1)
    expect(positive.snapshotIds).toEqual([visible])
    const negative = await store.previewSegment(f.workspaceId, withdrawn, {}, actor)
    expect(negative.count).toBe(0)
    expect(negative.snapshotIds).toEqual([])
    const empty = await store.previewSegment(f.workspaceId, none, {}, actor)
    expect(empty.snapshotIds).toEqual([silent])
    expect(empty.count).toBe(1)

    // Losing the Cedar edge removes every Cedar match; nothing falls back to General.
    await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])
    const revoked = await store.previewSegment(f.workspaceId, granted, {}, actor)
    expect(revoked.count).toBe(0)
    expect(revoked.rows).toEqual([])
  })
})
