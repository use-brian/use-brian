/**
 * Durable execution state through the driver's ledger port, against a
 * migration-replayed PostgreSQL 18 with real RLS: honest iteration
 * classification, restart recovery from the ledger, pause fencing of an
 * in-flight write-back, checked completion, and task lineage (supersession,
 * deletion, reassignment). Runs only through scripts/crm/local-fixture.mjs.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { abandonGoalsForHostTaskSystem, getGoalByIdSystem } from '../../db/goals.js'
import {
  applyControlSystem,
  bindExternalLaneSystem,
  getExecutionSystem,
  getPoolSystem,
  readExecutionForViewer,
} from '../../db/task-execution-store.js'
import { createTask, updateTask } from '../../db/tasks.js'
import { createAllowanceTree } from '../allowance-tree.js'
import { createExecutionLedger, evidenceMeetsPlan } from '../execution-state.js'
import { assistantTaskWithExecution, briefFixture, credentialActor, fakeUsage, human, runId } from './fixtures/execution-journeys.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

const setup = async (opts: Parameters<typeof assistantTaskWithExecution>[1] = {}) => {
  const f = await briefFixture()
  const made = await assistantTaskWithExecution(f, opts)
  const usage = fakeUsage()
  const ledger = createExecutionLedger({ allowance: createAllowanceTree({ usageStore: usage.store }) })
  const goal = (await getGoalByIdSystem(made.goalId!))!
  return { f, ...made, usage, ledger, goal }
}

async function iterate(ctx: Awaited<ReturnType<typeof setup>>, result: Partial<Parameters<ReturnType<typeof createExecutionLedger>['endIteration']>[2]> = {}) {
  const begin = await ctx.ledger.beginTick(ctx.goal)
  if (begin.kind !== 'proceed') return { begin, end: null }
  const run = result.runId ?? runId()
  await ctx.ledger.bindRun(begin.stateId, begin.attemptId, run)
  ctx.usage.set(run, 0.01)
  const end = await ctx.ledger.endIteration(begin.stateId, begin.attemptId, { runId: run, terminal: true, waiting: false, ...result })
  return { begin, end }
}

describe('[COMP:goals/execution-checkpoint] durable execution state (real PG + RLS)', () => {
  it('counts a completed run with no new evidence as no progress and stops at the limit', async () => {
    const ctx = await setup()
    const a = await iterate(ctx, { evidence: { artifacts: [{ kind: 'page', ref: 'p-1', version: '1' }] } })
    expect(a.end).toMatchObject({ progressed: true, blockedReason: null })
    // Same evidence again: the workflow "completed", but nothing new was checked.
    const b = await iterate(ctx, { evidence: { artifacts: [{ kind: 'page', ref: 'p-1', version: '1' }], summary: 'Reworded summary' } })
    expect(b.end).toMatchObject({ progressed: false, blockedReason: null })
    await iterate(ctx)
    const d = await iterate(ctx)
    expect(d.end).toMatchObject({ progressed: false, blockedReason: 'no_progress' })
    expect((await getExecutionSystem(ctx.state.id))).toMatchObject({ phase: 'blocked', blocker: { reason: 'no_progress' } })
    // New checked evidence is usable again after a human continue.
    const s = (await getExecutionSystem(ctx.state.id))!
    await applyControlSystem(s.id, { kind: 'continue', interventionId: randomUUID(), expectedRevision: s.controlRevision, actor: human(ctx.f.people.lead) })
    const e = await iterate(ctx, { evidence: { checkedResults: ['summary page published'] } })
    expect(e.end).toMatchObject({ progressed: true })
  })

  it('stops immediately on a known blocker and keeps it through a continue', async () => {
    const ctx = await setup()
    const r = await iterate(ctx, { blocker: { kind: 'missing_account', subject: 'calendar' } })
    expect(r.end?.blockedReason).toBe('missing_account: calendar')
    const s = (await getExecutionSystem(ctx.state.id))!
    const cont = await applyControlSystem(s.id, { kind: 'continue', interventionId: randomUUID(), expectedRevision: s.controlRevision, actor: human(ctx.f.people.lead) })
    expect(cont?.receipt).toMatchObject({ outcome: 'blocked', payload: { reason: 'blocker_unresolved' }, renewedSegment: null })
  })

  it('treats a parked run as a real wait, not a stall', async () => {
    const ctx = await setup()
    for (let i = 0; i < 4; i++) {
      const r = await iterate(ctx, { terminal: false, waiting: true })
      expect(r.end).toMatchObject({ progressed: false, blockedReason: null })
    }
    expect((await getExecutionSystem(ctx.state.id))).toMatchObject({ phase: 'waiting', streaks: { noProgress: 0 } })
  })

  it('recovers a crashed attempt from the ledger without a fresh allowance', async () => {
    const ctx = await setup()
    const first = await ctx.ledger.beginTick(ctx.goal)
    if (first.kind !== 'proceed') throw new Error(first.kind)
    const run = runId()
    await ctx.ledger.bindRun(first.stateId, first.attemptId, run)
    ctx.usage.set(run, 0.42)
    // The process dies here: no settle. The next tick (reaper re-arm) reloads.
    const second = await ctx.ledger.beginTick(ctx.goal)
    expect(second).toMatchObject({ kind: 'proceed', loop: { iteration: 1, spend: 0.42 } })
    const s = (await getExecutionSystem(ctx.state.id))!
    expect(s.checkpoint?.uncertainEffects).toEqual([{ operation: 'workflow_run', ref: run, attemptId: first.attemptId }])
    expect((await getPoolSystem(s.poolId))!.lifetime).toMatchObject({ iterations: 1, spent: 0.42 })
  })

  it('fences a stale write-back after Pause and keeps committed and uncertain effects', async () => {
    const ctx = await setup()
    const begin = await ctx.ledger.beginTick(ctx.goal)
    if (begin.kind !== 'proceed') throw new Error(begin.kind)
    const s = (await getExecutionSystem(begin.stateId))!
    const paused = await applyControlSystem(s.id, { kind: 'pause', interventionId: randomUUID(), expectedRevision: s.controlRevision, actor: human(ctx.f.people.member) })
    expect(paused?.receipt).toMatchObject({ outcome: 'applied', renewedSegment: null })
    const end = await ctx.ledger.endIteration(begin.stateId, begin.attemptId, {
      runId: runId(), terminal: true, waiting: false,
      evidence: { completedEffects: [{ operation: 'send_email', ref: 'msg-1', attemptId: begin.attemptId }],
        uncertainEffects: [{ operation: 'book_room', ref: 'req-7', attemptId: begin.attemptId }] },
    })
    expect(end.fenced).toBe(true)
    const after = (await getExecutionSystem(begin.stateId))!
    expect(after.phase).toBe('paused')
    expect(after.checkpoint?.completedEffects.map(e => e.ref)).toEqual(['msg-1'])
    expect(after.checkpoint?.uncertainEffects.map(e => e.ref)).toEqual(['req-7'])
    expect(await ctx.ledger.beginTick(ctx.goal)).toEqual({ kind: 'paused' })
    // A credential may pause too, but cannot claim a human renewal.
    const again = await applyControlSystem(after.id, { kind: 'continue', interventionId: randomUUID(), expectedRevision: after.controlRevision, actor: credentialActor(randomUUID()) })
    expect(again?.receipt.payload).toEqual({ reason: 'human_intent_required' })
  })

  it('completes only on checked evidence for every chosen criterion', async () => {
    const ctx = await setup({ completionEvidence: ['summary page published', 'owner notified'] })
    await iterate(ctx, { evidence: { checkedResults: ['summary page published'] } })
    let s = (await getExecutionSystem(ctx.state.id))!
    expect(evidenceMeetsPlan(ctx.goal, s)).toBe(false)
    // A prepared draft with an uncertain send is still partial.
    await iterate(ctx, { evidence: { checkedResults: ['owner notified'], uncertainEffects: [{ operation: 'send', ref: 'm-2', attemptId: 'x' }] } })
    s = (await getExecutionSystem(ctx.state.id))!
    expect(evidenceMeetsPlan(ctx.goal, s)).toBe(false)
    await iterate(ctx, { evidence: { completedEffects: [{ operation: 'send', ref: 'm-2', attemptId: 'x' }] } })
    s = (await getExecutionSystem(ctx.state.id))!
    expect(evidenceMeetsPlan(ctx.goal, s)).toBe(true)
    // The task being closed is not evidence on its own.
    const bare = await setup()
    await updateTask(bare.f.people.lead, bare.task.id, { status: 'done' })
    expect(await bare.ledger.completionSatisfied(bare.goal)).toBe(false)
  })

  it('follows task supersession for native and external lanes', async () => {
    const ctx = await setup()
    const lane = await bindExternalLaneSystem({ workspaceId: ctx.f.workspaceId, taskId: ctx.task.id, externalExecutionId: 'session-a',
      harness: 'codex', label: null, actor: credentialActor(randomUUID()) })
    const next = await updateTask(ctx.f.people.lead, ctx.task.id, { title: 'Prepare the fictional vendor summary v2' })
    expect(next!.id).not.toBe(ctx.task.id)
    expect((await getExecutionSystem(ctx.state.id))!.taskId).toBe(next!.id)
    expect((await getExecutionSystem(lane.state.id))!.taskId).toBe(next!.id)
  })

  it('retires on deletion and on reassignment without reviving the host or losing history', async () => {
    const ctx = await setup()
    await iterate(ctx, { evidence: { checkedResults: ['partial'] } })
    await pool.query('UPDATE tasks SET valid_to = now() WHERE id = $1', [ctx.task.id])
    await abandonGoalsForHostTaskSystem(ctx.task.id, 'host_task_deleted')
    expect(await getExecutionSystem(ctx.state.id)).toMatchObject({ phase: 'retired', blocker: { reason: 'host_task_deleted' } })
    expect((await getGoalByIdSystem(ctx.goalId!))!.status).toBe('abandoned')
    expect(await ctx.ledger.beginTick(ctx.goal)).toEqual({ kind: 'retired' })
    const kinds = (await pool.query('SELECT kind FROM task_execution_commands WHERE state_id=$1 ORDER BY created_at', [ctx.state.id])).rows.map(r => r.kind)
    expect(kinds).toEqual(['enter', 'retire'])
    const live = await pool.query('SELECT count(*)::int n FROM tasks WHERE id=$1 AND valid_to IS NULL', [ctx.task.id])
    expect(live.rows[0].n).toBe(0)

    const re = await setup()
    const member = (await pool.query('SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [re.f.workspaceId, re.f.people.lead])).rows[0].id
    await updateTask(re.f.people.lead, re.task.id, { assigneeId: member })
    expect((await getExecutionSystem(re.state.id))!.phase).toBe('retired')
    // A confirmed goal driving it is fenced, not left running for the old executor.
    expect((await getGoalByIdSystem(re.goalId!))!.status).toBe('abandoned')
  })

  it('hides a protected execution from rows, children and receipts under RLS', async () => {
    const f = await briefFixture()
    await f.q("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.people.lead])
    const task = await createTask(f.people.lead, { workspaceId: f.workspaceId, title: 'Protected fictional work', sensitivity: 'confidential',
      executorAssistantId: f.assistants.brian, home: { kind: 'project', id: f.projectId } })
    const made = await assistantTaskWithExecution(f, { withGoal: false })
    await pool.query('UPDATE task_execution_states SET task_id=$1 WHERE id=$2', [task.id, made.state.id])
    expect(await readExecutionForViewer(f.people.lead, { executionId: made.state.id })).toMatchObject({ state: { id: made.state.id } })
    expect(await readExecutionForViewer(f.people.member, { executionId: made.state.id })).toBeNull()
    expect(await readExecutionForViewer(f.people.member, { taskId: task.id })).toBeNull()
    const visible = await getAppPool().connect()
    try {
      await visible.query('BEGIN')
      await visible.query(`SET LOCAL app.current_user_id = '${f.people.member}'`)
      const n = await visible.query('SELECT count(*)::int n FROM task_execution_commands WHERE state_id=$1', [made.state.id])
      expect(n.rows[0].n).toBe(0)
      await visible.query('ROLLBACK')
    } finally { visible.release() }
    expect(await readExecutionForViewer(f.people.outsider, { executionId: made.state.id })).toBeNull()
  })
})
