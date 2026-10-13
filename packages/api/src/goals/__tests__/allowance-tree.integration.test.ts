/**
 * One shared allowance per execution tree, against a migration-replayed
 * PostgreSQL 18: serialized reservations, ledger reconciliation, human-only
 * renewal, replay/stale handling, late use and the migration's own
 * constraints. Runs only through scripts/crm/local-fixture.mjs.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import {
  applyControlSystem,
  beginIterationSystem,
  createRootExecution,
  getExecutionSystem,
  getPoolSystem,
} from '../../db/task-execution-store.js'
import { createAllowanceTree } from '../allowance-tree.js'
import { assistantActor, assistantTaskWithExecution, briefFixture, credentialActor, evidence, fakeUsage, human, runId } from './fixtures/execution-journeys.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

const checkpoint = (over = {}) => ({ ...evidence(over), sourceRefs: [], nextStep: null, questions: [], segment: 1, evidenceFingerprint: '' })

describe('[COMP:goals/allowance-tree] one shared allowance per execution tree (real PG)', () => {
  it('creates one pool per root and returns the existing pursuit to a duplicate entry', async () => {
    const f = await briefFixture()
    const { task, goalId, state } = await assistantTaskWithExecution(f)
    const again = await createRootExecution({
      workspaceId: f.workspaceId, taskId: task.id, goalId, executor: { kind: 'assistant', id: f.assistants.brian }, phase: 'ready',
      plan: {}, sourceRefs: [], authoringRef: null, budget: { maxSpend: 5, maxIterations: 30 },
      enter: { idempotencyKey: `enter:${task.id}:dup`, actor: human(f.people.lead, 'assignment') },
    })
    expect(again).toMatchObject({ created: false, state: { id: state.id } })
    const pools = await pool.query('SELECT count(*)::int n FROM task_execution_pools WHERE workspace_id=$1', [f.workspaceId])
    expect(pools.rows[0].n).toBe(1)
  })

  it('serializes concurrent reservations so branches cannot each spend the remainder', async () => {
    const f = await briefFixture()
    const { state } = await assistantTaskWithExecution(f, { budget: { maxSpend: null, maxIterations: 2 } })
    const tree = createAllowanceTree({ usageStore: fakeUsage().store })
    const a = await tree.deriveChild(state.id, 'branch-a', { taskId: null, executor: { kind: 'assistant', id: f.assistants.brian }, plan: {}, sourceRefs: [], dependencyOpen: false })
    const b = await tree.deriveChild(state.id, 'branch-b', { taskId: null, executor: { kind: 'assistant', id: f.assistants.brian }, plan: {}, sourceRefs: [], dependencyOpen: false })
    expect(a.state.poolId).toBe(state.poolId)
    expect(b.state.poolId).toBe(state.poolId)
    const results = await Promise.all([state.id, a.state.id, b.state.id].map(id => beginIterationSystem(id)))
    expect(results.filter(r => r.kind === 'proceed')).toHaveLength(2)
    expect(results.filter(r => r.kind === 'exhausted').map(r => (r as { reason: string }).reason)).toEqual(['max_iterations'])
  })

  it('caps the spend reservation by what is left in the active segment', async () => {
    const f = await briefFixture()
    const { state } = await assistantTaskWithExecution(f, { budget: { maxSpend: 0.08, maxIterations: null } })
    const tree = createAllowanceTree({ usageStore: fakeUsage().store })
    const child = await tree.deriveChild(state.id, 'c', { taskId: null, executor: { kind: 'assistant', id: f.assistants.brian }, plan: {}, sourceRefs: [], dependencyOpen: false })
    const third = await tree.deriveChild(state.id, 'd', { taskId: null, executor: { kind: 'assistant', id: f.assistants.brian }, plan: {}, sourceRefs: [], dependencyOpen: false })
    const r1 = await beginIterationSystem(state.id)
    const r2 = await beginIterationSystem(child.state.id)
    const r3 = await beginIterationSystem(third.state.id)
    expect(r1.kind === 'proceed' && r1.inFlight.spend).toBe(0.05)
    expect(r2.kind === 'proceed' && r2.inFlight.spend).toBeCloseTo(0.03, 6)
    expect(r3).toMatchObject({ kind: 'exhausted', reason: 'max_spend' })
  })

  it('derives a child idempotently into the root pool; a human-owned child waits', async () => {
    const f = await briefFixture()
    const { state } = await assistantTaskWithExecution(f)
    const tree = createAllowanceTree({ usageStore: fakeUsage().store })
    const first = await tree.deriveChild(state.id, 'research', { taskId: null, executor: { kind: 'person', id: randomUUID() }, plan: {}, sourceRefs: [], dependencyOpen: false })
    const replay = await tree.deriveChild(state.id, 'research', { taskId: null, executor: null, plan: {}, sourceRefs: [], dependencyOpen: false })
    expect(first).toMatchObject({ created: true, state: { phase: 'waiting', poolId: state.poolId } })
    expect(replay).toMatchObject({ created: false, state: { id: first.state.id } })
  })

  it('reconciles actual metered spend by delta across ticks of one run', async () => {
    const f = await briefFixture()
    const { state } = await assistantTaskWithExecution(f)
    const usage = fakeUsage()
    const tree = createAllowanceTree({ usageStore: usage.store })
    const run = runId()
    let r = await tree.reserve(state.id)
    if (r.kind !== 'proceed') throw new Error(r.kind)
    usage.set(run, 0.2)
    await tree.settle(state.id, { attemptId: r.inFlight.attemptId, runId: run, checkpoint: checkpoint(), nextPhase: 'ready', streaks: { noProgress: 0, transient: 0 } })
    r = await tree.reserve(state.id)
    if (r.kind !== 'proceed') throw new Error(r.kind)
    usage.set(run, 0.5)
    const s = await tree.settle(state.id, { attemptId: r.inFlight.attemptId, runId: run, checkpoint: (await getExecutionSystem(state.id))!.checkpoint, nextPhase: 'ready', streaks: { noProgress: 0, transient: 0 } })
    expect(s?.pool.lifetime).toMatchObject({ spent: 0.5, iterations: 2, reservedSpend: 0 })
  })

  it('never treats missing metering as zero spend', async () => {
    const f = await briefFixture()
    const { state } = await assistantTaskWithExecution(f)
    const tree = createAllowanceTree({ usageStore: null })
    expect(tree.meteringAvailable()).toBe(false)
    const r = await beginIterationSystem(state.id)
    if (r.kind !== 'proceed') throw new Error(r.kind)
    const s = await tree.settle(state.id, { attemptId: r.inFlight.attemptId, runId: runId(), checkpoint: null, nextPhase: 'ready', streaks: { noProgress: 0, transient: 0 } })
    expect(s?.pool.lifetime.spent).toBe(r.inFlight.spend)
    expect(s?.pool.lifetime.spent).toBeGreaterThan(0)
  })

  it('renews once per distinct human intervention and keeps lifetime use', async () => {
    const f = await briefFixture()
    const { state } = await assistantTaskWithExecution(f, { budget: { maxSpend: null, maxIterations: 1 } })
    const usage = fakeUsage()
    const tree = createAllowanceTree({ usageStore: usage.store })
    const run = runId()
    const r = await tree.reserve(state.id)
    if (r.kind !== 'proceed') throw new Error(r.kind)
    usage.set(run, 0.1)
    await tree.settle(state.id, { attemptId: r.inFlight.attemptId, runId: run, checkpoint: checkpoint(), nextPhase: 'ready', streaks: { noProgress: 0, transient: 0 } })
    expect(await tree.reserve(state.id)).toMatchObject({ kind: 'exhausted', reason: 'max_iterations' })

    const blocked = (await getExecutionSystem(state.id))!
    const intervention = randomUUID()
    const cont = await applyControlSystem(state.id, { kind: 'continue', interventionId: intervention, expectedRevision: blocked.controlRevision, actor: human(f.people.member) })
    expect(cont?.receipt).toMatchObject({ outcome: 'applied', renewedSegment: 2, humanOrigin: true })
    const replay = await applyControlSystem(state.id, { kind: 'continue', interventionId: intervention, expectedRevision: blocked.controlRevision, actor: human(f.people.member) })
    expect(replay).toMatchObject({ replayed: true, receipt: { id: cont!.receipt.id } })
    let p = (await getPoolSystem(state.poolId))!
    expect(p.activeSegment).toBe(2)
    expect(p.lifetime).toMatchObject({ spent: 0.1, iterations: 1 })
    expect(p.segments.map(s => s.openedReason)).toEqual(['initial', 'human_renewal'])
    expect(await tree.reserve(state.id)).toMatchObject({ kind: 'proceed' })

    // Non-human origins and stale revisions renew nothing.
    const now = (await getExecutionSystem(state.id))!
    for (const actor of [assistantActor(f.assistants.brian), credentialActor(randomUUID())]) {
      const denied = await applyControlSystem(state.id, { kind: 'continue', interventionId: randomUUID(), expectedRevision: now.controlRevision, actor })
      expect(denied?.receipt).toMatchObject({ outcome: 'blocked', renewedSegment: null, payload: { reason: 'human_intent_required' } })
    }
    const stale = await applyControlSystem(state.id, { kind: 'steer', interventionId: randomUUID(), expectedRevision: now.controlRevision - 1, instruction: 'Use the newer vendor list', actor: human(f.people.member) })
    expect(stale?.receipt).toMatchObject({ outcome: 'stale', renewedSegment: null })
    p = (await getPoolSystem(state.poolId))!
    expect(p.activeSegment).toBe(2)
  })

  it('reconciles late use to its originating segment after a renewal', async () => {
    const f = await briefFixture()
    const { state } = await assistantTaskWithExecution(f)
    const usage = fakeUsage()
    const tree = createAllowanceTree({ usageStore: usage.store })
    const run = runId()
    const r = await tree.reserve(state.id)
    if (r.kind !== 'proceed') throw new Error(r.kind)
    // A human steers while the attempt is in flight: segment 2 opens.
    await applyControlSystem(state.id, { kind: 'steer', interventionId: randomUUID(), expectedRevision: r.state.controlRevision, instruction: 'Focus on the two cheapest vendors', actor: human(f.people.lead) })
    usage.set(run, 0.3)
    const s = await tree.settle(state.id, { attemptId: r.inFlight.attemptId, runId: run, checkpoint: checkpoint(), nextPhase: 'ready', streaks: { noProgress: 0, transient: 0 } })
    expect(s?.kind).toBe('fenced')
    const seg1 = s!.pool.segments.find(x => x.segmentNo === 1)!
    expect(seg1).toMatchObject({ spent: 0.3, lateSpend: 0.3, reservedSpend: 0, iterations: 1 })
    expect(s!.pool.segments.find(x => x.segmentNo === 2)).toMatchObject({ spent: 0, iterations: 0 })
    expect(s!.pool.lifetime.spent).toBe(0.3)
  })

  it('enforces human-only renewal, immutable receipts and monotonic revisions in the schema', async () => {
    const f = await briefFixture()
    const { state } = await assistantTaskWithExecution(f)
    await expect(pool.query(
      `INSERT INTO task_execution_commands (workspace_id,state_id,pool_id,idempotency_key,kind,actor_kind,origin,human_origin,outcome,renewed_segment)
       VALUES ($1,$2,$3,'forged','continue','assistant','chat',false,'applied',2)`, [f.workspaceId, state.id, state.poolId])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(
      `INSERT INTO task_execution_commands (workspace_id,state_id,pool_id,idempotency_key,kind,actor_kind,origin,human_origin,outcome)
       VALUES ($1,$2,$3,'forged-human','continue','credential','mcp',true,'applied')`, [f.workspaceId, state.id, state.poolId])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`UPDATE task_execution_commands SET outcome='blocked' WHERE state_id=$1`, [state.id])).rejects.toThrow(/task_execution_command_immutable/)
    await expect(pool.query(`UPDATE task_execution_states SET control_revision = 0 WHERE id=$1`, [state.id])).rejects.toThrow(/task_execution_revision_regressed/)
    // A pool in another workspace cannot be borrowed.
    const other = await briefFixture()
    await expect(pool.query(
      `INSERT INTO task_execution_states (workspace_id, goal_id, task_id, pool_id, lane, phase) VALUES ($1,NULL,$2,$3,'native','ready')`,
      [other.workspaceId, randomUUID(), state.poolId])).rejects.toMatchObject({ code: '23503' })
  })
})
