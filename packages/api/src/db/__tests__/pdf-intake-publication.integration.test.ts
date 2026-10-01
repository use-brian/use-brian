import {createOfficeLiveStore} from '../office-live.js'
import {intakeTransaction,reservePdfIntake,capturePdfIntakeSource} from '../office-pdf-intake.js'
import {createDbFileStore,getFileCachePreviewProjection} from '../file-store.js'
import {createHash,randomUUID} from 'node:crypto'
import {Writable} from 'node:stream'
import request from 'supertest'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {getPool,getAppPool,queryWithRLS} from '../client.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'
import {createDbWorkspaceFilesStore} from '../workspace-files-store.js'
import {createWorkspaceFileUploadsStore} from '../workspace-file-uploads-store.js'
import {createOfficePdfSessionStore} from '../office-pdf-sessions.js'
import {createFilesApi} from '../../files/files-api.js'
import {createChunkedFileUploadService,chunkedUploadPartKey} from '../../files/chunked-upload.js'
import {createPdfSessionService} from '../../office/pdf-session-service.js'
import {officePdfSessionRoutes} from '../../routes/office-pdf-sessions.js'
import {createTestApp} from '../../routes/__tests__/helpers.js'
import {purgeExpiredPdfSessions,runPdfPurgeBlobWorker} from '../../office/lifecycle-worker.js'
import {createFlatPdfFixture} from '../../../../core/src/office/__tests__/fixtures/pdf/index.js'
import type {FilesContext} from '@use-brian/core'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
afterAll(async()=>{await getAppPool().end();await pool.end()})
async function fixture(){
 const workspaceId=randomUUID(),userId=randomUUID(),assistantId=randomUUID(),projectId=randomUUID()
 await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'PDF intake',$2)",[workspaceId,userId])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
 await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'PDF uploader','primary','confidential')",[assistantId,workspaceId,userId])
 await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'PDF','pdf',$3)",[projectId,workspaceId,userId])
 const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(userId,workspaceId,{name:'Common',key:'common'}),sourceTeam=await groups.createTeam(userId,workspaceId,{name:'Source',key:'source'})
 await pool.query("UPDATE workspace_access_policies SET access_mode='departments',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1",[workspaceId,team.id])
 const blobs=new Map<string,Buffer>(),store=createDbWorkspaceFilesStore(),uploads=createWorkspaceFileUploadsStore()
 let hook=async()=>{}
 const gcs={signedWriteUrl:async()=> 'https://fixture.invalid/staging',statBlob:async(k:string)=>blobs.has(k)?{sizeBytes:blobs.get(k)!.length}:null,
  readBlob:async(k:string)=>blobs.has(k)?{bytes:blobs.get(k)!,mime:'application/pdf',metadata:{}}:null,
  deleteBlob:async(k:string)=>{blobs.delete(k)},writeBlob:async(k:string,b:Buffer)=>{blobs.set(k,b);await hook()},
  writeStream(k:string){const parts:Buffer[]=[];return new Writable({write(c,_,cb){parts.push(Buffer.from(c));cb()},final(cb){blobs.set(k,Buffer.concat(parts));cb()}})}}
 const resolver={forWorkspace:async()=>({gcs:gcs as never,bucket:'fixture',byo:true}),forUri:async()=>gcs as never},audit={append:vi.fn()} as never
 const files=createFilesApi({resolver,store,auditStore:audit}),upload=createChunkedFileUploadService({resolver,filesStore:store,uploadsStore:uploads,auditStore:audit})
 const bytes=Buffer.from(await createFlatPdfFixture()),uploadCtx:FilesContext={workspaceId,userId,assistantId,assistantKind:'primary',clearance:'confidential',
  writeCompartments:[sourceTeam.compartmentKey!],writeProjectIds:[projectId],writeSensitivity:'confidential'}
 const started=await upload.start(uploadCtx,{fileName:'intake.pdf',mime:'application/pdf',sizeBytes:bytes.length})
 blobs.set(chunkedUploadPartKey((await uploads.get(userId,started.uploadId))!,0),bytes)
 const source=await upload.complete(uploadCtx,started.uploadId)
 await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1",[workspaceId])
 const ctx:FilesContext={workspaceId,userId,assistantKind:'standard',clearance:'confidential'}
 const sessions=createOfficePdfSessionStore()
 const assets={
  async write(p:any){const r=await files.writeBytes({...ctx,userId:p.userId,workspaceId:p.workspaceId,writeSensitivity:p.sensitivity,writeCompartments:p.compartments,writeProjectIds:p.projectIds},
   {path:p.path,bytes:p.bytes,mime:p.mime,sensitivity:p.sensitivity,sessionOwned:true});if(!r.ok)throw new Error('asset write failed');return {...r.value,sha256:createHash('sha256').update(p.bytes).digest('hex')}},
  async read(p:any){const r=await files.readBytes({...ctx,userId:p.userId,workspaceId:p.workspaceId},p.fileId);return r.ok?{bytes:r.value.bytes,file:{...r.value.file,sha256:createHash('sha256').update(r.value.bytes).digest('hex')}}:null},
  async delete(p:any){await files.delete({...ctx,userId:p.userId,workspaceId:p.workspaceId},p.fileId)},
  async saveDurable(){throw new Error('not exercised')},
 }
 const service=createPdfSessionService({sessions,assets,assertWorkspaceMember:async({userId:actor,workspaceId:w})=>(await queryWithRLS(actor,'SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[w,actor])).rows.length>0,
  async resolveSource(p){if(p.source.kind==='file_cache'){
   const projection=await getFileCachePreviewProjection({workspaceId:p.workspaceId,userId:p.userId,assistantId:'',assistantKind:'primary',visibilityAssistantIds:[],clearance:'confidential'},p.source.id)
   if(!projection)return null
   const encoded=projection.originalContent??projection.file.content,match=/^data:([^;]+);base64,(.+)$/.exec(encoded)
   return match?{bytes:Buffer.from(match[2],'base64'),mime:projection.file.mimeType,fileName:projection.file.fileName,sensitivity:projection.file.sensitivity,compartments:projection.file.compartments,projectIds:projection.file.projectIds}:null
  }const r=await files.readBytes({...ctx,userId:p.userId,workspaceId:p.workspaceId},p.source.id);return r.ok?{bytes:r.value.bytes,mime:r.value.file.mime,fileName:r.value.file.name,sensitivity:r.value.file.sensitivity,compartments:r.value.file.compartments??[],projectIds:r.value.file.projectIds??[]}:null}})
 const app=createTestApp('/api/office',officePdfSessionRoutes({service}),{userId})
 const body={workspaceId,source:{kind:'workspace_file',id:source.id},title:'Uploaded PDF',sensitivity:'internal',idempotencyKey:'pdf-intake-route-key'}
 return {workspaceId,userId,assistantId,bytes,projectId,sourceTeamId:sourceTeam.id,key:sourceTeam.compartmentKey!,source,ctx,files,store,sessions,service,app,body,blobs,hook(fn:()=>Promise<void>){hook=fn}}
}
describe('production PDF upload intake publication',()=>{
 it('allocates a hidden canonical parent before assets, then publishes a usable private session atomically',async()=>{
  const f=await fixture()
  let stages=0
  f.hook(async()=>{
   stages++
   expect((await pool.query("SELECT pdf_intake_state FROM office_artifacts WHERE workspace_id=$1",[f.workspaceId])).rows).toEqual([{pdf_intake_state:'pending'}])
   expect((await queryWithRLS(f.userId,'SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
   expect((await queryWithRLS(f.userId,"SELECT id FROM workspace_files WHERE workspace_id=$1 AND path LIKE '/office/sessions/%'",[f.workspaceId])).rows).toEqual([])
  })
  const result=await request(f.app).post('/api/office/pdf-sessions').send(f.body)
  expect(result.status,result.text).toBe(201);expect(stages).toBe(2)
  expect(await f.sessions.get(f.userId,result.body.artifactId)).toMatchObject({ownerUserId:f.userId,sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
  expect((await request(f.app).get(`/api/office/artifacts/${result.body.artifactId}/pdf/source`)).status).toBe(200)
  const retry=await request(f.app).post('/api/office/pdf-sessions').send(f.body)
  expect(retry.status,retry.text).toBe(201);expect(retry.body.artifactId).toBe(result.body.artifactId);expect(stages).toBe(2)
  expect((await request(f.app).post('/api/office/pdf-sessions').send({...f.body,title:'Different request'})).status).toBe(400)
  expect((await queryWithRLS(f.userId,'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
  await pool.query("UPDATE workspace_files SET scope_held=true WHERE id=$1",[f.source.id])
  expect((await request(f.app).get(`/api/office/artifacts/${result.body.artifactId}/pdf/source`)).status).toBe(404)
 })
 it('keeps partial failure hidden, permits a fresh retry and queues only abandoned assets for cleanup',async()=>{
  const f=await fixture();let count=0
  f.hook(async()=>{if(++count===2)throw Object.assign(new Error('storage interruption'),{code:'fixture_storage_failure'})})
  expect((await request(f.app).post('/api/office/pdf-sessions').send(f.body)).status).toBe(400)
  expect((await queryWithRLS(f.userId,'SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  const abandoned=(await pool.query("SELECT id FROM office_artifacts WHERE workspace_id=$1 AND pdf_intake_state='abandoned'",[f.workspaceId])).rows[0]
  expect(abandoned).toBeTruthy()
  f.hook(async()=>{})
  const retry=await request(f.app).post('/api/office/pdf-sessions').send(f.body)
  expect(retry.status,retry.text).toBe(201);expect(retry.body.artifactId).not.toBe(abandoned.id)
  const client=await pool.connect()
  try{expect(await purgeExpiredPdfSessions(client,1)).toBe(1);await runPdfPurgeBlobWorker({client,deleteObject:async(_uri,key)=>{f.blobs.delete(key)}})}finally{client.release()}
  expect(await f.sessions.get(f.userId,retry.body.artifactId)).not.toBeNull()
  expect((await f.files.stat(f.ctx,f.source.id)).ok).toBe(true)
  expect(f.blobs.size).toBe(3)
 })
 it('rejects source changes during parsing/storage and never publishes an unverified session',async()=>{
  const f=await fixture();let changed=false
  f.hook(async()=>{if(!changed){changed=true;await pool.query("UPDATE workspace_files SET title='Changed during intake' WHERE id=$1",[f.source.id])}})
  expect((await request(f.app).post('/api/office/pdf-sessions').send(f.body)).status).toBe(400)
  expect((await queryWithRLS(f.userId,'SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  expect((await queryWithRLS(f.userId,"SELECT id FROM workspace_files WHERE workspace_id=$1 AND path LIKE '/office/sessions/%'",[f.workspaceId])).rows).toEqual([])
 })
 it('accepts the real cached-upload request shape from an owned, canonically bound private session',async()=>{
  const f=await fixture(),sessionId=randomUUID()
  await pool.query(`INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id,context_compartments,context_project_id,context_group_id)
    VALUES($1,$2,$3,$4,'web',$1::uuid::text,$5,$6,$7)`,[sessionId,f.assistantId,f.userId,f.workspaceId,[f.key],f.projectId,f.sourceTeamId])
  const cached=await createDbFileStore().cache({sessionId,fileName:'owned.pdf',mimeType:'application/pdf',content:'data:application/pdf;base64,'+f.bytes.toString('base64'),
    sizeBytes:f.bytes.length,workspaceId:f.workspaceId,userId:f.userId,assistantId:null,sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
  const result=await request(f.app).post('/api/office/pdf-sessions').send({...f.body,source:{kind:'file_cache',id:cached.id}})
  expect(result.status,result.text).toBe(201)
  expect(await f.sessions.get(f.userId,result.body.artifactId)).toMatchObject({ownerUserId:f.userId,sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
  expect(await createOfficeLiveStore().get(f.userId,result.body.artifactId)).not.toBeNull()
  await pool.query('UPDATE file_cache SET scope_held=true WHERE id=$1',[cached.id])
  expect(await createOfficeLiveStore().get(f.userId,result.body.artifactId)).toBeNull()
  expect((await queryWithRLS(f.userId,'UPDATE office_collab_documents SET seq=seq+1 WHERE artifact_id=$1',[result.body.artifactId])).rowCount).toBe(0)
  expect((await request(f.app).get(`/api/office/artifacts/${result.body.artifactId}/pdf/source`)).status).toBe(404)
 })
 it('denies foreign workspace/actor source substitution before allocating a pending root',async()=>{
  const f=await fixture(),foreign=await fixture()
  const result=await request(f.app).post('/api/office/pdf-sessions').send({...f.body,source:{kind:'workspace_file',id:foreign.source.id}})
  expect(result.status).toBe(400)
  expect((await pool.query('SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
 })
 it('a lost final commit acknowledgement does not abandon or delete the published session',async()=>{
  const f=await fixture(),create=f.sessions.create
  f.sessions.create=async p=>{await create(p);throw Object.assign(new Error('lost ack'),{code:'fixture_lost_ack'})}
  expect((await request(f.app).post('/api/office/pdf-sessions').send(f.body)).status).toBe(400)
  const root=(await pool.query('SELECT id,pdf_intake_state FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows[0]
  expect(root.pdf_intake_state).toBe('ready')
  expect((await request(f.app).post('/api/office/pdf-sessions').send(f.body)).body.artifactId).toBe(root.id)
  expect((await request(f.app).get(`/api/office/artifacts/${root.id}/pdf/source`)).status).toBe(200)
 })

 it.each(['hold','change','retract','delete','root_hold'] as const)('denies direct child reads and writes after %s',async drift=>{
  const f=await fixture()
  const result=await request(f.app).post('/api/office/pdf-sessions').send(f.body)
  expect(result.status,result.text).toBe(201)
  const id=result.body.artifactId,job=randomUUID(),thread=randomUUID()
  const version=(await pool.query('SELECT head_version_id FROM office_artifacts WHERE id=$1',[id])).rows[0].head_version_id
  // Cover direct, audit, nested-thread and nested-job policy dispatch, not
  // merely a route that happens to load the root first.
  await queryWithRLS(f.userId,`INSERT INTO office_comment_threads(id,artifact_id,workspace_id,artifact_version_id,anchor_kind,anchor,created_by)
    VALUES($1,$2,$3,$4,'point','{}',$5)`,[thread,id,f.workspaceId,version,f.userId])
  await queryWithRLS(f.userId,`INSERT INTO office_comment_messages(thread_id,workspace_id,author_type,author_user_id,body)
    VALUES($1,$2,'user',$3,'private comment')`,[thread,f.workspaceId,f.userId])
  await queryWithRLS(f.userId,`INSERT INTO office_generation_jobs(id,artifact_id,workspace_id,initiated_by_user_id,brief,authority_projection,idempotency_key)
    VALUES($1,$2,$3,$4,'{}','{}',$1::uuid::text)`,[job,id,f.workspaceId,f.userId])
  const insertEvent=()=>queryWithRLS(f.userId,`INSERT INTO office_generation_events(job_id,workspace_id,seq,code,actor_type)
    VALUES($1,$2,2,'private-event','user')`,[job,f.workspaceId])
  await queryWithRLS(f.userId,`INSERT INTO office_generation_events(job_id,workspace_id,seq,code,actor_type)
    VALUES($1,$2,1,'private-event','user')`,[job,f.workspaceId])
  await queryWithRLS(f.userId,`INSERT INTO office_generation_steering(job_id,workspace_id,sender_user_id,instruction)
    VALUES($1,$2,$3,'private instruction')`,[job,f.workspaceId,f.userId])
  const tables=['office_collab_documents','office_artifact_versions','office_pdf_session_assets','office_audit_events',
    'office_comment_threads','office_comment_messages','office_generation_jobs','office_generation_events','office_generation_steering']
  for(const table of tables)expect((await queryWithRLS(f.userId,`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows.length,table).toBeGreaterThan(0)
  const live=createOfficeLiveStore()
  expect(await live.get(f.userId,id)).not.toBeNull()
  expect(await live.getOfflineSource(f.userId,id)).not.toBeNull()
  expect((await queryWithRLS(f.userId,'UPDATE office_collab_documents SET seq=seq+1 WHERE artifact_id=$1 RETURNING seq',[id])).rowCount).toBe(1)
  if(drift==='root_hold')await pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision)
    VALUES($1,'office_artifact',$2,read_scope_review_source($1,'office_artifact',$2)->>'version','held',1)`,[f.workspaceId,id])
  else if(drift==='delete')await pool.query('DELETE FROM workspace_files WHERE id=$1',[f.source.id])
  else await pool.query(`UPDATE workspace_files SET ${drift==='hold'?'scope_held=true':drift==='change'?"title='changed source'":'retracted_at=now()'} WHERE id=$1`,[f.source.id])
  expect(await live.get(f.userId,id)).toBeNull()
  expect(await live.getOfflineSource(f.userId,id)).toBeNull()
  for(const table of tables){
   expect((await queryWithRLS(f.userId,`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows,table).toEqual([])
   expect((await queryWithRLS(f.userId,`UPDATE ${table} SET workspace_id=workspace_id WHERE workspace_id=$1 RETURNING workspace_id`,[f.workspaceId])).rowCount,table).toBe(0)
   expect((await queryWithRLS(f.userId,`DELETE FROM ${table} WHERE workspace_id=$1 RETURNING workspace_id`,[f.workspaceId])).rowCount,table).toBe(0)
  }
  await expect(queryWithRLS(f.userId,`INSERT INTO office_collab_documents(artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version,seq)
    VALUES($1,$2,$3,$3,$4,0,1)`,[id,f.workspaceId,Buffer.from('blocked'),'a'.repeat(64)])).rejects.toMatchObject({code:'42501'})
  await expect(insertEvent()).rejects.toMatchObject({code:'42501'})
  await expect(queryWithRLS(f.userId,`INSERT INTO office_audit_events(artifact_id,workspace_id,event_type) VALUES($1,$2,'must-deny')`,[id,f.workspaceId])).rejects.toMatchObject({code:'42501'})
  // Even the internal GUC is not an escape for stale *published* proof.
  await intakeTransaction(f.userId,async client=>{
   await client.query("SELECT set_config('app.pdf_intake_artifact',$1,true)",[id])
   expect((await client.query('SELECT ydoc FROM office_collab_documents WHERE artifact_id=$1',[id])).rows).toEqual([])
   expect((await client.query('SELECT office_artifact_scope_allows($1,$2,true) AS allowed',[id,f.workspaceId])).rows[0].allowed).toBe(false)
  })
 })
 it('keeps pending children hidden except to the exact owner writer with current source proof',async()=>{
  const f=await fixture(),id=randomUUID(),other=randomUUID()
  const source=await capturePdfIntakeSource(f.userId,f.workspaceId,f.body.source as {kind:'workspace_file';id:string})
  await reservePdfIntake({userId:f.userId,workspaceId:f.workspaceId,artifactId:id,title:'Pending',idempotencyKey:'pending-child-gate',
    requestHash:'a'.repeat(64),sensitivity:'confidential',sources:[source]})
  await intakeTransaction(f.userId,async client=>{
   await client.query("SELECT set_config('app.pdf_intake_artifact',$1,true)",[id])
   await client.query(`INSERT INTO office_collab_documents(artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version,seq)
     VALUES($1,$2,$3,$3,$4,0,1)`,[id,f.workspaceId,Buffer.from('pending bytes'),'a'.repeat(64)])
   expect((await client.query('SELECT ydoc FROM office_collab_documents WHERE artifact_id=$1',[id])).rows).toHaveLength(1)
   expect((await client.query('UPDATE office_collab_documents SET seq=2 WHERE artifact_id=$1 RETURNING seq',[id])).rowCount).toBe(1)
  })
  expect((await queryWithRLS(f.userId,'SELECT ydoc FROM office_collab_documents WHERE artifact_id=$1',[id])).rows).toEqual([])
  expect((await queryWithRLS(f.userId,'UPDATE office_collab_documents SET seq=3 WHERE artifact_id=$1',[id])).rowCount).toBe(0)
  await expect(queryWithRLS(f.userId,`INSERT INTO office_audit_events(artifact_id,workspace_id,event_type) VALUES($1,$2,'must-deny')`,[id,f.workspaceId])).rejects.toMatchObject({code:'42501'})
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[other])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[f.workspaceId,other])
  for(const [actor,binding] of [[f.userId,randomUUID()],[other,id]])await intakeTransaction(actor,async client=>{
   await client.query("SELECT set_config('app.pdf_intake_artifact',$1,true)",[binding])
   expect((await client.query('SELECT ydoc FROM office_collab_documents WHERE artifact_id=$1',[id])).rows).toEqual([])
  })
  await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[f.source.id])
  await intakeTransaction(f.userId,async client=>{
   await client.query("SELECT set_config('app.pdf_intake_artifact',$1,true)",[id])
   expect((await client.query('SELECT ydoc FROM office_collab_documents WHERE artifact_id=$1',[id])).rows).toEqual([])
   expect((await client.query('UPDATE office_collab_documents SET seq=3 WHERE artifact_id=$1',[id])).rowCount).toBe(0)
  })
 })
 it('covers every canonical child policy operation through the shared predicate',async()=>{
  const direct=['office_artifact_versions','office_artifact_sources','office_artifact_grants','office_collab_documents',
    'office_comment_threads','office_suggestions','office_generation_jobs','office_claims','office_media_uses','office_release_records','office_offline_packages']
  for(const [table,predicate] of [...direct.map(t=>[t,'office_artifact_scope_allows']),['office_audit_events','office_audit_scope_allows'],
    ['office_comment_messages','office_child_scope_allows'],['office_generation_events','office_child_scope_allows'],['office_generation_steering','office_child_scope_allows']]){
   const policies=(await pool.query(`SELECT cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND policyname LIKE 'office_scope_%' AND permissive='RESTRICTIVE'`,[table])).rows
   expect(policies.map(p=>p.cmd).sort(),table).toEqual(['DELETE','INSERT','SELECT','UPDATE'])
   for(const p of policies)expect((p.qual??'')+(p.with_check??''),table+':'+p.cmd).toContain(predicate)
  }
 })

})
