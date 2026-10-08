import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool,queryWithRLS} from '../client.js'
import {createOfficeArtifactStore} from '../office-artifacts.js'
import {createOfficeCommentStore} from '../office-comments.js'
import {createOfficeTemplateStore} from '../office-templates.js'
import {createOfficeGenerationStore} from '../office-generation.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'
import {runWithAgentAccess} from '../agent-access-context.js'
import {resolveOfficeAccess} from '../../office/access.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),artifacts=createOfficeArtifactStore(),comments=createOfficeCommentStore(),jobs=createOfficeGenerationStore()
const hash='a'.repeat(64)
async function fixture(grantLifetimeMs=86_400_000,v2=false) {
  const workspaceId=randomUUID(),owner=randomUUID(),reader=randomUUID(),editor=randomUUID(),fileId=randomUUID()
  for(const id of [owner,reader,editor])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  // These suites pin the legacy (flag-off) model: read grants are read-only there.
  // Under v2 an edge is read and write at its clearance (permission-model-v2 A09).
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Office scope fixture',$2,$3)",[workspaceId,owner,v2])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','internal','assigned'),($1,$3,'member','internal','assigned'),($1,$4,'member','internal','assigned')",[workspaceId,owner,reader,editor])
  const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(owner,workspaceId,{name:'Office department',key:'office-department'})
  await groups.addMember(owner,team.id,editor)
  const artifact=await artifacts.createShell({userId:owner,workspaceId,family:'document',title:'Scoped document',templateVersionId:null,capabilityVersion:1,sensitivity:'internal',requiredCompartments:[team.compartmentKey!]})
  await pool.query('INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,compartments) VALUES($1,$2,$3,$4,$5,$6)',[fileId,workspaceId,'/fixture.json','fixture.json','fixture://snapshot',[team.compartmentKey!]])
  const checkpoint=(userId:string,expectedVersion:number)=>artifacts.commitVersion({userId,artifactId:artifact.id,snapshotTitle:'Scoped document',expectedVersion,snapshotFileId:fileId,snapshotHash:hash,operationClock:new Uint8Array(),schemaVersion:1,capabilityVersion:1,origin:'manual',authorType:'user',authorUserId:userId,summary:'Fixture checkpoint'})
  const version=await checkpoint(owner,0);if(!version)throw new Error('Missing fixture version')
  const threadParams={userId:editor,workspaceId,artifactId:artifact.id,artifactVersionId:version.id,anchor:{kind:'block' as const,targetIds:[randomUUID()]},body:'Fixture discussion'}
  const thread=await comments.createThread(threadParams)
  const job=await jobs.create({userId:editor,workspaceId,artifactId:artifact.id,assistantId:null,jobKind:'revise',brief:{},authorityProjection:{},idempotencyKey:randomUUID()})
  await jobs.appendEvent({userId:editor,workspaceId,jobId:job.id,code:'fixture',values:{},actorType:'user',actorUserId:editor})
  await jobs.steer({userId:editor,workspaceId,jobId:job.id,instruction:'Fixture instruction'})
  await pool.query("INSERT INTO office_collab_documents(artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version) VALUES($1,$2,'','',$3,1)",[artifact.id,workspaceId,hash])
  await pool.query("INSERT INTO office_artifact_sources(artifact_id,artifact_version_id,workspace_id,source_kind,source_id,sensitivity) VALUES($1,$2,$3,'user_attested','fixture','internal')",[artifact.id,version.id,workspaceId])
  await pool.query("INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role) VALUES($1,$2,$3,'edit')",[artifact.id,workspaceId,reader])
  await pool.query("INSERT INTO office_audit_events(artifact_id,workspace_id,event_type) VALUES($1,$2,'fixture')",[artifact.id,workspaceId])
  await pool.query("INSERT INTO office_suggestions(artifact_id,workspace_id,base_version_id,proposed_by_type,command_batch,affected_object_ids) VALUES($1,$2,$3,'user','[]','{}')",[artifact.id,workspaceId,version.id])
  await pool.query("INSERT INTO office_claims(artifact_id,artifact_version_id,workspace_id,object_id,claim_text,classification,confidence,severity,reason_code) VALUES($1,$2,$3,$4,'Fixture claim','user_attested',1,'info','fixture')",[artifact.id,version.id,workspaceId,randomUUID()])
  await pool.query("INSERT INTO office_release_records(artifact_id,artifact_version_id,workspace_id,action,destination_projection,validation_receipt,released_by) VALUES($1,$2,$3,'export','{}','{}',$4)",[artifact.id,version.id,workspaceId,owner])
  await pool.query("INSERT INTO office_offline_packages(artifact_id,artifact_version_id,workspace_id,user_id,device_id,package_file_id,manifest,manifest_hash,signature,state_vector) VALUES($1,$2,$3,$4,'fixture',$5,'{}',$6,'fixture','')",[artifact.id,version.id,workspaceId,reader,fileId,hash])
  const resource=randomUUID()
  await pool.query("INSERT INTO office_resources(id,workspace_id,kind,name,content_hash,mime,sensitivity,created_by) VALUES($1,$2,'brand_media','Fixture media',$3,'image/png','internal',$4)",[resource,workspaceId,hash,owner])
  await pool.query("INSERT INTO office_media_uses(artifact_id,artifact_version_id,workspace_id,object_id,resource_id,provenance_state) VALUES($1,$2,$3,$4,$5,'verified_reusable')",[artifact.id,version.id,workspaceId,randomUUID(),resource])
  async function grant() {
    const id=randomUUID()
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Office fixture',now()-interval '1 day',now()+$7*interval '1 millisecond',$5,1,'approved',$6,now())`,[id,workspaceId,reader,team.id,hash,owner,grantLifetimeMs])
    return (await pool.query<{id:string}>(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1 RETURNING id`,[id])).rows[0]!.id
  }
  const grantId=await grant()
  const revoke=(id=grantId)=>pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1',[id,owner])
  return {workspaceId,owner,reader,editor,fileId,team,artifact,version,thread,job,threadParams,checkpoint,grantId,grant,revoke,groups}
}
afterAll(async()=>{await getAppPool().end();await pool.end()})

const children=['office_artifact_versions','office_artifact_sources','office_artifact_grants','office_audit_events','office_collab_documents','office_comment_threads','office_comment_messages','office_suggestions','office_generation_jobs','office_generation_events','office_generation_steering','office_claims','office_media_uses','office_release_records','office_offline_packages'] as const

describe('[COMP:api/office-access] current Office operation scopes (PG18)',()=>{
  it('under v2 an approved grant edge is read and write at its clearance until it is revoked (A09)',async()=>{
    const f=await fixture(86_400_000,true)
    expect(await resolveOfficeAccess(f.reader,f.artifact.id)).toMatchObject({role:'edit',canView:true,canEdit:true})
    await f.revoke()
    expect(await resolveOfficeAccess(f.reader,f.artifact.id)).toBeNull()
  })

  it('admits a current read grant through the canonical resolver and every seeded child without granting mutations',async()=>{
    const f=await fixture()
    expect((await queryWithRLS(f.reader,'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows).toEqual([{rolsuper:false,rolbypassrls:false}])
    expect(await resolveOfficeAccess(f.reader,f.artifact.id)).toMatchObject({role:'view',canView:true,canEdit:false,canComment:false,canRestore:false,canManageSharing:false})
    for(const table of children)expect((await queryWithRLS(f.reader,`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows,table).toHaveLength(1)
    for(const table of children) {
      expect((await queryWithRLS(f.reader,`UPDATE ${table} SET workspace_id=workspace_id WHERE workspace_id=$1 RETURNING *`,[f.workspaceId])).rows,table).toHaveLength(0)
      expect((await queryWithRLS(f.reader,`DELETE FROM ${table} WHERE workspace_id=$1 RETURNING *`,[f.workspaceId])).rows,table).toHaveLength(0)
    }
    expect(await artifacts.nameVersion({userId:f.reader,artifactId:f.artifact.id,versionId:f.version.id,summary:'Denied'})).toBe(false)
    expect((await queryWithRLS(f.reader,'DELETE FROM office_artifacts WHERE id=$1 RETURNING id',[f.artifact.id])).rows).toHaveLength(0)
    await expect(comments.createThread({...f.threadParams,userId:f.reader})).rejects.toMatchObject({code:'42501'})
    expect(await f.checkpoint(f.reader,1)).toBeNull()
    expect((await pool.query('SELECT head_version::int AS version FROM office_artifacts WHERE id=$1',[f.artifact.id])).rows).toEqual([{version:1}])
    expect((await pool.query('SELECT id FROM office_comment_threads WHERE artifact_id=$1',[f.artifact.id])).rows).toHaveLength(1)
    expect((await pool.query('SELECT id FROM office_artifact_versions WHERE artifact_id=$1',[f.artifact.id])).rows).toHaveLength(1)
  })
  it('keeps ordinary department comments and checkpoint transactions useful',async()=>{
    const f=await fixture()
    expect(await resolveOfficeAccess(f.editor,f.artifact.id)).toMatchObject({canComment:true,canEdit:false})
    const created=await comments.createThread(f.threadParams)
    expect(created.messageId).toBeTruthy()
    expect(await comments.reply({userId:f.editor,workspaceId:f.workspaceId,threadId:created.threadId,body:'Allowed reply'})).not.toBeNull()
    await pool.query("INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role) VALUES($1,$2,$3,'edit')",[f.artifact.id,f.workspaceId,f.editor])
    expect(await resolveOfficeAccess(f.editor,f.artifact.id)).toMatchObject({canEdit:true})
    expect(await f.checkpoint(f.editor,1)).toMatchObject({version:2})
  })
  it('rechecks all children on revocation and preserves an independent still-valid grant',async()=>{
    const f=await fixture(),other=await f.grant();await f.revoke()
    expect(await resolveOfficeAccess(f.reader,f.artifact.id)).not.toBeNull()
    await f.revoke(other)
    expect(await resolveOfficeAccess(f.reader,f.artifact.id)).toBeNull()
    for(const table of children)expect((await queryWithRLS(f.reader,`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows,table).toHaveLength(0)
    expect(await comments.reply({userId:f.reader,workspaceId:f.workspaceId,threadId:f.thread.threadId,body:'Denied'})).toBeNull()
  })
  it.each(['expiry','membership','clearance','private','deny'] as const)('rechecks %s without leaking a child projection',async change=>{
    const f=await fixture(change==='expiry'?250:86_400_000)
    if(change==='expiry')await pool.query('SELECT pg_sleep(0.3)')
    if(change==='membership')await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.reader])
    if(change==='clearance')await pool.query("UPDATE office_artifacts SET sensitivity='confidential' WHERE id=$1",[f.artifact.id])
    if(change==='private')await pool.query('UPDATE office_artifacts SET visibility_user_ids=$2 WHERE id=$1',[f.artifact.id,[f.owner]])
    if(change==='deny')await pool.query("UPDATE office_artifact_grants SET role='deny' WHERE artifact_id=$1 AND user_id=$2",[f.artifact.id,f.reader])
    expect(await resolveOfficeAccess(f.reader,f.artifact.id)).toBeNull()
    for(const table of children)expect((await queryWithRLS(f.reader,`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows,table).toHaveLength(0)
  })
  it('intersects execution read, mutation, project, workspace, actor and assistant visibility ceilings',async()=>{
    const f=await fixture(),project=randomUUID(),assistant=randomUUID()
    const scope={workspaceId:f.workspaceId,userId:f.owner,clearance:'confidential',compartments:[f.team.compartmentKey!],mutationCompartments:[],projectIds:[project]}
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Office project','office project',$3)",[project,f.workspaceId,f.owner])
    await pool.query('UPDATE office_artifacts SET project_ids=$2 WHERE id=$1',[f.artifact.id,[project]])
    expect(await runWithAgentAccess(scope,()=>resolveOfficeAccess(f.owner,f.artifact.id))).toMatchObject({canView:true,canEdit:false,canManageSharing:false})
    for(const changed of [{compartments:[]},{projectIds:[]},{workspaceId:randomUUID()}]) {
      expect(await runWithAgentAccess({...scope,...changed},()=>resolveOfficeAccess(f.owner,f.artifact.id))).toBeNull()
    }
    await pool.query('UPDATE office_artifacts SET visibility_user_ids=$2 WHERE id=$1',[f.artifact.id,[f.owner]])
    expect(await runWithAgentAccess({...scope,userId:f.reader},()=>resolveOfficeAccess(f.owner,f.artifact.id))).toBeNull()
    await pool.query('UPDATE office_artifacts SET visibility_assistant_ids=$2 WHERE id=$1',[f.artifact.id,[assistant]])
    expect(await runWithAgentAccess({...scope,visibilityAssistantIds:[]},()=>resolveOfficeAccess(f.owner,f.artifact.id))).toBeNull()
    expect(await runWithAgentAccess({...scope,visibilityAssistantIds:[assistant]},()=>resolveOfficeAccess(f.owner,f.artifact.id))).not.toBeNull()
  })
  it('preserves trusted admin clearance without silently granting Edit to peers',async()=>{
    const f=await fixture();await pool.query("UPDATE office_artifacts SET sensitivity='confidential',creator_user_id=$2,owner_user_id=$2 WHERE id=$1",[f.artifact.id,f.editor])
    expect(await resolveOfficeAccess(f.owner,f.artifact.id)).toMatchObject({role:'comment',canComment:true,canEdit:false,canElevate:true})
  })
  it('refuses replacement classification outside ordinary reach and rolls back a forbidden source insert',async()=>{
    const f=await fixture(),other=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Other department',key:'other'})
    await expect(queryWithRLS(f.editor,'UPDATE office_artifacts SET compartments=$2 WHERE id=$1',[f.artifact.id,[other.compartmentKey!]])).rejects.toMatchObject({code:'42501'})
    await expect(queryWithRLS(f.editor,"INSERT INTO office_artifact_sources(artifact_id,artifact_version_id,workspace_id,source_kind,source_id,sensitivity,required_compartments) VALUES($1,$2,$3,'user_attested','denied','internal',$4)",[f.artifact.id,f.version.id,f.workspaceId,[other.compartmentKey!]])).rejects.toMatchObject({code:'42501'})
    expect((await artifacts.get(f.editor,f.artifact.id))?.compartments).toEqual([f.team.compartmentKey!])
    expect((await pool.query('SELECT id FROM office_artifact_sources WHERE artifact_id=$1',[f.artifact.id])).rows).toHaveLength(1)
  })
  it('rejects children carrying a different workspace even for a member of both',async()=>{
    const f=await fixture(),foreign=randomUUID()
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Other workspace',$2)",[foreign,f.owner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[foreign,f.owner])
    await expect(comments.createThread({...f.threadParams,userId:f.owner,workspaceId:foreign})).rejects.toMatchObject({code:'42501'})
    await expect(comments.reply({userId:f.owner,workspaceId:foreign,threadId:f.thread.threadId,body:'Wrong workspace'})).rejects.toMatchObject({code:'42501'})
    await expect(jobs.steer({userId:f.owner,workspaceId:foreign,jobId:f.job.id,instruction:'Wrong workspace'})).rejects.toMatchObject({code:'42501'})
  })
  it('requires current unretracted source visibility even when the root remains readable by label',async()=>{
    const f=await fixture()
    await pool.query('UPDATE office_artifact_sources SET visibility_user_ids=$2 WHERE artifact_id=$1',[f.artifact.id,[f.owner]])
    expect(await resolveOfficeAccess(f.reader,f.artifact.id)).toBeNull()
    expect((await comments.listThreads(f.reader,f.artifact.id))).toEqual([])
    await pool.query('UPDATE office_artifact_sources SET retracted_at=now() WHERE artifact_id=$1',[f.artifact.id])
    expect(await resolveOfficeAccess(f.reader,f.artifact.id)).not.toBeNull()
  })
  it('preserves lifecycle recovery and purge while the access service hides purged artifacts',async()=>{
    const f=await fixture()
    const transition=(userId:string,action:'archive'|'unarchive'|'trash'|'restore'|'purge')=>artifacts.transitionLifecycle({userId,artifactId:f.artifact.id,action,reason:'Fixture lifecycle'})
    expect(await transition(f.reader,'archive')).toBeNull()
    expect(await transition(f.owner,'archive')).toMatchObject({lifecycleState:'archived'})
    expect((await pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM office_offline_packages WHERE artifact_id=$1',[f.artifact.id])).rows).toEqual([{revoked:true}])
    expect(await transition(f.owner,'unarchive')).toMatchObject({lifecycleState:'active'})
    expect(await transition(f.owner,'trash')).toMatchObject({lifecycleState:'trash'})
    expect(await transition(f.reader,'purge')).toBeNull()
    expect(await transition(f.owner,'restore')).toMatchObject({lifecycleState:'active'})
    await transition(f.owner,'trash')
    await pool.query('UPDATE office_artifacts SET legal_hold=true WHERE id=$1',[f.artifact.id])
    expect(await transition(f.owner,'purge')).toBeNull()
    await pool.query('UPDATE office_artifacts SET legal_hold=false WHERE id=$1',[f.artifact.id])
    await pool.query('UPDATE office_offline_packages SET revoked_at=NULL,complete=true WHERE artifact_id=$1',[f.artifact.id])
    expect(await transition(f.owner,'purge')).toMatchObject({lifecycleState:'purged'})
    expect(await resolveOfficeAccess(f.owner,f.artifact.id)).toBeNull()
    expect((await pool.query("SELECT id FROM office_audit_events WHERE artifact_id=$1 AND event_type='office.lifecycle.purge'",[f.artifact.id])).rows).toHaveLength(1)
    expect(await transition(f.owner,'purge')).toBeNull()
  })

  it('preserves linked template lifecycle audit while refusing a read-only template owner',async()=>{
    const f=await fixture(),templates=createOfficeTemplateStore()
    await pool.query("UPDATE office_artifacts SET mode='template' WHERE id=$1",[f.artifact.id])
    const template=await templates.createDraft({userId:f.owner,workspaceId:f.workspaceId,family:'document',name:'Fixture template',description:'Fixture',sensitivity:'internal',draftArtifactId:f.artifact.id})
    await pool.query('UPDATE office_templates SET owner_user_id=$2 WHERE id=$1',[template.id,f.reader])
    const transition=(userId:string,action:'trash'|'restore'|'purge')=>templates.transitionLifecycle({userId,templateId:template.id,action,reason:'Fixture lifecycle'})
    expect(await transition(f.reader,'trash')).toBeNull()
    expect(await transition(f.owner,'trash')).toMatchObject({lifecycleState:'trash'})
    expect(await transition(f.owner,'restore')).toMatchObject({lifecycleState:'draft'})
    await transition(f.owner,'trash')
    await pool.query('UPDATE office_offline_packages SET revoked_at=NULL,complete=true WHERE artifact_id=$1',[f.artifact.id])
    expect(await transition(f.owner,'purge')).toMatchObject({lifecycleState:'purged'})
    expect((await pool.query("SELECT lifecycle_state FROM office_artifacts WHERE id=$1",[f.artifact.id])).rows).toEqual([{lifecycle_state:'purged'}])
    expect((await pool.query("SELECT id FROM office_audit_events WHERE workspace_id=$1 AND event_type='office.template.lifecycle.purge'",[f.workspaceId])).rows).toHaveLength(1)
    expect((await pool.query('SELECT revoked_at IS NOT NULL AS revoked,complete FROM office_offline_packages WHERE artifact_id=$1',[f.artifact.id])).rows).toEqual([{revoked:true,complete:false}])
    await expect(queryWithRLS(f.owner,"INSERT INTO office_audit_events(workspace_id,event_type) VALUES($1,'unbound')",[f.workspaceId])).rejects.toMatchObject({code:'42501'})
  })

})
