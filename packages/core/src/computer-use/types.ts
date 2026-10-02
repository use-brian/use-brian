import type { NativeTraceCorrelation } from './trace.js'
import type { NativeGoalObjective } from './context.js'
import type { NativeAction, NativeCommand, NativeGrant, NativeObservation, NativeReceipt, NativeStatus, NativeTarget } from '@use-brian/computer-control/protocol.js'
import type { DecisionCompletion, DecisionCompletionContext, DecisionCompletionRoute, DecisionEvaluationProfile, DecisionExecutionPort } from '../decisions/hydra.js'
import type { DecisionOperationRef } from '../decisions/types.js'

/** Transport owns authenticated routing, command deduplication and local Stop. Never retry execute. */
export interface NativeComputerProvider {
  status(signal: AbortSignal): Promise<NativeStatus>
  observe(command: NativeCommand, signal: AbortSignal): Promise<NativeObservation>
  execute(command: NativeCommand, signal: AbortSignal): Promise<NativeReceipt>
}
export type NativeAuthority = {
  grant: NativeGrant
  target: NativeTarget
  /** Recheck live membership/task authority; local helper independently checks consent and epoch. */
  assertCurrent(): Promise<void>
}
export type NativeCandidate = { id: string; action: NativeAction }
export type NativeSelection = string // candidate ID, abstain, or ask_user; never executable model text
export type NativeModelInput = {
  /** Trusted producer correlation only. Never serialize into model prompts/state.
   * This is a high-level phase span, not proof of an actual provider invocation. */
  trace?: NativeTraceCorrelation
  goal: string
  observation: NativeObservation
  candidates: readonly NativeCandidate[]
  signal: AbortSignal
  deadlineAt: number
}
/** Implementations use existing provider/key resolution and account every attempt, even failures.
 * Text selection MUST NOT receive frames. Vision requires explicit native grounding support.
 */
/** Trusted Hydra execution metadata only, never UI/model data or exceptions. */
export type NativeLlmAttemptContext = Pick<DecisionCompletionContext, 'kind' | 'followUpReason'>
export interface NativeLlmAdapter {
  /** Opt into reviewed document-only model projection. Must check full raw safety
   * first and return ALL frozen objectives. Core derives nodes from actual refs. */
  contextObjectives?(input: NativeModelInput): readonly NativeGoalObjective[]
  /** Freeze whole-goal observable postconditions before any effect, including clicks; AX only. */
  decompose?(input: NativeModelInput): Promise<void>
  /** Bounded proposals; schema/policy checked. A unique current action needs no second selector. */
  plan?(input: NativeModelInput): Promise<readonly NativeCandidate[]>
  /** Goal assessment only; completion is independently gated by local postconditions. */
  verify?(input: NativeModelInput, llm?: DecisionCompletionRoute, attempt?: NativeLlmAttemptContext): Promise<DecisionCompletion<NativeSelection>>
  select(input: NativeModelInput, llm?: DecisionCompletionRoute, attempt?: NativeLlmAttemptContext): Promise<DecisionCompletion<NativeSelection>>
  vision?: {
    nativeGrounding: true
    propose(input: NativeModelInput): Promise<NativeAction | null>
  }
}
export interface NativeSafetyPolicy {
  /** Trusted supported-app cohort/effect allowlist. Unknown, security/credential,
   * shell effects must return false. Unknown/external effects may only pass when the
   * independently enforced local broker requires exact-effect approval. No model-supplied approvals. */
  allows(action: NativeAction, observation: NativeObservation): boolean
  /** Must attest capture redaction/privacy before capture, not after upload. */
  allowsCapture(observation: NativeObservation): boolean
  /** Trusted postcondition check; models cannot declare success. */
  isComplete(observation: NativeObservation): boolean
}
export type NativeDecisionRuntime = DecisionExecutionPort & {
  resolveRoute(context: { workspaceId?: string; kind: 'execution' | 'observation'; evaluationSegment: string; operation: DecisionOperationRef; questionKinds: ('choice' | 'boolean' | 'score')[] }): Promise<{
    mode: 'llm_only' | 'shadow' | 'hybrid'; operatorOverride?: boolean; profile?: DecisionEvaluationProfile; llm?: DecisionCompletionRoute | null
  }>
}
export type NativeProgress = { phase: 'observing' | 'planning' | 'vision' | 'executing'; step: number }
export type NativeTaskResult = { outcome: 'completed' | 'paused' | 'cancelled' | 'execution_unknown' | 'unavailable'; reason: string; actions: number }
export type NativeTaskOptions = {
  authority: NativeAuthority
  goal: string
  signal: AbortSignal
  deadlineAt: number
  maxActions?: number
  maxModelCalls?: number
  maxNoProgress?: number
  onProgress?: (event: NativeProgress) => void
}

/** API-owned shared token/cost reservation ledger. Reservations bound worst-case
 * provider input/output/cost before scheduling; incurred usage is settled by the
 * existing runtime/adapter metering, including failed and shadow attempts.
 * Returning false forbids scheduling; never refund an ambiguous provider call.
 */
export interface NativeInferenceBudget {
  reserve(input: { lane: 'decision' | 'text' | 'vision'; maxAttempts: number; deadlineAt: number; signal: AbortSignal }): Promise<boolean>
}
