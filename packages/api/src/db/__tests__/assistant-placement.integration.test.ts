/** Real RLS and membership expiry, using the disposable PostgreSQL fixture. */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, queryWithRLS } from '../client.js'
import { resolveAssistantAccess, listAccessibleAssistants } from '../users.js'
import { loadDepartmentSnapshot } from '../../context-scope/department-resolver.js'
import { createDepartmentStore } from '../department-store.js'

const enabled = Boolean(process.env.BRIAN_ASSURANCE_FIXTURE && process.env.DATABASE_URL_APP)
const suite = enabled ? describe : describe.skip
const q = (sql: string, values: unknown[] = []) => getPool().query(sql, values)
afterAll(async () => { if (enabled) { await getAppPool().end(); await getPool().end() } })

async function fixture() {
  const people = await Promise.all(Array.from({ length: 4 }, async () =>
    (await q("INSERT INTO users(auth_provider,auth_provider_id) VALUES('test',$1) RETURNING id", [randomUUID()])).rows[0].id as string))
  const [owner, departmentOwner, reader, outsider] = people
  const workspace = (await q("INSERT INTO workspaces(name,purpose,owner_user_id,is_personal) VALUES('Example workspace','test',$1,false) RETURNING id", [owner])).rows[0].id
  for (const person of people) await q(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance)
    VALUES($1,$2,$3,'confidential')`, [workspace, person, person === owner ? 'owner' : person === departmentOwner ? 'admin' : 'member'])
  const department = randomUUID()
  await q(`INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key)
    VALUES($1,$2,'Example department',$3,'team',$1::uuid::text,$4)`, [department, workspace, departmentOwner, `team:${department}`])
  await createDepartmentStore().setEdge(departmentOwner, department, { kind: 'user', id: reader }, 'internal', null)
  const create = (actor = departmentOwner, dep = department) => queryWithRLS<{ id: string }>(actor,
    "SELECT create_department_assistant($1,$2,'Private specialist',1,'internal',NULL) AS id", [workspace, dep])
  const assistant = (await create()).rows[0].id
  const shared = (await q("INSERT INTO assistants(name,workspace_id,kind) VALUES('Shared specialist',$1,'standard') RETURNING id", [workspace])).rows[0].id
  return { owner, departmentOwner, reader, outsider, workspace, department, assistant, shared, create }
}

suite('[COMP:api/assistant-placement] Department assistant audience', () => {
  it('admits members but hides from outsiders and workspace owners even with direct grants', async () => {
    const f = await fixture()
    await q("INSERT INTO assistant_members(assistant_id,user_id,role) VALUES($1,$2,'owner')", [f.assistant, f.owner])
    for (const actor of [f.reader, f.departmentOwner]) {
      expect(await resolveAssistantAccess(actor, f.assistant)).not.toBeNull()
      expect((await listAccessibleAssistants(actor, f.workspace)).map(a => a.id)).toContain(f.assistant)
    }
    for (const actor of [f.owner, f.outsider]) {
      expect(await resolveAssistantAccess(actor, f.assistant)).toBeNull()
      expect((await listAccessibleAssistants(actor, f.workspace)).map(a => a.id)).not.toContain(f.assistant)
      expect((await queryWithRLS(actor, 'SELECT id FROM assistants WHERE id=$1', [f.assistant])).rows).toEqual([])
      expect(await resolveAssistantAccess(actor, f.shared)).not.toBeNull()
    }
  })

  it('revokes visibility on expiry and removal without changing placement', async () => {
    const f = await fixture()
    await q("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2", [f.department, f.reader])
    expect(await resolveAssistantAccess(f.reader, f.assistant)).toBeNull()
    await createDepartmentStore().setEdge(f.departmentOwner, f.department, { kind: 'user', id: f.reader }, 'public', null)
    expect(await resolveAssistantAccess(f.reader, f.assistant)).not.toBeNull()
    await createDepartmentStore().removeEdge(f.departmentOwner, f.department, { kind: 'user', id: f.reader })
    expect(await resolveAssistantAccess(f.reader, f.assistant)).toBeNull()
    expect((await q('SELECT placement_department_id FROM assistants WHERE id=$1', [f.assistant])).rows[0].placement_department_id).toBe(f.department)
  })

  it('creates placement, home and reader edge atomically and refuses unauthorized creation', async () => {
    const f = await fixture()
    const before = (await q('SELECT count(*) FROM assistants WHERE workspace_id=$1', [f.workspace])).rows[0].count
    await expect(f.create(f.owner)).rejects.toThrow('department_owner_required')
    await expect(f.create(f.departmentOwner, randomUUID())).rejects.toThrow('department_not_found')
    expect((await q('SELECT count(*) FROM assistants WHERE workspace_id=$1', [f.workspace])).rows[0].count).toBe(before)
    expect((await q('SELECT home_department_id FROM assistants WHERE id=$1', [f.assistant])).rows[0].home_department_id).toBe(f.department)
    expect((await q('SELECT clearance FROM department_edges WHERE assistant_id=$1 AND department_id=$2', [f.assistant, f.department])).rows[0].clearance).toBe('internal')
    await expect(q('UPDATE assistants SET placement_department_id=NULL WHERE id=$1', [f.assistant])).rejects.toThrow('assistant_placement_immutable')
  })

  it('checks execution authority and refuses shared sessions without publishing a private identity', async () => {
    const f = await fixture()
    await expect(loadDepartmentSnapshot(q, { workspaceId: f.workspace, userId: f.outsider, assistantId: f.assistant })).rejects.toThrow('authority_unavailable')
    await expect(loadDepartmentSnapshot(q, { workspaceId: f.workspace, userId: f.reader, assistantId: f.assistant })).resolves.toBeDefined()
    const session = (visibility: string, actor = f.reader) => q(`INSERT INTO sessions(assistant_id,user_id,channel_type,channel_id,visibility)
      VALUES($1,$2,'web',$3,$4) RETURNING id`, [f.assistant, actor, randomUUID(), visibility])
    await expect(session('owner')).resolves.toBeDefined()
    await expect(session('workspace')).rejects.toThrow('department_assistant_requires_private_access')
    await expect(session('owner', f.outsider)).rejects.toThrow('department_assistant_requires_private_access')
  })

  it('refuses public sharing and network discovery, and denies archived departments', async () => {
    const f = await fixture()
    await expect(q("INSERT INTO assistant_chat_links(assistant_id,token,label,created_by) VALUES($1,$2,'Example',$3)", [f.assistant, randomUUID(), f.departmentOwner])).rejects.toThrow('department_assistant_requires_private_access')
    await expect(q("INSERT INTO assistant_connections(follower_assistant_id,following_assistant_id,status) VALUES($1,$2,'accepted')", [f.shared, f.assistant])).rejects.toThrow('department_assistant_requires_private_access')
    await q("UPDATE workspace_groups SET status='archived' WHERE id=$1", [f.department])
    expect(await resolveAssistantAccess(f.departmentOwner, f.assistant)).toBeNull()
  })
})
