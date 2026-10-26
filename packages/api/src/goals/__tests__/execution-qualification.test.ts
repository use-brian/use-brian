/**
 * Qualification and automatic entry with the real readiness core and bounded
 * fake planner / manifest / source traces. The execution store is mocked here;
 * the real-database entry path is asserted by the journeys suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionPlanDraft, ExecutionProvenance } from '@use-brian/core'

const store = vi.hoisted(() => ({
  findActiveNativeExecutionSystem: vi.fn(),
  createRootExecution: vi.fn(),
  bindExecutionGoalSystem: vi.fn(),
  setExecutionPhaseSystem: vi.fn(),
  getExecutionSystem: vi.fn(),
}))
vi.mock('../../db/task-execution-store.js', () => store)
vi.mock('../../briefs/service.js', () => ({ inspectBrief: vi.fn() }))
vi.mock('../../db/client.js', () => ({ query: async () => { throw new Error('Unexpected direct database query in execution-qualification fixture') }, queryWithRLS: vi.fn() }))

const { qualifyTaskExecution, enterAssignedExecution, briefFromPlan } = await import('../execution-qualification.js')

const ASSISTANT = '11111111-1111-4111-8111-111111111111'
const task = (over = {}) => ({
  id: 't-1', workspaceId: 'w-1', title: 'Compare three fictional venues for the offsite and book one',
  attributes: { dates: 'next month' }, executorAssistantId: ASSISTANT as string | null, parentId: null, home: null, ...over,
})
const draft = (over: Partial<ExecutionPlanDraft> = {}): ExecutionPlanDraft => ({
  outcome: 'A venue is booked', constraints: ['under budget'], steps: [{ title: 'Shortlist venues', contribution: 'options' }],
  completionEvidence: ['booking confirmation id'], requiredOperations: ['webSearch'], requiredAccounts: [],
  requiredInputs: [], questions: [], ...over,
})
const provenance: ExecutionProvenance = { kind: 'human_assignment', actorUserId: 'u-1', origin: 'ui', at: '2026-10-13T08:00:00.000Z' }

function deps(over: Record<string, unknown> = {}) {
  const planner = vi.fn(async () => draft())
  return {
    planner,
    executorUsable: vi.fn(async () => true),
    manifest: vi.fn(async () => ({ tools: new Set(['webSearch', 'saveTask']), accounts: new Set<string>() })),
    readSources: vi.fn(async () => ({ sources: [{ kind: 'task' as const, id: 't-1' }], inaccessible: [], context: 'Request: ...', sparse: false, dependencies: [] })),
    captureAuthority: vi.fn(async () => ({ version: 1 as const, assistantId: ASSISTANT, ceiling: {} as never })),
    defaultBudget: vi.fn(async () => ({ maxSpend: 5, maxIterations: 30 })),
    armGoal: vi.fn(async () => ({ id: 'g-1' }) as never),
    kickoffGoal: vi.fn(async () => {}),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.findActiveNativeExecutionSystem.mockResolvedValue(null)
  store.getExecutionSystem.mockResolvedValue({ id: 's-1', phase: 'ready' })
  store.createRootExecution.mockImplementation(async (input: { phase: string }) => ({ state: { id: 's-1', phase: input.phase }, created: true }))
  store.bindExecutionGoalSystem.mockImplementation(async (id: string, goalId: string) => ({ id, goalId }))
  store.setExecutionPhaseSystem.mockImplementation(async (id: string, phase: string, extra: unknown) => ({ id, phase, ...(extra as object) }))
})

describe('[COMP:goals/execution-qualification] qualification and automatic entry', () => {
  it('R01: human or unassigned work is not qualified and never reaches a planner', async () => {
    const d = deps()
    expect(await qualifyTaskExecution(task({ executorAssistantId: null }), 'u-1', d)).toEqual({ kind: 'not_assistant_work' })
    expect(d.planner).not.toHaveBeenCalled()
    expect(d.readSources).not.toHaveBeenCalled()
  })

  it('R01: plans for the selected assistant and surfaces an unusable executor without substitution', async () => {
    const d = deps()
    await qualifyTaskExecution(task(), 'u-1', d)
    expect(d.planner).toHaveBeenCalledWith(expect.objectContaining({ executorAssistantId: ASSISTANT }))
    const gone = deps({ executorUsable: vi.fn(async () => false) })
    const q = await qualifyTaskExecution(task(), 'u-1', gone)
    expect(q).toMatchObject({ kind: 'qualified', executorAssistantId: ASSISTANT, plan: { readiness: { state: 'unavailable', reasons: [{ kind: 'executor_unavailable' }] } } })
    expect(gone.planner).not.toHaveBeenCalled()
  })

  it('R02: carries grounded sources and asks consequential intent instead of inventing scope', async () => {
    const d = deps({
      readSources: vi.fn(async () => ({ sources: [{ kind: 'task', id: 't-1' }, { kind: 'brief', id: 'b-1', version: '4' }], inaccessible: [], context: 'Accepted goals: stay under budget', sparse: false, dependencies: [] })),
      planner: vi.fn(async () => draft({ questions: ['Which city should the venue be in?'] })),
    })
    const q = await qualifyTaskExecution(task(), 'u-1', d)
    expect(q.kind === 'qualified' && q.plan.sourceBasis.map(s => s.kind)).toEqual(['task', 'brief'])
    expect(q.kind === 'qualified' && q.plan.readiness).toEqual({ state: 'uncertain', reasons: [{ kind: 'missing_input', subject: 'Which city should the venue be in?' }] })
    const sparse = await qualifyTaskExecution(task({ title: 'Venue' }), 'u-1', deps({
      readSources: vi.fn(async () => ({ sources: [], inaccessible: [], context: 'Request: Venue', sparse: true, dependencies: [] })) }))
    expect(sparse.kind === 'qualified' && sparse.plan.readiness.reasons).toEqual([{ kind: 'insufficient_context', subject: 'request' }])
  })

  it('R03: a missing operation, account or source blocks; a confident plan cannot pass on labels', async () => {
    const d = deps({ planner: vi.fn(async () => draft({ requiredOperations: ['webSearch', 'bookVenue'], requiredAccounts: ['venue-portal'] })),
      readSources: vi.fn(async () => ({ sources: [], inaccessible: ['brief:project:p-1'], context: '', sparse: false, dependencies: [] })) })
    const q = await qualifyTaskExecution(task(), 'u-1', d)
    expect(q.kind === 'qualified' && q.plan.readiness).toEqual({ state: 'unavailable', reasons: [
      { kind: 'missing_operation', subject: 'bookVenue' }, { kind: 'missing_account', subject: 'venue-portal' },
      { kind: 'inaccessible_source', subject: 'brief:project:p-1' }] })
  })

  it('R03: an unclear outcome from the clarity gate becomes a question, not a pass', async () => {
    const d = deps({ assessClarity: vi.fn(async () => ({ clear: false, clarifyingQuestion: 'What counts as booked?' })) })
    const q = await qualifyTaskExecution(task(), 'u-1', d)
    expect(q.kind === 'qualified' && q.plan.readiness.state).toBe('uncertain')
  })

  it('R04: arms ready assigned work once through the canonical goal path for the assigning human', async () => {
    const d = deps()
    const r = await enterAssignedExecution(task(), provenance, d)
    expect(r).toMatchObject({ kind: 'entered', goalId: 'g-1', readiness: { state: 'ready' } })
    expect(d.captureAuthority).toHaveBeenCalledWith({ userId: 'u-1', workspaceId: 'w-1', assistantId: ASSISTANT })
    expect(d.armGoal).toHaveBeenCalledTimes(1)
    expect(d.kickoffGoal).toHaveBeenCalledWith('g-1')
    expect(store.createRootExecution).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'ready', executor: { kind: 'assistant', id: ASSISTANT }, budget: { maxSpend: 5, maxIterations: 30 },
      enter: expect.objectContaining({ actor: { kind: 'user', id: 'u-1', origin: 'assignment', humanOrigin: true } }),
    }))
  })

  it('R04: a duplicate event, missing provenance or prose mention never arms', async () => {
    store.findActiveNativeExecutionSystem.mockResolvedValueOnce({ id: 's-0' })
    const d = deps()
    expect(await enterAssignedExecution(task(), provenance, d)).toEqual({ kind: 'duplicate', state: { id: 's-0' } })
    expect(await enterAssignedExecution(task(), null, d)).toEqual({ kind: 'not_entered', reason: 'authority_unproven' })
    expect(await enterAssignedExecution(task(), { ...provenance, origin: 'mcp' } as never, d)).toEqual({ kind: 'not_entered', reason: 'authority_unproven' })
    expect(await enterAssignedExecution(task({ executorAssistantId: null }), provenance, d)).toEqual({ kind: 'not_entered', reason: 'not_assistant_work' })
    // A concurrent entry that lost the unique index arms nothing either.
    store.createRootExecution.mockResolvedValueOnce({ state: { id: 's-9' }, created: false })
    expect(await enterAssignedExecution(task(), provenance, d)).toEqual({ kind: 'duplicate', state: { id: 's-9' } })
    expect(d.armGoal).not.toHaveBeenCalled()
    expect(d.kickoffGoal).not.toHaveBeenCalled()
  })

  it('R04: work that is not ready is recorded with its smallest missing thing and stays unarmed', async () => {
    const d = deps({ planner: vi.fn(async () => draft({ requiredAccounts: ['calendar'] })) })
    const r = await enterAssignedExecution(task(), provenance, d)
    expect(r).toMatchObject({ kind: 'entered', goalId: null, readiness: { state: 'unavailable' } })
    expect(store.createRootExecution).toHaveBeenCalledWith(expect.objectContaining({ phase: 'blocked', blocker: { reason: 'missing_account', detail: 'calendar' } }))
    expect(d.armGoal).not.toHaveBeenCalled()
  })

  it('R18: an authority capture failure blocks honestly instead of leasing fresh authority', async () => {
    const d = deps({ captureAuthority: vi.fn(async () => { throw new Error('goal_authority_unavailable') }) })
    const r = await enterAssignedExecution(task(), provenance, d)
    expect(r).toMatchObject({ kind: 'entered', goalId: null, state: { phase: 'blocked', blocker: { reason: 'authority_unproven' } } })
    expect(d.kickoffGoal).not.toHaveBeenCalled()
  })

  it('R13: carries the task-specific completion evidence into the goal brief', () => {
    expect(briefFromPlan({ ...draft({ completionEvidence: ['booking confirmation id', 'calendar hold sent'] }), sourceBasis: [], dependencies: [], nextStep: null, readiness: { state: 'ready', reasons: [] } }))
      .toMatchObject({ verification: 'booking confirmation id\ncalendar hold sent', approach: '1. Shortlist venues: options' })
  })
})
