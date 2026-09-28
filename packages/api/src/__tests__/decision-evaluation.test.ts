import { describe, expect, it, vi } from 'vitest'
import type { DecisionEvaluationProfile, DecisionProvider } from '@use-brian/core'
import {
  DECISION_EVAL_FIXTURES,
  SYNTHETIC_EVALUATION_PROFILES,
  estimateDecisionEvaluation,
  parseDecisionEvaluationArgs,
  parseDecisionEvaluationFixtures,
  runDecisionEvaluation,
  validateDecisionPromotion,
  type DecisionEvaluationReport,
} from '../decision-evaluation.js'

function provider(evaluate: DecisionProvider['evaluate']): DecisionProvider {
  return {
    id: 'fixture-live-decision',
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

describe('[COMP:decisions/evaluation] decision evaluation runner', () => {
  it('replays fixtures offline and marks the report ineligible for production evidence', async () => {
    const report = await runDecisionEvaluation({
      mode: 'offline',
      now: () => new Date('2026-09-28T00:00:00.000Z'),
    })

    expect(report).toMatchObject({
      mode: 'offline',
      evidence: 'synthetic',
      mockedData: true,
      productionPromotionEvidence: false,
      aggregate: {
        samples: DECISION_EVAL_FIXTURES.length,
        precision: 1,
        recall: 1,
        coverage: 1,
      },
    })
    expect(report.operations.map((entry) => entry.operation.id)).toContain('feed.draft-safety')
    expect(report.profiles.every((profile) => profile.version === '1')).toBe(true)
  })

  it('estimates provider calls, input volume, and catalog cost without dispatch', () => {
    const estimate = estimateDecisionEvaluation(
      DECISION_EVAL_FIXTURES.slice(0, 2),
      () => new Date('2026-09-28T00:00:00.000Z'),
    )
    expect(estimate).toMatchObject({
      mode: 'estimate',
      plannedCalls: 2,
      plannedQuestions: 2,
      pricing: 'known',
      providerCallsMade: 0,
    })
    expect(estimate.estimatedInputTokens).toBeGreaterThan(0)
    expect(estimate.estimatedCostUsd).toBeGreaterThan(0)

    const unknown = estimateDecisionEvaluation(
      DECISION_EVAL_FIXTURES.slice(0, 1),
      () => new Date(),
      { catalogId: 'fictional-unknown-model', wireId: 'fictional-unknown-model-v1' },
    )
    expect(unknown).toMatchObject({ pricing: 'unknown', estimatedCostUsd: null })
  })

  it('refuses uncapped or under-capped live work before provider dispatch', async () => {
    const evaluate = vi.fn(async () => { throw new Error('must not dispatch') })
    const liveProvider = provider(evaluate)
    const fixtures = DECISION_EVAL_FIXTURES.slice(0, 2)

    await expect(runDecisionEvaluation({ mode: 'live', fixtures, provider: liveProvider }))
      .rejects.toThrow(/max-calls/)
    await expect(runDecisionEvaluation({
      mode: 'live', fixtures, provider: liveProvider, maxCalls: 1, maxCostUsd: 1,
    })).rejects.toThrow(/below the 2 planned calls/)
    await expect(runDecisionEvaluation({
      mode: 'live', fixtures, provider: liveProvider, maxCalls: 2, maxCostUsd: 0.000000001,
    })).rejects.toThrow(/exceeds live cap/)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('runs bounded injected live calls and records non-mocked evidence', async () => {
    const fixtures = DECISION_EVAL_FIXTURES.slice(0, 2).map((fixture) => ({
      ...fixture,
      evidence: 'recorded' as const,
    }))
    const evaluate = vi.fn<DecisionProvider['evaluate']>(async (request) => {
      const fixture = fixtures.find((entry) => `decision-eval-${entry.id}` === request.runId)!
      return {
        providerId: 'fixture-live-decision',
        model: request.model,
        answers: request.questions.map((question) => ({
          questionId: question.id,
          kind: 'boolean' as const,
          value: fixture.expected[question.id] as boolean,
          evidence: { source: 'native_distribution' as const, confidence: 0.99 },
        })),
        usage: { inputTokens: 20, outputTokens: 0 },
      }
    })

    const report = await runDecisionEvaluation({
      mode: 'live',
      fixtures,
      provider: provider(evaluate),
      maxCalls: 2,
      maxCostUsd: 0.01,
      now: () => new Date('2026-09-28T00:00:00.000Z'),
    })

    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(report).toMatchObject({
      mode: 'live',
      evidence: 'recorded',
      mockedData: false,
      productionPromotionEvidence: true,
      aggregate: { precision: 1, recall: 1, coverage: 1 },
    })
  })

  it('binds reports and provider requests to an injected decision model', async () => {
    const fixture = { ...DECISION_EVAL_FIXTURES[0]!, evidence: 'recorded' as const }
    const model = { catalogId: 'typesafe-jev-1.13', wireId: 'fictional-wire-v2' }
    const evaluate = vi.fn<DecisionProvider['evaluate']>(async (request) => ({
      providerId: 'fixture-live-decision',
      model: request.model,
      answers: [{
        questionId: 'decision',
        kind: 'boolean',
        value: fixture.expected.decision as boolean,
        evidence: { source: 'native_distribution', confidence: 0.99 },
      }],
      usage: { inputTokens: 20, outputTokens: 0, costUsd: 0.0001 },
    }))

    const report = await runDecisionEvaluation({
      mode: 'live',
      fixtures: [fixture],
      provider: provider(evaluate),
      model,
      maxCalls: 1,
      maxCostUsd: 0.01,
    })

    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ model }))
    expect(report.model).toEqual(model)
  })

  it('validates operator fixture shape, labels, and answer vocabulary', () => {
    const fixture = { ...DECISION_EVAL_FIXTURES[0]!, evidence: 'recorded' as const }
    expect(parseDecisionEvaluationFixtures([fixture])).toEqual([fixture])
    expect(() => parseDecisionEvaluationFixtures([
      { ...fixture, expected: { decision: 'not-a-boolean' } },
    ])).toThrow(/invalid expected value/)
    expect(() => parseDecisionEvaluationFixtures([fixture, fixture])).toThrow(/duplicate/)
  })

  it('keeps live calls over synthetic fixtures ineligible for production promotion', async () => {
    const fixtures = DECISION_EVAL_FIXTURES.slice(0, 1)
    const evaluate = vi.fn<DecisionProvider['evaluate']>(async (request) => ({
      providerId: 'fixture-live-decision',
      model: request.model,
      answers: [{
        questionId: 'decision',
        kind: 'boolean',
        value: true,
        evidence: { source: 'native_distribution', confidence: 0.99 },
      }],
      usage: { inputTokens: 20, outputTokens: 0 },
    }))

    const report = await runDecisionEvaluation({
      mode: 'live',
      fixtures,
      provider: provider(evaluate),
      maxCalls: 1,
      maxCostUsd: 0.01,
    })

    expect(report).toMatchObject({
      evidence: 'synthetic',
      mockedData: true,
      productionPromotionEvidence: false,
    })
  })

  it('requires exact recorded versions, thresholds, and approval for promotion', async () => {
    const offline = await runDecisionEvaluation({ mode: 'offline' })
    const syntheticProfile = SYNTHETIC_EVALUATION_PROFILES[0]!
    expect(validateDecisionPromotion(syntheticProfile, offline)).toMatchObject({ eligible: false })

    const recorded = {
      ...offline,
      mode: 'live',
      evidence: 'recorded',
      mockedData: false,
      productionPromotionEvidence: true,
    } as DecisionEvaluationReport
    const approved = {
      ...syntheticProfile,
      mode: 'hybrid',
      status: 'approved',
      evidence: 'recorded',
    } as DecisionEvaluationProfile
    expect(validateDecisionPromotion(approved, recorded)).toEqual({ eligible: true, issues: [] })
    expect(validateDecisionPromotion(
      { ...approved, questionVersion: '2' },
      recorded,
    )).toMatchObject({ eligible: false, issues: expect.arrayContaining([expect.stringMatching(/versions/)]) })
  })

  it('parses explicit modes and rejects conflicting or unknown flags', () => {
    expect(parseDecisionEvaluationArgs([])).toEqual({ mode: 'offline' })
    expect(parseDecisionEvaluationArgs(['--estimate'])).toEqual({ mode: 'estimate' })
    expect(parseDecisionEvaluationArgs([
      '--live', '--model=typesafe-jev-1.13', '--fixtures=/tmp/fixtures.json',
      '--max-calls=14', '--max-cost-usd=0.25', '--output=/tmp/report.json',
    ])).toEqual({
      mode: 'live',
      modelAlias: 'typesafe-jev-1.13',
      fixtures: '/tmp/fixtures.json',
      maxCalls: 14,
      maxCostUsd: 0.25,
      output: '/tmp/report.json',
    })
    expect(() => parseDecisionEvaluationArgs(['--estimate', '--live'])).toThrow(/mutually exclusive/)
    expect(() => parseDecisionEvaluationArgs(['--mystery'])).toThrow(/unknown/)
  })
})
