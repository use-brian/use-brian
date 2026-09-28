import { describe, expect, it } from 'vitest'
import { DecisionProviderError } from '../types.js'
import {
  assertDecisionCapabilities,
  isJsonValue,
  validateDecisionRequest,
  validateDecisionResponse,
} from '../validate.js'
import { decisionRequest } from './fixtures.js'

describe('[COMP:decisions/contract] request and response validation', () => {
  it('accepts finite JSON state and an exact native distribution', () => {
    const request = decisionRequest()
    expect(isJsonValue(request.state)).toBe(true)
    expect(validateDecisionRequest(request)).toBe(request)
    const response = {
      providerId: 'fixture',
      model: request.model,
      answers: [{
        kind: 'choice' as const,
        questionId: 'intent',
        value: 'research',
        evidence: {
          source: 'native_distribution' as const,
          probabilities: { ordinary: 0.1, research: 0.9 },
          confidence: 0.8,
        },
      }],
    }
    expect(validateDecisionResponse(request, response)).toBe(response)
  })

  it('rejects cyclic state, duplicate questions, and non-finite values before dispatch', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => validateDecisionRequest({ ...decisionRequest(), state: cyclic as never }))
      .toThrow(DecisionProviderError)
    expect(() => validateDecisionRequest({
      ...decisionRequest(),
      questions: [...decisionRequest().questions, ...decisionRequest().questions],
    })).toThrow(/duplicate question id/)
    expect(() => validateDecisionRequest({ ...decisionRequest(), state: { n: Number.NaN } as never }))
      .toThrow(/JSON/)
  })

  it('rejects missing distribution coverage and does not fabricate probabilities', () => {
    const request = decisionRequest()
    expect(() => validateDecisionResponse(request, {
      providerId: 'fixture',
      model: request.model,
      answers: [{
        kind: 'choice',
        questionId: 'intent',
        value: 'research',
        evidence: { source: 'native_distribution', probabilities: { research: 1 } },
      }],
    })).toThrow(/cover/)

    const accepted = validateDecisionResponse(request, {
      providerId: 'fixture-llm',
      model: request.model,
      answers: [{
        kind: 'choice',
        questionId: 'intent',
        value: 'research',
        evidence: { source: 'unavailable' },
      }],
    })
    expect(accepted.answers[0]!.evidence.probabilities).toBeUndefined()
    expect(accepted.answers[0]!.evidence.confidence).toBeUndefined()
  })

  it('rejects narrower capabilities without truncating or fanning out', () => {
    try {
      assertDecisionCapabilities(decisionRequest(), {
        primitives: ['boolean'],
        batch: false,
        maxOptions: 2,
        maxQuestions: 1,
        maxRubricLevels: 2,
        maxInputTokens: 10_000,
        uncertainty: ['unavailable'],
      })
      throw new Error('expected capability rejection')
    } catch (error) {
      expect(error).toMatchObject({ kind: 'unsupported_capability' })
    }
  })
})
