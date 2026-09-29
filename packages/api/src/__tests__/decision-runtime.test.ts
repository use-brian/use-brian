import { describe, expect, it, vi } from 'vitest'
import {
  DecisionAdapterRegistry,
  type DecisionProvider,
  type DecisionResponse,
  type LLMProvider,
} from '@use-brian/core'
import { createDecisionRuntime, type DecisionRuntimeOperation } from '../decision-runtime.js'

type Result = { verdict: 'ordinary' | 'research' | 'safe' }

const operationRef = {
  id: 'fixture.intent',
  version: '1',
  stateVersion: '1',
  questionVersion: '1',
}

function fixtureLlm(): LLMProvider {
  return {
    name: 'fixture-llm',
    models: ['fixture-llm'],
    stream: async function* () {
      yield { type: 'message_start', model: 'fixture-llm' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }
    },
    createSession: () => ({ send: async function* () {} }),
  }
}

function request() {
  return {
    runId: 'runtime-fictional-1',
    operation: operationRef,
    state: { message: 'Compare the fictional Acorn and Birch plans.' },
    questions: [{
      kind: 'choice' as const,
      id: 'intent',
      prompt: 'Which bounded intent matches?',
      options: [{ value: 'ordinary' }, { value: 'research' }],
    }],
  }
}

function resultOperation(
  complete = vi.fn<DecisionRuntimeOperation<Result>['completeWithLlm']>(async (context) => ({
    result: { verdict: 'research' },
    providerId: context.llm.provider.name,
    model: { catalogId: context.llm.modelId, wireId: context.llm.modelId },
    usage: { inputTokens: 20, outputTokens: 5 },
  })),
): DecisionRuntimeOperation<Result> {
  return {
    decide(response) {
      const answer = response.answers[0]
      return answer?.kind === 'choice'
        ? { kind: 'complete', result: { verdict: answer.value as Result['verdict'] } }
        : { kind: 'unavailable', reason: 'invalid_response' }
    },
    validateResult(result) {
      if (!['ordinary', 'research', 'safe'].includes(result.verdict)) throw new Error('invalid result')
      return result
    },
    safeFailure: () => ({ verdict: 'safe' }),
    completeWithLlm: complete,
  }
}

function primaryProvider(): DecisionProvider {
  return {
    id: 'fixture-typesafe',
    capabilities: {
      primitives: ['choice'],
      batch: true,
      maxOptions: 255,
      maxQuestions: 64,
      maxRubricLevels: 10,
      maxInputTokens: 64_000,
      uncertainty: ['native_distribution'],
    },
    async evaluate(decisionRequest): Promise<DecisionResponse> {
      return {
        providerId: 'fixture-typesafe',
        model: decisionRequest.model,
        answers: [{
          kind: 'choice',
          questionId: 'intent',
          value: 'ordinary',
          evidence: {
            source: 'native_distribution',
            probabilities: { ordinary: 0.9, research: 0.1 },
          },
        }],
        usage: { inputTokens: 8, outputTokens: 0 },
      }
    },
  }
}

function profile() {
  return {
    id: 'fixture-profile',
    version: '1',
    mode: 'hybrid' as const,
    operationId: operationRef.id,
    operationVersion: operationRef.version,
    stateVersion: operationRef.stateVersion,
    questionVersion: operationRef.questionVersion,
    modelCatalogId: 'typesafe-jev-1.13',
    modelWireId: 'jev-1.13.0',
    evaluationSegment: 'global',
    status: 'approved' as const,
    evidence: 'synthetic' as const,
    totalTimeoutMs: 100,
    primaryTimeoutMs: 50,
    maxAttempts: 2 as const,
  }
}

describe('[COMP:decisions/runtime] decision composition', () => {
  it('defaults to one LLM-only completion and supplies the boot LLM lane', async () => {
    const llm = fixtureLlm()
    const complete = vi.fn<DecisionRuntimeOperation<Result>['completeWithLlm']>(async (context) => ({
      result: { verdict: 'research' },
      providerId: context.llm.provider.name,
      model: { catalogId: context.llm.modelId, wireId: context.llm.modelId },
    }))
    const runtime = createDecisionRuntime({ llmProvider: llm, defaultLlmModel: 'fixture-llm' })

    const result = await runtime.run({ request: request(), operation: resultOperation(complete) })

    expect(result).toMatchObject({ path: 'llm_only', attempts: 1, result: { verdict: 'research' } })
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0]![0].llm).toEqual({ provider: llm, modelId: 'fixture-llm' })
  })

  it('treats a missing decision credential as configuration absence and stays functional', async () => {
    const complete = vi.fn(resultOperation().completeWithLlm)
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
      resolveRoute: () => ({
        mode: 'hybrid',
        primaryModelId: 'typesafe-jev-1.13',
        profile: profile(),
        allowSyntheticProfile: true,
      }),
    })

    const result = await runtime.run({ request: request(), operation: resultOperation(complete) })

    expect(result).toMatchObject({ path: 'llm_only', attempts: 1 })
    expect(runtime.configuredAdapterIds()).not.toContain('typesafe')
    expect(complete).toHaveBeenCalledOnce()
  })

  it('skips observation in llm-only mode without invoking an LLM completion', async () => {
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
    })
    const complete = vi.fn(resultOperation().completeWithLlm)

    const result = await runtime.observe({
      request: request(),
      operation: {
        decide: resultOperation(complete).decide,
        validateResult: resultOperation(complete).validateResult,
      },
    })

    expect(result).toMatchObject({ path: 'skipped', attempts: 0 })
    expect(complete).not.toHaveBeenCalled()
  })

  it('runs one configured primary observation without an LLM completion', async () => {
    const adapters = new DecisionAdapterRegistry().register('typesafe', () => primaryProvider())
    const complete = vi.fn(resultOperation().completeWithLlm)
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
      adapters,
      resolveRoute: () => ({
        mode: 'shadow',
        primaryModelId: 'typesafe-jev-1.13',
        profile: {
          ...profile(),
          mode: 'shadow',
          status: 'evaluation',
          shadowSampleRate: 1,
        },
      }),
    })

    const op = resultOperation(complete)
    const result = await runtime.observe({
      workspaceId: 'workspace-fictional',
      request: request(),
      operation: { decide: op.decide, validateResult: op.validateResult },
    })

    expect(result).toMatchObject({
      path: 'observed_complete',
      attempts: 1,
      disposition: { kind: 'complete', result: { verdict: 'ordinary' } },
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('resolves workspace policy to an injected adapter with no vendor branch in Hydra', async () => {
    const adapters = new DecisionAdapterRegistry()
      .register('typesafe', () => primaryProvider())
    const resolveRoute = vi.fn(() => ({
      mode: 'hybrid' as const,
      primaryModelId: 'typesafe-jev-1.13',
      profile: profile(),
      allowSyntheticProfile: true,
    }))
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: () => 'fixture-llm',
      adapters,
      resolveRoute,
    })

    const result = await runtime.run({
      workspaceId: 'workspace-fictional',
      request: request(),
      operation: resultOperation(),
    })

    expect(result).toMatchObject({ path: 'primary_complete', attempts: 1, result: { verdict: 'ordinary' } })
    expect(resolveRoute).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-fictional',
      operation: operationRef,
      questionKinds: ['choice'],
    }))
  })

  it('attributes each attempt and prices known decision usage from the shared catalog', async () => {
    const attempts: Array<{ usage?: { costUsd?: number }; effectiveMode: string; operatorOverride: boolean }> = []
    const outcomes: Array<{ path: string; effectiveMode: string; operatorOverride: boolean }> = []
    const adapters = new DecisionAdapterRegistry().register('typesafe', () => primaryProvider())
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
      adapters,
      resolveRoute: () => ({
        mode: 'hybrid', primaryModelId: 'typesafe-jev-1.13', profile: profile(), allowSyntheticProfile: true,
      }),
      onAttempt: (attempt) => { attempts.push(attempt) },
      onOutcome: (outcome) => { outcomes.push(outcome) },
    })

    await runtime.run({ request: request(), operation: resultOperation() })

    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ effectiveMode: 'hybrid', operatorOverride: false, usage: { costUsd: 8 * 0.042 / 1_000_000 } })
    expect(outcomes).toEqual([expect.objectContaining({ path: 'primary_complete', effectiveMode: 'hybrid', operatorOverride: false })])
  })

  it('attributes deployment operator override attempts and outcomes', async () => {
    const attempts: Array<{ operatorOverride: boolean }> = []
    const outcomes: Array<{ operatorOverride: boolean }> = []
    const adapters = new DecisionAdapterRegistry().register('typesafe', () => primaryProvider())
    const runtime = createDecisionRuntime({
      llmProvider: fixtureLlm(),
      defaultLlmModel: 'fixture-llm',
      adapters,
      resolveRoute: () => ({
        mode: 'hybrid',
        primaryModelId: 'typesafe-jev-1.13',
        profile: {
          ...profile(),
          status: 'operator_override',
          evidence: 'operator_override',
        },
        operatorOverride: true,
      }),
      onAttempt: (attempt) => { attempts.push(attempt) },
      onOutcome: (outcome) => { outcomes.push(outcome) },
    })

    await runtime.run({ request: request(), operation: resultOperation() })

    expect(attempts).toEqual([expect.objectContaining({ operatorOverride: true })])
    expect(outcomes).toEqual([expect.objectContaining({ operatorOverride: true })])
  })

  it('rejects unknown models, missing model ids, denied LLM lanes, and mismatched profiles before dispatch', async () => {
    const llm = fixtureLlm()
    const base = { llmProvider: llm, defaultLlmModel: 'fixture-llm' }
    const run = (runtime: ReturnType<typeof createDecisionRuntime>) => runtime.run({
      request: request(), operation: resultOperation(),
    })

    await expect(run(createDecisionRuntime({
      ...base, resolveRoute: () => ({ mode: 'hybrid', profile: profile() }),
    }))).rejects.toThrow(/primaryModelId/)
    await expect(run(createDecisionRuntime({
      ...base, resolveRoute: () => ({ mode: 'hybrid', primaryModelId: 'unknown', profile: profile() }),
    }))).rejects.toThrow(/not an active decision model/)
    await expect(run(createDecisionRuntime({
      ...base, resolveRoute: () => ({ mode: 'llm_only', llm: null }),
    }))).rejects.toThrow(/no permitted LLM/)

    const adapters = new DecisionAdapterRegistry().register('typesafe', () => primaryProvider())
    await expect(run(createDecisionRuntime({
      ...base,
      adapters,
      resolveRoute: () => ({
        mode: 'hybrid',
        primaryModelId: 'typesafe-jev-1.13',
        profile: { ...profile(), questionVersion: 'wrong' },
        allowSyntheticProfile: true,
      }),
    }))).rejects.toThrow(/versions/)
  })
})
