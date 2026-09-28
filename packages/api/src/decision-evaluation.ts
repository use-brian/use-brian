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
import { bracketFor, modelRates, registryRow } from '@use-brian/shared/model-registry'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type DecisionEvalValue = string | number | boolean

export type DecisionEvalFixture = {
  id: string
  evidence: 'synthetic' | 'recorded'
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

const MODEL = { catalogId: 'typesafe-jev-1.13', wireId: 'jev-1.13.0' } as const
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
    modelCatalogId: MODEL.catalogId,
    modelWireId: MODEL.wireId,
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

function metricsFor(
  fixtures: readonly DecisionEvalFixture[],
  results: ReadonlyArray<DecisionEvalFixture['recorded']>,
  operation: DecisionOperationRef,
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
    const cost = pricedCost(MODEL.catalogId, result.usage)
    if (cost === undefined) unknownSamples += 1
    else {
      knownUsd += cost
      knownSamples += 1
    }
  }
  return {
    operation,
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
  now: () => Date
}): DecisionEvaluationReport {
  const groups = new Map<string, { ref: DecisionOperationRef; fixtures: DecisionEvalFixture[]; results: Array<DecisionEvalFixture['recorded']> }>()
  params.fixtures.forEach((fixture, index) => {
    const group = groups.get(fixture.operation.id) ?? { ref: fixture.operation, fixtures: [], results: [] }
    group.fixtures.push(fixture)
    group.results.push(params.results[index]!)
    groups.set(fixture.operation.id, group)
  })
  const operations = [...groups.values()].map((group) => metricsFor(group.fixtures, group.results, group.ref))
  const aggregateOperation: DecisionOperationRef = {
    id: 'aggregate',
    version: '1',
    stateVersion: '1',
    questionVersion: '1',
  }
  const aggregate = metricsFor(params.fixtures, params.results, aggregateOperation)
  const { operation: _operation, ...aggregateWithoutOperation } = aggregate
  const evidence = params.fixtures.every((fixture) => fixture.evidence === 'recorded')
    ? 'recorded'
    : 'synthetic'
  const mockedData = params.mode !== 'live' || evidence !== 'recorded'
  return {
    schemaVersion: '1',
    generatedAt: params.now().toISOString(),
    mode: params.mode,
    model: MODEL,
    evidence,
    mockedData,
    productionPromotionEvidence: params.mode === 'live' && !mockedData,
    profiles: SYNTHETIC_EVALUATION_PROFILES
      .filter((profile) => groups.has(profile.operationId))
      .map((profile) => ({
        id: profile.id,
        version: profile.version,
        operationId: profile.operationId,
        operationVersion: profile.operationVersion,
        stateVersion: profile.stateVersion,
        questionVersion: profile.questionVersion,
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
  model: { catalogId: string; wireId: string } = MODEL,
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
  maxCalls?: number
  maxCostUsd?: number
  now?: () => Date
} = {}): Promise<DecisionEvaluationReport> {
  const mode = options.mode ?? 'offline'
  const fixtures = options.fixtures ?? DECISION_EVAL_FIXTURES
  const now = options.now ?? (() => new Date())
  if (mode === 'offline') {
    return buildReport({ mode, fixtures, results: fixtures.map((fixture) => fixture.recorded), now })
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
  const estimate = estimateDecisionEvaluation(fixtures, now)
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
      model: MODEL,
      state: fixture.state,
      questions: fixture.questions,
    })
    const usage = response.usage
    if (!usage) throw new Error('live decision evaluation requires provider usage attribution')
    const cost = pricedCost(MODEL.catalogId, usage)
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
  return buildReport({ mode, fixtures, results, now })
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
  const metrics = report.operations.find((entry) => entry.operation.id === profile.operationId)
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
  maxCalls?: number
  maxCostUsd?: number
  output?: string
}

export function parseDecisionEvaluationArgs(args: readonly string[]): DecisionEvaluationCliOptions {
  let mode: DecisionEvaluationMode = 'offline'
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
    } else if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length)
    } else {
      throw new Error(`unknown decision evaluation argument: ${arg}`)
    }
  }
  return {
    mode,
    ...(maxCalls !== undefined ? { maxCalls } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(output ? { output } : {}),
  }
}

export async function runDecisionEvaluationCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const cli = parseDecisionEvaluationArgs(args)
  const now = () => new Date()
  let output: DecisionEvaluationReport | DecisionEvaluationEstimate
  if (cli.mode === 'estimate') {
    output = estimateDecisionEvaluation(DECISION_EVAL_FIXTURES, now)
  } else if (cli.mode === 'live') {
    const apiKey = process.env.TYPESAFE_API_KEY?.trim()
    if (!apiKey) throw new Error('live decision evaluation requires TYPESAFE_API_KEY')
    const row = registryRow(MODEL.catalogId)
    if (!row || row.inference !== 'decision') throw new Error('configured evaluation model is not a decision model')
    output = await runDecisionEvaluation({
      mode: 'live',
      provider: createTypeSafeDecisionProvider({ apiKey }),
      maxCalls: cli.maxCalls,
      maxCostUsd: cli.maxCostUsd,
      now,
    })
  } else {
    output = await runDecisionEvaluation({ mode: 'offline', now })
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
