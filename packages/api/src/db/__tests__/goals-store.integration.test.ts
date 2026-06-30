import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import {
  rollupGoals,
  rollupHost,
  instantiateGoalRecipe,
  type RollupDeps,
  type RollupGoalDeps,
  type DoneWhenResolvers,
} from '@sidanclaw/core'

/**
 * Integration test for the goals store + the task host adapter (rollup
 * end-to-end). Requires a local PostgreSQL `sidanclaw` with migration
 * `285_goals.sql` applied. Skips silently when the DB / table is unavailable.
 *
 * [COMP:goals/store] [COMP:goals/host-task]
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM goals LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'goals-' || gen_random_uuid()) RETURNING id`,
  )
  return r.rows[0].id
}
async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'goals-test-ws', 'test', $1, false) RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}
async function addMember(client: pg.PoolClient, workspaceId: string, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [workspaceId, userId],
  )
}

type GoalsMod = typeof import('../goals.js')
type TasksMod = typeof import('../tasks.js')
type HostMod = typeof import('../../goals/host-task.js')

describeIf('[COMP:goals/store] goals store (integration)', () => {
  let goals: GoalsMod
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    goals = await import('../goals.js')
  })

  let userId: string
  let workspaceId: string
  beforeEach(async () => {
    const c = await pool!.connect()
    try {
      userId = await makeUser(c)
      workspaceId = await makeWorkspace(c, userId)
      await addMember(c, workspaceId, userId)
    } finally {
      c.release()
    }
  })

  it('create + getByIdSystem round trip (host + done_when preserved)', async () => {
    const g = await goals.createGoal({
      workspaceId,
      outcome: 'ship the thing',
      doneWhen: { kind: 'subtasks' },
      host: { type: 'task', id: '00000000-0000-0000-0000-000000000001' },
      budget: { maxIterations: 10, deadline: '2026-12-31T00:00:00.000Z' },
      createdByUserId: userId,
    })
    expect(g.status).toBe('active')
    const got = await goals.getGoalByIdSystem(g.id)
    expect(got?.host).toEqual({ type: 'task', id: '00000000-0000-0000-0000-000000000001' })
    expect(got?.doneWhen).toEqual({ kind: 'subtasks' })
    expect(got?.budget).toEqual({ maxIterations: 10, deadline: '2026-12-31T00:00:00.000Z' })
  })

  it('a self-hosted goal stores a null host', async () => {
    const g = await goals.createGoal({ workspaceId, outcome: 'grow MRR', doneWhen: { kind: 'query', query: { predicate: { mrr_gte: 50000 } } }, createdByUserId: userId })
    const got = await goals.getGoalByIdSystem(g.id)
    expect(got?.host).toBeNull()
  })

  it('rejects a half-specified host (host_pairing CHECK)', async () => {
    await expect(
      pool!.query(
        `INSERT INTO goals (workspace_id, host_type, outcome, done_when) VALUES ($1, 'task', 'x', '{}'::jsonb)`,
        [workspaceId],
      ),
    ).rejects.toThrow(/goals_host_pairing_check/)
  })

  it('rejects a cross-workspace sub-goal (parent_workspace guard)', async () => {
    const parent = await goals.createGoal({ workspaceId, outcome: 'parent', doneWhen: { kind: 'subtasks' }, createdByUserId: userId })
    // a second workspace owned by the same user
    const c = await pool!.connect()
    let otherWs: string
    try {
      otherWs = await makeWorkspace(c, userId)
      await addMember(c, otherWs, userId)
    } finally {
      c.release()
    }
    await expect(
      goals.createGoal({ workspaceId: otherWs, outcome: 'child', doneWhen: { kind: 'subtasks' }, parentGoalId: parent.id, createdByUserId: userId }),
    ).rejects.toThrow(/same workspace/)
  })

  it('countOpenSubGoalsSystem counts non-terminal children', async () => {
    const parent = await goals.createGoal({ workspaceId, outcome: 'p', doneWhen: { kind: 'subtasks' }, createdByUserId: userId })
    const c1 = await goals.createGoal({ workspaceId, outcome: 'c1', doneWhen: { kind: 'subtasks' }, parentGoalId: parent.id, createdByUserId: userId })
    await goals.createGoal({ workspaceId, outcome: 'c2', doneWhen: { kind: 'subtasks' }, parentGoalId: parent.id, createdByUserId: userId })
    expect(await goals.countOpenSubGoalsSystem(parent.id)).toBe(2)
    await goals.setGoalStatusSystem(c1.id, 'done')
    expect(await goals.countOpenSubGoalsSystem(parent.id)).toBe(1)
  })

  it('setStatusSystem records a blocker reason', async () => {
    const g = await goals.createGoal({ workspaceId, outcome: 'x', doneWhen: { kind: 'subtasks' }, createdByUserId: userId })
    const updated = await goals.setGoalStatusSystem(g.id, 'blocked', 'max_iterations')
    expect(updated?.status).toBe('blocked')
    expect(updated?.blockerReason).toBe('max_iterations')
  })
})

describeIf('[COMP:goals/host-task] rollup end-to-end (goal on a task host)', () => {
  let goals: GoalsMod
  let tasks: TasksMod
  let host: HostMod
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    goals = await import('../goals.js')
    tasks = await import('../tasks.js')
    host = await import('../../goals/host-task.js')
  })

  it('a goal hosted on a task completes when its sub-tasks close, and closes the task', async () => {
    const c = await pool!.connect()
    let userId: string
    let workspaceId: string
    try {
      userId = await makeUser(c)
      workspaceId = await makeWorkspace(c, userId)
      await addMember(c, workspaceId, userId)
    } finally {
      c.release()
    }

    const parentTitle = `host-task-${Date.now()}-${Math.round(performance.now())}`
    const parent = await tasks.createTask(userId, { workspaceId, title: parentTitle })
    const sub1 = await tasks.createTask(userId, { workspaceId, title: 's1', parentId: parent.id })
    const sub2 = await tasks.createTask(userId, { workspaceId, title: 's2', parentId: parent.id })

    const goal = await goals.createGoal({
      workspaceId,
      outcome: 'finish the parent task',
      doneWhen: { kind: 'subtasks' },
      host: { type: 'task', id: parent.id },
      createdByUserId: userId,
    })

    const hostStore = host.createHostStore({ actorUserId: userId })
    const resolversFor = (g: { host: { type: string; id: string } | null }): DoneWhenResolvers => ({
      subtasksClosed: async () => {
        const a = hostStore.adapterFor(g.host!.type as 'task')
        return (await a.acceptanceSource(g.host as { type: 'task'; id: string })).subtasksClosed
      },
      query: async () => false,
      tool: async () => false,
    })
    const deps: RollupDeps = {
      goalsForHost: (h) => goals.listGoalsByHostSystem(h),
      resolversFor: (g) => resolversFor(g),
      complete: async (g) => {
        await goals.setGoalStatusSystem(g.id, 'done')
        const a = hostStore.adapterFor(g.host!.type as 'task')
        await a.setTerminal(g.host as { type: 'task'; id: string }, 'done', null)
      },
    }

    // 1. Sub-tasks still open -> rollup leaves the goal active.
    const r1 = await rollupHost({ type: 'task', id: parent.id }, deps)
    expect(r1).toEqual([{ goalId: goal.id, met: false }])
    expect((await goals.getGoalByIdSystem(goal.id))?.status).toBe('active')

    // 2. Close both sub-tasks.
    await tasks.updateTask(userId, sub1.id, { status: 'done' })
    await tasks.updateTask(userId, sub2.id, { status: 'done' })

    // 3. Rollup again -> done_when met -> goal done + host task closed.
    const r2 = await rollupHost({ type: 'task', id: parent.id }, deps)
    expect(r2).toEqual([{ goalId: goal.id, met: true }])
    expect((await goals.getGoalByIdSystem(goal.id))?.status).toBe('done')

    const activeParent = await pool!.query<{ status: string }>(
      `SELECT status FROM tasks WHERE valid_to IS NULL AND title = $1`,
      [parentTitle],
    )
    expect(activeParent.rows[0]?.status).toBe('done')
  })
})

describeIf('[COMP:goals/rollup] self-hosted goal over sub-goals (integration)', () => {
  let goals: GoalsMod
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    goals = await import('../goals.js')
  })

  it('a self-hosted goal completes when its sub-goals close', async () => {
    const c = await pool!.connect()
    let userId: string
    let workspaceId: string
    try {
      userId = await makeUser(c)
      workspaceId = await makeWorkspace(c, userId)
      await addMember(c, workspaceId, userId)
    } finally {
      c.release()
    }

    const parent = await goals.createGoal({ workspaceId, outcome: 'self-hosted objective', doneWhen: { kind: 'subtasks' }, createdByUserId: userId })
    const sub1 = await goals.createGoal({ workspaceId, outcome: 'sg1', doneWhen: { kind: 'subtasks' }, parentGoalId: parent.id, createdByUserId: userId })
    const sub2 = await goals.createGoal({ workspaceId, outcome: 'sg2', doneWhen: { kind: 'subtasks' }, parentGoalId: parent.id, createdByUserId: userId })

    // Self-hosted acceptance: `subtasks` resolves to "no open sub-goals".
    const selfDeps: RollupGoalDeps = {
      resolversFor: (g) => ({
        subtasksClosed: async () => (await goals.countOpenSubGoalsSystem(g.id)) === 0,
        query: async () => false,
        tool: async () => false,
      }),
      complete: async (g) => {
        await goals.setGoalStatusSystem(g.id, 'done')
      },
    }

    // Sub-goals open -> parent not met.
    expect(await rollupGoals([parent], selfDeps)).toEqual([{ goalId: parent.id, met: false }])

    await goals.setGoalStatusSystem(sub1.id, 'done')
    await goals.setGoalStatusSystem(sub2.id, 'done')

    // Re-fetch the (still active) parent and roll up -> met -> done.
    const parentNow = await goals.getGoalByIdSystem(parent.id)
    expect(await rollupGoals([parentNow!], selfDeps)).toEqual([{ goalId: parent.id, met: true }])
    expect((await goals.getGoalByIdSystem(parent.id))?.status).toBe('done')
  })
})

describeIf('[COMP:goals/recipe-store] recipe persistence + instantiation link (integration)', () => {
  let goals: GoalsMod
  let recipes: typeof import('../goal-recipes.js')
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    goals = await import('../goals.js')
    recipes = await import('../goal-recipes.js')
  })

  it('persists a recipe, then instantiates a goal whose recipe_id links back to it', async () => {
    const c = await pool!.connect()
    let userId: string
    let workspaceId: string
    try {
      userId = await makeUser(c)
      workspaceId = await makeWorkspace(c, userId)
      await addMember(c, workspaceId, userId)
    } finally {
      c.release()
    }

    const recipe = await recipes.createGoalRecipe({
      workspaceId,
      name: 'Close a deal',
      description: 'Drive a deal to closed-won.',
      outcome: 'Close the {{account}} deal',
      doneWhen: { kind: 'query', query: { predicate: { stage: 'closed-won', account: '{{account}}' } } },
      vars: [{ name: 'account', required: true }],
      createdByUserId: userId,
    })
    expect(await recipes.getGoalRecipeByIdSystem(recipe.id)).toMatchObject({ name: 'Close a deal' })

    // Instantiate (core) -> create the goal -> the FK link holds.
    const params = instantiateGoalRecipe(recipe, { workspaceId, vars: { account: 'Acme' }, createdByUserId: userId })
    const goal = await goals.createGoal(params)
    expect(goal.outcome).toBe('Close the Acme deal')
    expect(goal.recipeId).toBe(recipe.id)
    const got = await goals.getGoalByIdSystem(goal.id)
    expect(got?.recipeId).toBe(recipe.id) // recipe_id FK round-trips
    expect(got?.doneWhen).toEqual({ kind: 'query', query: { predicate: { stage: 'closed-won', account: 'Acme' } } })
  })
})

describeIf('[COMP:goals/host-readonly] goal on a non-task host (query-driven)', () => {
  let goals: GoalsMod
  let host: HostMod
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    goals = await import('../goals.js')
    host = await import('../../goals/host-task.js')
  })

  const NON_TASK_HOSTS = ['entity', 'page', 'workflow'] as const
  for (const hostType of NON_TASK_HOSTS) {
    it(`a goal on a ${hostType} host reaches done via a query predicate; the host is not mutated`, async () => {
      const c = await pool!.connect()
      let userId: string
      let workspaceId: string
      try {
        userId = await makeUser(c)
        workspaceId = await makeWorkspace(c, userId)
        await addMember(c, workspaceId, userId)
      } finally {
        c.release()
      }

      const hostId = '00000000-0000-0000-0000-0000000000aa'
      const goal = await goals.createGoal({
        workspaceId,
        outcome: `drive the ${hostType}`,
        doneWhen: { kind: 'query', query: { predicate: { ready: true } } },
        host: { type: hostType, id: hostId },
        createdByUserId: userId,
      })

      const hostStore = host.createHostStore({ actorUserId: userId })
      // A non-task host rejects a `subtasks` predicate (it has no sub-tasks).
      await expect(
        hostStore.adapterFor(hostType).acceptanceSource({ type: hostType, id: hostId }),
      ).rejects.toThrow(/not applicable/)

      const deps: RollupGoalDeps = {
        resolversFor: () => ({
          subtasksClosed: async () => {
            throw new Error('subtasksClosed must not be called for a query done_when')
          },
          query: async () => true, // the host's truth-condition holds
          tool: async () => false,
        }),
        complete: async (g) => {
          await goals.setGoalStatusSystem(g.id, 'done')
          await hostStore.adapterFor(g.host!.type).setTerminal(g.host!, 'done', null) // no-op for non-task
        },
      }
      expect(await rollupGoals([goal], deps)).toEqual([{ goalId: goal.id, met: true }])
      expect((await goals.getGoalByIdSystem(goal.id))?.status).toBe('done')
    })
  }
})

describeIf('[COMP:goals/rollup-runner] the task-close hook fires the structural rollup', () => {
  let tasks: TasksMod
  let tasksStore: typeof import('../tasks-store.js')
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    tasks = await import('../tasks.js')
    tasksStore = await import('../tasks-store.js')
  })

  it('fires onTaskTerminal with the parent host on a sub-task close, and not otherwise', async () => {
    const c = await pool!.connect()
    let userId: string
    let workspaceId: string
    try {
      userId = await makeUser(c)
      workspaceId = await makeWorkspace(c, userId)
      await addMember(c, workspaceId, userId)
    } finally {
      c.release()
    }

    const fired: Array<{ type: string; id: string }> = []
    const store = tasksStore.createDbTaskStore({ onTaskTerminal: (h) => fired.push(h) })

    // Two distinct children — each updated once from its live id, so the
    // bi-temporal supersession (every edit mints a new id) never bites the test.
    const parentTitle = `hook-${Date.now()}-${Math.round(performance.now())}`
    const parent = await tasks.createTask(userId, { workspaceId, title: parentTitle })
    const subA = await tasks.createTask(userId, { workspaceId, title: 'child-a', parentId: parent.id })
    const subB = await tasks.createTask(userId, { workspaceId, title: 'child-b', parentId: parent.id })

    // A non-terminal update of a child -> no rollup.
    await store.update(userId, subA.id, { status: 'in_progress' })
    expect(fired).toEqual([])

    // Closing a child (terminal) -> roll up the PARENT host.
    await store.update(userId, subB.id, { status: 'done' })
    expect(fired).toEqual([{ type: 'task', id: parent.id }])

    // Closing the parentless top task -> no parent -> no further rollup.
    await store.update(userId, parent.id, { status: 'done' })
    expect(fired).toEqual([{ type: 'task', id: parent.id }])
  })
})

describeIf('[COMP:goals/rollup-runner] the runner completes a met goal and delivers (no silent termination)', () => {
  let goals: GoalsMod
  let tasks: TasksMod
  let goalStoreMod: typeof import('../goals-store.js')
  let runnerMod: typeof import('../../goals/rollup-runner.js')
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    goals = await import('../goals.js')
    tasks = await import('../tasks.js')
    goalStoreMod = await import('../goals-store.js')
    runnerMod = await import('../../goals/rollup-runner.js')
  })

  it('rolls a task-hosted goal to done, closes the host task, and delivers exactly once', async () => {
    const c = await pool!.connect()
    let userId: string
    let workspaceId: string
    try {
      userId = await makeUser(c)
      workspaceId = await makeWorkspace(c, userId)
      await addMember(c, workspaceId, userId)
    } finally {
      c.release()
    }

    const title = `runner-${Date.now()}-${Math.round(performance.now())}`
    const parent = await tasks.createTask(userId, { workspaceId, title })
    const sub = await tasks.createTask(userId, { workspaceId, title: 'child', parentId: parent.id })
    const goal = await goals.createGoal({
      workspaceId,
      outcome: 'finish the parent task',
      doneWhen: { kind: 'subtasks' },
      host: { type: 'task', id: parent.id },
      createdByUserId: userId,
    })

    const delivered: string[] = []
    const runner = runnerMod.createGoalRollupRunner({
      goalStore: goalStoreMod.createDbGoalStore(),
      deliverGoalDone: async (g) => {
        delivered.push(g.id)
      },
    })

    // Sub-task still open -> rollup leaves the goal active, no delivery.
    expect(await runner.rollup({ type: 'task', id: parent.id })).toEqual([
      { goalId: goal.id, met: false },
    ])
    expect(delivered).toEqual([])

    // Close the sub-task, then roll up -> goal done + host closed + delivered.
    await tasks.updateTask(userId, sub.id, { status: 'done' })
    expect(await runner.rollup({ type: 'task', id: parent.id })).toEqual([
      { goalId: goal.id, met: true },
    ])
    expect((await goals.getGoalByIdSystem(goal.id))?.status).toBe('done')
    expect(delivered).toEqual([goal.id])

    const activeParent = await pool!.query<{ status: string }>(
      `SELECT status FROM tasks WHERE valid_to IS NULL AND title = $1`,
      [title],
    )
    expect(activeParent.rows[0]?.status).toBe('done')
  })
})

describeIf('[COMP:goals/auto-draft] task-autopilot auto-draft + done detection', () => {
  let goals: GoalsMod
  let tasks: TasksMod
  let tasksStore: typeof import('../tasks-store.js')
  let writeback: typeof import('../../goals/writeback.js')
  let goalStoreMod: typeof import('../goals-store.js')
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    goals = await import('../goals.js')
    tasks = await import('../tasks.js')
    tasksStore = await import('../tasks-store.js')
    writeback = await import('../../goals/writeback.js')
    goalStoreMod = await import('../goals-store.js')
  })

  it('drafts an unconfirmed goal for a TOP-LEVEL task only; hostTaskDone flips true once the task closes; confirm arms it', async () => {
    const c = await pool!.connect()
    let userId: string
    let workspaceId: string
    try {
      userId = await makeUser(c)
      workspaceId = await makeWorkspace(c, userId)
      await addMember(c, workspaceId, userId)
    } finally {
      c.release()
    }

    // Wire the auto-draft hook exactly as boot does.
    const store = tasksStore.createDbTaskStore({
      onTaskCreate: (task, uid) => {
        void goals.createGoal({
          workspaceId: task.workspaceId,
          host: { type: 'task', id: task.id },
          outcome: `Complete: ${task.title}`,
          doneWhen: { kind: 'query', query: { predicate: { hostTaskDone: true } } },
          confirmed: false,
          createdByUserId: uid,
        })
      },
    })

    const title = `autopilot-${Date.now()}-${Math.round(performance.now())}`
    const top = await store.create({ userId, workspaceId, title })
    const sub = await store.create({ userId, workspaceId, title: 'child', parentId: top.id })
    await new Promise((r) => setTimeout(r, 100)) // let the fire-and-forget drafts settle

    // Top-level → exactly one DRAFT goal; a sub-task → none.
    const hostGoals = await goals.listGoalsByHostSystem({ type: 'task', id: top.id })
    expect(hostGoals).toHaveLength(1)
    const goal = hostGoals[0]
    expect(goal.confirmedAt).toBeNull()
    expect(goal.host).toEqual({ type: 'task', id: top.id })
    expect(await goals.listGoalsByHostSystem({ type: 'task', id: sub.id })).toHaveLength(0)

    // done_when (hostTaskDone): false while open, true once the task closes —
    // the resolver follows the supersession chain, so the close's new id is found.
    const resolvers = writeback.buildGoalResolvers(goal, goalStoreMod.createDbGoalStore())
    expect(await resolvers.query({ predicate: { hostTaskDone: true } })).toBe(false)
    await tasks.updateTask(userId, top.id, { status: 'done' })
    expect(await resolvers.query({ predicate: { hostTaskDone: true } })).toBe(true)

    // Enforcement: a workflow that tried to work an unconfirmed goal blocks it
    // for clarification; confirming un-blocks it so it can be spun up.
    await goals.setGoalStatusSystem(goal.id, 'blocked', 'unconfirmed_needs_clarification')
    const confirmed = await goals.updateGoalSystem(goal.id, { confirm: true })
    expect(confirmed?.confirmedAt).not.toBeNull()
    expect(confirmed?.status).toBe('active') // un-blocked → ready to spin up
  })

  it('an edit to a hosted task repoints its goal so host_id tracks the live id', async () => {
    const c = await pool!.connect()
    let userId: string
    let workspaceId: string
    try {
      userId = await makeUser(c)
      workspaceId = await makeWorkspace(c, userId)
      await addMember(c, workspaceId, userId)
    } finally {
      c.release()
    }

    // Draft a goal on a top-level task, as boot's auto-draft does.
    const title = `repoint-${Date.now()}-${Math.round(performance.now())}`
    const top = await tasks.createTask(userId, { workspaceId, title })
    const goal = await goals.createGoal({
      workspaceId,
      host: { type: 'task', id: top.id },
      outcome: `Complete: ${title}`,
      doneWhen: { kind: 'query', query: { predicate: { hostTaskDone: true } } },
      confirmed: false,
      createdByUserId: userId,
    })

    // Editing the task supersedes it (a new bi-temporal id). The goal must
    // follow, so a lookup by the NEW id finds it and the OLD id doesn't —
    // otherwise the Brain panel's goal affordance would vanish on any edit.
    const edited = await tasks.updateTask(userId, top.id, { title: `${title}-v2` })
    expect(edited!.id).not.toBe(top.id)
    const byNew = await goals.listGoalsByHostSystem({ type: 'task', id: edited!.id })
    expect(byNew).toHaveLength(1)
    expect(byNew[0].id).toBe(goal.id) // same goal row, repointed
    expect(await goals.listGoalsByHostSystem({ type: 'task', id: top.id })).toHaveLength(0)
  })
})

describeIf('[COMP:goals/verifier] verify-termination wiring (integration)', () => {
  let goals: GoalsMod
  let writeback: typeof import('../../goals/writeback.js')
  let goalStoreMod: typeof import('../goals-store.js')
  let core: typeof import('@sidanclaw/core')
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    goals = await import('../goals.js')
    writeback = await import('../../goals/writeback.js')
    goalStoreMod = await import('../goals-store.js')
    core = await import('@sidanclaw/core')
  })

  it('a {kind:verify} goal: round-trips the store; verifiedDone flips false→true only once the marker is stamped, and the evaluator follows', async () => {
    const c = await pool!.connect()
    let userId: string
    let workspaceId: string
    try {
      userId = await makeUser(c)
      workspaceId = await makeWorkspace(c, userId)
      await addMember(c, workspaceId, userId)
    } finally {
      c.release()
    }

    const goal = await goals.createGoal({
      workspaceId,
      outcome: 'Draft and send the launch announcement',
      doneWhen: { kind: 'verify' },
      createdByUserId: userId,
    })

    // done_when + the (null) marker round-trip the store.
    const got = await goals.getGoalByIdSystem(goal.id)
    expect(got?.doneWhen).toEqual({ kind: 'verify' })
    expect(got?.completionClaim).toBeNull()

    const store = goalStoreMod.createDbGoalStore()
    const resolvers = writeback.buildGoalResolvers(got!, store)

    // Not stamped -> verifiedDone false -> evaluator NOT met (the §12 fail-safe:
    // a verify goal never completes on an unverified claim).
    expect(await resolvers.verifiedDone!()).toBe(false)
    expect((await core.evaluateDoneWhen({ kind: 'verify' }, resolvers)).met).toBe(false)

    // The completion tool stamps the marker ONLY after a verifier pass.
    const stamped = await goals.stampGoalCompletionSystem(
      goal.id,
      'Posted the announcement to the blog and emailed the list',
    )
    expect(stamped?.completionClaim?.because).toContain('announcement')

    // Now verifiedDone re-reads fresh -> true -> evaluator met -> the driver
    // would finish + deliver the goal.
    expect(await resolvers.verifiedDone!()).toBe(true)
    expect((await core.evaluateDoneWhen({ kind: 'verify' }, resolvers)).met).toBe(true)
  })
})
