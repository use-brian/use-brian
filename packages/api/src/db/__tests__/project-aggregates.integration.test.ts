/** [COMP:api/project-aggregates] Real-schema counts with current department access. */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../client.js'
import { projectAggregates, projectContent } from '../project-aggregates.js'

const local = [process.env.DATABASE_URL, process.env.DATABASE_URL_APP].every(value => {
  try { return Boolean(value && ['localhost', '127.0.0.1'].includes(new URL(value).hostname)) } catch { return false }
})
const pool = local ? getPool() : undefined
const workspaces: string[] = [], users: string[] = []
afterAll(async () => {
  if (!pool) return
  for (const id of workspaces) await pool.query('DELETE FROM workspaces WHERE id=$1', [id])
  for (const id of users) await pool.query('DELETE FROM users WHERE id=$1', [id])
  await getAppPool().end(); await pool.end()
})
async function fixture() {
  const userId = randomUUID(), other = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID()
  users.push(userId, other); workspaces.push(workspaceId)
  await pool!.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text),($2::uuid,$2::text)', [userId, other])
  await pool!.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Project fixture',$2)", [workspaceId, userId])
  await pool!.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')", [workspaceId, userId, other])
  await pool!.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Atlas','atlas',$3)", [projectId, workspaceId, userId])
  return { userId, other, workspaceId, projectId }
}

describe.skipIf(!local)('[COMP:api/project-aggregates] real PostgreSQL project overview', () => {
  it('counts knowledge and Office with their real schemas and excludes General rows', async () => {
    const f = await fixture()
    const role = await queryWithRLS(f.userId, 'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }])
    await pool!.query("INSERT INTO tasks(workspace_id,title,created_by_user_id,project_ids) VALUES($1,'Project work',$2,ARRAY[$3::uuid]),($1,'General work',$2,'{}')", [f.workspaceId, f.userId, f.projectId])
    await pool!.query("INSERT INTO knowledge_entries(workspace_id,path,title,content,created_by,project_ids) VALUES($1,'fixture.md','Project notes','Content',$2,ARRAY[$3::uuid])", [f.workspaceId, f.userId, f.projectId])
    await pool!.query("INSERT INTO office_artifacts(workspace_id,family,title,creator_user_id,owner_user_id,capability_version,sensitivity,project_ids) VALUES($1,'document','Project document',$2,$2,1,'internal',ARRAY[$3::uuid])", [f.workspaceId, f.userId, f.projectId])
    await pool!.query("INSERT INTO tasks(workspace_id,title,created_by_user_id,user_id,project_ids) VALUES($1,'Private work',$2,$2,ARRAY[$3::uuid])", [f.workspaceId, f.other, f.projectId])
    await pool!.query("INSERT INTO office_artifacts(workspace_id,family,title,creator_user_id,owner_user_id,capability_version,sensitivity,project_ids,default_workspace_role) VALUES($1,'document','Private document',$2,$2,1,'internal',ARRAY[$3::uuid],'deny')", [f.workspaceId, f.other, f.projectId])
    const counts = await projectAggregates(f.userId, f.workspaceId, f.projectId)
    expect(counts).toMatchObject({ tasks: 1, knowledge: 1, office: 1, memories: 0, recordings: 0, pages: 0, goals: 0, episodes: 0 })
    expect(Object.keys(counts)).toHaveLength(11)
    const work = await projectContent(f.userId, f.workspaceId, f.projectId, 'work', '', 0)
    expect(work.items.map(row=>row.title).sort()).toEqual(['Project document','Project work'])
    expect(work.items.find(row=>row.title==='Project work')?.target).toMatchObject({type:'brain',primitive:'tasks'})
    expect((await projectContent(f.userId,f.workspaceId,f.projectId,'knowledge','notes',0)).items.map(row=>row.title)).toEqual(['Project notes'])
    expect((await projectContent(f.userId,f.workspaceId,f.projectId,'recent','Private',0)).items).toEqual([])
    expect((await projectContent(f.userId,f.workspaceId,f.projectId,'recent','General',0)).items).toEqual([])
  })
  it('does not turn workspace ownership into department access and follows grants and revocation', async () => {
    const f = await fixture(), departmentId = randomUUID(), key = `team:${departmentId}`
    await pool!.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Fixture department',$3,'team',$1::uuid::text,$4)", [departmentId, f.workspaceId, f.other, key])
    await pool!.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Fixture department',$3,'team',$4)", [f.workspaceId, key, f.other, departmentId])
    await pool!.query("INSERT INTO tasks(workspace_id,title,created_by_user_id,sensitivity,compartments,project_ids) VALUES($1,'Scoped work',$2,'confidential',$3,ARRAY[$4::uuid])", [f.workspaceId, f.other, [key], f.projectId])
    expect((await projectAggregates(f.userId, f.workspaceId, f.projectId)).tasks).toBe(0)
    await pool!.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')", [f.workspaceId, departmentId, f.userId])
    expect((await projectAggregates(f.userId, f.workspaceId, f.projectId)).tasks).toBe(0)
    await pool!.query("UPDATE department_edges SET clearance='confidential' WHERE department_id=$1 AND user_id=$2", [departmentId, f.userId])
    expect((await projectAggregates(f.userId, f.workspaceId, f.projectId)).tasks).toBe(1)
    expect((await projectContent(f.userId,f.workspaceId,f.projectId,'work','',0)).items).toHaveLength(1)
    await pool!.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2', [departmentId, f.userId])
    expect((await projectContent(f.userId,f.workspaceId,f.projectId,'work','',0)).items).toEqual([])
    expect((await projectAggregates(f.userId, f.workspaceId, f.projectId)).tasks).toBe(0)
  })
  it('paginates without duplicates and treats search wildcard characters literally', async () => {
    const f = await fixture()
    await pool!.query(`INSERT INTO tasks(workspace_id,title,created_by_user_id,project_ids)
      SELECT $1,'Item '||i,$2,ARRAY[$3::uuid] FROM generate_series(1,35) i`,[f.workspaceId,f.userId,f.projectId])
    const first=await projectContent(f.userId,f.workspaceId,f.projectId,'work','',0)
    const second=await projectContent(f.userId,f.workspaceId,f.projectId,'work','',first.nextOffset!)
    expect(first.items).toHaveLength(30);expect(second.items).toHaveLength(5);expect(second.nextOffset).toBeNull()
    expect(new Set([...first.items,...second.items].map(row=>row.key)).size).toBe(35)
    expect((await projectContent(f.userId,f.workspaceId,f.projectId,'work','%',0)).items).toEqual([])
  })

})
