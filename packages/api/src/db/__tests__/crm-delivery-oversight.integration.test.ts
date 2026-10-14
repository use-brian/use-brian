/** Real native CRM service and non-bypass app-role authority. Fictional fixtures.
 * [COMP:api/crm-delivery-oversight]
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { type CrmOperationsContext, type DeliveryProposal } from '@use-brian/core'
import { getPool, getAppPool, queryWithRLS } from '../client.js'
import { createCrmDomainEventWorker, createDbCrmDomainEventOutboxStore } from '../../crm-operations/domain-event-worker.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmDeliveryReadStore } from '../crm-delivery-oversight-store.js'
import { briefFixture } from '../../briefs/__tests__/fixture.js'
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
   observation:{source:update.proposal.source,kind:'human_report' as const,claim:'completed' as const,statement:'Completed according to the author',workId:null}}
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
 it('CO08 read-only/foreign actor and assistant missing turn authority cannot mutate',async()=>{
  const f=await fixture(),p=await f.message()
  await expect(service.execute({...f.ctx(),authority:{...f.ctx().authority,canWrite:false}},{kind:'record_delivery_recognition',operationId:randomUUID(),proposal:p.proposal})).rejects.toMatchObject({code:'not_authorized'})
  await expect(service.execute(f.ctx(f.people.outsider),{kind:'record_delivery_recognition',operationId:randomUUID(),proposal:p.proposal})).rejects.toMatchObject({code:'not_found'})
  await expect(service.execute({...f.ctx(),actor:{kind:'assistant',assistantId:f.assistants.brian,userId:f.userId,sessionId:f.chat.id}},{kind:'record_delivery_recognition',operationId:randomUUID(),proposal:p.proposal})).rejects.toMatchObject({code:'not_authorized'})
 })
})
