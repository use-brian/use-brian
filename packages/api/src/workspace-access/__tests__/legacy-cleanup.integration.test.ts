import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'
import {createMemory} from '../../db/memories.js'
import {addSessionMessage} from '../../db/sessions.js'
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
describe.sequential('[COMP:api/workspace-legacy-cleanup] owner-reviewed selective cleanup',()=>{
 afterAll(async()=>{await getAppPool().end();await pool.end()})
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
})
