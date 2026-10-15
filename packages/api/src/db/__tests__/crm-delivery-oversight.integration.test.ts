/** Real native CRM service and non-bypass app-role authority. Fictional fixtures.
 * [COMP:api/crm-delivery-oversight]
 */
import express from 'express'
import request from 'supertest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { brainMcpRoutes } from '../../brain-mcp/server.js'
import { crmOperationsRoutes } from '../../routes/crm-operations.js'
import { createPendingApprovalsStore } from '../pending-approvals-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { buildTool, createCrmDeliveryOversightTools, processEpisode, type Tool, type LLMProvider, type PipelineBEpisode, type CrmOperationsContext, type DeliveryProposal } from '@use-brian/core'
import { getPool, getAppPool, queryWithRLS } from '../client.js'
import { createCrmDomainEventWorker, createDbCrmDomainEventOutboxStore } from '../../crm-operations/domain-event-worker.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmDeliveryReadStore } from '../crm-delivery-oversight-store.js'
import { createDbEpisodesStore } from '../episodes-store.js'
import { createDbCrmStore } from '../crm-store.js'
import { createDbEntitiesStore } from '../entities-store.js'
import { createDbEntityLinksStore } from '../entity-links-store.js'
import { createDbMemoryStore } from '../memory-store.js'
import { createExtractionApplicationStore } from '../extraction-application-store.js'
import { createIngestApplicationService } from '../../ingest/application-service.js'
import { createPipelineBApplicationMutationPort } from '../../ingest/pipeline-b-application-adapter.js'
import { briefFixture } from '../../briefs/__tests__/fixture.js'
import { createProgrammaticCaptureStore } from '../programmatic-capture-store.js'
import { createDbBrainKeyStore } from '../brain-keys-store.js'
import { withExternalKeyActor } from '../external-key-admission.js'
import { authSessionStore } from '../auth-session-store.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'
import { createFilesApi } from '../../files/files-api.js'
import { createEngineeringArchivePublisher } from '../../engineering-history/publisher.js'
import { createProgrammaticCaptureRouter } from '../../ingest/programmatic-capture.js'
import type { BrainAuth } from '../../brain-mcp/auth.js'
import { addSessionMessage, createWorkspaceChatSession } from '../sessions.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(), reads=createCrmDeliveryReadStore(), service=createCrmOperationsService(createDbCrmOperationsStore())
afterAll(async()=>{await getAppPool().end();await pool.end()})
async function fixture() {
 const f=await briefFixture(), userId=f.people.lead
 const chat=await createWorkspaceChatSession({assistantId:f.assistants.brian,starterUserId:userId,workspaceId:f.workspaceId,
  effectiveClearance:'internal',contextProjectId:f.projectId,authenticatedHuman:true})
 const companyId=randomUUID()
 await f.q(`INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,sensitivity,compartments,project_ids)
  VALUES($1,$2,'company','Fictional buyer',$3,'manual','internal',$4,$5)`,[companyId,f.workspaceId,userId,[`project:${f.projectId}`],[f.projectId]])
 const ctx=(id=userId):CrmOperationsContext=>({workspaceId:f.workspaceId,actor:{kind:'user',userId:id},authority:{role:id===userId?'admin':id===f.people.owner?'owner':'member',canWrite:true,canConfigure:false,trustedIdentitySources:[]}})
 const message=async(text='Agreed: deliver the accepted report on 2026-10-20.',options:{private?:boolean;role?:string;sender?:string}={})=>{
  const m=await addSessionMessage({sessionId:chat.id,role:options.role??'user',content:[{type:'text',text}],senderUserId:options.sender??userId,
   scope:{workspaceId:f.workspaceId,userId:options.private?userId:null,assistantId:f.assistants.brian,
    sensitivity:'internal',compartments:[`project:${f.projectId}`],projectIds:[f.projectId]}})
  const raw=(await pool.query<{snapshot:{version:string}}>("SELECT crm_delivery_source_snapshot($1,'session_message',$2) AS snapshot",[f.workspaceId,m.id])).rows[0]!.snapshot
  const proposal:DeliveryProposal={candidateKey:'accepted-report',source:{kind:'session_message',id:m.id,revision:raw.version,quote:text,start:0,end:text.length},
   outcome:'Deliver the accepted report',dueDate:'2026-10-20',companyId,dealId:null,taskIds:[],goalIds:[],basis:'explicit_agreement',agreeingUserId:userId}
  return {m,proposal}
 }
 const record=async(p:DeliveryProposal,operationId=randomUUID())=> service.execute(ctx(),{kind:'record_delivery_recognition',operationId,proposal:p})
 return {...f,userId,chat,companyId,ctx,message,record}
}
describe('[COMP:api/crm-delivery-oversight] real source authority and lifecycle barrier',()=>{
 it('CO01/CO02/CO07 records once without Task/Goal/terms/message side effects and binds receipts',async()=>{
  const f=await fixture(),p=await f.message(),op=randomUUID()
  const count=async()=> (await pool.query(`SELECT (SELECT count(*) FROM tasks WHERE workspace_id=$1)::int tasks,
   (SELECT count(*) FROM goals WHERE workspace_id=$1)::int goals,(SELECT count(*) FROM entities WHERE workspace_id=$1)::int entities,
   (SELECT count(*) FROM crm_engagement_extensions WHERE workspace_id=$1)::int terms,
   (SELECT count(*) FROM scheduled_jobs WHERE assistant_id IN(SELECT id FROM assistants WHERE workspace_id=$1))::int reminders,
   (SELECT count(*) FROM session_messages WHERE workspace_id=$1)::int messages`,[f.workspaceId])).rows[0]
  const before=await count(), saved=await f.record(p.proposal,op),replay=await f.record(p.proposal,op)
  expect(replay).toMatchObject({duplicate:true,record:saved.record})
  let dispatches=0
  await createCrmDomainEventWorker({store:createDbCrmDomainEventOutboxStore(),dispatcher:{dispatchStrict:async()=>{dispatches++}},workerId:'fictional-delivery-worker'}).tick()
  expect(dispatches).toBe(0)
  expect(await count()).toEqual(before)
  const detail=await reads.get({userId:f.userId},f.workspaceId,saved.record.id as string)
  expect(detail).toMatchObject({commitment:{recognitionState:'recognised',taskIds:[],dueDate:'2026-10-20'},assessment:{coverage:'unobserved',outcome:'unknown',issue:null,nextAction:null}})
  await expect(f.record({...p.proposal,outcome:'Different outcome'},op)).rejects.toMatchObject({code:'idempotency_conflict'})
  await expect(f.record({...p.proposal,outcome:'Different outcome'})).rejects.toMatchObject({code:'idempotency_conflict'})
  expect((await f.record(p.proposal)).record.id).toBe(saved.record.id)
  expect((await pool.query('SELECT count(*)::int n FROM crm_delivery_history WHERE commitment_id=$1',[saved.record.id])).rows[0].n).toBe(1)
  expect((await pool.query('SELECT event_type FROM crm_domain_event_outbox WHERE workspace_id=$1',[f.workspaceId])).rows.map(v=>v.event_type)).toEqual(['crm.delivery_projection.changed'])
 })
 it('CO02 assistant drafts, suggestions, spoofed actors and missing client identity stay review candidates',async()=>{
  const f=await fixture()
  for(const input of [{text:'Draft: Agreed to deliver a report.',options:{role:'assistant'}},{text:'Maybe deliver a report.',options:{}},{text:'Agreed to deliver a report.',options:{sender:f.people.member}}]) {
   const p=await f.message(input.text,input.options),saved=await f.record(p.proposal)
   expect((await reads.get({userId:f.userId},f.workspaceId,saved.record.id as string))!.commitment.recognitionState).toBe('needs_review')
  }
  const p=await f.message(),saved=await f.record({...p.proposal,companyId:null})
  expect((await reads.get({userId:f.userId},f.workspaceId,saved.record.id as string))!.commitment.recognitionState).toBe('needs_review')
  await expect(f.record({...p.proposal,source:{...p.proposal.source,quote:'Forged source text',end:18}})).rejects.toBeTruthy()
 })
 it('CO08 non-superuser RLS enforces Project/private/current source and shared audience before rows and counts',async()=>{
  const f=await fixture(),p=await f.message(),saved=await f.record(p.proposal),id=saved.record.id as string
  expect((await queryWithRLS(f.people.outsider,'SELECT count(*)::int n FROM crm_delivery_commitments WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
  expect(await reads.get({userId:f.people.outsider},f.workspaceId,id)).toBeNull()
  expect(await reads.get({userId:f.people.member,chatId:f.chat.id},f.workspaceId,id)).not.toBeNull()
  const secret=await f.message('Agreed to deliver a private outcome.',{private:true}),privateSaved=await f.record(secret.proposal)
  expect(await reads.get({userId:f.people.owner},f.workspaceId,privateSaved.record.id as string)).toBeNull()
  expect(await reads.get({userId:f.userId,chatId:f.chat.id},f.workspaceId,privateSaved.record.id as string)).toBeNull()
  await f.q('DELETE FROM project_shared_members WHERE project_id=$1 AND user_id=$2',[f.projectId,f.people.member])
  expect(await reads.get({userId:f.people.member},f.workspaceId,id)).toBeNull()
  await f.q('UPDATE session_messages SET scope_held=true WHERE id=$1',[p.m.id])
  expect(await reads.get({userId:f.userId},f.workspaceId,id)).toBeNull()
  expect((await queryWithRLS(f.userId,'SELECT count(*)::int n FROM crm_delivery_commitments WHERE id=$1',[id])).rows[0].n).toBe(0)
  await expect(f.record(p.proposal)).rejects.toMatchObject({code:'not_found'})
 })
 it('CO04/CO09 human updates remain reports; review/withdraw/replay preserve versions and original evidence',async()=>{
  const f=await fixture(),p=await f.message(),saved=await f.record(p.proposal),id=saved.record.id as string
  const update=await f.message('The accepted report is completed.')
  const op=randomUUID(),cmd={kind:'append_delivery_observation' as const,operationId:op,commitmentId:id,expectedVersion:1,
   observation:{source:update.proposal.source,kind:'human_report' as const,claim:'completed' as const,statement:update.proposal.source.quote,workId:null}}
  await service.execute(f.ctx(),cmd);expect((await service.execute(f.ctx(),cmd)).duplicate).toBe(true)
  const detail=(await reads.get({userId:f.userId},f.workspaceId,id))!
  expect(detail.assessment.outcome).toBe('reported_completion');expect(detail.observations[0].reporterUserId).toBe(f.userId)
  await expect(service.execute(f.ctx(),{...cmd,operationId:randomUUID(),expectedVersion:2,observation:{...cmd.observation,kind:'observed_fact',claim:'outcome_delivered'}})).rejects.toMatchObject({code:'invalid_input'})
  await expect(service.execute(f.ctx(),{kind:'review_delivery_recognition',operationId:randomUUID(),commitmentId:id,expectedVersion:1,decision:'dismiss',reason:'Existing evidence review'})).rejects.toMatchObject({code:'conflict'})
  await service.execute(f.ctx(),{kind:'withdraw_delivery_observation',operationId:randomUUID(),commitmentId:id,expectedVersion:2,observationId:detail.observations[0].id,reason:'Report withdrawn'})
  expect((await reads.get({userId:f.userId},f.workspaceId,id))!.assessment.outcome).toBe('unknown')
  await service.execute(f.ctx(),{kind:'review_delivery_recognition',operationId:randomUUID(),commitmentId:id,expectedVersion:3,decision:'correct',reason:'Clarify the existing interpretation',outcome:'Deliver agreed report'})
  expect((await reads.get({userId:f.userId},f.workspaceId,id))!.commitment).toMatchObject({outcome:'Deliver agreed report',version:4,source:p.proposal.source})
  await f.q('DELETE FROM session_messages WHERE id=$1',[p.m.id])
  expect(await reads.get({userId:f.userId},f.workspaceId,id)).toBeNull()
  expect((await pool.query('SELECT count(*)::int n FROM crm_delivery_history WHERE commitment_id=$1',[id])).rows[0].n).toBe(0)
 })
 it('CO08 Department and clearance floors survive current source and direct app-role reads',async()=>{
  const f=await fixture(),p=await f.message()
  await f.q('UPDATE session_messages SET compartments=$2 WHERE id=$1',[p.m.id,[`project:${f.projectId}`,`team:${f.finance}`]])
  const snapshot=(await pool.query<{snapshot:{version:string}}>("SELECT crm_delivery_source_snapshot($1,'session_message',$2) AS snapshot",[f.workspaceId,p.m.id])).rows[0].snapshot
  const proposal={...p.proposal,source:{...p.proposal.source,revision:snapshot.version}}
  const saved=await service.execute(f.ctx(f.people.financeLead),{kind:'record_delivery_recognition',operationId:randomUUID(),proposal})
  const id=saved.record.id as string
  expect(await reads.get({userId:f.userId},f.workspaceId,id)).toBeNull()
  expect(await reads.get({userId:f.people.owner},f.workspaceId,id)).toBeNull()
  expect(await reads.get({userId:f.people.financeLead},f.workspaceId,id)).not.toBeNull()
  await f.edge('user',f.people.member)
  expect(await reads.get({userId:f.people.member},f.workspaceId,id)).not.toBeNull()
  await f.q("UPDATE department_edges SET clearance='public' WHERE department_id=$1 AND user_id=$2",[f.finance,f.people.member])
  expect((await queryWithRLS(f.people.member,'SELECT count(*)::int n FROM crm_delivery_commitments WHERE id=$1',[id])).rows[0].n).toBe(0)
  await expect(service.execute(f.ctx(f.people.member),{kind:'review_delivery_recognition',operationId:randomUUID(),commitmentId:id,expectedVersion:1,decision:'dismiss',reason:'Existing evidence review'})).rejects.toMatchObject({code:'not_found'})
 })
 it('CO09 concurrent once-only recording and transaction failure do not leave partial projection/history',async()=>{
  const f=await fixture(),p=await f.message(),op=randomUUID()
  const saved=await Promise.all([f.record(p.proposal,op),f.record(p.proposal,op)])
  expect(saved[0].record.id).toBe(saved[1].record.id)
  const changed=await f.message('Agreed: deliver the second accepted report.')
  await pool.query(`CREATE FUNCTION delivery_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional audit failure'; END $$;
   CREATE TRIGGER delivery_test_failure BEFORE INSERT ON crm_delivery_history FOR EACH ROW EXECUTE FUNCTION delivery_test_failure()`)
  try {
   await expect(f.record(changed.proposal)).rejects.toThrow('fictional audit failure')
   expect((await pool.query('SELECT count(*)::int n FROM crm_delivery_commitments WHERE source_id=$1',[changed.m.id])).rows[0].n).toBe(0)
  } finally { await pool.query('DROP TRIGGER delivery_test_failure ON crm_delivery_history; DROP FUNCTION delivery_test_failure()') }
 })
 it('CO10 excludes engineering Episode inputs before projection even for an authorized reader',async()=>{
  const f=await fixture(),ep=randomUUID(),text='Agreed: deliver an outcome extracted from engineering history.'
  await f.q(`INSERT INTO episodes(id,workspace_id,source_kind,source_ref,content_ref,occurred_at,user_id,assistant_id,created_by_user_id,sensitivity,compartments,project_ids)
   VALUES($1,$2,'engineering_history','{}',$3::jsonb,now(),NULL,$4,$5,'internal',$6,$7)`,[ep,f.workspaceId,JSON.stringify({text}),f.assistants.brian,f.userId,[`project:${f.projectId}`],[f.projectId]])
  await expect(f.record({candidateKey:'archive',source:{kind:'episode',id:ep,revision:'1',quote:text,start:0,end:text.length},outcome:'History outcome',
   dueDate:null,companyId:f.companyId,dealId:null,taskIds:[],goalIds:[],basis:'explicit_agreement',agreeingUserId:f.userId})).rejects.toMatchObject({code:'not_found'})
  expect((await pool.query('SELECT count(*)::int n FROM crm_delivery_commitments WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
 })
 it('CO10 excludes operational descendants of a real admitted engineering archive without producing observations or advice',async()=>{
  const f=await fixture(),actor=f.people.owner
  await f.edge('user',actor)
  await f.q("UPDATE workspace_access_policies SET setup_state='ready',access_mode='simple',default_department_id=$2 WHERE workspace_id=$1",[f.workspaceId,f.finance])
  const authSession=(await authSessionStore.create(actor,{deviceLabel:'Fictional archive fixture',ipAddress:null,userAgent:null}))!
  const captureStore=createProgrammaticCaptureStore()
  const profile=await captureStore.createProfile({actingUserId:actor,authSessionId:authSession.id,workspaceId:f.workspaceId,name:'Fictional archive',processingMode:'archive_only',partitionBy:'session',enabled:true,
   destination:{kind:'department',departmentId:f.finance}})
  const rule=await captureStore.addRule({actingUserId:actor,authSessionId:authSession.id,workspaceId:f.workspaceId,profileId:profile.id,
   rule:{filterType:'role_match',filterParams:{values:['user','assistant']},routingMode:'realtime',scopeBindingMode:'explicit',compartments:[`team:${f.finance}`]}})
  const key=await withExternalKeyActor(actor,authSession.id,()=>createDbBrainKeyStore().create({workspaceId:f.workspaceId,actingUserId:actor,name:'Fictional capture key',scope:'read_write',maxClearance:'internal',contextGroupId:f.finance,
   contextProjectId:null,captureAssistantId:f.assistants.brian,captureProfileId:profile.id}))
  const auth:BrainAuth={workspaceId:f.workspaceId,keyId:key.id,scope:'read_write',maxClearance:'internal',authKind:'api_key',storeScope:'none',agentScope:'none',actingUserId:actor,captureAssistantId:f.assistants.brian,captureProfileId:profile.id}
  const blobs=new Map<string,Buffer>()
  const files=createFilesApi({store:createDbWorkspaceFilesStore(),bucket:'fictional-fixture',auditStore:{append:async()=>{}} as never,
   gcs:{writeBlob:async(k:string,b:Buffer)=>{blobs.set(k,b)},readBlob:async(k:string)=>blobs.has(k)?{bytes:blobs.get(k)!}:null,deleteBlob:async(k:string)=>{blobs.delete(k)}} as never})
  const archive=createEngineeringArchivePublisher(files)
  const ingest=()=>{throw new Error('No live operational ingest')}
  const capture=createProgrammaticCaptureRouter({store:captureStore,ingest:ingest as never,archive:archive.capture})
  const text='Agreed: deliver an outcome from engineering history.'
  const receipt=await capture(auth,{eventId:randomUUID(),content:text,sessionId:'fictional-archive-session',role:'user',metadata:{provider:'codex'}})
  expect(receipt.deliveryStatus).toBe('archived');expect(receipt.fileId).toBeTruthy()
  expect((await pool.query('SELECT engineering_archive_source_current($1) AS current',[receipt.archiveId])).rows[0].current).toBe(true)
  const descendant=await createDbEpisodesStore().createEpisode(actor,{workspaceId:f.workspaceId,sourceKind:'manual_paste',sourceRef:{},contentRef:{text,fileId:receipt.fileId},occurredAt:new Date('2026-10-15T00:00:00Z'),
   userId:null,assistantId:f.assistants.brian,createdByUserId:actor,createdByAssistantId:null,sensitivity:'internal',compartments:[`team:${f.finance}`],projectIds:[]})
  const ep=descendant.id
  await expect(service.execute(f.ctx(actor),{kind:'record_delivery_recognition',operationId:randomUUID(),proposal:{candidateKey:'archive-descendant',source:{kind:'episode',id:ep,revision:'1',quote:text,start:0,end:text.length},
   outcome:'History outcome',dueDate:null,companyId:null,dealId:null,taskIds:[],goalIds:[],basis:'explicit_agreement',agreeingUserId:actor}})).rejects.toMatchObject({code:'not_found'})
  expect((await pool.query('SELECT count(*)::int n FROM crm_delivery_commitments WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM crm_delivery_observations WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
 })
 it('CO06/CO07/CO09/CO12 real source processing freezes and applies recognition once without model replay or new work',async()=>{
  const f=await fixture(),text='Agreed: deliver the accepted report on 2026-10-20.'
  const episodes=createDbEpisodesStore(),links=createDbEntityLinksStore()
  const source=await episodes.createEpisode(f.userId,{workspaceId:f.workspaceId,sourceKind:'manual_paste',sourceRef:{},contentRef:{text},occurredAt:new Date('2026-10-15T00:00:00Z'),
   userId:null,assistantId:f.assistants.brian,createdByUserId:f.userId,createdByAssistantId:null,sensitivity:'internal',compartments:[`project:${f.projectId}`],projectIds:[f.projectId]})
  let calls=0
  const provider={name:'fixture',models:['fixture'],createSession(){throw new Error('No sessions')},async *stream(){calls++;
   yield {type:'text_delta',text:JSON.stringify({summary:'Existing agreement',delivery_commitments:[{candidateKey:'source-report',quote:text,outcome:'Deliver agreed report',
    dueDate:'2026-10-20',companyId:f.companyId,dealId:null,agreeingUserId:f.userId,basis:'explicit_agreement',taskIds:[],goalIds:[]}],entities:[],edges:[],tasks:[],memories:[],ephemeral:[],tags:[]})};
   yield {type:'message_end',stopReason:'end_turn',usage:{inputTokens:10,outputTokens:10}}
  }} as LLMProvider
  const store=createExtractionApplicationStore()
  const application=createIngestApplicationService({store,episodes,mutateCandidate:createPipelineBApplicationMutationPort(),getWorkspaceRole:async()=> 'admin'})
  const result=await processEpisode({...source,sensitivity:'internal'} as PipelineBEpisode,text,{provider,model:'fixture',classifierModel:null,episodes,
   crm:createDbCrmStore(),entities:createDbEntitiesStore({entityLinks:links}),entityLinks:links,memories:createDbMemoryStore(),application})
  expect(result.applicationState).toBe('complete');expect(calls).toBe(1)
  const row=(await pool.query('SELECT id,recognition_state FROM crm_delivery_commitments WHERE source_id=$1',[source.id])).rows[0]
  expect(row.recognition_state).toBe('needs_review') // native importer is not the agreeing speaker
  const frozen=(await pool.query('SELECT frozen_plan,attempt_key FROM episode_extraction_runs WHERE episode_id=$1',[source.id])).rows[0]
  await application.apply({workspaceId:f.workspaceId,actorUserId:f.userId,mutationCompartments:[`project:${f.projectId}`],projectIds:[f.projectId],attemptKey:frozen.attempt_key,plan:frozen.frozen_plan})
  expect(calls).toBe(1)
  expect((await pool.query('SELECT count(*)::int n FROM crm_delivery_commitments WHERE source_id=$1',[source.id])).rows[0].n).toBe(1)
  expect((await pool.query('SELECT count(*)::int n FROM tasks WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM goals WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
 })
 it('CO08 read-only/foreign actor and assistant missing turn authority cannot mutate',async()=>{
  const f=await fixture(),p=await f.message()
  await expect(service.execute({...f.ctx(),authority:{...f.ctx().authority,canWrite:false}},{kind:'record_delivery_recognition',operationId:randomUUID(),proposal:p.proposal})).rejects.toMatchObject({code:'not_authorized'})
  await expect(service.execute(f.ctx(f.people.outsider),{kind:'record_delivery_recognition',operationId:randomUUID(),proposal:p.proposal})).rejects.toMatchObject({code:'not_found'})
  await expect(service.execute({...f.ctx(),actor:{kind:'assistant',assistantId:f.assistants.brian,userId:f.userId,sessionId:f.chat.id}},{kind:'record_delivery_recognition',operationId:randomUUID(),proposal:p.proposal})).rejects.toMatchObject({code:'not_authorized'})
 })
})


describe('[COMP:api/crm-delivery-oversight] shared HTTP, attended tool and MCP parity',()=>{
 it('CO01/CO03/CO04/CO05 preserves native work and bounded reported issues without treating closure as delivery',async()=>{
  const f=await fixture(),p=await f.message(),task=randomUUID()
  await f.q(`INSERT INTO tasks(id,workspace_id,title,status,created_by_user_id,executor_assistant_id,sensitivity,compartments,project_ids)
    VALUES($1,$2,'Fictional report preparation','done',$3,$4,'internal',$5,$6)`,[task,f.workspaceId,f.userId,f.assistants.brian,[`project:${f.projectId}`],[f.projectId]])
  const saved=await f.record({...p.proposal,taskIds:[task]}),id=saved.record.id as string
  const before=(await reads.get({userId:f.userId},f.workspaceId,id))!
  expect(before.linkedWork).toMatchObject([{id:task,status:'done',executorLabel:'Brian'}]);expect(before.assessment).toMatchObject({coverage:'unobserved',outcome:'unknown',issue:null,nextAction:null})
  const update=await f.message('The accepted report is blocked pending the agreed input.')
  await service.execute(f.ctx(),{kind:'append_delivery_observation',operationId:randomUUID(),commitmentId:id,expectedVersion:1,
    observation:{source:update.proposal.source,kind:'human_report',claim:'blocker',statement:update.proposal.source.quote,workId:task}})
  const after=(await reads.get({userId:f.userId},f.workspaceId,id))!
  expect(after.assessment).toMatchObject({coverage:'reported',outcome:'unknown',issue:{kind:'blocker'},nextAction:{workId:task}})
  expect(after.observations[0]).toMatchObject({reporterUserId:f.userId,reporterName:'Fictional person',sourceNavigation:{type:'conversation',id:f.chat.id}})
  expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[task])).rows[0].status).toBe('done')
  await f.q('UPDATE session_messages SET scope_held=true WHERE id=$1',[update.m.id])
  expect((await reads.get({userId:f.userId},f.workspaceId,id))!.assessment).toMatchObject({coverage:'unobserved',issue:null,nextAction:null})
 })
 it('CO06/CO08 lists at most 50 admitted records and 20 evidence references with honest cursors',async()=>{
  const f=await fixture();let first=''
  for(let i=0;i<51;i++){const p=await f.message(`Agreed: deliver fictional report ${i}.`);const r=await f.record(p.proposal);if(i===0)first=r.record.id as string}
  const query={scope:'project' as const,scopeId:f.projectId,limit:50}
  const page=await reads.list({userId:f.userId},f.workspaceId,query)
  expect(page.commitments).toHaveLength(50);expect(page.nextCursor).toBeTruthy()
  expect((await reads.list({userId:f.userId},f.workspaceId,{...query,cursor:page.nextCursor!})).commitments).toHaveLength(1)
  expect((await reads.list({userId:f.people.outsider},f.workspaceId,query))).toEqual({commitments:[],nextCursor:null})
  for(let i=0;i<21;i++){const p=await f.message(`Fictional work update ${i}.`);await service.execute(f.ctx(),{kind:'append_delivery_observation',operationId:randomUUID(),commitmentId:first,expectedVersion:i+1,
   observation:{source:p.proposal.source,kind:'human_report',claim:'unknown',statement:p.proposal.source.quote,workId:null}})}
  const detail=(await reads.get({userId:f.userId},f.workspaceId,first))!
  expect(detail.observations).toHaveLength(20);expect(detail.evidenceCursor).toBeTruthy();expect(detail.assessment.partial).toBe(true)
  expect(detail.assessment.issue).toBeNull();expect(detail.assessment.nextAction).toBeNull()
 })
 it('CO02/CO08 governed acceptance retains the accepted request audience as well as the native deal',async()=>{
  const f=await fixture(),deal=randomUUID()
  await f.q(`INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,sensitivity,compartments,project_ids)
   VALUES($1,$2,'deal','Fictional report engagement',$3,'manual','internal',$4,$5)`,[deal,f.workspaceId,f.userId,[`project:${f.projectId}`],[f.projectId]])
  const draft=(await service.execute(f.ctx(),{kind:'save_change_request',operationId:randomUUID(),target:{kind:'deal',id:deal},changes:{name:'Deliver the accepted report',assignReferences:[]}})).record.request as {id:string;version:number}
  await service.execute(f.ctx(),{kind:'submit_change_request',operationId:randomUUID(),requestId:draft.id,expectedVersion:draft.version})
  // Native request privacy can be tighter than the target engagement.
  await f.q('UPDATE crm_change_requests SET user_id=$2 WHERE id=$1',[draft.id,f.userId])
  const snapshot=(await pool.query("SELECT crm_delivery_source_snapshot($1,'entity',$2) AS s",[f.workspaceId,deal])).rows[0].s
  const saved=await f.record({candidateKey:'accepted-native-terms',source:{kind:'entity',id:deal,revision:snapshot.version,quote:snapshot.text,start:0,end:snapshot.text.length},outcome:'Deliver the accepted report',dueDate:null,companyId:f.companyId,dealId:deal,taskIds:[],goalIds:[],basis:'accepted_terms',agreeingUserId:f.userId})
  expect((await reads.get({userId:f.userId},f.workspaceId,saved.record.id as string))!.commitment.recognitionState).toBe('recognised')
  expect(await reads.get({userId:f.people.member},f.workspaceId,saved.record.id as string)).toBeNull()
  expect(await reads.get({userId:f.userId,chatId:f.chat.id},f.workspaceId,saved.record.id as string)).toBeNull()
 })
 it('CO02/CO09/CO12 exact persisted attended approval permits human interpretation and rejects changed arguments',async()=>{
  const f=await fixture(),p=await f.message('Maybe deliver the accepted report.'),saved=await f.record(p.proposal),id=saved.record.id as string
  const input={operationId:randomUUID(),commitmentId:id,expectedVersion:1,decision:'recognise',reason:'Interpret the existing exact agreement evidence'}
  const tools=createCrmDeliveryOversightTools({reads,service}),approvals=createPendingApprovalsStore()
  const approval=await approvals.createToolInvocation({workspaceId:f.workspaceId,blockingSessionId:f.chat.id,originatingAssistantId:f.assistants.brian,approverUserId:f.userId,
   toolName:'reviewCrmDeliveryRecognition',arguments:input,approvalPayload:{allowPersistentApproval:false,displayLines:[p.proposal.source.quote]},deliveryChannelType:'web',expiresAt:new Date(Date.now()+60_000)})
  const ctx={workspaceId:f.workspaceId,userId:f.userId,assistantId:f.assistants.brian,sessionId:f.chat.id,activeCapabilities:new Set(['crm','home_app:crm:read','home_app:crm:write'])} as never
  const access={workspaceId:f.workspaceId,userId:f.userId,clearance:'internal',compartments:[`project:${f.projectId}`],mutationCompartments:[`project:${f.projectId}`],projectIds:[f.projectId],visibilityAssistantIds:[f.assistants.brian]}
  const run=(args:Record<string,unknown>,proof?:object)=>runWithAgentAccess(access,()=>tools.reviewCrmDeliveryRecognition.execute(args,{...ctx as object,...(proof?{approvedToolInvocation:proof}:{})} as never))
  expect(await run(input)).toMatchObject({isError:true,data:{error:'not_authorized'}})
  await approvals.respond(approval.id,'approved',f.userId)
  const proof={approvalId:approval.id,approverUserId:f.userId,toolName:'reviewCrmDeliveryRecognition'}
  expect(await run({...input,reason:'Changed after approval'},proof)).toMatchObject({isError:true,data:{error:'not_authorized'}})
  const approvedResult=await run(input,proof);expect(approvedResult,JSON.stringify(approvedResult)).not.toHaveProperty('isError',true)
  expect((await reads.get({userId:f.userId},f.workspaceId,id))!.commitment).toMatchObject({recognitionState:'recognised',version:2})
  expect((await pool.query("SELECT actor_kind,actor_id FROM crm_delivery_history WHERE commitment_id=$1 AND action='recognise'",[id])).rows).toEqual([{actor_kind:'user',actor_id:f.userId}])
  expect(await run(input,proof)).toMatchObject({data:{duplicate:true}})
 })
 it('CO08/CO09/CO12 real HTTP and authenticated MCP share source authority, strict schemas, receipts and key revocation',async()=>{
  const f=await fixture(),p=await f.message(),deliveryTools=createCrmDeliveryOversightTools({reads,service})
  await f.edge('user',f.userId)
  await f.q("INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id) SELECT $1,unnest(ARRAY['crm','home_app:crm:read','home_app:crm:write']),$2::uuid ON CONFLICT DO NOTHING",[f.assistants.brian,f.userId])
  const key=await withExternalKeyActor(f.userId,undefined,()=>createDbBrainKeyStore().create({workspaceId:f.workspaceId,actingUserId:f.userId,name:'Fictional delivery key',scope:'read_write',maxClearance:'internal',contextGroupId:f.finance,contextProjectId:f.projectId}))
  const tools=new Proxy(deliveryTools as Record<string,Tool>,{get(target,name){return target[name as string]??buildTool({name:String(name),description:'Unused fixture boundary',inputSchema:z.object({id:z.string().optional()}),execute:async()=>{throw new Error('Unrelated tool must not run')}})}})
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=req.get('x-test-user')??undefined;next()})
  app.use('/api/crm',crmOperationsRoutes({service,deliveryReads:reads,readStore:{} as never,workspaceStore:{getRole:async(u:string,w:string)=>(await pool.query('SELECT role FROM workspace_members WHERE user_id=$1 AND workspace_id=$2',[u,w])).rows[0]?.role??null} as never}))
  app.use('/api/brain/mcp',brainMcpRoutes({brainKeyStore:createDbBrainKeyStore(),memoryTools:tools as never,taskTools:tools as never,crmTools:tools as never,retrievalTools:tools as never}))
  const server=await new Promise<import('node:http').Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))}),address=server.address() as import('node:net').AddressInfo
  const mcp=new Client({name:'fictional-delivery-fixture',version:'1'})
  try {
   await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/api/brain/mcp`),{requestInit:{headers:{Authorization:`Bearer ${key.plaintext}`}}}))
   const names=(await mcp.listTools()).tools.map(t=>t.name);expect(names).toContain('listCrmDeliveryCommitments');expect(names).toContain('recordCrmDeliveryRecognition')
   const args={operationId:randomUUID(),proposal:p.proposal},created=await mcp.callTool({name:'recordCrmDeliveryRecognition',arguments:args})
   expect(created.isError,JSON.stringify(created)).not.toBe(true)
   const decode=(result:any)=>JSON.parse(result.content[0].text)
   const data=decode(created) as {record:{id:string}},id=data.record.id
   const base=`/api/crm/${f.workspaceId}/operations/delivery-commitments`
   const http=await request(app).get(`${base}/${id}`).set('x-test-user',f.userId)
   expect(http.status,JSON.stringify(http.body)).toBe(200);expect(http.headers['cache-control']).toBe('no-store');expect(http.body.commitment.id).toBe(id)
   expect(decode(await mcp.callTool({name:'getCrmDeliveryAssessment',arguments:{commitmentId:id}}))).toMatchObject({commitment:{id}})
   expect(decode(await mcp.callTool({name:'recordCrmDeliveryRecognition',arguments:args}))).toMatchObject({duplicate:true,record:{id}})
   expect((await request(app).get(base).query({scope:'project',scopeId:f.projectId,limit:51}).set('x-test-user',f.userId)).status).toBe(400)
   expect((await request(app).get(`${base}/${id}`).set('x-test-user',f.people.outsider)).status).toBe(404)
   const review={kind:'review_delivery_recognition',operationId:randomUUID(),commitmentId:id,expectedVersion:1,decision:'correct',reason:'Correct exact admitted interpretation',outcome:'Deliver the existing report'}
   expect((await request(app).post(`/api/crm/${f.workspaceId}/operations/commands`).set('x-test-user',f.userId).send(review)).status).toBe(200)
   expect(await mcp.callTool({name:'reviewCrmDeliveryRecognition',arguments:{operationId:randomUUID(),commitmentId:id,expectedVersion:2,decision:'dismiss',reason:'Machine cannot human-review'}})).toMatchObject({isError:true})
   const refreshed=await mcp.callTool({name:'refreshCrmDeliveryAssessment',arguments:{operationId:randomUUID(),commitmentId:id,expectedVersion:2}})
   expect(refreshed.isError,JSON.stringify(refreshed)).not.toBe(true)
   await f.q('UPDATE session_messages SET scope_held=true WHERE id=$1',[p.m.id])
   expect((await request(app).get(`${base}/${id}`).set('x-test-user',f.userId)).status).toBe(404)
   expect(await mcp.callTool({name:'getCrmDeliveryAssessment',arguments:{commitmentId:id}})).toMatchObject({isError:true})
   expect(await mcp.callTool({name:'recordCrmDeliveryRecognition',arguments:args})).toMatchObject({isError:true})
   await f.q("UPDATE brain_keys SET status='revoked' WHERE id=$1",[key.id])
   await expect(mcp.callTool({name:'listCrmDeliveryCommitments',arguments:{scope:'project',scopeId:f.projectId,limit:50}})).rejects.toThrow()
  } finally {await mcp.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}
 })
})


describe('[COMP:api/crm-delivery-oversight] native outcome and source revision',()=>{
 it('CO04 admitted outcome receipt supports delivery, parent File revocation removes that claim',async()=>{
  const f=await fixture(),p=await f.message(),saved=await f.record(p.proposal),id=saved.record.id as string,file=randomUUID(),text='Acceptance receipt: the accepted report was delivered.'
  await f.q(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,sensitivity,compartments,project_ids)
   VALUES($1,$2,$3,'Fictional outcome receipt','fixture://receipt',$4,'internal',$5,$6)`,[file,f.workspaceId,`/${file}.txt`,f.userId,[`project:${f.projectId}`],[f.projectId]])
  const segment=(await f.q(`INSERT INTO file_segments(workspace_id,file_id,segment_index,char_start,char_end,content,created_by_user_id,sensitivity,compartments,project_ids)
   VALUES($1,$2,0,0,$3,$4,$5,'internal',$6,$7) RETURNING id`,[f.workspaceId,file,text.length,text,f.userId,[`project:${f.projectId}`],[f.projectId]])).rows[0].id
  const source=(await f.q("SELECT crm_delivery_source_snapshot($1,'file_segment',$2) AS s",[f.workspaceId,segment])).rows[0].s
  await service.execute(f.ctx(),{kind:'append_delivery_observation',operationId:randomUUID(),commitmentId:id,expectedVersion:1,
   observation:{source:{kind:'file_segment',id:segment,revision:source.version,quote:text,start:0,end:text.length},kind:'observed_fact',claim:'outcome_delivered',statement:text,workId:null}})
  expect((await reads.get({userId:f.userId},f.workspaceId,id))!.assessment.outcome).toBe('verified_delivery')
  await f.q('UPDATE workspace_files SET scope_held=true WHERE id=$1',[file])
  expect((await reads.get({userId:f.userId},f.workspaceId,id))!.assessment.outcome).toBe('unknown')
 })
 it('CO09 changed native text invalidates old content and supersedes it once under the new revision',async()=>{
  const f=await fixture(),p=await f.message(),saved=await f.record(p.proposal),text='Agreed: deliver the amended accepted report.'
  await f.q('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',[p.m.id,JSON.stringify([{type:'text',text}])])
  expect(await reads.get({userId:f.userId},f.workspaceId,saved.record.id as string)).toBeNull()
  const source=(await f.q("SELECT crm_delivery_source_snapshot($1,'session_message',$2) AS s",[f.workspaceId,p.m.id])).rows[0].s
  expect(source.version).not.toBe(p.proposal.source.revision)
  const next=await f.record({...p.proposal,source:{...p.proposal.source,revision:source.version,quote:text,end:text.length},outcome:'Deliver the amended report'})
  expect(next.record.id).not.toBe(saved.record.id)
  expect((await reads.list({userId:f.userId},f.workspaceId,{scope:'project',scopeId:f.projectId,limit:50})).commitments.map(c=>c.id)).toEqual([next.record.id])
  expect((await f.q('SELECT recognition_state FROM crm_delivery_commitments WHERE id=$1',[saved.record.id])).rows[0].recognition_state).toBe('superseded')
  expect((await f.q('SELECT action FROM crm_delivery_history WHERE commitment_id=$1 ORDER BY version',[saved.record.id])).rows.map(r=>r.action)).toEqual(['recorded','superseded'])
 })
})
