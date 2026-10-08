import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, queryWithRLS, applyRLSGucs, runWithAgentAccess } from '../../db/client.js'
import { createDbSavedViewStore } from '../../db/saved-views-store.js'
import { ContextScopeAccumulator, createFileTools, pinAccessCeiling, type ToolContext, type PageLifecycleEvent, type AccessCeiling } from '@use-brian/core'
import { validateCallerScopeEvidence, validateAudienceScopeEvidence } from '../caller-evidence.js'
import { createDbWorkflowStore, createDbWorkflowRunStore, pauseWorkflowForPrimitiveEventSystem } from '../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../workflow-authority.js'
import { readWorkflowInputEvidence } from '../workflow-input-evidence.js'
import { readWorkflowOutcomeWithLineage } from '../../crm-operations/workflow-copy-store.js'
import { createWorkspaceFile, updateWorkspaceFileMeta } from '../../db/workspace-files.js'
import { createMemory } from '../../db/memories.js'
import { describeScopeRefusal, DerivedScopeError } from '@use-brian/core'
import { captureRecordingIntakeParent } from '../../db/recording-intake-admission.js'
import { insertFileSegments } from '../../db/file-segments-store.js'
import { readFileSegmentRange } from '../../db/retrieval-store.js'
import { createFilesApi } from '../../files/files-api.js'
import { createDbWorkspaceFilesStore } from '../../db/workspace-files-store.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
async function fixture() {
  const workspaceId=randomUUID(),owner=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[owner])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Page receipt fixture',$2)",[workspaceId,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL)",[workspaceId,owner])
  async function page(teamspaceId:string|null=null,parentId:string|null=null) {
    return (await pool.query(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance,teamspace_id,nest_parent_id)
      VALUES($1,$2,'Receipt title','tasks','table','{"blocks":[]}','saved','internal',$3,$4) RETURNING id,page_event_revision`,[workspaceId,owner,teamspaceId,parentId])).rows[0]
  }
  async function receipt(revision:string) {
    return (await pool.query('SELECT * FROM workflow_page_event_receipts WHERE revision=$1',[revision])).rows[0]
  }
  return {workspaceId,owner,page,receipt}
}
describe('[COMP:api/workflow-input-evidence] canonical page event capture',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('inherits a newly private page boundary at ordinary file copy and never loses that observed floor',async()=>{
    const f=await fixture(),space=randomUUID(),member=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",[f.workspaceId,member])
    await pool.query("INSERT INTO teamspaces(id,workspace_id,name,created_by) VALUES($1,$2,'Copy source space',$3)",[space,f.workspaceId,f.owner])
    for(const user of [f.owner,member])await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[space,user])
    const page=await f.page(space)
    const snapshot=async(kind:string,id:string)=>(await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,kind,id])).rows[0].source
    const publish=(source:Awaited<ReturnType<typeof snapshot>>)=>createWorkspaceFile(f.owner,
      {workspaceId:f.workspaceId,path:`/${randomUUID()}.txt`,parentPath:'/',name:'observed-copy.txt',mime:'text/plain',sizeBytes:1,storageUri:'fixture://observed-copy',createdByUserId:f.owner,source:'extracted'},
      {derivation:{producer:'observed-page-copy',sources:[source]}})
    const file=await publish(await snapshot('page_event_changed',page.page_event_revision))
    expect(file.userId).toBeNull()
    await pool.query('UPDATE saved_views SET teamspace_id=NULL WHERE id=$1',[page.id])
    const assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Copy assistant','primary','confidential')",[assistantId,f.workspaceId,f.owner])
    const scopeAccumulator=new ContextScopeAccumulator()
    scopeAccumulator.noteSource(await snapshot('workspace_file',file.id))
    const api=createFilesApi({store:createDbWorkspaceFilesStore(),gcs:{writeBlob:async()=>{}} as never,bucket:'fixture',auditStore:{append:async()=>{}} as never})
    const context:ToolContext={userId:f.owner,workspaceId:f.workspaceId,assistantId,assistantKind:'primary',
      appId:'fixture',sessionId:randomUUID(),channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal,
      clearance:'confidential',compartments:[],mutationCompartments:[],projectIds:null,scopeAccumulator}
    const result=await createFileTools(api).fileWrite.execute({path:'/ordinary-copy.txt',content:'Copied from the observed file'},context)
    expect(result.isError).not.toBe(true)
    const copy=(await pool.query('SELECT id,user_id AS "userId" FROM workspace_files WHERE workspace_id=$1 AND path=$2',[f.workspaceId,'/ordinary-copy.txt'])).rows[0]
    expect(copy.userId).toBe(f.owner)
    await pool.query('UPDATE saved_views SET teamspace_id=$2 WHERE id=$1',[page.id,space])
    expect((await queryWithRLS(member,'SELECT id FROM workspace_files WHERE id=$1',[file.id])).rows).toHaveLength(1)
    expect((await queryWithRLS(member,'SELECT id FROM workspace_files WHERE id=$1',[copy.id])).rows).toHaveLength(0)
    await pool.query('DELETE FROM saved_views WHERE id=$1',[page.id])
    expect((await queryWithRLS(f.owner,'SELECT id FROM workspace_files WHERE id=$1',[copy.id])).rows).toHaveLength(1)
    expect((await queryWithRLS(member,'SELECT id FROM workspace_files WHERE id=$1',[copy.id])).rows).toHaveLength(0)
  })
  it('publishes a real page-derived file and preserves Teamspace authority through metadata edits and extraction',async()=>{
    const f=await fixture(),space=randomUUID(),member=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",[f.workspaceId,member])
    await pool.query("INSERT INTO teamspaces(id,workspace_id,name,created_by) VALUES($1,$2,'File source space',$3)",[space,f.workspaceId,f.owner])
    await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[space,f.owner])
    const page=await f.page(space)
    const source=(await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,'page_event_changed',page.page_event_revision])).rows[0].source
    const ceiling:AccessCeiling={workspaceId:f.workspaceId,userId:f.owner,clearance:'confidential',compartments:null,mutationCompartments:null,projectIds:null,visibilityAssistantIds:null}
    const evidence=await validateCallerScopeEvidence({sources:[source]},ceiling)
    const rejectedPath=`/${randomUUID()}.txt`
    await expect(queryWithRLS(f.owner,'SELECT id FROM create_source_derived_file($1::jsonb,$2::jsonb)',[
      JSON.stringify({workspaceId:f.workspaceId,path:rejectedPath,parentPath:'/',name:'incomplete.txt',mime:'text/plain',sizeBytes:1,storageUri:'fixture://incomplete',createdByUserId:f.owner,source:'extracted',userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]}),
      JSON.stringify({producer:'page-file-fixture',sources:[source]}),
    ])).rejects.toThrow('scope_evidence_missing')
    expect((await pool.query('SELECT id FROM workspace_files WHERE workspace_id=$1 AND path=$2',[f.workspaceId,rejectedPath])).rows).toEqual([])
    const file=await createWorkspaceFile(f.owner,{workspaceId:f.workspaceId,path:`/${randomUUID()}.txt`,parentPath:'/',name:'page-result.txt',mime:'text/plain',sizeBytes:17,storageUri:'fixture://page-result',createdByUserId:f.owner,source:'extracted'},
      {derivation:{producer:'page-file-fixture',sources:[source]}})
    const writtenSources=(await pool.query(`SELECT s.source_id FROM scope_derivation_sources s
      JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1`,[file.id])).rows.map(row=>row.source_id)
    expect(writtenSources).toEqual(expect.arrayContaining(evidence.sources!.map(item=>item.resourceId)))
    const rows=async(actor:string)=>(await queryWithRLS(actor,'SELECT id FROM workspace_files WHERE id=$1',[file.id])).rows
    expect((await pool.query('SELECT scope_held,valid_to,retracted_at FROM workspace_files WHERE id=$1',[file.id])).rows[0]).toEqual({scope_held:false,valid_to:null,retracted_at:null})
    expect((await queryWithRLS(f.owner,'SELECT derived_page_scope_visible($1,$2,$3,$4) AS visible',
      [f.workspaceId,'workspace_file',file.id,'1'])).rows[0]).toEqual({visible:true})
    expect(await rows(f.owner)).toHaveLength(1)
    expect(await rows(member)).toHaveLength(0)
    expect(file).toMatchObject({userId:null,compartments:[]})
    await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[space,member])
    expect(await rows(member)).toHaveLength(1)
    expect(await updateWorkspaceFileMeta(f.owner,f.workspaceId,file.id,{title:'Renamed result'})).not.toBeNull()
    const parent=await captureRecordingIntakeParent({actorUserId:f.owner},f.workspaceId,file.id)
    await insertFileSegments({workspaceId:f.workspaceId,fileId:file.id,createdByUserId:f.owner,
      visibility:{userId:parent.userId,assistantId:parent.assistantId},sensitivity:parent.sensitivity,compartments:parent.compartments,tags:null,source:file.source,
      segments:[{segmentIndex:0,charStart:0,charEnd:17,headingPath:[],content:'Page result text.'}]},
      {actorUserId:f.owner,parent})
    const actor={workspaceId:f.workspaceId,userId:member,assistantId:'',assistantKind:'primary' as const,clearance:'confidential' as const}
    expect(await readFileSegmentRange(actor,{fileId:file.id,fromIndex:0,toIndex:0})).toHaveLength(1)
    const fileSource=(await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,'workspace_file',file.id])).rows[0].source
    const copy=await createWorkspaceFile(f.owner,{workspaceId:f.workspaceId,path:`/${randomUUID()}.txt`,parentPath:'/',name:'page-copy.txt',mime:'text/plain',sizeBytes:17,storageUri:'fixture://page-copy',createdByUserId:f.owner,source:'extracted'},
      {derivation:{producer:'page-file-copy-fixture',sources:[fileSource]}})
    const copyRows=async(actorId:string)=>(await queryWithRLS(actorId,'SELECT id FROM workspace_files WHERE id=$1',[copy.id])).rows
    expect(await copyRows(member)).toHaveLength(1)
    await pool.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[space,member])
    expect(await rows(member)).toHaveLength(0)
    expect(await readFileSegmentRange(actor,{fileId:file.id,fromIndex:0,toIndex:0})).toEqual([])
    expect(await copyRows(member)).toHaveLength(0)
    await expect(pool.query('DELETE FROM scope_derivation_sources WHERE derivation_id IN(SELECT id FROM scope_derivations WHERE resource_id=$1)',[file.id])).rejects.toThrow('page_derivation_receipt_immutable')
    await expect(pool.query('DELETE FROM scope_derivations WHERE resource_id=$1',[file.id])).rejects.toThrow('page_derivation_receipt_immutable')
    await pool.query('DELETE FROM saved_views WHERE id=$1',[page.id])
    expect(await rows(f.owner)).toHaveLength(1)
    expect(await rows(member)).toHaveLength(0)
    expect(await copyRows(member)).toHaveLength(0)
    await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[space,member])
    expect(await rows(member)).toHaveLength(1)
    expect(await copyRows(member)).toHaveLength(1)
    expect(await readFileSegmentRange(actor,{fileId:file.id,fromIndex:0,toIndex:0})).toHaveLength(1)
  })
  it('refuses a page-derived memory as a typed error, saves nothing, and names the file path as recovery',async()=>{
    const f=await fixture(),assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Memory assistant','primary','confidential')",[assistantId,f.workspaceId,f.owner])
    const page=await f.page()
    const source=(await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,'page_event_changed',page.page_event_revision])).rows[0].source
    const summary=`Page-derived note ${randomUUID()}`
    const error=await createMemory({workspaceId:f.workspaceId,userId:f.owner,assistantId,createdByUserId:f.owner,summary,sensitivity:'internal',
      derivation:{producer:'page-memory-fixture',sources:[source]}}).catch(e=>e)
    expect(error).toBeInstanceOf(DerivedScopeError)
    expect(error.code).toBe('scope_output_not_integrated')
    expect(describeScopeRefusal(error.message)).toContain('workspace file')
    expect((await pool.query('SELECT id FROM memories WHERE summary=$1',[summary])).rows).toEqual([])
    // The same evidence publishes as a file: the refusal names a path that works.
    const file=await createWorkspaceFile(f.owner,{workspaceId:f.workspaceId,path:`/${randomUUID()}.txt`,parentPath:'/',name:'page-note.txt',mime:'text/plain',sizeBytes:1,storageUri:'fixture://page-note',createdByUserId:f.owner,source:'extracted'},
      {derivation:{producer:'page-memory-fixture',sources:[source]}})
    expect(file.id).toBeTruthy()
  })
  it('requires coherent transaction authority and all page dependencies at the SQL derivation reader',async()=>{
    const f=await fixture(),page=await f.page(),other=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[other])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[f.workspaceId,other])
    const read=async(actor:string,mismatch=false)=>{
      const client=await pool.connect()
      try{
        await client.query('BEGIN');await applyRLSGucs(client,actor)
        if(mismatch)await client.query("SELECT set_config('app.agent_actor_id',$1,true)",[other])
        const value=(await client.query('SELECT read_page_derivation_source($1,$2,$3) AS source',[f.workspaceId,'page_event_changed',page.page_event_revision])).rows[0].source
        await client.query('COMMIT');return value
      }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    }
    const admitted=await read(f.owner)
    expect(admitted).toMatchObject({resourceKind:'page_event_changed',userId:f.owner,held:false})
    expect(admitted.requiredSources).toHaveLength(2)
    expect(await read(other)).toBeNull()
    expect(await read(f.owner,true)).toBeNull()
    const facade=async(actor:string,claimed=actor)=>(await queryWithRLS(actor,
      'SELECT read_admitted_page_authority($1,$2,$3,$4) AS authority',
      [f.workspaceId,'page_event_changed',page.page_event_revision,claimed])).rows[0].authority
    expect(await facade(f.owner)).toMatchObject({principalAllowed:true,source:{userId:f.owner}})
    expect(await facade(other)).toBeNull()
    expect(await facade(other,f.owner)).toBeNull()
    const ceiling:AccessCeiling={workspaceId:f.workspaceId,userId:f.owner,clearance:'public',
      compartments:null,mutationCompartments:null,projectIds:null,visibilityAssistantIds:null}
    expect(await runWithAgentAccess(ceiling,()=>read(f.owner))).toBeNull()
    const project=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Page context','page context',$3)",[project,f.workspaceId,f.owner])
    await pool.query('UPDATE saved_views SET project_id=$2 WHERE id=$1',[page.id,project])
    expect(await read(f.owner)).not.toBeNull()
    expect(await runWithAgentAccess({...ceiling,clearance:'confidential',projectIds:[]},()=>read(f.owner))).toBeNull()
    await expect(queryWithRLS(f.owner,'SELECT read_page_derivation_source($1,$2,$3)',[f.workspaceId,'page_event_changed',page.page_event_revision])).rejects.toMatchObject({code:'42501'})
  })
  it('denies the private page trigger at queue/storm admission and retains authorized evidence after deletion',async()=>{
    const f=await fixture(),page=await f.page(),member=randomUUID(),runs=createDbWorkflowRunStore()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'member','public','{}')",[f.workspaceId,member])
    const workflow=async(userId:string)=>{
      const assistantId=randomUUID()
      await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Page workflow fixture',$2,$3,'standard',$4,NULL)",[assistantId,f.workspaceId,userId,userId===f.owner?'confidential':'public'])
      const authoringAuthority=await captureAuthoringAuthoritySystem({userId,workspaceId:f.workspaceId,assistantId})
      const w=await createDbWorkflowStore().create({userId,workspaceId:f.workspaceId,name:'Page event fixture',authoringAuthority,
        definition:{startStepId:'inspect',steps:[{id:'inspect',type:'tool_call',toolName:'fixtureInspect',arguments:{}}]}})
      return {...w,assistantId,userId}
    }
    const denied=await workflow(member),allowed=await workflow(f.owner)
    const context=(await createDbSavedViewStore().getPageEventContextSystem(page.id))!
    const input={trigger:{sourceType:'page',provider:'page',pageId:page.id,channelId:'updated',actorId:null},
      event:{pageId:page.id,sourceVersion:context.sourceVersion,title:context.title,parentId:null,action:'updated',actorId:null}}
    const params=(w:typeof allowed)=>({workflowId:w.id,workspaceId:f.workspaceId,triggeredBy:w.userId,triggerKind:'event' as const,input})
    await expect(runs.createRun(params(denied))).rejects.toThrow()
    await expect(pauseWorkflowForPrimitiveEventSystem(params(denied),'Fixture pause')).rejects.toThrow()
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workflow_id=$1',[denied.id])).rows).toHaveLength(0)
    await expect(runs.createRun({...params(allowed),input:{...input,event:{...input.event,title:'Substituted'}}})).rejects.toThrow('primitive_event_metadata_conflict')
    const run=await runs.createRun(params(allowed))
    expect((await pool.query('SELECT trigger_page_id FROM workflow_runs WHERE id=$1',[run.id])).rows[0].trigger_page_id).toBe(page.id)
    const scope=await resolveWorkflowRunScope({workspaceId:f.workspaceId,userId:f.owner,assistantId:allowed.assistantId,run})
    expect(scope.inputScopeEvidence.sources?.every(source=>source.userId===f.owner)).toBe(true)
    expect(scope.inputScopeEvidence.sources).toHaveLength(2)
    expect(await scope.executeWithAuthority(async()=> 'authorized')).toBe('authorized')
    await expect(pool.query("UPDATE workflow_runs SET input=jsonb_set(input,'{event,title}','\"Substituted\"') WHERE id=$1",[run.id])).rejects.toThrow('page_event_binding_immutable')
    await pool.query('UPDATE workflow_runs SET vars=$2 WHERE id=$1',[run.id,{__contextScopeEvidence:{sensitivity:'public',compartments:[],projectIds:[]}}])
    expect((await queryWithRLS(f.owner,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toHaveLength(1)
    await pool.query('DELETE FROM saved_views WHERE id=$1',[page.id])
    const retained=await readWorkflowInputEvidence(run.id,f.workspaceId)
    expect(retained.sources).toEqual(scope.inputScopeEvidence.sources)
    const derived=(await pool.query('SELECT read_workflow_derivation_inputs($1,$2) AS inputs',[f.workspaceId,run.id])).rows[0].inputs
    expect(derived[0].evidence.sources).toEqual(expect.arrayContaining(retained.sources!))
    const ancestry=(await pool.query('SELECT read_resource_page_dependencies($1,$2,$3,$4) AS sources',[f.workspaceId,'workflow_run',run.id,'fixture-version'])).rows[0].sources
    expect(ancestry).toEqual(expect.arrayContaining(retained.sources!))
    const workflowSource=(await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,'workflow_run',run.id])).rows[0].source
    const ownerCeiling:AccessCeiling={workspaceId:f.workspaceId,userId:f.owner,clearance:'confidential',
      compartments:null,mutationCompartments:null,projectIds:null,visibilityAssistantIds:null}
    const expanded=await validateCallerScopeEvidence({sources:[workflowSource]},ownerCeiling)
    expect(expanded.sources).toEqual(expect.arrayContaining(retained.sources!))
    await expect(validateAudienceScopeEvidence({sources:[workflowSource]},{...ownerCeiling,userId:member})).rejects.toThrow()
    const visible=async(actor:string)=>(await queryWithRLS(actor,
      'SELECT derived_page_scope_visible($1,$2,$3,$4) AS visible',
      [f.workspaceId,'workflow_run',run.id,workflowSource.version])).rows[0].visible
    expect(await visible(f.owner)).toBe(true)
    expect(await visible(member)).toBe(false)
    await pool.query("UPDATE workflow_runs SET status='completed',outcome='{\"summary\":\"Page-derived fixture result\"}' WHERE id=$1",[run.id])
    const target=await runs.createRun({workflowId:allowed.id,workspaceId:f.workspaceId,triggeredBy:f.owner,triggerKind:'manual',input:{}})
    expect(await runWithAgentAccess(pinAccessCeiling(scope.turnScope.access),()=>readWorkflowOutcomeWithLineage(allowed.id,target.id)))
      .toMatchObject({summary:'Page-derived fixture result'})
    expect((await readWorkflowInputEvidence(target.id,f.workspaceId)).sources).toEqual(expect.arrayContaining(retained.sources!))
    await expect(pool.query('SELECT read_resource_page_dependencies($1,$2,$3,$4)',[f.workspaceId,'workflow_run',target.id,'fixture-version']))
      .rejects.toThrow('scope_evidence_missing')
    const targetScope=await resolveWorkflowRunScope({workspaceId:f.workspaceId,userId:f.owner,assistantId:allowed.assistantId,run:(await runs.getRunSystem(target.id))!})
    await runs.updateRun(target.id,{vars:{__contextScopeEvidence:targetScope.inputScopeEvidence}})
    const copied=(await pool.query('SELECT read_resource_page_dependencies($1,$2,$3,$4) AS sources',[f.workspaceId,'workflow_run',target.id,'fixture-version'])).rows[0].sources
    expect(copied).toEqual(expect.arrayContaining(retained.sources!))
    expect((await queryWithRLS(f.owner,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toHaveLength(1)
  })
  it('renews caller and audience evidence without losing an intermediate Teamspace restriction',async()=>{
    const f=await fixture(),page=await f.page(),spaces=[randomUUID(),randomUUID()]
    const ceiling:AccessCeiling={workspaceId:f.workspaceId,userId:f.owner,clearance:'confidential',
      compartments:null,mutationCompartments:null,projectIds:null,visibilityAssistantIds:null}
    const source=(await pool.query('SELECT read_page_event_authority($1,$2,$3) AS authority',[f.workspaceId,page.page_event_revision,f.owner])).rows[0].authority.boundaries[0].savedSource
    let evidence=await validateCallerScopeEvidence({sources:[source]},ceiling)
    expect(evidence.sources).toHaveLength(2)
    for(const space of spaces){
      await pool.query("INSERT INTO teamspaces(id,workspace_id,name,created_by) VALUES($1,$2,'Renewed space',$3)",[space,f.workspaceId,f.owner])
      await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[space,f.owner])
      await pool.query('UPDATE saved_views SET teamspace_id=$2 WHERE id=$1',[page.id,space])
      evidence=await validateCallerScopeEvidence(evidence,ceiling)
    }
    expect(evidence.sources).toHaveLength(4)
    await expect(validateAudienceScopeEvidence(evidence,ceiling)).resolves.toMatchObject({sensitivity:'internal'})
    await expect(validateCallerScopeEvidence({sources:[{...source,userId:null}]},ceiling)).rejects.toMatchObject({diagnostic:'source_changed'})
    await expect(validateCallerScopeEvidence({sources:[{...source,resourceId:randomUUID()}]},ceiling)).rejects.toMatchObject({diagnostic:'source_unverifiable'})
    await pool.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[spaces[0],f.owner])
    await expect(validateCallerScopeEvidence(evidence,ceiling)).rejects.toMatchObject({reason:'caller_evidence_unavailable'})
    await expect(validateAudienceScopeEvidence(evidence,ceiling)).rejects.toMatchObject({reason:'delivery_audience_unverified'})
    await pool.query('DELETE FROM saved_views WHERE id=$1',[page.id])
    await expect(validateCallerScopeEvidence(evidence,ceiling)).rejects.toMatchObject({diagnostic:'source_unverifiable'})
  })
  it('requires all causal page floors even when the caller supplies only a changed-page descriptor',async()=>{
    const f=await fixture(),parent=await f.page(),child=await f.page(null,parent.id)
    await pool.query("UPDATE saved_views SET clearance='confidential' WHERE id=$1",[parent.id])
    const source=(await pool.query('SELECT read_page_event_authority($1,$2,$3) AS authority',[f.workspaceId,child.page_event_revision,f.owner])).rows[0].authority.boundaries.find((b:{role:string})=>b.role==='changed').savedSource
    const ceiling:AccessCeiling={workspaceId:f.workspaceId,userId:f.owner,clearance:'internal',
      compartments:null,mutationCompartments:null,projectIds:null,visibilityAssistantIds:null}
    await expect(validateCallerScopeEvidence({sources:[source]},ceiling)).rejects.toMatchObject({diagnostic:'source_reclassified'})
    const admitted=await validateCallerScopeEvidence({sources:[source]},{...ceiling,clearance:'confidential'})
    expect(admitted.sources?.map(s=>s.resourceKind).sort()).toEqual(['page_event_changed','page_event_destination','page_live_changed','page_live_destination'])
    expect(admitted.sensitivity).toBe('confidential')
  })
  it('retains private live observations in the actual accumulator after sharing, and reuses unchanged observations',async()=>{
    const f=await fixture(),page=await f.page(),space=randomUUID()
    const read=async()=> (await pool.query('SELECT read_page_event_authority($1,$2,$3) AS authority',[f.workspaceId,page.page_event_revision,f.owner])).rows[0].authority.boundaries[0]
    const privateState=await read(),accumulator=new ContextScopeAccumulator({sources:[privateState.currentSource]})
    expect((await read()).currentSource).toEqual(privateState.currentSource)
    await pool.query("INSERT INTO teamspaces(id,workspace_id,name,created_by) VALUES($1,$2,'Observed space',$3)",[space,f.workspaceId,f.owner])
    await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[space,f.owner])
    await pool.query('UPDATE saved_views SET teamspace_id=$2 WHERE id=$1',[page.id,space])
    const shared=await read()
    expect(shared.currentSource.userId).toBeNull()
    expect(shared.currentSource.resourceId).not.toBe(privateState.currentSource.resourceId)
    accumulator.note({sources:[shared.currentSource]})
    expect(accumulator.evidence.sources).toHaveLength(2)
    expect(accumulator.evidence.sources).toContainEqual(privateState.currentSource)
    const rows=(await pool.query('SELECT id,boundary FROM workflow_page_event_observations WHERE receipt_id=$1',[page.page_event_revision])).rows
    expect(rows).toHaveLength(2)
    await expect(pool.query("UPDATE workflow_page_event_observations SET boundary='{}' WHERE id=$1",[privateState.currentSource.resourceId])).rejects.toThrow('page_event_observation_immutable')
    await pool.query('DELETE FROM saved_views WHERE id=$1',[page.id])
    expect((await pool.query('SELECT id,boundary FROM workflow_page_event_observations WHERE receipt_id=$1',[page.page_event_revision])).rows).toEqual(rows)
  })
  it('keeps immutable and current descriptors distinct through reclassification and deletion',async()=>{
    const f=await fixture(),page=await f.page()
    const read=async()=> (await pool.query('SELECT read_page_event_authority($1,$2,$3) AS authority',[f.workspaceId,page.page_event_revision,f.owner])).rows[0].authority.boundaries[0]
    const initial=await read()
    expect(initial.savedSource).toMatchObject({resourceKind:'page_event_changed',resourceId:page.page_event_revision,
      version:page.page_event_revision,workspaceId:f.workspaceId,userId:f.owner,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]})
    expect(initial.currentSource).toMatchObject({resourceKind:'page_live_changed',userId:f.owner,sensitivity:'internal'})
    expect(initial.currentSource.resourceId).not.toBe(page.page_event_revision)
    await pool.query("UPDATE saved_views SET clearance='confidential' WHERE id=$1",[page.id])
    const raised=await read()
    expect(raised.savedSource).toEqual(initial.savedSource)
    expect(raised.currentSource.sensitivity).toBe('confidential')
    expect(raised.currentSource.version).not.toBe(initial.currentSource.version)
    await pool.query("UPDATE saved_views SET name='Content-only rename' WHERE id=$1",[page.id])
    expect((await read()).currentSource).toEqual(raised.currentSource)
    await pool.query('DELETE FROM saved_views WHERE id=$1',[page.id])
    const deleted=await read()
    expect(deleted.savedSource).toEqual(initial.savedSource)
    expect(deleted.currentSource).toBeNull()
  })
  it('holds Teamspace membership through the caller transaction and denies the next read after removal',async()=>{
    const f=await fixture(),space=randomUUID()
    await pool.query("INSERT INTO teamspaces(id,workspace_id,name,created_by) VALUES($1,$2,'Locked space',$3)",[space,f.workspaceId,f.owner])
    await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[space,f.owner])
    const page=await f.page(space),reader=await pool.connect(),writer=await pool.connect()
    try {
      await reader.query('BEGIN')
      const read=(await reader.query('SELECT read_page_event_authority($1,$2,$3) AS authority',[f.workspaceId,page.page_event_revision,f.owner])).rows[0].authority
      expect(read.boundaries[0].principalAllowed).toBe(true)
      await writer.query('BEGIN')
      await writer.query("SET LOCAL lock_timeout='100ms'")
      await expect(writer.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[space,f.owner])).rejects.toMatchObject({code:'55P03'})
      await writer.query('ROLLBACK')
      await reader.query('COMMIT')
      await writer.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[space,f.owner])
      const after=(await reader.query('SELECT read_page_event_authority($1,$2,$3) AS authority',[f.workspaceId,page.page_event_revision,f.owner])).rows[0].authority
      expect(after.boundaries[0].principalAllowed).toBe(false)
    }finally{
      await reader.query('ROLLBACK');await writer.query('ROLLBACK')
      reader.release();writer.release()
    }
  })
  it('retains saved Teamspace membership after a move or deletion without an owner bypass',async()=>{
    const f=await fixture(),oldSpace=randomUUID(),nextSpace=randomUUID()
    for(const id of [oldSpace,nextSpace])await pool.query("INSERT INTO teamspaces(id,workspace_id,name,sensitivity,created_by) VALUES($1,$2,'Principal space','internal',$3)",[id,f.workspaceId,f.owner])
    const page=await f.page(oldSpace)
    const read=async()=> (await pool.query('SELECT read_page_event_authority($1,$2,$3) AS authority',[f.workspaceId,page.page_event_revision,f.owner])).rows[0].authority
    // Workspace ownership does not imply Teamspace membership.
    expect((await read()).boundaries[0].principalAllowed).toBe(false)
    await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[oldSpace,f.owner])
    expect((await read()).boundaries[0].principalAllowed).toBe(true)
    await pool.query('UPDATE saved_views SET teamspace_id=$2 WHERE id=$1',[page.id,nextSpace])
    const moved=await read()
    expect(moved.boundaries[0]).toMatchObject({principalAllowed:false,saved:{teamspaceId:oldSpace},current:{teamspaceId:nextSpace}})
    await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[nextSpace,f.owner])
    expect((await read()).boundaries[0].principalAllowed).toBe(true)
    await pool.query('DELETE FROM saved_views WHERE id=$1',[page.id])
    expect((await read()).boundaries[0]).toMatchObject({principalAllowed:true,current:null})
    await pool.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[oldSpace,f.owner])
    expect((await read()).boundaries[0].principalAllowed).toBe(false)
  })
  it('requires private ownership for both causal pages but does not add a parent to an update event',async()=>{
    const f=await fixture(),other=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[other])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[f.workspaceId,other])
    const parent=await f.page(),child=await f.page(null,parent.id)
    await pool.query('UPDATE saved_views SET created_by=$2 WHERE id=$1',[parent.id,other])
    const read=async(revision:string,actor=f.owner)=> (await pool.query('SELECT read_page_event_authority($1,$2,$3) AS authority',[f.workspaceId,revision,actor])).rows[0].authority
    const created=await read(child.page_event_revision)
    expect(created.boundaries).toHaveLength(2)
    expect(created.boundaries.find((b:{role:string})=>b.role==='changed').principalAllowed).toBe(true)
    expect(created.boundaries.find((b:{role:string})=>b.role==='destination').principalAllowed).toBe(false)
    expect((await read(child.page_event_revision,other)).boundaries.every((b:{principalAllowed:boolean})=>b.principalAllowed)).toBe(false)
    const updated=(await pool.query("UPDATE saved_views SET name='Own updated title' WHERE id=$1 RETURNING page_event_revision",[child.id])).rows[0]
    expect((await read(updated.page_event_revision)).boundaries).toHaveLength(1)
    expect((await read(updated.page_event_revision)).boundaries[0].principalAllowed).toBe(true)
    await expect(queryWithRLS(f.owner,'SELECT read_page_event_authority($1,$2,$3)',[f.workspaceId,child.page_event_revision,f.owner])).rejects.toMatchObject({code:'42501'})
    expect((await pool.query('SELECT read_page_event_authority($1,$2,$3) AS authority',[randomUUID(),child.page_event_revision,f.owner])).rows[0].authority).toBeNull()
  })
  it('binds real metadata and deferred-created emissions to their committed revision',async()=>{
    const f=await fixture(),events:PageLifecycleEvent[]=[]
    const store=createDbSavedViewStore({onPageLifecycle:event=>events.push(event)})
    const page=await store.createDraft({userId:f.owner,workspaceId:f.workspaceId,name:'Deferred title',
      entity:'tasks',viewType:'table',binding:{entity:'tasks',viewType:'table'},page:{blocks:[]},
      teamspaceId:null,deferCreatedEvent:true})
    expect(events).toHaveLength(0)
    expect(await store.commitCreatedEvent(f.owner,page.id)).toBe(true)
    expect(await store.commitCreatedEvent(f.owner,page.id)).toBe(false)
    expect(events).toHaveLength(1)
    const first=await f.receipt(events[0].sourceVersion!)
    expect(first.metadata).toMatchObject({title:'Deferred title',createdEventPending:false,actorId:f.owner,action:'created'})
    await store.update(f.owner,page.id,{name:'Updated title'})
    expect(events).toHaveLength(2)
    expect(events[1].sourceVersion).not.toBe(events[0].sourceVersion)
    expect((await f.receipt(events[1].sourceVersion!)).metadata).toMatchObject({title:'Updated title',actorId:f.owner,action:'updated'})
    expect(await f.receipt(events[0].sourceVersion!)).toEqual(first)
    const parent=await f.page()
    expect(await store.reparent(f.owner,page.id,parent.id,0)).toBe(true)
    expect(events).toHaveLength(3)
    const moved=await f.receipt(events[2].sourceVersion!)
    expect(moved.metadata).toMatchObject({title:'Updated title',parentId:parent.id,action:'moved',actorId:f.owner})
    expect(moved.boundaries.destination).toMatchObject({pageId:parent.id,principalBoundary:'private'})
  })
  it('captures fresh body-settle protection without altering the page or borrowing its metadata revision',async()=>{
    const f=await fixture(),space=randomUUID()
    await pool.query("INSERT INTO teamspaces(id,workspace_id,name,sensitivity,created_by) VALUES($1,$2,'Body space','internal',$3)",[space,f.workspaceId,f.owner])
    const page=await f.page(space),store=createDbSavedViewStore()
    const original=(await pool.query('SELECT * FROM saved_views WHERE id=$1',[page.id])).rows[0]
    await pool.query("UPDATE teamspaces SET sensitivity='confidential' WHERE id=$1",[space])
    const context=await store.getPageEventContextSystem(page.id)
    expect(context).toMatchObject({workspaceId:f.workspaceId,parentId:null,title:'Receipt title'})
    expect(context!.sourceVersion).not.toBe(page.page_event_revision)
    const receipt=await f.receipt(context!.sourceVersion)
    expect(receipt.boundaries.changed).toMatchObject({sensitivity:'confidential',teamspaceId:space,principalBoundary:'teamspace'})
    expect(receipt.metadata).toMatchObject({actorId:null,action:'updated',writeKind:'body'})
    expect((await pool.query('SELECT * FROM saved_views WHERE id=$1',[page.id])).rows[0]).toEqual(original)
    await pool.query('DELETE FROM saved_views WHERE id=$1',[page.id])
    expect(await store.getPageEventContextSystem(page.id)).toBeNull()
    expect(await f.receipt(context!.sourceVersion)).toEqual(receipt)
  })
  it('retains exact private metadata after rename, reclassification and deletion',async()=>{
    const f=await fixture(),page=await f.page()
    const before=await f.receipt(page.page_event_revision)
    expect(before.metadata).toMatchObject({pageId:page.id,title:'Receipt title',parentId:null,creatorId:f.owner,writeKind:'insert'})
    expect(before.boundaries.changed).toMatchObject({principalBoundary:'private',creatorId:f.owner,sensitivity:'internal',unavailable:false})
    const updated=(await pool.query("UPDATE saved_views SET name='Renamed',clearance='public' WHERE id=$1 RETURNING page_event_revision",[page.id])).rows[0]
    expect(updated.page_event_revision).not.toBe(page.page_event_revision)
    expect((await f.receipt(updated.page_event_revision)).metadata.title).toBe('Renamed')
    await pool.query('DELETE FROM saved_views WHERE id=$1',[page.id])
    expect(await f.receipt(page.page_event_revision)).toEqual(before)
  })
  it('captures the changed and destination boundaries without turning an unlinked Teamspace into General',async()=>{
    const f=await fixture(),teamspace=randomUUID(),department=randomUUID(),linked=randomUUID()
    await pool.query("INSERT INTO teamspaces(id,workspace_id,name,sensitivity,created_by) VALUES($1,$2,'Unlinked space','confidential',$3)",[teamspace,f.workspaceId,f.owner])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Receipt department',$3,'team',$1::text,$4)",[department,f.workspaceId,f.owner,`team:${department}`])
    await pool.query("INSERT INTO teamspaces(id,workspace_id,name,sensitivity,created_by,workspace_group_id) VALUES($1,$2,'Linked space','confidential',$3,$4)",[linked,f.workspaceId,f.owner,department])
    const parent=await f.page(linked),child=await f.page(teamspace,parent.id)
    const receipt=await f.receipt(child.page_event_revision)
    expect(receipt.boundaries.changed).toMatchObject({teamspaceId:teamspace,principalBoundary:'teamspace',sensitivity:'confidential',compartments:[],unavailable:false})
    expect(receipt.boundaries.destination).toMatchObject({pageId:parent.id,departmentId:department,principalBoundary:'department',sensitivity:'confidential',compartments:[`team:${department}`]})
    await pool.query("UPDATE teamspaces SET sensitivity='public' WHERE id=ANY($1::uuid[])",[[teamspace,linked]])
    expect(await f.receipt(child.page_event_revision)).toEqual(receipt)
  })
  it('makes receipt reads and writes unavailable to the non-bypass app role, including owners',async()=>{
    const f=await fixture(),page=await f.page()
    // Depending on deployment grants, RLS can return no rows or privilege denial.
    try {expect((await queryWithRLS(f.owner,'SELECT * FROM workflow_page_event_receipts WHERE revision=$1',[page.page_event_revision])).rows).toEqual([])}
    catch(error){expect((error as {code:string}).code).toBe('42501')}
    await expect(queryWithRLS(f.owner,"UPDATE workflow_page_event_receipts SET metadata='{}' WHERE revision=$1 RETURNING revision",[page.page_event_revision]).then(r=>{
      if(r.rows.length===0)throw Object.assign(new Error('RLS denied'),{code:'42501'})
    })).rejects.toMatchObject({code:'42501'})
    expect((await f.receipt(page.page_event_revision)).metadata.title).toBe('Receipt title')
  })
  it('rolls receipts back with the page transaction and rejects caller-selected revisions',async()=>{
    const f=await fixture(),client=await pool.connect(),id=randomUUID(),supplied=randomUUID()
    try {
      await client.query('BEGIN')
      const inserted=(await client.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,page_event_revision)
        VALUES($1,$2,$3,'Rolled back','tasks','table',$4) RETURNING page_event_revision`,[id,f.workspaceId,f.owner,supplied])).rows[0]
      expect(inserted.page_event_revision).not.toBe(supplied)
      expect((await client.query('SELECT revision FROM workflow_page_event_receipts WHERE page_id=$1',[id])).rows).toHaveLength(1)
      await client.query('ROLLBACK')
      expect((await pool.query('SELECT revision FROM workflow_page_event_receipts WHERE page_id=$1',[id])).rows).toHaveLength(0)
    } finally {client.release()}
  })
})
