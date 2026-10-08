/** Workflow definitions follow their department context for every member lane. */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createDbWorkflowStore } from '../../db/workflow-store.js'
import { getAppPool, getPool } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const store = createDbWorkflowStore()

async function fixture() {
  const workspaceId = randomUUID(), custodian = randomUUID(), cedarMember = randomUUID(), harborMember = randomUUID(), admin = randomUUID()
  const cedar = randomUUID(), harbor = randomUUID(), departmental = randomUUID(), general = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text),($2::uuid,$2::text),($3::uuid,$3::text),($4::uuid,$4::text)', [custodian, cedarMember, harborMember, admin])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional workflow workspace',$2)", [workspaceId, custodian])
  await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [workspaceId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'admin')", [workspaceId, custodian, cedarMember, harborMember, admin])
  for (const [id, name, member] of [[cedar, 'Cedar', cedarMember], [harbor, 'Harbor', harborMember]]) {
    await pool.query(`INSERT INTO workspace_groups(id,workspace_id,kind,name,created_by,compartment_key,key)
      VALUES($1::uuid,$2,'team',$3,$4,$5,$1::text)`, [id, workspaceId, name, custodian, `team:${id}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,$3,'team',$4)", [workspaceId, `team:${id}`, name, id])
    await pool.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin)
      VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING`, [workspaceId, id, member])
  }
  const definition = JSON.stringify({ startStepId: 'step', steps: [{ id: 'step', type: 'tool_call', toolName: 'fictionalTool', arguments: {} }] })
  await pool.query(`INSERT INTO workflows(id,workspace_id,created_by,name,definition,context_group_id) VALUES
    ($1,$3,$4,'Fictional Cedar payroll review',$5::jsonb,$6),($2,$3,$4,'Fictional General digest',$5::jsonb,NULL)`,
  [departmental, general, workspaceId, custodian, definition, cedar])
  return { workspaceId, cedarMember, harborMember, admin, departmental, general }
}

describe('[COMP:workflow/context-scope] Workflow definition department floor', () => {
  afterAll(async () => { await Promise.all([pool.end(), getPool().end(), getAppPool().end()]) })

  it('hides and protects a department workflow from members outside it, including an admin without an edge', async () => {
    const f = await fixture()
    for (const outsider of [f.harborMember, f.admin]) {
      expect(await store.getById(outsider, f.departmental)).toBeNull()
      expect((await store.list(outsider, f.workspaceId)).map(row => row.id)).toEqual([f.general])
      expect(await store.delete(outsider, f.departmental)).toBe(false)
    }
    expect((await pool.query('SELECT name FROM workflows WHERE id=$1', [f.departmental])).rows[0].name).toBe('Fictional Cedar payroll review')

    expect((await store.getById(f.cedarMember, f.departmental))?.name).toBe('Fictional Cedar payroll review')
    expect((await store.list(f.cedarMember, f.workspaceId)).map(row => row.id).sort()).toEqual([f.departmental, f.general].sort())
  })
})
