/**
 * Runtime validation for classifier promotion artifacts. Operator files and
 * JSONB rows are untrusted until they pass these schemas and policy checks.
 *
 * [COMP:decisions/promotion-registry]
 */
import { z } from 'zod'
import type {
  DecisionEvaluationProfile,
  JsonValue,
} from '@use-brian/core'
import {
  validateDecisionPromotion,
  type DecisionEvaluationReport,
} from './decision-evaluation.js'

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]))

const operationSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  stateVersion: z.string().min(1),
  questionVersion: z.string().min(1),
}).strict()

const metricsSchema = z.object({
  operation: operationSchema,
  evaluationSegment: z.string().min(1),
  samples: z.number().int().nonnegative(),
  labels: z.number().int().nonnegative(),
  answered: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1).nullable(),
  recall: z.number().min(0).max(1).nullable(),
  coverage: z.number().min(0).max(1),
  cascadeOutcomes: z.record(z.number().int().nonnegative()),
  latencyMs: z.object({
    mean: z.number().finite().nonnegative(),
    p50: z.number().finite().nonnegative(),
    p95: z.number().finite().nonnegative(),
  }).strict(),
  cost: z.object({
    knownUsd: z.number().finite().nonnegative(),
    unknownSamples: z.number().int().nonnegative(),
    meanKnownUsd: z.number().finite().nonnegative().nullable(),
  }).strict(),
}).strict()

const reportProfileSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  operationId: z.string().min(1),
  operationVersion: z.string().min(1),
  stateVersion: z.string().min(1),
  questionVersion: z.string().min(1),
  evaluationSegment: z.string().min(1),
}).strict()

const reportSchema = z.object({
  schemaVersion: z.literal('1'),
  generatedAt: z.string().min(1),
  mode: z.literal('live'),
  model: z.object({
    catalogId: z.string().min(1),
    wireId: z.string().min(1),
  }).strict(),
  evidence: z.literal('recorded'),
  mockedData: z.literal(false),
  productionPromotionEvidence: z.literal(true),
  profiles: z.array(reportProfileSchema).min(1),
  aggregate: metricsSchema.omit({ operation: true }),
  operations: z.array(metricsSchema).min(1),
}).strict()

const profileSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  mode: z.literal('hybrid'),
  operationId: z.string().min(1),
  operationVersion: z.string().min(1),
  stateVersion: z.string().min(1),
  questionVersion: z.string().min(1),
  modelCatalogId: z.string().min(1),
  modelWireId: z.string().min(1),
  evaluationSegment: z.string().min(1),
  status: z.literal('approved'),
  evidence: z.literal('recorded'),
  totalTimeoutMs: z.number().finite().positive(),
  primaryTimeoutMs: z.number().finite().positive(),
  maxAttempts: z.literal(2),
  policy: jsonValueSchema.optional(),
  shadowSampleRate: z.number().finite().positive().max(1).optional(),
}).strict().refine(
  (profile) => profile.primaryTimeoutMs < profile.totalTimeoutMs,
  { message: 'primaryTimeoutMs must be less than totalTimeoutMs' },
)

export const OBSERVATION_ONLY_DECISION_OPERATION_IDS = new Set([
  'ingest.extraction-gate',
  'ingest.sensitivity',
  'feed.reply-classification',
  'feed.draft-safety',
])

export function isAuthorityBearingDecisionOperation(operationId: string): boolean {
  return !OBSERVATION_ONLY_DECISION_OPERATION_IDS.has(operationId)
}

export type DecisionPromotionBundle = {
  profile: DecisionEvaluationProfile
  report: DecisionEvaluationReport
}

export class DecisionPromotionValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`decision promotion rejected: ${issues.join('; ')}`)
    this.name = 'DecisionPromotionValidationError'
    this.issues = issues
  }
}

export function parseDecisionPromotionBundle(
  profileValue: unknown,
  reportValue: unknown,
): DecisionPromotionBundle {
  const profile = profileSchema.parse(profileValue) as DecisionEvaluationProfile
  const report = reportSchema.parse(reportValue) as DecisionEvaluationReport
  const validation = validateDecisionPromotion(profile, report)
  const issues = [...validation.issues]
  if (!isAuthorityBearingDecisionOperation(profile.operationId)) {
    issues.push('observation-only operations cannot be promoted to authority')
  }
  if (issues.length > 0) throw new DecisionPromotionValidationError(issues)
  return { profile, report }
}

export function parseStoredDecisionProfile(value: unknown): DecisionEvaluationProfile {
  return profileSchema.parse(value) as DecisionEvaluationProfile
}
