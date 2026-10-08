/** The chat list never outruns the session read gate (session-messages.md). */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, query } from '../../db/client.js'
import { sessionRoutes } from '../sessions.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:api/sessions-list] department read gate on the chat list', () => {
  it('omits an own department chat, title and all, once its edge is removed or expired', async () => {
    const workspace = randomUUID(), owner = randomUUID(), member = randomUUID(), custodian = randomUUID(), cedar = randomUUID(), assistant = randomUUID()
    for (const user of [owner, member, custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id,department_read_v2) VALUES($1,'Fictional chat list fixture','test',$2,true)", [workspace, owner])
    for (const [user, role] of [[owner, 'owner'], [member, 'member'], [custodian, 'member']]) await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')", [workspace, user, role])
    await query("INSERT INTO assistants(id,name,workspace_id,kind,clearance,owner_user_id) VALUES($1,'Fictional primary',$2,'primary','confidential',$3)", [assistant, workspace, owner])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)", [cedar, workspace, custodian, `team:${cedar}`])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [workspace, cedar, member])
    const chat = async (title: string, department: string | null) => {
      const id = randomUUID()
      await query(`INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,visibility,effective_clearance,context_compartments,context_group_id,status,title,app_origin)
        VALUES($1::uuid,$2,$3,$4,'web',$1::text,'owner','confidential',$5,$6,'idle',$7,'chat')`, [id, workspace, assistant, member, department ? [`team:${department}`] : [], department, title])
      return id
    }
    const cedarChat = await chat('Fictional Cedar budget chat', cedar)
    const generalChat = await chat('Fictional General planning chat', null)

    const app = express()
    app.use((req, _res, next) => { Object.assign(req, { userId: req.header('x-fixture-user') }); next() })
    app.use('/api/sessions', sessionRoutes())
    const list = async () => (await request(app).get(`/api/sessions?workspaceId=${workspace}`).set('x-fixture-user', member).expect(200)).body as { id: string; title: string }[]

    expect((await list()).map((row) => row.id).sort()).toEqual([cedarChat, generalChat].sort())

    await query("UPDATE department_edges SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2", [workspace, member])
    const expired = await list()
    expect(expired.map((row) => row.id)).toEqual([generalChat])
    expect(JSON.stringify(expired)).not.toContain('Cedar')

    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [workspace, member])
    expect((await list()).map((row) => row.id)).toEqual([generalChat])
    // Consistent with opening it: the gate refuses the same chat.
    expect((await request(app).get(`/api/sessions/${cedarChat}/messages`).set('x-fixture-user', member)).status).toBe(403)
  })
})
