/** Migration 736: deleting an ordinary chat does not advance the workspace access-policy revision. */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, query } from '../client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:sandbox/session-source] Browser-session descendant hold', () => {
  it('leaves the access-policy revision alone when a deleted session is not a browser source', async () => {
    const workspace = randomUUID(), owner = randomUUID(), assistant = randomUUID(), session = randomUUID()
    await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [owner])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional hold fixture','test',$2)", [workspace, owner])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspace, owner])
    await query("INSERT INTO assistants(id,name,workspace_id,kind,clearance,owner_user_id) VALUES($1,'Fictional primary',$2,'primary','confidential',$3)", [assistant, workspace, owner])
    await query("INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING", [workspace])
    await query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id) VALUES($1::uuid,$2,$3,$4,'web',$1::text)", [session, workspace, assistant, owner])
    const revision = async () => (await query<{ revision: number }>('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1', [workspace])).rows[0].revision
    const before = await revision()
    await query('DELETE FROM sessions WHERE id=$1', [session])
    expect(await revision()).toBe(before)
  })
})
