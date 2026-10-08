import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, query, queryWithRLS, runWithAgentAccess } from '../../db/client.js'
import { createDeal } from '../../db/crm.js'
import { createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { readWorkflowInputEvidence } from '../workflow-input-evidence.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:api/crm-event-scope] v2 source snapshots', () => {
  it('uses department tiers for event and workflow history with no role bypass', async () => {
    const workspace=randomUUID(), owner=randomUUID(), admin=randomUUID(), member=randomUUID(), custodian=randomUUID()
    const department=randomUUID(), assistant=randomUUID(), weak=randomUUID(), workflow=randomUUID(), event=randomUUID()
    for(const user of [owner,admin,member,custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[user])
    await query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional history fixture',$2,true)",[workspace,owner])
    for(const [user,role,tier] of [[owner,'owner','confidential'],[admin,'admin','confidential'],[member,'member','public'],[custodian,'member','confidential']])
      await query('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)',[workspace,user,role,tier])
    for(const [id,kind] of [[assistant,'primary'],[weak,'standard']]) await query("INSERT INTO assistants(id,name,workspace_id,kind,clearance,owner_user_id) VALUES($1,'Fixture assistant',$2,$3,'confidential',$4)",[id,workspace,kind,owner])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Research',$3,'team',$1::text,$4)",[department,workspace,custodian,`team:${department}`])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[workspace,department,member])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'internal','store') ON CONFLICT DO NOTHING",[workspace,department,weak])
    await query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Research','team',$3)",[workspace,`team:${department}`,department])
    const deal=await createDeal(owner,{workspaceId:workspace})
    await query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[deal.id,[`team:${department}`]])
    await query("INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,payload,actor_kind) VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal',$3,'{}','user')",[event,workspace,deal.id])
    const readEvent=async(user:string)=>(await queryWithRLS(user,'SELECT id FROM crm_domain_event_outbox WHERE id=$1',[event])).rows
    // A Public base does not cap a Confidential department edge.
    expect(await readEvent(member)).toEqual([{id:event}])
    expect(await readEvent(owner)).toEqual([])
    expect(await readEvent(admin)).toEqual([])
    await query("INSERT INTO workflows(id,workspace_id,created_by,name,definition) VALUES($1,$2,$3,'Fictional source workflow',$4)",[workflow,workspace,member,JSON.stringify({startStepId:'review',steps:[{id:'review',type:'tool_call',toolName:'fixtureReview',arguments:{}}]})])
    // System admission must evaluate the explicit recorded actor even without a caller GUC.
    const runs=createDbWorkflowRunStore()
    const run=await runs.createRun({workflowId:workflow,workspaceId:workspace,triggeredBy:member,triggerKind:'event',input:{trigger:{sourceType:'crm'},event:{domainEventId:event,subjectId:deal.id}}})
    expect(await runs.getRunById(member,run.id)).toBeNull()
    await runs.updateRun(run.id,{vars:{__contextScopeEvidence:await readWorkflowInputEvidence(run.id,workspace)}})
    expect((await runs.getRunById(member,run.id))?.id).toBe(run.id)
    expect(await runs.getRunById(owner,run.id)).toBeNull()
    const agent=(assistantId:string)=>({workspaceId:workspace,userId:member,clearance:'confidential' as const,compartments:null,projectIds:null,visibilityAssistantIds:null,
      departmentRead:{workspaceId:workspace,userId:member,assistantId,base:'public' as const,departments:{[department]:'confidential' as const},contextDepartment:null,binding:null,cap:null}})
    expect(await runWithAgentAccess(agent(weak),()=>readEvent(member))).toEqual([])
    expect(await runWithAgentAccess(agent(assistant),()=>readEvent(member))).toEqual([{id:event}])
    const bound=agent(assistant)
    expect(await runWithAgentAccess({...bound,departmentRead:{...bound.departmentRead,binding:[]}},()=>readEvent(member))).toEqual([])
    expect(await runWithAgentAccess({...bound,departmentRead:{...bound.departmentRead,cap:'internal'}},()=>readEvent(member))).toEqual([])
    await expect(queryWithRLS(member,'SELECT department_read_grants_for($1)',[owner])).rejects.toMatchObject({code:'42501'})
    const client=await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true)",[member])
      expect((await client.query('SELECT department_read_grants_for($1) AS grants',[owner])).rows[0].grants).toEqual({})
      expect((await client.query("SELECT current_setting('app.current_user_id') AS actor")).rows[0].actor).toBe(member)
    } finally { await client.query('ROLLBACK'); client.release() }
    // Releasing the current source cannot erase the saved event audience.
    await query("UPDATE entities SET sensitivity='public',compartments='{}' WHERE id=$1",[deal.id])
    await query("UPDATE department_edges SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[workspace,member])
    expect(await readEvent(member)).toEqual([])
    expect(await runs.getRunById(member,run.id)).toBeNull()
    await query("UPDATE department_edges SET clearance='confidential',expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,member])
    expect(await readEvent(member)).toEqual([])
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[workspace,member])
    expect(await readEvent(member)).toEqual([])
    expect(await runs.getRunById(member,run.id)).toBeNull()
    await query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[workspace])
    expect(await readEvent(owner)).toEqual([{id:event}])
    expect(await readEvent(member)).toEqual([])
  })
})
