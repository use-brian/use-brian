import {randomUUID,createHash} from 'node:crypto'
import request from 'supertest'
import {Router} from 'express'
import type {DocumentSnapshot} from '@use-brian/office-model'
import {createOfficeLiveStore} from '../office-live.js'
import {createFilesApi} from '../../files/files-api.js'
import type {GcsFilesClient} from '../../files/gcs-client.js'
import {createDbWorkspaceFilesStore} from '../workspace-files-store.js'
import {getWorkspaceFileReadProjection} from '../workspace-files.js'
import {getWorkspaceMembershipWithClearanceSystem} from '../workspace-store.js'
import {createOfficeResourceReader} from '../../office/resource-read.js'
import {resolveOfficeAccess} from '../../office/access.js'
import {officeResourceRoutes} from '../../routes/office-resources.js'
import {createTestApp} from '../../routes/__tests__/helpers.js'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool,queryWithRLS} from '../client.js'
import {createOfficeArtifactStore,defaultOfficeDbQuery,type OfficeDbQuery} from '../office-artifacts.js'
import {readOfficeProjection,officeProjectionQuery} from '../office-read-projection.js'
import {createOfficeCommentStore} from '../office-comments.js'
import {createOfficeGenerationStore} from '../office-generation.js'
import {createOfficeService} from '../../office/service.js'
import {officeArtifactRoutes,type OfficeArtifactsRouteDeps} from '../../routes/office-artifacts.js'
import {officeCollaborationRoutes,type OfficeCollaborationRouteDeps} from '../../routes/office-collaboration.js'
import {officeTemplateRoutes,type OfficeTemplatesRouteDeps} from '../../routes/office-templates.js'
import {officeJobRoutes} from '../../routes/office-jobs.js'
import {createOfficeTemplateStore} from '../office-templates.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'
import {runWithAgentAccess} from '../agent-access-context.js'
import {readWorkspaceMemberDirectory} from '../workspace-member-directory.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),artifacts=createOfficeArtifactStore(),templates=createOfficeTemplateStore(),groups=createDbWorkspaceGroupStore()
const hash='a'.repeat(64)
const tables=['office_templates','office_template_versions','office_resources','office_template_resource_refs'] as const
async function fixture(grantLifetimeMs=86_400_000) {
  const workspaceId=randomUUID(),owner=randomUUID(),reader=randomUUID(),editor=randomUUID()
  for(const id of [owner,reader,editor])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Library scope fixture',$2)",[workspaceId,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','internal','assigned'),($1,$3,'member','internal','assigned'),($1,$4,'member','internal','assigned')",[workspaceId,owner,reader,editor])
  const team=await groups.createTeam(owner,workspaceId,{name:'Library department',key:'library-department'})
  await groups.addMember(owner,team.id,editor)
  const artifact=await artifacts.createShell({userId:owner,workspaceId,family:'document',mode:'template',title:'Library draft',templateVersionId:null,capabilityVersion:1,sensitivity:'internal',requiredCompartments:[team.compartmentKey!]})
  const template=await templates.createDraft({userId:owner,workspaceId,family:'document',name:'Library template',description:'Fixture description',sensitivity:'internal',draftArtifactId:artifact.id})
  async function file(compartments=[team.compartmentKey!]) {
    const id=randomUUID()
    await pool.query('INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,compartments) VALUES($1,$2,$3,$4,$5,$6)',[id,workspaceId,'/'+id+'.bin',id+'.bin','fixture://'+id,compartments])
    return id
  }
  const bundleFileId=await file(),resourceFileId=await file()
  const resourceParams={userId:owner,workspaceId,kind:'brand_media' as const,name:'Library image',fileId:resourceFileId,hash,mime:'image/png',licence:{},embeddingRights:'allowed' as const,sensitivity:'internal' as const}
  const resource=await templates.addResource(resourceParams)
  const versionParams={userId:owner,templateId:template.id,workspaceId,bundleFileId,bundleHash:hash,capabilityVersion:1,locales:['en'],tags:[],whenToUse:[],whenNotToUse:[],exampleRequests:[],fieldSchema:{},admissionReceipt:{},provenance:{},resourceIds:[resource.id],status:'admitted' as const}
  const version=await templates.addVersion(versionParams)
  async function grant() {
    const request=randomUUID()
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Library fixture',now()-interval '1 day',now()+$7*interval '1 millisecond',$5,1,'approved',$6,now())`,[request,workspaceId,reader,team.id,hash,owner,grantLifetimeMs])
    return (await pool.query<{id:string}>(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1 RETURNING id`,[request])).rows[0]!.id
  }
  const grantId=await grant()
  const revoke=(id=grantId)=>pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1',[id,owner])
  return {workspaceId,owner,reader,editor,team,artifact,template,file,bundleFileId,resourceFileId,resource,resourceParams,version,versionParams,grantId,grant,revoke}
}
afterAll(async()=>{await getAppPool().end();await pool.end()})

describe('[COMP:api/office-access] current Office library scopes (PG18)',()=>{
  it('deduplicates bytes only inside one durable file scope',async()=>{
    const f=await fixture(),otherTeam=await groups.createTeam(f.owner,f.workspaceId,{name:'Separate library department',key:'separate-library'})
    const sameScope=await templates.addResource({...f.resourceParams,name:'Same file retry'})
    const isolated=await templates.addResource({...f.resourceParams,name:'Same bytes, separate scope',fileId:await f.file([otherTeam.compartmentKey!])})
    expect(sameScope.id).toBe(f.resource.id)
    expect(isolated.id).not.toBe(f.resource.id)
    expect((await pool.query('SELECT file_id FROM office_resources WHERE workspace_id=$1 AND content_hash=$2 ORDER BY file_id',[f.workspaceId,hash])).rows).toHaveLength(2)
  })
  it('admits read-grant metadata but refuses every registry mutation without partial publication',async()=>{
    const f=await fixture()
    expect((await queryWithRLS(f.reader,'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows).toEqual([{rolsuper:false,rolbypassrls:false}])
    expect(await templates.get(f.reader,f.template.id)).toMatchObject({id:f.template.id})
    expect(await templates.getVersion(f.reader,f.version.id)).toMatchObject({id:f.version.id})
    expect(await templates.getResource(f.reader,f.resource.id)).toMatchObject({id:f.resource.id})
    for(const table of tables) {
      expect((await queryWithRLS(f.reader,`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows,table).toHaveLength(1)
      expect((await queryWithRLS(f.reader,`UPDATE ${table} SET workspace_id=workspace_id WHERE workspace_id=$1 RETURNING *`,[f.workspaceId])).rows,table).toHaveLength(0)
      expect((await queryWithRLS(f.reader,`DELETE FROM ${table} WHERE workspace_id=$1 RETURNING *`,[f.workspaceId])).rows,table).toHaveLength(0)
    }
    await expect(templates.addVersion({...f.versionParams,userId:f.reader,bundleHash:'b'.repeat(64)})).rejects.toMatchObject({code:'42501'})
    await expect(templates.addResource({...f.resourceParams,userId:f.reader,hash:'b'.repeat(64)})).rejects.toMatchObject({code:'42501'})
    expect((await pool.query('SELECT current_version_id FROM office_templates WHERE id=$1',[f.template.id])).rows).toEqual([{current_version_id:f.version.id}])
    expect((await pool.query('SELECT id FROM office_template_versions WHERE template_id=$1',[f.template.id])).rows).toHaveLength(1)
  })
  it('publishes an ordinary member version and all declared resources in one statement',async()=>{
    const f=await fixture()
    const version=await templates.addVersion({...f.versionParams,userId:f.editor,bundleHash:'b'.repeat(64),resourceIds:[f.resource.id,f.resource.id]})
    expect(version.version).toBe(2)
    expect((await queryWithRLS(f.editor,'SELECT resource_id FROM office_template_resource_refs WHERE template_version_id=$1',[version.id])).rows).toEqual([{resource_id:f.resource.id}])
    expect((await templates.list(f.editor,f.workspaceId))[0]).toMatchObject({currentVersionId:version.id})
  })
  it('publishes a copied artifact and every required child atomically, while read-only grants leave no shell',async()=>{
    const f=await fixture(),copiedId=randomUUID()
    const input={artifactId:copiedId,versionId:randomUUID(),workspaceId:f.workspaceId,family:'document' as const,title:'Copied department document',templateVersionId:null,
      capabilityVersion:1,sensitivity:'internal' as const,compartments:[f.team.compartmentKey!],projectIds:[],snapshotFileId:f.bundleFileId,
      snapshotHash:hash,operationClock:new Uint8Array([1]),schemaVersion:1,snapshotCapabilityVersion:1,liveUpdate:new Uint8Array([2]),
      liveStateVector:new Uint8Array([3]),sourceArtifactId:f.artifact.id,sourceVersionId:String(f.version.id)}
    await expect(artifacts.createCopiedArtifact({userId:f.owner,...input})).resolves.toMatchObject({version:1})
    expect((await pool.query('SELECT head_version FROM office_artifacts WHERE id=$1',[copiedId])).rows).toEqual([{head_version:'1'}])
    expect((await pool.query('SELECT artifact_id FROM office_artifact_versions WHERE artifact_id=$1',[copiedId])).rows).toHaveLength(1)
    expect((await pool.query('SELECT artifact_id FROM office_collab_documents WHERE artifact_id=$1',[copiedId])).rows).toHaveLength(1)
    expect((await pool.query('SELECT artifact_id FROM office_artifact_sources WHERE artifact_id=$1',[copiedId])).rows).toHaveLength(1)
    const refusedId=randomUUID()
    await expect(artifacts.createCopiedArtifact({userId:f.reader,...input,artifactId:refusedId,versionId:randomUUID()})).rejects.toMatchObject({code:'42501'})
    expect((await pool.query('SELECT id FROM office_artifacts WHERE id=$1',[refusedId])).rows).toHaveLength(0)
  })
  it('rechecks revocation for all metadata and preserves independent live authority',async()=>{
    const f=await fixture(),other=await f.grant();await f.revoke()
    expect(await templates.getVersion(f.reader,f.version.id)).not.toBeNull()
    await f.revoke(other)
    for(const table of tables)expect((await queryWithRLS(f.reader,`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows,table).toHaveLength(0)
  })
  it.each(['holding','retracted','superseded','private','clearance'] as const)('withholds template dependencies after a file becomes %s',async change=>{
    const f=await fixture()
    if(change==='holding')await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[f.resourceFileId])
    if(change==='retracted')await pool.query('UPDATE workspace_files SET retracted_at=now() WHERE id=$1',[f.resourceFileId])
    if(change==='superseded')await pool.query('UPDATE workspace_files SET valid_to=now() WHERE id=$1',[f.resourceFileId])
    if(change==='private')await pool.query('UPDATE workspace_files SET user_id=$2 WHERE id=$1',[f.resourceFileId,f.owner])
    if(change==='clearance')await pool.query("UPDATE workspace_files SET sensitivity='confidential' WHERE id=$1",[f.resourceFileId])
    for(const table of tables)expect((await queryWithRLS(f.reader,`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows,table).toHaveLength(0)
  })
  it('checks the linked draft and bundle separately from resource file access',async()=>{
    const f=await fixture()
    await pool.query('UPDATE office_artifacts SET visibility_user_ids=$2 WHERE id=$1',[f.artifact.id,[f.owner]])
    expect(await templates.getResource(f.reader,f.resource.id)).not.toBeNull()
    expect(await templates.get(f.reader,f.template.id)).toBeNull()
    await pool.query("UPDATE office_artifacts SET visibility_user_ids='{}' WHERE id=$1",[f.artifact.id])
    await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[f.bundleFileId])
    expect(await templates.getVersion(f.reader,f.version.id)).toBeNull()
    expect(await templates.get(f.reader,f.template.id)).toBeNull()
  })
  it('refuses a late resource-authority loss without leaving a version, ref, or head change',async()=>{
    const f=await fixture()
    await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[f.resourceFileId])
    await expect(templates.addVersion({...f.versionParams,bundleHash:'b'.repeat(64)})).rejects.toThrow()
    expect((await pool.query('SELECT current_version_id FROM office_templates WHERE id=$1',[f.template.id])).rows).toEqual([{current_version_id:f.version.id}])
    expect((await pool.query('SELECT id FROM office_template_versions WHERE template_id=$1',[f.template.id])).rows).toHaveLength(1)
    expect((await pool.query('SELECT resource_id FROM office_template_resource_refs WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1)
  })
  it('rejects a newly declared inaccessible resource atomically after version insertion',async()=>{
    const f=await fixture(),team=await groups.createTeam(f.owner,f.workspaceId,{name:'Other library department',key:'other'})
    const resource=await templates.addResource({...f.resourceParams,fileId:await f.file([team.compartmentKey!]),hash:'c'.repeat(64)})
    await expect(templates.addVersion({...f.versionParams,userId:f.editor,bundleHash:'b'.repeat(64),resourceIds:[resource.id]})).rejects.toMatchObject({code:'42501'})
    expect((await pool.query('SELECT id FROM office_template_versions WHERE template_id=$1',[f.template.id])).rows).toHaveLength(1)
    expect((await pool.query('SELECT current_version_id FROM office_templates WHERE id=$1',[f.template.id])).rows).toEqual([{current_version_id:f.version.id}])
  })
  it('intersects execution workspace, actor, read, mutation and project ceilings on linked files',async()=>{
    const f=await fixture(),project=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Library project','library project',$3)",[project,f.workspaceId,f.owner])
    await pool.query('UPDATE workspace_files SET project_ids=$2 WHERE id=$1',[f.bundleFileId,[project]])
    const scope={workspaceId:f.workspaceId,userId:f.owner,clearance:'confidential',compartments:[f.team.compartmentKey!],mutationCompartments:[],projectIds:[project]}
    expect(await runWithAgentAccess(scope,()=>templates.get(f.owner,f.template.id))).not.toBeNull()
    await pool.query("UPDATE office_templates SET lifecycle_state='draft' WHERE id=$1",[f.template.id])
    expect(await runWithAgentAccess(scope,()=>templates.saveDraftRouting({userId:f.owner,templateId:f.template.id,routing:{}}))).toBe(false)
    expect(await templates.saveDraftRouting({userId:f.owner,templateId:f.template.id,routing:{}})).toBe(true)
    for(const changed of [{compartments:[]},{projectIds:[]},{workspaceId:randomUUID()}])expect(await runWithAgentAccess({...scope,...changed},()=>templates.get(f.owner,f.template.id))).toBeNull()
    await pool.query('UPDATE workspace_files SET user_id=$2 WHERE id=$1',[f.bundleFileId,f.owner])
    expect(await runWithAgentAccess({...scope,userId:f.reader},()=>templates.get(f.owner,f.template.id))).toBeNull()
  })
  it('rejects cross-workspace file, draft, current-version, parent and resource references',async()=>{
    const f=await fixture(),foreign=await fixture()
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[foreign.workspaceId,f.owner])
    for(const [sql,values] of [
      ['UPDATE office_resources SET file_id=$2 WHERE id=$1',[f.resource.id,foreign.resourceFileId]],
      ['UPDATE office_templates SET draft_artifact_id=$2 WHERE id=$1',[f.template.id,foreign.artifact.id]],
      ['UPDATE office_templates SET current_version_id=$2 WHERE id=$1',[f.template.id,foreign.version.id]],
      ['UPDATE office_templates SET replacement_template_id=$2 WHERE id=$1',[f.template.id,foreign.template.id]],
      ['UPDATE office_template_versions SET parent_version_id=$2 WHERE id=$1',[f.version.id,foreign.version.id]],
      ['UPDATE office_template_resource_refs SET resource_id=$2 WHERE template_version_id=$1',[f.version.id,foreign.resource.id]],
    ] as const)await expect(queryWithRLS(f.owner,sql,[...values])).rejects.toMatchObject({code:'23514'})
  })
  it('keeps legacy unlinked templates constrained by bundle files and declarative resources by sensitivity',async()=>{
    const f=await fixture()
    await pool.query('UPDATE office_templates SET draft_artifact_id=NULL WHERE id=$1',[f.template.id])
    expect(await templates.get(f.reader,f.template.id)).not.toBeNull()
    await f.revoke()
    expect(await templates.get(f.reader,f.template.id)).toBeNull()
    const resource=await templates.addResource({...f.resourceParams,fileId:null,hash:'b'.repeat(64),sensitivity:'public'})
    expect(await templates.getResource(f.reader,resource.id)).not.toBeNull()
    const confidential=await templates.addResource({...f.resourceParams,fileId:null,hash:'c'.repeat(64),sensitivity:'confidential'})
    expect(await templates.getResource(f.reader,confidential.id)).toBeNull()
  })
  it('validates same-workspace version roots and source-artifact references',async()=>{
    const f=await fixture()
    const other=await artifacts.createShell({userId:f.owner,workspaceId:f.workspaceId,family:'document',mode:'template',title:'Other draft',templateVersionId:null,capabilityVersion:1,sensitivity:'internal'})
    const template=await templates.createDraft({userId:f.owner,workspaceId:f.workspaceId,family:'document',name:'Other template',description:'Fixture',sensitivity:'internal',draftArtifactId:other.id})
    const version=await templates.addVersion({...f.versionParams,templateId:template.id,bundleHash:'d'.repeat(64)})
    const source=await artifacts.commitVersion({userId:f.owner,artifactId:other.id,snapshotTitle:'Other draft',expectedVersion:0,snapshotFileId:f.bundleFileId,snapshotHash:hash,operationClock:new Uint8Array(),schemaVersion:1,capabilityVersion:1,origin:'manual',authorType:'user',authorUserId:f.owner,summary:'Fixture'})
    expect(source).not.toBeNull()
    for(const [sql,values] of [
      ['UPDATE office_templates SET current_version_id=$2 WHERE id=$1',[f.template.id,version.id]],
      ['UPDATE office_template_versions SET parent_version_id=$2 WHERE id=$1',[f.version.id,version.id]],
      ['UPDATE office_template_versions SET source_artifact_version_id=$2 WHERE id=$1',[f.version.id,source!.id]],
    ] as const)await expect(queryWithRLS(f.owner,sql,[...values])).rejects.toMatchObject({code:'23514'})
    expect((await queryWithRLS(f.owner,'UPDATE office_template_versions SET source_artifact_version_id=$2 WHERE id=$1 RETURNING id',[version.id,source!.id])).rows).toHaveLength(1)
  })
  it('retains assistant visibility and current membership on resource metadata',async()=>{
    const f=await fixture(),assistant=randomUUID()
    await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Library assistant',$2,$3,'standard')",[assistant,f.workspaceId,f.owner])
    await pool.query('UPDATE workspace_files SET assistant_id=$2 WHERE id=$1',[f.resourceFileId,assistant])
    expect(await templates.getResource(f.owner,f.resource.id)).toBeNull()
    const scope={workspaceId:f.workspaceId,userId:f.owner,clearance:'confidential',compartments:null,projectIds:null}
    expect(await runWithAgentAccess({...scope,visibilityAssistantIds:[]},()=>templates.getResource(f.owner,f.resource.id))).toBeNull()
    expect(await runWithAgentAccess({...scope,visibilityAssistantIds:[assistant]},()=>templates.getResource(f.owner,f.resource.id))).not.toBeNull()
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.owner])
    expect(await runWithAgentAccess({...scope,visibilityAssistantIds:[assistant]},()=>templates.getResource(f.owner,f.resource.id))).toBeNull()
  })

})

async function resourceDeliveryFixture(grantLifetimeMs=86_400_000) {
  const f=await fixture(grantLifetimeMs),bytes=Buffer.from('Office image fixture'),contentHash=createHash('sha256').update(bytes).digest('hex')
  await pool.query("UPDATE workspace_files SET storage_uri=$2,mime='image/png' WHERE id=$1",[f.resourceFileId,`gs://fixture-bucket/${f.workspaceId}/${f.resourceFileId}`])
  await pool.query('UPDATE office_resources SET content_hash=$2 WHERE id=$1',[f.resource.id,contentHash])
  const snapshot:DocumentSnapshot={schemaVersion:1,capabilityVersion:1,artifactId:f.artifact.id,workspaceId:f.workspaceId,family:'document',locale:'en',defaultLanguage:'en',templateVersionId:null,rootId:randomUUID(),title:'Resource fixture',accessibility:{title:'Resource fixture'},
    resources:[{id:f.resource.id,kind:'image',hash:contentHash,mime:'image/png',sensitivity:'internal'}],
    sections:[{id:randomUUID(),page:{widthPt:612,heightPt:792,marginTopPt:72,marginRightPt:72,marginBottomPt:72,marginLeftPt:72,orientation:'portrait'},header:[],footer:[],showPageNumber:false,nodes:[{id:randomUUID(),kind:'image',resourceId:f.resource.id,altText:'Fixture',decorative:false,widthPt:100,heightPt:80}]}]}
  const live=createOfficeLiveStore();await live.initialize({userId:f.owner,artifactId:f.artifact.id,snapshot})
  const gcs={readBlob:async()=>({bytes,mime:'image/png',metadata:{}})} as unknown as GcsFilesClient
  const api=createFilesApi({gcs,store:createDbWorkspaceFilesStore(),auditStore:{append:async()=>{}} as never,bucket:'fixture-bucket'})
  const read=createOfficeResourceReader({filesApi:api,getResource:templates.getResource,membership:getWorkspaceMembershipWithClearanceSystem,readProjection:getWorkspaceFileReadProjection})
  const load=async(userId:string,artifactId:string)=>{
    const [artifact,access,current]=await Promise.all([artifacts.get(userId,artifactId),resolveOfficeAccess(userId,artifactId),live.get(userId,artifactId)])
    return artifact&&access&&current?{artifact,access,snapshot:current.snapshot}:null
  }
  const app=(userId=f.reader)=>createTestApp('/api/office',officeResourceRoutes({load,readResource:read,
    readUpload:async()=>{throw new Error('not an admission test')},persistImage:async()=>{throw new Error('not an admission test')}}),{userId})
  return {...f,bytes,gcs,api,read,live,snapshot,app,url:`/api/office/artifacts/${f.artifact.id}/resources/${f.resource.id}`}
}

describe('[COMP:api/office-resources] real current resource delivery (PG18)',()=>{
  it('serves current read-only grant bytes, bounds lifetime, ignores stale validators and preserves independent access',async()=>{
    const f=await resourceDeliveryFixture(3000)
    const res=await request(f.app()).get(f.url).set('If-None-Match','*').expect(200)
    expect(Buffer.from(res.body)).toEqual(f.bytes);expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.headers.etag).toBeUndefined();expect(Number(res.headers['x-brian-media-valid-for-ms'])).toBeGreaterThan(0)
    expect(Number(res.headers['x-brian-media-valid-for-ms'])).toBeLessThanOrEqual(3000)
    expect((await resolveOfficeAccess(f.reader,f.artifact.id))?.canEdit).toBe(false)
    const other=await f.grant();await f.revoke();await request(f.app()).get(f.url).expect(200)
    await f.revoke(other);const denied=await request(f.app()).get(f.url).expect(404)
    expect(denied.text).not.toContain(f.bytes.toString());expect(denied.headers['x-brian-media-valid-for-ms']).toBeUndefined()
  })
  it('normalizes administrator clearance without bypassing private file visibility',async()=>{
    const f=await resourceDeliveryFixture()
    await pool.query("UPDATE workspace_files SET sensitivity='confidential' WHERE id=$1",[f.resourceFileId])
    await pool.query("UPDATE office_resources SET sensitivity='confidential' WHERE id=$1",[f.resource.id])
    await request(f.app(f.owner)).get(f.url).expect(200)
    await pool.query('UPDATE workspace_files SET user_id=$2 WHERE id=$1',[f.resourceFileId,f.editor])
    await request(f.app(f.owner)).get(f.url).expect(404)
  })
  it.each(['grant','membership','holding','file revision','resource binding','resource sensitivity','artifact deny','reference removal'] as const)('withholds fetched bytes after %s changes during I/O',async change=>{
    const f=await resourceDeliveryFixture(),original=f.gcs.readBlob.bind(f.gcs)
    f.gcs.readBlob=async key=>{
      const result=await original(key)
      if(change==='grant')await f.revoke()
      if(change==='membership')await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.reader])
      if(change==='holding')await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[f.resourceFileId])
      if(change==='file revision')await pool.query("UPDATE workspace_files SET sensitivity='public' WHERE id=$1",[f.resourceFileId])
      if(change==='resource binding')await pool.query('UPDATE office_resources SET file_id=$2 WHERE id=$1',[f.resource.id,await f.file()])
      if(change==='resource sensitivity')await pool.query("UPDATE office_resources SET sensitivity='confidential' WHERE id=$1",[f.resource.id])
      if(change==='artifact deny')await pool.query("INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role,granted_by) VALUES($1,$2,$3,'deny',$4)",[f.artifact.id,f.workspaceId,f.reader,f.owner])
      if(change==='reference removal')await f.live.initialize({userId:f.owner,artifactId:f.artifact.id,snapshot:{...f.snapshot,resources:[],sections:f.snapshot.sections.map(section=>({...section,nodes:[]}))}})
      return result
    }
    const res=await request(f.app()).get(f.url).expect(404)
    expect(res.text).not.toContain(f.bytes.toString());expect(res.headers['x-brian-media-valid-for-ms']).toBeUndefined()
  })
  it('does not project bytes into a different requested workspace',async()=>{
    const f=await resourceDeliveryFixture()
    await request(f.app()).get(f.url+'?workspaceId='+randomUUID()).expect(404)
    await request(f.app()).get(f.url+'?workspaceId='+f.workspaceId).expect(200)
  })
})


// These handlers use the real stores, canonical access resolver and non-owner
// application pool. The only injection schedules a concurrent fixture change.
async function metadataFixture() {
  const f=await resourceDeliveryFixture(),comments=createOfficeCommentStore(),jobs=createOfficeGenerationStore()
  const snapshotBytes=Buffer.from(JSON.stringify(f.snapshot)),snapshotHash=createHash('sha256').update(snapshotBytes).digest('hex')
  await pool.query("UPDATE workspace_files SET storage_uri=$2,mime='application/json' WHERE id=$1",[f.bundleFileId,`gs://fixture-bucket/${f.workspaceId}/${f.bundleFileId}`])
  const readBlob=f.gcs.readBlob.bind(f.gcs);f.gcs.readBlob=async key=>key.includes(f.bundleFileId)?{bytes:snapshotBytes,mime:'application/json',metadata:{workspaceId:f.workspaceId,mime:'application/json'}}:readBlob(key)
  // Ordinary artifact collections deliberately exclude template-mode drafts.
  const listedArtifact=await artifacts.createShell({userId:f.owner,workspaceId:f.workspaceId,family:'document',title:'Listed department document',
    templateVersionId:null,capabilityVersion:1,sensitivity:'internal',requiredCompartments:[f.team.compartmentKey!]})
  const version=await artifacts.commitVersion({userId:f.owner,artifactId:f.artifact.id,snapshotTitle:f.snapshot.title,expectedVersion:0,
    snapshotFileId:f.bundleFileId,snapshotHash,operationClock:new Uint8Array(),schemaVersion:1,capabilityVersion:1,
    origin:'manual',authorType:'user',authorUserId:f.owner,summary:'Metadata fixture version'})
  const thread=await comments.createThread({userId:f.owner,workspaceId:f.workspaceId,artifactId:f.artifact.id,artifactVersionId:version!.id,
    anchor:{kind:'block',targetIds:[f.snapshot.sections[0]!.nodes[0]!.id]},body:'Department comment'})
  const suggestion=await comments.createSuggestion({userId:f.owner,workspaceId:f.workspaceId,artifactId:f.artifact.id,baseVersionId:version!.id,
    proposedByType:'user',commandBatch:[],affectedObjectIds:[]})
  const job=await jobs.create({userId:f.owner,workspaceId:f.workspaceId,artifactId:f.artifact.id,assistantId:null,jobKind:'create',
    brief:{outcome:'Department outcome'},authorityProjection:{},idempotencyKey:randomUUID()})
  await jobs.appendEvent({userId:f.owner,jobId:job.id,workspaceId:f.workspaceId,code:'office.job.queued',values:{},actorType:'user',actorUserId:f.owner})
  await pool.query("UPDATE office_templates SET lifecycle_state='draft',draft_routing=NULL WHERE id=$1",[f.template.id])
  const service=createOfficeService({generationAvailable:()=>false,createShell:artifacts.createShell,deleteEmptyShell:artifacts.deleteEmptyShell,
    getArtifact:artifacts.get,raiseScope:artifacts.raiseScope,resolveAccess:resolveOfficeAccess,createJob:jobs.create,latestJob:jobs.latestForArtifact,getSnapshot:f.live.get})
  let change:(()=>Promise<unknown>)|undefined
  const after=async<T>(pending:Promise<T>):Promise<T>=>{const result=await pending;const fn=change;change=undefined;await fn?.();return result}
  const router=Router()
  router.use(officeArtifactRoutes({service:{...service,get:params=>after(service.get(params))},generationAvailable:()=>false,
    list:async(userId,workspaceId,view)=>{
      const rows=await artifacts.list(userId,workspaceId,view)
      const projections=await Promise.all(rows.map(row=>service.get({userId,artifactId:row.id})))
      return after(Promise.resolve(projections.filter((row):row is NonNullable<typeof row>=>row!==null)))
    },getArtifact:artifacts.get,resolveAccess:resolveOfficeAccess,listVersions:(...args)=>after(artifacts.listVersions(...args)),
    previewVersion:async({userId,artifactId,versionId})=>{
      const source=await artifacts.getVersionSource(userId,artifactId,versionId);if(!source)return null
      const read=await f.api.readBytes({workspaceId:source.workspaceId,userId,assistantKind:'standard',clearance:'confidential'},source.snapshotFileId)
      if(!read.ok)throw new Error('snapshot unavailable')
      if(createHash('sha256').update(read.value.bytes).digest('hex')!==source.snapshotHash)throw new Error('snapshot hash mismatch')
      return after(Promise.resolve(JSON.parse(new TextDecoder().decode(read.value.bytes))))
    },
    listSharing:async(userId,artifactId)=>{
      const artifact=await artifacts.get(userId,artifactId)
      if(!artifact)return {status:'unavailable' as const}
      const [grants,directory]=await Promise.all([artifacts.listGrants(userId,artifactId),readWorkspaceMemberDirectory(userId,artifact.workspaceId)])
      if(directory.status===409)return {status:'changed' as const}
      if(directory.status!==200)return {status:'unavailable' as const}
      return after(Promise.resolve({status:'ok' as const,workspaceId:artifact.workspaceId,validForMs:directory.body.validForMs,defaultWorkspaceRole:artifact.defaultWorkspaceRole,grants,
        members:directory.body.members.map(member=>({userId:member.userId,userName:member.name,email:member.email,isOwner:member.userId===artifact.ownerUserId}))}))
    }} as OfficeArtifactsRouteDeps))
  router.use(officeCollaborationRoutes({getArtifact:artifacts.get,resolveAccess:resolveOfficeAccess,
    getSnapshot:(...args)=>after(f.live.get(...args)),listThreads:(...args)=>after(comments.listThreads(...args)),
    listSuggestions:(...args)=>after(comments.listSuggestions(...args))} as OfficeCollaborationRouteDeps))
  router.use(officeTemplateRoutes({list:(...args)=>after(templates.list(...args)),getTemplate:templates.get,getSnapshot:f.live.get,
    getDraftRouting:(...args)=>after(templates.getDraftRouting(...args))} as OfficeTemplatesRouteDeps))
  router.use(officeJobRoutes({get:(...args)=>after(jobs.get(...args)),events:(...args)=>after(jobs.listEvents(...args)),steer:jobs.steer,cancel:jobs.cancel}))
  const paths={
    artifacts:`/artifacts?workspaceId=${f.workspaceId}`,artifact:`/artifacts/${f.artifact.id}`,versions:`/artifacts/${f.artifact.id}/versions`,
    snapshot:`/artifacts/${f.artifact.id}/snapshot`,comments:`/artifacts/${f.artifact.id}/comments`,suggestions:`/artifacts/${f.artifact.id}/suggestions`,
    preview:`/artifacts/${f.artifact.id}/versions/${version!.id}/preview`,sharing:`/artifacts/${f.artifact.id}/sharing`,
    templates:`/templates?workspaceId=${f.workspaceId}`,routing:`/templates/${f.template.id}/routing`,job:`/jobs/${job.id}`,events:`/jobs/${job.id}/events`,
  }
  return {...f,listedArtifact,comments,jobs,job,thread,suggestion,version,paths,change:(fn:()=>Promise<unknown>)=>{change=fn},
    metadataApp:(userId:string|undefined=f.reader)=>createTestApp('/api/office',router,{userId})}
}
const metadataPaths=['artifacts','artifact','versions','preview','sharing','snapshot','comments','suggestions','templates','routing','job','events'] as const

describe('[COMP:api/office-routes] real bounded Office metadata publication (PG18)',()=>{
  it('serves every SQL metadata surface with bounded no-store responses and no conditional 304',async()=>{
    const f=await metadataFixture(),app=f.metadataApp()
    const bodies:Record<string,any>={}
    for(const name of metadataPaths){
      const res=await request(app).get('/api/office'+f.paths[name]).set('If-None-Match','*').expect(200)
      expect(res.headers['cache-control'],name).toBe('private, no-store')
      expect(res.headers.etag,name).toBeUndefined()
      expect(Number(res.headers['x-brian-projection-valid-for-ms']),name).toBeGreaterThan(0)
      expect(Number(res.headers['x-brian-projection-valid-for-ms']),name).toBeLessThanOrEqual(30_000)
      bodies[name]=res.body
    }
    expect(bodies.artifacts.artifacts).toHaveLength(1)
    expect(bodies.artifacts.artifacts[0].artifactId).toBe(f.listedArtifact.id)
    expect(bodies.artifact.artifact).toMatchObject({artifactId:f.artifact.id,role:'view'})
    expect(bodies.versions.versions).toHaveLength(1)
    expect(bodies.preview.snapshot).toMatchObject({artifactId:f.artifact.id,title:f.snapshot.title})
    expect(bodies.sharing).toMatchObject({defaultWorkspaceRole:'comment',canManage:false})
    expect(bodies.sharing.members).toHaveLength(3)
    expect(bodies.snapshot.snapshot).toMatchObject({artifactId:f.artifact.id,title:f.snapshot.title})
    expect(bodies.comments.threads[0].messages[0].body).toBe('Department comment')
    expect(bodies.suggestions.suggestions[0].id).toBe(f.suggestion.id)
    expect(bodies.templates.templates[0].id).toBe(f.template.id)
    expect(bodies.routing.routing).toBeDefined()
    expect(await templates.getDraftRouting(f.owner,f.template.id)).toBeNull()
    expect(bodies.job.job.id).toBe(f.job.id);expect(bodies.events.events).toHaveLength(1)
    const independent=await f.grant();await f.revoke()
    await request(app).get('/api/office'+f.paths.artifact).expect(200)
    await f.revoke(independent)
    for(const name of metadataPaths){
      const res=await request(app).get('/api/office'+f.paths[name])
      if(name==='artifacts'||name==='templates'){
        expect(res.status).toBe(200);expect(res.body[name]).toEqual([])
      }else{expect(res.status,name).toBe(404);expect(res.headers['x-brian-projection-valid-for-ms']).toBeUndefined()}
      expect(res.text,name).not.toContain(f.artifact.id);expect(res.text,name).not.toContain('Department comment')
    }
  })
  it.each(metadataPaths)('withholds %s when authority changes after its real store read',async name=>{
    const f=await metadataFixture();f.change(()=>f.revoke())
    const res=await request(f.metadataApp()).get('/api/office'+f.paths[name]).expect(409)
    expect(res.body).toEqual({error:'office_projection_changed'})
    expect(res.headers['x-brian-projection-valid-for-ms']).toBeUndefined()
    expect(res.headers['cache-control']).toBe('private, no-store')
  })
  it.each(['title','private','membership','file'] as const)('detects a concurrent %s change without a policy revision bump',async change=>{
    const f=await metadataFixture()
    f.change(()=>change==='title'?pool.query("UPDATE office_artifacts SET title='Changed title' WHERE id=$1",[f.artifact.id])
      :change==='private'?pool.query('UPDATE office_artifacts SET visibility_user_ids=$2 WHERE id=$1',[f.artifact.id,[f.owner]])
      :change==='membership'?pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.reader])
      :pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[f.bundleFileId]))
    const res=await request(f.metadataApp()).get('/api/office'+(change==='file'?f.paths.templates:f.paths.artifact)).expect(409)
    expect(res.body).toEqual({error:'office_projection_changed'})
  })
  it('withholds a file-backed preview when its exact snapshot file loses authority before publication',async()=>{
    const f=await metadataFixture();f.change(()=>pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[f.bundleFileId]))
    const response=await request(f.metadataApp()).get('/api/office'+f.paths.preview).expect(409)
    expect(response.body).toEqual({error:'office_projection_changed'});expect(response.text).not.toContain(f.snapshot.title)
  })
  it('uses a consistent initial snapshot, detects a changed live document, and allows the next fresh read',async()=>{
    const f=await metadataFixture()
    const reply=await readOfficeProjection(f.reader,async()=>{
      const before=await f.live.get(f.reader,f.artifact.id)
      await pool.query("UPDATE office_collab_documents SET seq=seq+1 WHERE artifact_id=$1",[f.artifact.id])
      expect(await f.live.get(f.reader,f.artifact.id)).toEqual(before)
      return {workspaceId:f.workspaceId,body:before}
    })
    expect(reply).toEqual({status:409,body:{error:'office_projection_changed'}})
    await request(f.metadataApp()).get('/api/office'+f.paths.snapshot).expect(200)
  })
  it('does not invalidate a projection when an independent grant still authorizes it',async()=>{
    const f=await metadataFixture();await f.grant();f.change(()=>f.revoke())
    await request(f.metadataApp()).get('/api/office'+f.paths.artifact).expect(200)
  })
  it('retains the trusted execution ceiling on both read snapshots',async()=>{
    const f=await fixture()
    const scope={workspaceId:f.workspaceId,userId:f.owner,clearance:'confidential',compartments:[f.team.compartmentKey!],mutationCompartments:[],projectIds:null}
    const read=()=>readOfficeProjection(f.owner,async()=>({workspaceId:f.workspaceId,body:await artifacts.get(f.owner,f.artifact.id)}))
    const allowed=await runWithAgentAccess(scope,read)
    expect(allowed.body).toMatchObject({id:f.artifact.id});expect(allowed.validForMs).toBeGreaterThan(0)
    const narrowed=await runWithAgentAccess({...scope,compartments:[]},read)
    expect(narrowed.body).toBeNull()
  })
  it('returns an unauthenticated no-store response before executing a store read',async()=>{
    const jobs=createOfficeGenerationStore()
    const app=createTestApp('/api/office',officeJobRoutes({get:jobs.get,events:jobs.listEvents,steer:jobs.steer,cancel:jobs.cancel}))
    const res=await request(app).get('/api/office/jobs/'+randomUUID()).expect(401)
    expect(res.body).toEqual({error:'Unauthorized'});expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.headers.etag).toBeUndefined();expect(res.headers['x-brian-projection-valid-for-ms']).toBeUndefined()
  })
  it('bounds lifetime by grant expiry and withholds a read completed after expiry',async()=>{
    const f=await fixture(1500)
    const first=await readOfficeProjection(f.reader,async()=>({workspaceId:f.workspaceId,body:await artifacts.get(f.reader,f.artifact.id)}))
    expect(first.validForMs).toBeGreaterThan(0);expect(first.validForMs).toBeLessThan(1500)
    const expired=await readOfficeProjection(f.reader,async()=>{
      const body=await artifacts.get(f.reader,f.artifact.id)
      await pool.query('SELECT pg_sleep(1.6)')
      return {workspaceId:f.workspaceId,body}
    })
    expect(expired).toEqual({status:409,body:{error:'office_projection_changed'}})
  })
  it('uses the shorter lifetime when a protected dependency supplies its own deadline',async()=>{
    const f=await fixture()
    const reply=await readOfficeProjection(f.reader,async()=>({workspaceId:f.workspaceId,validForMs:750,body:await artifacts.get(f.reader,f.artifact.id)}))
    expect(reply.validForMs).toBeGreaterThan(0);expect(reply.validForMs).toBeLessThanOrEqual(750)
  })
  it('rejects writes, nested reads, a different actor/ceiling, missing SQL and retained context use; releases on error',async()=>{
    const f=await fixture()
    await expect(readOfficeProjection(f.owner,async()=>{
      await defaultOfficeDbQuery(f.owner,"UPDATE office_artifacts SET title='Forbidden' WHERE id=$1",[f.artifact.id])
      return {workspaceId:f.workspaceId,body:{}}
    })).rejects.toMatchObject({code:'25006'})
    await expect(readOfficeProjection(f.owner,()=>readOfficeProjection(f.owner,async()=>({body:{}})))).rejects.toThrow('office_projection_nested')
    await expect(readOfficeProjection(f.owner,async()=>({workspaceId:f.workspaceId,body:await artifacts.get(f.reader,f.artifact.id)}))).rejects.toThrow('office_projection_context_mismatch')
    await expect(readOfficeProjection(f.owner,()=>runWithAgentAccess({clearance:'public',compartments:[]},async()=>({workspaceId:f.workspaceId,body:await artifacts.get(f.owner,f.artifact.id)})))).rejects.toThrow('office_projection_context_mismatch')
    await expect(readOfficeProjection(f.owner,async()=>({workspaceId:f.workspaceId,body:{}}))).rejects.toThrow('office_projection_unbound')
    let retained:OfficeDbQuery|undefined
    const reply=await readOfficeProjection(f.owner,async()=>{
      retained=officeProjectionQuery(f.owner)
      return {workspaceId:f.workspaceId,body:await artifacts.get(f.owner,f.artifact.id)}
    })
    expect(reply.validForMs).toBeGreaterThan(0)
    await expect(retained!(f.owner,'SELECT 1',[])).rejects.toThrow('office_projection_context_mismatch')
    expect((await artifacts.get(f.owner,f.artifact.id))?.title).toBe('Library draft')
  })
})
