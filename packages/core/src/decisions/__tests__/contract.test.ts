import { describe, expect, it } from 'vitest'
import { DecisionProviderError } from '../types.js'
import {
  assertDecisionCapabilities, estimateDecisionInputCapacity,
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

  it('checks both complete-state capacities at their exact estimated boundaries', () => {
    const request = { ...decisionRequest(), state: { text: '完整上下文'.repeat(500) },
      questions: [...decisionRequest().questions, { ...decisionRequest().questions[0]!, id: 'second', prompt: 'Longer question '.repeat(30) }] }
    const size = estimateDecisionInputCapacity(request)
    const capabilities = { primitives: ['choice'] as const, batch: true, maxOptions: 255, maxQuestions: 64,
      maxRubricLevels: 10, maxInputTokens: size.whole, maxQuestionInputTokens: size.perQuestion, uncertainty: ['unavailable'] as const }
    expect(size.whole).toBeGreaterThan(size.perQuestion)
    expect(() => assertDecisionCapabilities(request, capabilities)).not.toThrow()
    expect(() => assertDecisionCapabilities(request, { ...capabilities, maxInputTokens: size.whole - 1 })).toThrow(/token capability/)
    expect(() => assertDecisionCapabilities(request, { ...capabilities, maxQuestionInputTokens: size.perQuestion - 1 })).toThrow(/token capability/)
    expect(() => assertDecisionCapabilities(request, { ...capabilities, maxQuestions: 1, maxQuestionInputTokens: 1 })).toThrow(/question count/)
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
