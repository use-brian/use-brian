/**
 * Explicitly delegated approval review: the pure contracts shared by the API
 * domain services, Brian tools, MCP and app-web.
 *
 * Nothing here reads a database, a clock it was not handed, or a model. The
 * API layer supplies the frozen request facts; these functions decide what a
 * request IS (its action descriptor), whether it is human-only (D47), whether
 * it matches a human-approved pattern exactly (D42), whether human evidence
 * qualifies (D43), and which explicit assignment applies (D45/D46).
 *
 * Spec: docs/architecture/features/approval-review.md
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { checkVerbCeiling } from '../sandbox/verb-ceiling.js'

/** D43: consistent human approvals on distinct executions needed to activate a pattern. */
export const REQUIRED_HUMAN_APPROVALS = 3

// ── Assignment ────────────────────────────────────────────────────────────

/** Most specific first: a request override wins its task, session and procedure default. */
export const APPROVAL_REVIEW_SCOPE_KINDS = ['request', 'task', 'session', 'workflow', 'browser_skill'] as const
export const approvalReviewScopeKindSchema = z.enum(APPROVAL_REVIEW_SCOPE_KINDS)
export type ApprovalReviewScopeKind = z.infer<typeof approvalReviewScopeKindSchema>

export type ApprovalReviewAssignmentStatus = 'active' | 'revoked'
/** Where the human made the assignment. Never `mcp`: programmatic callers cannot delegate. */
export type ApprovalReviewOrigin = 'ui' | 'chat'

// ── Parameter policy ──────────────────────────────────────────────────────

const RECIPIENT_LIKE = /(^|[._])(to|cc|bcc|recipients?|emails?|address(es)?|phones?|chat_?id|channel_?id|user_?ids?|members?)$|recipient/i
const ATTACHMENT_LIKE = /attach|file|document|upload|media/i

/**
 * A human-declared varying field. Absent a rule a field must be exactly equal.
 * Nothing here is inferred from examples: a rule exists only because a human
 * wrote it on the assignment.
 */
export const parameterRuleSchema = z.discriminatedUnion('rule', [
  z.object({ rule: z.literal('text'), maxLength: z.number().int().min(1).max(10_000) }).strict(),
  z.object({ rule: z.literal('one_of'), values: z.array(z.union([z.string().max(500), z.number(), z.boolean()])).min(1).max(50) }).strict(),
  z.object({ rule: z.literal('number_max'), max: z.number().finite() }).strict(),
])
export type ParameterRule = z.infer<typeof parameterRuleSchema>

export const parameterPolicySchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  parameterRuleSchema,
).superRefine((policy, ctx) => {
  const keys = Object.keys(policy)
  if (keys.length > 20) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at most 20 varying fields' })
  for (const [field, rule] of Object.entries(policy)) {
    if ((RECIPIENT_LIKE.test(field) || ATTACHMENT_LIKE.test(field)) && rule.rule !== 'one_of') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'recipient and attachment fields accept only an explicit one_of list' })
    }
  }
})
export type ParameterPolicy = z.infer<typeof parameterPolicySchema>

function satisfiesRule(rule: ParameterRule, value: unknown): boolean {
  switch (rule.rule) {
    case 'text': return typeof value === 'string' && value.length <= rule.maxLength
    case 'one_of': return (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      && rule.values.some((allowed) => allowed === value)
    case 'number_max': return typeof value === 'number' && Number.isFinite(value) && value <= rule.max
  }
}

// ── Canonical hashing ─────────────────────────────────────────────────────

/** Deterministic JSON: object keys sorted at every depth, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** Digest of a workflow step's authored definition (layout excluded). */
export function digestStepDefinition(step: unknown): string {
  return digestOf(step)
}

// ── Action descriptors ────────────────────────────────────────────────────

export type ProcedureRef =
  | { kind: 'workflow'; id: string; stepId: string; definitionDigest: string }
  | { kind: 'browser_skill'; id: string; version: number; stepId: string }

export type ActionDescriptor = {
  /** Canonical action kind (canonical tool name, or `browser.terminal_send`). */
  actionKind: string
  procedure: ProcedureRef
  /** Immutable executing identity: account key, browser profile, or executor assistant. */
  identity: string
  /** The frozen, resolved parameters the request would execute. */
  parameters: Record<string, unknown>
  /** Server-authored text describing the effect (never model text). */
  effectTexts: string[]
}

export type UnresolvedReason =
  | 'ineligible_kind'
  | 'no_procedure'
  | 'unknown_identity'
  | 'unknown_action'
  | 'skill_version_missing'
  | 'send_drift'
  | 'verb_ceiling'

export type DescriptorResult = { ok: true; descriptor: ActionDescriptor } | { ok: false; reason: UnresolvedReason }

/** The frozen facts of a request, as the server persisted them. */
export type DescriptorSource =
  | {
      kind: 'workflow_step'
      toolName: string | null
      arguments: Record<string, unknown>
      workflowId: string | null
      stepId: string | null
      /** The step's authored definition at request time; null when the run or step is gone. */
      stepDefinition: unknown
      accountKey: string | null
      originatingAssistantId: string | null
      description: string | null
    }
  | { kind: 'browser_skill_send'; payload: Record<string, unknown> }
  | { kind: string }

export function canonicalActionKind(toolName: string): string {
  const suffix = toolName.indexOf('__')
  return suffix === -1 ? toolName : toolName.slice(0, suffix)
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function deriveActionDescriptor(source: DescriptorSource): DescriptorResult {
  if (source.kind === 'workflow_step') {
    const s = source as Extract<DescriptorSource, { kind: 'workflow_step' }>
    if (!s.toolName || !/^[a-zA-Z0-9_.:-]+$/.test(s.toolName)) return { ok: false, reason: 'unknown_action' }
    if (!s.workflowId || !s.stepId || s.stepDefinition == null) return { ok: false, reason: 'no_procedure' }
    const identity = s.accountKey ? `account:${s.accountKey}` : s.originatingAssistantId ? `assistant:${s.originatingAssistantId}` : null
    if (!identity) return { ok: false, reason: 'unknown_identity' }
    const actionKind = canonicalActionKind(s.toolName)
    return {
      ok: true,
      descriptor: {
        actionKind,
        procedure: { kind: 'workflow', id: s.workflowId, stepId: s.stepId, definitionDigest: digestStepDefinition(s.stepDefinition) },
        identity,
        parameters: s.arguments ?? {},
        effectTexts: [humanizeAction(actionKind), ...(s.description ? [s.description] : [])],
      },
    }
  }
  if (source.kind === 'browser_skill_send') {
    const p = (source as Extract<DescriptorSource, { kind: 'browser_skill_send' }>).payload
    if (str(p.ceiling)) return { ok: false, reason: 'verb_ceiling' }
    if (str(p.drift)) return { ok: false, reason: 'send_drift' }
    const skillId = str(p.skillId)
    const profileId = str(p.profileId)
    if (!skillId) return { ok: false, reason: 'no_procedure' }
    if (typeof p.skillVersion !== 'number' || !Number.isInteger(p.skillVersion) || p.skillVersion < 1) {
      return { ok: false, reason: 'skill_version_missing' }
    }
    if (!profileId) return { ok: false, reason: 'unknown_identity' }
    const ref = str(p.ref)
    if (!ref) return { ok: false, reason: 'unknown_action' }
    const label = str(p.label)
    const description = str(p.description)
    return {
      ok: true,
      descriptor: {
        actionKind: 'browser.terminal_send',
        procedure: { kind: 'browser_skill', id: skillId, version: p.skillVersion, stepId: ref },
        identity: `browser_profile:${profileId}`,
        parameters: { ref, label, description, site: str(p.site) },
        effectTexts: [label, description].filter((t): t is string => Boolean(t)),
      },
    }
  }
  return { ok: false, reason: 'ineligible_kind' }
}

function humanizeAction(actionKind: string): string {
  return actionKind.replace(/[._:-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

// ── D47: human-only categories ────────────────────────────────────────────

export const HUMAN_ONLY_CATEGORIES = ['payment', 'transfer', 'account_deletion', 'security', 'bulk_destructive'] as const
export type HumanOnlyCategory = (typeof HUMAN_ONLY_CATEGORIES)[number]

const CEILING_CATEGORY: Record<string, HumanOnlyCategory> = {
  financial_transfer: 'transfer',
  payment: 'payment',
  account_deletion: 'account_deletion',
  security_settings: 'security',
  mass_delete: 'bulk_destructive',
}

const ACTION_RULES: ReadonlyArray<{ category: HumanOnlyCategory; pattern: RegExp }> = [
  { category: 'transfer', pattern: /\b(transfer|wire|payout|withdraw\w*|remit\w*)\b/ },
  { category: 'payment', pattern: /\b(pay|pays|payment|payments|charge|refund|purchase|checkout|invoice pay|billing|subscribe|subscription)\b/ },
  { category: 'account_deletion', pattern: /\b(delete|deactivate|close|terminate|disable|remove|offboard)\b.*\b(account|accounts|user|users|member|members|workspace|assistant|assistants)\b/ },
  { category: 'security', pattern: /\b(password|passcode|secret|secrets|credential|credentials|token|tokens|key|keys|permission|permissions|grant|grants|role|roles|access|capability|capabilities|policy|policies|mfa|2fa|auth|oauth|sso|share|invite|connector)\b/ },
  { category: 'bulk_destructive', pattern: /\b(bulk|mass|purge|wipe|flush|truncate|destroy)\b/ },
]
const DESTRUCTIVE_VERB = /\b(delete|remove|archive|cancel|revoke|unpublish|retract)\b/

/**
 * D47. A hit means no assignment, learned pattern or standing grant may
 * resolve the request: a human decides each time. Over-classification only
 * keeps the human path; it never adds an approval gate to an action that did
 * not already require one.
 */
export function humanOnlyCategory(input: {
  actionKind: string
  parameters?: Record<string, unknown>
  effectTexts?: ReadonlyArray<string | null | undefined>
  /** Browser verb-ceiling reason already frozen on the request. */
  ceiling?: string | null
}): HumanOnlyCategory | null {
  if (input.ceiling) return CEILING_CATEGORY[input.ceiling] ?? 'security'
  const action = humanizeAction(input.actionKind)
  const ceiling = checkVerbCeiling({ description: action, contractDescriptions: input.effectTexts ?? [] })
  if (ceiling) return CEILING_CATEGORY[ceiling.reason] ?? 'security'
  for (const { category, pattern } of ACTION_RULES) if (pattern.test(action)) return category
  if (DESTRUCTIVE_VERB.test(action)) {
    const many = Object.values(input.parameters ?? {}).some((v) => Array.isArray(v) && v.length > 1)
    if (many) return 'bulk_destructive'
  }
  return null
}

// ── D42: exact match ──────────────────────────────────────────────────────

/** The lineage key: the descriptor with each varying field replaced by its declared rule. */
export function patternKeyFor(descriptor: ActionDescriptor, policy: ParameterPolicy): string {
  const parameters: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(descriptor.parameters)) {
    parameters[field] = policy[field] ? { __varying: policy[field] } : value
  }
  for (const field of Object.keys(policy)) if (!(field in parameters)) parameters[field] = { __varying: policy[field], __absent: true }
  return digestOf({ v: 1, actionKind: descriptor.actionKind, procedure: descriptor.procedure, identity: descriptor.identity, parameters })
}

export type PatternMatchFailure =
  | 'procedure_mismatch'
  | 'definition_changed'
  | 'identity_mismatch'
  | 'action_mismatch'
  | 'parameter_mismatch'
  | 'varying_field_out_of_policy'

export function matchPattern(
  pattern: { patternKey: string; descriptor: ActionDescriptor; parameterPolicy: ParameterPolicy },
  candidate: ActionDescriptor,
): { ok: true } | { ok: false; reason: PatternMatchFailure } {
  const a = pattern.descriptor
  const b = candidate
  if (a.procedure.kind !== b.procedure.kind || a.procedure.id !== b.procedure.id || a.procedure.stepId !== b.procedure.stepId) {
    return { ok: false, reason: 'procedure_mismatch' }
  }
  if ((a.procedure.kind === 'workflow' && b.procedure.kind === 'workflow' && a.procedure.definitionDigest !== b.procedure.definitionDigest)
    || (a.procedure.kind === 'browser_skill' && b.procedure.kind === 'browser_skill' && a.procedure.version !== b.procedure.version)) {
    return { ok: false, reason: 'definition_changed' }
  }
  if (a.identity !== b.identity) return { ok: false, reason: 'identity_mismatch' }
  if (a.actionKind !== b.actionKind) return { ok: false, reason: 'action_mismatch' }
  for (const [field, rule] of Object.entries(pattern.parameterPolicy)) {
    if (!satisfiesRule(rule, b.parameters[field])) return { ok: false, reason: 'varying_field_out_of_policy' }
  }
  if (patternKeyFor(b, pattern.parameterPolicy) !== pattern.patternKey) return { ok: false, reason: 'parameter_mismatch' }
  return { ok: true }
}

// ── D43: human evidence ───────────────────────────────────────────────────

export type SupportRecord = {
  approvalId: string
  /** One logical example per native execution chain (workflow run, source session). */
  chainKey: string
  decision: 'approved' | 'rejected'
  /** Only a canonical human decision may be support. Delegated, replayed or quoted decisions are false. */
  humanOrigin: boolean
  decidedAt: Date
  /** Superseded or withdrawn approvals never count. */
  withdrawn?: boolean
}

export type SupportEvaluation = {
  distinctApprovedChains: number
  contradicted: boolean
  qualifies: boolean
  /** One approval id per counted chain (the earliest). */
  countedApprovalIds: string[]
}

export function countQualifyingSupport(records: ReadonlyArray<SupportRecord>, since: Date | null): SupportEvaluation {
  const eligible = records
    .filter((r) => r.humanOrigin && !r.withdrawn && (!since || r.decidedAt.getTime() >= since.getTime()))
    .sort((x, y) => x.decidedAt.getTime() - y.decidedAt.getTime())
  const contradicted = eligible.some((r) => r.decision === 'rejected')
  const byChain = new Map<string, string>()
  for (const r of eligible) if (r.decision === 'approved' && !byChain.has(r.chainKey)) byChain.set(r.chainKey, r.approvalId)
  const counted = [...byChain.values()]
  return {
    distinctApprovedChains: counted.length,
    contradicted,
    qualifies: !contradicted && counted.length >= REQUIRED_HUMAN_APPROVALS,
    countedApprovalIds: counted.slice(0, REQUIRED_HUMAN_APPROVALS),
  }
}

// ── D45/D46: which explicit assignment applies ────────────────────────────

export type AssignmentCandidate = {
  id: string
  scopeKind: ApprovalReviewScopeKind
  scopeId: string
  status: ApprovalReviewAssignmentStatus
  delegatorUserId: string
  reviewerAssistantId: string
  revision: number
  parameterPolicy: ParameterPolicy
}

export type RequestScopes = {
  approvalId: string
  approverUserId: string
  taskId: string | null
  sessionId: string | null
  procedure: { kind: 'workflow' | 'browser_skill'; id: string } | null
}

/**
 * The most specific ACTIVE assignment made by the request's own approver.
 * No match means no reviewer: the request stays with its human. Nothing is
 * inferred from executor, follow-up owner or assistant kind.
 */
export function resolveEffectiveAssignment(
  candidates: ReadonlyArray<AssignmentCandidate>,
  scopes: RequestScopes,
): AssignmentCandidate | null {
  const targets: Array<[ApprovalReviewScopeKind, string | null]> = [
    ['request', scopes.approvalId],
    ['task', scopes.taskId],
    ['session', scopes.sessionId],
    [scopes.procedure?.kind ?? 'workflow', scopes.procedure?.id ?? null],
  ]
  for (const [kind, id] of targets) {
    if (!id) continue
    const hit = candidates.find((c) => c.status === 'active' && c.scopeKind === kind && c.scopeId === id
      && c.delegatorUserId === scopes.approverUserId)
    if (hit) return hit
  }
  return null
}

// ── Review outcomes ───────────────────────────────────────────────────────

export type ApprovalResolutionOrigin = 'human' | 'delegated_assistant' | 'standing_grant' | 'system'
export type ReviewOutcome = 'resolved' | 'needs_human' | 'blocked'

/** Every reason a review leaves the request with its human. */
export type ReviewReason =
  | 'no_assignment'
  | 'not_pending'
  | 'expired'
  | 'delegator_not_approver'
  | 'delegator_source_denied'
  | 'reviewer_not_assigned'
  | 'reviewer_unavailable'
  | 'reviewer_lacks_configure'
  | 'reviewer_not_admitted'
  | `human_only:${HumanOnlyCategory}`
  | `unresolved:${UnresolvedReason}`
  | 'no_active_pattern'
  | 'pattern_suspended'
  | `mismatch:${PatternMatchFailure}`
  | 'assignment_changed'
  | 'pattern_changed'
  | 'lost_race'

export const assignReviewerInputSchema = z.object({
  reviewerAssistantId: z.string().uuid(),
  scopeKind: approvalReviewScopeKindSchema,
  scopeId: z.string().uuid(),
  parameterPolicy: parameterPolicySchema.optional(),
  idempotencyKey: z.string().min(8).max(200),
}).strict()
export type AssignReviewerInput = z.infer<typeof assignReviewerInputSchema>

export const changeAssignmentInputSchema = z.object({
  expectedRevision: z.number().int().min(1),
  reviewerAssistantId: z.string().uuid().optional(),
  parameterPolicy: parameterPolicySchema.optional(),
}).strict()
export type ChangeAssignmentInput = z.infer<typeof changeAssignmentInputSchema>
