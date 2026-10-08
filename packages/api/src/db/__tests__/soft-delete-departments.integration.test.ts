/** Views row delete and `deleteBrainRow` soft-delete only rows their actor may mutate. */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { softDelete, SoftDeleteError } from '@use-brian/core'
import { getAppPool, getPool, query, runWithAgentAccess } from '../client.js'
import { createSoftDeleteStore } from '../soft-delete-store.js'
import { authorizeBrainRowMutation } from '../brain-inbox-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

async function fixture() {
  const workspace = randomUUID(), owner = randomUUID(), member = randomUUID(), outsider = randomUUID(), custodian = randomUUID(), cedar = randomUUID()
  // A distinct custodian creates the department, so the owner holds no edge through provisioning.
  for (const user of [owner, member, outsider, custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
  await query("INSERT INTO workspaces(id,name,purpose,owner_user_id,department_read_v2) VALUES($1,'Fictional delete fixture','test',$2,true)", [workspace, owner])
  for (const [user, role] of [[owner, 'owner'], [member, 'member'], [outsider, 'member'], [custodian, 'member']]) {
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')", [workspace, user, role])
  }
  await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)", [cedar, workspace, custodian, `team:${cedar}`])
  await query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)", [workspace, `team:${cedar}`, cedar])
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [workspace, cedar, member])
  const task = (await query<{ id: string }>(`INSERT INTO tasks(workspace_id,title,sensitivity,compartments,created_by_user_id)
    VALUES($1,'Fictional Cedar payroll review','internal',$2,$3) RETURNING id`, [workspace, [`team:${cedar}`], custodian])).rows[0]!.id
  const contact = (await query<{ id: string }>(`INSERT INTO entities(workspace_id,kind,display_name,source,sensitivity,compartments,created_by_user_id)
    VALUES($1,'person','Fictional Cedar supplier','user','internal',$2,$3) RETURNING id`, [workspace, [`team:${cedar}`], custodian])).rows[0]!.id
  return { workspace, owner, member, outsider, cedar, task, contact }
}

const repo = createSoftDeleteStore({ authorize: authorizeBrainRowMutation })
const live = async (table: string, id: string) => (await query<{ validTo: Date | null }>(`SELECT valid_to AS "validTo" FROM ${table} WHERE id=$1`, [id])).rows[0]!.validTo === null
const audits = async (id: string) => Number((await query<{ n: string }>("SELECT count(*)::text AS n FROM correction_audit WHERE row_id=$1", [id])).rows[0]!.n)
const remove = (actorUserId: string, workspaceId: string, primitive: 'task' | 'contact', rowId: string) =>
  softDelete({ primitive, workspaceId, rowId, actorUserId, reason: 'Fictional cleanup' }, { repo })

describe('[COMP:corrections/soft-delete-store] actor-authorized soft delete', () => {
  it('refuses another department\'s rows as not found, the owner role included, and changes nothing', async () => {
    const f = await fixture()
    for (const actor of [f.outsider, f.owner]) {
      for (const [primitive, id] of [['task', f.task], ['contact', f.contact]] as const) {
        await expect(remove(actor, f.workspace, primitive, id)).rejects.toMatchObject({ code: 'row_not_found' })
      }
    }
    expect(await live('tasks', f.task)).toBe(true)
    expect(await live('entities', f.contact)).toBe(true)
    expect(await audits(f.task)).toBe(0)
    expect(await audits(f.contact)).toBe(0)
  })

  it('lets a member with the department edge delete, and stops once the edge expires', async () => {
    const f = await fixture()
    await expect(remove(f.member, f.workspace, 'task', f.task)).resolves.toMatchObject({ rowId: f.task })
    expect(await live('tasks', f.task)).toBe(false)
    expect(await audits(f.task)).toBe(1)
    await query("UPDATE department_edges SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2", [f.workspace, f.member])
    await expect(remove(f.member, f.workspace, 'contact', f.contact)).rejects.toBeInstanceOf(SoftDeleteError)
    expect(await live('entities', f.contact)).toBe(true)
  })

  it('bounds an agent caller by its own ceiling', async () => {
    const f = await fixture()
    await expect(runWithAgentAccess({ workspaceId: f.workspace, userId: f.member, clearance: 'public', compartments: null },
      () => remove(f.member, f.workspace, 'task', f.task))).rejects.toMatchObject({ code: 'row_not_found' })
    expect(await live('tasks', f.task)).toBe(true)
  })

  it('keeps the unauthorized adapter for the operator corrections path', async () => {
    const f = await fixture()
    await expect(softDelete({ primitive: 'task', workspaceId: f.workspace, rowId: f.task, actorUserId: f.outsider, reason: 'Operator cleanup' },
      { repo: createSoftDeleteStore() })).resolves.toMatchObject({ rowId: f.task })
  })
})
