import {z} from 'zod'
import {buildTool,workspaceFilesCtxFor} from '@use-brian/core'
import {brainMcpRoutes} from '../../brain-mcp/server.js'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import express from 'express'
import request from 'supertest'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {createWorkspaceStore} from '../workspace-store.js'
import {engineeringHistoryRoutes} from '../../routes/engineering-history.js'
import {createEngineeringHistoryService} from '../../engineering-history/service.js'
import {createCaptureConfigurationReader} from '../../engineering-history/configuration.js'
import { randomUUID } from 'node:crypto'
import { afterAll,describe,it,expect,vi } from 'vitest'
import { getPool,getAppPool,queryWithRLS } from '../client.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'
import { createFilesApi } from '../../files/files-api.js'
import { createEngineeringArchivePublisher } from '../../engineering-history/publisher.js'
import { createProgrammaticCaptureRouter } from '../../ingest/programmatic-capture.js'
import { createProgrammaticCaptureStore } from '../programmatic-capture-store.js'
import { createDbProgrammaticBatchStore } from '../pending-ingest-batches-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createDbBrainKeyStore } from '../brain-keys-store.js'
import { withExternalKeyActor } from '../external-key-admission.js'
import { enqueueFileIngestJob } from '../file-ingest-jobs-store.js'
import type { BrainAuth } from '../../brain-mcp/auth.js'
import type { FilesContext } from '@use-brian/core'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
afterAll(async()=>{await getAppPool().end();await pool.end()})
async function fixture(ready=false){
 const workspaceId=randomUUID(),userId=randomUUID(),memberId=randomUUID(),assistantId=randomUUID();let keyId:string=randomUUID()
 for(const id of [userId,memberId])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Engineering fixture',$2,true)",[workspaceId,userId])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
 const team=await createDbWorkspaceGroupStore().createTeam(userId,workspaceId,{name:'Engineering',key:'engineering'})
 await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance,default_compartments) VALUES($1,$2,$3,'Capture','primary','internal',$4)",[assistantId,workspaceId,userId,[team.compartmentKey]])
 const session=ready?(await pool.query("INSERT INTO auth_sessions(user_id,auth_version,device_label) VALUES($1,0,'Fixture') RETURNING id",[userId])).rows[0].id:undefined
 if(ready)await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='simple',default_department_id=$2 WHERE workspace_id=$1",[workspaceId,team.id])
 const store=createProgrammaticCaptureStore()
 const profile=await store.createProfile({actingUserId:userId,authSessionId:session,workspaceId,name:'Engineering',processingMode:'archive_only',partitionBy:'session',enabled:true,...(ready?{destination:{kind:'department' as const,departmentId:team.id}}:{})})
 const rule=await store.addRule({actingUserId:userId,authSessionId:session,workspaceId,profileId:profile.id,rule:{filterType:'role_match',filterParams:{values:['user','assistant']},routingMode:'realtime',scopeBindingMode:'explicit',compartments:[team.compartmentKey!]}})
 const issued=await withExternalKeyActor(userId,session,()=>createDbBrainKeyStore().create({workspaceId,actingUserId:userId,name:'Fixture',scope:'read_write',maxClearance:'internal',contextGroupId:ready?team.id:null,contextProjectId:null,captureAssistantId:assistantId,captureProfileId:profile.id}))
 keyId=issued.id

 const auth:BrainAuth={workspaceId,keyId,scope:'read_write',maxClearance:'internal',authKind:'api_key',storeScope:'none',agentScope:'none',actingUserId:userId,captureAssistantId:assistantId,captureProfileId:profile.id}
 const ctx:FilesContext={workspaceId,userId,assistantId,assistantKind:'primary',clearance:'confidential'}
 const blobs=new Map<string,Buffer>(),audit=vi.fn(),ingest=vi.fn()
 let io=async()=>{},fail=false,lostAck=false
 const fileStore=createDbWorkspaceFilesStore(),nativeCreate=fileStore.create.bind(fileStore)
 fileStore.create=async(...args)=>{const file=await nativeCreate(...args);if(lostAck){lostAck=false;throw new Error('lost commit acknowledgement')}return file}
 const api=createFilesApi({store:fileStore,gcs:{writeBlob:async(k:string,b:Buffer)=>{if(fail)throw new Error('storage unavailable');blobs.set(k,b);await io()},readBlob:async(k:string)=>blobs.has(k)?{bytes:blobs.get(k)!}:null,deleteBlob:async(k:string)=>{blobs.delete(k)}} as never,bucket:'fixture',auditStore:{append:audit} as never})
 const publisher=createEngineeringArchivePublisher(api),route=createProgrammaticCaptureRouter({store,ingest,archive:publisher.capture})
 const send=(eventId=randomUUID(),content='  original\n工程 ☃\n\t')=>route(auth,{eventId,content,sessionId:'fictional-session',role:'user',metadata:{provider:'codex'}})
 return {workspaceId,userId,memberId,keyId,plaintext:issued.plaintext,profile,rule:rule!,auth,ctx,store,api,blobs,ingest,publisher,route,send,team,
  uncertainCommit(){lostAck=true},during(fn:()=>Promise<void>){io=fn},failStorage(){fail=true},workingStorage(){fail=false}}
}
describe('[COMP:api/engineering-history] native publication and identity',()=>{
 it('EH01/EH02/EH05 publishes exact original once with stable native receipt and no extraction',async()=>{
  const f=await fixture(),eventId=randomUUID(),content='  original\n工程 ☃\n\t'
  const [a,b]=await Promise.all([f.send(eventId,content),f.send(eventId,content)])
  expect([a.outcome,b.outcome]).toContain('archived');expect(a.archiveId).toBe(b.archiveId)
  const ready=await f.send(eventId,content)
  expect(ready).toMatchObject({outcome:'duplicate',deliveryStatus:'archived',indexStatus:'ready'})
  const bytes=await f.api.readBytes(f.ctx,ready.fileId!)
  expect(bytes.ok).toBe(true);if(!bytes.ok)throw new Error('bytes unavailable')
  expect(JSON.parse(bytes.value.bytes.toString()).content).toBe(content)
  expect(f.ingest).not.toHaveBeenCalled()
  expect((await pool.query('SELECT id FROM workspace_files WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1)
  await expect(f.send(eventId,'changed')).rejects.toThrow('capture_event_conflict')
  await f.send(randomUUID(),content)
  expect((await pool.query('SELECT id FROM workspace_files WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(2)
  expect((await queryWithRLS(f.userId,'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toMatchObject({rolsuper:false,rolbypassrls:false})
 })
 it('EH04/EH08 rejects publication-time key revocation without completed receipt',async()=>{
  const f=await fixture()
  f.during(async()=>{await pool.query("UPDATE brain_keys SET status='revoked' WHERE id=$1",[f.keyId])})
  await expect(f.send()).rejects.toThrow()
  expect((await pool.query('SELECT id FROM workspace_files WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  expect((await pool.query('SELECT status FROM programmatic_capture_receipts WHERE workspace_id=$1',[f.workspaceId])).rows[0].status).toBe('queued')
  expect(f.ingest).not.toHaveBeenCalled()
 })
 it('EH08 retains pending original across blob failure and reconciles one File on replay',async()=>{
  const f=await fixture(),id=randomUUID();f.failStorage()
  await expect(f.send(id)).rejects.toThrow()
  expect((await pool.query('SELECT events FROM pending_ingest_batches WHERE workspace_id=$1',[f.workspaceId])).rows[0].events[0].content).toContain('工程')
  f.workingStorage();await pool.query('UPDATE pending_ingest_batches SET archive_claim_until=NULL,purpose_held=false WHERE workspace_id=$1',[f.workspaceId])
  await f.publisher.drain((await pool.query('SELECT id FROM pending_ingest_batches WHERE workspace_id=$1',[f.workspaceId])).rows[0].id)
  expect((await f.send(id)).deliveryStatus).toBe('archived')
  expect(f.blobs.size).toBe(1)
 })
 it('EH05/EH08 lost commit acknowledgement reconciles the existing canonical original and receipt',async()=>{
  const f=await fixture(),id=randomUUID();f.uncertainCommit()
  await expect(f.send(id)).rejects.toThrow('could not be confirmed')
  const retry=await f.send(id),history=createEngineeringHistoryService({files:f.api,cursorSecret:'fixture-cursor-secret'})
  expect(retry).toMatchObject({deliveryStatus:'archived',outcome:'duplicate'})
  expect((await history.read(f.ctx,retry.archiveId!)).content).toBe('  original\n工程 ☃\n\t')
  expect(f.blobs.size).toBe(1);expect((await pool.query('SELECT id FROM workspace_files WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1);expect(f.ingest).not.toHaveBeenCalled()
 })
 it.each(['programmatic_archive_events','programmatic_capture_receipts'])('EH08 %s publication fault rolls back File/projection/receipt atomically and retains WIP',async table=>{
  const f=await fixture(),id=randomUUID(),fn='fixture_archive_publication_fault',trigger='fixture_archive_fault'
  const condition=table==='programmatic_archive_events'?`NEW.workspace_id='${f.workspaceId}'::uuid`:`NEW.workspace_id='${f.workspaceId}'::uuid AND NEW.status='completed'`
  await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'fixture_publication_fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
  try{await expect(f.send(id)).rejects.toThrow();expect((await pool.query('SELECT id FROM workspace_files WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([]);expect((await pool.query('SELECT status FROM programmatic_capture_receipts WHERE workspace_id=$1',[f.workspaceId])).rows[0].status).toBe('queued');expect((await pool.query('SELECT events FROM pending_ingest_batches WHERE workspace_id=$1',[f.workspaceId])).rows[0].events[0].content).toContain('工程')}
  finally{await pool.query(`DROP TRIGGER ${trigger} ON ${table}; DROP FUNCTION ${fn}()`)}
  await f.publisher.drain((await pool.query('SELECT id FROM pending_ingest_batches WHERE workspace_id=$1',[f.workspaceId])).rows[0].id)
  const result=await f.send(id);expect(result.deliveryStatus).toBe('archived');expect(f.blobs.size).toBe(1);expect(f.ingest).not.toHaveBeenCalled()
 })
 it('EH07 old extraction SQL cannot claim archives and profile edits hold pending purpose',async()=>{
  const f=await fixture()
  await f.store.updateRule({actingUserId:f.userId,workspaceId:f.workspaceId,profileId:f.profile.id,ruleId:f.rule.id,
   rule:{filterType:'role_match',filterParams:{values:['user','assistant']},routingMode:'scheduled',routingSchedule:'0 0 * * *',scopeBindingMode:'explicit',compartments:f.rule.compartments}})
  expect((await f.send()).outcome).toBe('queued')
  const claims=(await pool.query("SELECT id FROM pending_ingest_batches WHERE workspace_id=$1 AND source='programmatic' AND NOT scope_held AND processed_at IS NULL",[f.workspaceId])).rows
  expect(claims).toEqual([])
  await createDbProgrammaticBatchStore().withClaimedBatches(10,async batches=>{expect(batches).toEqual([])})
  await f.store.updateProfile({actingUserId:f.userId,workspaceId:f.workspaceId,profileId:f.profile.id,name:'Extraction',partitionBy:'session',enabled:true,processingMode:'extract'})
  expect((await pool.query('SELECT processing_purpose,purpose_held,scope_held FROM pending_ingest_batches WHERE workspace_id=$1',[f.workspaceId])).rows[0]).toMatchObject({processing_purpose:'archive_only',purpose_held:true,scope_held:true})
  expect(await f.publisher.drain((await pool.query('SELECT id FROM pending_ingest_batches WHERE workspace_id=$1',[f.workspaceId])).rows[0].id)).toBeNull();expect(f.ingest).not.toHaveBeenCalled()
 })
 it('EH10 native deletion erases projection and keeps a non-content replay tombstone',async()=>{
  const f=await fixture(),event=randomUUID(),r=await f.send(event)
  expect((await f.api.delete(f.ctx,r.fileId!)).ok).toBe(true)
  const row=(await pool.query('SELECT * FROM programmatic_archive_events WHERE id=$1',[r.archiveId])).rows[0]
  expect(row).toMatchObject({delivery_status:'deleted',index_text:'',file_id:null,annotations:[]})
  expect((await f.send(event)).deliveryStatus).toBe('deleted');expect(f.blobs.size).toBe(0)
 })
 it('EH03 ordinary discovery, ingest, derivation and original mutation all refuse archives',async()=>{
  const f=await fixture(),r=await f.send(),store=createDbWorkspaceFilesStore()
  const access={workspaceId:f.workspaceId,userId:f.userId,assistantId:f.ctx.assistantId!,assistantKind:'primary' as const,clearance:'confidential' as const}
  expect(await store.listByPath(access,{prefix:'/engineering-history'})).toEqual([])
  expect(await store.listIndexRanked(access,50)).toEqual([])
  expect(await store.searchByText(access,{query:'engineering'})).toEqual([])
  expect(await enqueueFileIngestJob({workspaceId:f.workspaceId,actingUserId:f.userId,fileId:r.fileId!,mode:'explicit'})).toMatchObject({enqueued:false,jobId:null})
  expect(await f.api.append(f.ctx,r.fileId!,'operational')).toMatchObject({ok:false,error:{kind:'read_only'}})
  expect(await f.api.setMeta(f.ctx,r.fileId!,{tags:['operational']})).toMatchObject({ok:false,error:{kind:'read_only'}})
  expect((await queryWithRLS(f.userId,"SELECT read_entity_derivation_source($1,'workspace_file',$2) AS source",[f.workspaceId,r.fileId])).rows[0].source).toBeNull()
  await expect(pool.query("INSERT INTO file_ingest_jobs(file_id,workspace_id,acting_user_id,source_label) VALUES($1,$2,$3,'fixture')",[r.fileId,f.workspaceId,f.userId])).rejects.toThrow('engineering_archive_operational_input_denied')
  for(const table of ['episodes','memories','entities','tasks','goals','brief_bindings','research_activities','research_improvements','feed_learning_outputs'])expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows[0].n).toBe(0)
  expect(f.ingest).not.toHaveBeenCalled()
 })
 it('EH04 native admission permits collaborators and revokes reads immediately',async()=>{
  const f=await fixture(),r=await f.send(),viewer={...f.ctx,userId:f.memberId,assistantId:undefined}
  expect(await f.api.readBytes(viewer,r.fileId!)).toMatchObject({ok:false,error:{kind:'not_found'}})
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')",[f.workspaceId,f.memberId])
  await createDbWorkspaceGroupStore().addMember(f.userId,f.team.id,f.memberId)
  const admittedRead=await f.api.readBytes(viewer,r.fileId!);if(!admittedRead.ok)throw new Error(JSON.stringify(admittedRead.error));expect(admittedRead.ok).toBe(true)
  await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2',[f.team.id,f.memberId])
  expect(await f.api.readBytes(viewer,r.fileId!)).toMatchObject({ok:false,error:{kind:'not_found'}})
  expect((await queryWithRLS(f.memberId,'SELECT id,index_text FROM programmatic_archive_events WHERE id=$1',[r.archiveId])).rows).toEqual([])
 })
 it('EH04 read-only writes fail before any source storage, including direct service calls',async()=>{
  const f=await fixture()
  await expect(f.route({...f.auth,scope:'read'},{eventId:randomUUID(),content:'prompt',sessionId:'session',role:'user'})).rejects.toThrow()
  expect((await pool.query('SELECT id FROM workspace_files WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  expect(f.ingest).not.toHaveBeenCalled()
 })
 it('EH10 a held original withholds the index without becoming operational on replay',async()=>{
  const f=await fixture(),event=randomUUID(),r=await f.send(event)
  await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[r.fileId])
  expect((await pool.query('SELECT index_text,delivery_status FROM programmatic_archive_events WHERE id=$1',[r.archiveId])).rows[0]).toMatchObject({index_text:'',delivery_status:'excluded'})
  expect((await f.send(event)).deliveryStatus).toBe('excluded')
 })

 it('EH01/EH04 configured ready profiles publish through real key and saved Department admission',async()=>{
  const f=await fixture(true),r=await f.send()
  expect(r).toMatchObject({outcome:'archived',deliveryStatus:'archived'})
  expect(f.ingest).not.toHaveBeenCalled()
  expect((await pool.query('SELECT purpose,compartments FROM workspace_files WHERE id=$1',[r.fileId])).rows[0]).toMatchObject({purpose:'engineering_archive',compartments:[f.team.compartmentKey]})
 })
 it('EH04 key revocation withholds existing original bytes and index for admitted readers',async()=>{
  const f=await fixture(),r=await f.send()
  await pool.query("UPDATE brain_keys SET status='revoked' WHERE id=$1",[f.keyId])
  expect(await f.api.readBytes(f.ctx,r.fileId!)).toMatchObject({ok:false,error:{kind:'not_found'}})
  expect((await queryWithRLS(f.userId,'SELECT id FROM programmatic_archive_events WHERE id=$1',[r.archiveId])).rows).toEqual([])
 })

 it('EH04 shared Project membership and owner oversight retain Department restrictions',async()=>{
  const f=await fixture(),projectId=randomUUID(),ownerId=randomUUID()
  await pool.query('UPDATE workspaces SET project_shared_spaces=true WHERE id=$1',[f.workspaceId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Shared fixture','shared fixture',$3)",[projectId,f.workspaceId,f.userId])
  await pool.query("INSERT INTO project_shared_scopes(project_id,workspace_id,origin,created_by) VALUES($1,$2,'created',$3)",[projectId,f.workspaceId,f.userId])
  await pool.query("INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,user_id,origin) VALUES($1,$2,'user',$3,'creator')",[f.workspaceId,projectId,f.userId])
  await pool.query("INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,assistant_id,origin) VALUES($1,$2,'assistant',$3,'invited')",[f.workspaceId,projectId,f.auth.captureAssistantId])
  const projectRule={filterType:'role_match',filterParams:{values:['user','assistant']},routingMode:'realtime' as const,scopeBindingMode:'explicit' as const,compartments:[`project:${projectId}`],projectIds:[projectId]}
  await f.store.updateRule({actingUserId:f.userId,workspaceId:f.workspaceId,profileId:f.profile.id,ruleId:f.rule.id,rule:projectRule})
  const shared=await f.send(),viewer={...f.ctx,userId:f.memberId,assistantId:undefined}
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')",[f.workspaceId,f.memberId])
  expect((await f.api.readBytes(viewer,shared.fileId!)).ok).toBe(false)
  await pool.query("INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,user_id,origin) VALUES($1,$2,'user',$3,'invited')",[f.workspaceId,projectId,f.memberId])
  expect((await f.api.readBytes(viewer,shared.fileId!)).ok).toBe(true)
  await pool.query('DELETE FROM project_shared_members WHERE project_id=$1 AND user_id=$2',[projectId,f.memberId])
  expect((await f.api.readBytes(viewer,shared.fileId!)).ok).toBe(false)
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[ownerId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[f.workspaceId,ownerId])
  await pool.query('UPDATE workspaces SET owner_user_id=$2 WHERE id=$1',[f.workspaceId,ownerId])
  await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,ownerId])
  const oversight={...f.ctx,userId:ownerId,assistantId:undefined}
  expect((await f.api.readBytes(oversight,shared.fileId!)).ok).toBe(true)
  await f.store.updateRule({actingUserId:f.userId,workspaceId:f.workspaceId,profileId:f.profile.id,ruleId:f.rule.id,rule:{...projectRule,compartments:[...projectRule.compartments,f.team.compartmentKey!]}})
  const restricted=await f.send()
  expect((await f.api.readBytes(oversight,restricted.fileId!)).ok).toBe(false)
  expect((await f.api.readBytes({...f.ctx,workspaceId:randomUUID()},restricted.fileId!)).ok).toBe(false)
 })

 it('EH09/EH10 shared history preserves original export, annotations, versions and canonical erasure',async()=>{
  const f=await fixture(),r=await f.send(),history=createEngineeringHistoryService({files:f.api,cursorSecret:'fixture-cursor-secret'})
  const original=await history.read(f.ctx,r.archiveId!)
  expect(original.content).toBe('  original\n工程 ☃\n\t')
  const command={action:'annotate' as const,eventId:original.id,text:'Reported result is unverified.',expectedRevision:original.revision,expectedFileVersion:original.fileVersion,idempotencyKey:randomUUID()}
  const first=await history.execute(f.ctx,command)
  expect(await history.execute(f.ctx,command)).toEqual(first)
  expect((await history.read(f.ctx,original.id)).content).toBe(original.content)
  expect((await history.read(f.ctx,original.id)).annotations).toHaveLength(1)
  await expect(history.execute(f.ctx,{...command,text:'changed'})).rejects.toThrow('history_command_conflict')
  await expect(history.execute(f.ctx,{...command,idempotencyKey:randomUUID()})).rejects.toThrow('history_version_conflict')
  const exported=await history.exportPage(f.ctx,{query:'工程'})
  expect(JSON.parse(exported.jsonl).content).toBe(original.content);expect(exported.status).toBe('complete')
  const current=await history.read(f.ctx,original.id),erase={action:'delete' as const,eventId:current.id,expectedRevision:current.revision,expectedFileVersion:current.fileVersion,idempotencyKey:randomUUID()}
  expect(await history.execute(f.ctx,erase)).toMatchObject({status:'deleted'})
  expect(await history.execute(f.ctx,erase)).toMatchObject({status:'deleted'})
  expect((await history.list(f.ctx)).events).toEqual([])
  await expect(history.read(f.ctx,original.id)).rejects.toThrow('history_not_available')
  expect(f.blobs.size).toBe(0)
 })
 it('EH09 scoped cursors, original JSONL partial failure and read-only commands disclose only admitted events',async()=>{
  const f=await fixture(),a=await f.send(),b=await f.send(),history=createEngineeringHistoryService({files:f.api,cursorSecret:'fixture-cursor-secret'})
  const page=await history.list(f.ctx,{limit:1});expect(page.events).toHaveLength(1);expect(page.nextCursor).toBeTruthy()
  expect((await history.list(f.ctx,{limit:1,cursor:page.nextCursor!})).events).toHaveLength(1)
  await expect(history.list({...f.ctx,userId:f.memberId},{limit:1,cursor:page.nextCursor!})).rejects.toThrow('history_cursor_invalid')
  expect((await history.list({...f.ctx,userId:f.memberId})).events).toEqual([])
  await expect(history.read({...f.ctx,userId:f.memberId},a.archiveId!)).rejects.toThrow('history_not_available')
  const event=await history.read(f.ctx,a.archiveId!)
  await expect(history.execute({...f.ctx,readOnly:true},{action:'delete',eventId:event.id,expectedRevision:event.revision,expectedFileVersion:event.fileVersion,idempotencyKey:randomUUID()})).rejects.toThrow('history_write_denied')
  f.blobs.delete(`${f.workspaceId}/${b.fileId}`)
  const partial=await history.exportPage(f.ctx)
  expect(partial).toMatchObject({status:'partial',count:1,failureCode:'history_not_available'})
  expect(JSON.parse(partial.jsonl).id).toBe(a.archiveId)
 })
 it('EH01 configuration inherits the selected assistant and fails readiness after key revocation',async()=>{
  const f=await fixture(),configuration=createCaptureConfigurationReader(f.store,()=>true)
  expect(await configuration(f.auth)).toMatchObject({ready:true,processingPurpose:'archive_only',permittedEventKinds:['user','assistant'],localEmitterObserved:false})
  await f.store.setAssistantProfile({actingUserId:f.userId,workspaceId:f.workspaceId,assistantId:f.auth.captureAssistantId!,profileId:f.profile.id})
  expect(await configuration({...f.auth,captureProfileId:null})).toMatchObject({ready:true,profileId:f.profile.id})
  expect(await configuration({...f.auth,scope:'read'})).toMatchObject({ready:false})
  await pool.query("UPDATE brain_keys SET status='revoked' WHERE id=$1",[f.keyId])
  expect(await configuration(f.auth)).toMatchObject({ready:false})
 })
 it('EH09 HTTP authenticates real web users and registers static JSONL export before event ids',async()=>{
  const f=await fixture(),r=await f.send(),history=createEngineeringHistoryService({files:f.api,cursorSecret:'fixture-cursor-secret'})
  const session=(await pool.query("INSERT INTO auth_sessions(user_id,auth_version,device_label) VALUES($1,0,'History fixture') RETURNING id",[f.userId])).rows[0].id
  const secret='fictional-history-web-secret',token=createTokens(f.userId,secret,{id:session,authVersion:0}).accessToken,app=express()
  app.use(express.json());app.use(requireAuth(secret));app.use('/api/workspaces/:workspaceId/engineering-history',engineeringHistoryRoutes({service:history,workspaceStore:createWorkspaceStore()}))
  const path=`/api/workspaces/${f.workspaceId}/engineering-history`
  expect((await request(app).get(path)).status).toBe(401)
  const original=await request(app).get(`${path}/${r.archiveId}`).auth(token,{type:'bearer'})
  expect(original.status).toBe(200);expect(original.body.content).toContain('工程')
  const exported=await request(app).get(`${path}/export`).auth(token,{type:'bearer'})
  expect(exported.status).toBe(200);expect(exported.headers['x-brian-export-status']).toBe('complete');expect(JSON.parse(exported.text).id).toBe(r.archiveId)
 })

 it.each(['codex','claude-code'] as const)('EH11 provider fixture reaches the actual MCP transport, native publisher and exact history for %s',async provider=>{
  const f=await fixture(true),history=createEngineeringHistoryService({files:f.api,cursorSecret:'fixture-cursor-secret'}),configuration=createCaptureConfigurationReader(f.store,()=>true)
  const unused=vi.fn(async()=>{throw new Error('operational tool must not run')})
  const tools=new Proxy({}, {get(_target,name){return buildTool({name:String(name),description:'Fixture boundary',inputSchema:z.object({id:z.string().optional()}),execute:unused})}})
  const app=express();app.use(express.json());app.use('/api/brain/mcp',brainMcpRoutes({brainKeyStore:createDbBrainKeyStore(),memoryTools:tools as never,taskTools:tools as never,crmTools:tools as never,retrievalTools:tools as never,
   programmaticCapture:f.route,captureConfiguration:configuration,engineeringHistory:(auth,input,ctx)=>history.execute({...workspaceFilesCtxFor(ctx),readOnly:auth.scope==='read',principalRef:`${auth.authKind}:${auth.keyId}`,origin:'programmatic'},input)}))
  const server=await new Promise<import('node:http').Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))}),address=server.address() as import('node:net').AddressInfo
  const collector=await import(new URL('../../../../engineering-capture/dist/index.js',import.meta.url).href) as {
   CollectorConfigSchema:{parse(v:unknown):any};CaptureSpool:new(c:any)=>{enqueue(v:any):string;close():void;status():any};
   projectCodexHook(v:unknown):any;projectClaudeCodeHook(v:unknown):any;connectCaptureTransport(c:any,e:Record<string,string>):Promise<any>;flushCapture(c:any,s:any,connect:()=>Promise<any>):Promise<any>
  }
  const dir=mkdtempSync(join(tmpdir(),'engineering-round-trip-')),config=collector.CollectorConfigSchema.parse({version:1,provider,endpoint:`http://127.0.0.1:${address.port}/api/brain/mcp`,credentialEnv:'BRAIN_CAPTURE_FIXTURE_KEY',project:'/workspace/example-project',stateRoot:dir}),spool=new collector.CaptureSpool(config)
  try{
   const project=provider==='codex'?collector.projectCodexHook:collector.projectClaudeCodeHook
   for(const [hook,field,text] of [['UserPromptSubmit','prompt','  Submitted\n工程 ☃\n'],['Stop','last_assistant_message','\nReported result.\t ']]){
    const selected=project({hook_event_name:hook,session_id:'fixture-session',turn_id:'fixture-turn',cwd:'/workspace/example-project',[field!]:text,reasoning:'excluded',tool_result:'excluded',transcript_path:'/unread/fixture'})
    expect(selected.event).toBeTruthy();spool.enqueue(selected.event)
   }
   const result=await collector.flushCapture(config,spool,()=>collector.connectCaptureTransport(config,{BRAIN_CAPTURE_FIXTURE_KEY:f.plaintext}))
   expect(result).toMatchObject({delivered:2});expect(spool.status()).toMatchObject({counts:{archived:2}})
   const events=(await history.list(f.ctx)).events;expect(events).toHaveLength(2)
   expect((await history.read(f.ctx,events[0]!.id)).content).toBe('  Submitted\n工程 ☃\n')
   expect((await history.read(f.ctx,events[1]!.id)).content).toBe('\nReported result.\t ')
   expect(f.ingest).not.toHaveBeenCalled();expect(unused).not.toHaveBeenCalled()
  }finally{spool.close();rmSync(dir,{recursive:true,force:true});await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}
 })

 it('EH04 capture-assistant Department revocation blocks new capture and hides original history',async()=>{
  const f=await fixture(),r=await f.send(),configuration=createCaptureConfigurationReader(f.store,()=>true)
  await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND assistant_id=$2',[f.team.id,f.auth.captureAssistantId])
  expect(await configuration(f.auth)).toMatchObject({ready:false})
  await expect(f.send()).rejects.toThrow()
  expect((await f.api.readBytes(f.ctx,r.fileId!)).ok).toBe(false)
  expect(f.ingest).not.toHaveBeenCalled()
 })
 it('EH07 enqueue sequence preserves navigation when publication completes out of order',async()=>{
  const f=await fixture(),history=createEngineeringHistoryService({files:f.api,cursorSecret:'fixture-cursor-secret'})
  await f.store.updateRule({actingUserId:f.userId,workspaceId:f.workspaceId,profileId:f.profile.id,ruleId:f.rule.id,rule:{filterType:'always',routingMode:'scheduled',routingSchedule:'0 0 * * *',scopeBindingMode:'explicit',compartments:[f.team.compartmentKey!]}})
  const first=await f.send(randomUUID(),'first accepted'),batch=(await pool.query("SELECT id FROM pending_ingest_batches WHERE workspace_id=$1 AND events->0->>'archiveId'=$2",[f.workspaceId,first.archiveId])).rows[0].id
  const second=await f.send(randomUUID(),'second accepted'),other=(await pool.query("SELECT id FROM pending_ingest_batches WHERE workspace_id=$1 AND events->0->>'archiveId'=$2",[f.workspaceId,second.archiveId])).rows[0].id
  await f.publisher.drain(other);await f.publisher.drain(batch)
  expect((await history.list(f.ctx)).events.map(e=>e.id)).toEqual([first.archiveId,second.archiveId])
 })

})
