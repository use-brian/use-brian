import { randomUUID } from 'node:crypto'
import { afterAll,describe,expect,it } from 'vitest'
import { getAppPool,getPool,queryWithRLS } from '../../db/client.js'
import { createGoal,getGoalByIdSystem,setGoalStatusSystem,updateGoalSystem,claimGoalRollupTerminalSystem,tryClaimGoalForTick } from '../../db/goals.js'
import { createDbGoalStore } from '../../db/goals-store.js'
import { createTask } from '../../db/tasks.js'
import { captureAuthoringAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { createGoalRollupRunner } from '../rollup-runner.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture() {
  const workspaceId = randomUUID(), ownerId = randomUUID(), userId = randomUUID(), assistantId = randomUUID()
  for (const id of [ownerId, userId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic rollup workspace',$2,false)", [workspaceId,ownerId])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'product','Product')", [workspaceId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',ARRAY['product'])", [workspaceId,ownerId,userId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments) VALUES($1,'Synthetic rollup assistant',$2,$3,'primary','confidential',NULL)", [assistantId,ownerId,workspaceId])
  const authority = await captureAuthoringAuthoritySystem({ workspaceId,userId,assistantId })
  const task = await createTask(userId,{ workspaceId,title:'Synthetic rollup host',sensitivity:'internal',compartments:['product'] })
  const goal = await createGoal({ workspaceId,createdByUserId:userId,authoringAuthority:authority,outcome:'Synthetic rollup completion',host:{type:'task',id:task.id},doneWhen:{kind:'subtasks'} })
  const store = createDbGoalStore()
  let deliveries = 0
  const runner = createGoalRollupRunner({ goalStore:store,claimTerminal:claimGoalRollupTerminalSystem,deliverGoalDone:async () => { deliveries++ } })
  const readableTask = async () => (await queryWithRLS(userId,'SELECT id FROM tasks WHERE id=$1', [task.id])).rows.length
  const role = (await queryWithRLS(userId,`SELECT
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass,
    (SELECT relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) FROM pg_class WHERE oid='tasks'::regclass) AS owns_tasks,
    row_security_active('tasks'::regclass) AS rls`)).rows[0]
  expect(role).toMatchObject({superuser:false,bypass:false,owns_tasks:false,rls:true})
  expect(await readableTask()).toBe(1)
  return { workspaceId,ownerId,userId,assistantId,goal,task,store,runner,readableTask,deliveries:()=>deliveries }
}


describe('[COMP:goals/rollup-runner] structural terminal ownership (real RLS)', () => {
  afterAll(async()=>{await getAppPool().end();await pool.end()})

  it('preserves an unchanged authorized close and does not deliver it twice',async()=>{
    const f=await fixture()
    await f.runner.rollup({type:'task',id:f.task.id})
    expect((await getGoalByIdSystem(f.goal.id))?.status).toBe('done')
    expect(f.deliveries()).toBe(1)
    await f.runner.rollup({type:'task',id:f.task.id})
    expect(f.deliveries()).toBe(1)
    const host=(await pool.query('SELECT status FROM tasks WHERE logical_id=$1 AND valid_to IS NULL',[f.task.logicalId])).rows[0]
    expect(host.status).toBe('done')
  })

  it('keeps a cancellation made during the actual host lookup and performs no terminal effects',async()=>{
    const f=await fixture(),lookup=f.store.listByHostSystem
    f.store.listByHostSystem=async(host)=>{
      const goals=await lookup(host)
      await setGoalStatusSystem(f.goal.id,'abandoned')
      return goals
    }
    await f.runner.rollup({type:'task',id:f.task.id})
    expect((await getGoalByIdSystem(f.goal.id))?.status).toBe('abandoned')
    expect(f.deliveries()).toBe(0)
    expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.task.id])).rows[0].status).toBe('todo')
  })

  it('does not finish under acceptance changed during the lookup',async()=>{
    const f=await fixture(),lookup=f.store.listByHostSystem
    f.store.listByHostSystem=async(host)=>{
      const goals=await lookup(host)
      await updateGoalSystem(f.goal.id,{doneWhen:{kind:'query',query:{predicate:{hostTaskDone:true}}}})
      return goals
    }
    await f.runner.rollup({type:'task',id:f.task.id})
    expect((await getGoalByIdSystem(f.goal.id))?.status).toBe('active')
    expect(f.deliveries()).toBe(0)
    expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.task.id])).rows[0].status).toBe('todo')
  })

  it('allows only one concurrent terminal claim of the same evaluated configuration',async()=>{
    const f=await fixture()
    const claimed=await Promise.all([claimGoalRollupTerminalSystem(f.goal),claimGoalRollupTerminalSystem(f.goal)])
    expect(claimed.filter(Boolean).length).toBe(1)
    expect((await getGoalByIdSystem(f.goal.id))?.status).toBe('done')
  })

  it('does not take terminal ownership from an acting worker that claimed during lookup',async()=>{
    const f=await fixture(),lookup=f.store.listByHostSystem
    let claimed=false
    f.store.listByHostSystem=async(host)=>{
      const goals=await lookup(host)
      claimed=await tryClaimGoalForTick(f.goal.id)
      return goals
    }
    await f.runner.rollup({type:'task',id:f.task.id})
    expect(claimed).toBe(true)
    expect((await getGoalByIdSystem(f.goal.id))?.status).toBe('running')
    expect(f.deliveries()).toBe(0)
    expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.task.id])).rows[0].status).toBe('todo')
  })

})
