import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { crmDomainEventToDispatchEvent } from '@use-brian/core'
import { getPool, getAppPool, queryWithRLS } from '../../db/client.js'
import { createContact } from '../../db/crm.js'
import { getGoalById, getGoalByIdSystem } from '../../db/goals.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { claimCrmGoalEventResume, assertGoalCrmSourceAuthority } from '../crm-event-resume.js'
import { resolveWorkflowRunScope,captureAuthoringAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { prepareCrmPrivacyCopies, retireCrmNotificationCopies } from '../../crm-operations/privacy-copy-resolver.js'
import { CRM_PRIVACY_COVERAGE, crmPrivacyDomainSql } from '../../crm-operations/privacy-coverage.js'
import { pruneCrmOperationsRetention } from '../../crm-operations/privacy.js'
import type { GoalAwaitingEvent } from '../driver.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),runs=createDbWorkflowRunStore()
async function fixture(){
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),assistantId=randomUUID(),goalId=randomUUID(),eventId=randomUUID()
  for(const id of [owner,member])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Goal source fixture',$2)",[workspaceId,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','internal','assigned')",[workspaceId,owner,member])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Fixture primary',$2,$3,'primary','confidential',NULL)",[assistantId,workspaceId,owner])
  const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(owner,workspaceId,{name:'Fixture department',key:'fixture-department'})
  await groups.addMember(owner,team.id,member)
  const contact=await createContact(owner,{workspaceId,name:'Fixture contact',compartments:[team.compartmentKey!]})
  await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,payload,actor_kind)
    VALUES($1::uuid,$2,'crm.consent.changed',$1::text,'contact',$3,'{}','user')`,[eventId,workspaceId,contact.id])
  const authoringAuthority=await captureAuthoringAuthoritySystem({userId:member,assistantId,workspaceId,contextGroupId:null,contextProjectId:null})
  const workflow=await createDbWorkflowStore().create({userId:member,workspaceId,authoringAuthority,name:'Goal source fixture',definition:{startStepId:'consult',steps:[{id:'consult',type:'assistant_call',target:{assistantId:'primary'},prompt:'Fixture question'}]}})
  let marker:GoalAwaitingEvent={subscriptions:[{source:{type:'crm'}}],state:{iteration:3,spend:2,noProgressStreak:0,runId:null}}
  await pool.query(`INSERT INTO goals(id,workspace_id,outcome,done_when,means,created_by_user_id,confirmed_at,awaiting_event,authoring_authority)
    VALUES($1,$2,'Fixture outcome','{"kind":"subtasks"}',jsonb_build_object('workflowId',$3::text),$4,now(),$5,$6::jsonb)`,[goalId,workspaceId,workflow.id,member,JSON.stringify(marker),JSON.stringify(authoringAuthority)])
  marker=(await pool.query('SELECT awaiting_event FROM goals WHERE id=$1',[goalId])).rows[0].awaiting_event
  const event=crmDomainEventToDispatchEvent({id:eventId,workspaceId,eventType:'crm.consent.changed',subjectKind:'contact',subjectId:contact.id,payload:{},actorKind:'user',occurredAt:new Date()})
  const create=()=>runs.createRun({workflowId:workflow.id,workspaceId,triggeredBy:member,triggerKind:'manual',input:{goalId}})
  const revoke=()=>groups.removeMember(owner,team.id,member)
  return {workspaceId,owner,member,assistantId,goalId,eventId,groups,team,contact,workflow,marker,event,create,revoke}
}
describe('[COMP:api/goal-crm-scope] durable goal wake-up sources',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('refuses an unauthorized wake without consuming the park marker',async()=>{
    const f=await fixture();await f.revoke()
    await expect(claimCrmGoalEventResume(f.goalId,f.event,f.marker)).rejects.toMatchObject({code:'42501'})
    expect((await pool.query('SELECT awaiting_event FROM goals WHERE id=$1',[f.goalId])).rows[0].awaiting_event).toEqual(f.marker)
    expect((await pool.query('SELECT event_id FROM goal_crm_event_sources WHERE goal_id=$1',[f.goalId])).rows).toEqual([])
  })
  it('claims once under concurrency and cannot consume a later park on duplicate delivery',async()=>{
    const f=await fixture()
    expect((await Promise.all([claimCrmGoalEventResume(f.goalId,f.event,f.marker),claimCrmGoalEventResume(f.goalId,f.event,f.marker)])).sort()).toEqual([false,true])
    const again=(await pool.query('UPDATE goals SET awaiting_event=$2 WHERE id=$1 RETURNING awaiting_event',[f.goalId,JSON.stringify(f.marker)])).rows[0].awaiting_event
    expect(again.revision).not.toBe(f.marker.revision)
    expect(await claimCrmGoalEventResume(f.goalId,f.event,again)).toBe(false)
    expect((await pool.query('SELECT awaiting_event FROM goals WHERE id=$1',[f.goalId])).rows[0].awaiting_event).toEqual(again)
  })
  it('re-matches canonical events and refuses stale or forged dispatch descriptions',async()=>{
    const f=await fixture(),marker={...f.marker,subscriptions:[{source:{type:'crm' as const},match:{inChannels:['crm.deal.stage_changed']}}]}
    await pool.query('UPDATE goals SET awaiting_event=$2 WHERE id=$1',[f.goalId,JSON.stringify(marker)])
    expect(await claimCrmGoalEventResume(f.goalId,{...f.event,channelId:'crm.deal.stage_changed'},marker)).toBe(false)
    expect(await claimCrmGoalEventResume(f.goalId,f.event,f.marker)).toBe(false)
  })
  it('does not consume a new park generation with identical subscriptions and loop state',async()=>{
    const f=await fixture()
    const next=(await pool.query('UPDATE goals SET awaiting_event=$2 WHERE id=$1 RETURNING awaiting_event',[f.goalId,JSON.stringify(f.marker)])).rows[0].awaiting_event
    expect(next.revision).not.toBe(f.marker.revision)
    expect(await claimCrmGoalEventResume(f.goalId,f.event,f.marker)).toBe(false)
    expect(await claimCrmGoalEventResume(f.goalId,f.event,next)).toBe(true)
  })
  it('keeps saved protection through source release, marker clearing, workflow input edits and revocation',async()=>{
    const f=await fixture();expect(await claimCrmGoalEventResume(f.goalId,f.event,f.marker)).toBe(true)
    const run=await f.create()
    await runs.createStepRun({runId:run.id,stepId:'consult',stepType:'assistant_call',input:{private:'Protected output'}})
    await pool.query("UPDATE workflow_runs SET input='{}' WHERE id=$1",[run.id])
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1",[f.contact.id]);await f.revoke()
    for(const [table,where,id] of [['goals','id',f.goalId],['workflow_runs','id',run.id],['workflow_step_runs','run_id',run.id]])
      expect((await queryWithRLS(f.member,`SELECT id FROM ${table} WHERE ${where}=$1`,[id])).rows).toEqual([])
    const client=await pool.connect()
    try{expect(await getGoalById(f.member,f.goalId,client)).toBeNull()}finally{client.release()}
    await expect(f.create()).rejects.toMatchObject({code:'42501'})
    await expect(assertGoalCrmSourceAuthority((await getGoalByIdSystem(f.goalId))!)).rejects.toThrow('goal_source_scope_unavailable')
  })
  it('checks goal Team selection rather than allowing a broad creator to wake a foreign lane',async()=>{
    const f=await fixture(),other=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Other department',key:'other-department'})
    await f.groups.addMember(f.owner,other.id,f.member)
    await pool.query('UPDATE goals SET context_group_id=$2 WHERE id=$1',[f.goalId,other.id])
    await expect(claimCrmGoalEventResume(f.goalId,f.event,f.marker)).rejects.toMatchObject({code:'42501'})
  })
  it('invalidates a workflow lease when a goal wake-up source changes',async()=>{
    const f=await fixture();await claimCrmGoalEventResume(f.goalId,f.event,f.marker)
    const run=await f.create(),execution=await resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run})
    expect(execution.inputScopeEvidence.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({resourceKind:'crm_event',resourceId:f.eventId}),
      expect.objectContaining({resourceKind:'entity',resourceId:f.contact.id}),
    ]))
    await expect(execution.executeWithAuthority(async()=>{await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.contact.id]);return 'Protected result'})).rejects.toMatchObject({reason:'authority_changed'})
  })
  it.each(['team','project'])('refuses a parked goal in an archived %s before consuming the marker or creating a run',async kind=>{
    const f=await fixture()
    if(kind==='team') {
      await pool.query('UPDATE goals SET context_group_id=$2 WHERE id=$1',[f.goalId,f.team.id])
      await pool.query("UPDATE workspace_groups SET status='archived' WHERE id=$1",[f.team.id])
    }else {
      const projectId=randomUUID()
      await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by,status) VALUES($1,$2,'Archived','archived',$3,'archived')",[projectId,f.workspaceId,f.owner])
      await pool.query('UPDATE goals SET context_project_id=$2 WHERE id=$1',[f.goalId,projectId])
    }
    await expect(claimCrmGoalEventResume(f.goalId,f.event,f.marker)).rejects.toMatchObject({code:'42501'})
    await expect(f.create()).rejects.toMatchObject({code:'42501'})
    expect((await pool.query('SELECT awaiting_event FROM goals WHERE id=$1',[f.goalId])).rows[0].awaiting_event).toEqual(f.marker)
    expect((await pool.query('SELECT event_id FROM goal_crm_event_sources WHERE goal_id=$1',[f.goalId])).rows).toEqual([])
  })
  it('bounds a General workflow to its goal Team for reads, writes and resumed execution',async()=>{
    const f=await fixture(),other=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Second department',key:'second-department'})
    await f.groups.addMember(f.owner,other.id,f.member)
    const foreign=await createContact(f.owner,{workspaceId:f.workspaceId,name:'Other department contact',compartments:[other.compartmentKey!]})
    await pool.query('UPDATE goals SET context_group_id=$2 WHERE id=$1',[f.goalId,f.team.id])
    await claimCrmGoalEventResume(f.goalId,f.event,f.marker)
    const run=await f.create(),params={userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run}
    const execution=await resolveWorkflowRunScope(params)
    expect(run.contextGroupId).toBeNull()
    expect(execution.turnScope).toMatchObject({activeGroupId:f.team.id,writeCompartments:[f.team.compartmentKey],
      access:{compartments:[f.team.compartmentKey],mutationCompartments:[f.team.compartmentKey]}})
    await execution.executeWithAuthority(async()=>{
      expect((await queryWithRLS(f.member,'SELECT id FROM entities WHERE id=$1',[foreign.id])).rows).toEqual([])
      expect((await queryWithRLS(f.member,"UPDATE entities SET display_name='Forbidden change' WHERE id=$1 RETURNING id",[foreign.id])).rows).toEqual([])
      expect((await queryWithRLS(f.member,'SELECT id FROM entities WHERE id=$1',[f.contact.id])).rows).toHaveLength(1)
    })
    await pool.query("UPDATE workflow_runs SET input='{}',status='running' WHERE id=$1",[run.id])
    expect((await resolveWorkflowRunScope(params)).turnScope.writeCompartments).toEqual([f.team.compartmentKey])
    await pool.query('UPDATE goals SET context_group_id=NULL WHERE id=$1',[f.goalId])
    await expect(resolveWorkflowRunScope(params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
    await expect(execution.executeWithAuthority(async()=> 'Stale result')).rejects.toMatchObject({reason:'authority_changed'})
  })
  it('preserves the goal Project when a company-wide workflow is reused',async()=>{
    const f=await fixture(),projectId=randomUUID(),foreignProjectId=randomUUID()
    for(const id of [projectId,foreignProjectId])await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1::uuid,$2,$1::text,$1::text,$3)",[id,f.workspaceId,f.owner])
    const foreign=await createContact(f.owner,{workspaceId:f.workspaceId,name:'Other project contact',projectIds:[foreignProjectId]})
    const projectAuthority=await captureAuthoringAuthoritySystem({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,contextGroupId:null,contextProjectId:projectId})
    await pool.query('UPDATE goals SET context_project_id=$2,authoring_authority=$3::jsonb WHERE id=$1',[f.goalId,projectId,JSON.stringify(projectAuthority)])
    await claimCrmGoalEventResume(f.goalId,f.event,f.marker)
    const run=await f.create(),execution=await resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run})
    expect(execution.turnScope).toMatchObject({activeProjectId:projectId,writeProjectIds:[projectId],access:{projectIds:[projectId]}})
    await execution.executeWithAuthority(async()=>{
      expect((await queryWithRLS(f.member,'SELECT id FROM entities WHERE id=$1',[foreign.id])).rows).toEqual([])
    })
    await expect(execution.executeWithAuthority(async()=>{
      await pool.query("UPDATE workspace_projects SET status='archived' WHERE id=$1",[projectId])
      return 'Stale project result'
    })).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:true})
  })
  it('rechecks goal selection at run admission and refuses incompatible workflow write defaults',async()=>{
    const f=await fixture(),other=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Second department',key:'second-department'})
    await f.groups.addMember(f.owner,other.id,f.member)
    await claimCrmGoalEventResume(f.goalId,f.event,f.marker)
    await pool.query('UPDATE goals SET context_group_id=$2 WHERE id=$1',[f.goalId,other.id])
    await expect(f.create()).rejects.toMatchObject({code:'42501'})
    const plain=await fixture(),second=await plain.groups.createTeam(plain.owner,plain.workspaceId,{name:'Other team',key:'other-team'})
    await plain.groups.addMember(plain.owner,second.id,plain.member)
    await pool.query('UPDATE goals SET context_group_id=$2 WHERE id=$1',[plain.goalId,plain.team.id])
    await pool.query('UPDATE workflows SET context_group_id=$2 WHERE id=$1',[plain.workflow.id,second.id])
    const run=await plain.create()
    await expect(resolveWorkflowRunScope({userId:plain.member,assistantId:plain.assistantId,workspaceId:plain.workspaceId,run})).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
    expect((await pool.query('SELECT execution_authority FROM workflow_runs WHERE id=$1',[run.id])).rows[0].execution_authority).toBeNull()
  })
  it('cannot delete causal receipts, detach a workflow or transfer its recorded actor',async()=>{
    const f=await fixture();await claimCrmGoalEventResume(f.goalId,f.event,f.marker)
    const run=await f.create()
    await expect(pool.query('DELETE FROM goal_crm_event_sources WHERE goal_id=$1',[f.goalId])).rejects.toThrow('goal_source_scope_immutable')
    await expect(pool.query('UPDATE workflow_runs SET source_goal_id=NULL WHERE id=$1',[run.id])).rejects.toThrow('goal_source_scope_immutable')
    await expect(runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.owner,triggerKind:'manual',input:{goalId:f.goalId}})).rejects.toMatchObject({code:'42501'})
    await pool.query('DELETE FROM goals WHERE id=$1',[f.goalId])
    expect((await pool.query('SELECT event_id FROM goal_crm_event_sources WHERE goal_id=$1',[f.goalId])).rows).toHaveLength(1)
    await expect(pool.query('DELETE FROM goal_crm_event_sources WHERE goal_id=$1',[f.goalId])).rejects.toThrow('goal_source_scope_immutable')
    expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toEqual([])
  })
  it('keeps a missing source as a denial rather than deleting its causal receipt',async()=>{
    const f=await fixture();await claimCrmGoalEventResume(f.goalId,f.event,f.marker)
    const run=await f.create()
    await pool.query('DELETE FROM crm_domain_event_outbox WHERE id=$1',[f.eventId])
    expect((await pool.query('SELECT event_id FROM goal_crm_event_sources WHERE goal_id=$1',[f.goalId])).rows).toHaveLength(1)
    expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toEqual([])
    const replacement=await createContact(f.owner,{workspaceId:f.workspaceId,name:'Unrelated public source'})
    await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,payload,actor_kind)
      VALUES($1::uuid,$2,'crm.consent.changed',$1::text,'contact',$3,'{}','user')`,[f.eventId,f.workspaceId,replacement.id])
    expect((await queryWithRLS(f.member,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toEqual([])
  })
  it('uses canonical workflow context at goal-run admission',async()=>{
    const f=await fixture();await claimCrmGoalEventResume(f.goalId,f.event,f.marker)
    const other=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Other department',key:'other-department'})
    await f.groups.addMember(f.owner,other.id,f.member)
    await pool.query('UPDATE workflows SET context_group_id=$2 WHERE id=$1',[f.workflow.id,other.id])
    await expect(f.create()).rejects.toMatchObject({code:'42501'})
    await expect(queryWithRLS(f.member,`INSERT INTO workflow_runs(workflow_id,workspace_id,triggered_by,trigger_kind,input,context_group_id,context_compartments)
      VALUES($1,$2,$3,'manual',$4,$5,$6)`,[f.workflow.id,f.workspaceId,f.member,JSON.stringify({goalId:f.goalId}),other.id,[f.team.compartmentKey]])).rejects.toMatchObject({code:'42501'})
  })
  it('upgrades an existing goal run without inventing historical event provenance',async()=>{
    const f=await fixture(),run=await f.create(),client=await pool.connect()
    const sql=(await readFile(new URL('../../../migrations/584_goal_crm_scope.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
    const previous=await readFile(new URL('../../../migrations/582_crm_event_scope.sql',import.meta.url),'utf8')
    const previousFunction=previous.slice(previous.indexOf('CREATE FUNCTION workflow_crm_scope_allows'),previous.indexOf('REVOKE ALL ON FUNCTION workflow_crm_scope_allows')).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
    try{
      await client.query('BEGIN');await client.query(previousFunction)
      await client.query('DROP POLICY goals_crm_source_read ON goals')
      await client.query('DROP TRIGGER goal_event_park_revision ON goals')
      await client.query('DROP FUNCTION stamp_goal_event_park()')
      await client.query('DROP TRIGGER workflow_goal_scope_guard ON workflow_runs')
      await client.query('ALTER TABLE workflow_runs DROP COLUMN source_goal_id')
      await client.query('DROP TABLE goal_crm_event_sources')
      for(const fn of ['claim_crm_goal_resume(uuid,uuid,uuid,jsonb)','guard_goal_crm_source()','guard_workflow_goal_scope()','goal_crm_execution_allows(uuid)','goal_crm_scope_visible(uuid)','goal_crm_scope_allows(uuid,uuid,text[],uuid[])','goal_crm_event_binding(crm_domain_event_outbox)'])await client.query(`DROP FUNCTION ${fn}`)
      await client.query(sql)
      expect((await client.query('SELECT source_goal_id FROM workflow_runs WHERE id=$1',[run.id])).rows[0].source_goal_id).toBe(f.goalId)
      expect((await client.query('SELECT event_id FROM goal_crm_event_sources WHERE goal_id=$1',[f.goalId])).rows).toEqual([])
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('retains wake-up events during legacy retention even before a workflow run exists',async()=>{
    const f=await fixture()
    await pool.query("UPDATE crm_domain_event_outbox SET status='delivered',created_at=now()-interval '2 days' WHERE id=$1",[f.eventId])
    await claimCrmGoalEventResume(f.goalId,f.event,f.marker)
    await pruneCrmOperationsRetention({workspaceId:f.workspaceId,actor:{kind:'user',userId:f.owner},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}},new Date())
    expect((await pool.query('SELECT id FROM crm_domain_event_outbox WHERE id=$1',[f.eventId])).rows).toHaveLength(1)
  })
  it('minimizes terminal privacy receipts and cannot revive their original source binding',async()=>{
    const f=await fixture();await claimCrmGoalEventResume(f.goalId,f.event,f.marker)
    const before=(await pool.query('SELECT event_binding FROM goal_crm_event_sources WHERE goal_id=$1',[f.goalId])).rows[0].event_binding
    const client=await pool.connect()
    try{await client.query('BEGIN');await prepareCrmPrivacyCopies(client,f.workspaceId,f.contact.id)
      await retireCrmNotificationCopies(client,f.workspaceId,f.contact.id);await client.query('COMMIT')
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    expect((await pool.query('SELECT event_binding FROM goal_crm_event_sources WHERE goal_id=$1',[f.goalId])).rows[0].event_binding).toEqual({erased:true})
    await expect(pool.query('UPDATE goal_crm_event_sources SET event_binding=$2 WHERE goal_id=$1',[f.goalId,JSON.stringify(before)])).rejects.toThrow('goal_source_scope_immutable')
    await expect(assertGoalCrmSourceAuthority((await getGoalByIdSystem(f.goalId))!)).rejects.toThrow('goal_source_scope_unavailable')
  })
  it('includes goal-driven runs in canonical subject privacy copy discovery',async()=>{
    const f=await fixture();await claimCrmGoalEventResume(f.goalId,f.event,f.marker)
    const run=await f.create(),client=await pool.connect()
    try{await client.query('BEGIN');await prepareCrmPrivacyCopies(client,f.workspaceId,f.contact.id)
      expect((await client.query('SELECT id FROM pg_temp.crm_privacy_copy_workflows WHERE id=$1',[run.id])).rows).toHaveLength(1)
      const domain=CRM_PRIVACY_COVERAGE.find(entry=>entry.domain==='workflow_runs')!
      const exported=(await client.query(crmPrivacyDomainSql(domain,'workspace'),[f.workspaceId,null])).rows
      expect(exported).toHaveLength(1)
      expect(JSON.parse(exported[0].payload)).not.toHaveProperty('source_goal_id')
      const receipts=CRM_PRIVACY_COVERAGE.find(entry=>entry.domain==='goal_crm_event_sources')!
      expect((await client.query(crmPrivacyDomainSql(receipts,'workspace'),[f.workspaceId,null])).rows).toEqual([])
    }finally{await client.query('ROLLBACK');client.release()}
  })
})
