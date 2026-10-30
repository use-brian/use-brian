import {bindDepartmentOfficeKnowledge} from '../generation-evidence.js'
import {readOfficeGenerationRecovery,resumeOfficeGeneration} from '../generation-recovery.js'
import {templateBundle,completeSpreadsheetSnapshot} from '../../../../core/src/office/__tests__/fixtures.js'
import {createOfficeGenerationWorker} from '../generation-worker.js'
import {publishDepartmentOfficeSnapshot} from '../generation-publication.js'
import {createOfficeTemplateBundleReader} from '../release-runtime.js'
import {createFilesApi} from '../../files/files-api.js'
import {createDbWorkspaceFilesStore} from '../../db/workspace-files-store.js'
import {buildStorageKey,buildStorageUri} from '../../files/gcs-client.js'
import {createOfficeLiveStore} from '../../db/office-live.js'
import {randomUUID,createHash} from 'node:crypto'
import express,{type ErrorRequestHandler} from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool,queryWithRLS} from '../../db/client.js'
import {officeArtifactStore} from '../../db/office-artifacts.js'
import {officeGenerationStore} from '../../db/office-generation.js'
import {createOfficeTemplateStore} from '../../db/office-templates.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {createOfficeService} from '../service.js'
import {officeArtifactRoutes} from '../../routes/office-artifacts.js'
import {WorkspaceAccessError} from '../../workspace-access/policy.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),secret=randomUUID()
afterAll(async()=>{await getAppPool().end();await pool.end()})
const service=createOfficeService({generationAvailable:()=>true,createShell:officeArtifactStore.createShell,
  deleteEmptyShell:officeArtifactStore.deleteEmptyShell,getArtifact:officeArtifactStore.get,
  raiseScope:officeArtifactStore.raiseScope,resolveAccess:async()=>null,createJob:officeGenerationStore.create,
  latestJob:officeGenerationStore.latestForArtifact,getSnapshot:async()=>null})
const app=express()
app.use(express.json(),requireAuth(secret))
app.use('/office',officeArtifactRoutes({service,generationAvailable:()=>true,list:async()=>[],
  restoreVersion:async()=>null,getArtifact:officeArtifactStore.get,resolveAccess:async()=>null,
  listVersions:async()=>[],previewVersion:async()=>null,nameVersion:async()=>false,copyVersion:async()=>null,
  listSharing:async()=>({status:'unavailable'}),setGrant:async()=>false,revokeGrant:async()=>false,
  setDefaultWorkspaceRole:async()=>false,canRestoreVersion:async()=>false}))
app.use(((error,_req,res,_next)=>{
  if(error instanceof WorkspaceAccessError)return void res.status(error.status).json({error:error.code})
  res.status(500).json({error:error instanceof Error?error.message:'unexpected_fixture_error'})
}) as ErrorRequestHandler)
async function fixture(family:'document'|'presentation'|'spreadsheet'='document',state='ready') {
  const userId=randomUUID(),workspaceId=randomUUID(),assistantId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic cutover Office',$2,true)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
  const groups=createDbWorkspaceGroupStore(),department=await groups.createTeam(userId,workspaceId,{name:'Personal',key:'personal'})
  await groups.addMember(userId,department.id,userId)
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Primary',$2,$3,'primary','confidential')",[assistantId,userId,workspaceId])
  await queryWithRLS(userId,'INSERT INTO workspace_group_assistants(group_id,assistant_id) VALUES($1,$2)',[department.id,assistantId])
  await queryWithRLS(userId,"SELECT department_set_home($1,'user',$2,$3)",[workspaceId,userId,department.id])
  await queryWithRLS(userId,"SELECT department_set_home($1,'assistant',$2,$3)",[workspaceId,assistantId,department.id])
  await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1',[assistantId,department.id])
  await pool.query('UPDATE workspace_access_policies SET access_mode=$2,setup_state=$3,default_department_id=$4 WHERE workspace_id=$1',[workspaceId,'departments',state,department.id])
  const session=await authSessionStore.create(userId,{deviceLabel:'Synthetic fixture',userAgent:null,ipAddress:null})
  const token=createTokens(userId,secret,session!).accessToken
  const source=randomUUID()
  await pool.query("INSERT INTO knowledge_entries(id,workspace_id,path,title,content,sensitivity,compartments) VALUES($1,$2,$1::uuid::text,'Synthetic knowledge','Fictional source','internal',$3)",[source,workspaceId,[department.compartmentKey]])
  const draft=await officeArtifactStore.createShell({userId,workspaceId,family,mode:'template',title:'Synthetic template',templateVersionId:null,capabilityVersion:1,sensitivity:'internal'})
  const templates=createOfficeTemplateStore()
  const template=await templates.createDraft({userId,workspaceId,family,name:'Synthetic template',description:'Fixture',sensitivity:'internal',draftArtifactId:draft.id})
  const bundle=structuredClone(templateBundle(family==='spreadsheet'?'document':family))
  if(family==='spreadsheet') {
    const snapshot=completeSpreadsheetSnapshot();snapshot.resources=[]
    for(const sheet of snapshot.worksheets)sheet.images=[]
    bundle.family='spreadsheet';bundle.snapshot=snapshot;bundle.fields=[];bundle.slideRecipes=[]
  }
  bundle.workspaceId=workspaceId;bundle.snapshot.workspaceId=workspaceId;bundle.status='admitted'
  const bytes=Buffer.from(JSON.stringify(bundle)),hash=createHash('sha256').update(bytes).digest('hex')
  const blobs=new Map<string,Buffer>();let duringIO=async()=>{}
  const gcs={writeBlob:async(k:string,b:Buffer)=>{blobs.set(k,b);await duringIO()},deleteBlob:async(k:string)=>{blobs.delete(k)},
    readBlob:async(k:string)=>blobs.has(k)?{bytes:blobs.get(k)!,mime:'application/json'}:null}
  const resolver={forWorkspace:async()=>({gcs:gcs as never,bucket:'fixture',byo:true}),forUri:async()=>gcs as never}
  const filesApi=createFilesApi({resolver,store:createDbWorkspaceFilesStore(),auditStore:{append:async()=>{}} as never})
  const file=randomUUID()
  await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,compartments) VALUES($1,$2,$1::uuid::text,'bundle.json',$4,$3)",[file,workspaceId,[department.compartmentKey],buildStorageUri('fixture',workspaceId,file)])
  blobs.set(buildStorageKey(workspaceId,file),bytes)
  const version=await templates.addVersion({userId,templateId:template.id,workspaceId,bundleFileId:file,bundleHash:hash,capabilityVersion:1,locales:['en'],tags:[],whenToUse:[],whenNotToUse:[],exampleRequests:[],fieldSchema:{},admissionReceipt:{},provenance:{},resourceIds:[],status:'admitted'})
  const input={workspaceId,assistantId,family,outcome:'Prepare a fictional report',audience:'Personal',sourceHandles:[`knowledge:${source}`],templateId:version.id,additionalContext:'Use only fictional facts.',destination:{kind:'department',departmentId:department.id},idempotencyKey:randomUUID()}
  const post=(patch:Record<string,unknown>={})=>request(app).post('/office/artifacts').set('Authorization',`Bearer ${token}`).send({...input,...patch})
  return {resolver,filesApi,bundle,blobs,during(fn:()=>Promise<void>){duringIO=fn},userId,workspaceId,assistantId,department,source,draft,template,version,session:session!,input,post}
}
describe('[COMP:api/organization-cutover] v2 Office generation before and after activation',()=>{
  it.each(['document','presentation','spreadsheet'] as const)('admits %s with its real source and template into Personal',async family=>{
    const f=await fixture(family),response=await f.post()
    expect(response.status,JSON.stringify(response.body)).toBe(202)
    const artifact=await officeArtifactStore.get(f.userId,response.body.artifactId)
    expect(artifact).toMatchObject({family,compartments:[f.department.compartmentKey],templateVersionId:f.version.id})
    const job=await officeGenerationStore.get(f.userId,response.body.jobId)
    expect(job).toMatchObject({status:'queued',authorityProjection:{compartments:[f.department.compartmentKey],creationBinding:{protocol:'office_department_v2'}}})
    expect((await f.post()).body).toEqual(response.body)
    expect((await f.post({outcome:'A changed request'})).status).toBe(409)
    expect((await pool.query("SELECT id FROM office_artifacts WHERE workspace_id=$1 AND mode='artifact'",[f.workspaceId])).rows).toHaveLength(1)
    const claimed=await officeGenerationStore.claim({userId:f.userId,leaseToken:randomUUID(),leaseMs:60_000})
    expect(claimed?.id).toBe(job!.id)
  })
  it.each(['document','presentation','spreadsheet'] as const)('runs %s through the real worker, export/reopen and atomic live publication',async family=>{
    const f=await fixture(family),created=await f.post()
    expect(created.status,JSON.stringify(created.body)).toBe(202)
    const reader=createOfficeTemplateBundleReader({filesApi:f.filesApi,templates:createOfficeTemplateStore(),artifacts:officeArtifactStore})
    const worker=createOfficeGenerationWorker({store:officeGenerationStore,workerUserId:f.userId,buildPipelineDeps(job){return {
      resolveAuthority:async()=>({...job.authorityProjection as object,clearance:'confidential'} as never),
      selectTemplate:async()=>({template:(await reader(f.userId,f.workspaceId,f.version.id))!,sourceScope:{sensitivity:'internal',compartments:[f.department.compartmentKey!],projectIds:[]}}),
      retrieveBrain:async()=>{const entries=[{handle:`knowledge:${f.source}`,excerpt:'Synthetic knowledge\nFictional source',sensitivity:'internal' as const,compartments:[f.department.compartmentKey!],projectIds:[]}];await bindDepartmentOfficeKnowledge(job,entries);return entries;},
      inspectUrl:async()=>[],planClaims:async()=>[],
      construct:async(_brief,_evidence,_claims,template)=>({...structuredClone(template.snapshot),artifactId:job.artifactId,workspaceId:f.workspaceId,templateVersionId:f.version.id}),
      processMedia:async snapshot=>snapshot,resolveResource:async()=>null,cancelled:async()=>false,
      renderValidation:async(snapshot,{exportBytes})=>({ok:true,issues:[],candidateHash:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),exportHash:createHash('sha256').update(exportBytes).digest('hex')}),
      commit:async snapshot=>{const version=await publishDepartmentOfficeSnapshot({job,leaseToken:job.leaseToken!,snapshot,resolver:f.resolver,storageLimitBytes:1e9});return {artifactId:job.artifactId,version:version.version}},
    }}})
    expect(await worker.runOnce(),JSON.stringify(await officeGenerationStore.get(f.userId,created.body.jobId))).toBe('completed')
    expect(await officeGenerationStore.get(f.userId,created.body.jobId)).toMatchObject({status:'completed'})
    expect(await createOfficeLiveStore().get(f.userId,created.body.artifactId)).not.toBeNull()
    const versions=await officeArtifactStore.listVersions(f.userId,created.body.artifactId)
    expect(versions).toHaveLength(1)
    const provenance=(await pool.query('SELECT source_kind,source_id,required_compartments FROM office_artifact_sources WHERE artifact_id=$1',[created.body.artifactId])).rows
    expect(provenance).toContainEqual({source_kind:'brain',source_id:`knowledge:${f.source}`,required_compartments:[f.department.compartmentKey]})
    expect((await queryWithRLS(f.userId,'SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolbypassrls:false,rolsuper:false})
    const file=(await pool.query('SELECT f.* FROM workspace_files f JOIN office_generation_file_bindings b ON b.file_id=f.id WHERE b.job_id=$1',[created.body.jobId])).rows[0]
    expect(file.compartments).toEqual([f.department.compartmentKey])
    await expect(queryWithRLS(f.userId,"UPDATE workspace_files SET name='changed' WHERE id=$1 RETURNING id",[file.id])).resolves.toMatchObject({rows:[]})
    expect((await pool.query("SELECT id FROM office_generation_events WHERE job_id=$1 AND code='office.job.completed'",[created.body.jobId])).rows).toHaveLength(1)
  })
  it.each(['source','session','cancel','quota'] as const)('rolls back late %s changes, including staged bytes',async change=>{
    const f=await fixture(),created=await f.post(),job=await officeGenerationStore.claim({userId:f.userId,leaseToken:randomUUID(),leaseMs:60_000})
    const snapshot={...f.bundle.snapshot,artifactId:created.body.artifactId,workspaceId:f.workspaceId,templateVersionId:f.version.id}
    const before=new Set(f.blobs.keys())
    f.during(async()=>{
      if(change==='source')await pool.query('UPDATE knowledge_entries SET scope_held=true WHERE id=$1',[f.source])
      if(change==='session')await authSessionStore.revokeForUser(f.userId,f.session.id)
      if(change==='cancel')await pool.query('UPDATE office_generation_jobs SET cancel_requested_at=now() WHERE id=$1',[job!.id])
    })
    const resolver=change==='quota'?{...f.resolver,forWorkspace:async()=>({...await f.resolver.forWorkspace(),byo:false})}:f.resolver
    await expect(publishDepartmentOfficeSnapshot({job:job!,leaseToken:job!.leaseToken!,snapshot,resolver,storageLimitBytes:0})).rejects.toThrow()
    expect(new Set(f.blobs.keys())).toEqual(before)
    expect((await officeArtifactStore.get(f.userId,created.body.artifactId))?.headVersion).toBe(0)
    expect((await pool.query('SELECT id FROM office_artifact_versions WHERE artifact_id=$1',[created.body.artifactId])).rows).toEqual([])
  })
  it('binds ambient knowledge exactly and refuses publication after it changes',async()=>{
    const f=await fixture(),created=await f.post(),job=await officeGenerationStore.claim({userId:f.userId,leaseToken:randomUUID(),leaseMs:60_000})
    const ambient=randomUUID()
    await pool.query("INSERT INTO knowledge_entries(id,workspace_id,path,title,content,sensitivity,compartments) VALUES($1,$2,$1::uuid::text,'Ambient','Fictional ambient','internal',$3)",[ambient,f.workspaceId,[f.department.compartmentKey]])
    const entry={handle:`knowledge:${ambient}`,excerpt:'Ambient\nFictional ambient',sensitivity:'internal',compartments:[f.department.compartmentKey!],projectIds:[]}
    await expect(bindDepartmentOfficeKnowledge(job!,[{...entry,excerpt:'Stale content'}])).rejects.toThrow('office_source_changed')
    await bindDepartmentOfficeKnowledge(job!,[entry])
    await pool.query("UPDATE knowledge_entries SET content='Changed ambient' WHERE id=$1",[ambient])
    await expect(publishDepartmentOfficeSnapshot({job:job!,leaseToken:job!.leaseToken!,snapshot:{...f.bundle.snapshot,artifactId:created.body.artifactId,workspaceId:f.workspaceId,templateVersionId:f.version.id},resolver:f.resolver,storageLimitBytes:1e9})).rejects.toThrow('office_source_changed')
    expect((await officeArtifactStore.get(f.userId,created.body.artifactId))?.headVersion).toBe(0)
  })
  it('resumes a template choice in a ready v2 workspace using renewed canonical source evidence',async()=>{
    const f=await fixture('presentation'),created=await f.post({templateId:undefined})
    expect(created.status).toBe(202)
    const job=await officeGenerationStore.claim({userId:f.userId,leaseToken:randomUUID(),leaseMs:60_000})
    await officeGenerationStore.finish({userId:f.userId,jobId:job!.id,leaseToken:job!.leaseToken!,status:'needs_input',stage:'needs_input',errorCode:'template_ambiguous'})
    const choices=await readOfficeGenerationRecovery(f.userId,created.body.artifactId,job!.id)
    expect(choices.canResumeTemplate).toBe(true)
    expect(choices.templateChoices).toContainEqual({templateVersionId:f.version.id,name:'Synthetic template'})
    await resumeOfficeGeneration(f.userId,{artifactId:created.body.artifactId,jobId:job!.id,templateVersionId:f.version.id})
    expect(await officeGenerationStore.get(f.userId,job!.id)).toMatchObject({status:'queued',templateVersionId:f.version.id,brief:{templateId:f.version.id}})
    expect((await officeGenerationStore.claim({userId:f.userId,leaseToken:randomUUID(),leaseMs:60_000}))?.id).toBe(job!.id)
  })
  it('supports the same template generation while setup is still legacy',async()=>{
    const f=await fixture('presentation','legacy'),response=await f.post()
    expect(response.status,JSON.stringify(response.body)).toBe(202)
    expect((await officeArtifactStore.get(f.userId,response.body.artifactId))?.compartments).toEqual([f.department.compartmentKey])
  })
  it('rejects held and foreign sources without publishing a draft or job',async()=>{
    const f=await fixture(),foreign=await fixture()
    await pool.query('UPDATE knowledge_entries SET scope_held=true WHERE id=$1',[f.source])
    expect((await f.post()).status).toBe(404)
    expect((await f.post({sourceHandles:[`knowledge:${foreign.source}`]})).status).toBe(404)
    expect((await f.post({sourceHandles:[],templateId:foreign.version.id})).status).toBe(404)
    expect((await pool.query("SELECT id FROM office_artifacts WHERE workspace_id=$1 AND mode='artifact'",[f.workspaceId])).rows).toEqual([])
    expect((await pool.query('SELECT id FROM office_generation_jobs WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  })
  it('does not claim generation after its authenticated session is revoked',async()=>{
    const f=await fixture(),response=await f.post()
    expect(response.status,JSON.stringify(response.body)).toBe(202)
    await authSessionStore.revokeForUser(f.userId,f.session.id)
    expect(await officeGenerationStore.claim({userId:f.userId,leaseToken:randomUUID(),leaseMs:60_000})).toBeNull()
  })
})
