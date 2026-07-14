import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import type { GoalRecord, GoalStore } from '@sidanclaw/core'

/**
 * Integration tests for the goal stall reaper's SQL sweeps and the
 * `entityCount` done_when predicate. Requires a local PostgreSQL `sidanclaw`
 * with the goals migrations applied. Skips silently when unavailable.
 *
 * [COMP:goals/reaper] [COMP:goals/entity-count]
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

const createdWorkspaces: string[] = []
const createdUsers: string[] = []

afterAll(async () => {
  if (pool) {
    const client = await pool.connect()
    try {
      for (const ws of createdWorkspaces) await client.query('DELETE FROM workspaces WHERE id = $1', [ws])
      for (const u of createdUsers) await client.query('DELETE FROM users WHERE id = $1', [u])
    } finally {
      client.release()
    }
    await pool.end()
  }
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'reaper-' || gen_random_uuid()) RETURNING id`,
  )
  createdUsers.push(r.rows[0].id)
  return r.rows[0].id
}
async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'reaper-test-ws', 'test', $1, false) RETURNING id`,
    [ownerId],
  )
  createdWorkspaces.push(r.rows[0].id)
  return r.rows[0].id
}
async function makeAssistant(client: pg.PoolClient, workspaceId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, workspace_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
    [workspaceId],
  )
  return r.rows[0].id
}

async function insertGoal(
  client: pg.PoolClient,
  opts: {
    workspaceId: string
    userId: string
    status: string
    confirmed?: boolean
    means?: Record<string, unknown>
    staleMinutes?: number
  },
): Promise<string> {
  const r = await client.query(
    `INSERT INTO goals (workspace_id, outcome, done_when, means, status, created_by_user_id, confirmed_at)
     VALUES ($1, 'reaper test goal', '{"kind":"subtasks"}'::jsonb, $2::jsonb, $3, $4, $5)
     RETURNING id`,
    [
      opts.workspaceId,
      JSON.stringify(opts.means ?? { workflowId: '00000000-0000-0000-0000-000000000001' }),
      opts.status,
      opts.userId,
      opts.confirmed === false ? null : new Date(),
    ],
  )
  const id = r.rows[0].id
  if (opts.staleMinutes) {
    // The BEFORE UPDATE trigger unconditionally bumps updated_at; disable
    // triggers for THIS session only to backdate the row.
    await client.query(`SET session_replication_role = replica`)
    await client.query(`UPDATE goals SET updated_at = now() - make_interval(mins => $1) WHERE id = $2`, [
      opts.staleMinutes,
      id,
    ])
    await client.query(`SET session_replication_role = DEFAULT`)
  }
  return id
}

async function insertTickJob(
  client: pg.PoolClient,
  opts: { goalId: string; assistantId: string; userId: string; enabled?: boolean },
): Promise<void> {
  await client.query(
    `INSERT INTO scheduled_jobs (assistant_id, user_id, instructions, channel_type, channel_id, enabled, schedule, timezone, mode, next_run_at)
     VALUES ($1, $2, $3, 'workflow', $4, $5, '{"type":"once","datetime":"2027-01-01T00:00:00"}'::jsonb, 'UTC', 'local', now() + interval '1 hour')`,
    [
      opts.assistantId,
      opts.userId,
      JSON.stringify({ kind: 'goal_tick', goalId: opts.goalId, state: { iteration: 0, spend: 0, noProgressStreak: 0, runId: null } }),
      opts.goalId,
      opts.enabled ?? true,
    ],
  )
}

describeIf('[COMP:goals/reaper] goal stall reaper (integration)', () => {
  let reaper: typeof import('../../goals/reaper.js')
  let client: pg.PoolClient
  let userId: string
  let workspaceId: string
  let assistantId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    reaper = await import('../../goals/reaper.js')
    client = await pool!.connect()
    userId = await makeUser(client)
    workspaceId = await makeWorkspace(client, userId)
    assistantId = await makeAssistant(client, workspaceId)
  })
  afterAll(() => client?.release())

  async function status(goalId: string): Promise<string> {
    const r = await client.query(`SELECT status FROM goals WHERE id = $1`, [goalId])
    return r.rows[0]?.status
  }

  it('recovers a wedged running goal (stale, no enabled tick job): flips to active and re-arms', async () => {
    const wedged = await insertGoal(client, { workspaceId, userId, status: 'running', staleMinutes: 20 })
    const rearmed: string[] = []
    const r = reaper.createGoalStallReaper({ rearm: async (id) => void rearmed.push(id) })
    const recovered = await r.sweepOnce()

    expect(recovered.some((g) => g.id === wedged && g.sweep === 'running_wedge')).toBe(true)
    expect(rearmed).toContain(wedged)
    expect(await status(wedged)).toBe('active')

    // The flip bumped updated_at, so an immediate second sweep leaves it alone
    // (the recovery tick's enabled job would guard it in production; here the
    // freshness alone suffices).
    const again = await r.sweepOnce()
    expect(again.some((g) => g.id === wedged)).toBe(false)
  })

  it('leaves a running goal alone while its tick job is still enabled (an executing iteration) or it is fresh', async () => {
    const executing = await insertGoal(client, { workspaceId, userId, status: 'running', staleMinutes: 20 })
    await insertTickJob(client, { goalId: executing, assistantId, userId, enabled: true })
    const fresh = await insertGoal(client, { workspaceId, userId, status: 'running' })

    const rearmed: string[] = []
    const r = reaper.createGoalStallReaper({ rearm: async (id) => void rearmed.push(id) })
    await r.sweepOnce()

    expect(rearmed).not.toContain(executing)
    expect(rearmed).not.toContain(fresh)
    expect(await status(executing)).toBe('running')
    expect(await status(fresh)).toBe('running')
  })

  it('re-arms a confirmed acting goal whose chain died (active, stale, no job) and skips drafts / monitors / alive chains', async () => {
    const dead = await insertGoal(client, { workspaceId, userId, status: 'active', staleMinutes: 20 })
    const draft = await insertGoal(client, { workspaceId, userId, status: 'active', confirmed: false, staleMinutes: 20 })
    const monitor = await insertGoal(client, { workspaceId, userId, status: 'active', means: {}, staleMinutes: 20 })
    const alive = await insertGoal(client, { workspaceId, userId, status: 'active', staleMinutes: 20 })
    await insertTickJob(client, { goalId: alive, assistantId, userId, enabled: true })
    const consumed = await insertGoal(client, { workspaceId, userId, status: 'active', staleMinutes: 20 })
    await insertTickJob(client, { goalId: consumed, assistantId, userId, enabled: false })

    const rearmed: string[] = []
    const r = reaper.createGoalStallReaper({ rearm: async (id) => void rearmed.push(id) })
    const recovered = await r.sweepOnce()

    expect(rearmed).toContain(dead)
    expect(recovered.find((g) => g.id === dead)?.sweep).toBe('dead_chain')
    // A disabled (fired/failed) job row is NOT an alive chain — recovered too.
    expect(rearmed).toContain(consumed)
    expect(rearmed).not.toContain(draft) // unconfirmed drafts never act
    expect(rearmed).not.toContain(monitor) // no-means monitors are the rollup's
    expect(rearmed).not.toContain(alive) // enabled future tick → chain is alive
  })
})

describeIf('[COMP:goals/entity-count] entityCount done_when predicate (integration)', () => {
  let writeback: typeof import('../../goals/writeback.js')
  let client: pg.PoolClient
  let userId: string
  let workspaceId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    writeback = await import('../../goals/writeback.js')
    client = await pool!.connect()
    userId = await makeUser(client)
    workspaceId = await makeWorkspace(client, userId)

    const insert = (attrs: Record<string, string>, state: 'live' | 'retracted' | 'superseded' = 'live') =>
      client.query(
        `INSERT INTO entities (kind, display_name, workspace_id, user_id, created_by_user_id, source, attributes, retracted_at, valid_to)
         VALUES ('company', 'co-' || gen_random_uuid(), $1, $2, $2, 'test', $3::jsonb,
                 CASE WHEN $4 = 'retracted' THEN now() END,
                 CASE WHEN $4 = 'superseded' THEN now() END)`,
        [workspaceId, userId, JSON.stringify(attrs), state],
      )
    await insert({ prospect: 'true' })
    await insert({ prospect: 'true' })
    await insert({}) // live company, not a prospect
    await insert({ prospect: 'true' }, 'retracted') // retracted → excluded
    await insert({ prospect: 'true' }, 'superseded') // superseded → excluded
  })
  afterAll(() => client?.release())

  function goalIn(ws: string): GoalRecord {
    return { id: 'g-ec', workspaceId: ws, host: null } as unknown as GoalRecord
  }
  const stubStore = {} as GoalStore

  async function evalCount(predicate: Record<string, unknown>, ws = workspaceId): Promise<boolean> {
    const resolvers = writeback.buildGoalResolvers(goalIn(ws), stubStore)
    return resolvers.query({ predicate } as never)
  }

  it('meets when at least `min` live matching entities exist (attribute-filtered)', async () => {
    expect(await evalCount({ entityCount: { kind: 'company', min: 2, attributeEquals: { key: 'prospect', value: 'true' } } })).toBe(true)
  })

  it('excludes retracted and superseded rows from the count', async () => {
    // 2 live prospects — the retracted + superseded ones must not make it 4.
    expect(await evalCount({ entityCount: { kind: 'company', min: 3, attributeEquals: { key: 'prospect', value: 'true' } } })).toBe(false)
  })

  it('counts by kind alone when no attribute filter is given', async () => {
    expect(await evalCount({ entityCount: { kind: 'company', min: 3 } })).toBe(true) // 3 live companies
    expect(await evalCount({ entityCount: { kind: 'person', min: 1 } })).toBe(false)
  })

  it('is workspace-scoped', async () => {
    const otherWs = await makeWorkspace(client, userId)
    expect(await evalCount({ entityCount: { kind: 'company', min: 1 } }, otherWs)).toBe(false)
  })

  it('resolves malformed payloads to not-confirmed, never a throw', async () => {
    expect(await evalCount({ entityCount: { kind: 'company' } })).toBe(false) // no min
    expect(await evalCount({ entityCount: { min: 2 } })).toBe(false) // no kind
    expect(await evalCount({ entityCount: { kind: 'company', min: 0 } })).toBe(false) // min < 1
    expect(await evalCount({ entityCount: 'nonsense' })).toBe(false)
  })
})

describeIf('[COMP:goals/entity-count] discovery-until-N scenario (the fls flow, E2E over the real loop + DB)', () => {
  let writeback: typeof import('../../goals/writeback.js')
  let driverMod: typeof import('../../goals/driver.js')
  let goalsDb: typeof import('../goals.js')
  let client: pg.PoolClient
  let userId: string
  let workspaceId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    writeback = await import('../../goals/writeback.js')
    driverMod = await import('../../goals/driver.js')
    goalsDb = await import('../goals.js')
    client = await pool!.connect()
    userId = await makeUser(client)
    workspaceId = await makeWorkspace(client, userId)
  })
  afterAll(() => client?.release())

  it('runs discovery 5-at-a-time until 20 prospects exist, then self-terminates done and delivers', async () => {
    // The goal: "run discovery until 20 prospects are identified", done_when
    // engine-verified over saved prospect entities — nothing model-judged.
    const created = await goalsDb.createGoal({
      workspaceId,
      outcome: 'Identify 20 prospects for outreach',
      doneWhen: {
        kind: 'query',
        query: { description: '20 prospects saved', predicate: { entityCount: { kind: 'company', min: 20, attributeEquals: { key: 'prospect', value: 'true' } } } },
      } as never,
      means: { workflowId: '00000000-0000-0000-0000-00000000000f' },
      createdByUserId: userId,
      confirmed: true,
    })

    // Each "workflow run" saves 5 prospect companies — the 5-at-a-time search.
    let runs = 0
    const saveFiveProspects = async () => {
      runs++
      for (let i = 0; i < 5; i++) {
        await client.query(
          `INSERT INTO entities (kind, display_name, workspace_id, user_id, created_by_user_id, source, attributes)
           VALUES ('company', 'prospect-' || gen_random_uuid(), $1, $2, $2, 'test', '{"prospect":"true"}'::jsonb)`,
          [workspaceId, userId],
        )
      }
      return { runId: `run-${runs}`, terminal: true, completed: true }
    }

    // The real driver over the real store/resolvers; the re-arm chain is driven
    // inline (each scheduled tick fires immediately) so the test IS the loop.
    const delivered: string[] = []
    const chain: Array<{ goalId: string; state: import('../../goals/driver.js').GoalLoopState }> = []
    const driver = driverMod.createGoalDriver({
      goalStore: {
        getByIdSystem: (id: string) => goalsDb.getGoalByIdSystem(id),
        setStatusSystem: (id: string, s: never, r?: never) => goalsDb.setGoalStatusSystem(id, s, r),
        countOpenSubGoalsSystem: (id: string) => goalsDb.countOpenSubGoalsSystem(id),
      } as never,
      tryClaim: (id) => goalsDb.tryClaimGoalForTick(id),
      sessionCostUsd: async () => 0.05,
      meteringAvailable: () => true,
      dispatchRun: saveFiveProspects,
      deliver: async (_g, terminal) => void delivered.push(terminal),
      scheduleGoalTick: async (g, _fireAt, state) => void chain.push({ goalId: g.id, state }),
      getAwaitingEvent: async () => null,
      setAwaitingEvent: async () => {},
      clearAwaitingEvent: async () => false,
      now: () => new Date(),
    })

    await driver.kickoffGoal(created.id)
    expect(chain).toHaveLength(1) // armed
    let ticks = 0
    while (chain.length > 0 && ticks < 10) {
      const next = chain.shift()!
      ticks++
      await driver.tickGoal(next.goalId, next.state)
    }

    // 4 iterations × 5 prospects = 20 → the 4th tick's evaluation meets the
    // predicate mid-loop... the run happens BEFORE the evaluation each tick, so
    // the goal completes on the tick that saved the 20th prospect.
    expect(runs).toBe(4)
    expect(ticks).toBe(4)
    const final = await goalsDb.getGoalByIdSystem(created.id)
    expect(final?.status).toBe('done')
    expect(delivered).toEqual(['done']) // no silent termination
    const count = await client.query(
      `SELECT count(*)::int AS n FROM entities WHERE workspace_id = $1 AND attributes->>'prospect' = 'true' AND valid_to IS NULL`,
      [workspaceId],
    )
    expect(count.rows[0].n).toBe(20)

    // The budget-defaulting invariant: the goal armed via kickoffGoal without
    // applyDefaultBudget wired stays as-authored — assert the loop terminated
    // on the PREDICATE, not a budget backstop.
    expect(final?.blockerReason).toBeNull()
  })
})
