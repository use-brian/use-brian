import type { DecisionExecutionOperation, DecisionEvaluationProfile } from '../decisions/hydra.js'
import type { DecisionModelRef } from '../decisions/types.js'
import type { NativeLlmAdapter, NativeModelInput, NativeSelection } from './types.js'

export const NATIVE_NEXT_ACTION = { id: 'computer.next-action', version: '1', stateVersion: '4', questionVersion: '1' } as const
export const NATIVE_VERIFY_PROGRESS = { id: 'computer.verify-progress', version: '1', stateVersion: '3', questionVersion: '1' } as const
export function approvedNativeProfile(profile: DecisionEvaluationProfile | undefined, model?: DecisionModelRef, operationId: string = NATIVE_NEXT_ACTION.id): boolean {
  const operation = operationId === NATIVE_NEXT_ACTION.id ? NATIVE_NEXT_ACTION
    : operationId === NATIVE_VERIFY_PROGRESS.id ? NATIVE_VERIFY_PROGRESS : undefined
  return !!operation && !!profile && profile.mode === 'hybrid' && profile.status === 'approved' && profile.evidence === 'recorded'
    && profile.operationId === operationId && profile.operationVersion === '1'
    && profile.stateVersion === operation.stateVersion && profile.questionVersion === '1' && profile.evaluationSegment === 'global'
    && (!model || (profile.modelCatalogId === model.catalogId && profile.modelWireId === model.wireId))
}
export function createNativeDecisionOperation(input: NativeModelInput, adapter: NativeLlmAdapter, allowPrimary: boolean, operationId: string = NATIVE_NEXT_ACTION.id): DecisionExecutionOperation<NativeSelection> {
  const values = new Set([...input.candidates.map(c => c.id), 'abstain', 'ask_user'])
  const validateResult = (value: string) => {
    if (!values.has(value)) throw new Error('Invalid native candidate')
    return value
  }
  return {
    validateResult,
    safeFailure: () => 'abstain',
    decide(response, { profile }) {
      if (!allowPrimary || !approvedNativeProfile(profile, response.model, operationId)) return { kind: 'follow_up', reason: 'uncertain' }
      const answer = response.answers.length === 1 ? response.answers[0] : undefined
      const policy = profile?.policy
      const threshold = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy.minProbability : undefined
      if (!answer || answer.kind !== 'choice' || answer.questionId !== 'next' || !values.has(answer.value)
        || typeof threshold !== 'number' || threshold <= 0 || threshold > 1
        || answer.evidence.source !== 'native_distribution'
        || !Number.isFinite(answer.evidence.probabilities?.[answer.value])
        || answer.evidence.probabilities![answer.value]! < threshold) return { kind: 'follow_up', reason: 'uncertain' }
      return { kind: 'complete', result: answer.value }
    },
    completeWithLlm: context => adapter.select({ ...input, signal: context.signal, deadlineAt: context.deadlineAt ?? input.deadlineAt }, context.llm, { kind: context.kind, followUpReason: context.followUpReason }),
  }
}

/** A primary completion is only a goal assessment, never evidence or action authority. */
export function createNativeProgressOperation(input: NativeModelInput, adapter: NativeLlmAdapter, allowPrimary: boolean): DecisionExecutionOperation<NativeSelection> {
  return createNativeDecisionOperation({ ...input, candidates: ['complete', 'continue'].map(id => ({ id, action: { kind: 'observe', target: input.observation.target } })) }, {
    select: (i, route, attempt) => adapter.verify!(i, route, attempt),
  }, allowPrimary, NATIVE_VERIFY_PROGRESS.id)
}
