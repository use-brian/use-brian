/**
 * The allowance tree: one shared pool per execution tree, reserved before
 * dispatch and reconciled against the edition's real usage ledger after it.
 *
 * - Usage truth is the injected `UsageStore` (hosted `usage_tracking`, OSS
 *   `oss_usage_tracking`). A workflow run's spend is
 *   `getSessionCostUsd('workflow_run_' + runId)`; a run advanced across several
 *   ticks is reconciled by DELTA against the checkpoint's `runLedger`, so it is
 *   never counted twice.
 * - Missing metering is not zero: with no store, or a failed read, the
 *   reservation itself is kept as spent.
 * - Recovery reconstructs only from the ledger: an attempt left unsettled by a
 *   crash is settled from its bound run's recorded cost (or its reservation),
 *   its effects are kept as uncertain, and a `recover` receipt is written. The
 *   pool is never re-initialized.
 * - Children join the root pool; nothing here can open a segment. Renewal is
 *   only `applyControlSystem` with a human origin.
 *
 * Spec: docs/architecture/features/goals.md -> "Resumable task execution".
 * [COMP:goals/allowance-tree]
 */
import type { ExecutionCheckpoint, ExecutionPlan, ExecutionSourceRef, ExecutionStreaks, UsageStore } from '@use-brian/core'
import {
  beginIterationSystem,
  deriveChildExecutionSystem,
  getExecutionSystem,
  settleIterationSystem,
  type BeginIterationResult,
  type ExecutionExecutor,
  type ExecutionState,
  type SettleInput,
  type SettleOutcome,
} from '../db/task-execution-store.js'

export type AllowanceTreeDeps = {
  /** The edition's real usage store, or null when metering is not wired. */
  usageStore: Pick<UsageStore, 'getSessionCostUsd'> | null
}

export type ReserveResult = Exclude<BeginIterationResult, { kind: 'unsettled' }> & { recovered?: boolean }

const runSession = (runId: string) => `workflow_run_${runId}`

export function createAllowanceTree(deps: AllowanceTreeDeps) {
  /** Cumulative recorded spend of a run, or null when unknown. */
  async function runCost(runId: string | null): Promise<number | null> {
    if (!runId || !deps.usageStore) return null
    try {
      return await deps.usageStore.getSessionCostUsd(runSession(runId))
    } catch (error) {
      console.error('[allowance] usage read failed; keeping the reservation as spent:', error)
      return null
    }
  }

  /** Spend attributable to THIS attempt: the run's cumulative cost minus what
   *  earlier attempts on the same run already settled. */
  async function attemptSpend(state: ExecutionState, runId: string | null): Promise<{ actual: number | null; ledger: ExecutionCheckpoint['runLedger'] }> {
    const total = await runCost(runId)
    if (total === null || !runId) return { actual: null, ledger: state.checkpoint?.runLedger ?? null }
    const prior = state.checkpoint?.runLedger?.runId === runId ? state.checkpoint.runLedger.accounted : 0
    return { actual: Math.max(0, total - prior), ledger: { runId, accounted: Math.max(total, prior) } }
  }

  async function reserve(stateId: string): Promise<ReserveResult> {
    let result = await beginIterationSystem(stateId)
    if (result.kind !== 'unsettled') return result
    await recoverUnsettled(result.state)
    result = await beginIterationSystem(stateId)
    if (result.kind === 'unsettled') throw new Error('execution_state_unrecoverable')
    return { ...result, recovered: true }
  }

  /** Settle a crashed attempt from the ledger. Its effects become uncertain:
   *  the dispatch may or may not have landed, and it must not be retried as if
   *  it had not. */
  async function recoverUnsettled(state: ExecutionState): Promise<SettleOutcome | null> {
    const f = state.inFlight
    if (!f) return null
    const { actual, ledger } = await attemptSpend(state, f.runId)
    const base = state.checkpoint
    const checkpoint: ExecutionCheckpoint | null = base
      ? { ...base, runLedger: ledger, uncertainEffects: [...base.uncertainEffects, { operation: 'workflow_run', ref: f.runId ?? 'unbound', attemptId: f.attemptId }] }
      : { summary: 'Recovered an interrupted attempt.', sourceRefs: state.sourceRefs, artifacts: [], completedEffects: [],
          uncertainEffects: [{ operation: 'workflow_run', ref: f.runId ?? 'unbound', attemptId: f.attemptId }], checkedResults: [],
          nextStep: null, questions: [], segment: f.segment, evidenceFingerprint: '', runLedger: ledger }
    return settleIterationSystem(state.id, {
      attemptId: f.attemptId, actualSpend: actual, checkpoint,
      // Recovery is not progress and not a stall; the streaks carry unchanged.
      nextPhase: 'ready', streaks: state.streaks,
    })
  }

  async function settle(stateId: string, input: Omit<SettleInput, 'actualSpend'> & { runId: string | null }): Promise<SettleOutcome | null> {
    const state = await getExecutionSystem(stateId)
    if (!state) return null
    const { actual, ledger } = await attemptSpend(state, input.runId)
    const checkpoint = input.checkpoint ? { ...input.checkpoint, runLedger: ledger } : input.checkpoint
    return settleIterationSystem(stateId, { ...input, actualSpend: actual, checkpoint })
  }

  async function deriveChild(parentStateId: string, childKey: string, input: {
    taskId: string | null; executor: ExecutionExecutor; plan: Partial<ExecutionPlan>; sourceRefs: ExecutionSourceRef[]
    dependencyOpen: boolean
  }) {
    return deriveChildExecutionSystem(parentStateId, childKey, {
      taskId: input.taskId, executor: input.executor, plan: input.plan, sourceRefs: input.sourceRefs,
      // A human-owned child is tracked and waited on, never pursued by AI.
      phase: input.executor?.kind === 'person' || input.dependencyOpen ? 'waiting' : 'ready',
    })
  }

  return { reserve, settle, recoverUnsettled, deriveChild, meteringAvailable: () => deps.usageStore !== null }
}

export type AllowanceTree = ReturnType<typeof createAllowanceTree>
