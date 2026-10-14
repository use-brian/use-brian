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
import type { BrainAuth } from '../../brain-mcp/auth.js'
import type { FilesContext } from '@use-brian/core'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
afterAll(async()=>{await getAppPool().end();await pool.end()})
async function fixture(){
 const workspaceId=randomUUID(),userId=randomUUID(),memberId=randomUUID(),assistantId=randomUUID(),keyId=randomUUID()
 for(const id of [userId,memberId])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Engineering fixture',$2,false)",[workspaceId,userId])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
 const team=await createDbWorkspaceGroupStore().createTeam(userId,workspaceId,{name:'Engineering',key:'engineering'})
 await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance,default_compartments) VALUES($1,$2,$3,'Capture','primary','internal',$4)",[assistantId,workspaceId,userId,[team.compartmentKey]])
 const store=createProgrammaticCaptureStore()
 const profile=await store.createProfile({actingUserId:userId,workspaceId,name:'Engineering',processingMode:'archive_only',partitionBy:'session',enabled:true})
 const rule=await store.addRule({actingUserId:userId,workspaceId,profileId:profile.id,rule:{filterType:'role_match',filterParams:{values:['user','assistant']},routingMode:'realtime',scopeBindingMode:'explicit',compartments:[team.compartmentKey!]}})
 await pool.query(`INSERT INTO brain_keys(id,workspace_id,name,key_hash,key_prefix,scope,issuer_user_id,capture_assistant_id,capture_profile_id)
  VALUES($1,$2,'Fixture key','not-a-credential','fixture','read_write',$3,$4,$5)`,[keyId,workspaceId,userId,assistantId,profile.id])
 const auth:BrainAuth={workspaceId,keyId,scope:'read_write',maxClearance:'internal',authKind:'api_key',storeScope:'none',agentScope:'none',actingUserId:userId,captureAssistantId:assistantId,captureProfileId:profile.id}
 const ctx:FilesContext={workspaceId,userId,assistantId,assistantKind:'primary',clearance:'confidential'}
 const blobs=new Map<string,Buffer>(),audit=vi.fn(),ingest=vi.fn()
 let io=async()=>{},fail=false
 const api=createFilesApi({store:createDbWorkspaceFilesStore(),gcs:{writeBlob:async(k:string,b:Buffer)=>{if(fail)throw new Error('storage unavailable');blobs.set(k,b);await io()},readBlob:async(k:string)=>blobs.has(k)?{bytes:blobs.get(k)!}:null,deleteBlob:async(k:string)=>{blobs.delete(k)}} as never,bucket:'fixture',auditStore:{append:audit} as never})
 const publisher=createEngineeringArchivePublisher(api),route=createProgrammaticCaptureRouter({store,ingest,archive:publisher.capture})
 const send=(eventId=randomUUID(),content='  original\n工程 ☃\n\t')=>route(auth,{eventId,content,sessionId:'fictional-session',role:'user',metadata:{provider:'codex'}})
 return {workspaceId,userId,memberId,keyId,profile,rule:rule!,auth,ctx,store,api,blobs,ingest,publisher,route,send,
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
})
