/**
 * Offline-first evaluator for provider-neutral classifier decisions.
 *
 * Default mode replays checked-in synthetic fixtures. `--estimate` plans a
 * live run without provider calls. `--live` requires explicit call and spend
 * caps and never treats synthetic/offline output as promotion evidence.
 *
 * [COMP:decisions/evaluation]
 */

import {
  createTypeSafeDecisionProvider,
  type DecisionAnswer,
  type DecisionEvaluationProfile,
  type DecisionOperationRef,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionUsage,
  type JsonValue,
} from '@use-brian/core'
import {
  bracketFor,
  isDecisionModelRow,
  modelRates,
  registryRow,
} from '@use-brian/shared/model-registry'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export type DecisionEvalValue = string | number | boolean

export type DecisionEvalFixture = {
  id: string
  evidence: 'synthetic' | 'recorded'
  evaluationSegment: string
  operation: DecisionOperationRef
  state: JsonValue
  questions: DecisionQuestion[]
  expected: Record<string, DecisionEvalValue>
  recorded: {
    answers: Record<string, DecisionEvalValue>
    path: 'primary_complete' | 'generation' | 'uncertainty_review' | 'operational_failover' | 'safe_default'
    latencyMs: number
    usage?: DecisionUsage
  }
}

export type DecisionEvaluationMode = 'offline' | 'estimate' | 'live'

export type DecisionOperationMetrics = {
  operation: DecisionOperationRef
  evaluationSegment: string
  samples: number
  labels: number
  answered: number
  precision: number | null
  recall: number | null
  coverage: number
  cascadeOutcomes: Record<string, number>
  latencyMs: { mean: number; p50: number; p95: number }
  cost: { knownUsd: number; unknownSamples: number; meanKnownUsd: number | null }
}

export type DecisionEvaluationReport = {
  schemaVersion: '1'
  generatedAt: string
  mode: 'offline' | 'live'
  model: { catalogId: string; wireId: string }
  evidence: 'synthetic' | 'recorded'
  mockedData: boolean
  productionPromotionEvidence: boolean
  profiles: Array<{
    id: string
    version: string
    operationId: string
    operationVersion: string
    stateVersion: string
    questionVersion: string
    evaluationSegment: string
  }>
  aggregate: Omit<DecisionOperationMetrics, 'operation'>
  operations: DecisionOperationMetrics[]
}

export type DecisionEvaluationEstimate = {
  schemaVersion: '1'
  generatedAt: string
  mode: 'estimate'
  model: { catalogId: string; wireId: string }
  plannedCalls: number
  plannedQuestions: number
  estimatedInputTokens: number
  estimatedCostUsd: number | null
  pricing: 'known' | 'unknown'
  providerCallsMade: 0
}

export type PromotionValidation = { eligible: boolean; issues: string[] }

export const DEFAULT_DECISION_EVALUATION_MODEL = {
  catalogId: 'typesafe-jev-1.13',
  wireId: 'jev-1.13.0',
} as const
const V1 = { version: '1', stateVersion: '1', questionVersion: '1' } as const

function booleanFixture(
  id: string,
  operationId: string,
  prompt: string,
  expected: boolean,
  predicted: boolean,
  path: DecisionEvalFixture['recorded']['path'] = 'primary_complete',
): DecisionEvalFixture {
  return {
    id,
    evidence: 'synthetic',
    evaluationSegment: 'global',
    operation: { id: operationId, ...V1 },
    state: { text: `Fictional fixture ${id}` },
    questions: [{ id: 'decision', kind: 'boolean', prompt }],
    expected: { decision: expected },
    recorded: {
      answers: { decision: predicted },
      path,
      latencyMs: 12,
      usage: { inputTokens: 32, outputTokens: 0, costUsd: 32 * 0.042 / 1_000_000 },
    },
  }
}

/** Synthetic development fixtures. They are never production approval evidence. */
export const DECISION_EVAL_FIXTURES: readonly DecisionEvalFixture[] = [
  booleanFixture('research-intent-positive', 'research.intent', 'Does this require deep research?', true, true),
  booleanFixture('memory-usefulness-negative', 'memory.usefulness', 'Was this recalled memory useful?', false, false),
  booleanFixture('research-split-positive', 'research.split', 'Should this research request split?', true, true),
  booleanFixture('topic-known-negative', 'memory.topic', 'Does this continue the known topic?', true, true),
  booleanFixture('entity-ambiguous', 'entity.disambiguation', 'Is the first supplied entity the referent?', false, false),
  booleanFixture('task-assistable', 'task.assistability', 'Can the assistant materially help?', true, true),
  booleanFixture('task-readiness-negative', 'task.readiness', 'Is this candidate an actionable task?', false, false),
  booleanFixture('memory-reclassification-keep', 'memory.reclassification', 'Should this memory stay unchanged?', true, true),
  booleanFixture('alias-no-cluster', 'entity.alias-clustering', 'Is an alias cluster present?', false, false),
  booleanFixture('skill-known-group', 'skill.categorization', 'Can this use a supplied group?', true, true),
  booleanFixture('extraction-negative', 'ingest.extraction-gate', 'Is extraction needed?', false, false),
  booleanFixture('sensitivity-observation', 'ingest.sensitivity', 'Is the content confidential?', true, true),
  booleanFixture('feed-reply-observation', 'feed.reply-classification', 'Is this a binding ask?', false, false),
  booleanFixture('feed-safety-observation', 'feed.draft-safety', 'Is this draft safe?', false, false),
] as const

const evaluationJsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(evaluationJsonSchema),
  z.record(evaluationJsonSchema),
]))

const evaluationValueSchema = z.union([z.string(), z.number().finite(), z.boolean()])
const evaluationQuestionSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.literal('choice'),
    prompt: z.string().min(1),
    options: z.array(z.object({
      value: z.string().min(1),
      description: z.string().min(1).optional(),
    }).strict()).min(1),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('boolean'),
    prompt: z.string().min(1),
    criteria: z.object({
      true: z.string().min(1).optional(),
      false: z.string().min(1).optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('score'),
    prompt: z.string().min(1),
    rubric: z.array(z.object({
      value: z.number().finite(),
      description: z.string().min(1),
    }).strict()).min(1),
  }).strict(),
])

const decisionEvalFixtureSchema = z.object({
  id: z.string().min(1),
  evidence: z.enum(['synthetic', 'recorded']),
  evaluationSegment: z.string().min(1),
  operation: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    stateVersion: z.string().min(1),
    questionVersion: z.string().min(1),
  }).strict(),
  state: evaluationJsonSchema,
  questions: z.array(evaluationQuestionSchema).min(1),
  expected: z.record(evaluationValueSchema),
  recorded: z.object({
    answers: z.record(evaluationValueSchema),
    path: z.enum([
      'primary_complete',
      'generation',
      'uncertainty_review',
      'operational_failover',
      'safe_default',
    ]),
    latencyMs: z.number().finite().nonnegative(),
    usage: z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().finite().nonnegative().optional(),
    }).strict().optional(),
  }).strict(),
}).strict()

function valueMatchesQuestion(
  value: DecisionEvalValue,
  question: DecisionQuestion,
): boolean {
  if (question.kind === 'boolean') return typeof value === 'boolean'
  if (question.kind === 'choice') {
    return typeof value === 'string' && question.options.some((option) => option.value === value)
  }
  return typeof value === 'number' && question.rubric.some((level) => level.value === value)
}

export function parseDecisionEvaluationFixtures(value: unknown): DecisionEvalFixture[] {
  const fixtures = z.array(decisionEvalFixtureSchema).min(1).parse(value) as DecisionEvalFixture[]
  const fixtureIds = new Set<string>()
  for (const fixture of fixtures) {
    if (fixtureIds.has(fixture.id)) throw new Error(`duplicate decision evaluation fixture id: ${fixture.id}`)
    fixtureIds.add(fixture.id)
    const questions = new Map<string, DecisionQuestion>()
    for (const question of fixture.questions) {
      if (questions.has(question.id)) {
        throw new Error(`fixture '${fixture.id}' has duplicate question '${question.id}'`)
      }
      questions.set(question.id, question)
    }
    for (const question of fixture.questions) {
      const expected = fixture.expected[question.id]
      if (expected === undefined || !valueMatchesQuestion(expected, question)) {
        throw new Error(`fixture '${fixture.id}' has invalid expected value for '${question.id}'`)
      }
      const recorded = fixture.recorded.answers[question.id]
      if (recorded === undefined || !valueMatchesQuestion(recorded, question)) {
        throw new Error(`fixture '${fixture.id}' has invalid recorded value for '${question.id}'`)
      }
    }
    for (const questionId of [...Object.keys(fixture.expected), ...Object.keys(fixture.recorded.answers)]) {
      if (!questions.has(questionId)) {
        throw new Error(`fixture '${fixture.id}' contains unknown answer '${questionId}'`)
      }
    }
  }
  return fixtures
}

export function loadDecisionEvaluationFixtures(path: string): DecisionEvalFixture[] {
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown
  return parseDecisionEvaluationFixtures(parsed)
}

const PROMOTION_POLICY = {
  promotion: {
    minSamples: 1,
    minPrecision: 0.9,
    minRecall: 0.9,
    minCoverage: 1,
    maxP95LatencyMs: 1_000,
    maxMeanCostUsd: 0.01,
  },
} as const

/** Checked-in profiles stay shadow/evaluation/synthetic by construction. */
export const SYNTHETIC_EVALUATION_PROFILES: readonly DecisionEvaluationProfile[] = DECISION_EVAL_FIXTURES.map(
  (fixture) => ({
    id: `synthetic-${fixture.operation.id.replace(/[^a-z0-9]+/gi, '-')}`,
    version: '1',
    mode: 'shadow',
    operationId: fixture.operation.id,
    operationVersion: fixture.operation.version,
    stateVersion: fixture.operation.stateVersion,
    questionVersion: fixture.operation.questionVersion,
    modelCatalogId: DEFAULT_DECISION_EVALUATION_MODEL.catalogId,
    modelWireId: DEFAULT_DECISION_EVALUATION_MODEL.wireId,
    evaluationSegment: fixture.evaluationSegment,
    status: 'evaluation',
    evidence: 'synthetic',
    totalTimeoutMs: 2_000,
    primaryTimeoutMs: 1_000,
    maxAttempts: 2,
    shadowSampleRate: 0.1,
    policy: PROMOTION_POLICY,
  }),
)

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function pricedCost(modelId: string, usage: DecisionUsage | undefined): number | undefined {
  if (!usage) return undefined
  if (usage.costUsd !== undefined) return usage.costUsd
  const rates = modelRates(modelId)
  if (!rates) return undefined
  const rate = bracketFor(rates, usage.inputTokens)
  return (usage.inputTokens * rate.inPerMTok + usage.outputTokens * rate.outPerMTok) / 1_000_000
}

function pricedModelCost(
  model: { catalogId: string; wireId: string },
  usage: DecisionUsage | undefined,
): number | undefined {
  return pricedCost(model.catalogId, usage) ?? pricedCost(model.wireId, usage)
}

function metricsFor(
  fixtures: readonly DecisionEvalFixture[],
  results: ReadonlyArray<DecisionEvalFixture['recorded']>,
  operation: DecisionOperationRef,
  evaluationSegment: string,
  model: { catalogId: string; wireId: string },
): DecisionOperationMetrics {
  let labels = 0
  let answered = 0
  let matches = 0
  let mismatches = 0
  const outcomes: Record<string, number> = {}
  const latencies: number[] = []
  let knownUsd = 0
  let knownSamples = 0
  let unknownSamples = 0
  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index]!
    const result = results[index]!
    for (const [questionId, expected] of Object.entries(fixture.expected)) {
      labels += 1
      if (!(questionId in result.answers)) continue
      answered += 1
      if (result.answers[questionId] === expected) matches += 1
      else mismatches += 1
    }
    outcomes[result.path] = (outcomes[result.path] ?? 0) + 1
    latencies.push(result.latencyMs)
    const cost = pricedModelCost(model, result.usage)
    if (cost === undefined) unknownSamples += 1
    else {
      knownUsd += cost
      knownSamples += 1
    }
  }
  return {
    operation,
    evaluationSegment,
    samples: fixtures.length,
    labels,
    answered,
    precision: matches + mismatches === 0 ? null : round(matches / (matches + mismatches)),
    recall: labels === 0 ? null : round(matches / labels),
    coverage: labels === 0 ? 0 : round(answered / labels),
    cascadeOutcomes: outcomes,
    latencyMs: {
      mean: latencies.length === 0 ? 0 : round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    cost: {
      knownUsd: round(knownUsd),
      unknownSamples,
      meanKnownUsd: knownSamples === 0 ? null : round(knownUsd / knownSamples),
    },
  }
}

function buildReport(params: {
  mode: 'offline' | 'live'
  fixtures: readonly DecisionEvalFixture[]
  results: ReadonlyArray<DecisionEvalFixture['recorded']>
  model: { catalogId: string; wireId: string }
  now: () => Date
}): DecisionEvaluationReport {
  const groups = new Map<string, {
    ref: DecisionOperationRef
    evaluationSegment: string
    fixtures: DecisionEvalFixture[]
    results: Array<DecisionEvalFixture['recorded']>
  }>()
  params.fixtures.forEach((fixture, index) => {
    const key = [
      fixture.operation.id,
      fixture.operation.version,
      fixture.operation.stateVersion,
      fixture.operation.questionVersion,
      fixture.evaluationSegment,
    ].join('\u0000')
    const group = groups.get(key) ?? {
      ref: fixture.operation,
      evaluationSegment: fixture.evaluationSegment,
      fixtures: [],
      results: [],
    }
    group.fixtures.push(fixture)
    group.results.push(params.results[index]!)
    groups.set(key, group)
  })
  const operations = [...groups.values()].map((group) => (
    metricsFor(
      group.fixtures,
      group.results,
      group.ref,
      group.evaluationSegment,
      params.model,
    )
  ))
  const aggregateOperation: DecisionOperationRef = {
    id: 'aggregate',
    version: '1',
    stateVersion: '1',
    questionVersion: '1',
  }
  const aggregate = metricsFor(
    params.fixtures,
    params.results,
    aggregateOperation,
    'aggregate',
    params.model,
  )
  const { operation: _operation, ...aggregateWithoutOperation } = aggregate
  const evidence = params.fixtures.every((fixture) => fixture.evidence === 'recorded')
    ? 'recorded'
    : 'synthetic'
  const mockedData = params.mode !== 'live' || evidence !== 'recorded'
  return {
    schemaVersion: '1',
    generatedAt: params.now().toISOString(),
    mode: params.mode,
    model: params.model,
    evidence,
    mockedData,
    productionPromotionEvidence: params.mode === 'live' && !mockedData,
    profiles: [...groups.values()].map(({ ref, evaluationSegment }) => ({
      id: `evaluated-${ref.id.replace(/[^a-z0-9]+/gi, '-')}`,
      version: '1',
      operationId: ref.id,
      operationVersion: ref.version,
      stateVersion: ref.stateVersion,
      questionVersion: ref.questionVersion,
      evaluationSegment,
    })),
    aggregate: aggregateWithoutOperation,
    operations,
  }
}

function estimatedInputTokens(fixture: DecisionEvalFixture): number {
  return Math.max(1, Math.ceil(JSON.stringify({ state: fixture.state, questions: fixture.questions }).length / 4))
}

export function estimateDecisionEvaluation(
  fixtures: readonly DecisionEvalFixture[] = DECISION_EVAL_FIXTURES,
  now: () => Date = () => new Date(),
  model: { catalogId: string; wireId: string } = DEFAULT_DECISION_EVALUATION_MODEL,
): DecisionEvaluationEstimate {
  const inputTokens = fixtures.reduce((sum, fixture) => sum + estimatedInputTokens(fixture), 0)
  const rates = modelRates(model.catalogId) ?? modelRates(model.wireId)
  const estimatedCostUsd = rates
    ? fixtures.reduce((sum, fixture) => {
        const tokens = estimatedInputTokens(fixture)
        return sum + tokens * bracketFor(rates, tokens).inPerMTok / 1_000_000
      }, 0)
    : null
  return {
    schemaVersion: '1',
    generatedAt: now().toISOString(),
    mode: 'estimate',
    model,
    plannedCalls: fixtures.length,
    plannedQuestions: fixtures.reduce((sum, fixture) => sum + fixture.questions.length, 0),
    estimatedInputTokens: inputTokens,
    estimatedCostUsd: estimatedCostUsd === null ? null : round(estimatedCostUsd),
    pricing: estimatedCostUsd === null ? 'unknown' : 'known',
    providerCallsMade: 0,
  }
}

function answerValue(answer: DecisionAnswer): DecisionEvalValue {
  return answer.value
}

export async function runDecisionEvaluation(options: {
  mode?: 'offline' | 'live'
  fixtures?: readonly DecisionEvalFixture[]
  provider?: DecisionProvider
  model?: { catalogId: string; wireId: string }
  maxCalls?: number
  maxCostUsd?: number
  now?: () => Date
} = {}): Promise<DecisionEvaluationReport> {
  const mode = options.mode ?? 'offline'
  const fixtures = options.fixtures ?? DECISION_EVAL_FIXTURES
  const model = options.model ?? DEFAULT_DECISION_EVALUATION_MODEL
  const now = options.now ?? (() => new Date())
  if (mode === 'offline') {
    return buildReport({
      mode,
      fixtures,
      results: fixtures.map((fixture) => fixture.recorded),
      model,
      now,
    })
  }
  if (!options.provider) throw new Error('live decision evaluation requires an injected provider')
  if (!Number.isInteger(options.maxCalls) || (options.maxCalls ?? 0) <= 0) {
    throw new Error('live decision evaluation requires --max-calls=<positive integer>')
  }
  if (!Number.isFinite(options.maxCostUsd) || (options.maxCostUsd ?? 0) <= 0) {
    throw new Error('live decision evaluation requires --max-cost-usd=<positive number>')
  }
  if (options.maxCalls! < fixtures.length) {
    throw new Error(`live call cap ${options.maxCalls} is below the ${fixtures.length} planned calls`)
  }
  const estimate = estimateDecisionEvaluation(fixtures, now, model)
  if (estimate.estimatedCostUsd === null) {
    throw new Error('live decision evaluation refuses unknown model pricing')
  }
  if (estimate.estimatedCostUsd > options.maxCostUsd!) {
    throw new Error(`estimated cost $${estimate.estimatedCostUsd} exceeds live cap $${options.maxCostUsd}`)
  }

  const results: Array<DecisionEvalFixture['recorded']> = []
  let spent = 0
  for (const fixture of fixtures) {
    const started = Date.now()
    const response = await options.provider.evaluate({
      runId: `decision-eval-${fixture.id}`,
      operation: fixture.operation,
      model,
      evaluationSegment: fixture.evaluationSegment,
      state: fixture.state,
      questions: fixture.questions,
    })
    const usage = response.usage
    if (!usage) throw new Error('live decision evaluation requires provider usage attribution')
    const cost = pricedModelCost(model, usage)
    if (cost === undefined) throw new Error('live decision evaluation received usage with unknown cost')
    spent += cost
    if (spent > options.maxCostUsd!) {
      throw new Error(`live spend $${round(spent)} exceeded cap $${options.maxCostUsd}`)
    }
    results.push({
      answers: Object.fromEntries(response.answers.map((answer) => [answer.questionId, answerValue(answer)])),
      path: 'primary_complete',
      latencyMs: Math.max(0, Date.now() - started),
      usage: { ...usage, costUsd: cost },
    })
  }
  return buildReport({ mode, fixtures, results, model, now })
}

function promotionThresholds(profile: DecisionEvaluationProfile): {
  minSamples: number
  minPrecision: number
  minRecall: number
  minCoverage: number
  maxP95LatencyMs: number
  maxMeanCostUsd: number
} | null {
  if (!profile.policy || Array.isArray(profile.policy) || typeof profile.policy !== 'object') return null
  const promotion = (profile.policy as Record<string, JsonValue>).promotion
  if (!promotion || Array.isArray(promotion) || typeof promotion !== 'object') return null
  const value = promotion as Record<string, JsonValue>
  const keys = ['minSamples', 'minPrecision', 'minRecall', 'minCoverage', 'maxP95LatencyMs', 'maxMeanCostUsd'] as const
  if (keys.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return null
  return value as ReturnType<typeof promotionThresholds>
}

export function validateDecisionPromotion(
  profile: DecisionEvaluationProfile,
  report: DecisionEvaluationReport,
): PromotionValidation {
  const issues: string[] = []
  if (profile.mode !== 'hybrid') issues.push('promotion profile must target hybrid mode')
  if (profile.status !== 'approved') issues.push('promotion profile must be explicitly approved')
  if (profile.evidence !== 'recorded') issues.push('promotion profile must cite recorded evidence')
  if (report.mockedData || report.evidence !== 'recorded' || !report.productionPromotionEvidence) {
    issues.push('synthetic or mocked reports cannot authorize production promotion')
  }
  if (profile.modelCatalogId !== report.model.catalogId || profile.modelWireId !== report.model.wireId) {
    issues.push('report model does not match profile model')
  }
  const reportProfile = report.profiles.find((entry) => (
    entry.operationId === profile.operationId
    && entry.operationVersion === profile.operationVersion
    && entry.stateVersion === profile.stateVersion
    && entry.questionVersion === profile.questionVersion
    && entry.evaluationSegment === profile.evaluationSegment
  ))
  if (!reportProfile) issues.push('report profile metadata does not match profile operation identity')
  const metrics = report.operations.find((entry) => (
    entry.operation.id === profile.operationId
    && entry.evaluationSegment === profile.evaluationSegment
  ))
  if (!metrics) issues.push('report does not contain the profile operation')
  else if (
    metrics.operation.version !== profile.operationVersion ||
    metrics.operation.stateVersion !== profile.stateVersion ||
    metrics.operation.questionVersion !== profile.questionVersion
  ) issues.push('report operation/question/state versions do not match profile')
  const thresholds = promotionThresholds(profile)
  if (!thresholds) issues.push('promotion profile lacks complete versioned thresholds')
  if (metrics && thresholds) {
    if (metrics.samples < thresholds.minSamples) issues.push('sample count is below promotion minimum')
    if (metrics.precision === null || metrics.precision < thresholds.minPrecision) issues.push('precision is below promotion minimum')
    if (metrics.recall === null || metrics.recall < thresholds.minRecall) issues.push('recall is below promotion minimum')
    if (metrics.coverage < thresholds.minCoverage) issues.push('coverage is below promotion minimum')
    if (metrics.latencyMs.p95 > thresholds.maxP95LatencyMs) issues.push('p95 latency exceeds promotion maximum')
    if (
      metrics.cost.unknownSamples > 0 ||
      metrics.cost.meanKnownUsd === null ||
      metrics.cost.meanKnownUsd > thresholds.maxMeanCostUsd
    ) issues.push('mean cost is unknown or exceeds promotion maximum')
  }
  return { eligible: issues.length === 0, issues }
}

export type DecisionEvaluationCliOptions = {
  mode: DecisionEvaluationMode
  modelAlias?: string
  fixtures?: string
  maxCalls?: number
  maxCostUsd?: number
  output?: string
}

export function parseDecisionEvaluationArgs(args: readonly string[]): DecisionEvaluationCliOptions {
  let mode: DecisionEvaluationMode = 'offline'
  let modelAlias: string | undefined
  let fixtures: string | undefined
  let maxCalls: number | undefined
  let maxCostUsd: number | undefined
  let output: string | undefined
  for (const arg of args) {
    if (arg === '--estimate') {
      if (mode === 'live') throw new Error('--estimate and --live are mutually exclusive')
      mode = 'estimate'
    } else if (arg === '--live') {
      if (mode === 'estimate') throw new Error('--estimate and --live are mutually exclusive')
      mode = 'live'
    } else if (arg.startsWith('--max-calls=')) {
      maxCalls = Number(arg.slice('--max-calls='.length))
    } else if (arg.startsWith('--max-cost-usd=')) {
      maxCostUsd = Number(arg.slice('--max-cost-usd='.length))
    } else if (arg.startsWith('--model=')) {
      modelAlias = arg.slice('--model='.length)
    } else if (arg.startsWith('--fixtures=')) {
      fixtures = arg.slice('--fixtures='.length)
    } else if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length)
    } else {
      throw new Error(`unknown decision evaluation argument: ${arg}`)
    }
  }
  return {
    mode,
    ...(modelAlias ? { modelAlias } : {}),
    ...(fixtures ? { fixtures } : {}),
    ...(maxCalls !== undefined ? { maxCalls } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(output ? { output } : {}),
  }
}

export async function runDecisionEvaluationCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const cli = parseDecisionEvaluationArgs(args)
  const now = () => new Date()
  const fixtures = cli.fixtures
    ? loadDecisionEvaluationFixtures(cli.fixtures)
    : [...DECISION_EVAL_FIXTURES]
  const row = registryRow(cli.modelAlias ?? DEFAULT_DECISION_EVALUATION_MODEL.catalogId)
  if (!row || row.status !== 'active' || !isDecisionModelRow(row)) {
    throw new Error('configured evaluation model is not an active decision model')
  }
  const model = {
    catalogId: row.alias,
    wireId: row.decisionCapabilities.wireModelId,
  }
  let output: DecisionEvaluationReport | DecisionEvaluationEstimate
  if (cli.mode === 'estimate') {
    output = estimateDecisionEvaluation(fixtures, now, model)
  } else if (cli.mode === 'live') {
    if (row.decisionCapabilities.adapterId !== 'typesafe') {
      throw new Error(`live CLI has no configured adapter factory for '${row.decisionCapabilities.adapterId}'`)
    }
    const apiKey = process.env.TYPESAFE_API_KEY?.trim()
    if (!apiKey) throw new Error('live decision evaluation requires TYPESAFE_API_KEY')
    output = await runDecisionEvaluation({
      mode: 'live',
      fixtures,
      provider: createTypeSafeDecisionProvider({ apiKey }),
      model,
      maxCalls: cli.maxCalls,
      maxCostUsd: cli.maxCostUsd,
      now,
    })
  } else {
    output = await runDecisionEvaluation({ mode: 'offline', fixtures, model, now })
  }
  const defaultPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'eval-results',
    `decisions-${output.mode}-${output.generatedAt.replace(/[:.]/g, '-')}.json`,
  )
  const outputPath = resolve(cli.output ?? defaultPath)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`Decision evaluation (${output.mode}) written to ${outputPath}`)
  if ('mockedData' in output && output.mockedData) {
    console.log('Synthetic/mock data only: this report cannot authorize production promotion.')
  }
  if (output.mode === 'estimate' && output.pricing === 'unknown') {
    console.log('Estimated cost: unknown (live mode will refuse this model).')
  }
  return 0
}
