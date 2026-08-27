import { z } from 'zod'

export const DECISION_EVENT_SCHEMA_VERSION = 1 as const

export const decisionDeclaredScopeSchema = z.enum([
  'instance',
  'entity',
  'account',
  'tool',
  'user',
  'assistant',
  'workspace',
])

export const decisionVisibilitySchema = z.enum(['owner', 'workspace'])
export const decisionSensitivitySchema = z.enum([
  'public',
  'internal',
  'confidential',
  'restricted',
])

export type DecisionDeclaredScope = z.infer<typeof decisionDeclaredScopeSchema>
export type DecisionVisibility = z.infer<typeof decisionVisibilitySchema>
export type DecisionSensitivity = z.infer<typeof decisionSensitivitySchema>

export const stableExternalIdentitySchema = z.object({
  provider: z.string().trim().min(1).max(64),
  providerInstanceKey: z.string().trim().min(1).max(256),
  subjectId: z.string().trim().min(1).max(512),
}).strict()

export type StableExternalIdentity = z.infer<typeof stableExternalIdentitySchema>

/**
 * Convert a provider-owned CRM reference into mutation-grade identity.
 *
 * The allowlist is deliberately narrow. A generic `{provider,id}` object is
 * only metadata: without the provider installation namespace, the same
 * subject token can name different people. Extend this switch when an adapter
 * has a documented, stable subject namespace.
 */
export function stableExternalIdentityFromCrmRef(
  input: unknown,
): StableExternalIdentity | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const ref = input as Record<string, unknown>
  const provider = typeof ref.provider === 'string' ? ref.provider.trim().toLowerCase() : ''
  if (provider !== 'slack') return null
  const providerInstanceKey = typeof ref.team_id === 'string' ? ref.team_id.trim() : ''
  const subjectId = typeof ref.id === 'string' ? ref.id.trim() : ''
  const parsed = stableExternalIdentitySchema.safeParse({ provider, providerInstanceKey, subjectId })
  return parsed.success ? parsed.data : null
}

const baseDecisionEventShape = {
  idempotencyKey: z.string().trim().min(1).max(512),
  workspaceId: z.string().uuid().nullable(),
  actorUserId: z.string().uuid(),
  assistantId: z.string().uuid().nullable().optional().default(null),
  sessionId: z.string().uuid().nullable().optional().default(null),
  schemaVersion: z.literal(DECISION_EVENT_SCHEMA_VERSION).default(DECISION_EVENT_SCHEMA_VERSION),
  sourceKind: z.string().trim().min(1).max(64),
  sourceId: z.string().trim().min(1).max(512),
  declaredScope: decisionDeclaredScopeSchema,
  visibility: decisionVisibilitySchema,
  sensitivity: decisionSensitivitySchema,
  reason: z.string().trim().max(1_000).nullable().optional().default(null),
  causedByEventId: z.string().uuid().nullable().optional().default(null),
  causedByApplicationId: z.string().uuid().nullable().optional().default(null),
  reversesEventId: z.string().uuid().nullable().optional().default(null),
} as const

const approvalDecidedSchema = z.object({
  ...baseDecisionEventShape,
  eventKind: z.literal('approval.decided'),
  payload: z.object({
    approvalId: z.string().uuid().optional(),
    toolCallId: z.string().trim().min(1).max(512).optional(),
    approvalKind: z.string().trim().min(1).max(64),
    toolName: z.string().trim().min(1).max(256).nullable().optional(),
    resolution: z.enum(['allow', 'deny', 'always_allow', 'always_deny']),
    revision: z.number().int().positive().max(1_000_000).optional(),
    accountKey: z.string().trim().min(1).max(256).nullable().optional(),
  }).strict().refine(
    (payload) => payload.approvalId !== undefined || payload.toolCallId !== undefined,
    'approvalId or toolCallId is required',
  ),
}).strict()

const emailDraftRevisedSchema = z.object({
  ...baseDecisionEventShape,
  eventKind: z.literal('email.draft_revised'),
  payload: z.object({
    previousApprovalId: z.string().uuid(),
    replacementApprovalId: z.string().uuid(),
    previousRevision: z.number().int().positive().max(1_000_000),
    newRevision: z.number().int().positive().max(1_000_000),
    accountKey: z.string().trim().min(1).max(256).nullable().optional(),
  }).strict(),
}).strict()

const entitiesMergedSchema = z.object({
  ...baseDecisionEventShape,
  eventKind: z.literal('crm.entities_merged'),
  payload: z.object({
    mergeId: z.string().uuid(),
    survivingEntityId: z.string().uuid(),
    mergedEntityId: z.string().uuid(),
    bindingNamespaces: z.array(stableExternalIdentitySchema).max(50).default([]),
  }).strict(),
}).strict()

const mergeUndoneSchema = z.object({
  ...baseDecisionEventShape,
  eventKind: z.literal('crm.merge_undone'),
  payload: z.object({
    mergeId: z.string().uuid(),
    survivingEntityId: z.string().uuid(),
    restoredEntityId: z.string().uuid(),
  }).strict(),
}).strict()

const keptSeparateSchema = z.object({
  ...baseDecisionEventShape,
  eventKind: z.literal('crm.entities_kept_separate'),
  payload: z.object({
    separationId: z.string().uuid(),
    leftEntityId: z.string().uuid(),
    rightEntityId: z.string().uuid(),
  }).strict(),
}).strict()

const separationRetiredSchema = z.object({
  ...baseDecisionEventShape,
  eventKind: z.literal('crm.separation_retired'),
  payload: z.object({
    separationId: z.string().uuid(),
    leftEntityId: z.string().uuid(),
    rightEntityId: z.string().uuid(),
  }).strict(),
}).strict()

const brainVerificationSchema = z.object({
  ...baseDecisionEventShape,
  eventKind: z.literal('brain.verification_recorded'),
  payload: z.object({
    primitive: z.string().trim().min(1).max(64),
    targetId: z.string().uuid(),
    action: z.string().trim().min(1).max(64),
    changedFields: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  }).strict(),
}).strict()

const taskRejectedSchema = z.object({
  ...baseDecisionEventShape,
  eventKind: z.literal('task.rejected'),
  payload: z.object({
    taskId: z.string().uuid(),
    tombstoneId: z.string().uuid(),
    activeRuleId: z.string().uuid().nullable().optional(),
    proposedRuleId: z.string().uuid().nullable().optional(),
    reasonStoredOn: z.literal('task_tombstone'),
  }).strict(),
}).strict()

const playbookRuleDecidedSchema = z.object({
  ...baseDecisionEventShape,
  eventKind: z.literal('playbook.rule_decided'),
  payload: z.object({
    ruleId: z.string().uuid(),
    decision: z.enum(['approve', 'reject', 'retire', 'restore']),
  }).strict(),
}).strict()

export const decisionEventWriteSchema = z.discriminatedUnion('eventKind', [
  approvalDecidedSchema,
  emailDraftRevisedSchema,
  entitiesMergedSchema,
  mergeUndoneSchema,
  keptSeparateSchema,
  separationRetiredSchema,
  brainVerificationSchema,
  taskRejectedSchema,
  playbookRuleDecidedSchema,
])

/** Caller-facing input. Fields with registry defaults may be omitted. */
export type DecisionEventWrite = z.input<typeof decisionEventWriteSchema>
/** Parsed journal event with every registry default materialized. */
export type DecisionEvent = z.output<typeof decisionEventWriteSchema>
export type DecisionEventKind = DecisionEvent['eventKind']

export const DECISION_EVENT_KINDS = [
  'approval.decided',
  'email.draft_revised',
  'crm.entities_merged',
  'crm.merge_undone',
  'crm.entities_kept_separate',
  'crm.separation_retired',
  'brain.verification_recorded',
  'task.rejected',
  'playbook.rule_decided',
] as const satisfies readonly DecisionEventKind[]

export function parseDecisionEventWrite(input: unknown): DecisionEvent {
  return decisionEventWriteSchema.parse(input)
}
