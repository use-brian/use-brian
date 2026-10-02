import pg from 'pg'
import {createMemory} from '../../db/memories.js'
import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {getPool,getAppPool} from '../../db/client.js'
import {executeDepartmentAccessCommand,getWorkspaceAccess} from '../service.js'
import {applyDepartmentCommand,withCommandReviewTransaction} from '../command-review.js'
import {createMigrationPlan,getMigrationPlan,listMigrationPlans,getMigrationItemReview,prepareMigrationItem,applyMigrationItem,setMigrationPlanState} from '../migration-service.js'
vi.mock('../readiness.js',()=>({getDepartmentalReadinessSystem:async()=>({ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]})}))
vi.hoisted(()=>{process.env.PG_SINGLE_CONNECTION='1'})
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
describe('[COMP:api/workspace-access] migration on the shared embedded single connection',()=>{
  afterAll(async()=>{await pool.end()})
  it('commits each reserved phase and releases only owned clients, including rollback',async()=>{
    expect(getAppPool()).toBe(pool)
    expect(pool.options.max).toBe(1)
    const c=await pool.connect()
    try{
      const first=await withCommandReviewTransaction(async client=>{
        expect(client).toBe(c)
        await client.query('CREATE TEMP TABLE migration_phase_probe(value int)')
        await client.query('INSERT INTO migration_phase_probe VALUES(1)')
        return (await client.query('SELECT txid_current()::text AS id')).rows[0].id
      },c)
      await expect(withCommandReviewTransaction(async client=>{
        await client.query('INSERT INTO migration_phase_probe VALUES(2)')
        throw new Error('phase failure')
      },c)).rejects.toThrow('phase failure')
      await withCommandReviewTransaction(async client=>{
        expect((await client.query('SELECT txid_current()::text AS id')).rows[0].id).not.toBe(first)
        expect((await client.query('SELECT * FROM migration_phase_probe')).rows).toEqual([{value:1}])
      },c)
    }finally{c.release()}
    expect(pool.waitingCount).toBe(0)
  })
  it('retains nonblocking cross-session exclusion with the shared pool at max one',async()=>{
    const f=await fixture(),holder=new pg.Client({connectionString:process.env.DATABASE_URL})
    await holder.connect()
    try{
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1,620))',[f.w])
      await expect(createMigrationPlan(f.w,f.u,f.input)).rejects.toMatchObject({code:'migration_busy'})
    }finally{await holder.end()}
    expect((await createMigrationPlan(f.w,f.u,f.input)).status).toBe('proposed')
  })
  it('keeps resource simulation, saved review and canonical apply on the reserved client',async()=>{
    const f=await fixture()
    const root=await createMemory({workspaceId:f.w,userId:f.u,assistantId:f.a,createdByUserId:f.u,summary:'Single connection evidence',sensitivity:'confidential',compartments:[]})
    const p=await createMigrationPlan(f.w,f.u,{targetMode:'simple',idempotencyKey:randomUUID(),items:[{
      reason:'Explicit resource',command:{type:'resource.scope',resourceKind:'memory',resourceId:root.id,action:'assign_team',targetTeamId:f.t},
    }]})
    const i=(await getMigrationPlan(f.w,f.u,p.id)).items[0]
    const r=await prepareMigrationItem(f.w,f.u,p.id,i.id)
    if(!('kind' in r))throw new Error('Expected resource review')
    expect(await getMigrationItemReview(f.w,f.u,p.id,i.id,r.confirmation)).toMatchObject({kind:'resource',alreadyApplied:false})
    expect((await applyMigrationItem(f.w,f.u,p.id,i.id,r.confirmation)).status).toBe('applied')
    await setMigrationPlanState(f.w,f.u,p.id,'cancelled')
    expect((await applyMigrationItem(f.w,f.u,p.id,i.id,r.confirmation)).status).toBe('applied')
  })
  it('creates, prepares all principal helper paths, applies, gets, pauses and cancels without escaping the reserved session',async()=>{
    const f=await fixture(),revision=(await getWorkspaceAccess(f.w,f.u)).policyRevision
    const clearance=(await pool.query('SELECT clearance FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.w,f.m])).rows[0].clearance
    const p=await createMigrationPlan(f.w,f.u,{...f.input,items:[...f.input.items,
      {reason:'Member projection',command:{type:'member.access.set',userId:f.m,teamScopeMode:'assigned',clearance,expectedPolicyRevision:revision}},
      {reason:'Assistant projection',command:{type:'assistant.audience.set',assistantId:f.a,teamMode:'assigned',teamIds:[f.t],defaultGroupId:f.t,projectMode:'all',projectIds:[],defaultProjectId:null}},
    ]})
    expect((await listMigrationPlans(f.w,f.u)).map(p=>p.id)).toContain(p.id)
    const items=(await getMigrationPlan(f.w,f.u,p.id)).items
    let receipt:ReturnType<typeof proof>|undefined
    for(const i of items){
      const r=await prepareMigrationItem(f.w,f.u,p.id,i.id)
      receipt=proof(r.review)
      expect(await getMigrationItemReview(f.w,f.u,p.id,i.id,receipt)).toMatchObject({id:r.review.id})
      expect((await applyMigrationItem(f.w,f.u,p.id,i.id,receipt)).status).toBe('applied')
    }
    await setMigrationPlanState(f.w,f.u,p.id,'paused')
    expect((await getMigrationPlan(f.w,f.u,p.id)).status).toBe('paused')
    await setMigrationPlanState(f.w,f.u,p.id,'cancelled')
    expect((await applyMigrationItem(f.w,f.u,p.id,items.at(-1)!.id,receipt!)).status).toBe('applied')
    const pending=await createMigrationPlan(f.w,f.u,{...f.input,idempotencyKey:randomUUID()})
    const i=(await getMigrationPlan(f.w,f.u,pending.id)).items[0]
    const old=await prepareMigrationItem(f.w,f.u,pending.id,i.id)
    await setMigrationPlanState(f.w,f.u,pending.id,'paused')
    await expect(applyDepartmentCommand(f.w,f.u,proof(old.review))).rejects.toMatchObject({code:'access_conflict'})
    await setMigrationPlanState(f.w,f.u,pending.id,'proposed')
    const fresh=await prepareMigrationItem(f.w,f.u,pending.id,i.id)
    expect(fresh.review.id).not.toBe(old.review.id)
    await setMigrationPlanState(f.w,f.u,pending.id,'cancelled')
    await expect(prepareMigrationItem(f.w,f.u,pending.id,i.id)).rejects.toMatchObject({code:'migration_not_active'})
    expect(pool.waitingCount).toBe(0)
  },20000)
})
