import { describe, expect, it, vi } from 'vitest'
import {
  executeDecisionCascade,
  executeDecisionObservation,
  validateDecisionRoute,
  type DecisionCascadeOperation,
  type DecisionEvaluationProfile,
  type DecisionAttemptRecord,
} from '../hydra.js'
import type { DecisionProvider, DecisionResponse } from '../types.js'
import { DecisionProviderError } from '../types.js'
import { decisionRequest } from './fixtures.js'

type Result = { verdict: 'ordinary' | 'research' | 'safe'; generated?: string }

function response(value: 'ordinary' | 'research' = 'ordinary'): DecisionResponse {
  const request = decisionRequest()
  return {
    providerId: 'fixture-primary',
    nativeMetadata: { actualModel: request.model.wireId, usage: { inputTokens: 8, outputTokens: 2 } },
    model: request.model,
    answers: [{
      kind: 'choice',
      questionId: 'intent',
      value,
      evidence: { source: 'unavailable' },
    }],
    usage: { inputTokens: 8, outputTokens: 2 },
  }
}

function provider(evaluate: DecisionProvider['evaluate']): DecisionProvider {
  return {
    id: 'fixture-primary',
    supportsNativeStrict: true,
    capabilities: {
      primitives: ['choice'],
      batch: true,
      maxOptions: 4,
      maxQuestions: 4,
      maxRubricLevels: 2,
      maxInputTokens: 4_000,
      uncertainty: ['unavailable'],
    },
    evaluate,
  }
}

function profile(mode: 'shadow' | 'hybrid' = 'hybrid'): DecisionEvaluationProfile {
  const request = decisionRequest()
  return {
    id: 'fixture-profile',
    version: '1',
    mode,
    operationId: request.operation.id,
    operationVersion: request.operation.version,
    stateVersion: request.operation.stateVersion,
    questionVersion: request.operation.questionVersion,
    modelCatalogId: request.model.catalogId,
    modelWireId: request.model.wireId,
    evaluationSegment: request.evaluationSegment ?? 'global',
    status: mode === 'hybrid' ? 'approved' : 'evaluation',
    evidence: 'synthetic',
    totalTimeoutMs: 100,
    primaryTimeoutMs: 50,
    maxAttempts: 2,
    ...(mode === 'shadow' ? { shadowSampleRate: 1 } : {}),
  }
}

function operation(params: {
  disposition?: DecisionCascadeOperation<Result>['decide']
  complete?: DecisionCascadeOperation<Result>['completeWithLlm']
} = {}): DecisionCascadeOperation<Result> {
  return {
    decide: params.disposition ?? ((primary) => ({
      kind: 'complete',
      result: { verdict: primary.answers[0]!.kind === 'choice' && primary.answers[0]!.value === 'research' ? 'research' : 'ordinary' },
    })),
    validateResult(result) {
      if (!['ordinary', 'research', 'safe'].includes(result.verdict)) throw new Error('invalid result')
      return result
    },
    safeFailure: () => ({ verdict: 'safe' }),
    completeWithLlm: params.complete ?? (async (context) => ({
      result: { verdict: 'research', generated: context.kind },
      providerId: 'fixture-llm',
      model: { catalogId: 'fixture-llm', wireId: 'fixture-llm-v1' },
      usage: { inputTokens: 20, outputTokens: 5 },
    })),
  }
}

describe('[COMP:decisions/hydra] bounded cascade', () => {
  it('preserves LLM-only as one complete call with no primary dispatch', async () => {
    const primary = vi.fn(async () => response())
    const complete = vi.fn(operation().completeWithLlm)
    const result = await executeDecisionCascade({
      request: decisionRequest(),
      operation: operation({ complete }),
      route: { mode: 'llm_only', primary: provider(primary) },
    })
    expect(result).toMatchObject({ path: 'llm_only', attempts: 1, result: { generated: 'llm_only' } })
    expect(primary).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledOnce()
  })

  it('returns a terminal primary result without an LLM call', async () => {
    const complete = vi.fn(operation().completeWithLlm)
    const result = await executeDecisionCascade({
      request: decisionRequest(),
      operation: operation({ complete }),
      route: {
        mode: 'hybrid',
        primary: provider(async () => response('ordinary')),
        profile: profile(),
        allowSyntheticProfile: true,
      },
    })
    expect(result).toMatchObject({ path: 'primary_complete', attempts: 1, result: { verdict: 'ordinary' } })
    expect(complete).not.toHaveBeenCalled()
  })

  it('uses one generation follow-up and carries the accepted primary response', async () => {
    const complete = vi.fn(operation().completeWithLlm)
    const result = await executeDecisionCascade({
      request: decisionRequest(),
      operation: operation({
        disposition: () => ({ kind: 'follow_up', reason: 'generation_required' }),
        complete,
      }),
      route: { mode: 'hybrid', primary: provider(async () => response()), profile: profile(), allowSyntheticProfile: true },
    })
    expect(result).toMatchObject({ path: 'generation', attempts: 2 })
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0]![0]).toMatchObject({
      kind: 'generation',
      followUpReason: 'generation_required',
      primaryResponse: { providerId: 'fixture-primary' },
    })
  })

  it('runs uncertainty review independently without exposing the preferred answer', async () => {
    const complete = vi.fn(operation().completeWithLlm)
    const result = await executeDecisionCascade({
      request: decisionRequest(),
      operation: operation({
        disposition: () => ({ kind: 'follow_up', reason: 'uncertain' }),
        complete,
      }),
      route: { mode: 'hybrid', primary: provider(async () => response()), profile: profile(), allowSyntheticProfile: true },
    })
    expect(result.path).toBe('uncertainty_review')
    expect(complete.mock.calls[0]![0]).toMatchObject({ kind: 'uncertainty_review' })
    expect(complete.mock.calls[0]![0].primaryResponse).toBeUndefined()
  })

  it.each(['rate_limit', 'overloaded', 'transport', 'timeout', 'invalid_response'] as const)(
    'fails over %s directly to one complete LLM result with no third attempt',
    async (kind) => {
      const complete = vi.fn(operation().completeWithLlm)
      const result = await executeDecisionCascade({
        request: decisionRequest(),
        operation: operation({ complete }),
        route: {
          mode: 'hybrid',
          primary: provider(async () => { throw new DecisionProviderError(kind, kind) }),
          profile: profile(),
          allowSyntheticProfile: true,
        },
      })
      expect(result).toMatchObject({ path: 'operational_failover', attempts: 2 })
      expect(complete).toHaveBeenCalledOnce()
      expect(complete.mock.calls[0]![0]).toMatchObject({ kind: 'operational_failover' })
    },
  )

  it('never falls back after caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const complete = vi.fn(operation().completeWithLlm)
    await expect(executeDecisionCascade({
      request: { ...decisionRequest(), signal: controller.signal },
      operation: operation({ complete }),
      route: { mode: 'hybrid', primary: provider(async () => response()), profile: profile(), allowSyntheticProfile: true },
    })).rejects.toMatchObject({ kind: 'cancelled' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('does not use forbidden fallback for authentication or policy defects', async () => {
    const complete = vi.fn(operation().completeWithLlm)
    const result = await executeDecisionCascade({
      request: decisionRequest(),
      operation: operation({ complete }),
      route: {
        mode: 'hybrid',
        primary: provider(async () => { throw new DecisionProviderError('authentication', 'bad key') }),
        profile: profile(),
        allowSyntheticProfile: true,
      },
    })
    expect(result).toMatchObject({ path: 'safe_default', attempts: 1, failureKind: 'authentication' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('enforces the total budget even when a provider ignores abort', async () => {
    const short = { ...profile(), totalTimeoutMs: 8, primaryTimeoutMs: 2 }
    const complete = vi.fn(async () => new Promise<Awaited<ReturnType<DecisionCascadeOperation<Result>['completeWithLlm']>>>((resolve) => {
      setTimeout(() => resolve({
        result: { verdict: 'research' },
        providerId: 'fixture-llm',
        model: { catalogId: 'fixture-llm', wireId: 'fixture-llm-v1' },
      }), 25)
    }))
    const result = await executeDecisionCascade({
      request: decisionRequest(),
      operation: operation({ complete }),
      route: {
        mode: 'hybrid',
        primary: provider(async () => new Promise((resolve) => setTimeout(() => resolve(response()), 25))),
        profile: short,
        allowSyntheticProfile: true,
      },
    })
    expect(result).toMatchObject({ path: 'safe_default', failureKind: 'timeout' })
    expect([1, 2]).toContain(result.attempts)
    expect(complete).toHaveBeenCalledTimes(result.attempts - 1)
  })

  it('records every attempt exactly once with stage and attribution', async () => {
    const records: DecisionAttemptRecord[] = []
    const result = await executeDecisionCascade({
      request: decisionRequest(),
      operation: operation({ disposition: () => ({ kind: 'follow_up', reason: 'generation_required' }) }),
      route: { mode: 'hybrid', primary: provider(async () => response()), profile: profile(), allowSyntheticProfile: true },
      onAttempt: (record) => { records.push(record) },
    })
    expect(result.attempts).toBe(2)
    expect(records.map((record) => [record.attempt, record.stage, record.outcome])).toEqual([
      [1, 'primary_decision', 'success'],
      [2, 'generation', 'success'],
    ])
  })

  it('shadow always returns the legacy LLM result and never the primary result', async () => {
    const result = await executeDecisionCascade({
      request: decisionRequest(),
      operation: operation(),
      route: { mode: 'shadow', primary: provider(async () => response('ordinary')), profile: profile('shadow') },
      random: () => 0,
    })
    expect(result).toMatchObject({
      path: 'shadow_legacy',
      attempts: 2,
      result: { verdict: 'research', generated: 'shadow_legacy' },
      primaryResponse: { providerId: 'fixture-primary' },
    })
  })

  it('observation skips llm-only and unsampled routes without dispatch', async () => {
    const evaluate = vi.fn(async () => response())
    const observationOperation = {
      decide: operation().decide,
      validateResult: operation().validateResult,
    }
    await expect(executeDecisionObservation({
      request: decisionRequest(),
      operation: observationOperation,
      route: { mode: 'llm_only' },
    })).resolves.toMatchObject({ path: 'skipped', attempts: 0 })
    await expect(executeDecisionObservation({
      request: decisionRequest(),
      operation: observationOperation,
      route: {
        mode: 'shadow',
        primary: provider(evaluate),
        profile: { ...profile('shadow'), shadowSampleRate: 0.25 },
      },
      random: () => 0.9,
    })).resolves.toMatchObject({ path: 'skipped', attempts: 0 })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('observation records one primary disposition with no completion stage', async () => {
    const records: DecisionAttemptRecord[] = []
    const result = await executeDecisionObservation({
      request: decisionRequest(),
      operation: {
        decide: () => ({ kind: 'follow_up', reason: 'uncertain' }),
        validateResult: operation().validateResult,
      },
      route: {
        mode: 'shadow',
        primary: provider(async () => response('ordinary')),
        profile: profile('shadow'),
      },
      onAttempt: (record) => { records.push(record) },
    })
    expect(result).toMatchObject({ path: 'observed_follow_up', attempts: 1 })
    expect(records).toEqual([expect.objectContaining({
      stage: 'primary_decision',
      disposition: 'follow_up',
      followUpReason: 'uncertain',
    })])
  })

  it('rejects missing, mismatched, unbounded, and synthetic production profiles before dispatch', () => {
    const request = decisionRequest()
    const primary = provider(async () => response())
    expect(() => validateDecisionRoute(request, { mode: 'hybrid', primary })).toThrow(/profile/)
    expect(() => validateDecisionRoute(request, {
      mode: 'hybrid', primary, profile: { ...profile(), questionVersion: 'wrong' }, allowSyntheticProfile: true,
    })).toThrow(/versions/)
    expect(() => validateDecisionRoute(request, {
      mode: 'hybrid', primary, profile: { ...profile(), evaluationSegment: 'ja' }, allowSyntheticProfile: true,
    })).toThrow(/segment/)
    expect(() => validateDecisionRoute(request, {
      mode: 'hybrid', primary, profile: { ...profile(), primaryTimeoutMs: 100 }, allowSyntheticProfile: true,
    })).toThrow(/primary < total/)
    expect(() => validateDecisionRoute(request, {
      mode: 'hybrid', primary, profile: profile(),
    })).toThrow(/recorded/)
  })

  it('accepts an operator override only with its separate authority bit and metadata', () => {
    const request = decisionRequest()
    const primary = provider(async () => response())
    const overrideProfile: DecisionEvaluationProfile = {
      ...profile(),
      status: 'operator_override',
      evidence: 'operator_override',
    }

    expect(() => validateDecisionRoute(request, {
      mode: 'hybrid', primary, profile: overrideProfile, operatorOverride: true,
    })).not.toThrow()
    expect(() => validateDecisionRoute(request, {
      mode: 'hybrid', primary, profile: overrideProfile,
    })).toThrow(/approved evaluation profile/)
    expect(() => validateDecisionRoute(request, {
      mode: 'hybrid', primary, profile: profile(), operatorOverride: true,
    })).toThrow(/override profile metadata/)
    expect(() => validateDecisionRoute(request, {
      mode: 'shadow', primary, profile: profile('shadow'), operatorOverride: true,
    })).toThrow(/only for hybrid/)
  })
})

// Native primary providers can ignore AbortSignal. Late settlement is accounting
// only: no accepted result, profile authority, or side effect can be resurrected.
describe('native primary invocation lifecycle', () => {
  function nativeRequest(signal?: AbortSignal) {
    const request = decisionRequest()
    return { ...request, operation: { ...request.operation, id: 'computer.next-action' }, signal }
  }
  function nativeProfile() {
    return { ...profile(), operationId: 'computer.next-action' }
  }
  it.each(['success', 'failure'] as const)('Stop returns before late %s; one stable ledger identity, no late decide', async ending => {
    let resolve!: (value: DecisionResponse) => void, reject!: (reason: Error) => void, started!: () => void
    const gate = new Promise<DecisionResponse>((yes, no) => { resolve = yes; reject = no })
    const dispatched = new Promise<void>(yes => { started = yes })
    const abort = new AbortController(), records: DecisionAttemptRecord[] = []
    const op = operation(), decide = vi.spyOn(op, 'decide')
    const result = executeDecisionCascade({ request: nativeRequest(abort.signal), operation: op,
      route: { mode: 'hybrid', primary: provider(async () => { started(); return gate }), profile: nativeProfile(), allowSyntheticProfile: true },
      onAttempt: r => { records.push(r) },
    })
    const rejected = expect(result).rejects.toMatchObject({ kind: 'cancelled' })
    await dispatched; abort.abort(); await rejected
    expect(records.filter(r => r.stage === 'primary_decision')).toHaveLength(2)
    expect(records.every(r => r.invocationState === 'pending' && !r.usage)).toBe(true)
    if (ending === 'success') resolve(response())
    else reject(new Error('raw late credential'))
    await vi.waitFor(() => expect(records.at(-1)?.invocationState).toBe('settled'))
    expect(new Set(records.map(r => r.invocationId)).size).toBe(1)
    expect(records.at(-1)).toMatchObject({ interrupted: true, outcome: ending === 'success' ? 'success' : 'error' })
    expect(records.filter(r => r.usage)).toHaveLength(ending === 'success' ? 1 : 0)
    expect(decide).not.toHaveBeenCalled()
    expect(JSON.stringify(records)).not.toContain('raw late credential')
  })
  it('never dispatches a registered legacy adapter without the native contract', async () => {
    const evaluate = vi.fn(async () => response()), legacy = provider(evaluate)
    delete (legacy as { supportsNativeStrict?: true }).supportsNativeStrict
    const op = operation(), complete = vi.spyOn(op, 'completeWithLlm')
    const result = await executeDecisionCascade({ request: nativeRequest(), operation: op,
      route: { mode: 'hybrid', primary: legacy, profile: nativeProfile(), allowSyntheticProfile: true } })
    expect(result.path).toBe('safe_default')
    expect(evaluate).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })
  it.each(['absent', 'unknown', 'mismatched', 'missing usage', 'malformed usage'])('rejects %s provenance before decide and without another model invocation', async mode => {
    const records: DecisionAttemptRecord[] = [], op = operation()
    const decide = vi.spyOn(op, 'decide'), complete = vi.spyOn(op, 'completeWithLlm')
    const evaluate = vi.fn(async request => {
      expect(request.nativeStrict).toBe(true)
      const result = response()
      if (mode === 'absent') delete result.nativeMetadata
      else result.nativeMetadata = { actualModel: mode === 'unknown' ? null : mode === 'mismatched' ? 'other-model' : request.model.wireId,
        usage: mode === 'missing usage' ? null : mode === 'malformed usage' ? { inputTokens: -1, outputTokens: 1 } : { inputTokens: 1, outputTokens: 1 } }
      return result
    })
    const result = await executeDecisionCascade({ request: nativeRequest(), operation: op,
      route: { mode: 'hybrid', primary: provider(evaluate), profile: nativeProfile(), allowSyntheticProfile: true,
        allowOperationalFailover: true, allowInvalidResponseRecovery: true }, onAttempt: r => { records.push(r) } })
    expect(result.path).toBe('safe_default')
    expect(decide).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(evaluate).toHaveBeenCalledOnce()
    expect(records).toHaveLength(2)
    expect(new Set(records.map(r => r.invocationId)).size).toBe(1)
    expect(records.at(-1)).toMatchObject({ invocationState: 'settled', outcome: 'error' })
  })
  it('never-settling native primary remains pending without fallback', async () => {
    const records: DecisionAttemptRecord[] = []
    const result = await executeDecisionCascade({ request: nativeRequest(), operation: operation(),
      route: { mode: 'hybrid', primary: provider(() => new Promise(() => {})), profile: nativeProfile(), allowSyntheticProfile: true },
      onAttempt: r => { records.push(r) },
    })
    expect(result.path).toBe('safe_default')
    const primary = records.filter(r => r.stage === 'primary_decision')
    expect(primary).toHaveLength(2)
    expect(primary.every(r => r.invocationState === 'pending' && !r.usage)).toBe(true)
  })
  it('downstream audit failure cannot emit primary billable usage twice', async () => {
    const records: DecisionAttemptRecord[] = []
    let fail = true
    await executeDecisionCascade({ request: nativeRequest(), operation: operation(),
      route: { mode: 'hybrid', primary: provider(async () => response()), profile: nativeProfile(), allowSyntheticProfile: true },
      onAttempt: r => {
        records.push(r)
        if (r.stage === 'primary_decision' && r.usage && fail) { fail = false; throw new Error('audit unavailable') }
      },
    })
    expect(records.filter(r => r.stage === 'primary_decision' && r.usage)).toHaveLength(1)
  })
})

it.each([true, false])('primary duration is monotonic only for native=%s; wall clock remains the deadline source', async native => {
  let wall = 1000, monotonic = 100
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  try {
    const request = decisionRequest()
    if (native) request.operation = { ...request.operation, id: 'computer.next-action' }
    const records: DecisionAttemptRecord[] = []
    await executeDecisionCascade({ request, operation: operation(), now: () => wall,
      route: { mode: 'hybrid', primary: provider(async incoming => {
        expect(incoming.deadlineAt).toBe(1050)
        wall += 60000; monotonic += 37.4
        return response()
      }), profile: { ...profile(), operationId: request.operation.id }, allowSyntheticProfile: true },
      onAttempt: record => { records.push(record) },
    })
    expect(records.find(r => r.stage === 'primary_decision' && r.outcome === 'success')!.latencyMs).toBe(native ? 37 : 60000)
  } finally { clock.mockRestore() }
})
