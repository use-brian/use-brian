import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool,queryWithRLS} from '../client.js'
import {createOfficeArtifactStore} from '../office-artifacts.js'
import {createOfficeTemplateStore} from '../office-templates.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'
import {runWithAgentAccess} from '../agent-access-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),artifacts=createOfficeArtifactStore(),templates=createOfficeTemplateStore(),groups=createDbWorkspaceGroupStore()
const hash='a'.repeat(64)
const tables=['office_templates','office_template_versions','office_resources','office_template_resource_refs'] as const
async function fixture() {
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
      VALUES($1,$2,$3,'member',$3,$4,'Library fixture',now()-interval '1 day',now()+interval '1 day',$5,1,'approved',$6,now())`,[request,workspaceId,reader,team.id,hash,owner])
    return (await pool.query<{id:string}>(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1 RETURNING id`,[request])).rows[0]!.id
  }
  const grantId=await grant()
  const revoke=(id=grantId)=>pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1',[id,owner])
  return {workspaceId,owner,reader,editor,team,artifact,template,file,bundleFileId,resourceFileId,resource,resourceParams,version,versionParams,grant,revoke}
}
afterAll(async()=>{await getAppPool().end();await pool.end()})

describe('[COMP:api/office-access] current Office library scopes (PG18)',()=>{
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
