import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../client.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { readWorkspacePageDirectory } from '../page-directory.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

afterAll(async () => { await getAppPool().end(); await pool.end() })

describe('[COMP:api/page-directory] real current-RLS page projection', () => {
  it('publishes a temporary visible page and removes it after revocation', async () => {
    const workspaceId = randomUUID(), owner = randomUUID(), reader = randomUUID()
    for (const id of [owner, reader]) {
      await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    }
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Page directory fixture',$2)", [workspaceId, owner])
    await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode)
      VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','confidential','assigned')`,
    [workspaceId, owner, reader])
    const groups = createDbWorkspaceGroupStore()
    const team = await groups.createTeam(owner, workspaceId, { name: 'Directory team', key: 'directory-team' })
    const teamspaceId = randomUUID(), pageId = randomUUID(), requestId = randomUUID()
    await pool.query(`INSERT INTO teamspaces(id,workspace_id,name,sensitivity,workspace_group_id,created_by)
      VALUES($1,$2,'Directory team','internal',$3,$4)`, [teamspaceId, workspaceId, team.id, owner])
    await pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,page,state,teamspace_id,clearance)
      VALUES($1,$2,$3,'Visible only now','tasks','table','{"blocks":[]}','saved',$4,'internal')`,
    [pageId, workspaceId, owner, teamspaceId])
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Directory fixture',now()-interval '1 day',now()+interval '1 day',repeat('b',64),1,'approved',$5,now())`,
    [requestId, workspaceId, reader, team.id, owner])
    const grantId = (await pool.query<{ id: string }>(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1 RETURNING id`,
    [requestId])).rows[0]!.id

    const visible = await readWorkspacePageDirectory(reader, workspaceId)
    expect(visible.status).toBe(200)
    expect(visible.status === 200 && visible.body.pages).toContainEqual({ id: pageId, title: 'Visible only now' })
    expect(visible.status === 200 && visible.body.validForMs).toBeGreaterThan(0)

    await pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1', [grantId, owner])
    const revoked = await readWorkspacePageDirectory(reader, workspaceId)
    expect(revoked.status).toBe(200)
    expect(revoked.status === 200 && revoked.body.pages).not.toContainEqual(expect.objectContaining({ id: pageId }))

    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, reader])
    await expect(readWorkspacePageDirectory(reader, workspaceId)).resolves.toEqual({
      status: 404,
      body: { error: 'page_directory_unavailable' },
    })
  })
})
