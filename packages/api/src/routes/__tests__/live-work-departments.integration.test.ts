import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, query } from '../../db/client.js'
import { liveWorkRoutes } from '../live-work.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })
describe('[COMP:api/live-work-roster] real departmental roster reads', () => {
  it('applies department tiers to shared content and private presence across roles and revocation', async () => {
    const workspace=randomUUID(),owner=randomUUID(),viewer=randomUUID(),admin=randomUUID(),custodian=randomUUID(),department=randomUUID(),assistant=randomUUID(),project=randomUUID()
    for(const user of [owner,viewer,admin,custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[user])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id,department_read_v2) VALUES($1,'Fictional roster fixture','test',$2,true)",[workspace,owner])
    for(const [user,role,tier] of [[owner,'owner','confidential'],[viewer,'member','public'],[admin,'admin','confidential'],[custodian,'member','confidential']]) await query('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)',[workspace,user,role,tier])
    await query("INSERT INTO assistants(id,name,workspace_id,kind,clearance,owner_user_id) VALUES($1,'Protected fixture assistant',$2,'primary','confidential',$3)",[assistant,workspace,owner])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Research',$3,'team',$1::text,$4)",[department,workspace,custodian,`team:${department}`])
    await query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture project','fixture project',$3)",[project,workspace,owner])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[workspace,department,viewer])
    // A separate department custodian keeps owner seeding out of the no-edge actor cases.
    const ids:string[]=[]
    for(const visibility of ['workspace','owner']) {
      const id=randomUUID();ids.push(id)
      await query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,visibility,effective_clearance,context_compartments,context_group_id,context_project_id,status,title) VALUES($1::uuid,$2,$3,$4,'web',$1::text,$5,'confidential',$6,$7,$8,'running','Protected fixture work')",[id,workspace,assistant,owner,visibility,[`team:${department}`],department,project])
    }
    const app=express()
    app.use((req,_res,next)=>{Object.assign(req,{userId:req.header('x-fixture-user')});next()})
    app.use('/api',liveWorkRoutes())
    const read=async(user:string)=>(await request(app).get(`/api/workspaces/${workspace}/live`).set('x-fixture-user',user).expect(200)).body.items
    const admitted=await read(viewer)
    expect(admitted).toEqual(expect.arrayContaining([expect.objectContaining({id:ids[0],tier:'full',title:'Protected fixture work'}),expect.objectContaining({id:ids[1],tier:'presence'})]))
    expect(admitted.find((item:{id:string})=>item.id===ids[1])).not.toHaveProperty('title')
    expect(await read(admin)).toEqual([])
    expect(await read(owner)).toEqual([])
    await query("UPDATE department_edges SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[workspace,viewer])
    expect(await read(viewer)).toEqual([])
    await query("UPDATE department_edges SET clearance='confidential',expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,viewer])
    expect(await read(viewer)).toEqual([])
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[workspace,viewer])
    expect(await read(viewer)).toEqual([])
  })
})
