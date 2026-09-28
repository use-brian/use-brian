import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { type ScopeSource } from '@use-brian/core'
import { getPool, getAppPool } from '../../db/client.js'
import { createDeal, createContact } from '../../db/crm.js'
import { createMemory } from '../../db/memories.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { resolveWorkflowRunScope } from '../workflow-authority.js'
import { readWorkflowInputEvidence } from '../workflow-input-evidence.js'
import { readWorkflowOutcomeWithLineage } from '../../crm-operations/workflow-copy-store.js'
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
  if(!team.compartmentKey)throw new Error('Fixture team has no compartment key')
  const teamKey=team.compartmentKey
  await groups.addMember(owner,team.id,member)
  const deal=await createDeal(owner,{workspaceId})
  await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[deal.id,[team.compartmentKey]])
  const eventId=randomUUID()
  await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,payload,actor_kind)
    VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal',$3,'{}','user')`,[eventId,workspaceId,deal.id])
  const workflow=await createDbWorkflowStore().create({
    userId:member,
    workspaceId,
    name:'Event audience fixture',
    definition:{startStepId:'consult',steps:[{id:'consult',type:'assistant_call',target:{assistantId:'primary'},prompt:'Fixture question'}]},
    authoringAuthority:{
      version:1,
      assistantId,
      ceiling:{
        workspaceId,
        userId:member,
        clearance:'internal',
        compartments:[teamKey],
        mutationCompartments:[teamKey],
        projectIds:null,
        visibilityAssistantIds:null,
      },
    },
  })
  const input={trigger:{sourceType:'crm'},event:{domainEventId:eventId,subjectId:deal.id}}
  const create=(actor=member)=>runs.createRun({workflowId:workflow.id,workspaceId,triggeredBy:actor,triggerKind:'event',input})
  const revoke=()=>pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[team.id,member])
  return {workspaceId,owner,member,assistantId,groups,team,deal,eventId,workflow,input,create,revoke}
}


async function derive(f: Awaited<ReturnType<typeof fixture>>, sources: ScopeSource[]) {
  return createMemory({workspaceId:f.workspaceId,userId:f.member,assistantId:f.assistantId,
    createdByUserId:f.member,summary:'Derived event note',sensitivity:'internal',
    derivation:{producer:'fixture:event',sources}})
}
describe('[COMP:api/workflow-input-evidence] canonical causal inputs',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('preserves the saved audience after release and records event plus current-entity edges',async()=>{
    const f=await fixture(),run=await f.create()
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1",[f.deal.id])
    const scope=await resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run})
    expect(scope.inputScopeEvidence.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({resourceKind:'crm_event',resourceId:f.eventId,compartments:[f.team.compartmentKey]}),
      expect.objectContaining({resourceKind:'entity',resourceId:f.deal.id,compartments:[]}),
    ]))
    const memory=await derive(f,scope.inputScopeEvidence.sources!)
    expect(memory.compartments).toEqual([f.team.compartmentKey])
    expect((await pool.query('SELECT source_kind FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1 ORDER BY source_kind',[memory.id])).rows).toEqual([{source_kind:'crm_event'},{source_kind:'entity'}])
  })
  it.each(['payload','actor','time','hold','delete','retire','entity'] as const)('withholds existing descendants and refuses stale %s inputs',async change=>{
    const f=await fixture(),run=await f.create(),evidence=await readWorkflowInputEvidence(run.id,f.workspaceId)
    const memory=await derive(f,evidence.sources!)
    if(change==='payload')await pool.query(`UPDATE crm_domain_event_outbox SET payload='{"changed":true}' WHERE id=$1`,[f.eventId])
    if(change==='actor')await pool.query("UPDATE crm_domain_event_outbox SET actor_kind='import' WHERE id=$1",[f.eventId])
    if(change==='time')await pool.query("UPDATE crm_domain_event_outbox SET occurred_at=occurred_at+interval '1 minute' WHERE id=$1",[f.eventId])
    if(change==='hold')await pool.query('UPDATE crm_domain_event_outbox SET scope_held=true WHERE id=$1',[f.eventId])
    if(change==='delete') {
      await pool.query('DELETE FROM workflow_runs WHERE id=$1',[run.id])
      await pool.query('DELETE FROM crm_domain_event_outbox WHERE id=$1',[f.eventId])
    }
    if(change==='retire')await pool.query("UPDATE crm_domain_event_outbox SET retired_from_status=status,retired_at=now(),status='retired',subject_id='00000000-0000-0000-0000-000000000000',payload=jsonb_build_object('erased',true,'eventType',event_type) WHERE id=$1",[f.eventId])
    if(change==='entity')await pool.query("UPDATE entities SET attributes=attributes||'{\"changed\":true}'::jsonb WHERE id=$1",[f.deal.id])
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[memory.id])).rows[0].scope_held).toBe(true)
    await expect(derive(f,evidence.sources!)).rejects.toThrow('scope_source_changed')
  })
  it('requires the current entity edge at the canonical writer',async()=>{
    const f=await fixture(),run=await f.create(),evidence=await readWorkflowInputEvidence(run.id,f.workspaceId)
    await expect(derive(f,evidence.sources!.filter(s=>s.resourceKind==='crm_event'))).rejects.toThrow('scope_evidence_missing')
  })
  it('keeps delivery bookkeeping outside content versions',async()=>{
    const f=await fixture(),run=await f.create(),before=await readWorkflowInputEvidence(run.id,f.workspaceId)
    await pool.query("UPDATE crm_domain_event_outbox SET status='delivered',attempts=attempts+1 WHERE id=$1",[f.eventId])
    expect(await readWorkflowInputEvidence(run.id,f.workspaceId)).toEqual(before)
    expect((await derive(f,before.sources!)).id).toBeTruthy()
  })
  it('rejects changed event content during execution and stale persisted evidence on resume',async()=>{
    const f=await fixture(),run=await f.create(),params={userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run}
    const scope=await resolveWorkflowRunScope(params)
    await runs.updateRun(run.id,{vars:{__contextScopeEvidence:scope.inputScopeEvidence}})
    await expect(scope.executeWithAuthority(async()=>{
      await pool.query(`UPDATE crm_domain_event_outbox SET payload='{"updated":true}' WHERE id=$1`,[f.eventId])
      return 'Stale answer'
    })).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:true})
    await expect(resolveWorkflowRunScope(params)).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
  })
  it('follows copied outcome receipts instead of forged source IDs in input JSON',async()=>{
    const f=await fixture(),source=await f.create()
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Protected\"}' WHERE id=$1",[source.id])
    const target=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspaceId,triggeredBy:f.member,triggerKind:'manual',input:{event:{domainEventId:randomUUID()}}})
    expect((await readWorkflowInputEvidence(target.id,f.workspaceId)).sources).toBeUndefined()
    await readWorkflowOutcomeWithLineage(f.workflow.id,target.id)
    expect((await readWorkflowInputEvidence(target.id,f.workspaceId)).sources).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'crm_event',resourceId:f.eventId})]))
  })
  it.each(['reassign','delete'] as const)('holds association event descendants on subject %s',async change=>{
    const f=await fixture(),contact=await createContact(f.owner,{workspaceId:f.workspaceId,name:'Fixture contact'}),subject=randomUUID(),eventId=randomUUID()
    await pool.query(`INSERT INTO association_enquiries(id,workspace_id,contact_id,source,source_submission_id,request_fingerprint,subject,message)
      VALUES($1::uuid,$2,$3,'fixture',$1::text,repeat('a',64),'Fixture','Fixture')`,[subject,f.workspaceId,contact.id])
    await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind)
      VALUES($1::uuid,$2,'crm.submission.received',$1::text,'submission',$3,'user')`,[eventId,f.workspaceId,subject])
    f.input.event.domainEventId=eventId
    const run=await f.create(),evidence=await readWorkflowInputEvidence(run.id,f.workspaceId),memory=await derive(f,evidence.sources!)
    if(change==='reassign') {
      const other=await createContact(f.owner,{workspaceId:f.workspaceId,name:'Other fixture'})
      await pool.query('UPDATE association_enquiries SET contact_id=$2 WHERE id=$1',[subject,other.id])
    } else await pool.query('DELETE FROM association_enquiries WHERE id=$1',[subject])
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[memory.id])).rows[0].scope_held).toBe(true)
    await expect(derive(f,evidence.sources!)).rejects.toThrow('scope_source_changed')
    if(change==='reassign') {
      await pool.query('UPDATE association_enquiries SET contact_id=$2 WHERE id=$1',[subject,contact.id])
      await expect(derive(f,evidence.sources!)).rejects.toThrow('scope_source_changed')
    }
  })
  it('upgrades saved audiences without rewriting them or exposing the metadata reader',async()=>{
    const f=await fixture(),client=await pool.connect()
    const migration=(await readFile(new URL('../../../migrations/586_crm_event_derivation.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
    try {
      await client.query('BEGIN')
      const saved=(await client.query('SELECT scope_source FROM crm_domain_event_outbox WHERE id=$1',[f.eventId])).rows[0].scope_source
      await client.query('DROP TRIGGER zz_crm_event_scope_version ON crm_domain_event_outbox')
      for(const table of ['association_enquiries','association_memberships','association_registrations'])await client.query(`DROP TRIGGER crm_event_source_rebound ON ${table}`)
      await client.query('DROP FUNCTION advance_crm_event_scope_version(); DROP FUNCTION hold_rebound_crm_event_derivations()')
      await client.query('ALTER TABLE crm_domain_event_outbox DROP COLUMN scope_version')
      // Later suites can have created receipt kinds that did not exist at 585.
      // Remove only those edges inside this rolled-back historical fixture.
      await client.query("DELETE FROM scope_derivation_sources WHERE source_kind NOT IN('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event')")
      await client.query(migration)
      expect((await client.query('SELECT scope_source FROM crm_domain_event_outbox WHERE id=$1',[f.eventId])).rows[0].scope_source).toEqual(saved)
      expect((await client.query("SELECT read_scope_source($1,'crm_event',$2) AS source",[f.workspaceId,f.eventId])).rows[0].source).toMatchObject({resourceKind:'crm_event',compartments:[f.team.compartmentKey]})
      expect((await client.query("SELECT has_function_privilege('assurance_app','read_scope_source(uuid,text,uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
      expect((await client.query("SELECT scope_source_table('crm_event') AS editable")).rows[0].editable).toBeNull()
    } finally {await client.query('ROLLBACK');client.release()}
  })
  it('refuses unresolved aggregate inputs even while legacy admission remains enabled',async()=>{
    const f=await fixture(),eventId=randomUUID()
    await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,payload)
      VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal',$3,'import','{"batchCount":2}')`,[eventId,f.workspaceId,f.deal.id])
    f.input.event.domainEventId=eventId
    const run=await f.create()
    await expect(resolveWorkflowRunScope({userId:f.member,assistantId:f.assistantId,workspaceId:f.workspaceId,run})).rejects.toMatchObject({reason:'workflow_authority_unavailable'})
  })
})
