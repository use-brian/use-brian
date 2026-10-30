import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getAppPool,getPool} from '../../db/client.js'
import {sessionContextGeneration,writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'
import {executeWorkspaceScopeReview as execute} from '../scope-review.js'
import {descendantAdapter,SCOPE_REVIEW_KINDS} from '../scope-review-registry.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(kind:'memory'|'workspace_file'='memory'){
 const f=await persistentContextFixture()
 const team=await createDbWorkspaceGroupStore().createTeam(f.ownerId,f.workspaceId,{name:'Personal',key:'personal'})
 const id=kind==='memory'?(await f.memory('Fictional review root')).id:randomUUID()
 if(kind==='workspace_file')await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,sensitivity)
  VALUES($1,$2,'/fictional-review.txt','fictional-review.txt','fixture://review',$3,'internal')`,[id,f.workspaceId,f.ownerId])
 const source=(await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,kind,id])).rows[0].source
 const now=Date.now()
 const revision=await writeSessionContextRevision({sessionId:f.session.id,parentId:randomUUID(),kind:'session_state',
  content:{key:'Fictional review',summary:'Fictional derived content',detail:null,status:'open',source:'tool',createdAt:now,updatedAt:now,resolvedAt:null},
  authority:await f.modelContext(),expectedGeneration:await sessionContextGeneration(f.session.id),
  derivation:{producer:'fixture:scope-review',sources:[source]}})
 if(!revision)throw Error('Expected a real canonical context revision')
 const preview=()=>execute(f.workspaceId,f.ownerId,{type:'scope.review.preview',resourceKind:kind,resourceIds:[id],action:'assign_team',targetTeamId:team.id,reason:'Move fictional current root into Personal'})
 const apply=(job:Awaited<ReturnType<typeof preview>>)=>execute(f.workspaceId,f.ownerId,{type:'scope.review.apply',reviewId:job.id,expectedVersion:job.version,payloadHash:job.payloadHash})
 return {...f,team,id,kind,source,revision,preview,apply}
}

describe.sequential('[COMP:api/workspace-scope-review] immutable derived revision impact',()=>{
 afterAll(async()=>{await getAppPool().end();await pool.end()})
 it.each(['memory','workspace_file'] as const)('reviews and moves a %s with a real context revision while holding its dependent',async kind=>{
  const f=await fixture(kind)
  try{
   const job=await f.preview()
   expect(job.items[0].impact?.descendants).toContainEqual({resourceKind:'session_context_revision',resourceId:f.revision.id,version:'1',held:false})
   expect((await f.apply(job)).status).toBe('complete')
   const after=(await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,kind,f.id])).rows[0].source
   expect(after).toEqual({...f.source,compartments:[f.team.compartmentKey],version:String(Number(f.source.version)+1)})
   expect((await pool.query('SELECT scope_held FROM session_context_scope_revisions WHERE id=$1',[f.revision.id])).rows).toEqual([{scope_held:true}])
   expect((await f.apply(job)).status).toBe('complete')
  }finally{await f.cleanup()}
 })
 it('refuses a changed dependent hold before applying the root',async()=>{
  const f=await fixture()
  try{
   const job=await f.preview()
   await pool.query('UPDATE session_context_scope_revisions SET scope_held=true WHERE id=$1',[f.revision.id])
   expect((await f.apply(job)).status).toBe('stale')
   expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[f.id])).rows).toEqual([{compartments:[]}])
  }finally{await f.cleanup()}
 })
 it('keeps the SQL metadata reader tenant-bound and inaccessible to app_user',async()=>{
  const f=await fixture()
  try{
   expect((await pool.query('SELECT read_scope_review_impact_source($1,$2,$3) AS source',[f.workspaceId,'session_context_revision',f.revision.id])).rows[0].source).toEqual({version:'1',held:false})
   for(const [workspace,id] of [[randomUUID(),f.revision.id],[f.workspaceId,randomUUID()]]){
    expect((await pool.query('SELECT read_scope_review_impact_source($1,$2,$3) AS source',[workspace,'session_context_revision',id])).rows[0].source).toBeNull()
   }
   await expect(getAppPool().query('SELECT read_scope_review_impact_source($1,$2,$3)',[f.workspaceId,'session_context_revision',f.revision.id])).rejects.toMatchObject({code:'42501'})
   expect(SCOPE_REVIEW_KINDS).not.toContain('session_context_revision')
   expect(descendantAdapter('new_unsupported_kind')).toBeUndefined()
   expect(descendantAdapter('__proto__')).toBeUndefined()
  }finally{await f.cleanup()}
 })
 it('independently rejects forged revision references at the SQL guard',async()=>{
  const f=await fixture()
  try{
   const saved=await f.preview()
   for(const reference of [
    {resourceKind:'session_context_revision',resourceId:f.revision.id,version:'999',held:false},
    {resourceKind:'session_context_revision',resourceId:f.revision.id,version:'1',held:true},
    {resourceKind:'session_context_revision',resourceId:randomUUID(),version:'1',held:false},
    {resourceKind:'unsupported_revision',resourceId:f.revision.id,version:'1',held:false},
   ]){
    const id=randomUUID()
    await pool.query(`INSERT INTO workspace_scope_reviews(id,workspace_id,created_by,resource_kind,action,target_team_id,target_compartment,reason,payload_hash,policy_revision,selection_revision)
     SELECT $2,workspace_id,created_by,resource_kind,action,target_team_id,target_compartment,reason,payload_hash,policy_revision,selection_revision FROM workspace_scope_reviews WHERE id=$1`,[saved.id,id])
    await expect(pool.query(`INSERT INTO workspace_scope_review_items(workspace_id,review_id,resource_kind,resource_id,resource_version,source_snapshot,impact_snapshot)
     SELECT workspace_id,$2,resource_kind,resource_id,resource_version,source_snapshot,$3::jsonb FROM workspace_scope_review_items WHERE review_id=$1`,
     [saved.id,id,JSON.stringify({version:2,dependents:{},descendants:[reference]})])).rejects.toThrow('scope_review_reference_invalid')
   }
  }finally{await f.cleanup()}
 })
 it('reads only immutable Knowledge revision metadata, including held rows',async()=>{
  const f=await persistentContextFixture(),client=await pool.connect(),id=randomUUID()
  try{
   // Exercise the metadata reader before publication, then roll back. No
   // incomplete revision can be committed past the existing deferred guard.
   await client.query('BEGIN')
   await client.query(`INSERT INTO knowledge_entry_scope_revisions(id,workspace_id,entry_id,sensitivity,compartments,project_ids,revision_kind)
    VALUES($1,$2,$3,'internal','{}','{}','body')`,[id,f.workspaceId,randomUUID()])
   const read=async()=>(await client.query("SELECT read_scope_review_impact_source($1,'knowledge_entry_revision',$2) AS source",[f.workspaceId,id])).rows[0].source
   expect(await read()).toEqual({version:'1',held:false})
   await client.query('UPDATE knowledge_entry_scope_revisions SET scope_held=true WHERE id=$1',[id])
   expect(await read()).toEqual({version:'1',held:true})
   expect(SCOPE_REVIEW_KINDS).not.toContain('knowledge_entry_revision')
  }finally{await client.query('ROLLBACK');client.release();await f.cleanup()}
 })

})
