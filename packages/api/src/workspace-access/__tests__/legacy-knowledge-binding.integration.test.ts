import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import express,{type ErrorRequestHandler} from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it} from 'vitest'
import {createKnowledgeSyncWorker} from '@use-brian/core'
import {getPool,getAppPool,queryWithRLS} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {createDbWorkflowStore} from '../../db/workflow-store.js'
import {createDbJobStore} from '../../db/job-store.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {workspaceAccessRoutes} from '../../routes/workspace-access.js'
import {WorkspaceAccessError} from '../policy.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),store=createDbKnowledgeStore(),secret=randomUUID(),app=express()
const fixtureWorkspaces:string[]=[]
app.use(express.json(),requireAuth(secret),workspaceAccessRoutes())
app.use(((error,_req,res,_next)=>{res.status(error instanceof WorkspaceAccessError?error.status:500).json({error:error instanceof WorkspaceAccessError?error.code:error.message})}) as ErrorRequestHandler)
afterAll(async()=>{
 try {await pool.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[fixtureWorkspaces])}
 finally {await getAppPool().end();await pool.end()}
})
async function fixture(entries=1) {
 const owner=randomUUID(),admin=randomUUID(),w=randomUUID(),assistant=randomUUID()
 fixtureWorkspaces.push(w)
 for(const u of [owner,admin])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[u])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional legacy source',$2,true)",[w,owner])
 for(const [u,role] of [[owner,'owner'],[admin,'admin']])await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[w,u,role])
 const team=await createDbWorkspaceGroupStore().createTeam(admin,w,{name:'Personal',key:'personal'})
 await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Primary',$2,$3,'primary','confidential')",[assistant,admin,w])
 await queryWithRLS(admin,'INSERT INTO workspace_group_assistants(group_id,assistant_id) VALUES($1,$2)',[team.id,assistant])
 await queryWithRLS(admin,"SELECT department_set_home($1,'assistant',$2,$3)",[w,assistant,team.id])
 await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1',[assistant,team.id])
 await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING",[w,team.id,admin])
 await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[w,owner])
 await pool.query("UPDATE workspace_access_policies SET access_mode='departments',setup_state='legacy',classification_mode='review',default_department_id=$2 WHERE workspace_id=$1",[w,team.id])
 const directory=await mkdtemp(join(tmpdir(),'fictional-source-cutover-'))
 for(let i=0;i<entries;i++)await writeFile(join(directory,`note-${i}.md`),`---\ntitle: Fictional note ${i}\n---\nFictional retained content ${i}`)
 const source=await store.createSource({workspaceId:w,sourceType:'local',repo:directory})
 const events:Array<{type:string;error?:string}>=[]
 const worker=()=>createKnowledgeSyncWorker({store:{...store,getSourcesDueForSync:async()=>[(await store.getSource(source.id))!]},api:{} as never,
  credentials:{getPat:async()=>{throw Error('Local source must not fetch credentials')}},onEvent:event=>events.push(event)})
 await worker().tick()
 expect(events.filter(e=>e.type==='sync_error')).toEqual([])
 await pool.query('UPDATE knowledge_entries SET compartments=$2 WHERE workspace_id=$1',[w,[team.compartmentKey]])
 const session=await authSessionStore.create(admin,{deviceLabel:'Fictional admin',userAgent:null,ipAddress:null})
 const ownerSession=await authSessionStore.create(owner,{deviceLabel:'Fictional owner',userAgent:null,ipAddress:null})
 const token=createTokens(admin,secret,session!).accessToken,ownerToken=createTokens(owner,secret,ownerSession!).accessToken
 const post=(path:string,body:Record<string,unknown>,bearer=token)=>request(app).post(`/workspaces/${w}/access/${path}`).set('Authorization',`Bearer ${bearer}`).send(body)
 const preview=(extra:Record<string,unknown>={},bearer=token)=>post('knowledge-bindings/preview',{sourceId:source.id,targetDepartmentId:team.id,idempotencyKey:randomUUID(),...extra},bearer)
 const apply=(review:{reviewId:string;payloadHash:string},bearer=token)=>post('knowledge-bindings/apply',{reviewId:review.reviewId,payloadHash:review.payloadHash},bearer)
 return {w,owner,admin,assistant,team,source,directory,token,ownerToken,session:session!,post,preview,apply,worker,events}
}
describe('[COMP:api/legacy-knowledge-binding] complete legacy source recovery',()=>{
 it('preserves 222 entries, adopts as the attending admin, finalizes as the separate owner, and syncs afterwards',async()=>{
  const f=await fixture(222)
  try {
   const workflows=createDbWorkflowStore(),jobs=createDbJobStore(),jobIds:string[]=[]
   for(const kind of ['event','schedule','schedule'] as const) {
    const schedule={type:'once' as const,datetime:'2099-01-01T00:00:00Z'}
    const workflow=await workflows.create({userId:f.admin,workspaceId:f.w,name:'Fictional retained workflow',
     definition:{startStepId:'call',steps:[{id:'call',type:'assistant_call',target:{assistantId:f.assistant},prompt:'Fictional prompt'}]},
     trigger:kind==='schedule'?{kind,schedule}:{kind,event:{sources:[{source:{type:'task'}}]}},contextGroupId:f.team.id},
     {authoring:{kind:'internal-human',userId:f.admin,assistantId:f.assistant}})
    if(kind==='schedule')jobIds.push((await jobs.create({userId:f.admin,assistantId:f.assistant,workflowId:workflow.id,schedule,timezone:'Asia/Hong_Kong',
     instructions:'Fictional instructions',channelType:'web',channelId:randomUUID(),nextRunAt:new Date('2099-01-01'),
     contextGroupId:f.team.id,contextCompartments:[f.team.compartmentKey!],contextProjectIds:[]})).id)
   }
   const before=(await pool.query('SELECT to_jsonb(entry) AS row FROM knowledge_entries entry WHERE workspace_id=$1 ORDER BY id',[f.w])).rows
   expect(before).toHaveLength(222)
   const blocked=await f.post('cutover/preview',{targetDepartmentId:f.team.id,idempotencyKey:randomUUID(),requireNoGeneral:true},f.ownerToken)
   expect(blocked.body.blockers).toEqual([{code:'cutover_knowledge_source_binding_required',kind:'knowledge_source',id:f.source.id}])
   expect((await f.preview({},f.ownerToken)).body).toEqual({error:'knowledge_binding_department_access_required'})
   const review=await f.preview()
   expect(review.body,JSON.stringify(review.body)).toMatchObject({status:'prepared',entryCount:'222',configuredByUserId:f.admin,binding:{compartments:[f.team.compartmentKey],projectIds:[]}})
   expect(JSON.stringify(review.body)).not.toContain(f.directory)
   const applied=await f.apply(review.body)
   expect(applied.body,JSON.stringify(applied.body)).toMatchObject({entriesPreserved:'222',recordsDeleted:0,grantsChanged:false})
   expect((await f.apply(review.body)).body).toEqual(applied.body)
   expect((await pool.query('SELECT to_jsonb(entry) AS row FROM knowledge_entries entry WHERE workspace_id=$1 ORDER BY id',[f.w])).rows).toEqual(before)
   expect(await store.getSource(f.source.id)).toMatchObject({repo:f.directory,configuredByUserId:f.admin,bindingCompartments:[f.team.compartmentKey],bindingVersion:'2',bindingHeld:false})
   const cutover=await f.post('cutover/preview',{targetDepartmentId:f.team.id,idempotencyKey:randomUUID(),requireNoGeneral:true},f.ownerToken)
   expect(cutover.body.status,JSON.stringify(cutover.body)).toBe('prepared')
   expect((await f.post('cutover/apply',{reviewId:cutover.body.reviewId,payloadHash:cutover.body.payloadHash},f.ownerToken)).body).toMatchObject({setupState:'ready',readyForActivation:true,scheduleConversions:expect.arrayContaining(jobIds)})
   await writeFile(join(f.directory,'note-0.md'),'---\ntitle: Fictional updated note\n---\nFictional updated content')
   await f.worker().tick()
   expect(f.events.filter(e=>e.type==='sync_error')).toEqual([])
   expect((await pool.query("SELECT content,compartments,scope_held FROM knowledge_entries WHERE workspace_id=$1 AND content LIKE '%Fictional updated content%'",[f.w])).rows).toEqual([{content:expect.stringContaining('Fictional updated content'),compartments:[f.team.compartmentKey],scope_held:false}])
   expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_entries WHERE workspace_id=$1',[f.w])).rows[0].n).toBe(222)
   expect((await pool.query('SELECT id FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[f.w,f.owner])).rows).toEqual([])
  }finally {await rm(f.directory,{recursive:true,force:true})}
 },60_000)
 it.each(['revoked','expired','changed-source','changed-output','revoked-session'] as const)('rejects %s review evidence without partial adoption',async(change)=>{
  const f=await fixture()
  try {
   const review=await f.preview();expect(review.body.status,JSON.stringify(review.body)).toBe('prepared')
   if(change==='revoked'||change==='expired') {
    await pool.query('INSERT INTO department_owners(workspace_id,department_id,user_id) VALUES($1,$2,$3)',[f.w,f.team.id,f.owner])
    await pool.query('DELETE FROM department_owners WHERE workspace_id=$1 AND user_id=$2',[f.w,f.admin])
   }
   if(change==='revoked')await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[f.w,f.admin])
   if(change==='expired')await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[f.w,f.admin])
   if(change==='changed-source')await pool.query("UPDATE workspace_knowledge_sources SET last_synced_sha='changed' WHERE id=$1",[f.source.id])
   if(change==='changed-output')await pool.query("UPDATE knowledge_entries SET title='Changed fixture' WHERE workspace_id=$1",[f.w])
   if(change==='revoked-session')await authSessionStore.revokeForUser(f.admin,f.session.id)
   expect((await f.apply(review.body)).status).not.toBe(200)
   expect((await store.getSource(f.source.id))!.configuredByUserId).toBeNull()
   expect((await pool.query('SELECT status FROM workspace_knowledge_binding_reviews WHERE id=$1',[review.body.reviewId])).rows[0].status).toBe('prepared')
  }finally {await rm(f.directory,{recursive:true,force:true})}
 })
 it('blocks direct app-role GUC forgery and held or busy sources',async()=>{
  const f=await fixture(),c=await getAppPool().connect()
  try {
   const review=await f.preview();expect(review.body.status).toBe('prepared')
   await c.query('BEGIN');await c.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.knowledge_binding_review',$2,true)",[f.admin,review.body.reviewId])
   await expect(c.query("UPDATE workspace_knowledge_binding_reviews SET status='applying' WHERE id=$1",[review.body.reviewId])).rejects.toThrow()
   await c.query('ROLLBACK');await c.query('BEGIN');await c.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.knowledge_binding_review',$2,true)",[f.admin,review.body.reviewId])
   await expect(c.query("UPDATE workspace_knowledge_sources SET configured_by_user_id=$2,binding_sensitivity='internal',binding_compartments=$3,binding_project_ids='{}',binding_version=binding_version+1 WHERE id=$1",[f.source.id,f.admin,[f.team.compartmentKey]])).rejects.toThrow()
   await c.query('ROLLBACK')
   const captured=await store.captureSourceSync((await store.getSource(f.source.id))!)
   expect((await f.preview()).body).toEqual({error:'knowledge_binding_source_busy'})
   await store.releaseSourceSync(captured!)
   await pool.query('UPDATE workspace_knowledge_sources SET binding_held=true WHERE id=$1',[f.source.id])
   expect((await f.preview()).body).toEqual({error:'knowledge_binding_source_busy'})
  }finally {await c.query('ROLLBACK');c.release();await rm(f.directory,{recursive:true,force:true})}
 })
 it('rejects supplied actor identities and rolls the whole conversion back if an output changes during apply',async()=>{
  const f=await fixture()
  try {
   expect((await f.preview({configuredByUserId:f.owner})).status).toBe(400)
   const before=(await pool.query('SELECT to_jsonb(entry) AS row FROM knowledge_entries entry WHERE workspace_id=$1 ORDER BY id',[f.w])).rows
   const review=await f.preview();expect(review.body.status).toBe('prepared')
   await pool.query(`CREATE FUNCTION knowledge_binding_fixture_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id='${f.source.id}'::uuid AND OLD.configured_by_user_id IS NULL AND NEW.configured_by_user_id IS NOT NULL THEN
     UPDATE knowledge_entries SET title='Unreviewed fixture rewrite' WHERE source_id=NEW.id;
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER zzzz_knowledge_binding_fixture_rewrite AFTER UPDATE ON workspace_knowledge_sources
    FOR EACH ROW EXECUTE FUNCTION knowledge_binding_fixture_rewrite()`)
   try {
    expect((await f.apply(review.body)).body).toEqual({error:'knowledge_binding_outputs_changed'})
    expect((await store.getSource(f.source.id))!.configuredByUserId).toBeNull()
    expect((await pool.query('SELECT status FROM workspace_knowledge_binding_reviews WHERE id=$1',[review.body.reviewId])).rows[0].status).toBe('prepared')
    expect((await pool.query('SELECT to_jsonb(entry) AS row FROM knowledge_entries entry WHERE workspace_id=$1 ORDER BY id',[f.w])).rows).toEqual(before)
   }finally {await pool.query('DROP TRIGGER zzzz_knowledge_binding_fixture_rewrite ON workspace_knowledge_sources; DROP FUNCTION knowledge_binding_fixture_rewrite()')}
  }finally {await rm(f.directory,{recursive:true,force:true})}
 })
})
