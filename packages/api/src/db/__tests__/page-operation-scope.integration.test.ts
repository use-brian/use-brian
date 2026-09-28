import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../client.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), reader = randomUUID(), editor = randomUUID()
  for (const id of [owner, reader, editor]) {
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  }
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Page scope fixture',$2)", [workspaceId, owner])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode)
    VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','confidential','assigned'),($1,$4,'member','confidential','assigned')`,
  [workspaceId, owner, reader, editor])
  const groups = createDbWorkspaceGroupStore()
  const team = await groups.createTeam(owner, workspaceId, { name: 'Page department', key: 'page-department' })
  await groups.addMember(owner, team.id, editor)
  const teamspaceId = randomUUID(), projectId = randomUUID(), pageId = randomUUID()
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Page project','page project',$3)", [projectId, workspaceId, owner])
  await pool.query(`INSERT INTO teamspaces(id,workspace_id,name,sensitivity,workspace_group_id,created_by)
    VALUES($1,$2,'Page department','internal',$3,$4)`, [teamspaceId, workspaceId, team.id, owner])
  await pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,page,state,teamspace_id,project_id,clearance)
    VALUES($1,$2,$3,'Scoped page','tasks','table','{"blocks":[]}','saved',$4,$5,'internal')`,
  [pageId, workspaceId, owner, teamspaceId, projectId])
  await pool.query("INSERT INTO documents(page_id,ydoc,state_vector,snapshot_json,snapshot_title) VALUES($1,'','','{\"blocks\":[]}','Scoped page')", [pageId])
  await pool.query("INSERT INTO page_grants(page_id,principal_type,principal_ref,role,created_by) VALUES($1,'workspace',NULL,'edit',$2)", [pageId, owner])
  await pool.query('INSERT INTO meeting_tag_state(page_id) VALUES($1)', [pageId])

  async function grant() {
    const requestId = randomUUID()
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Page fixture',now()-interval '1 day',now()+interval '1 day',repeat('a',64),1,'approved',$5,now())`,
    [requestId, workspaceId, reader, team.id, owner])
    return (await pool.query<{ id: string }>(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1 RETURNING id`,
    [requestId])).rows[0]!.id
  }
  const grantId = await grant()
  const revoke = (id = grantId) => pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1', [id, owner])
  return { workspaceId, owner, reader, editor, team, teamspaceId, projectId, pageId, grantId, grant, revoke }
}

afterAll(async () => { await getAppPool().end(); await pool.end() })

describe('[COMP:api/saved-views-store] current page operation scopes (PG18)', () => {
  it('admits a temporary department read across page roots and children without granting any mutation', async () => {
    const f = await fixture()
    expect((await queryWithRLS(f.reader, 'SELECT id FROM saved_views WHERE id=$1', [f.pageId])).rows).toEqual([{ id: f.pageId }])
    for (const table of ['documents', 'page_grants', 'meeting_tag_state']) {
      expect((await queryWithRLS(f.reader, `SELECT page_id FROM ${table} WHERE page_id=$1`, [f.pageId])).rows, table).toHaveLength(1)
      expect((await queryWithRLS(f.reader, `UPDATE ${table} SET page_id=page_id WHERE page_id=$1 RETURNING page_id`, [f.pageId])).rows, table).toHaveLength(0)
      expect((await queryWithRLS(f.reader, `DELETE FROM ${table} WHERE page_id=$1 RETURNING page_id`, [f.pageId])).rows, table).toHaveLength(0)
    }
    expect((await queryWithRLS(f.reader, "UPDATE saved_views SET name='Denied' WHERE id=$1 RETURNING id", [f.pageId])).rows).toHaveLength(0)
    expect((await queryWithRLS(f.reader, 'DELETE FROM saved_views WHERE id=$1 RETURNING id', [f.pageId])).rows).toHaveLength(0)
    await expect(queryWithRLS(f.reader, "INSERT INTO page_grants(page_id,principal_type,role,created_by) VALUES($1,'workspace','view',$2)", [f.pageId, f.reader]))
      .rejects.toMatchObject({ code: '42501' })
    expect((await pool.query('SELECT name FROM saved_views WHERE id=$1', [f.pageId])).rows).toEqual([{ name: 'Scoped page' }])
  })

  it('keeps ordinary department page and child mutations useful', async () => {
    const f = await fixture()
    expect((await queryWithRLS(f.editor, "UPDATE saved_views SET name='Allowed' WHERE id=$1 RETURNING name", [f.pageId])).rows).toEqual([{ name: 'Allowed' }])
    expect((await queryWithRLS(f.editor, "UPDATE documents SET snapshot_title='Allowed' WHERE page_id=$1 RETURNING snapshot_title", [f.pageId])).rows).toEqual([{ snapshot_title: 'Allowed' }])
    expect((await queryWithRLS(f.editor, "UPDATE page_grants SET label='Allowed' WHERE page_id=$1 RETURNING label", [f.pageId])).rows).toEqual([{ label: 'Allowed' }])
  })

  it('rechecks revocation and preserves an independent still-valid read grant', async () => {
    const f = await fixture(), other = await f.grant()
    await f.revoke()
    expect((await queryWithRLS(f.reader, 'SELECT id FROM saved_views WHERE id=$1', [f.pageId])).rows).toHaveLength(1)
    await f.revoke(other)
    expect((await queryWithRLS(f.reader, 'SELECT id FROM saved_views WHERE id=$1', [f.pageId])).rows).toHaveLength(0)
    expect((await queryWithRLS(f.reader, 'SELECT page_id FROM documents WHERE page_id=$1', [f.pageId])).rows).toHaveLength(0)
  })

  it('composes current human scope with agent Team, Project and mutation ceilings', async () => {
    const f = await fixture()
    const run = <T>(compartments: string[] | null, mutationCompartments: string[] | null, projectIds: string[] | null, fn: () => Promise<T>) =>
      runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.owner, clearance: 'confidential', compartments, mutationCompartments, projectIds, visibilityAssistantIds: null }, fn)
    expect((await run([], [], [f.projectId], () => queryWithRLS(f.owner, 'SELECT id FROM saved_views WHERE id=$1', [f.pageId]))).rows).toHaveLength(0)
    expect((await run([f.team.compartmentKey!], [], [], () => queryWithRLS(f.owner, 'SELECT id FROM saved_views WHERE id=$1', [f.pageId]))).rows).toHaveLength(0)
    expect((await run([f.team.compartmentKey!], [], [f.projectId], () => queryWithRLS(f.owner, 'SELECT id FROM saved_views WHERE id=$1', [f.pageId]))).rows).toHaveLength(1)
    expect((await run([f.team.compartmentKey!], [], [f.projectId], () => queryWithRLS(f.owner, "UPDATE saved_views SET name='Denied agent' WHERE id=$1 RETURNING id", [f.pageId]))).rows).toHaveLength(0)
    expect((await run([f.team.compartmentKey!], [f.team.compartmentKey!], [f.projectId], () => queryWithRLS(f.owner, "UPDATE saved_views SET name='Allowed agent' WHERE id=$1 RETURNING name", [f.pageId]))).rows).toEqual([{ name: 'Allowed agent' }])
  })
})
