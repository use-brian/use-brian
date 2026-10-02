import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {getPool,getAppPool} from '../../db/client.js'
import {executeDepartmentAccessCommand,getWorkspaceAccess} from '../service.js'
import {applyDepartmentCommand} from '../command-review.js'
import {createMigrationPlan,getMigrationPlan,listMigrationPlans,prepareMigrationItem,applyMigrationItem,setMigrationPlanState} from '../migration-service.js'
vi.mock('../readiness.js',()=>({getDepartmentalReadinessSystem:async()=>({ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]})}))
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(){
  const w=randomUUID(),u=randomUUID(),m=randomUUID(),a=randomUUID()
  for(const id of [u,m])await pool.query("INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,'Migration fixture')",[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Migration fixture',$2)",[w,u])
  for(const id of [u,m])await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)',[w,id,id===u?'owner':'member'])
  await pool.query("INSERT INTO assistants(id,workspace_id,name) VALUES($1,$2,'Migration assistant')",[a,w])
  const t=(await executeDepartmentAccessCommand(w,u,{type:'department.create',name:'Research',key:'research'})).appliedCommand!.subjectId
  const input={targetMode:'simple' as const,idempotencyKey:randomUUID(),items:[{command:{type:'department.member.set' as const,teamId:t,userId:m,enabled:true,activateAssigned:true},reason:'Named pilot'},{command:{type:'department.assistant.set' as const,teamId:t,assistantId:a,enabled:true},reason:'Assistant pilot'}]}
  return {w,u,m,a,t,input}
}
const proof=(r:{id:string;payloadHash:string})=>({type:'access.command.apply' as const,reviewId:r.id,payloadHash:r.payloadHash})
describe('[COMP:api/workspace-access] bounded durable migration',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('creates an idempotent inventory-only draft without treating empty work as applied',async()=>{
    const f=await fixture(),input={...f.input,items:[]}
    const p=await createMigrationPlan(f.w,f.u,input)
    expect(p.status).toBe('draft')
    expect((await createMigrationPlan(f.w,f.u,input)).id).toBe(p.id)
    expect(await getMigrationPlan(f.w,f.u,p.id)).toMatchObject({status:'draft',items:[]})
    expect((await setMigrationPlanState(f.w,f.u,p.id,'paused')).status).toBe('paused')
    expect((await setMigrationPlanState(f.w,f.u,p.id,'proposed')).status).toBe('draft')
    expect((await getMigrationPlan(f.w,f.u,p.id)).blockers).toContain('intake_certification_required')
    expect((await setMigrationPlanState(f.w,f.u,p.id,'cancelled')).status).toBe('cancelled')
    expect((await getMigrationPlan(f.w,f.u,p.id)).status).toBe('cancelled')
  })
  it('simulates without writes; checkpoints exact reviews, retries and blocks final completion',async()=>{
    const f=await fixture(),before=await getWorkspaceAccess(f.w,f.u)
    const p=await createMigrationPlan(f.w,f.u,f.input),retry=await createMigrationPlan(f.w,f.u,f.input)
    expect(retry.id).toBe(p.id)
    let state=await getMigrationPlan(f.w,f.u,p.id)
    expect(state.items).toHaveLength(2)
    expect((await getWorkspaceAccess(f.w,f.u)).policyRevision).toBe(before.policyRevision)
    expect((await pool.query('SELECT 1 FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.t,f.m])).rows).toHaveLength(0)
    const member=state.items.find(i=>i.subject_kind==='member')!,assistant=state.items.find(i=>i.subject_kind==='assistant')!
    expect(member.before_state.reach.compartments).toBeNull()
    expect(member.after_state.reach.compartments).toEqual([`team:${f.t}`])
    expect(member.after_state.reach.mutationCompartments).toEqual([`team:${f.t}`])
    expect(member.after_state.person.role).toBe('member')
    const one=await prepareMigrationItem(f.w,f.u,p.id,member.id),stale=await prepareMigrationItem(f.w,f.u,p.id,assistant.id)
    const applied=await Promise.allSettled([applyMigrationItem(f.w,f.u,p.id,member.id,proof(one.review)),applyMigrationItem(f.w,f.u,p.id,member.id,proof(one.review))])
    expect(applied.some(i=>i.status==='fulfilled'&&i.value.status==='applied')).toBe(true)
    for(const result of applied)if(result.status==='rejected')expect(result.reason).toMatchObject({code:'migration_busy'})
    expect((await applyMigrationItem(f.w,f.u,p.id,member.id,proof(one.review))).status).toBe('applied')
    await expect(applyMigrationItem(f.w,f.u,p.id,assistant.id,proof(stale.review))).rejects.toMatchObject({code:'access_policy_conflict'})
    const fresh=await prepareMigrationItem(f.w,f.u,p.id,assistant.id)
    expect(fresh.review.id).not.toBe(stale.review.id)
    // Lost response/checkpoint: canonical receipt is durable and get resumes from it.
    await pool.query('UPDATE workspace_access_migration_items SET command_review_id=NULL WHERE id=$1',[assistant.id])
    // Recover a saved review even if the process died before attaching its reference.
    expect((await getMigrationPlan(f.w,f.u,p.id)).items.find(i=>i.id===assistant.id)?.command_review_id).toBe(fresh.review.id)
    await applyDepartmentCommand(f.w,f.u,proof(fresh.review))
    state=await getMigrationPlan(f.w,f.u,p.id)
    expect(state.items.every(i=>i.status==='applied')).toBe(true)
    expect(state.status).toBe('blocked')
    expect(state.blockers).toContain('mode_finalizer_unavailable')
    expect((await pool.query('SELECT access_mode FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0].access_mode).toBe('departments')
    expect((await pool.query("SELECT 1 FROM workspace_access_events WHERE workspace_id=$1 AND kind IN ('department.member.set','department.assistant.set')",[f.w])).rows).toHaveLength(2)
    await setMigrationPlanState(f.w,f.u,p.id,'cancelled')
    expect((await pool.query('SELECT 1 FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.t,f.m])).rows).toHaveLength(1)
    expect((await getMigrationPlan(f.w,f.u,p.id)).status).toBe('cancelled')
  })
  it('enforces current admin, locality, strict action allowlist and idempotency intent',async()=>{
    const f=await fixture(),other=await fixture()
    await expect(createMigrationPlan(f.w,f.m,f.input)).rejects.toMatchObject({code:'admin_required'})
    for(const command of [{type:'workspace.access_mode.set',mode:'simple'},{type:'department.create',name:'No',key:'no'},{type:'assistant.clearance.set',assistantId:f.a,clearance:'confidential'}]){
      await expect(createMigrationPlan(f.w,f.u,{...f.input,items:[{command,reason:'Forbidden'}]})).rejects.toMatchObject({code:'invalid_command'})
    }
    await expect(createMigrationPlan(f.w,f.u,{...f.input,actorUserId:other.u})).rejects.toMatchObject({code:'invalid_command'})
    await expect(createMigrationPlan(f.w,f.u,{...f.input,items:[{command:{...f.input.items[0].command,userId:other.m},reason:'Foreign'}]})).rejects.toThrow()
    const p=await createMigrationPlan(f.w,f.u,f.input)
    await expect(createMigrationPlan(f.w,f.u,{...f.input,targetMode:'departments'})).rejects.toMatchObject({code:'access_idempotency_conflict'})
    await expect(getMigrationPlan(other.w,other.u,p.id)).rejects.toMatchObject({code:'not_found'})
    await expect(listMigrationPlans(f.w,f.m)).rejects.toMatchObject({code:'admin_required'})
    expect((await listMigrationPlans(f.w,f.u)).map(p=>p.id)).toContain(p.id)
    const i=(await getMigrationPlan(f.w,f.u,p.id)).items[0],r=await prepareMigrationItem(f.w,f.u,p.id,i.id)
    await expect(applyMigrationItem(f.w,f.u,p.id,i.id,{...proof(r.review),payloadHash:'0'.repeat(64)})).rejects.toMatchObject({code:'access_review_changed'})
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.w,f.u])
    await expect(applyMigrationItem(f.w,f.u,p.id,i.id,proof(r.review))).rejects.toMatchObject({code:'admin_required'})
    await expect(getMigrationPlan(f.w,f.u,p.id)).rejects.toMatchObject({code:'admin_required'})
  })
  it('pauses/resumes without writes and cancels only future work; metadata obeys RLS',async()=>{
    const f=await fixture(),p=await createMigrationPlan(f.w,f.u,f.input),state=await getMigrationPlan(f.w,f.u,p.id)
    await setMigrationPlanState(f.w,f.u,p.id,'paused')
    await expect(prepareMigrationItem(f.w,f.u,p.id,state.items[0].id)).rejects.toMatchObject({code:'migration_not_active'})
    await setMigrationPlanState(f.w,f.u,p.id,'proposed')
    const client=await getAppPool().connect()
    try{await client.query('BEGIN');await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.m]);expect((await client.query('SELECT id FROM workspace_access_migration_plans WHERE id=$1',[p.id])).rows).toEqual([])
      await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.u]);expect((await client.query('SELECT id FROM workspace_access_migration_plans WHERE id=$1',[p.id])).rows).toHaveLength(1)
    }finally{await client.query('ROLLBACK');client.release()}
    await setMigrationPlanState(f.w,f.u,p.id,'cancelled')
    await expect(prepareMigrationItem(f.w,f.u,p.id,state.items[0].id)).rejects.toMatchObject({code:'migration_not_active'})
    expect((await pool.query('SELECT 1 FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.t,f.m])).rows).toHaveLength(0)
  })
  it('pause and cancellation stop already-saved reviews even through the direct command endpoint',async()=>{
    const f=await fixture(),p=await createMigrationPlan(f.w,f.u,f.input),state=await getMigrationPlan(f.w,f.u,p.id)
    const i=state.items.find(i=>i.subject_kind==='member')!,old=await prepareMigrationItem(f.w,f.u,p.id,i.id)
    await setMigrationPlanState(f.w,f.u,p.id,'paused')
    await expect(applyDepartmentCommand(f.w,f.u,proof(old.review))).rejects.toMatchObject({code:'access_conflict'})
    await setMigrationPlanState(f.w,f.u,p.id,'proposed')
    // Resuming cannot resurrect the old confirmation.
    await expect(applyDepartmentCommand(f.w,f.u,proof(old.review))).rejects.toMatchObject({code:'access_conflict'})
    const fresh=await prepareMigrationItem(f.w,f.u,p.id,i.id)
    expect(fresh.review.id).not.toBe(old.review.id)
    await setMigrationPlanState(f.w,f.u,p.id,'cancelled')
    await expect(applyDepartmentCommand(f.w,f.u,proof(fresh.review))).rejects.toMatchObject({code:'access_conflict'})
    expect((await pool.query('SELECT 1 FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.t,f.m])).rows).toHaveLength(0)
    expect((await pool.query('SELECT 1 FROM workspace_access_migration_reviews WHERE item_id=$1',[i.id])).rows).toHaveLength(2)
    await expect(pool.query('DELETE FROM workspace_access_migration_reviews WHERE review_id=$1',[old.review.id])).rejects.toThrow('migration_review_binding_immutable')
  })
  it('renews an expired review with a new exact confirmation instead of trapping its idempotency key',async()=>{
    const f=await fixture(),p=await createMigrationPlan(f.w,f.u,f.input),state=await getMigrationPlan(f.w,f.u,p.id),i=state.items[0],expiredId=randomUUID()
    await pool.query(`INSERT INTO workspace_access_command_reviews(id,workspace_id,actor_user_id,idempotency_key,intent_hash,command,policy_revision,changes,payload_hash,expires_at)
      VALUES($1,$2,$3,$4,repeat('a',64),$5,$6,'[]',repeat('b',64),clock_timestamp()+interval '1 millisecond')`,
      [expiredId,f.w,f.u,i.evidence_versions.reviewKey,i.proposed_action,i.evidence_versions.policyRevision])
    await new Promise(resolve=>setTimeout(resolve,20))
    const fresh=await prepareMigrationItem(f.w,f.u,p.id,i.id)
    expect(fresh.review.id).not.toBe(expiredId)
    expect((await applyMigrationItem(f.w,f.u,p.id,i.id,proof(fresh.review))).status).toBe('applied')
    await setMigrationPlanState(f.w,f.u,p.id,'cancelled')
    // Receipt replay remains safe after cancellation.
    expect((await applyMigrationItem(f.w,f.u,p.id,i.id,proof(fresh.review))).status).toBe('applied')
  })
  it('supports explicit assigned-member and assistant audience commands with current-policy review',async()=>{
    const f=await fixture(),revision=(await getWorkspaceAccess(f.w,f.u)).policyRevision
    const clearance=(await pool.query('SELECT clearance FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.w,f.m])).rows[0].clearance
    const p=await createMigrationPlan(f.w,f.u,{...f.input,items:[
      {reason:'Explicit assigned mode',command:{type:'member.access.set',userId:f.m,teamScopeMode:'assigned',clearance,expectedPolicyRevision:revision}},
      {reason:'Explicit assistant audience',command:{type:'assistant.audience.set',assistantId:f.a,teamMode:'assigned',teamIds:[f.t],defaultGroupId:f.t,projectMode:'all',projectIds:[],defaultProjectId:null}},
    ]})
    for(const i of (await getMigrationPlan(f.w,f.u,p.id)).items){
      const r=await prepareMigrationItem(f.w,f.u,p.id,i.id)
      await applyMigrationItem(f.w,f.u,p.id,i.id,proof(r.review))
    }
    expect((await getMigrationPlan(f.w,f.u,p.id)).status).toBe('blocked')
    expect((await pool.query('SELECT role,clearance,team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.w,f.m])).rows[0]).toEqual({role:'member',clearance,team_scope_mode:'assigned'})
    expect((await pool.query('SELECT team_scope_mode,default_workspace_group_id FROM assistants WHERE id=$1',[f.a])).rows[0]).toEqual({team_scope_mode:'assigned',default_workspace_group_id:f.t})
  })
  it('returns a retryable busy result without consuming the pool while another runner holds the workspace lease',async()=>{
    const f=await fixture(),holder=await pool.connect()
    try{
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1,620))',[f.w])
      await expect(createMigrationPlan(f.w,f.u,f.input)).rejects.toMatchObject({code:'migration_busy'})
    }finally{await holder.query('SELECT pg_advisory_unlock(hashtextextended($1,620))',[f.w]);holder.release()}
    expect((await createMigrationPlan(f.w,f.u,f.input)).status).toBe('proposed')
  })
  it('preserves clearance by rejecting changes even in a canonical member command',async()=>{
    const f=await fixture(),revision=(await getWorkspaceAccess(f.w,f.u)).policyRevision
    const clearance=(await pool.query('SELECT clearance FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.w,f.m])).rows[0].clearance
    await expect(createMigrationPlan(f.w,f.u,{...f.input,items:[{reason:'No clearance escalation',command:{type:'member.access.set',userId:f.m,teamScopeMode:'assigned',clearance:clearance==='public'?'confidential':'public',expectedPolicyRevision:revision}}]})).rejects.toMatchObject({code:'migration_clearance_change_forbidden'})
    expect(await listMigrationPlans(f.w,f.u)).toEqual([])
  })
})
