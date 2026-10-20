import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { createTask, updateTask } from '../../db/tasks.js'
import { createGoal, claimGoalRollupTerminalSystem } from '../../db/goals.js'
import { createDbGoalStore } from '../../db/goals-store.js'
import { captureAuthoringAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { createTaskHostAdapter } from '../host-task.js'
import { finishGoal } from '../writeback.js'

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
