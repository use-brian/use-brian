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
 if(ready)keyId=(await withExternalKeyActor(userId,session,()=>createDbBrainKeyStore().create({workspaceId,actingUserId:userId,name:'Fixture',scope:'read_write',maxClearance:'internal',contextGroupId:team.id,contextProjectId:null,captureAssistantId:assistantId,captureProfileId:profile.id}))).id
 else await pool.query(`INSERT INTO brain_keys(id,workspace_id,name,key_hash,key_prefix,scope,issuer_user_id,capture_assistant_id,capture_profile_id)
  VALUES($1,$2,'Fixture key','not-a-credential','fixture','read_write',$3,$4,$5)`,[keyId,workspaceId,userId,assistantId,profile.id])
 const auth:BrainAuth={workspaceId,keyId,scope:'read_write',maxClearance:'internal',authKind:'api_key',storeScope:'none',agentScope:'none',actingUserId:userId,captureAssistantId:assistantId,captureProfileId:profile.id}
 const ctx:FilesContext={workspaceId,userId,assistantId,assistantKind:'primary',clearance:'confidential'}
 const blobs=new Map<string,Buffer>(),audit=vi.fn(),ingest=vi.fn()
 let io=async()=>{},fail=false
 const api=createFilesApi({store:createDbWorkspaceFilesStore(),gcs:{writeBlob:async(k:string,b:Buffer)=>{if(fail)throw new Error('storage unavailable');blobs.set(k,b);await io()},readBlob:async(k:string)=>blobs.has(k)?{bytes:blobs.get(k)!}:null,deleteBlob:async(k:string)=>{blobs.delete(k)}} as never,bucket:'fixture',auditStore:{append:audit} as never})
 const publisher=createEngineeringArchivePublisher(api),route=createProgrammaticCaptureRouter({store,ingest,archive:publisher.capture})
 const send=(eventId=randomUUID(),content='  original\n工程 ☃\n\t')=>route(auth,{eventId,content,sessionId:'fictional-session',role:'user',metadata:{provider:'codex'}})
 return {workspaceId,userId,memberId,keyId,profile,rule:rule!,auth,ctx,store,api,blobs,ingest,publisher,route,send,team,
  during(fn:()=>Promise<void>){io=fn},failStorage(){fail=true},workingStorage(){fail=false}}
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
  for(const table of ['episodes','memories','entities','tasks'])expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows[0].n).toBe(0)
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

})
