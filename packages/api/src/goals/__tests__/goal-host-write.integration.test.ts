import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it,vi } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import * as taskWrites from '../../db/tasks.js'
import * as notifications from '../../brain-stream/notify.js'
import { createTask, updateTask } from '../../db/tasks.js'
import { createGoal, claimGoalRollupTerminalSystem,finishNativeTaskGoalTerminalSystem,tryClaimGoalForTick,getGoalByIdSystem } from '../../db/goals.js'
import { createDbGoalStore } from '../../db/goals-store.js'
import { captureAuthoringAuthoritySystem,resolveGoalAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { createTaskHostAdapter } from '../host-task.js'
import { buildGoalResolvers,finishGoal } from '../writeback.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

afterAll(async () => { await getAppPool().end(); await pool.end() })

async function fixture() {
  const workspaceId = randomUUID(), ownerId = randomUUID(), userId = randomUUID(), assistantId = randomUUID()
  for (const id of [ownerId, userId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic Goal host workspace',$2,false)", [workspaceId, ownerId])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'product','Product')", [workspaceId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',ARRAY['product'])", [workspaceId, ownerId, userId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments) VALUES($1,'Synthetic Goal host assistant',$2,$3,'primary','confidential',NULL)", [assistantId, ownerId, workspaceId])
  const task = await createTask(userId, { workspaceId, title:'Synthetic Goal host', sensitivity:'internal', compartments:['product'] })
  const authority = await captureAuthoringAuthoritySystem({ workspaceId, userId, assistantId })
  const goal = await createGoal({ workspaceId, createdByUserId:userId, authoringAuthority:authority, host:{type:'task',id:task.id}, outcome:'Finish the synthetic task', doneWhen:{kind:'subtasks'} })
  const role = (await queryWithRLS(userId, `SELECT
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass,
    (SELECT relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) FROM pg_class WHERE oid='tasks'::regclass) AS owns_tasks,
    row_security_active('tasks'::regclass) AS rls`)).rows[0]
  expect(role).toMatchObject({ superuser:false, bypass:false, owns_tasks:false, rls:true })
  const live = async () => (await pool.query('SELECT id,status FROM tasks WHERE logical_id=$1 AND valid_to IS NULL', [task.logicalId])).rows[0]
  return { workspaceId, userId, task, goal, live, adapter:createTaskHostAdapter({actorUserId:userId}) }
}

describe('[COMP:goals/host-task] real terminal write outcomes', () => {
  it('atomically finishes a real authored hostTaskDone Goal after its canonical Task close',async()=>{
    const f=await fixture(),store=createDbGoalStore()
    const goal=await createGoal({workspaceId:f.workspaceId,createdByUserId:f.userId,authoringAuthority:f.goal.authoringAuthority!,
      host:{type:'task',id:f.task.id},outcome:'Finish the fictional native task',doneWhen:{kind:'query',query:{predicate:{hostTaskDone:true}}}})
    expect(await tryClaimGoalForTick(goal.id)).toBe(true)
    const original=await resolveGoalAuthoritySystem(goal),delivered:string[]=[]
    await original.executeWithAuthority(async()=>{
      expect(await buildGoalResolvers(goal,store).query({predicate:{hostTaskDone:true}})).toBe(false)
      const closed=await updateTask(f.userId,f.task.id,{status:'done'})
      expect(closed?.id).not.toBe(f.task.id)
      expect(await buildGoalResolvers(goal,store).query({predicate:{hostTaskDone:true}})).toBe(true)
      await finishGoal(goal,'done',null,{goalStore:store,finishTerminal:finishNativeTaskGoalTerminalSystem,expectedStatus:'running',
        deliver:async committed=>{
          expect((await getGoalByIdSystem(committed.id))?.status).toBe('done')
          expect(committed.host?.id).toBe((await f.live()).id)
          delivered.push(committed.id)
        }})
    })
    expect(delivered).toEqual([goal.id]);expect((await f.live()).status).toBe('done')
  })

  it('refuses canonical writes after an independently committed awaited member contraction',async()=>{
    const f=await fixture(),original=await resolveGoalAuthoritySystem(f.goal),changed=vi.spyOn(notifications,'notifyWorkspaceChange')
    let deliveries=0,removed=false
    try{
      // The original lease is already pinned. Independent deletion commits
      // before the terminal transaction, so writer locks cannot mask setup.
      await Promise.resolve()
      await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
      removed=(await pool.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])).rows.length===0
      expect(removed).toBe(true)
      await expect(original.executeWithAuthority(()=>finishGoal(f.goal,'done',null,{goalStore:createDbGoalStore(),finishTerminal:finishNativeTaskGoalTerminalSystem,
        deliver:async()=>{deliveries++}}))).rejects.toThrow()
      expect(removed).toBe(true)
      expect((await pool.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])).rows).toHaveLength(0)
      expect((await getGoalByIdSystem(f.goal.id))?.status).toBe('active')
      expect(await f.live()).toEqual({id:f.task.id,status:'todo'})
      expect((await pool.query('SELECT count(*)::int AS n FROM tasks WHERE logical_id=$1',[f.task.logicalId])).rows[0].n).toBe(1)
      expect(deliveries).toBe(0);expect(changed).not.toHaveBeenCalled()
    }finally{changed.mockRestore()}
  })

  it('rolls back real canonical SQL after a database fault and serializes a later member contraction',async()=>{
    const f=await fixture(),persist=taskWrites.updateTask,changed=vi.spyOn(notifications,'notifyWorkspaceChange')
    const closed=vi.fn();taskWrites.bindTaskClosedHook(closed)
    let removal:Promise<unknown>|undefined,blocked=false,databaseFault=false
    const close=vi.spyOn(taskWrites,'updateTask').mockImplementationOnce(async(...args)=>{
      const written=await persist(...args)
      expect(written?.status).toBe('done')
      const writer=args[5]!.client,deleting=await pool.connect()
      const writerPid=(await writer.query('SELECT pg_backend_pid() AS id')).rows[0].id
      const deletingPid=(await deleting.query('SELECT pg_backend_pid() AS id')).rows[0].id
      removal=deleting.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId]).finally(()=>deleting.release())
      for(let attempt=0;attempt<20&&!blocked;attempt++){
        blocked=(await pool.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[deletingPid,writerPid])).rows[0].blocked
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(blocked).toBe(true)
      // A real PostgreSQL fault aborts the borrowed transaction after the
      // canonical successor was written. Its rollback releases the member.
      try{await writer.query('SELECT 1/0')}catch(error){databaseFault=(error as {code?:string}).code==='22012';throw error}
      throw new Error('The database fault did not occur')
    })
    let deliveries=0
    try{
      await expect(finishGoal(f.goal,'done',null,{goalStore:createDbGoalStore(),finishTerminal:finishNativeTaskGoalTerminalSystem,
        deliver:async()=>{deliveries++}})).rejects.toThrow()
      await removal
      expect(blocked).toBe(true);expect(databaseFault).toBe(true)
      expect((await pool.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])).rows).toHaveLength(0)
      expect((await getGoalByIdSystem(f.goal.id))?.status).toBe('active')
      expect(await f.live()).toEqual({id:f.task.id,status:'todo'})
      expect((await pool.query('SELECT count(*)::int AS n FROM tasks WHERE logical_id=$1',[f.task.logicalId])).rows[0].n).toBe(1)
      expect(deliveries).toBe(0);expect(changed).not.toHaveBeenCalled();expect(closed).not.toHaveBeenCalled()
    }finally{close.mockRestore();changed.mockRestore();taskWrites.bindTaskClosedHook(null);await removal}
  })

  it('preserves canonical forward resolution for an authorized superseded host', async () => {
    const f = await fixture()
    const edited = await updateTask(f.userId, f.task.id, {title:'Synthetic edited host'})
    expect(edited?.id).not.toBe(f.task.id)
    await f.adapter.setTerminal({type:'task',id:f.task.id}, 'done', null)
    const live = await f.live()
    expect(live.status).toBe('done')
    expect(live.id).not.toBe(edited?.id)
  })

  it('reports a typed refusal when the original member can no longer write the host', async () => {
    const f = await fixture()
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])
    expect((await queryWithRLS(f.userId, 'SELECT id FROM tasks WHERE id=$1', [f.task.id])).rows).toHaveLength(0)
    await expect(f.adapter.setTerminal({type:'task',id:f.task.id}, 'done', null))
      .rejects.toMatchObject({reason:'goal_host_write_unavailable'})
    expect(await f.live()).toEqual({id:f.task.id,status:'todo'})
  })

  it('reports a typed refusal after the host read floor contracts', async () => {
    const f = await fixture()
    await pool.query("UPDATE workspace_members SET compartments=ARRAY[]::text[] WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.userId])
    expect((await queryWithRLS(f.userId, 'SELECT id FROM tasks WHERE id=$1', [f.task.id])).rows).toHaveLength(0)
    await expect(f.adapter.setTerminal({type:'task',id:f.task.id}, 'blocked', null))
      .rejects.toMatchObject({reason:'goal_host_write_unavailable'})
    expect(await f.live()).toEqual({id:f.task.id,status:'todo'})
  })

  it('stops terminal delivery if host access disappears after the Goal claim', async () => {
    const f = await fixture()
    let deliveries = 0
    await expect(finishGoal(f.goal, 'done', null, {
      goalStore:createDbGoalStore(),
      claimTerminal:async () => {
        const claimed = await claimGoalRollupTerminalSystem(f.goal)
        await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])
        return claimed
      },
      deliver:async () => { deliveries++ },
    })).rejects.toMatchObject({reason:'goal_host_write_unavailable'})
    expect(deliveries).toBe(0)
    expect(await f.live()).toEqual({id:f.task.id,status:'todo'})
  })
})
