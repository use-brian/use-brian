/** A published or link-shared page never exposes a descendant in another department (doc.md publishing). */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, query } from '../client.js'
import { createDbPageGrantStore } from '../page-grant-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:doc/page-grants] Publication cascade and department boundaries', () => {
  it('cascades within the published root department and stops at another department', async () => {
    const workspace = randomUUID(), owner = randomUUID(), cedar = randomUUID()
    await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [owner])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id,external_sharing_enabled) VALUES($1,'Fictional publish fixture','test',$2,true)", [workspace, owner])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspace, owner])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)", [cedar, workspace, owner, `team:${cedar}`])
    await query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)", [workspace, `team:${cedar}`, cedar])
    const general = (await query<{ id: string }>("INSERT INTO teamspaces(workspace_id,name) VALUES($1,'Fictional General space') RETURNING id", [workspace])).rows[0].id
    const departmental = (await query<{ id: string }>("INSERT INTO teamspaces(workspace_id,name,workspace_group_id) VALUES($1,'Fictional Cedar space',$2) RETURNING id", [workspace, cedar])).rows[0].id
    const page = async (name: string, teamspace: string, parent: string | null) => (await query<{ id: string }>(
      `INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,teamspace_id,nest_parent_id,clearance)
       VALUES($1,$2,$3,'tasks','table',$4,$5,'public') RETURNING id`, [workspace, owner, name, teamspace, parent])).rows[0].id
    const root = await page('Fictional public root', general, null)
    const sameSpaceChild = await page('Fictional public child', general, root)
    const otherDepartmentChild = await page('Fictional Cedar child', departmental, root)
    await query("INSERT INTO page_grants(page_id,principal_type,principal_ref,role,indexable,created_by) VALUES($1,'published',$2,'view',false,$3)", [root, root, owner])
    const store = createDbPageGrantStore()

    expect((await store.resolvePublishedPage(sameSpaceChild))?.pageId).toBe(sameSpaceChild)
    expect(await store.resolvePublishedPage(otherDepartmentChild)).toBeNull()
  })
})
