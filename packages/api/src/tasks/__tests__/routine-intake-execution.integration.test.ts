/** Actual configuration, intake, questions, Task control, Goal writers and app-role RLS. */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { buildOneStepReminderWorkflow, createTaskTools, type ExecutionPlanDraft } from '@use-brian/core'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { createTask, getTaskByIdSystem, updateTask } from '../../db/tasks.js'
import { createDbTaskStore } from '../../db/tasks-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createDbConnectorStore } from '../../db/connector-store.js'
import { createDbAssistantConnectorStore } from '../../db/assistant-connector-store.js'
import { createDbMcpSettingsStore } from '../../db/mcp-settings-store.js'
import { createConnectorGrantStore } from '../../db/connector-grant-store.js'
import { createConnectorInstanceStore } from '../../db/connector-instance-store.js'
import { createGoalDefaultBudgetStore } from '../../db/goal-default-budget.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { createPersonalWebSession } from '../../db/sessions.js'
import { beginIterationSystem, deriveChildExecutionSystem, findActiveNativeExecutionSystem, getExecutionSystem, getPoolSystem,
  settleIterationSystem } from '../../db/task-execution-store.js'
import { getGoalByIdSystem, tryClaimGoalForTick, clearGoalAwaitingEventSystem, setGoalAwaitingEventSystem } from '../../db/goals.js'
import { createDbGoalStore } from '../../db/goals-store.js'
import { createDbJobStore } from '../../db/job-store.js'
import { createGoalDriver } from '../../goals/driver.js'
import { captureGoalMaterializationSource, scheduleNativeGoalTick } from '../../goals/materialization-source.js'
import { createGoalBriefBoundary } from '../../briefs/context.js'
import { resolveGoalAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { armQualifiedTaskGoal, readExecutionSources, resumeAssignedExecution, type EntryDeps } from '../../goals/execution-qualification.js'
import { buildWorkflowToolRegistry } from '../../workflow/mcp-bridge.js'
import { advanceWorkflowRun } from '@use-brian/core'
import { createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { advanceRoutineIntake, answerRoutineQuestion, ensureRoutineQuestion, noteRoutinePlanningUsage,
  routineExecutionDeps, routineManifestScope, verifyRoutineExecution } from '../routine-execution.js'
import { controlExecution, type ControlEffects } from '../execution-control.js'
import { admitRoutineRun } from '../routine-intake.js'
import { applyRoutineProposal, prepareRoutineProposal, setRoutineIntakeEnabled } from '../routine-proposals.js'
import { setup, activate, sourceRun } from './routine-fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const capabilities = createDbCapabilityStore()
const approvals = createPendingApprovalsStore()
afterAll(async () => { await getAppPool().end(); await pool.end() })

const draft = (): ExecutionPlanDraft => ({ outcome: 'Prepare a fictional case summary', constraints: [],
  steps: [{ title: 'Read the admitted case', contribution: 'Prepare its summary' }], completionEvidence: ['Summary saved'],
  requiredOperations: ['getTask'], requiredAccounts: [], requiredInputs: [{ name: 'destination', provided: true }], questions: [] })

async function executionFixture(options: { waiting?: boolean; human?: boolean; noRoute?: boolean; readyMode?: boolean } = {}) {
  const s = await setup()
  await s.f.edge('assistant', s.f.assistants.ops)
  await capabilities.grant({ assistantId: s.f.assistants.ops, capability: 'tasks', grantedByUserId: s.actor.userId })
  const memberId = (await pool.query('SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [s.f.workspaceId, s.actor.userId])).rows[0].id
  s.configuration.definition.defaultExecutor = options.human
    ? { kind: 'person', memberId } : { kind: 'assistant', assistantId: s.f.assistants.ops }
  s.configuration.definition.taskIntake.permittedActions.push('getTask')
  if (options.readyMode) await pool.query(`INSERT INTO workspace_access_policies(workspace_id,access_mode,setup_state,default_department_id)
    VALUES($1,'simple','ready',$2) ON CONFLICT(workspace_id) DO UPDATE SET access_mode='simple',setup_state='ready',default_department_id=$2`, [s.f.workspaceId, s.f.finance])
  if (options.waiting) s.configuration.definition.taskIntake.blueprint.inputs.push({ key: 'destination',
    label: 'Where should the summary go?', path: 'event.destination', required: true })
  await activate(s)
  const authVersion = (await pool.query('SELECT auth_version FROM users WHERE id=$1', [s.actor.userId])).rows[0].auth_version
  const session = options.noRoute ? null : await createPersonalWebSession({ assistantId: s.f.assistants.brian,
    userId: s.actor.userId, channelType: 'web', channelId: randomUUID(), workspaceId: s.f.workspaceId, appOrigin: 'chat',
    contextGroupId: s.f.finance, contextProjectId: null }, { actorUserId: s.actor.userId, authSessionId: s.actor.authSessionId, authVersion })
  const source = await createTask(s.actor.userId, { workspaceId: s.f.workspaceId, title: `Fictional input ${randomUUID()}`,
    home: { kind: 'department', id: s.f.finance }, compartments: [`team:${s.f.finance}`],
    sourceSessionId: session?.id, visibility: { userId: null, assistantId: null } })
  const { run } = await sourceRun(s, source)
  const taskTools = createTaskTools(createDbTaskStore())
  const firstParty = new Map(Object.values(taskTools).map(t => [t.name, t]))
  const planner = vi.fn(async () => { noteRoutinePlanningUsage(0.02); return draft() }) // provider/effect boundary only
  const driver = createGoalDriver({ goalStore: createDbGoalStore(), tryClaim: tryClaimGoalForTick,
    sessionCostUsd: async () => 0, meteringAvailable: () => true,
    dispatchRun: async () => { throw new Error('Provider dispatch is outside kickoff') }, deliver: async () => {},
    scheduleGoalTick: (goal, at, state) => scheduleNativeGoalTick(createDbJobStore(), goal, at, state),
    getAwaitingEvent: async () => null, setAwaitingEvent: setGoalAwaitingEventSystem, clearAwaitingEvent: clearGoalAwaitingEventSystem,
    executeWithAuthority: async (goal, operation) => (await resolveGoalAuthoritySystem(goal)).executeWithAuthority(operation),
    briefBoundary: createGoalBriefBoundary(), now: () => new Date() })
  const kickoff = vi.fn(driver.kickoffGoal)
  const deps: EntryDeps = routineExecutionDeps({
    executorUsable: async (actor, workspace, assistant) => (await pool.query(`SELECT EXISTS(SELECT 1 FROM assistants
      WHERE id=$3 AND workspace_id=$2 AND kind<>'app' AND public.assistant_placement_visible($1,id)) AS ok`, [actor, workspace, assistant])).rows[0].ok,
    manifest: async (assistantId, workspaceId, actor, task) => {
      const turnScope = task ? await routineManifestScope(actor, task) : null
      if (!turnScope) return null
      const registry = await buildWorkflowToolRegistry({ firstParty, connectorStore: createDbConnectorStore(null),
        settingsStore: createDbMcpSettingsStore(), assistantConnectorStore: createDbAssistantConnectorStore(),
        connectorGrantStore: createConnectorGrantStore(), connectorInstanceStore: createConnectorInstanceStore(null) },
      { assistantId, workspaceId, userId: actor, turnScope })
      const active = new Set(await capabilities.listActive(assistantId))
      return { tools: new Set([...registry.values()].filter(t => !t.requiresCapability || active.has(t.requiresCapability)).map(t => t.name)),
        accounts: new Set<string>() }
    },
    readSources: readExecutionSources, planner,
    captureAuthority: async () => { throw new Error('Routine continuation must use its retained mandate') },
    defaultBudget: async workspace => (await createGoalDefaultBudgetStore().get(workspace)).budget,
    armGoal: input => armQualifiedTaskGoal(input, async (goal, userId) => buildOneStepReminderWorkflow(s.store, {
      userId, workspaceId: goal.workspaceId, assistantId: goal.authoringAuthority!.assistantId,
      instructions: 'Read the admitted case.', tools: ['getTask'], authoringAuthority: goal.authoringAuthority!,
      captureGoalSource: material => captureGoalMaterializationSource(goal.id, 'completion_workflow', material),
      contextGroupId: goal.contextGroupId, contextProjectId: goal.contextProjectId })),
    kickoffGoal: kickoff,
  }, async () => true) // OSS has no hosted credit overlay
  const effects: ControlEffects = { afterControl: async (state, kind) => {
    if (kind === 'pause' || !state.taskId || state.goalId) return
    const task = await getTaskByIdSystem(state.taskId)
    if (!task) return
    await resumeAssignedExecution(state.id, task, deps)
    const current = await getExecutionSystem(state.id)
    if (current && !current.goalId) await ensureRoutineQuestion(current, approvals)
  } }
  const intake = () => advanceRoutineIntake(run.id, deps, approvals)
  return { ...s, source, run, session, deps, effects, planner, kickoff, intake, memberId }
}

describe('[COMP:api/routine-intake-execution] native receipt-backed entry and continuation (real PG)', () => {
  it('I07/I12: material executor edits never retarget an existing Task or refresh its original allowance',async()=>{
    const s=await executionFixture()
    const result=(await s.intake())!
    const state=(await findActiveNativeExecutionSystem({taskId:result.taskId}))!
    const before=await getPoolSystem(state.poolId)
    await capabilities.grant({assistantId:s.f.assistants.brian,capability:'tasks',grantedByUserId:s.actor.userId})
    const next={...s.configuration,definition:{...s.configuration.definition,defaultExecutor:{kind:'assistant' as const,assistantId:s.f.assistants.brian}}}
    const proposal=await prepareRoutineProposal(s.actor.userId,s.workflow.id,{configuration:next,expectedRevision:1,
      idempotencyKey:randomUUID(),rationale:'Human-selected future executor change'})
    await applyRoutineProposal(s.actor,proposal.id,{expectedRevision:1,idempotencyKey:randomUUID()})
    await s.intake()
    expect(await getTaskByIdSystem(result.taskId)).toMatchObject({executorAssistantId:s.f.assistants.ops})
    expect(await getExecutionSystem(state.id)).toMatchObject({goalId:state.goalId,poolId:state.poolId,executor:state.executor})
    expect(await getPoolSystem(state.poolId)).toEqual(before)
    expect(s.planner).toHaveBeenCalledOnce()
  })

  it('I06/I12: reviewed disable/re-enable and event replay cannot clear a Task pause or renew its allowance',async()=>{
    const s=await executionFixture({waiting:true})
    const result=(await s.intake())!
    const state=(await findActiveNativeExecutionSystem({taskId:result.taskId}))!
    await controlExecution({userId:s.actor.userId,kind:'user',id:s.actor.userId,origin:'ui',human:true},s.f.workspaceId,state.id,
      {action:'pause',expectedRevision:state.controlRevision,interventionId:randomUUID()},s.effects)
    const paused=await getExecutionSystem(state.id),allowance=await getPoolSystem(state.poolId)
    await setRoutineIntakeEnabled(s.actor,s.workflow.id,{enabled:false,expectedRevision:1,idempotencyKey:randomUUID()})
    await setRoutineIntakeEnabled(s.actor,s.workflow.id,{enabled:true,expectedRevision:1,idempotencyKey:randomUUID()})
    await s.intake()
    expect(await getExecutionSystem(state.id)).toEqual(paused)
    expect(await getPoolSystem(state.poolId)).toEqual(allowance)
    expect(s.planner).not.toHaveBeenCalled();expect(s.kickoff).not.toHaveBeenCalled()
  })
  it('I01/I09: ready entry arms the selected executor through canonical Goal writers and meters planning on one root pool', async () => {
    const s = await executionFixture()
    const result = (await s.intake())!
    const state = (await findActiveNativeExecutionSystem({ taskId: result.taskId }))!
    expect(state.goalId).toBeTruthy()
    expect(state.executor).toEqual({ kind: 'assistant', id: s.f.assistants.ops })
    const goal = (await getGoalByIdSystem(state.goalId!))!
    expect(goal.authoringAuthority?.assistantId).toBe(s.f.assistants.ops)
    expect(goal.confirmedAt).not.toBeNull()
    expect(goal.contextGroupId).toBe(s.f.finance)
    expect(s.kickoff).toHaveBeenCalledOnce()
    const allowance = (await getPoolSystem(state.poolId))!
    expect(allowance.lifetime).toMatchObject({ iterations: 1, spent: 0.02 })
    const completion = (await s.store.findByIdSystem(goal.means.workflowId!))!
    expect(completion.definition.steps[0]).toMatchObject({ type: 'assistant_call', target: { assistantId: s.f.assistants.ops }, tools: ['getTask'] })
    expect(await s.intake()).toMatchObject({ taskId: result.taskId, receiptId: result.receiptId })
    expect(s.planner).toHaveBeenCalledOnce()
    expect((await getPoolSystem(state.poolId))!.segments).toHaveLength(1)
    expect((await pool.query('SELECT assistant_id,user_id,context_group_id FROM scheduled_jobs WHERE channel_id=$1', [goal.id])).rows)
      .toEqual([expect.objectContaining({ assistant_id: s.f.assistants.ops, user_id: s.actor.userId, context_group_id: s.f.finance })])
  })

  it('I01/I12: ready access mode uses real inherited Goal means and tick writers, without a human-configuration fallback', async () => {
    const s = await executionFixture({ readyMode: true })
    const result = (await s.intake())!
    const state = (await findActiveNativeExecutionSystem({ taskId: result.taskId }))!
    expect(state.goalId).toBeTruthy()
    expect(state.phase).toBe('ready')
    expect((await pool.query('SELECT assistant_id,user_id FROM scheduled_jobs WHERE channel_id=$1', [state.goalId])).rows)
      .toEqual([{ assistant_id: s.f.assistants.ops, user_id: s.actor.userId }])
    const goal = (await getGoalByIdSystem(state.goalId!))!
    const means = (await s.store.findByIdSystem(goal.means.workflowId!))!
    await expect(s.store.create({ workspaceId: s.f.workspaceId, userId: s.actor.userId, name: 'Forged Goal source',
      definition: means.definition, trigger: { kind: 'manual' }, contextGroupId: s.f.finance,
      contextProjectId: null, authoringAuthority: means.authoringAuthority! }, { sourceGoal: {} })).rejects.toThrow('goal_source_scope_unavailable')
    expect(s.kickoff).toHaveBeenCalledOnce()
  })

  it('I03/I04/I06: one admitted waiting question, then an attributed answer continues after disable on the same pool', async () => {
    const s = await executionFixture({ waiting: true })
    const result = (await s.intake())!
    const state = (await findActiveNativeExecutionSystem({ taskId: result.taskId }))!
    expect(state).toMatchObject({ phase: 'waiting', goalId: null })
    expect(s.planner).not.toHaveBeenCalled()
    expect(s.kickoff).not.toHaveBeenCalled()
    expect((await getPoolSystem(state.poolId))!.lifetime.iterations).toBe(0)
    const pending = await approvals.listPendingForWorkspace(s.actor.userId, s.f.workspaceId)
    expect(pending).toHaveLength(1)
    expect(pending[0].approvalPayload).toMatchObject({ operation: 'routine_input', sourceTaskId: result.taskId })
    await s.intake()
    expect(await approvals.listPendingForWorkspace(s.actor.userId, s.f.workspaceId)).toHaveLength(1)
    await s.store.update(s.actor.userId, s.workflow.id, { enabled: false })
    const answer = (await approvals.recordAnswer(pending[0].id, 'Use the existing case note as the destination.', s.actor.userId))!
    await answerRoutineQuestion(answer, s.effects)
    const continued = (await getExecutionSystem(state.id))!
    expect(continued.goalId).toBeTruthy()
    expect(continued.poolId).toBe(state.poolId)
    expect(continued.steering).toContainEqual(expect.objectContaining({ byUserId: s.actor.userId }))
    expect((await getPoolSystem(state.poolId))!.segments).toHaveLength(2)
    await answerRoutineQuestion(answer, s.effects)
    expect((await getPoolSystem(state.poolId))!.segments).toHaveLength(2)
    expect(s.planner).toHaveBeenCalledOnce()
    const task = (await getTaskByIdSystem(result.taskId))!
    expect(task.executorAssistantId).toBe(s.f.assistants.ops)
  })

  it('I03/I04: no admitted chat is a visible routing blocker; human-owned work creates no AI pursuit', async () => {
    const s = await executionFixture({ waiting: true, noRoute: true })
    const result = (await s.intake())!
    expect(await findActiveNativeExecutionSystem({ taskId: result.taskId })).toMatchObject({ phase: 'waiting', goalId: null,
      blocker: { reason: 'input_route_unavailable' } })
    expect((await pool.query('SELECT count(*)::int n FROM pending_approvals WHERE workspace_id=$1 AND kind=\'question\'', [s.f.workspaceId])).rows[0].n).toBe(0)
    const human = await executionFixture({ human: true })
    const tracked = (await human.intake())!
    expect(await getTaskByIdSystem(tracked.taskId)).toMatchObject({ assigneeId: human.memberId, executorAssistantId: null })
    expect(await findActiveNativeExecutionSystem({ taskId: tracked.taskId })).toBeNull()
    expect(human.planner).not.toHaveBeenCalled()
    expect(human.kickoff).not.toHaveBeenCalled()
  })

  it('I04/I10: source revocation hides the question, rejects continuation, and fences an already armed Goal lease', async () => {
    const s = await executionFixture({ waiting: true })
    const result = (await s.intake())!
    const state = (await findActiveNativeExecutionSystem({ taskId: result.taskId }))!
    await pool.query('UPDATE tasks SET scope_held=true WHERE id=$1', [s.source.id])
    expect(await queryWithRLS(s.actor.userId, 'SELECT id FROM task_execution_states WHERE id=$1', [state.id])).toMatchObject({ rows: [] })
    expect(await approvals.listPendingForWorkspace(s.actor.userId, s.f.workspaceId)).toHaveLength(0)
    expect(await verifyRoutineExecution((await getTaskByIdSystem(result.taskId))!, state.authoringRef as never)).toBeNull()
    expect(await resumeAssignedExecution(state.id, (await getTaskByIdSystem(result.taskId))!, s.deps)).toMatchObject({ kind: 'not_entered' })
    expect(s.planner).not.toHaveBeenCalled()
    const ready = await executionFixture()
    const armed = (await ready.intake())!
    const goal = (await getGoalByIdSystem((await findActiveNativeExecutionSystem({ taskId: armed.taskId }))!.goalId!))!
    const lease = await resolveGoalAuthoritySystem(goal)
    await pool.query('UPDATE tasks SET scope_held=true WHERE id=$1', [ready.source.id])
    await expect(lease.executeWithAuthority(async () => 'effect')).rejects.toThrow()
    await expect(resolveGoalAuthoritySystem(goal)).rejects.toThrow()
  })

  it('I04: losing a required capability leaves an honest blocker without arming', async () => {
    const s = await executionFixture({ waiting: true })
    const result = (await s.intake())!
    const state = (await findActiveNativeExecutionSystem({ taskId: result.taskId }))!
    const grant = (await pool.query('SELECT id FROM assistant_capabilities WHERE assistant_id=$1 AND capability=\'tasks\' AND revoked_at IS NULL', [s.f.assistants.ops])).rows[0]
    await capabilities.revoke({ grantId: grant.id, revokedByUserId: s.actor.userId })
    const q = (await approvals.listPendingForWorkspace(s.actor.userId, s.f.workspaceId))[0]
    await answerRoutineQuestion((await approvals.recordAnswer(q.id, 'Use the existing case note.', s.actor.userId))!, s.effects)
    expect(await getExecutionSystem(state.id)).toMatchObject({ phase: 'blocked', goalId: null, blocker: { reason: 'missing_operation', detail: 'getTask' } })
    expect(s.kickoff).not.toHaveBeenCalled()
  })

  it('I09: a necessary child shares the root allowance and cannot multiply the limit', async () => {
    const s = await executionFixture()
    const result = (await s.intake())!
    const root = (await findActiveNativeExecutionSystem({ taskId: result.taskId }))!
    const child = await deriveChildExecutionSystem(root.id, 'necessary-source-review', { taskId: root.taskId,
      executor: root.executor, plan: {}, sourceRefs: [], phase: 'ready' })
    expect(child.state.poolId).toBe(root.poolId)
    await pool.query('UPDATE task_execution_pools SET max_iterations=2 WHERE id=$1', [root.poolId])
    const attempt = await beginIterationSystem(child.state.id)
    expect(attempt.kind).toBe('proceed')
    if (attempt.kind !== 'proceed') throw new Error('Expected native shared reservation')
    await settleIterationSystem(child.state.id, { attemptId: attempt.inFlight.attemptId, actualSpend: 0.01, checkpoint: null,
      nextPhase: 'ready', streaks: child.state.streaks })
    expect(await beginIterationSystem(root.id)).toMatchObject({ kind: 'exhausted', reason: 'max_iterations' })
    expect((await getPoolSystem(root.poolId))!.segments).toHaveLength(1)
  })

  it('I05/I06: replay recovers the initial handoff after Task commit, without reauthoring after disable', async () => {
    const s = await executionFixture()
    const committed = await admitRoutineRun(s.run.id)
    expect(committed.kind).toBe('created')
    if (committed.kind !== 'created') throw new Error('Expected canonical intake')
    expect(await findActiveNativeExecutionSystem({ taskId: committed.task.id })).toBeNull()
    await s.store.update(s.actor.userId, s.workflow.id, { enabled: false })
    const resumed = (await s.intake())!
    expect(resumed.taskId).toBe(committed.task.id)
    expect(await findActiveNativeExecutionSystem({ taskId: committed.task.id })).toMatchObject({ goalId: expect.any(String) })
    expect(s.planner).toHaveBeenCalledOnce()
    await s.intake()
    expect(s.planner).toHaveBeenCalledOnce()
  })

  it('I12: cancelling a Task-bound question pauses its native state without renewing or resuming a chat tool', async () => {
    const s = await executionFixture({ waiting: true })
    const result = (await s.intake())!
    const state = (await findActiveNativeExecutionSystem({ taskId: result.taskId }))!
    const question = (await approvals.listPendingForWorkspace(s.actor.userId, s.f.workspaceId))[0]
    const cancelled = (await approvals.respond(question.id, 'rejected', s.actor.userId, 'cancelled'))!
    await answerRoutineQuestion(cancelled, s.effects)
    expect(await getExecutionSystem(state.id)).toMatchObject({ phase: 'paused', goalId: null })
    expect((await getPoolSystem(state.poolId))!.segments).toHaveLength(1)
    await s.intake()
    expect(s.planner).not.toHaveBeenCalled()
    expect(s.kickoff).not.toHaveBeenCalled()
  })

  it('I03: an explicit continue replaces the stale question, while replay keeps one current pickup', async () => {
    const s = await executionFixture({ waiting: true })
    const result = (await s.intake())!
    const state = (await findActiveNativeExecutionSystem({ taskId: result.taskId }))!
    const old = (await approvals.listPendingForWorkspace(s.actor.userId, s.f.workspaceId))[0]
    await controlExecution({ userId: s.actor.userId, kind: 'user', id: s.actor.userId, origin: 'ui', human: true }, s.f.workspaceId,
      state.id, { action: 'continue', expectedRevision: state.controlRevision, interventionId: randomUUID() }, s.effects)
    const current = await approvals.listPendingForWorkspace(s.actor.userId, s.f.workspaceId)
    expect(current).toHaveLength(1)
    expect(current[0].id).not.toBe(old.id)
    expect((await approvals.getById(s.actor.userId, old.id))?.status).toBe('superseded')
    await s.intake()
    expect(await approvals.listPendingForWorkspace(s.actor.userId, s.f.workspaceId)).toHaveLength(1)
    expect(s.planner).not.toHaveBeenCalled()
    expect((await getPoolSystem(state.poolId))!.segments).toHaveLength(2)
  })

  it('I12: questions, execution and the original allowance follow the canonical Task head', async () => {
    const s = await executionFixture({ waiting: true })
    const result = (await s.intake())!
    const state = (await findActiveNativeExecutionSystem({ taskId: result.taskId }))!
    const question = (await approvals.listPendingForWorkspace(s.actor.userId, s.f.workspaceId))[0]
    const head = (await updateTask(s.actor.userId, result.taskId, { attributes: { description: 'Human precision edit' } }))!
    expect(head.id).not.toBe(result.taskId)
    expect(await getExecutionSystem(state.id)).toMatchObject({ taskId: head.id, poolId: state.poolId })
    expect(await approvals.getById(s.actor.userId, question.id)).not.toBeNull()
    await answerRoutineQuestion((await approvals.recordAnswer(question.id, 'Use the existing case note.', s.actor.userId))!, s.effects)
    expect(await getExecutionSystem(state.id)).toMatchObject({ taskId: head.id, goalId: expect.any(String), poolId: state.poolId })
    expect((await getPoolSystem(state.poolId))!.segments).toHaveLength(2)
  })

  it('I05/I12: a human pause fences an in-flight planner, including replay, while late usage stays in the original pool', async () => {
    const s = await executionFixture()
    let release!: () => void
    let entered!: () => void
    const start = new Promise<void>(resolve => { entered = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    s.planner.mockImplementationOnce(async () => { entered(); await wait; noteRoutinePlanningUsage(0.03); return draft() })
    const intake = s.intake()
    await start
    const state = (await pool.query('SELECT id,task_id FROM task_execution_states WHERE workspace_id=$1 AND parent_state_id IS NULL', [s.f.workspaceId])).rows[0]
    const current = (await getExecutionSystem(state.id))!
    await controlExecution({ userId: s.actor.userId, kind: 'user', id: s.actor.userId, origin: 'ui', human: true }, s.f.workspaceId,
      current.id, { action: 'pause', expectedRevision: current.controlRevision, interventionId: randomUUID() }, s.effects)
    release()
    await intake
    expect(await getExecutionSystem(current.id)).toMatchObject({ phase: 'paused', goalId: null })
    expect((await getPoolSystem(current.poolId))!.lifetime).toMatchObject({ spent: 0.03, iterations: 1 })
    await s.intake()
    expect(await getExecutionSystem(current.id)).toMatchObject({ phase: 'paused', goalId: null })
    expect((await getPoolSystem(current.poolId))!.segments).toHaveLength(1)
    expect(s.planner).toHaveBeenCalledOnce()
    expect(s.kickoff).not.toHaveBeenCalled()
  })

  it('I03: the native runner consumes intake once and never also executes definition steps', async () => {
    const s = await executionFixture({ waiting: true })
    const registry = vi.fn(async () => new Map())
    const outcome = await advanceWorkflowRun({ workflowStore: s.store, runStore: createDbWorkflowRunStore(),
      routineIntake: s.intake, buildToolRegistry: registry, resolvePrimary: async () => s.f.assistants.brian,
      consultTransport: { consult: async () => { throw new Error('No affected execution before readiness') } } as never }, s.run.id)
    expect(outcome).toMatchObject({ kind: 'completed', stepCount: 0 })
    expect(registry).not.toHaveBeenCalled()
    expect((await pool.query('SELECT count(*)::int n FROM workflow_step_runs WHERE run_id=$1', [s.run.id])).rows[0].n).toBe(0)
  })
})
