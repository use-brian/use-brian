import {randomUUID} from 'node:crypto'
import {ContextScopeAccumulator} from '@use-brian/core'
import express from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'
import {createMemory} from '../../db/memories.js'
import {addSessionMessage,createWorkspaceChatSession} from '../../db/sessions.js'
import {sessionContextGeneration,writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {workspaceAccessRoutes} from '../../routes/workspace-access.js'
import {previewLegacyCleanup as preview,applyLegacyCleanup as apply} from '../legacy-cleanup.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(){
 const f=await persistentContextFixture()
 const team=await createDbWorkspaceGroupStore().createTeam(f.ownerId,f.workspaceId,{name:'Personal',key:'personal'})
 const memory=await f.memory('Fictional obsolete memory')
 const retained=await createMemory({workspaceId:f.workspaceId,userId:f.ownerId,assistantId:f.assistantId,
  summary:'Fictional retained private memory',sensitivity:'internal',compartments:[team.compartmentKey!],createdByUserId:f.ownerId})
 const proposal={selections:[{kind:'memory',id:memory.id}],reason:'Remove explicitly selected fictional obsolete content'}
 const prepare=()=>preview(f.workspaceId,f.ownerId,proposal)
 const confirm=(r:{id:string;payloadHash:string})=>apply(f.workspaceId,f.ownerId,{reviewId:r.id,payloadHash:r.payloadHash})
 return{...f,team,memory,retained,proposal,prepare,confirm}
}
/** Model pre-scope rows only in the disposable fixture, never in production. */
async function legacyMessage(f:Awaited<ReturnType<typeof fixture>>){
 const id=randomUUID(),c=await pool.connect()
 try{
  await c.query('BEGIN');await c.query('SET LOCAL session_replication_role=replica')
  await c.query(`INSERT INTO session_messages(id,session_id,role,content,workspace_id,sensitivity,compartments,scope_version,sequence_num)
   VALUES($1,$2,'user','"Fictional unclassified history"',NULL,NULL,NULL,NULL,1)`,[id,f.session.id])
  await c.query('COMMIT');return id
 }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}
async function workflowHistory(f:Awaited<ReturnType<typeof fixture>>){
 const workflowId=randomUUID(),source=randomUUID(),copy=randomUUID()
 await pool.query(`INSERT INTO workflows(id,workspace_id,created_by,name,definition)
  VALUES($1,$2,$3,'Fictional legacy workflow','{"steps":[]}')`,[workflowId,f.workspaceId,f.ownerId])
 for(const id of [source,copy])await pool.query(`INSERT INTO workflow_runs(id,workflow_id,workspace_id,trigger_kind,status,vars)
  VALUES($1,$2,$3,'manual','completed','{"__contextScopeEvidence":{"sensitivity":"internal","compartments":[],"projectIds":[],"sources":[]}}')`,[id,workflowId,f.workspaceId])
 await pool.query('INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3)',[f.workspaceId,copy,source])
 return{workflowId,source,copy}
}
describe.sequential('[COMP:api/workspace-legacy-cleanup] owner-reviewed selective cleanup',()=>{
 afterAll(async()=>{await getAppPool().end();await pool.end()})
 it('erases explicitly consented Personal dependencies with their General source and retains other Personal data',async()=>{
  const f=await fixture()
  try{
   const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,f.memory.id])).rows[0].source
   const derived=await createMemory({workspaceId:f.workspaceId,userId:null,assistantId:f.assistantId,summary:'Fictional migrated dependent',
    sensitivity:'internal',compartments:[f.team.compartmentKey!],createdByUserId:f.ownerId,
    derivation:{producer:'fixture:consented-cleanup',sources:[source]}})
   const consent={kind:'memory',id:derived.id},body={selections:[...f.proposal.selections,consent],reason:'Erase exactly selected fictional dependencies'}
   const read=async()=>(await pool.query('SELECT to_jsonb(m) AS row FROM memories m WHERE id=$1',[f.retained.id])).rows[0].row
   const before=await read()
   await expect(f.prepare()).rejects.toMatchObject({code:'legacy_cleanup_retained_dependency'})
   const r=await preview(f.workspaceId,f.ownerId,{...body,eraseDepartmentRecords:[consent]})
   expect(r.departmentErasures).toEqual([{...consent,version:expect.any(String),compartments:[f.team.compartmentKey]}])
   expect((await f.confirm(r)).status).toBe('applied')
   expect((await f.confirm(r)).status).toBe('applied')
   expect((await pool.query('SELECT id FROM memories WHERE id=ANY($1::uuid[])',[[derived.id,f.memory.id]])).rowCount).toBe(0)
   expect(await read()).toEqual(before)
  }finally{await f.cleanup()}
 })
 it('requires exact selected consent and freezes consented scope, content and unrelated retention',async()=>{
  const f=await fixture(),consent={kind:'memory',id:randomUUID()}
  try{
   for(const body of [
    {...f.proposal,eraseDepartmentRecords:[consent]},
    {...f.proposal,selections:[consent],eraseDepartmentRecords:[consent,consent]},
    {...f.proposal,eraseDepartmentRecords:[{kind:'recording',id:f.memory.id}]},
   ])await expect(preview(f.workspaceId,f.ownerId,body)).rejects.toMatchObject({code:'invalid_command'})
   await expect(preview(f.workspaceId,f.ownerId,{...f.proposal,eraseDepartmentRecords:f.proposal.selections})).rejects.toMatchObject({code:'legacy_cleanup_department_consent_invalid'})
   const selected={kind:'memory',id:f.retained.id},body={selections:[selected],eraseDepartmentRecords:[selected],reason:'Erase selected fictional migrated record'}
   let r=await preview(f.workspaceId,f.ownerId,body)
   await pool.query("UPDATE memories SET summary='Fictional changed consented body' WHERE id=$1",[f.retained.id])
   await expect(f.confirm(r)).rejects.toMatchObject({code:'legacy_cleanup_changed'})
   r=await preview(f.workspaceId,f.ownerId,body)
   await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[f.retained.id])
   await expect(f.confirm(r)).rejects.toMatchObject({code:'legacy_cleanup_changed'})
   expect((await pool.query('SELECT id FROM memories WHERE id=$1',[f.retained.id])).rowCount).toBe(1)
  }finally{await f.cleanup()}
 })
 it('does not extend department consent to an unselected descendant',async()=>{
  const f=await fixture()
  try{
   const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,f.retained.id])).rows[0].source
   await createMemory({workspaceId:f.workspaceId,userId:null,assistantId:f.assistantId,summary:'Fictional protected descendant',
    sensitivity:'internal',compartments:[f.team.compartmentKey!],createdByUserId:f.ownerId,
    derivation:{producer:'fixture:protected-cleanup',sources:[source]}})
   const selected={kind:'memory',id:f.retained.id}
   await expect(preview(f.workspaceId,f.ownerId,{selections:[selected],eraseDepartmentRecords:[selected],reason:'Do not expand selected erasure'})).rejects.toMatchObject({code:'legacy_cleanup_retained_dependency'})
  }finally{await f.cleanup()}
 })
 it('erases a selected Personal episode and file with their General recording cascade',async()=>{
  const f=await fixture(),episode=randomUUID(),file=randomUUID()
  try{
   await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id)
    VALUES($1,$2,'/fictional.wav','fictional.wav','fixture://recording',$3)`,[file,f.workspaceId,f.ownerId])
   await pool.query(`INSERT INTO episodes(id,workspace_id,source_kind,source_ref,occurred_at,created_by_user_id)
    VALUES($1,$2,'recording','{}',now(),$3)`,[episode,f.workspaceId,f.ownerId])
   await pool.query(`INSERT INTO recordings(id,workspace_id,mime,gcs_key,media_file_id,created_by_user_id)
    VALUES($1,$2,'audio/wav','fixture-recording',$3,$4)`,[episode,f.workspaceId,file,f.ownerId])
   // Model an old General recording whose anchor and file were later migrated.
   await pool.query('UPDATE episodes SET compartments=$2 WHERE id=$1',[episode,[f.team.compartmentKey]])
   await pool.query('UPDATE workspace_files SET source_episode_id=$2,compartments=$3 WHERE id=$1',[file,episode,[f.team.compartmentKey]])
   expect((await pool.query('SELECT compartments FROM recordings WHERE id=$1',[episode])).rows[0].compartments).toEqual([])
   const consent=[{kind:'episode',id:episode},{kind:'workspace_file',id:file}]
   const body={selections:[...consent,{kind:'recording',id:episode}],reason:'Erase selected fictional recording dependencies',eraseDepartmentRecords:consent}
   await expect(preview(f.workspaceId,f.ownerId,{selections:[consent[0],{kind:'recording',id:episode}],eraseDepartmentRecords:[consent[0]],reason:body.reason})).rejects.toMatchObject({code:'legacy_cleanup_retained_dependency'})
   await expect(preview(f.workspaceId,f.ownerId,{selections:[consent[1]],eraseDepartmentRecords:[consent[1]],reason:body.reason})).rejects.toMatchObject({code:'legacy_cleanup_retained_dependency'})
   const r=await preview(f.workspaceId,f.ownerId,body)
   expect(r.erasedReferences.map(row=>row.kind).sort()).toEqual(['episode','recording','workspace_file'])
   expect((await f.confirm(r)).receipt).toMatchObject({retainedVerified:true})
   for(const [table,id] of [['episodes',episode],['recordings',episode],['workspace_files',file]])
    expect((await pool.query(`SELECT id FROM ${table} WHERE id=$1`,[id])).rowCount).toBe(0)
   expect((await pool.query('SELECT id FROM memories WHERE id=$1',[f.retained.id])).rowCount).toBe(1)
  }finally{await pool.query('DELETE FROM recordings WHERE id=$1',[episode]);await f.cleanup()}
 })
 it('independently rejects forged, missing, stale or unselected department consent in SQL evidence',async()=>{
  const f=await fixture()
  try{
   const selected={kind:'memory',id:f.retained.id}
   const r=await preview(f.workspaceId,f.ownerId,{selections:[selected],eraseDepartmentRecords:[selected],reason:'Review fictional exact department consent'})
   const saved=(await pool.query('SELECT evidence,selection FROM workspace_legacy_cleanup_reviews WHERE id=$1',[r.id])).rows[0]
   const consent=saved.evidence.departmentErasures[0]
   for(const [evidence,selection] of [
    [{...saved.evidence,departmentErasures:[]},saved.selection],
    [saved.evidence,f.proposal.selections],
    [{...saved.evidence,departmentErasures:[{...consent,compartments:['team:'+randomUUID()]}]},saved.selection],
    [{...saved.evidence,departmentErasures:[{...consent,version:'invented'}]},saved.selection],
    [{...saved.evidence,departmentErasures:[consent,consent]},saved.selection],
   ])await expect(pool.query(`INSERT INTO workspace_legacy_cleanup_reviews(id,workspace_id,actor_user_id,policy_revision,selection,evidence,payload_hash,expires_at)
    SELECT $2,workspace_id,actor_user_id,policy_revision,$3::jsonb,$4::jsonb,payload_hash,expires_at FROM workspace_legacy_cleanup_reviews WHERE id=$1`,
    [r.id,randomUUID(),JSON.stringify(selection),JSON.stringify(evidence)])).rejects.toThrow('legacy_cleanup_reference_invalid')
   expect((await f.confirm(r)).status).toBe('applied')
  }finally{await f.cleanup()}
 })
 it('erases copied General run history before deleting its legacy workflow',async()=>{
  const f=await fixture()
  try{
   const h=await workflowHistory(f)
   const r=await preview(f.workspaceId,f.ownerId,{selections:[{kind:'workflow',id:h.workflowId}],reason:'Erase fictional legacy workflow and copied history'})
   expect(r.erasedWorkflowRuns.map(row=>row.id).sort()).toEqual([h.source,h.copy].sort())
   expect((await f.confirm(r)).status).toBe('applied')
   expect((await pool.query('SELECT id FROM workflow_runs WHERE id=ANY($1::uuid[])',[[h.source,h.copy]])).rowCount).toBe(0)
   expect((await pool.query('SELECT id FROM workflows WHERE id=$1',[h.workflowId])).rowCount).toBe(0)
  }finally{await f.cleanup()}
 })
 it('erases only General history while retaining the workflow and unrelated Personal runs',async()=>{
  const f=await fixture(),personal=randomUUID()
  try{
   const h=await workflowHistory(f)
   await pool.query('UPDATE workflows SET context_group_id=$2 WHERE id=$1',[h.workflowId,f.team.id])
   await pool.query(`INSERT INTO workflow_runs(id,workflow_id,workspace_id,trigger_kind,status,context_group_id,context_compartments)
    VALUES($1,$2,$3,'manual','completed',$4,$5)`,[personal,h.workflowId,f.workspaceId,f.team.id,[f.team.compartmentKey]])
   await pool.query('UPDATE workflows SET context_group_id=NULL WHERE id=$1',[h.workflowId])
   const read=async()=>(await pool.query(`SELECT to_jsonb(w) AS workflow,to_jsonb(r) AS personal FROM workflows w
    JOIN workflow_runs r ON r.id=$2 WHERE w.id=$1`,[h.workflowId,personal])).rows[0]
   const before=await read()
   const r=await preview(f.workspaceId,f.ownerId,{selections:[{kind:'workflow_history',id:h.workflowId}],reason:'Erase fictional General history'})
   expect(r.erasedWorkflowRuns.map(row=>row.id).sort()).toEqual([h.source,h.copy].sort())
   expect((await f.confirm(r)).status).toBe('applied')
   expect(await read()).toEqual(before)
  }finally{await f.cleanup()}
 })
 it('rejects stale copied-run content and does not erase a Personal consumer or active history',async()=>{
  const f=await fixture()
  try{
   const h=await workflowHistory(f),body={selections:[{kind:'workflow',id:h.workflowId}],reason:'Review fictional copied history'}
   const r=await preview(f.workspaceId,f.ownerId,body)
   await pool.query(`UPDATE workflow_runs SET outcome='{"text":"Fictional changed output"}' WHERE id=$1`,[h.copy])
   await expect(f.confirm(r)).rejects.toMatchObject({code:'legacy_cleanup_changed'})
   const personal=randomUUID()
   await pool.query('UPDATE workflows SET context_group_id=$2 WHERE id=$1',[h.workflowId,f.team.id])
   await pool.query(`INSERT INTO workflow_runs(id,workflow_id,workspace_id,trigger_kind,status,context_group_id,context_compartments,vars)
    VALUES($1,$2,$3,'manual','completed',$4,$5,'{"__contextScopeEvidence":{"sensitivity":"internal","compartments":[],"projectIds":[],"sources":[]}}')`,[personal,h.workflowId,f.workspaceId,f.team.id,[f.team.compartmentKey]])
   await pool.query('INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3)',[f.workspaceId,personal,h.source])
   await pool.query('UPDATE workflows SET context_group_id=NULL WHERE id=$1',[h.workflowId])
   await expect(preview(f.workspaceId,f.ownerId,body)).rejects.toMatchObject({code:'legacy_cleanup_retained_dependency'})
   await expect(preview(f.workspaceId,f.ownerId,{...body,selections:[{kind:'workflow_history',id:h.workflowId}]})).rejects.toMatchObject({code:'legacy_cleanup_workflow_copy_dependency'})
   await pool.query('DELETE FROM workflow_runs WHERE id=$1',[personal])
   await pool.query("UPDATE workflow_runs SET status='running' WHERE id=$1",[h.copy])
   await expect(preview(f.workspaceId,f.ownerId,body)).rejects.toMatchObject({code:'legacy_cleanup_running'})
  }finally{await f.cleanup()}
 })
 it.each([['55000',409,'legacy_cleanup_blocked'],['XX000',500,'legacy_cleanup_database_error']] as const)(
  'returns only bounded database blocker metadata for SQLSTATE %s',async(sqlState,status,code)=>{
  const f=await fixture(),name='cleanup_guard_'+randomUUID().replaceAll('-',''),app=express()
  try{
   await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'Fictional secret bytes must not escape' USING ERRCODE='${sqlState}',DETAIL='Fictional protected detail';END $$`)
   await pool.query(`CREATE TRIGGER ${name} BEFORE DELETE ON memories FOR EACH ROW EXECUTE FUNCTION ${name}()`)
   app.use(express.json());app.use((req,_res,next)=>{req.userId=f.ownerId;next()});app.use('/api',workspaceAccessRoutes())
   const r=await request(app).post(`/api/workspaces/${f.workspaceId}/access/legacy-cleanup/preview`).send(f.proposal)
   expect(r.status).toBe(status)
   expect(r.body).toEqual({error:code,blocker:{sqlState,function:name}})
   expect((await pool.query('SELECT id FROM memories WHERE id=$1',[f.memory.id])).rowCount).toBe(1)
  }finally{
   await pool.query(`DROP TRIGGER IF EXISTS ${name} ON memories`);await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);await f.cleanup()
  }
 })
 it('requires explicit consent for unclassified history and retains unknown records outside the selection',async()=>{
  const f=await fixture(),other=await fixture()
  try{
   const spareSession=await createWorkspaceChatSession({workspaceId:f.workspaceId,assistantId:f.assistantId,starterUserId:f.ownerId,effectiveClearance:'internal',authenticatedHuman:true})
   const spareId=await legacyMessage({...f,session:spareSession})
   const id=await legacyMessage(f),otherId=await legacyMessage(other)
   const body={selections:[{kind:'session',id:f.session.id}],reason:'Erase explicitly selected fictional unclassified history'}
   await expect(preview(f.workspaceId,f.ownerId,body)).rejects.toMatchObject({code:'legacy_cleanup_scoped_record'})
   const r=await preview(f.workspaceId,f.ownerId,{...body,eraseUnclassifiedLegacy:true})
   expect(r.unclassifiedReferences).toEqual([{kind:'session_message',id,version:expect.stringMatching(/^legacy:/)}])
   await pool.query(`UPDATE session_messages SET content='"Unrelated changed fictional history"' WHERE id=$1`,[spareId])
   await expect(f.confirm(r)).rejects.toMatchObject({code:'legacy_cleanup_changed'})
   expect((await f.confirm(await preview(f.workspaceId,f.ownerId,{...body,eraseUnclassifiedLegacy:true}))).status).toBe('applied')
   expect((await pool.query('SELECT id FROM session_messages WHERE id=$1',[id])).rowCount).toBe(0)
   expect((await pool.query('SELECT id FROM session_messages WHERE id=$1',[otherId])).rowCount).toBe(1)
   expect((await pool.query('SELECT id FROM session_messages WHERE id=$1',[spareId])).rowCount).toBe(1)
   expect((await pool.query('SELECT id FROM memories WHERE id=$1',[f.retained.id])).rowCount).toBe(1)
  }finally{await other.cleanup();await f.cleanup()}
 })
 it('erases explicitly selected unclassified verification and correction history',async()=>{
  const f=await fixture(),ids=[randomUUID(),randomUUID(),randomUUID()],c=await pool.connect()
  try{
   await c.query('BEGIN');await c.query('SET LOCAL session_replication_role=replica')
   await c.query(`INSERT INTO memory_verifications(id,memory_id,workspace_id,verified_by,action)
    VALUES($1,$2,$3,$4,'confirm')`,[ids[0],f.memory.id,f.workspaceId,f.ownerId])
   await c.query(`INSERT INTO brain_verifications(id,target_kind,target_id,workspace_id,verified_by,action)
    VALUES($1,'task',$2,$3,$4,'confirm')`,[ids[1],randomUUID(),f.workspaceId,f.ownerId])
   await c.query(`INSERT INTO correction_audit(id,workspace_id,action,primitive,row_id,actor_user_id)
    VALUES($1,$2,'purge','memory',$3,$4)`,[ids[2],f.workspaceId,f.memory.id,f.ownerId])
   await c.query('COMMIT')
   const selections=ids.map((id,index)=>({kind:['memory_verification','brain_verification','correction_audit'][index],id}))
   const body={selections,reason:'Erase explicitly selected fictional unclassified audit history',eraseUnclassifiedLegacy:true}
   const r=await preview(f.workspaceId,f.ownerId,body)
   expect(r.unclassifiedReferences).toHaveLength(3)
   expect((await f.confirm(r)).status).toBe('applied')
   expect((await pool.query('SELECT id FROM memories WHERE id=ANY($1::uuid[])',[[f.memory.id,f.retained.id]])).rowCount).toBe(2)
  }catch(error){await c.query('ROLLBACK');throw error}finally{c.release();await f.cleanup()}
 })
 it('follows legacy message derivations even when the old message has no workspace column',async()=>{
  const f=await fixture(),c=await pool.connect(),derivation=randomUUID()
  try{
   const id=await legacyMessage(f)
   const version=(await pool.query("SELECT read_scope_review_source($1,'session_message',$2)->>'version' AS version",[f.workspaceId,id])).rows[0].version
   await c.query('BEGIN');await c.query('SET LOCAL session_replication_role=replica')
   await c.query(`INSERT INTO scope_derivations(id,workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
    SELECT $1,workspace_id,'memory',id,scope_version::text,'fixture:historical-message',user_id,assistant_id,sensitivity,compartments,project_ids,1 FROM memories WHERE id=$2`,[derivation,f.retained.id])
   await c.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
    VALUES($1,$2,'session_message',$3,$4)`,[f.workspaceId,derivation,id,version])
   await c.query('COMMIT')
   await expect(preview(f.workspaceId,f.ownerId,{selections:[{kind:'session',id:f.session.id}],reason:'Refuse erasure under retained Personal memory',eraseUnclassifiedLegacy:true})).rejects.toMatchObject({code:'legacy_cleanup_retained_dependency'})
   expect((await pool.query('SELECT id FROM session_messages WHERE id=$1',[id])).rowCount).toBe(1)
  }catch(error){await c.query('ROLLBACK');throw error}finally{c.release();await f.cleanup()}
 })
 it('pins unclassified message bodies and refuses department selections even with erasure consent',async()=>{
  const f=await fixture()
  try{
   const id=await legacyMessage(f)
   const r=await preview(f.workspaceId,f.ownerId,{selections:[{kind:'session',id:f.session.id}],reason:'Erase fictional old conversation',eraseUnclassifiedLegacy:true})
   await pool.query(`UPDATE session_messages SET content='"Changed fictional history"' WHERE id=$1`,[id])
   await expect(f.confirm(r)).rejects.toMatchObject({code:'legacy_cleanup_changed'})
   await expect(preview(f.workspaceId,f.ownerId,{selections:[{kind:'memory',id:f.retained.id}],reason:'Cannot erase retained Personal data',eraseUnclassifiedLegacy:true})).rejects.toMatchObject({code:'legacy_cleanup_scoped_record'})
  }finally{await f.cleanup()}
 })
 it('independently rejects missing consent, unselected and department-labelled unclassified SQL proofs',async()=>{
  const f=await fixture()
  try{
   await legacyMessage(f)
   const r=await preview(f.workspaceId,f.ownerId,{selections:[{kind:'session',id:f.session.id}],reason:'Review fictional unknown history',eraseUnclassifiedLegacy:true})
   const saved=(await pool.query('SELECT evidence,selection FROM workspace_legacy_cleanup_reviews WHERE id=$1',[r.id])).rows[0]
   for(const [evidence,selection] of [
    [{...saved.evidence,eraseUnclassifiedLegacy:false},saved.selection],
    [{...saved.evidence,unclassified:[]},saved.selection],
    [saved.evidence,[{kind:'session',id:randomUUID()}]],
    [{...saved.evidence,unclassified:[{kind:'memory',id:f.retained.id,version:'1'}],erasures:[{kind:'memory',id:f.retained.id,version:'1'}]},[{kind:'memory',id:f.retained.id}]],
   ]){
    await expect(pool.query(`INSERT INTO workspace_legacy_cleanup_reviews(id,workspace_id,actor_user_id,policy_revision,selection,evidence,payload_hash,expires_at)
     SELECT $2,workspace_id,actor_user_id,policy_revision,$3::jsonb,$4::jsonb,payload_hash,expires_at FROM workspace_legacy_cleanup_reviews WHERE id=$1`,
     [r.id,randomUUID(),JSON.stringify(selection),JSON.stringify(evidence)])).rejects.toThrow('legacy_cleanup_reference_invalid')
   }
  }finally{await f.cleanup()}
 })
 it('erases General cache and purged Office impacts without canonical ancestry',async()=>{
  const f=await fixture()
  try{
   const cache=(await pool.query(`INSERT INTO file_cache(session_id,file_name,mime_type,content,size_bytes,expires_at,workspace_id,user_id,assistant_id,sensitivity)
    VALUES($1,'obsolete.txt','text/plain','Fictional cached bytes',21,now()+interval '1 day',$2,$3,$4,'internal') RETURNING id`,[f.session.id,f.workspaceId,f.ownerId,f.assistantId])).rows[0].id
   const office=(await pool.query(`INSERT INTO office_artifacts(workspace_id,family,title,creator_user_id,owner_user_id,capability_version,sensitivity,visibility_user_ids,lifecycle_state)
    VALUES($1,'document','Fictional purged artifact',$2,$2,1,'internal',ARRAY[$2]::uuid[],'purged') RETURNING id`,[f.workspaceId,f.ownerId])).rows[0].id
   const r=await preview(f.workspaceId,f.ownerId,{selections:[{kind:'file_cache',id:cache},{kind:'office_artifact',id:office}],reason:'Erase fictional obsolete impacts'})
   expect(r.erasedReferences.map(row=>row.kind).sort()).toEqual(['file_cache','office_artifact'])
   expect((await f.confirm(r)).status).toBe('applied')
  }finally{await f.cleanup()}
 })
 it('previews without deleting, applies once, retains department content and leaves a removed reference',async()=>{
  const f=await fixture()
  try{
   const before=(await pool.query('SELECT to_jsonb(m) AS row FROM memories m WHERE id=$1',[f.retained.id])).rows[0].row
   const r=await f.prepare()
   expect(r.status).toBe('preview');expect(r.erasedReferences).toEqual([{kind:'memory',id:f.memory.id,version:'1'}])
   expect((await pool.query('SELECT id FROM memories WHERE id=$1',[f.memory.id])).rowCount).toBe(1)
   expect((await f.confirm(r)).status).toBe('applied')
   expect((await pool.query('SELECT id FROM memories WHERE id=$1',[f.memory.id])).rowCount).toBe(0)
   expect((await pool.query('SELECT to_jsonb(m) AS row FROM memories m WHERE id=$1',[f.retained.id])).rows[0].row).toEqual(before)
   expect((await pool.query("SELECT read_scope_review_impact_source($1,'memory',$2) AS ref",[f.workspaceId,f.memory.id])).rows[0].ref)
    .toEqual({version:`erased:${r.id}:1`,held:true,removed:true})
   expect((await f.confirm(r)).status).toBe('applied')
   expect((await pool.query("SELECT count(*)::int AS n FROM workspace_access_events WHERE workspace_id=$1 AND kind='legacy.cleanup.apply'",[f.workspaceId])).rows[0].n).toBe(1)
  }finally{await f.cleanup()}
 })
 it('requires the current owner, rejects foreign selections and cannot select department records',async()=>{
  const f=await fixture(),other=await persistentContextFixture()
  try{
   await expect(preview(f.workspaceId,f.firstId,f.proposal)).rejects.toMatchObject({code:'owner_required'})
   await expect(preview(other.workspaceId,other.ownerId,f.proposal)).rejects.toMatchObject({code:'legacy_cleanup_selection_unavailable'})
   await expect(preview(f.workspaceId,f.ownerId,{...f.proposal,selections:[{kind:'memory',id:f.retained.id}]})).rejects.toMatchObject({code:'legacy_cleanup_scoped_record'})
  }finally{await other.cleanup();await f.cleanup()}
 })
 it('rejects a changed selected body or retained content without deleting anything',async()=>{
  const f=await fixture()
  try{
   const r=await f.prepare()
   await pool.query("UPDATE memories SET summary='Fictional changed retained content' WHERE id=$1",[f.retained.id])
   await expect(f.confirm(r)).rejects.toMatchObject({code:'legacy_cleanup_changed'})
   const fresh=await f.prepare()
   await pool.query("UPDATE memories SET summary='Fictional changed selected content' WHERE id=$1",[f.memory.id])
   await expect(f.confirm(fresh)).rejects.toMatchObject({code:'legacy_cleanup_changed'})
   expect((await pool.query('SELECT count(*)::int AS n FROM memories WHERE id=ANY($1::uuid[])',[[f.memory.id,f.retained.id]])).rows[0].n).toBe(2)
  }finally{await f.cleanup()}
 })
 it('refuses erasure of an ancestor of retained department data',async()=>{
  const f=await fixture()
  try{
   const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,f.memory.id])).rows[0].source
   await createMemory({workspaceId:f.workspaceId,userId:null,assistantId:f.assistantId,summary:'Fictional retained derived fact',
    sensitivity:'internal',compartments:[f.team.compartmentKey!],createdByUserId:f.ownerId,
    derivation:{producer:'fixture:retained-cleanup',sources:[source]}})
   await expect(f.prepare()).rejects.toMatchObject({code:'legacy_cleanup_retained_dependency'})
   expect((await pool.query('SELECT id FROM memories WHERE id=$1',[f.memory.id])).rowCount).toBe(1)
  }finally{await f.cleanup()}
 })
 it('cancels a saved proposal and rejects forged, oversized and unknown selections',async()=>{
  const f=await fixture()
  try{
   for(const selections of [[{kind:'unsupported',id:f.memory.id}],Array.from({length:26},()=>({kind:'memory',id:randomUUID()})),[f.proposal.selections[0],f.proposal.selections[0]]]){
    await expect(preview(f.workspaceId,f.ownerId,{...f.proposal,selections})).rejects.toMatchObject({code:'invalid_command'})
   }
   const r=await f.prepare()
   await expect(apply(f.workspaceId,f.ownerId,{reviewId:r.id,payloadHash:'0'.repeat(64)})).rejects.toMatchObject({code:'legacy_cleanup_changed'})
   expect((await apply(f.workspaceId,f.ownerId,{reviewId:r.id,payloadHash:r.payloadHash},true)).status).toBe('cancelled')
   await expect(f.confirm(r)).rejects.toMatchObject({code:'legacy_cleanup_not_active'})
  }finally{await f.cleanup()}
 })
 it('denies application-role access and keeps saved evidence immutable',async()=>{
  const f=await fixture()
  try{
   const r=await f.prepare()
   await expect(getAppPool().query('SELECT * FROM workspace_legacy_cleanup_reviews')).rejects.toMatchObject({code:'42501'})
   await expect(getAppPool().query('SELECT read_scope_review_impact_source($1,$2,$3)',[f.workspaceId,'memory',f.memory.id])).rejects.toMatchObject({code:'42501'})
   await expect(pool.query("UPDATE workspace_legacy_cleanup_reviews SET evidence='{}' WHERE id=$1",[r.id])).rejects.toThrow('legacy_cleanup_review_immutable')
   await expect(pool.query('DELETE FROM workspace_legacy_cleanup_reviews WHERE id=$1',[r.id])).rejects.toThrow('legacy_cleanup_review_immutable')
   await expect(pool.query("UPDATE workspace_legacy_cleanup_reviews SET status='applied',receipt='{}' WHERE id=$1",[r.id])).rejects.toThrow('legacy_cleanup_reference_invalid')
  }finally{await f.cleanup()}
 })
 it('erases an unbound conversation with its General messages',async()=>{
  const f=await fixture()
  try{
   const message=await addSessionMessage({sessionId:f.session.id,role:'user',content:'Fictional old history',scope:f.envelope})
   const body={selections:[{kind:'session',id:f.session.id}],reason:'Remove obsolete fictional conversation'}
   const r=await preview(f.workspaceId,f.ownerId,body)
   expect(r.erasedReferences).toContainEqual({kind:'session_message',id:message.id,version:'1'})
   expect((await f.confirm(r)).status).toBe('applied')
   expect((await pool.query('SELECT id FROM session_messages WHERE id=$1',[message.id])).rowCount).toBe(0)
  }finally{await f.cleanup()}
 })
 it('refuses running conversations and keeps the current owner bound at apply',async()=>{
  const f=await fixture()
  try{
   await pool.query("UPDATE sessions SET status='running' WHERE id=$1",[f.session.id])
   await expect(preview(f.workspaceId,f.ownerId,{selections:[{kind:'session',id:f.session.id}],reason:'Fictional running conversation'})).rejects.toMatchObject({code:'legacy_cleanup_running'})
   const r=await f.prepare()
   await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.ownerId])
   await expect(f.confirm(r)).rejects.toMatchObject({code:'owner_required'})
  }finally{await f.cleanup()}
 })
 it('refuses an expired review without changing its proposal',async()=>{
  const f=await fixture()
  try{
   const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now-16*60_000)
   let r:Awaited<ReturnType<typeof f.prepare>>
   try{r=await f.prepare()}finally{clock.mockRestore()}
   await expect(f.confirm(r!)).rejects.toMatchObject({code:'legacy_cleanup_expired'})
  }finally{await f.cleanup()}
 })
 it('blocks real FK cascades into foreign workspaces or department-labelled children',async()=>{
  const f=await fixture(),other=await persistentContextFixture(),name='cleanup_probe_'+randomUUID().replaceAll('-','')
  try{
   await pool.query(`CREATE TABLE ${name}(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    source_id uuid REFERENCES memories(id) ON DELETE CASCADE,compartments text[] NOT NULL DEFAULT '{}')`)
   await pool.query(`INSERT INTO ${name}(id,workspace_id,source_id) VALUES($1,$2,$3)`,[randomUUID(),other.workspaceId,f.memory.id])
   await expect(f.prepare()).rejects.toMatchObject({code:'legacy_cleanup_foreign_dependency'})
   await pool.query(`DELETE FROM ${name}`)
   await pool.query(`INSERT INTO ${name}(id,workspace_id,source_id,compartments) VALUES($1,$2,$3,$4)`,[randomUUID(),f.workspaceId,f.memory.id,[f.team.compartmentKey]])
   await expect(f.prepare()).rejects.toMatchObject({code:'legacy_cleanup_retained_dependency'})
   expect((await pool.query(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n).toBe(1)
  }finally{await pool.query(`DROP TABLE IF EXISTS ${name}`);await other.cleanup();await f.cleanup()}
 })
 it('converts an unrestricted legacy assistant binding without changing grants or clearance',async()=>{
  const f=await fixture()
  try{
   await pool.query(`UPDATE assistants SET team_scope_mode='legacy',context_binding_origin='legacy',compartments=NULL,
    home_department_id=$2,default_workspace_group_id=NULL WHERE id=$1`,[f.assistantId,f.team.id])
   const before=(await pool.query('SELECT to_jsonb(a) AS row FROM assistants a WHERE id=$1',[f.assistantId])).rows[0].row
   const grants=(await pool.query('SELECT to_jsonb(g) AS row FROM workspace_group_assistants g WHERE assistant_id=$1 ORDER BY group_id',[f.assistantId])).rows
   const r=await preview(f.workspaceId,f.ownerId,{selections:[{kind:'assistant_binding',id:f.assistantId}],reason:'Confirm current fictional Personal home'})
   expect((await f.confirm(r)).status).toBe('applied')
   const after=(await pool.query('SELECT to_jsonb(a) AS row FROM assistants a WHERE id=$1',[f.assistantId])).rows[0].row
   const omit=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([key])=>!['team_scope_mode','default_workspace_group_id','context_binding_origin','updated_at'].includes(key)))
   expect(omit(after)).toEqual(omit(before));expect(after).toMatchObject({team_scope_mode:'all',context_binding_origin:'reviewed',default_workspace_group_id:f.team.id})
   expect((await pool.query('SELECT to_jsonb(g) AS row FROM workspace_group_assistants g WHERE assistant_id=$1 ORDER BY group_id',[f.assistantId])).rows).toEqual(grants)
  }finally{await f.cleanup()}
 })
 it('erases selected obsolete workflows and goals after their runs have finished',async()=>{
  const f=await fixture(),workflowId=randomUUID(),goalId=randomUUID(),runId=randomUUID()
  try{
   await pool.query(`INSERT INTO workflows(id,workspace_id,created_by,name,definition)
    VALUES($1,$2,$3,'Fictional obsolete workflow','{"steps":[]}')`,[workflowId,f.workspaceId,f.ownerId])
   await pool.query(`INSERT INTO workflow_runs(id,workflow_id,workspace_id,trigger_kind,status)
    VALUES($1,$2,$3,'manual','completed')`,[runId,workflowId,f.workspaceId])
   await pool.query(`INSERT INTO goals(id,workspace_id,outcome,done_when,created_by_user_id)
    VALUES($1,$2,'Fictional obsolete goal','{"kind":"manual"}',$3)`,[goalId,f.workspaceId,f.ownerId])
   const r=await preview(f.workspaceId,f.ownerId,{selections:[{kind:'workflow',id:workflowId},{kind:'goal',id:goalId}],reason:'Remove fictional obsolete automation'})
   expect((await f.confirm(r)).status).toBe('applied')
   expect((await pool.query('SELECT id FROM workflows WHERE id=$1',[workflowId])).rowCount).toBe(0)
   expect((await pool.query('SELECT id FROM workflow_runs WHERE id=$1',[runId])).rowCount).toBe(0)
   expect((await pool.query('SELECT id FROM goals WHERE id=$1',[goalId])).rowCount).toBe(0)
  }finally{await f.cleanup()}
 })
 it('protects pending and waiting workflow runs and running or approved-complete goals',async()=>{
  const f=await fixture(),workflowId=randomUUID(),goalId=randomUUID(),runId=randomUUID()
  try{
   await pool.query(`INSERT INTO workflows(id,workspace_id,created_by,name,definition)
    VALUES($1,$2,$3,'Fictional running workflow','{"steps":[]}')`,[workflowId,f.workspaceId,f.ownerId])
   await pool.query(`INSERT INTO workflow_runs(id,workflow_id,workspace_id,trigger_kind,status)
    VALUES($1,$2,$3,'manual','pending')`,[runId,workflowId,f.workspaceId])
   for(const status of ['pending','running','awaiting_wait','awaiting_input']){
    await pool.query('UPDATE workflow_runs SET status=$2 WHERE id=$1',[runId,status])
    await expect(preview(f.workspaceId,f.ownerId,{selections:[{kind:'workflow',id:workflowId}],reason:'Fictional active workflow'})).rejects.toMatchObject({code:'legacy_cleanup_running'})
   }
   await pool.query(`INSERT INTO goals(id,workspace_id,outcome,done_when,created_by_user_id)
    VALUES($1,$2,'Fictional protected goal','{"kind":"manual"}',$3)`,[goalId,f.workspaceId,f.ownerId])
   for(const status of ['running','awaiting_approval','done']){
    await pool.query('UPDATE goals SET status=$2 WHERE id=$1',[goalId,status])
    await expect(preview(f.workspaceId,f.ownerId,{selections:[{kind:'goal',id:goalId}],reason:'Fictional protected goal'})).rejects.toMatchObject({code:'legacy_cleanup_running'})
   }
  }finally{await f.cleanup()}
 })
 it('exposes the same owner-gated preview through the authenticated workspace route',async()=>{
  const f=await fixture(),app=express()
  try{
   app.use(express.json());app.use((req,_res,next)=>{req.userId=f.ownerId;next()});app.use('/api',workspaceAccessRoutes())
   const result=await request(app).post(`/api/workspaces/${f.workspaceId}/access/legacy-cleanup/preview`).send(f.proposal)
   expect(result.status).toBe(200);expect(result.body.status).toBe('preview')
   expect(JSON.stringify(result.body)).not.toContain('Fictional retained private memory')
  }finally{await f.cleanup()}
 })
 it('independently rejects duplicate, malformed, invented and pre-applied SQL proofs',async()=>{
  const f=await fixture()
  try{
   const r=await f.prepare(),valid=r.erasedReferences[0]
   for(const erasures of [[valid,valid],[{...valid,version:1}],[{...valid,id:randomUUID()}],
    [{...valid,version:'999'}],[{...valid,kind:'unsupported'}],[{...valid,id:f.retained.id}],
    [{...valid,extra:'unreviewed'}],[{...valid,id:valid.id.toUpperCase()}]]){
    await expect(pool.query(`INSERT INTO workspace_legacy_cleanup_reviews(id,workspace_id,actor_user_id,policy_revision,selection,evidence,payload_hash,expires_at)
     SELECT $2,workspace_id,actor_user_id,policy_revision,selection,jsonb_set(evidence,'{erasures}',$3::jsonb),payload_hash,expires_at
     FROM workspace_legacy_cleanup_reviews WHERE id=$1`,[r.id,randomUUID(),JSON.stringify(erasures)])).rejects.toThrow('legacy_cleanup_reference_invalid')
   }
   await expect(pool.query(`INSERT INTO workspace_legacy_cleanup_reviews(id,workspace_id,actor_user_id,policy_revision,selection,evidence,payload_hash,expires_at,status,receipt)
    SELECT $2,workspace_id,actor_user_id,policy_revision,selection,evidence,payload_hash,expires_at,'applied','{}'
    FROM workspace_legacy_cleanup_reviews WHERE id=$1`,[r.id,randomUUID()])).rejects.toThrow('legacy_cleanup_review_immutable')
  }finally{await f.cleanup()}
 })
 it('invalidates a conversation preview when a message body changes without a scope change',async()=>{
  const f=await fixture()
  try{
   const message=await addSessionMessage({sessionId:f.session.id,role:'user',content:'Fictional initial body',scope:f.envelope})
   const r=await preview(f.workspaceId,f.ownerId,{selections:[{kind:'session',id:f.session.id}],reason:'Remove fictional conversation'})
   await pool.query("UPDATE session_messages SET content='\"Fictional changed body\"'::jsonb WHERE id=$1",[message.id])
   await expect(f.confirm(r)).rejects.toMatchObject({code:'legacy_cleanup_changed'})
   expect((await pool.query('SELECT id FROM session_messages WHERE id=$1',[message.id])).rowCount).toBe(1)
  }finally{await f.cleanup()}
 })
 it('invalidates a changed General cascade child and supports more than 500 retained records',async()=>{
  const f=await fixture(),name='cleanup_probe_'+randomUUID().replaceAll('-','')
  try{
   await pool.query(`INSERT INTO memories(workspace_id,assistant_id,summary,sensitivity,compartments,created_by_user_id)
    SELECT $1,$2,'Fictional retained bulk memory','internal',$3::text[],$4 FROM generate_series(1,510)`,[f.workspaceId,f.assistantId,[f.team.compartmentKey],f.ownerId])
   await pool.query(`CREATE TABLE ${name}(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    source_id uuid REFERENCES memories(id) ON DELETE CASCADE,note text)`)
   await pool.query(`INSERT INTO ${name} VALUES($1,$2,$3,'Fictional initial child')`,[randomUUID(),f.workspaceId,f.memory.id])
   const r=await f.prepare()
   await pool.query(`UPDATE ${name} SET note='Fictional changed child'`)
   await expect(f.confirm(r)).rejects.toMatchObject({code:'legacy_cleanup_changed'})
   expect((await f.confirm(await f.prepare())).status).toBe('applied')
   expect((await pool.query("SELECT count(*)::int AS n FROM memories WHERE workspace_id=$1 AND cardinality(compartments)>0",[f.workspaceId])).rows[0].n).toBe(511)
  }finally{await pool.query(`DROP TABLE IF EXISTS ${name}`);await f.cleanup()}
 })
 it('rejects removed-reference evidence from another workspace or a restored physical ID',async()=>{
  const f=await fixture(),other=await persistentContextFixture()
  try{
   await f.confirm(await f.prepare())
   expect((await pool.query("SELECT read_scope_review_impact_source($1,'memory',$2) AS ref",[other.workspaceId,f.memory.id])).rows[0].ref).toBeNull()
   await pool.query(`INSERT INTO memories(id,workspace_id,assistant_id,summary,sensitivity,compartments)
    VALUES($1,$2,$3,'Fictional restored foreign memory','internal','{}')`,[f.memory.id,other.workspaceId,other.assistantId])
   expect((await pool.query("SELECT read_scope_review_impact_source($1,'memory',$2) AS ref",[f.workspaceId,f.memory.id])).rows[0].ref).toBeNull()
  }finally{await other.cleanup();await f.cleanup()}
 })
 it('records removal proof for canonical sources erased by a foreign-key cascade',async()=>{
  const f=await fixture(),column='cleanup_parent_'+randomUUID().replaceAll('-','')
  try{
   await pool.query(`ALTER TABLE memories ADD COLUMN ${column} uuid REFERENCES memories(id) ON DELETE CASCADE`)
   const child=await createMemory({workspaceId:f.workspaceId,userId:null,assistantId:f.assistantId,
    summary:'Fictional General cascade child',sensitivity:'internal',createdByUserId:f.ownerId})
   await pool.query(`UPDATE memories SET ${column}=$2 WHERE id=$1`,[child.id,f.memory.id])
   const grandchild=await createMemory({workspaceId:f.workspaceId,userId:null,assistantId:f.assistantId,
    summary:'Fictional General cascade grandchild',sensitivity:'internal',createdByUserId:f.ownerId})
   await pool.query(`UPDATE memories SET ${column}=$2 WHERE id=$1`,[grandchild.id,child.id])
   const r=await f.prepare()
   expect(r.erasedReferences).toContainEqual({kind:'memory',id:child.id,version:'1'})
   expect(r.erasedReferences).toContainEqual({kind:'memory',id:grandchild.id,version:'1'})
   expect((await f.confirm(r)).status).toBe('applied')
   expect((await pool.query("SELECT read_scope_review_impact_source($1,'memory',$2) AS ref",[f.workspaceId,child.id])).rows[0].ref)
    .toEqual({version:`erased:${r.id}:1`,held:true,removed:true})
   expect((await pool.query("SELECT read_scope_review_impact_source($1,'memory',$2) AS ref",[f.workspaceId,grandchild.id])).rows[0].ref)
    .toEqual({version:`erased:${r.id}:1`,held:true,removed:true})
  }finally{await pool.query(`ALTER TABLE memories DROP COLUMN ${column}`);await f.cleanup()}
 })
 it.each(['General','Personal'] as const)('purges General conversation snapshots while protecting %s context revisions',async department=>{
  const f=await fixture()
  try{
   let session=f.session
   if(department==='Personal'){
    await createDbWorkspaceGroupStore().setTeamAssistant(f.ownerId,f.team.id,f.assistantId,true)
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
    session=await createWorkspaceChatSession({workspaceId:f.workspaceId,assistantId:f.assistantId,starterUserId:f.ownerId,
     effectiveClearance:'internal',contextGroupId:f.team.id,authenticatedHuman:true})
   }
   const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,f.memory.id])).rows[0].source
   const now=Date.now()
   const revision=await writeSessionContextRevision({sessionId:session.id,parentId:randomUUID(),kind:'session_state',
    content:{key:'Fictional cleanup context',summary:'Fictional snapshot bytes',detail:null,status:'open',source:'tool',createdAt:now,updatedAt:now,resolvedAt:null},
    authority:{execution:await f.execution(f.ownerId,session),accumulator:new ContextScopeAccumulator()},expectedGeneration:await sessionContextGeneration(session.id),
    derivation:{producer:'fixture:cleanup-context',sources:[source]}})
   if(!revision)throw Error('Expected a canonical context revision')
   if(department==='Personal'){
    expect(revision.source.compartments).toContain(f.team.compartmentKey)
    // Model a historical departmental snapshot whose conversation binding is
    // now General; immutable snapshot labels and bytes stay untouched.
    await pool.query("UPDATE sessions SET context_group_id=NULL,context_compartments='{}' WHERE id=$1",[session.id])
   }
   const read=async()=>(await pool.query(`SELECT to_jsonb(r) AS header,to_jsonb(c) AS payload FROM session_context_scope_revisions r
    LEFT JOIN session_context_revision_contents c ON c.workspace_id=r.workspace_id AND c.revision_id=r.id WHERE r.id=$1`,[revision.id])).rows[0]
   const before=await read(),body={selections:[{kind:'session',id:session.id}],reason:'Remove fictional obsolete conversation and its snapshots'}
   if(department==='Personal'){
    await expect(preview(f.workspaceId,f.ownerId,body)).rejects.toMatchObject({code:'legacy_cleanup_retained_dependency'})
    expect(await read()).toEqual(before)
    expect((await pool.query('SELECT id FROM sessions WHERE id=$1',[session.id])).rowCount).toBe(1)
   }else{
    expect((await f.confirm(await preview(f.workspaceId,f.ownerId,body))).status).toBe('applied')
    expect(await read()).toEqual({header:{...before.header,scope_held:true},payload:null})
   }
  }finally{await f.cleanup()}
 })
})
