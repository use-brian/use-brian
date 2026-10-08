import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, queryWithRLS, runWithAgentAccess } from '../../db/client.js'
import { createDeal, createContact } from '../../db/crm.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { resolveWorkflowRunScope } from '../workflow-authority.js'
import { readWorkflowInputEvidence } from '../workflow-input-evidence.js'
import { readWorkflowOutcomeWithLineage } from '../../crm-operations/workflow-copy-store.js'
import { listCrmEventDelivery } from '../../crm-operations/privacy.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { resumeFromApproval, type ApprovalBridgeDeps } from '../../workflow/approval.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool=getPool(), runs=createDbWorkflowRunStore()
async function fixture() {
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),assistantId=randomUUID()
  for(const id of [owner,member])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Event audience fixture',$2)",[workspaceId,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','internal','assigned')",[workspaceId,owner,member])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Fixture primary',$2,$3,'primary','confidential',NULL)",[assistantId,workspaceId,owner])
  const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(owner,workspaceId,{name:'Fixture department',key:'fixture-department'})
  await groups.addMember(owner,team.id,member)
  const deal=await createDeal(owner,{workspaceId})
  await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[deal.id,[team.compartmentKey]])
  const eventId=randomUUID()
  await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,payload,actor_kind)
    VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal',$3,'{}','user')`,[eventId,workspaceId,deal.id])
  const workflow=await createDbWorkflowStore().create({userId:member,workspaceId,name:'Event audience fixture',definition:{startStepId:'consult',steps:[{id:'consult',type:'assistant_call',target:{assistantId:'primary'},prompt:'Fixture question'}]},
    authoringAuthority:{version:1,assistantId,ceiling:{workspaceId,userId:member,clearance:'internal',compartments:[team.compartmentKey!],mutationCompartments:[team.compartmentKey!],projectIds:null,visibilityAssistantIds:null}}})
  const input={trigger:{sourceType:'crm'},event:{domainEventId:eventId,subjectId:deal.id}}
  const create=(actor=member)=>runs.createRun({workflowId:workflow.id,workspaceId,triggeredBy:actor,triggerKind:'event',input})
  const revoke=()=>pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[team.id,member])
  return {workspaceId,owner,member,assistantId,groups,team,deal,eventId,workflow,input,create,revoke}
}

describe('[COMP:api/crm-event-scope] persisted event audience',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('withholds workflow approval projections and decisions when their CRM source becomes inaccessible',async()=>{
    const f=await fixture(),run=await f.create(),approvals=createPendingApprovalsStore()
    await runs.updateRun(run.id,{vars:{__contextScopeEvidence:await readWorkflowInputEvidence(run.id,f.workspaceId)}})
    const step=await runs.createStepRun({runId:run.id,stepId:'consult',stepType:'assistant_call',input:{}})
    const approval=await approvals.create({workspaceId:f.workspaceId,workflowRunId:run.id,workflowStepRunId:step.id,
      originatingAssistantId:f.assistantId,toolName:'fixtureMutation',arguments:{protected:'Fictional source value'},approverUserId:f.member,deliveryChannelType:'web'})
    expect((await approvals.listPendingForWorkspace(f.member,f.workspaceId)).map(row=>row.id)).toContain(approval.id)
    await f.revoke()
    expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toEqual([])
    expect(await approvals.listPendingForWorkspace(f.member,f.workspaceId)).toEqual([])
    expect(await approvals.getById(f.member,approval.id)).toBeNull()
    expect(await approvals.countPendingForUser(f.member)).toBe(0)
    const deps={approvalsStore:approvals,runStore:runs} as ApprovalBridgeDeps
    expect(await resumeFromApproval(deps,approval.id,'approved',f.member)).toEqual({status:'unavailable',runId:null})
    expect((await approvals.getByIdSystem(approval.id))?.status).toBe('pending')
  })
  it('refuses before input persistence when the recorded actor cannot read the source',async()=>{
    const f=await fixture();await f.revoke()
    await expect(f.create()).rejects.toMatchObject({code:'42501',message:'workflow_source_scope_unavailable'})
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workflow_id=$1',[f.workflow.id])).rows).toEqual([])
  })
  it('rechecks idempotent admission after revocation',async()=>{
    const f=await fixture(),params={workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'event' as const,input:f.input,idempotencyKey:'fixture-event',bodySha256:'a'.repeat(64)}
    expect((await runs.createWebhookRun!(params)).kind).toBe('created')
    await f.revoke()
    await expect(runs.createWebhookRun!(params)).rejects.toMatchObject({code:'42501'})
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workflow_id=$1',[f.workflow.id])).rows).toHaveLength(1)
  })
  it.each(['captured','unresolved'] as const)('does not let an app-role insert impersonate a broader actor for %s evidence',async origin=>{
    const f=await fixture()
    if(origin==='unresolved') {
      const eventId=randomUUID()
      await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind)
        VALUES($1::uuid,$2,'association.inventory.available',$1::text,'event',$3,'user')`,[eventId,f.workspaceId,randomUUID()])
      f.input.event.domainEventId=eventId
    }
    await expect(queryWithRLS(f.member,`INSERT INTO workflow_runs(workflow_id,workspace_id,triggered_by,trigger_kind,input)
      VALUES($1,$2,$3,'event',$4)`,[f.workflow.id,f.workspaceId,f.owner,JSON.stringify(f.input)])).rejects.toMatchObject({code:'42501'})
  })
  it('uses the stored workflow Team instead of caller-supplied scope arrays',async()=>{
    const f=await fixture(),other=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Other department',key:'other-department'})
    await f.groups.addMember(f.owner,other.id,f.member)
    await pool.query('UPDATE workflows SET context_group_id=$2 WHERE id=$1',[f.workflow.id,other.id])
    await expect(f.create()).rejects.toMatchObject({code:'42501'})
    await expect(queryWithRLS(f.member,`INSERT INTO workflow_runs(workflow_id,workspace_id,triggered_by,trigger_kind,input,context_group_id,context_compartments)
      VALUES($1,$2,$3,'event',$4,$5,$6)`,[f.workflow.id,f.workspaceId,f.member,JSON.stringify(f.input),other.id,[f.team.compartmentKey]])).rejects.toMatchObject({code:'42501'})
  })
  it('retains history scope on events, runs and steps after a parent release',async()=>{
    const f=await fixture(),run=await f.create()
    await runs.updateRun(run.id,{vars:{__contextScopeEvidence:await readWorkflowInputEvidence(run.id,f.workspaceId)}})
    await runs.createStepRun({runId:run.id,stepId:'consult',stepType:'assistant_call',input:{private:'Fixture input'}})
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1",[f.deal.id])
    await f.revoke()
    for(const [table,where,ids] of [
      ['crm_domain_event_outbox','id=$1',[f.eventId]],['workflow_runs','id=$1',[run.id]],['workflow_step_runs','run_id=$1',[run.id]],
    ] as const) expect((await queryWithRLS(f.member,`SELECT id FROM ${table} WHERE ${where}`,[...ids])).rows).toEqual([])
    expect((await queryWithRLS(f.owner,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toHaveLength(1)
    await expect(f.create()).rejects.toMatchObject({code:'42501'})
  })
  it('checks source holding before execution and withholds in-flight results with a sticky lease',async()=>{
    const f=await fixture(),run=await f.create(),params={userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run}
    const execution=await resolveWorkflowRunScope(params)
    await expect(execution.executeWithAuthority(async()=>{
      await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.deal.id]);return 'Protected output'
    })).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:true})
    await pool.query('UPDATE entities SET scope_held=false WHERE id=$1',[f.deal.id])
    await expect(execution.executeWithAuthority(async()=> 'Retry')).rejects.toMatchObject({reason:'authority_changed'})
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.deal.id])
    await expect(resolveWorkflowRunScope(params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
  })
  it('intersects bound assistant clearance and Team access at read time',async()=>{
    const f=await fixture(),run=await f.create()
    await runs.updateRun(run.id,{vars:{__contextScopeEvidence:await readWorkflowInputEvidence(run.id,f.workspaceId)}})
    const common={workspaceId:f.workspaceId,userId:f.owner,clearance:'confidential',compartments:null,mutationCompartments:null,projectIds:null,visibilityAssistantIds:null}
    for(const change of [{compartments:[]},{clearance:'public'}]) {
      expect((await runWithAgentAccess({...common,...change},()=>queryWithRLS(f.owner,'SELECT id FROM workflow_runs WHERE id=$1',[run.id]))).rows).toEqual([])
    }
    expect((await runWithAgentAccess(common,()=>queryWithRLS(f.owner,'SELECT id FROM workflow_runs WHERE id=$1',[run.id]))).rows).toHaveLength(1)
  })
  it.each(['clearance','private_user','private_assistant','project'] as const)('retains the saved %s floor after release',async axis=>{
    const f=await fixture(),eventId=randomUUID()
    const access:Parameters<typeof runWithAgentAccess>[0]={workspaceId:f.workspaceId,userId:f.owner,clearance:'confidential',compartments:null,projectIds:null,visibilityAssistantIds:null}
    if(axis==='clearance') {await pool.query("UPDATE entities SET sensitivity='confidential' WHERE id=$1",[f.deal.id]);access.clearance='internal'}
    if(axis==='private_user') {await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1',[f.deal.id,f.owner]);access.userId=f.member}
    if(axis==='private_assistant') {await pool.query('UPDATE entities SET assistant_id=$2 WHERE id=$1',[f.deal.id,f.assistantId]);access.visibilityAssistantIds=[]}
    if(axis==='project') {
      const projectId=randomUUID()
      await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[projectId,f.workspaceId,f.owner])
      await pool.query('UPDATE entities SET project_ids=$2 WHERE id=$1',[f.deal.id,[projectId]]);access.projectIds=[]
    }
    await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind)
      VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal',$3,'user')`,[eventId,f.workspaceId,f.deal.id])
    f.input.event.domainEventId=eventId
    const run=await f.create(f.owner)
    await pool.query("UPDATE entities SET user_id=NULL,assistant_id=NULL,sensitivity='public',compartments='{}',project_ids='{}' WHERE id=$1",[f.deal.id])
    expect((await runWithAgentAccess(access,()=>queryWithRLS(access.userId!,'SELECT id FROM workflow_runs WHERE id=$1',[run.id]))).rows).toEqual([])
  })
  it('propagates the event floor through outcome copies and refuses a later unauthorized copy',async()=>{
    const f=await fixture(),source=await f.create()
    await runs.updateRun(source.id,{vars:{__contextScopeEvidence:await readWorkflowInputEvidence(source.id,f.workspaceId)}})
    await pool.query("UPDATE workflow_runs SET status='completed',finished_at=now(),outcome=$2 WHERE id=$1",[source.id,JSON.stringify({summary:'Protected outcome'})])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual'})
    expect(await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)).toMatchObject({summary:'Protected outcome'})
    await f.revoke()
    expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[target.id])).rows).toEqual([])
    // Current evidence admission refuses before reaching the INSERT guard.
    expect(await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)).toBeNull()
    expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[target.id])).rows).toEqual([{run_id:target.id}])
  })
  it('captures the real source and rejects attempts to rewrite the saved event audience',async()=>{
    const f=await fixture()
    const source=(await pool.query('SELECT scope_source,scope_origin FROM crm_domain_event_outbox WHERE id=$1',[f.eventId])).rows[0]
    expect(source).toMatchObject({scope_origin:'captured',scope_source:{resourceId:f.deal.id,compartments:[f.team.compartmentKey]}})
    for(const change of ["scope_source='{}'", "scope_origin='legacy'", 'subject_id=gen_random_uuid()'])
      await expect(pool.query(`UPDATE crm_domain_event_outbox SET ${change} WHERE id=$1`,[f.eventId])).rejects.toThrow('event_scope_release_required')
  })
  it.each(['contact','submission','entitlement','participation'] as const)('resolves %s from persisted relationships rather than payload authority',async kind=>{
    const f=await fixture(),contact=await createContact(f.owner,{workspaceId:f.workspaceId,name:'Fixture contact',compartments:[f.team.compartmentKey!]}),subjectId=kind==='contact'?contact.id:randomUUID(),eventId=randomUUID()
    if(kind==='submission') await pool.query(`INSERT INTO association_enquiries(id,workspace_id,contact_id,source,source_submission_id,request_fingerprint,subject,message)
      VALUES($1::uuid,$2,$3,'fixture',$1::text,repeat('a',64),'Fixture','Fixture')`,[subjectId,f.workspaceId,contact.id])
    if(kind==='entitlement') {
      const planId=randomUUID()
      await pool.query("INSERT INTO association_membership_plans(id,workspace_id,plan_key,name,currency,fee_minor,billing_period) VALUES($1,$2,'fixture','Fixture','USD',0,'manual')",[planId,f.workspaceId])
      await pool.query(`INSERT INTO association_memberships(id,workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,starts_at)
        VALUES($1::uuid,$2,$3,$4,$1::text,repeat('a',64),now())`,[subjectId,f.workspaceId,contact.id,planId])
    }
    if(kind==='participation') {
      const attendanceId=randomUUID()
      await pool.query("INSERT INTO association_events(id,workspace_id,slug,title,starts_at,ends_at,timezone,mode) VALUES($1,$2,'fixture','Fixture','2099-01-01T00:00:00Z','2099-01-02T00:00:00Z','UTC','venue')",[attendanceId,f.workspaceId])
      await pool.query(`INSERT INTO association_registrations(id,workspace_id,event_id,attendee_contact_id,attendee_name,status,source_kind,source_id,request_fingerprint)
        VALUES($1::uuid,$2,$3,$4,'Fixture','registered','manual',$1::text,repeat('a',64))`,[subjectId,f.workspaceId,attendanceId,contact.id])
    }
    await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,payload,scope_source,scope_origin)
      VALUES($1::uuid,$2,'crm.submission.received',$1::text,$3,$4,'user','{"compartments":[],"clearance":"public"}','{}','legacy')`,[eventId,f.workspaceId,kind,subjectId])
    expect((await pool.query('SELECT scope_source,scope_origin FROM crm_domain_event_outbox WHERE id=$1',[eventId])).rows[0]).toMatchObject({scope_origin:'captured',scope_source:{resourceId:contact.id,compartments:[f.team.compartmentKey]}})
    f.input.event.domainEventId=eventId
    await f.revoke();await expect(f.create()).rejects.toMatchObject({code:'42501'})
  })
  it('filters operator delivery pages and refuses unbound credential scope',async()=>{
    const f=await fixture(),context={workspaceId:f.workspaceId,actor:{kind:'user' as const,userId:f.member},authority:{role:'member' as const,canWrite:true,canConfigure:false,trustedIdentitySources:[]}}
    expect((await listCrmEventDelivery(context)).events).toHaveLength(1)
    await f.revoke();expect((await listCrmEventDelivery(context)).events).toEqual([])
    await expect(listCrmEventDelivery({...context,actor:{kind:'integration_key',credentialId:randomUUID()}})).rejects.toMatchObject({code:'not_authorized'})
  })
  it('admits captured evidence in strict fixtures but refuses aggregate events without complete evidence',async()=>{
    const f=await fixture(),batchId=randomUUID()
    await pool.query("INSERT INTO workspace_access_policies(workspace_id,classification_mode) VALUES($1,'strict') ON CONFLICT(workspace_id) DO UPDATE SET classification_mode='strict'",[f.workspaceId])
    expect((await f.create()).id).toBeTruthy()
    await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,payload)
      VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal',$3,'import','{"batchCount":2}')`,[batchId,f.workspaceId,f.deal.id])
    f.input.event.domainEventId=batchId
    await expect(f.create()).rejects.toMatchObject({code:'42501'})
    expect((await pool.query('SELECT scope_origin FROM crm_domain_event_outbox WHERE id=$1',[batchId])).rows[0].scope_origin).toBe('unresolved')
  })
  it('backfills legacy audiences without relabeling retired receipts or admitting them in strict mode',async()=>{
    const f=await fixture(),client=await pool.connect(),retiredId=randomUUID()
    const migration=(await readFile(new URL('../../../migrations/582_crm_event_scope.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
    try {
      await client.query('BEGIN')
      for(const [table,policy] of [['crm_domain_event_outbox','crm_domain_event_scope_read'],['workflow_runs','workflow_runs_crm_scope_read'],['workflow_step_runs','workflow_steps_crm_scope_read'],['workflow_run_copy_sources','workflow_copies_crm_scope_read']])await client.query(`DROP POLICY ${policy} ON ${table}`)
      await client.query('DROP TRIGGER crm_scope_event_guard ON crm_domain_event_outbox; DROP TRIGGER workflow_event_scope_guard ON workflow_runs; DROP TRIGGER workflow_event_scope_guard ON workflow_run_copy_sources')
      for(const fn of ['guard_crm_event_scope()','guard_workflow_event_scope()','crm_event_scope_visible(uuid)','workflow_crm_scope_visible(uuid)','workflow_crm_scope_allows(uuid,uuid,text[],uuid[])','crm_event_scope_allows(uuid,uuid,text[],uuid[])','crm_scope_snapshot_allows(jsonb,uuid,uuid,text[],uuid[])','crm_event_entity_source(uuid,text,uuid,boolean)'])await client.query(`DROP FUNCTION ${fn}`)
      await client.query('ALTER TABLE crm_domain_event_outbox DROP COLUMN scope_source,DROP COLUMN scope_origin,DROP COLUMN scope_held')
      await client.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,payload,status,retired_at,retired_from_status)
        VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal','00000000-0000-0000-0000-000000000000','user','{"erased":true,"eventType":"crm.deal.stage_changed"}','retired',now(),'pending')`,[retiredId,f.workspaceId])
      await client.query(migration)
      expect((await client.query('SELECT scope_origin,scope_source FROM crm_domain_event_outbox WHERE id=$1',[f.eventId])).rows[0]).toMatchObject({scope_origin:'legacy',scope_source:{resourceId:f.deal.id}})
      expect((await client.query('SELECT scope_source,status FROM crm_domain_event_outbox WHERE id=$1',[retiredId])).rows[0]).toEqual({scope_source:null,status:'retired'})
      expect((await client.query('SELECT crm_event_scope_allows($1,$2) AS allowed',[f.eventId,f.member])).rows[0].allowed).toBe(true)
      await client.query("INSERT INTO workspace_access_policies(workspace_id,classification_mode) VALUES($1,'strict') ON CONFLICT(workspace_id) DO UPDATE SET classification_mode='strict'",[f.workspaceId])
      expect((await client.query('SELECT crm_event_scope_allows($1,$2) AS allowed',[f.eventId,f.member])).rows[0].allowed).toBe(false)
    } finally {await client.query('ROLLBACK');client.release()}
  })
})
