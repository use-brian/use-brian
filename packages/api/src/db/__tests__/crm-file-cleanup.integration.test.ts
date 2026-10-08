import {randomUUID} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createLocalFilesClient} from '../../files/local-files-client.js'
import express from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it,vi} from 'vitest'
import type {CrmOperationsContext,CrmImportFileCleanupPreview} from '@use-brian/core'
import {getPool,getAppPool,queryWithRLS} from '../client.js'
import {createCrmOperationsService} from '../../crm-operations/service.js'
import {createDbCrmOperationsStore} from '../crm-operations-store.js'
import {createCrmImportFileCleanupService} from '../../crm-operations/import-file-cleanup-service.js'
import {createCrmImportFileCleanupWorker} from '../../crm-operations/import-file-cleanup-worker.js'
import {createCrmPrivacyService} from '../../crm-operations/privacy-previews.js'
import {flushWorkspaceData} from '../workspace-flush.js'
import {streamCrmPrivacyExport} from '../../crm-operations/privacy-export.js'
import {createWorkspaceStore} from '../workspace-store.js'
import {createDbCrmIntakeReadStore} from '../crm-intake-store.js'
import {crmOperationsRoutes} from '../../routes/crm-operations.js'
import {_resetCoalescerForTests} from '../../brain-stream/notify.js'
import type {FilesClientResolver} from '../../files/files-api.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool(),service=createCrmOperationsService(createDbCrmOperationsStore()),cleanup=createCrmImportFileCleanupService()
async function fixture(configure=true,scheme='gs') {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID(),fileId=randomUUID(),jobId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Cleanup fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional contact',$3,'manual')",[contactId,workspaceId,userId])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canConfigure:true,canWrite:true,trustedIdentitySources:[]}}
  const storageUri=`${scheme}://fixture/${workspaceId}/${fileId}`
  await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,updated_at)
    VALUES($1,$2,$3,'private.csv',$4,$5,now()-interval '2 days')`,[fileId,workspaceId,`/private/${fileId}.csv`,storageUri,userId])
  await pool.query(`INSERT INTO crm_import_jobs(id,workspace_id,staged_file_id,entity_kind,status,mapping,mapping_hash,source_hash,total_rows,updated_at)
    VALUES($1,$2,$3,'contact','completed','{}',repeat('a',64),repeat('a',64),1,now()-interval '2 days')`,[jobId,workspaceId,fileId])
  await pool.query(`INSERT INTO crm_import_rows(workspace_id,job_id,row_number,input_hash,status,entity_id) VALUES($1,$2,1,repeat('a',64),'completed',$3)`,[workspaceId,jobId,contactId])
  async function policy(extra:Record<string,unknown>={},expectedVersion=0) {
    return service.execute(context,{kind:'save_privacy_policy',expectedVersion,confirmed:true,intakeReplay:{retentionSeconds:3600},importSourceErasure:{receiptRetentionSeconds:3600,heldSourceIds:[]},...extra})
  }
  if(configure)await policy()
  const preview=()=>cleanup.preview(context,{kind:'preview_import_file_cleanup',fileId,before:new Date().toISOString()})
  const execute=(p:CrmImportFileCleanupPreview)=>cleanup.execute(context,{kind:'execute_import_file_cleanup',previewId:p.id,previewHash:p.previewHash,confirmed:true})
  return {workspaceId,userId,contactId,fileId,jobId,storageUri,context,policy,preview,execute}
}
const count=async(table:string,ws:string)=>Number((await pool.query(`SELECT count(*) count FROM ${table} WHERE workspace_id=$1`,[ws])).rows[0].count)
const worker=(deleteBlob:(key:string)=>Promise<void>)=>createCrmImportFileCleanupWorker({resolver:{forUri:async()=>({deleteBlob})} as unknown as Pick<FilesClientResolver,'forUri'>})
describe('[COMP:crm/file-cleanup] Actual reviewed source and storage lifecycle',()=>{
  afterAll(async()=>{_resetCoalescerForTests();await pool.end();await appPool.end()})
  it.each(['file','consumer'] as const)('protects %s scope before review, deletion and saved receipt recovery',async kind=>{
    const f=await fixture(),department=randomUUID(),departmentOwner=randomUUID(),old=await f.preview()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[departmentOwner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,departmentOwner])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional cleanup department',$3,'team',$1::text,$4)",[department,f.workspaceId,departmentOwner,`team:${department}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional cleanup department','team',$3)",[f.workspaceId,`team:${department}`,department])
    await pool.query(`UPDATE ${kind==='file'?'workspace_files':'entities'} SET sensitivity='confidential',compartments=$2 WHERE id=$1`,[kind==='file'?f.fileId:f.contactId,[`team:${department}`]])
    await expect(f.preview()).rejects.toMatchObject({code:'not_authorized'})
    await expect(f.execute(old)).rejects.toMatchObject({code:'not_authorized'})
    expect(await count('workspace_files',f.workspaceId)).toBe(1)
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,department,f.userId])
    await expect(f.execute(old)).rejects.toMatchObject({details:{reason:'file_cleanup_preview_stale'}})
    const review=await f.preview();expect(review.status).toBe('ready')
    expect((await pool.query('SELECT scope_snapshot FROM crm_import_file_cleanups WHERE id=$1',[review.id])).rows[0].scope_snapshot.compartments).toEqual([`team:${department}`])
    await expect(pool.query("UPDATE crm_import_file_cleanups SET scope_snapshot=jsonb_set(scope_snapshot,'{compartments}','[]') WHERE id=$1",[review.id])).rejects.toMatchObject({code:'23514'})
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[department,f.userId])
    await expect(cleanup.read(f.context,review.id)).rejects.toMatchObject({code:'not_authorized'})
    await expect(f.execute(review)).rejects.toMatchObject({code:'not_authorized'})
    expect((await queryWithRLS(f.userId,'SELECT id FROM crm_import_file_cleanups WHERE id=$1',[review.id])).rows).toEqual([])
    expect(await count('workspace_files',f.workspaceId)).toBe(1)
    await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[department,f.userId])
    expect((await f.execute(review)).receipt.status).toBe('queued')
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[department,f.userId])
    await expect(cleanup.read(f.context,review.id)).rejects.toMatchObject({code:'not_authorized'})
    await expect(f.execute(review)).rejects.toMatchObject({code:'not_authorized'})
    const remove=vi.fn(async()=>{});await worker(remove).tick()
    expect(remove).toHaveBeenCalledWith(`${f.workspaceId}/${f.fileId}`)
    await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[department,f.userId])
    expect(await cleanup.read(f.context,review.id)).toMatchObject({status:'completed'})
  },60_000)
  it('refuses unknown historical receipt scope after department-v2 activation',async()=>{
    const f=await fixture()
    await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspaceId])
    const review=await f.preview()
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
    await expect(cleanup.read(f.context,review.id)).rejects.toMatchObject({code:'not_authorized'})
    await expect(f.execute(review)).rejects.toMatchObject({code:'not_authorized'})
    expect(await count('workspace_files',f.workspaceId)).toBe(1)
  })
  it('requires a current owner, policy, same-workspace file and nonfuture cutoff',async()=>{
    const f=await fixture(false),other=await fixture()
    expect((await f.preview()).blockers).toContainEqual({domain:'crm_privacy_policies',reason:'import_source_erasure_policy_unconfigured',count:1})
    await expect(cleanup.preview({...f.context,actor:{kind:'brain_key',credentialId:randomUUID()}},{kind:'preview_import_file_cleanup',fileId:f.fileId,before:new Date().toISOString()})).rejects.toMatchObject({code:'not_authorized'})
    await expect(cleanup.preview(f.context,{kind:'preview_import_file_cleanup',fileId:other.fileId,before:new Date().toISOString()})).rejects.toMatchObject({code:'not_authorized'})
    await expect(cleanup.preview(f.context,{kind:'preview_import_file_cleanup',fileId:f.fileId,before:new Date(Date.now()+60000).toISOString()})).rejects.toMatchObject({code:'invalid_input'})
    await f.policy();const p=await f.preview()
    await expect(other.execute(p)).rejects.toMatchObject({code:'not_found'})
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(f.execute(p)).rejects.toMatchObject({code:'not_authorized'})
  })
  it('blocks an active consumer, missing lineage, noncanonical object and explicit file/contact holds',async()=>{
    for(const change of ['active','lineage','object','file','contact']) {
      const f=await fixture()
      if(change==='active')await pool.query("UPDATE crm_import_jobs SET status='running' WHERE id=$1",[f.jobId])
      if(change==='lineage')await pool.query('DELETE FROM crm_import_jobs WHERE id=$1',[f.jobId])
      if(change==='object')await pool.query("UPDATE workspace_files SET storage_uri='gs://fixture/arbitrary-object' WHERE id=$1",[f.fileId])
      if(['file','contact'].includes(change))await f.policy({retention:{scheduled:false,intervalSeconds:60,resolvedSubmissionsSeconds:null,openSubmissions:null,importReceiptsSeconds:null,deliveryReceiptsSeconds:null,auditSeconds:null,financialRecordsSeconds:null,holds:[{domain:change,id:change==='file'?f.fileId:f.contactId}]}},1)
      const p=await f.preview();expect(p.status,change).toBe('blocked')
      await expect(f.execute(p)).rejects.toMatchObject({details:{reason:'file_cleanup_preview_blocked'}})
      expect(await count('workspace_files',f.workspaceId)).toBe(1)
    }
  })
  it('discovers independent and foreign-workspace FK consumers instead of cascading them away',async()=>{
    const f=await fixture(),other=await fixture()
    await pool.query('CREATE TABLE cleanup_test_reference(id uuid PRIMARY KEY,file_id uuid REFERENCES workspace_files(id) ON DELETE CASCADE)')
    try {
      await pool.query('INSERT INTO cleanup_test_reference VALUES($1,$2)',[randomUUID(),f.fileId])
      expect((await f.preview()).blockers).toContainEqual({domain:'cleanup_test_reference',reason:'shared_source_file_reference',count:1})
    }finally{await pool.query('DROP TABLE cleanup_test_reference')}
    await pool.query(`INSERT INTO crm_import_jobs(workspace_id,staged_file_id,entity_kind,status,mapping,mapping_hash,source_hash,total_rows,updated_at)
      VALUES($1,$2,'contact','completed','{}',repeat('a',64),repeat('a',64),0,now()-interval '2 days')`,[other.workspaceId,f.fileId])
    expect((await f.preview()).blockers).toContainEqual({domain:'crm_import_jobs',reason:'shared_source_file_reference',count:1})
  })
  it('hashes every receipt beyond a first page and rejects changed rows or policy',async()=>{
    const f=await fixture()
    for(let i=2;i<=270;i++)await pool.query(`INSERT INTO crm_import_rows(workspace_id,job_id,row_number,input_hash,status) VALUES($1,$2,$3,repeat('b',64),'failed')`,[f.workspaceId,f.jobId,i])
    const p=await f.preview();expect(p.status).toBe('ready')
    expect(p.domains).toContainEqual({domain:'crm_import_rows',action:'delete',count:270})
    await pool.query("UPDATE crm_import_rows SET updated_at=clock_timestamp() WHERE job_id=$1 AND row_number=270",[f.jobId])
    await expect(f.execute(p)).rejects.toMatchObject({details:{reason:'file_cleanup_preview_stale'}})
    const fresh=await f.preview();await f.policy({importSourceErasure:{receiptRetentionSeconds:7200,heldSourceIds:[]}},1)
    await expect(f.execute(fresh)).rejects.toMatchObject({details:{reason:'file_cleanup_preview_stale'}})
    expect(await count('workspace_files',f.workspaceId)).toBe(1)
  })
  it('atomically retires copies and queues bytes; failed deletion remains visible and replay safe across reset/restart',async()=>{
    const f=await fixture()
    await pool.query("INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor) VALUES('workspace_file',$1,1,'{\"private\":\"Old path\"}',now()-interval '1 minute',now(),'human_edit')",[f.fileId])
    await pool.query("INSERT INTO correction_audit(workspace_id,action,primitive,row_id,row_snapshot) VALUES($1,'soft_delete','workspace_file',$2,'{\"private\":\"Old path\"}')",[f.workspaceId,f.fileId])
    await pool.query("INSERT INTO workspace_audit_log(workspace_id,actor_user_id,event_type,subject_id,details) VALUES($1,$2,'file.uploaded',$3,'{\"private\":\"Old path\"}')",[f.workspaceId,f.userId,f.fileId])
    const p=await f.preview();expect(p.status).toBe('ready')
    const result=await f.execute(p);expect(result.receipt.status).toBe('queued')
    expect(await count('workspace_files',f.workspaceId)).toBe(0);expect(await count('crm_import_rows',f.workspaceId)).toBe(0)
    expect((await pool.query('SELECT before_image FROM brain_row_versions WHERE row_id=$1',[f.fileId])).rows[0].before_image).toBeNull()
    const pending=await createCrmPrivacyService().preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})
    expect(pending.blockers).toContainEqual({domain:'crm_import_file_cleanups',reason:'source_file_cleanup_pending',count:1})
    const failed=vi.fn(async()=>{throw new Error('Private provider diagnostic')})
    await worker(failed).tick();expect(failed).toHaveBeenCalledTimes(1)
    expect(await cleanup.read(f.context,p.id)).toMatchObject({status:'failed',errorCode:'file_cleanup_failed'})
    const stored=(await pool.query('SELECT * FROM crm_import_file_cleanups WHERE id=$1',[p.id])).rows[0]
    expect(JSON.stringify(stored)).not.toContain('Private provider diagnostic')
    expect((await f.execute(p)).duplicate).toBe(true)
    await flushWorkspaceData(f.userId,f.workspaceId)
    expect(await count('crm_import_file_cleanups',f.workspaceId)).toBe(1)
    // Simulate a worker that claimed this retry and died before its acknowledgement.
    await pool.query("UPDATE crm_import_file_cleanups SET status='leased',error_code=NULL,lease_token=$2,leased_until=clock_timestamp()-interval '1 second' WHERE id=$1",[p.id,randomUUID()])
    const remove=vi.fn(async()=>{})
    await Promise.all([worker(remove).tick(),worker(remove).tick()])
    expect(remove).toHaveBeenCalledTimes(1);expect(remove).toHaveBeenCalledWith(`${f.workspaceId}/${f.fileId}`)
    expect(await cleanup.read(f.context,p.id)).toMatchObject({status:'completed',errorCode:null})
    expect((await pool.query('SELECT storage_uri FROM crm_import_file_cleanups WHERE id=$1',[p.id])).rows[0].storage_uri).toBeNull()
    expect((await f.execute(p)).receipt.status).toBe('completed')
  })
  it('rolls back file removal if saving the queue fails and refuses concurrent privacy writers',async()=>{
    const f=await fixture(),p=await f.preview(),writer=await pool.connect()
    try {
      await writer.query('BEGIN');await writer.query("UPDATE entities SET display_name='Concurrent edit' WHERE id=$1",[f.contactId])
      await expect(f.execute(p)).rejects.toMatchObject({details:{reason:'privacy_operation_busy'}})
    }finally{await writer.query('ROLLBACK');writer.release()}
    await pool.query("ALTER TABLE crm_import_file_cleanups ADD CONSTRAINT fixture_refuse_queue CHECK(status<>'queued')")
    try {
      await expect(f.execute(p)).rejects.toMatchObject({details:{reason:'file_cleanup_failed'}})
      expect(await count('workspace_files',f.workspaceId)).toBe(1);expect(await count('crm_import_rows',f.workspaceId)).toBe(1)
      expect((await pool.query('SELECT status FROM crm_import_file_cleanups WHERE id=$1',[p.id])).rows[0].status).toBe('ready')
    }finally{await pool.query('ALTER TABLE crm_import_file_cleanups DROP CONSTRAINT fixture_refuse_queue')}
  })
  it('rejects late history and minimizes late audit after source retirement',async()=>{
    const f=await fixture();await f.execute(await f.preview())
    await expect(pool.query("INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor) VALUES('workspace_file',$1,1,'{\"private\":true}',now()-interval '1 minute',now(),'human_edit')",[f.fileId])).rejects.toMatchObject({code:'55P03'})
    await pool.query("INSERT INTO correction_audit(workspace_id,action,primitive,row_id,row_snapshot) VALUES($1,'soft_delete','workspace_file',$2,'{\"private\":true}')",[f.workspaceId,f.fileId])
    expect((await pool.query('SELECT row_snapshot FROM correction_audit WHERE row_id=$1',[f.fileId])).rows[0].row_snapshot).toEqual({erased:true})
    await worker(async()=>{}).tick()
  })
  it('deletes actual disposable local bytes and their metadata before acknowledging completion',async()=>{
    const f=await fixture(true,'file'),baseDir=await mkdtemp(join(tmpdir(),'crm-cleanup-bytes-'))
    try {
      const storage=createLocalFilesClient({baseDir}),key=`${f.workspaceId}/${f.fileId}`
      await storage.writeBlob(key,Buffer.from('email\nfictional@example.com\n'),{workspaceId:f.workspaceId,mime:'text/csv'})
      const p=await f.preview();await f.execute(p)
      expect((await storage.readBlob(key))?.bytes.toString()).toContain('fictional@example.com')
      await createCrmImportFileCleanupWorker({resolver:{forUri:async()=>storage}}).tick()
      expect(await storage.readBlob(key)).toBeNull()
      expect(await cleanup.read(f.context,p.id)).toMatchObject({status:'completed'})
      await storage.deleteBlob(key) // Missing-object deletion is replay-safe.
    }finally{await rm(baseDir,{recursive:true,force:true})}
  })
  it('retains read-only directory files and typed shared references',async()=>{
    const f=await fixture()
    await pool.query(`UPDATE workspace_files SET metadata=$2::jsonb WHERE id=$1`,[f.fileId,JSON.stringify({localDirectory:{readOnly:true,connectorInstanceId:randomUUID(),relativePath:'source.csv',fingerprint:'fixture'}})])
    expect((await f.preview()).blockers.some(b=>b.reason==='read_only_source_file')).toBe(true)
    await pool.query(`UPDATE workspace_files SET metadata='{}' WHERE id=$1`,[f.fileId])
    await pool.query("INSERT INTO entity_link_types(edge_type,description) VALUES('cleanup_fixture','Cleanup fixture edge') ON CONFLICT DO NOTHING")
    await pool.query(`INSERT INTO entity_links(workspace_id,source_kind,source_id,target_kind,target_id,edge_type,source,user_id) VALUES($1,'file',$2,'contact',$3,'cleanup_fixture','manual',$4)`,[f.workspaceId,f.fileId,f.contactId,f.userId])
    expect((await f.preview()).blockers).toContainEqual({domain:'entity_links',reason:'shared_source_file_reference',count:1})
  })
  it('exposes owner-only routes and safely projected exports with actual app-role isolation',async()=>{
    const f=await fixture(),other=await fixture()
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=f.userId;next()})
    app.use('/api/crm',crmOperationsRoutes({workspaceStore:createWorkspaceStore(),readStore:createDbCrmIntakeReadStore(),service}))
    const preview=await request(app).post(`/api/crm/${f.workspaceId}/operations/privacy/file-cleanup-preview`).send({fileId:f.fileId,before:new Date().toISOString()})
    expect(preview.status).toBe(200);expect(preview.body.status).toBe('ready')
    const result=await request(app).post(`/api/crm/${f.workspaceId}/operations/privacy/file-cleanup-execute`).send({previewId:preview.body.id,previewHash:preview.body.previewHash,confirmed:true})
    expect(result.status).toBe(200);expect(result.body.status).toBe('queued')
    expect((await request(app).get(`/api/crm/${f.workspaceId}/operations/privacy/file-cleanups/${preview.body.id}`)).body.status).toBe('queued')
    let output='';for await(const line of streamCrmPrivacyExport(f.context))output+=line
    const records=output.trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.type==='record' && row.domain==='crm_import_file_cleanups')
    expect(records).toHaveLength(1);expect(JSON.stringify(records)).not.toContain(f.storageUri);expect(JSON.stringify(records)).not.toContain(preview.body.previewHash)
    const client=await appPool.connect()
    try {
      await client.query('BEGIN');await client.query("SELECT set_config('app.current_user_id',$1,true)",[other.userId])
      expect((await client.query('SELECT id FROM crm_import_file_cleanups WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
      await expect(client.query('DELETE FROM crm_import_file_cleanups WHERE workspace_id=$1',[f.workspaceId])).resolves.toMatchObject({rowCount:0})
    }finally{await client.query('ROLLBACK');client.release()}
    await worker(async()=>{}).tick()
  })
})
