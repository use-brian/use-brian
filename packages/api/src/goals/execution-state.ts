/**
 * Execution state service: the durable side of a goal tick.
 *
 * The driver consumes this through its optional `executionLedger` port. When a
 * goal has a native task execution state, every tick:
 *   - reloads the durable state and reserves the iteration in the shared pool
 *     (`beginTick`), so loop counters come from the pool and checkpoint, never
 *     from the scheduled-job handoff: reaper recovery and duplicate kickoffs
 *     cannot start a fresh allowance;
 *   - settles it against the real ledger and classifies it (`endIteration`),
 *     replacing "the workflow completed, so it progressed";
 *   - refuses to finish `done` without checked completion evidence
 *     (`completionSatisfied`), so a status write cannot manufacture delivery.
 * A goal without an execution state keeps the legacy handoff behavior.
 *
 * Spec: docs/architecture/features/goals.md -> "Resumable task execution".
 * [COMP:goals/execution-checkpoint]
 */
import {
  classifyIteration,
  decideExecution,
  evidenceFingerprint,
  type ExecutionArtifact,
  type ExecutionCheckpoint,
  type ExecutionEffect,
  type GoalRecord,
  type ReadinessReason,
} from '@use-brian/core'
import {
  bindAttemptRunSystem,
  findActiveNativeExecutionSystem,
  getExecutionSystem,
  hasRetiredNativeExecutionSystem,
  setExecutionPhaseSystem,
  type ExecutionState,
} from '../db/task-execution-store.js'
import type { AllowanceTree } from './allowance-tree.js'

/** Evidence one iteration produced, as observed by the engine (not claimed). */
export type IterationEvidence = {
  summary?: string
  artifacts?: ExecutionArtifact[]
  completedEffects?: ExecutionEffect[]
  uncertainEffects?: ExecutionEffect[]
  checkedResults?: string[]
  nextStep?: string | null
  questions?: string[]
}

export type LedgerBegin =
  | { kind: 'legacy' }
  | { kind: 'proceed'; stateId: string; attemptId: string; loop: { iteration: number; spend: number; noProgressStreak: number } }
  | { kind: 'paused' }
  | { kind: 'retired' }
  | { kind: 'blocked'; reason: string }

export type LedgerIterationResult = {
  runId: string | null
  terminal: boolean
  waiting: boolean
  evidence?: IterationEvidence
  blocker?: ReadinessReason | null
  transientFault?: boolean
}

export type LedgerEnd = {
  progressed: boolean
  blockedReason: string | null
  fenced: boolean
  spend: number
}

export type ExecutionLedger = {
  beginTick(goal: GoalRecord): Promise<LedgerBegin>
  bindRun(stateId: string, attemptId: string, runId: string): Promise<void>
  endIteration(stateId: string, attemptId: string, result: LedgerIterationResult): Promise<LedgerEnd>
  /** Done requires checked completion evidence, not a status write. */
  completionSatisfied(goal: GoalRecord): Promise<boolean>
  onTerminal(goal: GoalRecord, terminal: 'done' | 'blocked', reason: string | null): Promise<void>
  /** Current phase of the goal's active native execution, or null. */
  phaseOf(goal: GoalRecord): Promise<ExecutionState['phase'] | null>
}

const unique = <T>(xs: T[], key: (x: T) => string) => [...new Map(xs.map(x => [key(x), x])).values()]

/** Fold one iteration's observed evidence onto the prior checkpoint. Evidence
 *  accumulates; only the summary, next step and questions are replaced. */
export function mergeCheckpoint(prior: ExecutionCheckpoint | null, state: ExecutionState, ev: IterationEvidence): ExecutionCheckpoint {
  const artifacts = unique([...(prior?.artifacts ?? []), ...(ev.artifacts ?? [])], a => `${a.kind}:${a.ref}:${a.version ?? ''}`)
  const completedEffects = unique([...(prior?.completedEffects ?? []), ...(ev.completedEffects ?? [])], e => `${e.operation}:${e.ref}`)
  const checkedResults = [...new Set([...(prior?.checkedResults ?? []), ...(ev.checkedResults ?? [])])]
  const uncertainEffects = unique([...(prior?.uncertainEffects ?? []), ...(ev.uncertainEffects ?? [])], e => `${e.operation}:${e.ref}`)
    .filter(u => !completedEffects.some(c => c.operation === u.operation && c.ref === u.ref))
  return {
    summary: ev.summary ?? prior?.summary ?? '',
    sourceRefs: prior?.sourceRefs ?? state.sourceRefs,
    artifacts, completedEffects, uncertainEffects, checkedResults,
    nextStep: ev.nextStep ?? prior?.nextStep ?? null,
    questions: ev.questions ?? prior?.questions ?? [],
    segment: prior?.segment ?? 1,
    evidenceFingerprint: evidenceFingerprint({ artifacts, completedEffects, checkedResults }),
    runLedger: prior?.runLedger ?? null,
  }
}

const norm = (s: string) => s.trim().toLowerCase()

/**
 * The original acceptance is met only by evidence: a verified completion claim
 * (the adversarial verifier passed), or a checked result for EVERY completion
 * evidence item the plan chose. An uncertain effect still outstanding means a
 * send or reservation might not have landed, so it is not done.
 */
export function evidenceMeetsPlan(goal: Pick<GoalRecord, 'completionClaim'>, state: ExecutionState): boolean {
  if (goal.completionClaim) return true
  const required = (state.plan.completionEvidence ?? []).map(norm)
  if (required.length === 0) return false
  const cp = state.checkpoint
  if (!cp || cp.uncertainEffects.length > 0) return false
  const checked = new Set(cp.checkedResults.map(norm))
  return required.every(r => checked.has(r))
}

export function createExecutionLedger(deps: { allowance: AllowanceTree }): ExecutionLedger {
  const active = (goal: GoalRecord) => findActiveNativeExecutionSystem({ goalId: goal.id })

  async function beginTick(goal: GoalRecord): Promise<LedgerBegin> {
    const state = await active(goal)
    if (!state) {
      // A goal whose execution was retired (executor change, host deleted)
      // must not continue on the legacy path either.
      return (await hasRetiredNativeExecutionSystem(goal.id)) ? { kind: 'retired' } : { kind: 'legacy' }
    }
    if (!deps.allowance.meteringAvailable()) return { kind: 'blocked', reason: 'metering_unavailable' }
    const r = await deps.allowance.reserve(state.id)
    if (r.kind === 'missing') return { kind: 'blocked', reason: 'execution_state_unrecoverable' }
    if (r.kind === 'exhausted') return { kind: 'blocked', reason: r.reason }
    if (r.kind === 'fenced') {
      if (r.state.phase === 'paused') return { kind: 'paused' }
      if (r.state.phase === 'retired' || r.state.phase === 'done') return { kind: 'retired' }
      return { kind: 'blocked', reason: r.state.blocker?.reason ?? 'execution_blocked' }
    }
    const seg = r.pool.segments.find(s => s.segmentNo === r.inFlight.segment)!
    return {
      kind: 'proceed', stateId: r.state.id, attemptId: r.inFlight.attemptId,
      // Bounds apply per active segment: a human renewal opens a fresh bound
      // while lifetime use stays on the pool.
      loop: { iteration: seg.iterations, spend: seg.spent, noProgressStreak: r.state.streaks.noProgress },
    }
  }

  async function endIteration(stateId: string, attemptId: string, result: LedgerIterationResult): Promise<LedgerEnd> {
    const state = await getExecutionSystem(stateId)
    if (!state) return { progressed: false, blockedReason: 'execution_state_unrecoverable', fenced: false, spend: 0 }
    const checkpoint = mergeCheckpoint(state.checkpoint, state, result.evidence ?? {})
    const classification = classifyIteration({
      blocker: result.blocker ?? null,
      waiting: result.waiting,
      transientFault: result.transientFault ?? false,
      previousFingerprint: state.checkpoint?.evidenceFingerprint ?? '',
      fingerprint: checkpoint.evidenceFingerprint,
    })
    const decision = decideExecution(classification, state.streaks, {}, result.blocker ?? null)
    const nextPhase = decision.decision === 'blocked' ? 'blocked' : decision.resume === 'wait' ? 'waiting' : 'ready'
    const before = state.checkpoint?.runLedger?.runId === result.runId ? state.checkpoint?.runLedger?.accounted ?? 0 : 0
    const settled = await deps.allowance.settle(stateId, {
      attemptId, runId: result.runId, checkpoint, nextPhase, streaks: decision.streaks,
      blocker: decision.decision === 'blocked' ? { reason: decision.reason } : null,
      wait: nextPhase === 'waiting' ? { runId: result.runId } : null,
    })
    const after = settled?.state.checkpoint?.runLedger?.accounted ?? before
    return {
      progressed: classification === 'progress',
      blockedReason: decision.decision === 'blocked' ? decision.reason : null,
      fenced: settled?.kind === 'fenced',
      spend: Math.max(0, after - before),
    }
  }

  async function completionSatisfied(goal: GoalRecord): Promise<boolean> {
    const state = await active(goal)
    if (!state) return true // legacy goal: its own done_when is the contract
    return evidenceMeetsPlan(goal, state)
  }

  async function onTerminal(goal: GoalRecord, terminal: 'done' | 'blocked', reason: string | null): Promise<void> {
    const state = await active(goal)
    if (!state) return
    await setExecutionPhaseSystem(state.id, terminal, terminal === 'blocked' ? { blocker: { reason: reason ?? 'blocked' } } : {})
  }

  async function phaseOf(goal: GoalRecord) {
    return (await active(goal))?.phase ?? null
  }

  return { beginTick, bindRun: bindAttemptRunSystem, endIteration, completionSatisfied, onTerminal, phaseOf }
}
