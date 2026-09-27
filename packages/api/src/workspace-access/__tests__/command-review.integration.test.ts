import {contextScopeRoutes} from '../../routes/context-scopes.js'
import {viewsRoutes} from '../../routes/views.js'
import {createWorkspaceStore} from '../../db/workspace-store.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {getPool,getAppPool} from '../../db/client.js'
import {workspaceAccessRoutes} from '../../routes/workspace-access.js'
import {executeDepartmentAccessCommand,getWorkspaceAccess} from '../service.js'
import {prepareDepartmentCommand,applyDepartmentCommand,applyDepartmentCommandIntent} from '../command-review.js'
import type {DepartmentAccessCommand,DepartmentCommandReview} from '@use-brian/shared'
vi.mock('../readiness.js',()=>({getDepartmentalReadinessSystem:vi.fn(async()=>({ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]}))}))
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(){
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID()
  for(const id of [owner,member])await pool.query("INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,'Fictional person')",[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Command fixture',$2)",[workspaceId,owner])
  for(const id of [owner,member])await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)",[workspaceId,id,id===owner?'owner':'member'])
  const intent=async(command:DepartmentAccessCommand)=>({command,expectedPolicyRevision:(await getWorkspaceAccess(workspaceId,owner)).policyRevision,idempotencyKey:randomUUID()})
  return{workspaceId,owner,member,intent}
}
const create={type:'department.create' as const,name:'Research',key:'research'}
const apply=(review:DepartmentCommandReview)=>({type:'access.command.apply' as const,reviewId:review.id,payloadHash:review.payloadHash})
function appFor(userId:string){const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=userId;next()});app.use('/api',workspaceAccessRoutes());app.use('/api',contextScopeRoutes({workspaceStore:createWorkspaceStore()}));return app}
describe('[COMP:api/workspace-access] immutable command review and application',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('reviews assistant clearance atomically with session/thread denormalization and idempotent replay',async()=>{
    const f=await fixture(),assistantId=randomUUID(),sessionId=randomUUID(),pageId=randomUUID();
    await pool.query("INSERT INTO assistants(id,workspace_id,name,clearance) VALUES($1,$2,'Review assistant','internal')",[assistantId,f.workspaceId]);
    await pool.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id,visibility,effective_clearance) VALUES($1,$2,$3,'web','fixture',$4,'workspace','internal')",[sessionId,assistantId,f.member,f.workspaceId]);
    await pool.query("INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type) VALUES($1,$2,$3,'Review page','tasks','table')",[pageId,f.workspaceId,f.owner]);
    await pool.query("INSERT INTO comment_threads(page_id,workspace_id,session_id,anchor_kind,created_by,effective_clearance) VALUES($1,$2,$3,'ai_block',$4,'internal')",[pageId,f.workspaceId,sessionId,f.member]);
    const command={type:'assistant.clearance.set' as const,assistantId,clearance:'public' as const};
    const review=await prepareDepartmentCommand(f.workspaceId,f.owner,await f.intent(command));
    expect(review.changes).toContainEqual({field:'clearance',before:[{kind:'code',value:'internal'}],after:[{kind:'code',value:'public'}]});
    const read=async()=> (await pool.query(`SELECT a.clearance,s.effective_clearance AS session,ct.effective_clearance AS thread FROM assistants a JOIN sessions s ON s.assistant_id=a.id JOIN comment_threads ct ON ct.session_id=s.id WHERE a.id=$1`,[assistantId])).rows[0];
    expect(await read()).toEqual({clearance:'internal',session:'internal',thread:'internal'});
    const applied=await applyDepartmentCommand(f.workspaceId,f.owner,apply(review));
    expect(await read()).toEqual({clearance:'public',session:'public',thread:'public'});
    expect(BigInt(applied.policyRevision)).toBeGreaterThan(BigInt(review.policyRevision));
    expect((await applyDepartmentCommand(f.workspaceId,f.owner,apply(review))).commandReceipt?.replayed).toBe(true);
    expect((await pool.query("SELECT 1 FROM workspace_access_events WHERE workspace_id=$1 AND kind='assistant.clearance.set'",[f.workspaceId])).rows).toHaveLength(1);
  });
  it('requires live direct owner membership and refuses ownership revoked after clearance review',async()=>{
    const f=await fixture(),assistantId=randomUUID();
    await pool.query("INSERT INTO assistants(id,workspace_id,name,clearance) VALUES($1,$2,'Owned fixture','internal')",[assistantId,f.workspaceId]);
    const command={type:'assistant.clearance.set' as const,assistantId,clearance:'public' as const};
    await expect(prepareDepartmentCommand(f.workspaceId,f.member,await f.intent(command))).rejects.toMatchObject({code:'admin_required'});
    await pool.query("INSERT INTO assistant_members(assistant_id,user_id,role) VALUES($1,$2,'owner')",[assistantId,f.member]);
    const review=await prepareDepartmentCommand(f.workspaceId,f.member,await f.intent(command));
    await pool.query('DELETE FROM assistant_members WHERE assistant_id=$1 AND user_id=$2',[assistantId,f.member]);
    await expect(applyDepartmentCommand(f.workspaceId,f.member,apply(review))).rejects.toMatchObject({code:'admin_required'});
    expect((await pool.query('SELECT clearance FROM assistants WHERE id=$1',[assistantId])).rows[0].clearance).toBe('internal');
    await expect(prepareDepartmentCommand(f.workspaceId,f.owner,await f.intent({...command,assistantId:randomUUID()}))).rejects.toMatchObject({code:'not_found'});
  });
  it('requires review proof on every legacy Team and assistant writer',async()=>{
    const f=await fixture(),app=appFor(f.owner),created=await executeDepartmentAccessCommand(f.workspaceId,f.owner,create),teamId=created.appliedCommand!.subjectId
    const base=`/api/workspaces/${f.workspaceId}/groups/${teamId}`
    const routes:Array<['post'|'patch'|'put'|'delete',string,Record<string,unknown>]>=[
      ['post',`/api/workspaces/${f.workspaceId}/groups`,{name:'Other',key:'other'}],['patch',base,{name:'Changed'}],
      ['post',`${base}/archive`,{}],['put',`${base}/read-grants`,{readAll:true,groupIds:[]}],
      ['put',`${base}/members/${f.member}`,{}],['delete',`${base}/members/${f.member}`,{}],
      ['put',`${base}/assistants/${randomUUID()}`,{}],['delete',`${base}/assistants/${randomUUID()}`,{}],
      ['put',`/api/workspaces/${f.workspaceId}/assistants/${randomUUID()}/context`,{teamMode:'all',teamIds:[],defaultGroupId:null,projectMode:'all',projectIds:[],defaultProjectId:null}],
    ]
    for(const [method,path,body] of routes){const response=await request(app)[method](path).send(body);expect(response.status).toBe(409);expect(response.body.error).toBe('access_review_required')}
    expect((await pool.query('SELECT count(*)::int AS n FROM workspace_access_events WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(1)
  })
  it('matches legacy create payloads before application and before receipt replay',async()=>{
    const f=await fixture(),app=appFor(f.owner),review=await prepareDepartmentCommand(f.workspaceId,f.owner,await f.intent(create))
    const headers={'X-Brian-Access-Review-Id':review.id,'X-Brian-Access-Review-Hash':review.payloadHash},path=`/api/workspaces/${f.workspaceId}/groups`
    for(const body of [{name:'Other',key:'other'},{name:'Research',key:'research',readAll:true}]){
      const response=await request(app).post(path).set(headers).send(body);expect(response.status).toBe(409);expect(response.body.error).toBe('access_review_changed')
    }
    const first=await request(app).post(path).set(headers).send({name:'Research',key:'research'})
    expect(first.status,JSON.stringify(first.body)).toBe(201)
    const again=await request(app).post(path).set(headers).send({name:'Research',key:'research'})
    expect(again.status).toBe(201);expect(again.body.group.id).toBe(first.body.group.id)
    expect((await request(app).post(path).set(headers).send({name:'Other',key:'other'})).body.error).toBe('access_review_changed')
    expect((await pool.query('SELECT 1 FROM workspace_access_events WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1)
  })
  it('binds member targets, assignment mode and operation across Team and page adapters',async()=>{
    const f=await fixture(),created=await executeDepartmentAccessCommand(f.workspaceId,f.owner,create),teamId=created.appliedCommand!.subjectId
    const review=await prepareDepartmentCommand(f.workspaceId,f.owner,await f.intent({type:'department.member.set',teamId,userId:f.member,enabled:true}))
    const headers={'X-Brian-Access-Review-Id':review.id,'X-Brian-Access-Review-Hash':review.payloadHash},app=appFor(f.owner),base=`/api/workspaces/${f.workspaceId}/groups/${teamId}/members`
    expect((await request(app).put(`${base}/${f.owner}`).set(headers).send({})).body.error).toBe('access_review_changed')
    expect((await request(app).put(`${base}/${f.member}`).set(headers).send({activateAssigned:true})).body.error).toBe('access_review_changed')
    expect((await request(app).delete(`${base}/${f.member}`).set(headers)).body.error).toBe('access_review_changed')
    expect((await request(app).put(`${base}/${f.member}`).set(headers).send({})).status).toBe(204)
    const pageId=randomUUID(),pageApp=express();pageApp.use(express.json());pageApp.use((req,_res,next)=>{req.userId=f.owner;next()})
    pageApp.use('/api',viewsRoutes({savedViewStore:{getById:async()=>({id:pageId,workspaceId:f.workspaceId})},workspaceStore:createWorkspaceStore(),workspaceGroupStore:createDbWorkspaceGroupStore()} as never))
    const pagePath=`/api/views/${pageId}/groups/${teamId}/members`
    expect((await request(pageApp).post(pagePath).send({userId:f.member})).body.error).toBe('access_review_required')
    expect((await request(pageApp).delete(`${pagePath}/${f.member}`)).body.error).toBe('access_review_required')
    expect((await request(pageApp).post(pagePath).set(headers).send({userId:f.owner})).body.error).toBe('access_review_changed')
    expect((await request(pageApp).post(pagePath).set(headers).send({userId:f.member})).status).toBe(201)
    expect((await pool.query("SELECT 1 FROM workspace_access_events WHERE workspace_id=$1 AND kind='department.member.set'",[f.workspaceId])).rows).toHaveLength(1)
    expect((await pool.query('SELECT 1 FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[teamId,f.member])).rows).toHaveLength(1)
  })
  it('previews canonical effects without leaking writes, revisions, audit or approval rows',async()=>{
    const f=await fixture(),intent=await f.intent(create),review=await prepareDepartmentCommand(f.workspaceId,f.owner,intent)
    expect(review.changes).toContainEqual({field:'name',before:[{kind:'code',value:'none'}],after:[{kind:'text',value:'Research'}]})
    expect((await getWorkspaceAccess(f.workspaceId,f.owner)).policyRevision).toBe(intent.expectedPolicyRevision)
    for(const table of ['workspace_groups','workspace_access_events','pending_approvals'])expect((await pool.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows).toEqual([])
    const created=await executeDepartmentAccessCommand(f.workspaceId,f.owner,create),teamId=created.appliedCommand!.subjectId
    await executeDepartmentAccessCommand(f.workspaceId,f.owner,{type:'department.configure',teamId,directoryVisibility:'workspace',requestable:true})
    const memberView=await getWorkspaceAccess(f.workspaceId,f.member)
    const reviewed=await prepareDepartmentCommand(f.workspaceId,f.member,{command:{type:'access.request.create',targetTeamId:teamId,beneficiaryKind:'member',beneficiaryId:f.member,reason:'Review requirements',days:7,ongoing:false},expectedPolicyRevision:memberView.policyRevision,idempotencyKey:randomUUID()})
    expect(reviewed.command).toHaveProperty('startsAt')
    for(const table of ['pending_approvals','workspace_access_requests'])expect((await pool.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows).toEqual([])
    await applyDepartmentCommand(f.workspaceId,f.member,apply(reviewed))
    expect((await pool.query('SELECT starts_at FROM workspace_access_requests WHERE workspace_id=$1',[f.workspaceId])).rows[0].starts_at.toISOString()).toBe((reviewed.command as {startsAt:string}).startsAt)
  })
  it('reviews revocation as a state change instead of promising the preview transaction timestamp',async()=>{
    const f=await fixture(),created=await executeDepartmentAccessCommand(f.workspaceId,f.owner,create),teamId=created.appliedCommand!.subjectId
    await executeDepartmentAccessCommand(f.workspaceId,f.owner,{type:'department.configure',teamId,directoryVisibility:'workspace',requestable:true})
    const requested=await executeDepartmentAccessCommand(f.workspaceId,f.member,{type:'access.request.create',targetTeamId:teamId,beneficiaryKind:'member',beneficiaryId:f.member,reason:'Review requirements',days:7,ongoing:false})
    const r=requested.requests[0]
    const granted=await executeDepartmentAccessCommand(f.workspaceId,f.owner,{type:'access.request.decide',requestId:r.id,expectedVersion:r.version,payloadHash:r.payloadHash,policyRevision:requested.policyRevision,decision:'approved'})
    const review=await prepareDepartmentCommand(f.workspaceId,f.owner,await f.intent({type:'access.grant.revoke',grantId:granted.grants[0].id,reason:'Review complete'}))
    expect(review.changes.find(change=>change.field==='revoked_at')).toEqual({field:'revoked_at',before:[{kind:'code',value:'disabled'}],after:[{kind:'code',value:'enabled'}]})
    expect((await applyDepartmentCommand(f.workspaceId,f.owner,apply(review))).grants[0].status).toBe('revoked')
  })
  it('reuses exact preparation and serializes concurrent application to one effect and audit',async()=>{
    const f=await fixture(),intent=await f.intent(create)
    const [one,two]=await Promise.all([prepareDepartmentCommand(f.workspaceId,f.owner,intent),prepareDepartmentCommand(f.workspaceId,f.owner,intent)])
    expect(one.id).toBe(two.id);expect(one.payloadHash).toBe(two.payloadHash)
    const results=await Promise.all([applyDepartmentCommand(f.workspaceId,f.owner,apply(one)),applyDepartmentCommand(f.workspaceId,f.owner,apply(one))])
    expect(results.map(r=>r.commandReceipt?.replayed).sort()).toEqual([false,true])
    expect(results[0].appliedCommand?.subjectId).toBe(results[1].appliedCommand?.subjectId)
    expect((await pool.query("SELECT 1 FROM workspace_groups WHERE workspace_id=$1 AND key='research'",[f.workspaceId])).rows).toHaveLength(1)
    expect((await pool.query("SELECT 1 FROM workspace_access_events WHERE workspace_id=$1 AND kind='department.create'",[f.workspaceId])).rows).toHaveLength(1)
    expect((await applyDepartmentCommandIntent(f.workspaceId,f.owner,intent)).commandReceipt?.replayed).toBe(true)
    expect(await prepareDepartmentCommand(f.workspaceId,f.owner,intent)).toMatchObject({id:one.id,payloadHash:one.payloadHash,alreadyApplied:true,changes:[]})
  })
  it('rejects changed intent, wrong hash, actor/workspace substitution and execution without review',async()=>{
    const f=await fixture(),other=await fixture(),intent=await f.intent(create),review=await prepareDepartmentCommand(f.workspaceId,f.owner,intent)
    await expect(prepareDepartmentCommand(f.workspaceId,f.owner,{...intent,command:{...create,name:'Different'}})).rejects.toMatchObject({code:'access_idempotency_conflict'})
    await expect(applyDepartmentCommand(f.workspaceId,f.owner,{...apply(review),payloadHash:'0'.repeat(64)})).rejects.toMatchObject({code:'access_review_changed'})
    await expect(applyDepartmentCommand(f.workspaceId,f.member,apply(review))).rejects.toMatchObject({code:'not_found'})
    await expect(applyDepartmentCommand(other.workspaceId,other.owner,apply(review))).rejects.toMatchObject({code:'not_found'})
    await expect(applyDepartmentCommandIntent(f.workspaceId,f.owner,{...intent,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'access_review_required'})
    await expect(applyDepartmentCommandIntent(f.workspaceId,f.owner,{...intent,command:{...create,name:'Different'}})).rejects.toMatchObject({code:'access_idempotency_conflict'})
    expect((await request(appFor(f.owner)).post(`/api/workspaces/${f.workspaceId}/access/commands`).send(create)).body.error).toBe('access_review_required')
  })
  it('refuses stale authority and returns only a fresh filtered projection after a committed retry',async()=>{
    const f=await fixture(),review=await prepareDepartmentCommand(f.workspaceId,f.owner,await f.intent(create))
    await pool.query("UPDATE workspace_members SET role='member',team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.owner])
    await expect(applyDepartmentCommand(f.workspaceId,f.owner,apply(review))).rejects.toMatchObject({code:'access_policy_conflict'})
    await pool.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.owner])
    const next=await prepareDepartmentCommand(f.workspaceId,f.owner,await f.intent(create));await applyDepartmentCommand(f.workspaceId,f.owner,apply(next))
    await pool.query("UPDATE workspace_members SET role='member',team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.owner])
    await pool.query('DELETE FROM workspace_group_members WHERE user_id=$1 AND group_id IN(SELECT id FROM workspace_groups WHERE workspace_id=$2)',[f.owner,f.workspaceId])
    const retried=await applyDepartmentCommand(f.workspaceId,f.owner,apply(next))
    expect(retried.canAdminister).toBe(false);expect(retried.teams).toEqual([]);expect(retried.appliedCommand).toBeUndefined();expect(retried.commandReceipt?.replayed).toBe(true)
  })
  it('protects review immutability and enforces expiry without mutating the command',async()=>{
    const f=await fixture(),review=await prepareDepartmentCommand(f.workspaceId,f.owner,await f.intent(create))
    await expect(pool.query("UPDATE workspace_access_command_reviews SET command=jsonb_set(command,'{name}','\"Changed\"') WHERE id=$1",[review.id])).rejects.toThrow('access_review_immutable')
    const expiredId=randomUUID()
    await pool.query(`INSERT INTO workspace_access_command_reviews(id,workspace_id,actor_user_id,idempotency_key,intent_hash,command,policy_revision,changes,payload_hash,created_at,expires_at)
      SELECT $2,workspace_id,actor_user_id,$3,intent_hash,command,policy_revision,changes,payload_hash,now()-interval '2 hours',now()-interval '1 hour' FROM workspace_access_command_reviews WHERE id=$1`,[review.id,expiredId,randomUUID()])
    await expect(applyDepartmentCommand(f.workspaceId,f.owner,{...apply(review),reviewId:expiredId})).rejects.toMatchObject({code:'access_review_expired'})
    expect((await pool.query('SELECT 1 FROM workspace_groups WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  })
  it('rolls back application, audit and receipt together and safely retries after repair',async()=>{
    const f=await fixture(),review=await prepareDepartmentCommand(f.workspaceId,f.owner,await f.intent(create))
    await pool.query(`CREATE FUNCTION fixture_review_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${review.id}'::uuid THEN RAISE EXCEPTION 'receipt_unavailable'; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE TRIGGER fixture_review_failure BEFORE UPDATE ON workspace_access_command_reviews FOR EACH ROW EXECUTE FUNCTION fixture_review_failure()')
    try{
      await expect(applyDepartmentCommand(f.workspaceId,f.owner,apply(review))).rejects.toMatchObject({code:'access_conflict'})
      for(const table of ['workspace_groups','workspace_access_events'])expect((await pool.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows).toEqual([])
      expect((await pool.query('SELECT status FROM workspace_access_command_reviews WHERE id=$1',[review.id])).rows[0].status).toBe('preview')
    }finally{await pool.query('DROP TRIGGER fixture_review_failure ON workspace_access_command_reviews');await pool.query('DROP FUNCTION fixture_review_failure()')}
    expect((await applyDepartmentCommand(f.workspaceId,f.owner,apply(review))).commandReceipt?.replayed).toBe(false)
  })
  it('isolates review metadata with non-superuser RLS and refuses unauthorized preparation',async()=>{
    const f=await fixture(),intent=await f.intent(create),review=await prepareDepartmentCommand(f.workspaceId,f.owner,intent)
    await expect(prepareDepartmentCommand(f.workspaceId,f.member,intent)).rejects.toMatchObject({code:'admin_required'})
    const client=await getAppPool().connect()
    try{
      await client.query('BEGIN');await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.member])
      expect((await client.query('SELECT id FROM workspace_access_command_reviews WHERE id=$1',[review.id])).rows).toEqual([])
      await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.owner])
      expect((await client.query('SELECT id FROM workspace_access_command_reviews WHERE id=$1',[review.id])).rows).toHaveLength(1)
      expect((await client.query("UPDATE workspace_access_command_reviews SET status='applied',applied_at=now(),receipt='{}' WHERE id=$1 RETURNING id",[review.id])).rows).toEqual([])
      await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.owner])
      expect((await client.query('SELECT id FROM workspace_access_command_reviews WHERE id=$1',[review.id])).rows).toEqual([])
    }finally{await client.query('ROLLBACK');client.release()}
  })
})
