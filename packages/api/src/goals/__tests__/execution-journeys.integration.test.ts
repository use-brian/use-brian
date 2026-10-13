/**
 * R17: the four acceptance journeys (docs/plans/task-execution-acceptance-
 * journeys.md TJ01-TJ04) as deterministic, stateful fixtures through the REAL
 * shared services: automatic entry and readiness, the goal driver with the
 * durable execution ledger, the control service, dependency wake and external
 * reporting, against a migration-replayed PostgreSQL 18. Operations and the
 * planner are fakes that model supported/unsupported capabilities.
 *
 * What this proves: the exercised contracts (entry, readiness, WIP, pool,
 * pause/resume, uncertain effects, dependency waits, checked completion,
 * reporting limits). What it does NOT prove: model planning quality, real
 * portal/mail/browser behavior, or research quality; those are the semantic
 * evals GE01-GE38 / GF01-GF38 leave to paid, live suites.
 *
 * Criteria touched (contract level only): GE02-GE11, GE13-GE17, GE19-GE26.
 * Runs only through scripts/crm/local-fixture.mjs. Fictional data only.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { ExecutionPlanDraft, GoalRecord } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbGoalStore } from '../../db/goals-store.js'
import {
  clearGoalAwaitingEventSystem,
  getGoalAwaitingEventSystem,
  getGoalByIdSystem,
  setGoalAwaitingEventSystem,
  setGoalStatusSystem,
  transitionRunningGoalStatusSystem,
  tryClaimGoalForTick,
} from '../../db/goals.js'
import { getExecutionSystem, getPoolSystem } from '../../db/task-execution-store.js'
import { createTask, getTaskByIdSystem, updateTask } from '../../db/tasks.js'
import { controlExecution, type ControlEffects } from '../../tasks/execution-control.js'
import { bindExternalExecution, reportExternalProgress } from '../../tasks/external-progress.js'
import { createAllowanceTree } from '../allowance-tree.js'
import { createGoalDriver, INITIAL_GOAL_LOOP_STATE, type DispatchRunResult, type GoalLoopState } from '../driver.js'
import { enterAssignedExecution, readExecutionSources, revalidateWaitingExecutions, type EntryDeps } from '../execution-qualification.js'
import { createExecutionLedger, type IterationEvidence } from '../execution-state.js'
import { briefFixture, fakeUsage, type BriefFixture } from './fixtures/execution-journeys.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

type Step = { evidence?: IterationEvidence; closeTask?: boolean; terminal?: boolean; blocker?: DispatchRunResult['blocker'] }

/** A world with the real services and scripted, fake operations. */
async function world(opts: { plan: ExecutionPlanDraft; tools?: string[]; accounts?: string[]; budget?: { maxSpend: number; maxIterations: number } }) {
  const f = await briefFixture()
  const usage = fakeUsage()
  const ledger = createExecutionLedger({ allowance: createAllowanceTree({ usageStore: usage.store }) })
  const queue: { goalId: string; state: GoalLoopState }[] = []
  const delivered: { goalId: string; terminal: string; reason: string | null }[] = []
  const dispatched: { goalId: string; steering: string[] }[] = []
  const script: Step[] = []
  let taskId = ''
  const driver = createGoalDriver({
    goalStore: createDbGoalStore(), tryClaim: tryClaimGoalForTick, transitionRunningStatus: transitionRunningGoalStatusSystem,
    sessionCostUsd: (s) => usage.store.getSessionCostUsd(s), meteringAvailable: () => true,
    getAwaitingEvent: async (goalId) => {
      const m = await getGoalAwaitingEventSystem(goalId)
      return m ? { subscriptions: m.subscriptions, state: m.state as GoalLoopState | undefined } : null
    },
    setAwaitingEvent: (goalId, marker) => setGoalAwaitingEventSystem(goalId, marker), clearAwaitingEvent: clearGoalAwaitingEventSystem,
    executionLedger: ledger, now: () => new Date(),
    deliver: async (goal, terminal, reason) => { delivered.push({ goalId: goal.id, terminal, reason }) },
    scheduleGoalTick: async (goal, _at, state) => { queue.push({ goalId: goal.id, state }) },
    dispatchRun: async ({ goal }) => {
      const state = await getExecutionSystem((await pool.query('SELECT id FROM task_execution_states WHERE goal_id=$1 AND parent_state_id IS NULL', [goal.id])).rows[0].id)
      dispatched.push({ goalId: goal.id, steering: state!.steering.map((x) => x.instruction) })
      const step = script.shift() ?? {}
      const runId = randomUUID()
      usage.set(runId, 0.02)
      if (step.closeTask) await updateTask(f.people.lead, taskId, { status: 'done' })
      return { runId, terminal: step.terminal ?? true, completed: step.terminal ?? true, evidence: step.evidence, blocker: step.blocker ?? null }
    },
  })
  const effects: ControlEffects = {
    afterControl: async (state, kind) => {
      if (!state.goalId) return
      const goal = (await getGoalByIdSystem(state.goalId))!
      if (kind === 'pause') { if (goal.status === 'active') await setGoalStatusSystem(goal.id, 'blocked', 'execution_paused'); return }
      if (goal.status === 'blocked') await setGoalStatusSystem(goal.id, 'active', null)
      queue.push({ goalId: goal.id, state: INITIAL_GOAL_LOOP_STATE })
    },
  }
  const deps: EntryDeps = {
    executorUsable: async () => true,
    manifest: async () => ({ tools: new Set(opts.tools ?? []), accounts: new Set(opts.accounts ?? []) }),
    readSources: readExecutionSources,
    planner: async () => opts.plan,
    captureAuthority: async ({ assistantId, workspaceId, userId }) => ({ version: 1, assistantId,
      ceiling: { workspaceId, userId, clearance: 'internal', compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: [assistantId] } } as never),
    defaultBudget: async () => opts.budget ?? { maxSpend: 5, maxIterations: 30 },
    // Test arming: a confirmed task goal with the planned outcome and a means.
    armGoal: async ({ task, plan, createdByUserId, budget }) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO goals (workspace_id, host_type, host_id, outcome, done_when, means, budget, status, created_by_user_id, confirmed_at)
         VALUES ($1,'task',$2,$3,'{"kind":"query","query":{"description":"task complete","predicate":{"hostTaskDone":true}}}'::jsonb,
                 $4::jsonb,$5::jsonb,'active',$6,now()) RETURNING id`,
        [task.workspaceId, task.id, plan.outcome, JSON.stringify({ workflowId: randomUUID() }), JSON.stringify(budget), createdByUserId])
      return (await getGoalByIdSystem(r.rows[0].id)) as GoalRecord
    },
    kickoffGoal: driver.kickoffGoal,
  }
  const assign = async (title: string, executor: 'assistant' | 'person' = 'assistant') => {
    const member = (await pool.query('SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.people.member])).rows[0].id
    const task = await createTask(f.people.lead, { workspaceId: f.workspaceId, title, home: { kind: 'project', id: f.projectId },
      ...(executor === 'assistant' ? { executorAssistantId: f.assistants.brian } : { assigneeId: member }) })
    taskId = task.id
    const entry = await enterAssignedExecution(task, { kind: 'human_assignment', actorUserId: f.people.lead, origin: 'ui', at: new Date().toISOString() }, deps)
    return { task, entry }
  }
  const drain = async (max = 10) => { for (let i = 0; i < max && queue.length > 0; i++) { const t = queue.shift()!; await driver.tickGoal(t.goalId, t.state) } }
  const human = (userId: string) => ({ userId, kind: 'user' as const, id: userId, origin: 'ui' as const, human: true })
  return { f, usage, queue, delivered, dispatched, script, deps, assign, drain, human, effects, task: () => taskId }
}

const plan = (over: Partial<ExecutionPlanDraft> = {}): ExecutionPlanDraft => ({
  outcome: 'Fictional outcome', constraints: [], steps: [{ title: 'Do the work', contribution: 'result' }],
  completionEvidence: ['result verified'], requiredOperations: [], requiredAccounts: [], requiredInputs: [], questions: [], ...over,
})

describe('[COMP:goals/execution-journeys] TJ01-TJ04 through the real shared services', () => {
  describe('TJ01 authenticated room booking', () => {
    const booking = plan({ outcome: 'Room for six booked for the fictional offsite', completionEvidence: ['booking confirmation id'],
      requiredOperations: ['checkAvailability', 'bookRoom'], requiredAccounts: ['venue-portal'] })

    it('success: starts once on assignment, checks availability, books, and completes on the checked receipt', async () => {
      const w = await world({ plan: booking, tools: ['checkAvailability', 'bookRoom'], accounts: ['venue-portal'] })
      const { entry } = await w.assign('Book a fictional room for six people')
      expect(entry).toMatchObject({ kind: 'entered', readiness: { state: 'ready' } })
      // A duplicate assignment event creates no second pursuit.
      expect((await enterAssignedExecution((await getTaskByIdSystem(w.task()))!, { kind: 'human_assignment', actorUserId: w.f.people.lead, origin: 'ui', at: 'x' }, w.deps)).kind).toBe('duplicate')
      w.script.push({ evidence: { artifacts: [{ kind: 'availability', ref: 'room-12' }] } })
      w.script.push({ evidence: { completedEffects: [{ operation: 'bookRoom', ref: 'booking-77', attemptId: 'a' }], checkedResults: ['booking confirmation id'] }, closeTask: true })
      await w.drain()
      const goalId = (entry as { goalId: string }).goalId
      expect((await getGoalByIdSystem(goalId))!.status).toBe('done')
      expect(w.delivered).toEqual([{ goalId, terminal: 'done', reason: null }])
      const state = (await pool.query('SELECT phase, pool_id FROM task_execution_states WHERE goal_id=$1', [goalId])).rows[0]
      expect(state.phase).toBe('done')
      expect((await getPoolSystem(state.pool_id))!.lifetime).toMatchObject({ iterations: 2, spent: 0.04 })
    })

    it('known blocker: a missing booking operation is reported precisely and nothing is armed', async () => {
      const w = await world({ plan: booking, tools: ['checkAvailability'], accounts: ['venue-portal'] })
      const { entry } = await w.assign('Book a fictional room for six people')
      expect(entry).toMatchObject({ kind: 'entered', goalId: null, state: { phase: 'blocked', blocker: { reason: 'missing_operation', detail: 'bookRoom' } } })
      expect(w.queue).toHaveLength(0)
    })

    it('pause, uncertain submission and resume: no duplicate booking, renewal by the person only', async () => {
      const w = await world({ plan: booking, tools: ['checkAvailability', 'bookRoom'], accounts: ['venue-portal'] })
      const { entry } = await w.assign('Book a fictional room for six people')
      const goalId = (entry as { goalId: string }).goalId
      w.script.push({ evidence: { uncertainEffects: [{ operation: 'bookRoom', ref: 'request-5', attemptId: 'a' }] } })
      await w.drain(1)
      let state = (await getExecutionSystem((entry as { state: { id: string } }).state.id))!
      expect(state.checkpoint?.uncertainEffects.map((e) => e.ref)).toEqual(['request-5'])
      await controlExecution(w.human(w.f.people.member), w.f.workspaceId, state.id,
        { action: 'pause', expectedRevision: state.controlRevision, interventionId: randomUUID() }, w.effects)
      await w.drain(1)
      expect(w.dispatched).toHaveLength(1)
      expect((await getGoalByIdSystem(goalId))).toMatchObject({ status: 'blocked', blockerReason: 'execution_paused' })
      expect(w.delivered).toEqual([])
      state = (await getExecutionSystem(state.id))!
      const steer = await controlExecution(w.human(w.f.people.lead), w.f.workspaceId, state.id,
        { action: 'steer', expectedRevision: state.controlRevision, interventionId: randomUUID(), instruction: 'Check the booking status before submitting again' }, w.effects)
      expect(steer.renewedSegment).toBe(2)
      w.script.push({ evidence: { completedEffects: [{ operation: 'bookRoom', ref: 'request-5', attemptId: 'b' }], checkedResults: ['booking confirmation id'] }, closeTask: true })
      await w.drain()
      expect(w.dispatched.at(-1)?.steering).toEqual(['Check the booking status before submitting again'])
      expect((await getGoalByIdSystem(goalId))!.status).toBe('done')
      const effects = (await getExecutionSystem(state.id))!.checkpoint!
      expect(effects.completedEffects.filter((e) => e.operation === 'bookRoom')).toHaveLength(1)
      expect(effects.uncertainEffects).toEqual([])
    })

    it('outcome unmet: a closed task without the booking receipt is not done', async () => {
      const w = await world({ plan: booking, tools: ['checkAvailability', 'bookRoom'], accounts: ['venue-portal'] })
      const { entry } = await w.assign('Book a fictional room for six people')
      w.script.push({ evidence: { artifacts: [{ kind: 'form', ref: 'prefilled' }] }, closeTask: true })
      await w.drain()
      const goalId = (entry as { goalId: string }).goalId
      expect(await getGoalByIdSystem(goalId)).toMatchObject({ status: 'blocked', blockerReason: 'completion_evidence_missing' })
    })
  })

  describe('TJ02 company research', () => {
    const research = plan({ outcome: 'Source-backed profile of a fictional company', completionEvidence: ['profile page saved'],
      requiredOperations: ['webSearch', 'createPage'] })

    it('budget pause keeps partial research; one human continue renews once and finishes in the same pool', async () => {
      const w = await world({ plan: research, tools: ['webSearch', 'createPage'], budget: { maxSpend: 5, maxIterations: 2 } })
      const { entry } = await w.assign('Research the fictional company history and funding')
      const stateId = (entry as { state: { id: string } }).state.id
      const goalId = (entry as { goalId: string }).goalId
      w.script.push({ evidence: { artifacts: [{ kind: 'source', ref: 'founding-article' }] } })
      w.script.push({ evidence: { artifacts: [{ kind: 'source', ref: 'funding-filing' }] } })
      await w.drain()
      expect(await getGoalByIdSystem(goalId)).toMatchObject({ status: 'blocked', blockerReason: 'max_iterations' })
      let state = (await getExecutionSystem(stateId))!
      expect(state.checkpoint?.artifacts.map((a) => a.ref)).toEqual(['founding-article', 'funding-filing'])
      // A necessary branch shares the root pool.
      const branch = await createAllowanceTree({ usageStore: w.usage.store }).deriveChild(stateId, 'funding', { taskId: null,
        executor: { kind: 'assistant', id: w.f.assistants.brian }, plan: {}, sourceRefs: [], dependencyOpen: false })
      expect(branch.state.poolId).toBe(state.poolId)
      state = (await getExecutionSystem(stateId))!
      await controlExecution(w.human(w.f.people.member), w.f.workspaceId, stateId,
        { action: 'continue', expectedRevision: state.controlRevision, interventionId: randomUUID() }, w.effects)
      w.script.push({ evidence: { artifacts: [{ kind: 'page', ref: 'profile-v1' }], checkedResults: ['profile page saved'] }, closeTask: true })
      await w.drain()
      expect((await getGoalByIdSystem(goalId))!.status).toBe('done')
      const p = (await getPoolSystem(state.poolId))!
      expect(p.segments.map((s) => [s.openedReason, s.iterations])).toEqual([['initial', 2], ['human_renewal', 1]])
      expect(p.lifetime.iterations).toBe(3)
    })

    it('known blocker during the run stops immediately; a cosmetic replan is not progress', async () => {
      const w = await world({ plan: research, tools: ['webSearch', 'createPage'] })
      const { entry } = await w.assign('Research the fictional company history and funding')
      const goalId = (entry as { goalId: string }).goalId
      w.script.push({ evidence: { artifacts: [{ kind: 'source', ref: 'a' }] } })
      w.script.push({ evidence: { artifacts: [{ kind: 'source', ref: 'a' }], summary: 'Reworded plan' } })
      w.script.push({ blocker: { kind: 'inaccessible_source', subject: 'registry-filing' } })
      await w.drain()
      expect(await getGoalByIdSystem(goalId)).toMatchObject({ status: 'blocked', blockerReason: 'inaccessible_source: registry-filing' })
      expect(w.dispatched).toHaveLength(3)
    })
  })

  describe('TJ03 email follow-up with required documents', () => {
    const followUp = plan({ outcome: 'Reply with the required documents sent', completionEvidence: ['reply submission receipt'],
      requiredOperations: ['readMessage', 'sendReply'], requiredAccounts: ['mailbox'] })

    it('waits on a human-owned document task and wakes only when it really completes', async () => {
      const w = await world({ plan: followUp, tools: ['readMessage', 'sendReply'], accounts: ['mailbox'] })
      const member = (await pool.query('SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [w.f.workspaceId, w.f.people.member])).rows[0].id
      const doc = await createTask(w.f.people.lead, { workspaceId: w.f.workspaceId, title: 'Sign the fictional form', assigneeId: member, home: { kind: 'project', id: w.f.projectId } })
      const other = await createTask(w.f.people.lead, { workspaceId: w.f.workspaceId, title: 'Unrelated fictional task', home: { kind: 'project', id: w.f.projectId } })
      // Plan the follow-up task with a depends_on edge to the human-owned document task.
      const followTask = await createTask(w.f.people.lead, { workspaceId: w.f.workspaceId, title: 'Reply to the fictional provider with documents',
        executorAssistantId: w.f.assistants.brian, home: { kind: 'project', id: w.f.projectId } })
      await pool.query(`INSERT INTO entity_links (workspace_id, source_kind, source_id, target_kind, target_id, edge_type, source, user_id)
        VALUES ($1,'task',$2,'task',$3,'depends_on','user',$4)`, [w.f.workspaceId, followTask.id, doc.id, w.f.people.lead])
      const entry = await enterAssignedExecution(followTask, { kind: 'human_assignment', actorUserId: w.f.people.lead, origin: 'ui', at: 'now' }, w.deps)
      expect(entry).toMatchObject({ kind: 'entered', goalId: null, state: { phase: 'waiting' }, readiness: { state: 'waiting' } })
      const wakeDeps = { ...w.deps, loadTask: getTaskByIdSystem }
      // An unrelated close wakes nothing; an archived prerequisite is not done.
      await updateTask(w.f.people.lead, other.id, { status: 'done' })
      expect(await revalidateWaitingExecutions(other.id, wakeDeps)).toEqual([])
      const archived = await updateTask(w.f.people.lead, doc.id, { status: 'archived' })
      const stillWaiting = await revalidateWaitingExecutions(archived!.id, wakeDeps)
      expect(stillWaiting).toMatchObject([{ goalId: null, readiness: { state: 'waiting' } }])
      expect(w.queue).toHaveLength(0)
      // The person really completes it: the work revalidates and arms once.
      const done = await updateTask(w.f.people.lead, archived!.id, { status: 'done' })
      const woke = await revalidateWaitingExecutions(done!.id, wakeDeps)
      expect(woke).toMatchObject([{ kind: 'entered', readiness: { state: 'ready' } }])
      expect(w.queue).toHaveLength(1)
    })

    it('a missing send account blocks before anything is drafted or sent', async () => {
      const w = await world({ plan: followUp, tools: ['readMessage', 'sendReply'], accounts: [] })
      const { entry } = await w.assign('Reply to the fictional provider with documents')
      expect(entry).toMatchObject({ goalId: null, state: { phase: 'blocked', blocker: { reason: 'missing_account', detail: 'mailbox' } } })
    })

    it('a prepared draft with an uncertain send stays partial', async () => {
      const w = await world({ plan: followUp, tools: ['readMessage', 'sendReply'], accounts: ['mailbox'] })
      const { entry } = await w.assign('Reply to the fictional provider with documents')
      w.script.push({ evidence: { artifacts: [{ kind: 'draft', ref: 'reply-draft-1' }], uncertainEffects: [{ operation: 'sendReply', ref: 'msg-9', attemptId: 'a' }], checkedResults: ['reply submission receipt'] }, closeTask: true })
      await w.drain()
      expect(await getGoalByIdSystem((entry as { goalId: string }).goalId)).toMatchObject({ status: 'blocked', blockerReason: 'completion_evidence_missing' })
    })
  })

  describe('TJ04 external coding work with MCP progress', () => {
    it('human-owned external work is tracked from reports and never pursued natively', async () => {
      const w = await world({ plan: plan() })
      const { task, entry } = await w.assign('Implement the fictional export feature', 'person')
      expect(entry).toEqual({ kind: 'not_entered', reason: 'not_assistant_work' })
      const reporter = { userId: w.f.people.member, actor: { kind: 'credential' as const, id: randomUUID(), origin: 'mcp' as const, humanOrigin: false } }
      await bindExternalExecution(reporter, w.f.workspaceId, task.id, { externalExecutionId: 'codex-run-1', harness: 'codex' })
      await bindExternalExecution(reporter, w.f.workspaceId, task.id, { externalExecutionId: 'claude-run-1', harness: 'claude-code' })
      await reportExternalProgress(reporter, w.f.workspaceId, task.id, 'codex-run-1', { eventId: 'e1', sequence: 1, milestone: 'PR opened',
        state: 'claimed_done', artifacts: [{ kind: 'pull_request', ref: 'https://git.example/pr/7' }], checks: ['tests pass'] })
      const rows = (await pool.query(`SELECT lane, phase, external_execution_id FROM task_execution_states WHERE task_id=$1 ORDER BY external_execution_id`, [task.id])).rows
      expect(rows).toEqual([
        { lane: 'external', phase: 'running', external_execution_id: 'claude-run-1' },
        { lane: 'external', phase: 'running', external_execution_id: 'codex-run-1' },
      ])
      expect((await getTaskByIdSystem(task.id))!.status).toBe('todo')
      expect(w.queue).toHaveLength(0)
      expect((await pool.query(`SELECT count(*)::int n FROM goals WHERE host_id=$1`, [task.id])).rows[0].n).toBe(0)
    })
  })
})

