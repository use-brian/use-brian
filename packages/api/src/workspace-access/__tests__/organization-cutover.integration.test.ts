import {createMigrationPlan,getMigrationPlan,listMigrationPlans} from '../migration-service.js'
import {createTask} from '../../db/tasks.js'
import {createMemory} from '../../db/memories.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {createPersonalWebSession} from '../../db/sessions.js'
import {createFilesApi} from '../../files/files-api.js'
import {createDbWorkspaceFilesStore} from '../../db/workspace-files-store.js'
import {randomUUID} from 'node:crypto'
import express,{type ErrorRequestHandler} from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool,queryWithRLS} from '../../db/client.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {createDbWorkflowStore,createDbWorkflowRunStore} from '../../db/workflow-store.js'
import {createDbJobStore} from '../../db/job-store.js'
import {officeArtifactStore} from '../../db/office-artifacts.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {workspaceAccessRoutes} from '../../routes/workspace-access.js'
import {SCOPE_REVIEW_REGISTRY_REVISION} from '../scope-review-registry.js'
import {WorkspaceAccessError} from '../policy.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),secret=randomUUID()
afterAll(async()=>{await getAppPool().end();await pool.end()})
const app=express()
app.use(express.json(),requireAuth(secret),workspaceAccessRoutes())
app.use(((error,_req,res,_next)=>{
 if(error instanceof WorkspaceAccessError)return void res.status(error.status).json({error:error.code})
 res.status(500).json({error:error instanceof Error?error.message:'unexpected_fixture_error'})
}) as ErrorRequestHandler)
async function fixture() {
 const w=randomUUID(),u=randomUUID(),a=randomUUID()
 await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[u])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic cutover',$2,true)",[w,u])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[w,u])
 const team=await createDbWorkspaceGroupStore().createTeam(u,w,{name:'Personal',key:'personal'})
 await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Primary',$2,$3,'primary','internal')",[a,u,w])
 await queryWithRLS(u,'INSERT INTO workspace_group_assistants(group_id,assistant_id) VALUES($1,$2)',[team.id,a])
 await queryWithRLS(u,"SELECT department_set_home($1,'user',$2,$3)",[w,u,team.id])
 await queryWithRLS(u,"SELECT department_set_home($1,'assistant',$2,$3)",[w,a,team.id])
 await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1',[a,team.id])
 await pool.query("UPDATE workspace_access_policies SET access_mode='departments',setup_state='legacy',default_department_id=$2 WHERE workspace_id=$1",[w,team.id])
 const session=await authSessionStore.create(u,{deviceLabel:'Synthetic cutover',userAgent:null,ipAddress:null})
 const token=createTokens(u,secret,session!).accessToken
 const workflows=createDbWorkflowStore(),jobs=createDbJobStore(),jobIds:string[]=[],workflowIds:string[]=[]
 for(let i=0;i<2;i++) {
  const schedule={type:'once' as const,datetime:`2099-01-0${i+1}T00:00:00Z`}
  const workflow=await workflows.create({userId:u,workspaceId:w,name:'Synthetic scheduled workflow',
   definition:{startStepId:'call',steps:[{id:'call',type:'assistant_call',target:{assistantId:a},prompt:'Private synthetic prompt'}]},
   trigger:{kind:'schedule',schedule},contextGroupId:team.id,contextProjectId:null},{authoring:{kind:'internal-human',userId:u,assistantId:a}})
  const job=await jobs.create({assistantId:a,userId:u,workflowId:workflow.id,schedule,timezone:'Asia/Hong_Kong',
   instructions:'Private synthetic instructions',channelType:'telegram',channelId:'synthetic-recipient',nextRunAt:new Date('2099-01-01T00:00:00Z'),
   contextGroupId:team.id,contextProjectId:null,contextCompartments:[team.compartmentKey!],contextProjectIds:[]})
  jobIds.push(job.id);workflowIds.push(workflow.id)
 }
 const retained=await officeArtifactStore.createShell({userId:u,workspaceId:w,family:'document',title:'Private synthetic retained draft',templateVersionId:null,capabilityVersion:1,sensitivity:'internal'})
 const preview=(body:Record<string,unknown>={},bearer=token)=>request(app).post(`/workspaces/${w}/access/cutover/preview`)
  .set('Authorization',`Bearer ${bearer}`).send({targetDepartmentId:team.id,idempotencyKey:randomUUID(),...body})
 const apply=(review:{reviewId:string;payloadHash:string},bearer=token)=>request(app).post(`/workspaces/${w}/access/cutover/apply`)
  .set('Authorization',`Bearer ${bearer}`).send({reviewId:review.reviewId,payloadHash:review.payloadHash})
 return {w,u,a,team,session:session!,token,jobs,jobIds,workflowIds,retained,preview,apply}
}
describe('[COMP:api/organization-cutover] owner-reviewed atomic activation (PG18)',()=>{
 it('starts unacknowledged, reviews complete coverage, and atomically certifies readiness without changing classification',async()=>{
  const f=await fixture()
  const policy=async()=>(await pool.query('SELECT reviewed_inventory_revision::text AS reviewed,classification_mode AS classification,setup_state AS setup FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0]
  const before=await policy()
  expect(before).toMatchObject({reviewed:null,setup:'legacy'})
  const reviewed=await f.preview()
  expect(reviewed.body.status,JSON.stringify(reviewed.body)).toBe('prepared')
  expect(reviewed.body.readiness).toMatchObject({readyForActivation:false,scopeInventory:{reviewedRevision:null,canAcknowledge:true,coverage:{unresolved:'0'}}})
  expect(reviewed.body.changes.reviewedInventoryRevision).toBe(String(SCOPE_REVIEW_REGISTRY_REVISION))
  expect(await policy()).toEqual(before)
  expect((await f.apply(reviewed.body)).body).toMatchObject({setupState:'ready',readyForActivation:true,reviewedInventoryRevision:String(SCOPE_REVIEW_REGISTRY_REVISION)})
  expect(await policy()).toEqual({reviewed:String(SCOPE_REVIEW_REGISTRY_REVISION),classification:before.classification,setup:'ready'})
 })

 it('reports all independent blockers while inventory acknowledgement is absent',async()=>{
  const f=await fixture()
  const source=await createDbKnowledgeStore().createSource({workspaceId:f.w,sourceType:'local',repo:'/fictional/cutover-fixture'})
  await pool.query("UPDATE assistants SET context_binding_origin='legacy' WHERE id=$1",[f.a])
  await pool.query('UPDATE scheduled_jobs SET dispatch_lease_id=$2 WHERE id=$1',[f.jobIds[0],randomUUID()])
  const result=await f.preview()
  expect(result.body.status,JSON.stringify(result.body)).toBe('blocked')
  expect(result.body.blockers).toEqual(expect.arrayContaining([
   {code:'readiness_scope_review'},
   {code:'cutover_assistant_binding_required',kind:'assistant',id:f.a},
   {code:'cutover_knowledge_source_binding_required',kind:'knowledge_source',id:source.id},
   {code:'cutover_schedule_not_quiet',kind:'scheduled_job',id:f.jobIds[0]},
  ]))
  expect(result.body.readiness.scopeInventory).toMatchObject({canAcknowledge:false})
  expect((await pool.query('SELECT reviewed_inventory_revision FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0].reviewed_inventory_revision).toBeNull()
 })

 it('rolls back acknowledgement and all schedule conversions when post-update readiness fails',async()=>{
  const f=await fixture(),reviewed=await f.preview()
  expect(reviewed.body.status).toBe('prepared')
  await pool.query(`CREATE FUNCTION cutover_fixture_reject_ack() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.workspace_id='${f.w}'::uuid AND NEW.setup_state='ready' THEN NEW.reviewed_inventory_revision:=NULL; END IF; RETURN NEW; END $$;
   CREATE TRIGGER zzzz_cutover_fixture_reject_ack BEFORE UPDATE ON workspace_access_policies FOR EACH ROW EXECUTE FUNCTION cutover_fixture_reject_ack()`)
  try {
   expect((await f.apply(reviewed.body)).body).toEqual({error:'cutover_post_readiness_failed'})
   expect((await pool.query('SELECT setup_state,reviewed_inventory_revision,completed_cutover_id FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0]).toEqual({setup_state:'legacy',reviewed_inventory_revision:null,completed_cutover_id:null})
   expect((await pool.query('SELECT id FROM scheduled_jobs WHERE id=ANY($1::uuid[]) AND workflow_authoring_snapshot IS NOT NULL',[f.jobIds])).rows).toEqual([])
  }finally {await pool.query('DROP TRIGGER zzzz_cutover_fixture_reject_ack ON workspace_access_policies; DROP FUNCTION cutover_fixture_reject_ack()')}
 })

 it('reviews all 12,000 provenance links, rejects a late link beyond 5,000, and preserves them on activation',async()=>{
  const f=await fixture(),sources:string[]=[],outputs:string[]=[]
  for(let i=0;i<221;i++) {
   const memory=await createMemory({workspaceId:f.w,userId:null,assistantId:f.a,createdByUserId:f.u,
    summary:'Fictional provenance fixture',sensitivity:'internal',compartments:[f.team.compartmentKey!]})
   ;(i<121?sources:outputs).push(memory.id)
  }
  sources.sort()
  const spare=sources.pop()!
  const derivations=(await pool.query<{id:string}>(`INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,
   resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
   SELECT workspace_id,'memory',id,read_scope_source(workspace_id,'memory',id)->>'version','large-inventory-fixture',
    user_id,assistant_id,sensitivity,compartments,project_ids,1 FROM memories WHERE id=ANY($1::uuid[]) RETURNING id`,[outputs])).rows.map(row=>row.id).sort()
  await pool.query(`WITH sources AS MATERIALIZED (SELECT id,workspace_id,read_scope_source(workspace_id,'memory',id)->>'version' AS version
   FROM memories WHERE id=ANY($2::uuid[])) INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
   SELECT d.workspace_id,d.id,'memory',s.id,s.version FROM scope_derivations d CROSS JOIN sources s WHERE d.id=ANY($1::uuid[])`,[derivations,sources])
  // Independent SQL aggregate verifies compatibility with existing review hashes.
  const fingerprint=async()=>(await pool.query(`SELECT count(*)::text AS count,encode(sha256(convert_to(string_agg(
   r.derivation_id::text||':'||r.source_kind||':'||r.source_id::text||':'||r.xmin::text||':'||
   jsonb_build_object('workspace_id',r.workspace_id,'derivation_id',r.derivation_id,'source_kind',r.source_kind,
    'source_id',r.source_id,'source_version',r.source_version)::text,E'\n'
   ORDER BY r.derivation_id::text||':'||r.source_kind||':'||r.source_id::text),'UTF8')),'hex') AS fingerprint
   FROM scope_derivation_sources r WHERE workspace_id=$1`,[f.w])).rows[0]
  const before=await fingerprint(),reviewed=await f.preview()
  expect(before.count).toBe('12000')
  expect(reviewed.status,JSON.stringify(reviewed.body)).toBe(200)
  expect(reviewed.body.status,JSON.stringify(reviewed.body)).toBe('prepared')
  expect(reviewed.body.inventory.families.find((row:{family:string})=>row.family==='scope_derivation_sources')).toEqual({family:'scope_derivation_sources',...before})
  expect(JSON.stringify(reviewed.body)).not.toContain('Fictional provenance fixture')
  // The new link sorts after every reviewed row, past the former cap.
  await pool.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
   SELECT $1,$2,'memory',id,read_scope_source(workspace_id,'memory',id)->>'version' FROM memories WHERE id=$3`,[f.w,derivations.at(-1),spare])
  expect((await f.apply(reviewed.body)).body).toEqual({error:'cutover_review_changed'})
  expect((await pool.query('SELECT setup_state FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0].setup_state).toBe('legacy')
  expect((await pool.query('SELECT id FROM scheduled_jobs WHERE id=ANY($1::uuid[]) AND workflow_authoring_snapshot IS NOT NULL',[f.jobIds])).rows).toEqual([])
  const current=await fingerprint(),fresh=await f.preview()
  expect(current.count).toBe('12001')
  expect(fresh.body.inventory.families.find((row:{family:string})=>row.family==='scope_derivation_sources')).toEqual({family:'scope_derivation_sources',...current})
  expect((await f.apply(fresh.body)).body).toMatchObject({setupState:'ready',recordsDeleted:0,grantsChanged:false})
  expect(await fingerprint()).toEqual(current)
 },60_000)
 it.each(['legacy','ready'] as const)('permits v2 General workflow authoring without a home department (%s)',async(setupState)=>{
  const w=randomUUID(),u=randomUUID(),a=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[u])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'General workflow fixture',$2,true)",[w,u])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','internal')",[w,u])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Primary',$2,$3,'primary','internal')",[a,u,w])
  await pool.query("UPDATE workspace_access_policies SET access_mode='departments',setup_state=$2 WHERE workspace_id=$1",[w,setupState])
  const store=createDbWorkflowStore(),params={userId:u,workspaceId:w,name:'General workflow',
   definition:{startStepId:'call',steps:[{id:'call',type:'assistant_call' as const,target:{assistantId:a},prompt:'Fictional prompt'}]}}
  const created=await store.create(params,{authoring:{kind:'internal-human',userId:u,assistantId:a}})
  expect(created.contextGroupId).toBeNull()
  expect(created.authoringAuthority?.ceiling).toMatchObject({workspaceId:w,userId:u,clearance:'internal',
   departmentRead:{departments:{},contextDepartment:null}})
  const saved=created.authoringAuthority!
  expect((await store.create({...params,authoringAuthority:saved})).authoringAuthority).toEqual(saved)
  await expect(store.create({...params,authoringAuthority:{...saved,ceiling:{...saved.ceiling,userId:randomUUID()}}})).rejects.toThrow()
  expect((await pool.query('SELECT count(*)::int AS n FROM workflows WHERE workspace_id=$1',[w])).rows[0].n).toBe(2)
 })
 it('preserves every non-binding schedule field and retained record, then claims and dispatches both jobs',async()=>{
  const f=await fixture()
  const before=(await pool.query("SELECT id,to_jsonb(j)-ARRAY['workflow_authoring_snapshot','updated_at'] AS body FROM scheduled_jobs j WHERE id=ANY($1::uuid[]) ORDER BY id",[f.jobIds])).rows
  const content=(await pool.query('SELECT to_jsonb(a) AS body FROM office_artifacts a WHERE id=$1',[f.retained.id])).rows[0]
  const reviewed=await f.preview()
  expect(reviewed.status,JSON.stringify(reviewed.body)).toBe(200)
  expect(reviewed.body.status,JSON.stringify(reviewed.body)).toBe('prepared')
  expect(reviewed.body.inventory.families).toHaveLength(73)
  expect(JSON.stringify(reviewed.body)).not.toContain('Private synthetic')
  const result=await f.apply(reviewed.body)
  expect(result.status,JSON.stringify(result.body)).toBe(200)
  expect(result.body).toMatchObject({setupState:'ready',recordsDeleted:0,grantsChanged:false})
  expect(result.body.scheduleConversions.sort()).toEqual([...f.jobIds].sort())
  expect((await f.apply(reviewed.body)).body).toEqual(result.body)
  expect((await pool.query("SELECT id,to_jsonb(j)-ARRAY['workflow_authoring_snapshot','updated_at'] AS body FROM scheduled_jobs j WHERE id=ANY($1::uuid[]) ORDER BY id",[f.jobIds])).rows).toEqual(before)
  expect((await pool.query('SELECT to_jsonb(a) AS body FROM office_artifacts a WHERE id=$1',[f.retained.id])).rows[0]).toEqual(content)
  expect((await pool.query('SELECT setup_state,completed_cutover_id FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0]).toEqual({setup_state:'ready',completed_cutover_id:reviewed.body.reviewId})
  for(const id of f.jobIds) {
   await pool.query('UPDATE scheduled_jobs SET next_run_at=clock_timestamp() WHERE id=$1',[id])
   const claim=await f.jobs.claimDueJob!(id)
   expect(claim?.scheduleClaimId).toBeTruthy()
   const run=await createDbWorkflowRunStore().createRun({workflowId:claim!.workflowId!,workspaceId:f.w,triggerKind:'schedule',triggeredBy:null,
    scheduledJob:{id,claimId:claim!.scheduleClaimId!}})
   expect(run.contextGroupId).toBe(f.team.id)
   expect(await f.jobs.finishScheduleClaim!(id,claim!.scheduleClaimId!,{success:true,nextRunAt:new Date(0),maxConsecutiveFailures:3})).toMatchObject({applied:true})
  }
 })
 it('rejects a stale cross-family inventory without changing mode or pinning any job',async()=>{
  const f=await fixture(),reviewed=await f.preview()
  expect(reviewed.body.status,JSON.stringify(reviewed.body)).toBe('prepared')
  await pool.query("UPDATE office_artifacts SET title='Changed synthetic draft' WHERE id=$1",[f.retained.id])
  expect((await f.apply(reviewed.body)).body).toEqual({error:'cutover_review_changed'})
  expect((await pool.query('SELECT setup_state FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0].setup_state).toBe('legacy')
  expect((await pool.query('SELECT id FROM scheduled_jobs WHERE id=ANY($1::uuid[]) AND workflow_authoring_snapshot IS NOT NULL',[f.jobIds])).rows).toEqual([])
 })
 it('does not activate during an outstanding dispatch lease, and fences an expired discovery after conversion',async()=>{
  const f=await fixture()
  await pool.query('UPDATE scheduled_jobs SET next_run_at=clock_timestamp() WHERE id=$1',[f.jobIds[0]])
  const leased=(await f.jobs.getDueJobs()).find(job=>job.id===f.jobIds[0])!
  expect(leased.dispatchLeaseId).toBeTruthy()
  const blocked=await f.preview()
  expect(blocked.body.status,JSON.stringify(blocked.body)).toBe('blocked')
  expect(blocked.body.blockers).toContainEqual({code:'cutover_schedule_not_quiet',kind:'scheduled_job',id:leased.id})
  expect(await f.jobs.finishDispatchLease!(leased.id,leased.dispatchLeaseId!,{success:false,nextRunAt:new Date('2099-01-01'),maxConsecutiveFailures:3})).toMatchObject({applied:true})
  // One-off completion retired its workflow. This fixture reactivates through
  // its ordinary unpinned writer before asking for a fresh review.
  await pool.query("UPDATE workflows SET enabled=true,lifecycle_state='active' WHERE id=$1",[f.workflowIds[0]])
  await pool.query('UPDATE scheduled_jobs SET enabled=true WHERE id=$1',[f.jobIds[0]])
  const reviewed=await f.preview()
  expect(reviewed.body.status,JSON.stringify(reviewed.body)).toBe('prepared')
  expect((await f.apply(reviewed.body)).status).toBe(200)
  expect(await f.jobs.validateDispatchLease!(leased)).toBe(false)
  expect(await f.jobs.finishDispatchLease!(leased.id,leased.dispatchLeaseId!,{success:false,nextRunAt:new Date(0),maxConsecutiveFailures:1})).toMatchObject({applied:false})
  expect((await pool.query('SELECT enabled FROM scheduled_jobs WHERE id=$1',[leased.id])).rows[0].enabled).toBe(true)
 })
 it('requires the actual live owner session and rejects forged body authority',async()=>{
  const f=await fixture(),admin=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[admin])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')",[f.w,admin])
  const session=await authSessionStore.create(admin,{deviceLabel:'Synthetic admin',userAgent:null,ipAddress:null})
  const token=createTokens(admin,secret,session!).accessToken
  expect((await f.preview({},token)).status).toBe(403)
  expect((await f.preview({actorUserId:f.u})).status).toBe(400)
  const reviewed=await f.preview()
  expect(reviewed.body.status,JSON.stringify(reviewed.body)).toBe('prepared')
  await authSessionStore.revokeForUser(f.u,f.session.id)
  expect((await f.apply(reviewed.body)).status).toBe(401)
 })
 it('rolls back every prior conversion if a later trigger rewrites a non-binding field',async()=>{
  const f=await fixture(),reviewed=await f.preview()
  expect(reviewed.body.status).toBe('prepared')
  const target=[...f.jobIds].sort()[1]
  await pool.query(`CREATE OR REPLACE FUNCTION cutover_fixture_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id='${target}'::uuid AND OLD.workflow_authoring_snapshot IS NULL AND NEW.workflow_authoring_snapshot IS NOT NULL
      THEN NEW.instructions:='Unreviewed synthetic rewrite'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER zzzz_cutover_fixture_rewrite BEFORE UPDATE ON scheduled_jobs FOR EACH ROW EXECUTE FUNCTION cutover_fixture_rewrite()`)
  try {
   const result=await f.apply(reviewed.body)
   expect(result.status,JSON.stringify(result.body)).toBe(409)
   expect(result.body).toEqual({error:'cutover_schedule_fields_changed'})
   expect((await pool.query('SELECT id FROM scheduled_jobs WHERE id=ANY($1::uuid[]) AND workflow_authoring_snapshot IS NOT NULL',[f.jobIds])).rows).toEqual([])
   expect((await pool.query('SELECT id FROM workflows WHERE id=ANY($1::uuid[]) AND schedule_authoring_pinned',[f.workflowIds])).rows).toEqual([])
   expect((await pool.query('SELECT setup_state,completed_cutover_id FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0]).toEqual({setup_state:'legacy',completed_cutover_id:null})
   expect((await pool.query('SELECT status FROM workspace_organization_cutover_reviews WHERE id=$1',[reviewed.body.reviewId])).rows[0].status).toBe('prepared')
  }finally {await pool.query('DROP TRIGGER zzzz_cutover_fixture_rewrite ON scheduled_jobs; DROP FUNCTION cutover_fixture_rewrite()')}
 })
 it('does not grant an app-role caller permission to forge a review or pin a job using a GUC',async()=>{
  const f=await fixture(),reviewed=await f.preview(),c=await getAppPool().connect()
  try {
   await c.query('BEGIN');await c.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.organization_cutover_review',$2,true)",[f.u,reviewed.body.reviewId])
   await expect(c.query("UPDATE workspace_organization_cutover_reviews SET status='applying' WHERE id=$1",[reviewed.body.reviewId])).resolves.toMatchObject({rowCount:0})
   const snapshot=(await pool.query('SELECT authoring_authority FROM workflows WHERE id=$1',[f.workflowIds[0]])).rows[0].authoring_authority
   await expect(c.query('UPDATE scheduled_jobs SET workflow_authoring_snapshot=$2::jsonb WHERE id=$1',[f.jobIds[0],JSON.stringify(snapshot)])).rejects.toThrow()
  }finally {await c.query('ROLLBACK');c.release()}
  expect((await f.apply(reviewed.body)).status).toBe(200)
  const mode=await request(app).get(`/workspaces/${f.w}/access/mode`).set('Authorization',`Bearer ${f.token}`)
  expect(mode.body).toMatchObject({setupState:'ready',cutoverReceiptId:reviewed.body.reviewId,canFinalize:true})
 })
 it('fails quickly under a concurrent writer without leaving partial state, then permits a fresh review',async()=>{
  const f=await fixture(),writer=await pool.connect()
  try {
   await writer.query('BEGIN');await writer.query('UPDATE office_artifacts SET title=title WHERE id=$1',[f.retained.id])
   const response=await f.preview()
   expect(response.status).toBe(409)
   expect(response.body).toEqual({error:'cutover_busy'})
   expect((await pool.query('SELECT setup_state FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0].setup_state).toBe('legacy')
  }finally {await writer.query('ROLLBACK');writer.release()}
  expect((await f.preview()).body.status).toBe('prepared')
 })

 it('keeps new tasks, files, knowledge, personal chats and event workflows usable after finalization',async()=>{
  const f=await fixture(),review=await f.preview()
  expect((await f.apply(review.body)).status).toBe(200)
  expect(await createTask(f.u,{workspaceId:f.w,title:'Synthetic post-cutover task'})).toMatchObject({compartments:[f.team.compartmentKey]})
  const knowledge=await createDbKnowledgeStore().upsertByPath({workspaceId:f.w,actorId:f.u,path:'synthetic-after.md',title:'After',content:'Fictional content',sensitivity:'internal'})
  expect(knowledge.compartments).toEqual([f.team.compartmentKey])
  const chat=await createPersonalWebSession({workspaceId:f.w,assistantId:f.a,userId:f.u,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
    {actorUserId:f.u,authSessionId:f.session.id,authVersion:f.session.authVersion})
  expect(chat).toMatchObject({visibility:'personal'})
  const event=await createDbWorkflowStore().create({userId:f.u,workspaceId:f.w,name:'Synthetic event',trigger:{kind:'event',event:{sources:[{source:{type:'task'}}]}},
   definition:{startStepId:'call',steps:[{id:'call',type:'assistant_call',target:{assistantId:f.a},prompt:'Fictional task event'}]}},
   {authoring:{kind:'internal-human',userId:f.u,assistantId:f.a}})
  expect(event.contextGroupId).toBe(f.team.id)
  const blobs=new Map(),gcs={writeBlob:async(k:string,b:Buffer)=>{blobs.set(k,b)},deleteBlob:async(k:string)=>{blobs.delete(k)}}
  const files=createFilesApi({gcs:gcs as never,bucket:'fixture',store:createDbWorkspaceFilesStore(),auditStore:{append:async()=>{}} as never})
  const file=await files.writeBytes({workspaceId:f.w,userId:f.u,assistantKind:'primary',clearance:'internal'},
   {path:'/synthetic-after.txt',bytes:Buffer.from('Fictional file'),mime:'text/plain',sensitivity:'internal'})
  expect(file).toMatchObject({ok:true,value:{compartments:[f.team.compartmentKey]}})
 })

 it('refreshes completed migration plans while keeping a different target mode explicit',async()=>{
  const f=await fixture()
  async function historicalPlan(targetMode:'departments'|'simple') {
   const p=await createMigrationPlan(f.w,f.u,{targetMode,idempotencyKey:randomUUID(),items:[]})
   // Historical already-applied plan bookkeeping. No permission mutation here.
   await pool.query(`INSERT INTO workspace_access_migration_items(workspace_id,plan_id,subject_kind,subject_id,
    proposed_action,reason,before_state,after_state,evidence_versions,dependency_versions,idempotency_key,status)
    VALUES($1,$2,'member',$3,$4,'Synthetic historical receipt','{}','{}',$5,'{}',$6,'applied')`,
    [f.w,p.id,f.u,JSON.stringify({type:'department.member.set',teamId:f.team.id,userId:f.u,enabled:true}),
     JSON.stringify({reviewKey:randomUUID(),policyRevision:'1'}),randomUUID()])
   return p.id
  }
  const departmentPlan=await historicalPlan('departments')
  const review=await f.preview();expect(review.body.status,JSON.stringify(review.body)).toBe('prepared')
  expect((await f.apply(review.body)).status).toBe(200)
  expect((await listMigrationPlans(f.w,f.u)).find(row=>row.id===departmentPlan).status).toBe('completed')
  expect(await getMigrationPlan(f.w,f.u,departmentPlan)).toMatchObject({status:'completed',blockers:[]})
  // Only one unfinished plan is allowed. A subsequent Simple proposal must
  // explicitly report its different target instead of claiming completion.
  const otherPlan=await historicalPlan('simple')
  expect((await getMigrationPlan(f.w,f.u,otherPlan)).blockers).toEqual(['organization_cutover_target_changed'])
 })

})
