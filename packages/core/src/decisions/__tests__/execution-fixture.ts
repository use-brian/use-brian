import type { LLMProvider } from '../../providers/types.js'
import {
  executeDecisionCascade,
  executeDecisionObservation,
  type DecisionCascadeOperation,
  type DecisionCascadeResult,
  type DecisionEvaluationProfile,
  type DecisionExecutionPort,
  type DecisionExecutionRunOptions,
  type DecisionObservationRunOptions,
  type DecisionProvider,
  type JsonValue,
} from '../index.js'

export function executionFixture(options: {
  mode?: 'llm_only' | 'shadow' | 'hybrid'
  primary?: DecisionProvider
  llm: LLMProvider
  model?: { catalogId: string; wireId: string }
  shadowSampleRate?: number
  profilePolicy?: JsonValue
}): DecisionExecutionPort {
  const routeFor = (request: Parameters<typeof executeDecisionCascade>[0]['request']) => {
    const mode = options.mode ?? 'hybrid'
    if (mode === 'llm_only') return { mode } as const
    if (!options.primary) throw new Error('fixture primary required')
    const profile: DecisionEvaluationProfile = {
      id: 'fixture-profile',
      version: '1',
      mode,
      operationId: request.operation.id,
      operationVersion: request.operation.version,
      stateVersion: request.operation.stateVersion,
      questionVersion: request.operation.questionVersion,
      modelCatalogId: request.model.catalogId,
      modelWireId: request.model.wireId,
      status: mode === 'hybrid' ? 'approved' : 'evaluation',
      evidence: 'synthetic',
      totalTimeoutMs: 100,
      primaryTimeoutMs: 50,
      maxAttempts: 2,
      ...(options.profilePolicy !== undefined ? { policy: options.profilePolicy } : {}),
      ...(mode === 'shadow' ? { shadowSampleRate: options.shadowSampleRate ?? 1 } : {}),
    }
    return {
      mode,
      primary: options.primary,
      profile,
      allowSyntheticProfile: true,
    } as const
  }

  return {
    async observe<T>(
      input: DecisionObservationRunOptions<T>,
    ) {
      const model = options.model ?? { catalogId: 'fixture-decision', wireId: 'fixture-decision-v1' }
      const request = { ...input.request, model }
      return executeDecisionObservation({ request, operation: input.operation, route: routeFor(request) })
    },
    async run<T>(
      input: DecisionExecutionRunOptions<T>,
    ): Promise<DecisionCascadeResult<T>> {
      const model = options.model ?? { catalogId: 'fixture-decision', wireId: 'fixture-decision-v1' }
      const request = { ...input.request, model }
      const operation: DecisionCascadeOperation<T> = {
        ...input.operation,
        completeWithLlm: (context) => input.operation.completeWithLlm({
          ...context,
          llm: { provider: options.llm, modelId: 'fixture-llm' },
        }),
      }
      return executeDecisionCascade({
        request,
        operation,
        route: routeFor(request),
      })
    },
  }
}

export function fixtureDecisionProvider(
  evaluate: DecisionProvider['evaluate'],
): DecisionProvider {
  return {
    id: 'fixture-decision',
    capabilities: {
      primitives: ['choice', 'boolean', 'score'],
      batch: true,
      maxOptions: 255,
      maxQuestions: 64,
      maxRubricLevels: 10,
      maxInputTokens: 64_000,
      uncertainty: ['native_distribution'],
    },
    evaluate,
  }
}
