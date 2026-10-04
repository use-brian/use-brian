import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {getPool,getAppPool} from '../../db/client.js'
import {createMemory} from '../../db/memories.js'
import {executeDepartmentAccessCommand} from '../service.js'
import {executeWorkspaceScopeReview as canonical} from '../scope-review.js'
import {createMigrationPlan,getMigrationPlan,prepareMigrationItem,applyMigrationItem,getMigrationItemReview,setMigrationPlanState} from '../migration-service.js'
vi.mock('../readiness.js',()=>({getDepartmentalReadinessSystem:async()=>({ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]})}))
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(action:'assign_team'|'hold'|'confirm_general'|'consolidate_default'='assign_team'){
  const w=randomUUID(),u=randomUUID(),a=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[u])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Resource migration',$2)",[w,u])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[w,u])
  await pool.query("INSERT INTO assistants(id,workspace_id,name) VALUES($1,$2,'Assistant')",[a,w])
  const team=(await executeDepartmentAccessCommand(w,u,{type:'department.create',name:'Default',key:'default'})).appliedCommand!.subjectId
  const old=(await executeDepartmentAccessCommand(w,u,{type:'department.create',name:'Old',key:'old'})).appliedCommand!.subjectId
  await pool.query('UPDATE workspace_access_policies SET default_department_id=$2 WHERE workspace_id=$1',[w,team])
  const root=await createMemory({workspaceId:w,userId:u,assistantId:a,createdByUserId:u,summary:'Private bounded evidence',sensitivity:'confidential',compartments:action==='consolidate_default'?[`team:${old}`]:[]})
  const command={type:'resource.scope' as const,resourceKind:'memory' as const,resourceId:root.id,action,...(['assign_team','consolidate_default'].includes(action)?{targetTeamId:team}:{})}
  const input={targetMode:'simple',idempotencyKey:randomUUID(),items:[{command,reason:'Explicit root review'}]}
  const p=await createMigrationPlan(w,u,input),i=(await getMigrationPlan(w,u,p.id)).items[0]
  const review=async()=>{const r=await prepareMigrationItem(w,u,p.id,i.id);if(!('kind' in r))throw Error('resource expected');return r}
  return {w,u,a,team,old,root,input,p,i,review}
}
const direct=(f:{w:string;u:string},r:{review:{id:string;version:string;payloadHash:string}})=>canonical(f.w,f.u,{type:'scope.review.apply',reviewId:r.review.id,expectedVersion:r.review.version,payloadHash:r.review.payloadHash})
describe('bounded RESOURCE migration (real PG)',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it.each(['assign_team','hold','confirm_general','consolidate_default'] as const)('previews and applies exactly one %s root; immutable receipt replays after cancellation',async action=>{
    const f=await fixture(action)
    expect((await pool.query('SELECT count(*) FROM workspace_scope_reviews WHERE workspace_id=$1',[f.w])).rows[0].count).toBe('0')
    expect((await createMigrationPlan(f.w,f.u,f.input)).id).toBe(f.p.id)
    const r=await f.review()
    expect(r.review.items).toHaveLength(1)
    expect((await getMigrationItemReview(f.w,f.u,f.p.id,f.i.id,r.confirmation))).toMatchObject({kind:'resource',alreadyApplied:false})
    const applied=await applyMigrationItem(f.w,f.u,f.p.id,f.i.id,r.confirmation)
    expect(applied.status).toBe('applied')
    const after=(await pool.query('SELECT user_id,assistant_id,sensitivity,project_ids,compartments,scope_held FROM memories WHERE id=$1',[f.root.id])).rows[0]
    expect(after).toEqual({user_id:f.u,assistant_id:f.a,sensitivity:'confidential',project_ids:[],
      compartments:['assign_team','consolidate_default'].includes(action)?[`team:${f.team}`]:[],scope_held:action==='hold'})
    expect((await getMigrationPlan(f.w,f.u,f.p.id)).status).toBe('blocked')
    await setMigrationPlanState(f.w,f.u,f.p.id,'cancelled')
    expect((await applyMigrationItem(f.w,f.u,f.p.id,f.i.id,r.confirmation)).status).toBe('applied')
    expect((await direct(f,r)).status).toBe('complete')
    expect((await pool.query("SELECT count(*) FROM workspace_access_events WHERE workspace_id=$1 AND kind='scope.review.apply'",[f.w])).rows[0].count).toBe('1')
    expect((await pool.query('SELECT access_mode FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0].access_mode).toBe('departments')
    await expect(pool.query('DELETE FROM workspace_access_migration_resource_reviews WHERE review_id=$1',[r.review.id])).rejects.toThrow('migration_review_binding_immutable')
  })
  it.each(['paused','cancelled','superseded'] as const)('blocks direct canonical bypass after %s and never resurrects old approval',async state=>{
    const f=await fixture(),r=await f.review()
    if(state==='superseded')await f.review();else await setMigrationPlanState(f.w,f.u,f.p.id,state)
    await expect(direct(f,r)).rejects.toMatchObject({code:'scope_review_conflict'})
    await expect(applyMigrationItem(f.w,f.u,f.p.id,f.i.id,r.confirmation)).rejects.toThrow()
    if(state==='paused'){
      await setMigrationPlanState(f.w,f.u,f.p.id,'proposed')
      await expect(direct(f,r)).rejects.toMatchObject({code:'scope_review_conflict'})
      const fresh=await f.review()
      expect((await applyMigrationItem(f.w,f.u,f.p.id,f.i.id,fresh.confirmation)).status).toBe('applied')
    }else expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[f.root.id])).rows[0].compartments).toEqual([])
  })
  it.each(['source','descendant','policy'] as const)('rejects stale %s evidence without mutations or automatic reapproval',async change=>{
    const f=await fixture(),r=await f.review()
    if(change==='source')await pool.query("UPDATE memories SET summary='Changed' WHERE id=$1",[f.root.id])
    if(change==='policy')await pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1',[f.w])
    if(change==='descendant'){
      const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) source",[f.w,f.root.id])).rows[0].source
      await createMemory({workspaceId:f.w,userId:f.u,assistantId:f.a,createdByUserId:f.u,summary:'Late descendant',sensitivity:'confidential',derivation:{producer:'test',sources:[source]}})
    }
    if(change!=='descendant')await expect(applyMigrationItem(f.w,f.u,f.p.id,f.i.id,r.confirmation)).rejects.toMatchObject({code:'access_policy_conflict'})
    else expect((await applyMigrationItem(f.w,f.u,f.p.id,f.i.id,r.confirmation)).status).toBe('stale')
    expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[f.root.id])).rows[0].compartments).toEqual([])
  })
  it('requires exact confirmation and fresh current admin, including saved review inspection',async()=>{
    const f=await fixture(),r=await f.review()
    for(const patch of [{payloadHash:'0'.repeat(64)},{expectedVersion:'2'},{expiresAt:new Date(0).toISOString()},{reviewId:randomUUID()}]){
      await expect(applyMigrationItem(f.w,f.u,f.p.id,f.i.id,{...r.confirmation,...patch})).rejects.toMatchObject({code:'access_review_changed'})
    }
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.w,f.u])
    await expect(getMigrationItemReview(f.w,f.u,f.p.id,f.i.id,r.confirmation)).rejects.toMatchObject({code:'admin_required'})
    await expect(direct(f,r)).rejects.toMatchObject({code:'admin_required'})
  })
  it('expires every resource action binding, including direct apply, without changing the canonical envelope',async()=>{
    const f=await fixture()
    // Test-only insertion clock: immutable bindings cannot be updated to manufacture expiry.
    await pool.query(`CREATE FUNCTION test_short_resource_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.expires_at=clock_timestamp()+interval '30 milliseconds'; RETURN NEW; END $$;
      CREATE TRIGGER test_short_resource_binding BEFORE INSERT ON workspace_access_migration_resource_reviews FOR EACH ROW EXECUTE FUNCTION test_short_resource_binding()`)
    let r:Awaited<ReturnType<typeof f.review>>
    try{r=await f.review()}finally{await pool.query('DROP TRIGGER test_short_resource_binding ON workspace_access_migration_resource_reviews; DROP FUNCTION test_short_resource_binding()')}
    const expiry=(await pool.query('SELECT expires_at FROM workspace_access_migration_resource_reviews WHERE review_id=$1',[r.review.id])).rows[0].expires_at.toISOString()
    await new Promise(resolve=>setTimeout(resolve,60))
    await expect(applyMigrationItem(f.w,f.u,f.p.id,f.i.id,{...r.confirmation,expiresAt:expiry})).rejects.toMatchObject({code:'scope_review_expired'})
    await expect(direct(f,r)).rejects.toMatchObject({code:'scope_review_conflict'})
    const fresh=await f.review()
    expect((await applyMigrationItem(f.w,f.u,f.p.id,f.i.id,fresh.confirmation)).status).toBe('applied')
  })
  it('preserves inherited source floors instead of treating consolidation as an unrestricted relabel',async()=>{
    const f=await fixture('consolidate_default')
    await setMigrationPlanState(f.w,f.u,f.p.id,'cancelled')
    const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) source",[f.w,f.root.id])).rows[0].source
    const derived=await createMemory({workspaceId:f.w,userId:f.u,assistantId:f.a,createdByUserId:f.u,summary:'Inherited floor',sensitivity:'confidential',derivation:{producer:'test',sources:[source]}})
    await expect(createMigrationPlan(f.w,f.u,{...f.input,idempotencyKey:randomUUID(),items:[{reason:'Cannot remove inherited floor',command:{...f.input.items[0].command,resourceId:derived.id}}]})).rejects.toMatchObject({code:'scope_review_source_floor_unsupported'})
    expect((await pool.query('SELECT compartments,user_id,sensitivity FROM memories WHERE id=$1',[derived.id])).rows[0]).toEqual({compartments:[`team:${f.old}`],user_id:f.u,sensitivity:'confidential'})
    expect((await pool.query('SELECT id FROM workspace_scope_reviews WHERE workspace_id=$1',[f.w])).rows).toHaveLength(0)
  })
  it('guards a late provenance floor at the permanent binding boundary, even on direct canonical apply',async()=>{
    const f=await fixture('consolidate_default')
    const parent=await createMemory({workspaceId:f.w,userId:f.u,assistantId:f.a,createdByUserId:f.u,summary:'Restricted parent',sensitivity:'confidential',compartments:[`team:${f.old}`]})
    const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) source",[f.w,parent.id])).rows[0].source
    const derived=await createMemory({workspaceId:f.w,userId:f.u,assistantId:f.a,createdByUserId:f.u,summary:'Provenance fixture',sensitivity:'confidential',derivation:{producer:'test',sources:[source]}})
    const r=await f.review()
    const receipt=(await pool.query(`INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
      SELECT workspace_id,resource_kind,$2,'1',producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision
      FROM scope_derivations WHERE resource_id=$1 RETURNING id`,[derived.id,f.root.id])).rows[0].id
    await pool.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version) VALUES($1,$2,'memory',$3,$4)`,[f.w,receipt,parent.id,source.version])
    expect((await direct(f,r)).status).toBe('stale')
    expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[f.root.id])).rows[0].compartments).toEqual([`team:${f.old}`])
  })
  it('serializes canonical apply against pause: an already committed receipt survives, with no unapproved next item',async()=>{
    const f=await fixture(),r=await f.review(),client=await pool.connect(),original=client.query.bind(client)
    let reached!:()=>void,release!:()=>void
    const atWrite=new Promise<void>(resolve=>{reached=resolve}),resume=new Promise<void>(resolve=>{release=resolve})
    const spy=vi.spyOn(client,'query').mockImplementation((async(...args:unknown[])=>{
      if(typeof args[0]==='string'&&args[0].startsWith('UPDATE memories SET compartments=')){reached();await resume}
      return (original as (...args:unknown[])=>Promise<unknown>)(...args)
    }) as typeof client.query)
    const connect=vi.spyOn(pool,'connect').mockImplementationOnce((()=>Promise.resolve(client)) as typeof pool.connect)
    const applying=direct(f,r)
    let stopping:Promise<unknown>|undefined
    try{
      await atWrite
      stopping=setMigrationPlanState(f.w,f.u,f.p.id,'paused')
      let blocked=false
      for(let n=0;n<100&&!blocked;n++){
        blocked=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM workspaces%FOR UPDATE%'")).rows.length>0
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(blocked).toBe(true)
      release()
      expect((await applying).status).toBe('complete')
      await stopping
      expect((await getMigrationPlan(f.w,f.u,f.p.id)).status).toBe('paused')
      expect((await applyMigrationItem(f.w,f.u,f.p.id,f.i.id,r.confirmation)).status).toBe('applied')
    }finally{release();await applying.catch(()=>undefined);await stopping;spy.mockRestore();connect.mockRestore()}
  })
  it('honors plan expiry on direct apply while preserving already-applied receipt retries',async()=>{
    const f=await fixture(),r=await f.review()
    await pool.query("UPDATE workspace_access_migration_plans SET expires_at=clock_timestamp()+interval '10 milliseconds' WHERE id=$1",[f.p.id])
    await new Promise(resolve=>setTimeout(resolve,30))
    await expect(applyMigrationItem(f.w,f.u,f.p.id,f.i.id,r.confirmation)).rejects.toMatchObject({code:'migration_expired'})
    await expect(direct(f,r)).rejects.toMatchObject({code:'scope_review_conflict'})
    const done=await fixture(),receipt=await done.review()
    await applyMigrationItem(done.w,done.u,done.p.id,done.i.id,receipt.confirmation)
    await pool.query("UPDATE workspace_access_migration_plans SET expires_at=clock_timestamp()+interval '10 milliseconds' WHERE id=$1",[done.p.id])
    await new Promise(resolve=>setTimeout(resolve,30))
    expect((await applyMigrationItem(done.w,done.u,done.p.id,done.i.id,receipt.confirmation)).status).toBe('applied')
  })
  it('protects permanent resource binding metadata with current-admin RLS',async()=>{
    const f=await fixture(),r=await f.review(),member=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.w,member])
    const client=await getAppPool().connect()
    try{
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.system_bypass','false',true)",[member])
      expect((await client.query('SELECT review_id FROM workspace_access_migration_resource_reviews WHERE review_id=$1',[r.review.id])).rows).toHaveLength(0)
      await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.u])
      expect((await client.query('SELECT review_id FROM workspace_access_migration_resource_reviews WHERE review_id=$1',[r.review.id])).rows).toHaveLength(1)
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('supports impact roots through the review registry and persists unsupported actions as blockers',async()=>{
    const f=await fixture(),session=randomUUID()
    await setMigrationPlanState(f.w,f.u,f.p.id,'cancelled')
    await pool.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id,effective_clearance) VALUES($1::uuid,$2,$3,'web',$1::text,$4,'confidential')",[session,f.a,f.u,f.w])
    const root=(await pool.query(`INSERT INTO file_cache(session_id,file_name,mime_type,content,size_bytes,expires_at,workspace_id,user_id,assistant_id,sensitivity)
      VALUES($1,'impact.txt','text/plain','bounded cache',13,now()+interval '1 day',$2,$3,$4,'confidential') RETURNING id`,[session,f.w,f.u,f.a])).rows[0].id
    const input={...f.input,idempotencyKey:randomUUID(),items:[{reason:'Unsupported assignment',command:{type:'resource.scope',resourceKind:'file_cache',resourceId:root,action:'assign_team',targetTeamId:f.team}}]}
    const p=await createMigrationPlan(f.w,f.u,input),i=(await getMigrationPlan(f.w,f.u,p.id)).items[0]
    expect(i).toMatchObject({status:'blocked',diagnostic_code:'scope_review_action_unsupported',after_state:{blocker:'scope_review_action_unsupported',allowedActions:['confirm_general','hold']}})
    await expect(prepareMigrationItem(f.w,f.u,p.id,i.id)).rejects.toMatchObject({code:'scope_review_action_unsupported'})
    await setMigrationPlanState(f.w,f.u,p.id,'cancelled')
    const supported=await createMigrationPlan(f.w,f.u,{...input,idempotencyKey:randomUUID(),items:[{reason:'Hold cache',command:{type:'resource.scope',resourceKind:'file_cache',resourceId:root,action:'hold'}}]})
    const next=(await getMigrationPlan(f.w,f.u,supported.id)).items[0],r=await prepareMigrationItem(f.w,f.u,supported.id,next.id)
    if(!('kind' in r))throw Error('resource expected')
    expect((await applyMigrationItem(f.w,f.u,supported.id,next.id,r.confirmation)).status).toBe('applied')
  })
  it('rolls back the canonical preview if binding fails, leaving no directly applicable orphan',async()=>{
    const f=await fixture()
    await pool.query(`CREATE FUNCTION test_fail_resource_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test_binding_failure'; END $$;
      CREATE TRIGGER test_fail_resource_binding BEFORE INSERT ON workspace_access_migration_resource_reviews FOR EACH ROW EXECUTE FUNCTION test_fail_resource_binding()`)
    try{await expect(f.review()).rejects.toMatchObject({code:'access_conflict'})}
    finally{await pool.query('DROP TRIGGER test_fail_resource_binding ON workspace_access_migration_resource_reviews; DROP FUNCTION test_fail_resource_binding()')}
    expect((await pool.query('SELECT id FROM workspace_scope_reviews WHERE workspace_id=$1',[f.w])).rows).toHaveLength(0)
    expect((await getMigrationPlan(f.w,f.u,f.p.id)).items[0].scope_review_id).toBeNull()
    expect((await f.review()).review.status).toBe('preview')
  })
  it('does not let another current admin apply an actor-bound migration review directly',async()=>{
    const f=await fixture(),r=await f.review(),other=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[other])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')",[f.w,other])
    // Membership changed policy: prepare again before testing the actor guard.
    const fresh=await f.review()
    await expect(direct({...f,u:other},fresh)).rejects.toMatchObject({code:'scope_review_conflict'})
    expect((await applyMigrationItem(f.w,f.u,f.p.id,f.i.id,fresh.confirmation)).status).toBe('applied')
    expect(r.review.id).not.toBe(fresh.review.id)
  })
  it('reconciles direct successful canonical apply after a lost facade response; never advances another item',async()=>{
    const f=await fixture(),r=await f.review()
    await direct(f,r)
    expect((await getMigrationPlan(f.w,f.u,f.p.id)).items[0].status).toBe('applied')
    expect((await applyMigrationItem(f.w,f.u,f.p.id,f.i.id,r.confirmation)).status).toBe('applied')
  })
})
