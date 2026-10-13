import { describe, expect, it } from 'vitest'
import {
  assessExecutionReadiness,
  classifyIteration,
  decideExecution,
  evidenceFingerprint,
  isTrustedProvenance,
  iterationSpendEstimate,
  reserveIteration,
  type ExecutionPlanDraft,
} from '../execution.js'

const plan = (over: Partial<ExecutionPlanDraft> = {}): ExecutionPlanDraft => ({
  outcome: 'Book the fictional offsite venue', constraints: [], steps: [{ title: 'Compare venues', contribution: 'shortlist' }],
  completionEvidence: ['booking confirmation id'], requiredOperations: ['webSearch'], requiredAccounts: [],
  requiredInputs: [{ name: 'date range', provided: true }], questions: [], ...over,
})
const manifest = (tools: string[], accounts: string[] = []) => ({ tools: new Set(tools), accounts: new Set(accounts) })

describe('[COMP:goals/execution-qualification] readiness against the actual manifest', () => {
  it('is ready only when every required operation and account is really present', () => {
    expect(assessExecutionReadiness({ plan: plan(), manifest: manifest(['webSearch']), inaccessibleSources: [], dependencies: [], contextSparse: false }))
      .toEqual({ state: 'ready', reasons: [] })
    const r = assessExecutionReadiness({ plan: plan({ requiredOperations: ['webSearch', 'bookVenue'], requiredAccounts: ['calendar'] }),
      manifest: manifest(['webSearch']), inaccessibleSources: [], dependencies: [], contextSparse: false })
    expect(r.state).toBe('unavailable')
    expect(r.reasons).toEqual([{ kind: 'missing_operation', subject: 'bookVenue' }, { kind: 'missing_account', subject: 'calendar' }])
  })

  it('keeps missing input, sparse context, inaccessible sources and executor loss distinct', () => {
    const r = assessExecutionReadiness({ plan: plan({ requiredInputs: [{ name: 'budget', provided: false }], questions: ['Which city?'] }),
      manifest: manifest(['webSearch']), inaccessibleSources: ['page:p-9'], dependencies: [], contextSparse: false })
    expect(r).toEqual({ state: 'uncertain', reasons: [
      { kind: 'missing_input', subject: 'budget' }, { kind: 'missing_input', subject: 'Which city?' },
      { kind: 'inaccessible_source', subject: 'page:p-9' }] })
    expect(assessExecutionReadiness({ plan: plan(), manifest: manifest(['webSearch']), inaccessibleSources: [], dependencies: [], contextSparse: true }).reasons)
      .toEqual([{ kind: 'insufficient_context', subject: 'request' }])
    expect(assessExecutionReadiness({ plan: plan(), manifest: null, inaccessibleSources: [], dependencies: [], contextSparse: false }))
      .toEqual({ state: 'unavailable', reasons: [{ kind: 'executor_unavailable', subject: 'executor' }] })
    expect(assessExecutionReadiness({ plan: plan({ completionEvidence: [] }), manifest: manifest(['webSearch']), inaccessibleSources: [], dependencies: [], contextSparse: false }).state)
      .toBe('uncertain')
  })

  it('waits on open, missing or cancelled prerequisites without calling them done', () => {
    for (const status of ['open', 'missing', 'cancelled'] as const) {
      const r = assessExecutionReadiness({ plan: plan(), manifest: manifest(['webSearch']), inaccessibleSources: [],
        dependencies: [{ taskId: 't-1', status, owner: 'person' }], contextSparse: false })
      expect(r).toEqual({ state: 'waiting', reasons: [{ kind: 'dependency_open', subject: 't-1', detail: status }] })
    }
  })

  it('accepts only a human assignment as trusted provenance', () => {
    expect(isTrustedProvenance({ kind: 'human_assignment', actorUserId: 'u-1', origin: 'ui', at: '2026-10-13T00:00:00Z' })).toBe(true)
    expect(isTrustedProvenance({ kind: 'human_assignment', actorUserId: 'u-1', origin: 'mcp', at: 'x' })).toBe(false)
    expect(isTrustedProvenance({ kind: 'extraction', actorUserId: 'u-1', origin: 'ui', at: 'x' })).toBe(false)
    expect(isTrustedProvenance(null)).toBe(false)
  })
})

describe('[COMP:goals/execution-checkpoint] iteration classification and limits', () => {
  const fp = (refs: string[]) => evidenceFingerprint({ artifacts: refs.map(ref => ({ kind: 'page', ref })), completedEffects: [], checkedResults: [] })

  it('requires new checked evidence for progress; a reworded or shrunken checkpoint is not progress', () => {
    expect(classifyIteration({ previousFingerprint: '', fingerprint: fp(['a']) })).toBe('progress')
    expect(classifyIteration({ previousFingerprint: fp(['a']), fingerprint: fp(['a']) })).toBe('no_progress')
    expect(classifyIteration({ previousFingerprint: fp(['a', 'b']), fingerprint: fp(['a']) })).toBe('no_progress')
    expect(classifyIteration({ previousFingerprint: fp(['a']), fingerprint: fp(['a']), waiting: true })).toBe('waiting')
    expect(classifyIteration({ previousFingerprint: '', fingerprint: fp(['a']), blocker: { kind: 'missing_account', subject: 'x' } })).toBe('blocker')
    expect(classifyIteration({ previousFingerprint: '', fingerprint: '', transientFault: true })).toBe('transient')
    expect(evidenceFingerprint({ artifacts: [], completedEffects: [], checkedResults: ['Sent ', 'sent'] })).toBe('c:sent')
  })

  it('stops a blocker immediately and caps no-progress at 3 and transient faults at 5', () => {
    expect(decideExecution('blocker', { noProgress: 0, transient: 0 }, {}, { kind: 'missing_input', subject: 'date' }))
      .toMatchObject({ decision: 'blocked', reason: 'missing_input: date' })
    let s = { noProgress: 0, transient: 0 }
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) { const d = decideExecution('no_progress', s); s = d.streaks; outcomes.push(d.decision) }
    expect(outcomes).toEqual(['continue', 'continue', 'blocked'])
    s = { noProgress: 2, transient: 0 }
    expect(decideExecution('progress', s)).toMatchObject({ decision: 'continue', resume: 'now', streaks: { noProgress: 0 } })
    expect(decideExecution('waiting', s)).toMatchObject({ decision: 'continue', resume: 'wait', streaks: { noProgress: 2 } })
    s = { noProgress: 0, transient: 4 }
    expect(decideExecution('transient', s)).toMatchObject({ decision: 'blocked', reason: 'transient_retries_exhausted' })
  })
})

describe('[COMP:goals/allowance-tree] segment reservation arithmetic', () => {
  it('counts outstanding reservations against headroom', () => {
    expect(reserveIteration({ maxSpend: 1, maxIterations: 2 }, { spent: 0, iterations: 1, reservedSpend: 0, reservedIterations: 1 }, 0.1))
      .toEqual({ ok: false, reason: 'max_iterations' })
    expect(reserveIteration({ maxSpend: 1, maxIterations: null }, { spent: 0.7, iterations: 0, reservedSpend: 0.25, reservedIterations: 1 }, 0.1))
      .toEqual({ ok: true, spend: 0.05, iterations: 1 })
    expect(reserveIteration({ maxSpend: 1, maxIterations: null }, { spent: 0.8, iterations: 0, reservedSpend: 0.2, reservedIterations: 0 }, 0.1))
      .toEqual({ ok: false, reason: 'max_spend' })
  })

  it('estimates from observed history, else a bounded default', () => {
    expect(iterationSpendEstimate(0, 0)).toBe(0.05)
    expect(iterationSpendEstimate(0.9, 3)).toBe(0.3)
  })
})

describe('[COMP:goals/execution-qualification] planner parsing is fail-closed', () => {
  it('accepts a complete plan and rejects anything else', async () => {
    const { parseExecutionPlan } = await import('../planner.js')
    const plan = parseExecutionPlan('Here: {"outcome":"Venue booked","steps":[{"title":"Shortlist","contribution":"options"}],"completionEvidence":["booking id"],"requiredOperations":["webSearch"]}')
    expect(plan).toMatchObject({ outcome: 'Venue booked', constraints: [], requiredAccounts: [], questions: [], completionEvidence: ['booking id'] })
    expect(parseExecutionPlan('no json')).toBeNull()
    expect(parseExecutionPlan('{"outcome":""}')).toBeNull()
    expect(parseExecutionPlan('{"steps":[]}')).toBeNull()
  })
})
