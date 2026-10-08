/** Duplicate merge needs edit authority over both records and never lowers merged data's protection. */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { mergeEntities, undoMerge } from '@use-brian/core'
import { createEntityMergeStore } from '../entity-merge-store.js'
import { getAppPool, getPool } from '../client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const repo = createEntityMergeStore()

async function fixture() {
  const workspaceId = randomUUID(), custodian = randomUUID(), member = randomUUID(), cedar = randomUUID(), harbor = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text),($2::uuid,$2::text)', [custodian, member])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional merge workspace',$2)", [workspaceId, custodian])
  await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [workspaceId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [workspaceId, custodian, member])
  for (const [id, name] of [[cedar, 'Cedar'], [harbor, 'Harbor']]) {
    await pool.query(`INSERT INTO workspace_groups(id,workspace_id,kind,name,created_by,compartment_key,key)
      VALUES($1::uuid,$2,'team',$3,$4,$5,$1::text)`, [id, workspaceId, name, custodian, `team:${id}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,$3,'team',$4)", [workspaceId, `team:${id}`, name, id])
  }
  const edge = (department: string) => pool.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin)
    VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING`, [workspaceId, department, member])
  const record = async (name: string, sensitivity: string, compartments: string[]) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,attributes,source,created_by_user_id,sensitivity,compartments)
      VALUES($1,$2,'person',$3,$4::jsonb,'manual',$5,$6,$7)`, [id, workspaceId, name, JSON.stringify({ email: `${id}@example.com` }), custodian, sensitivity, compartments])
    return id
  }
  return { workspaceId, member, cedar, harbor, edge, record }
}

describe('[COMP:corrections/entity-merge-store] Departmental duplicate merge', () => {
  afterAll(async () => { await Promise.all([pool.end(), getPool().end(), getAppPool().end()]) })

  it('refuses a member without edit authority on both records, and raises the survivor floor on an authorized merge', async () => {
    const f = await fixture()
    const survivor = await f.record('Fictional General person', 'internal', [])
    const merged = await f.record('Fictional Cedar person', 'confidential', [`team:${f.cedar}`])
    const merge = () => mergeEntities({ workspaceId: f.workspaceId, survivingId: survivor, mergedId: merged, actorUserId: f.member,
      reason: 'Fictional duplicate review', mode: 'survivor-wins', cascade: false }, { repo })

    await f.edge(f.harbor)
    await expect(merge()).rejects.toMatchObject({ code: 'entity_not_found' })
    expect((await pool.query('SELECT valid_to FROM entities WHERE id=$1', [merged])).rows[0].valid_to).toBeNull()

    await f.edge(f.cedar)
    const record = await merge()
    const after = (await pool.query('SELECT sensitivity,compartments FROM entities WHERE id=$1', [survivor])).rows[0]
    expect(after).toEqual({ sensitivity: 'confidential', compartments: [`team:${f.cedar}`] })

    // Undo needs the same authority; losing Cedar makes the merge unavailable, not undoable.
    await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2 AND department_id=$3', [f.workspaceId, f.member, f.cedar])
    await expect(undoMerge({ workspaceId: f.workspaceId, mergeId: record.id, actorUserId: f.member, reason: 'Fictional undo' }, { repo }))
      .rejects.toMatchObject({ code: 'merge_not_found' })
    expect((await pool.query('SELECT valid_to IS NOT NULL AS superseded FROM entities WHERE id=$1', [merged])).rows[0].superseded).toBe(true)
  })
})
