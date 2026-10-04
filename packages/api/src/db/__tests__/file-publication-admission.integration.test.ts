import {randomUUID} from 'node:crypto'
import {Writable} from 'node:stream'
import {afterAll,describe,it,expect,vi} from 'vitest'
import {getPool,getAppPool,queryWithRLS} from '../client.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'
import {createDbWorkspaceFilesStore} from '../workspace-files-store.js'
import {createWorkspaceFileUploadsStore} from '../workspace-file-uploads-store.js'
import {createChunkedFileUploadService,chunkedUploadPartKey} from '../../files/chunked-upload.js'
import {createFilesApi} from '../../files/files-api.js'
import type {FilesContext} from '@use-brian/core'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
await assertLocalFixture()
const pool=getPool()
afterAll(async()=>{await getAppPool().end();await pool.end()})
async function fixture(){
 const workspaceId=randomUUID(),userId=randomUUID(),assistantId=randomUUID(),projectId=randomUUID()
 await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Publication fixture',$2,false)",[workspaceId,userId])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
 await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Publication','primary','confidential')",[assistantId,workspaceId,userId])
 await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Project','project',$3)",[projectId,workspaceId,userId])
 const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(userId,workspaceId,{name:'Publication',key:'publication'}),other=await groups.createTeam(userId,workspaceId,{name:'Other',key:'other'})
 await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1",[workspaceId,team.id])
 const key=team.compartmentKey!,ctx:FilesContext={workspaceId,userId,assistantId,assistantKind:'primary',clearance:'confidential',compartments:null,mutationCompartments:null,projectIds:null}
 const store=createDbWorkspaceFilesStore(),uploads=createWorkspaceFileUploadsStore(),blobs=new Map<string,Buffer>(),audit=vi.fn()
 let duringIO=async()=>{}
 const gcs={signedWriteUrl:async()=> 'https://fixture.invalid/staging',statBlob:async(k:string)=>blobs.has(k)?{sizeBytes:blobs.get(k)!.length}:null,
  readBlob:async(k:string)=>blobs.has(k)?{bytes:blobs.get(k)!}:null,deleteBlob:async(k:string)=>{blobs.delete(k)},
  writeBlob:async(k:string,b:Buffer)=>{blobs.set(k,b);await duringIO()},
  writeStream(k:string){const chunks:Buffer[]=[];return new Writable({write(c,_,cb){chunks.push(Buffer.from(c));cb()},final(cb){blobs.set(k,Buffer.concat(chunks));duringIO().then(()=>cb(),cb)}})}}
 const resolver={forWorkspace:async()=>({gcs:gcs as never,bucket:'fixture',byo:true}),forUri:async()=>gcs as never}
 const service=createChunkedFileUploadService({resolver,filesStore:store,uploadsStore:uploads,auditStore:{append:audit} as never})
 const api=createFilesApi({resolver,store,auditStore:{append:audit} as never})
 const rows=async()=>(await pool.query('SELECT * FROM workspace_files WHERE workspace_id=$1',[workspaceId])).rows
 return {workspaceId,userId,assistantId,projectId,key,otherKey:other.compartmentKey!,team,ctx,store,uploads,blobs,audit,service,api,rows,
  during(fn:()=>Promise<void>){duringIO=fn},async start(){const started=await service.start(ctx,{fileName:'uploaded.txt',mime:'text/plain',sizeBytes:3});const upload=(await uploads.get(userId,started.uploadId))!;blobs.set(chunkedUploadPartKey(upload,0),Buffer.from('abc'));return started}}
}
describe('late upload and canonical session publication',()=>{
 it('publishes only after assembly with pinned scope and atomically completes the app-role ledger',async()=>{
  const f=await fixture(),start=await f.start()
  f.during(async()=>{expect(await f.rows()).toEqual([]);expect((await f.uploads.get(f.userId,start.uploadId))?.status).toBe('assembling')})
  await pool.query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1",[f.workspaceId])
  const file=await f.service.complete(f.ctx,start.uploadId)
  expect(file).toMatchObject({compartments:[f.key],userId:null,assistantId:null})
  expect((await f.uploads.get(f.userId,start.uploadId))?.status).toBe('completed')
  expect((await f.service.complete(f.ctx,start.uploadId)).id).toBe(file.id)
  expect((await queryWithRLS(f.userId,'SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0].rolbypassrls).toBe(false)
 })
 it.each(['membership','assistant','project','actor'] as const)('denies late %s change without file publication or success audit',async kind=>{
  const f=await fixture()
  f.ctx.writeProjectIds=[f.projectId]
  const start=await f.start()
  f.during(async()=>{
   if(kind==='membership')await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
   if(kind==='assistant')await pool.query("UPDATE assistants SET compartments='{}',team_scope_mode='assigned' WHERE id=$1",[f.assistantId])
   if(kind==='project')await pool.query("UPDATE workspace_projects SET status='archived' WHERE id=$1",[f.projectId])
  })
  await expect(f.service.complete({...f.ctx,...(kind==='actor'?{userId:randomUUID()}:{})},start.uploadId)).rejects.toThrow()
  expect(await f.rows()).toEqual([]);expect(f.audit).not.toHaveBeenCalled()
  expect((await pool.query('SELECT status FROM workspace_file_uploads WHERE id=$1',[start.uploadId])).rows[0].status).not.toBe('completed')
 })
 it('retains staged bytes on uncertain acknowledgement instead of deleting a possibly committed object',async()=>{
  const f=await fixture(),start=await f.start(),real=f.store.finalizeUpload
  f.store.finalizeUpload=async(...args)=>{await real(...args);throw new Error('lost acknowledgement')}
  await expect(f.service.complete(f.ctx,start.uploadId)).rejects.toThrow('lost acknowledgement')
  expect(f.blobs.has(`${f.workspaceId}/${start.fileId}`)).toBe(true)
  expect((await f.rows())[0].id).toBe(start.fileId)
  expect((await f.service.complete(f.ctx,start.uploadId)).id).toBe(start.fileId)
 })
 async function session(f:Awaited<ReturnType<typeof fixture>>){
  const id=randomUUID()
  await pool.query(`INSERT INTO office_artifacts(id,workspace_id,family,mode,title,creator_user_id,owner_user_id,capability_version,sensitivity,compartments,project_ids,default_workspace_role,expires_at)
    VALUES($1,$2,'pdf','session','Bound session',$3,$3,1,'confidential',$4,$5,'deny',now()+interval '1 day')`,[id,f.workspaceId,f.userId,[f.otherKey],[f.projectId]])
  return id
 }
 it.each(['omitted','null'] as const)('supports the production PDF caller with %s executing assistant',async assistant=>{
  const f=await fixture(),id=await session(f),path=`/office/sessions/${id}/preview/human.png`
  // Same human-only context as boot's PDF session asset writer, not a primary
  // assistant fixture. userId is deliberately not an assistants.id.
  const ctx:FilesContext={workspaceId:f.workspaceId,userId:f.userId,assistantKind:'standard',clearance:'confidential',
   writeSensitivity:'confidential',writeCompartments:[f.otherKey],writeProjectIds:[f.projectId],
   ...(assistant==='null'?{assistantId:null}:{})}
  const result=await f.api.writeBytes(ctx,{path,bytes:Buffer.from('abc'),mime:'image/png',sensitivity:'confidential',sessionOwned:true})
  expect(result).toMatchObject({ok:true,value:{userId:f.userId,assistantId:null,createdByUserId:f.userId,createdByAssistantId:null,
   sensitivity:'confidential',compartments:[f.otherKey],projectIds:[f.projectId]}})
  if(!result.ok)throw new Error('file missing')
  expect((await f.api.stat(ctx,result.value.id)).ok).toBe(true)
  expect((await pool.query('SELECT artifact_id FROM workspace_file_session_bindings WHERE file_id=$1',[result.value.id])).rows).toEqual([{artifact_id:id}])
  expect((await queryWithRLS(f.userId,'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
  const partitioned=await f.store.create(f.userId,{workspaceId:f.workspaceId,path:'/assistant-only.txt',parentPath:'/',name:'assistant-only.txt',
   mime:'text/plain',sizeBytes:1,storageUri:'fixture://assistant-only',createdByUserId:f.userId,assistantId:f.assistantId})
  expect(await f.api.stat(ctx,partitioned.id)).toMatchObject({ok:false,error:{kind:'not_found'}})
 })
 it('rejects an explicitly supplied foreign assistant before staging PDF session bytes',async()=>{
  const f=await fixture(),foreign=await fixture(),id=await session(f)
  const ctx:FilesContext={workspaceId:f.workspaceId,userId:f.userId,assistantKind:'standard',assistantId:foreign.assistantId,
   clearance:'confidential',writeSensitivity:'confidential',writeCompartments:[f.otherKey],writeProjectIds:[f.projectId]}
  await expect(f.api.writeBytes(ctx,{path:`/office/sessions/${id}/preview/foreign.png`,bytes:Buffer.from('abc'),mime:'image/png',sessionOwned:true}))
   .rejects.toMatchObject({code:'context_not_available'})
  expect(f.blobs.size).toBe(0);expect(await f.rows()).toEqual([]);expect(f.audit).not.toHaveBeenCalled()
 })
 it('writes a real session-owned file under its canonical private floor without the Simple default',async()=>{
  const f=await fixture(),id=await session(f),path=`/office/sessions/${id}/preview/page.png`
  const result=await f.api.writeBytes(f.ctx,{path,bytes:Buffer.from('abc'),mime:'image/png',sessionOwned:true})
  expect(result).toMatchObject({ok:true,value:{userId:f.userId,assistantId:null,sensitivity:'confidential',compartments:[f.otherKey],projectIds:[f.projectId],metadata:{officeSession:true,noIndex:true}}})
  if(!result.ok)throw new Error('file missing')
  expect((await pool.query('SELECT artifact_id FROM workspace_file_session_bindings WHERE file_id=$1',[result.value.id])).rows).toEqual([{artifact_id:id}])
  const successor=await f.store.supersede(f.userId,f.workspaceId,result.value.id,{editorUserId:f.userId,storageUri:'fixture://next',sizeBytes:3})
  expect(successor).not.toBeNull()
  expect((await pool.query('SELECT artifact_id FROM workspace_file_session_bindings WHERE file_id=$1',[successor!.id])).rows).toEqual([{artifact_id:id}])
  await pool.query("UPDATE office_artifacts SET created_at=now()-interval '24 hours 1 second',expires_at=now()-interval '1 second' WHERE id=$1",[id])
  expect(await f.store.getById({...f.ctx,assistantId:f.assistantId,assistantKind:'primary'},successor!.id)).toBeNull()
 })
 it.each(['scope','expiry','owner','held'] as const)('refuses session %s changes during byte staging',async kind=>{
  const f=await fixture(),id=await session(f)
  let changed=false
  f.during(async()=>{
   if(kind==='scope')await pool.query('UPDATE office_artifacts SET compartments=$2 WHERE id=$1',[id,[f.key]])
   if(kind==='expiry')await pool.query("UPDATE office_artifacts SET created_at=now()-interval '24 hours 1 second',expires_at=now()-interval '1 second' WHERE id=$1",[id])
   if(kind==='owner') {
    const other=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[other])
    await pool.query('UPDATE office_artifacts SET owner_user_id=$2 WHERE id=$1',[id,other])
   }
   if(kind==='held')await pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
     SELECT $1,'office_artifact',$2,read_scope_review_source($1,'office_artifact',$2)->>'version','held',1,'source_changed'`,[f.workspaceId,id])
   changed=true
  })
  await expect(f.api.writeBytes(f.ctx,{path:`/office/sessions/${id}/preview/page.png`,bytes:Buffer.from('abc'),mime:'image/png',sessionOwned:true})).rejects.toThrow()
  expect(changed).toBe(true)
  expect(await f.rows()).toEqual([]);expect(f.audit).not.toHaveBeenCalled()
 })
 it('rejects an unbound session path before any bytes are staged',async()=>{
  const f=await fixture()
  await expect(f.api.writeBytes(f.ctx,{path:`/office/sessions/${randomUUID()}/source/source.pdf`,bytes:Buffer.from('abc'),mime:'application/pdf',sessionOwned:true})).rejects.toThrow()
  expect(f.blobs.size).toBe(0)
 })
})
