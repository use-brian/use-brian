/**
 * Saved research, scoped feedback learning and engine improvement: the pure
 * contracts shared by the API domain services, Brian tools, MCP and app-web.
 *
 * Nothing here reads a database, a clock it was not handed, or a model. The
 * API layer supplies admitted facts; these functions decide what those facts
 * mean (receipt validity, follow-up association, signal meaning, lesson
 * eligibility) so the same rule holds on every entry path.
 *
 * Spec: docs/architecture/features/research.md
 */
import { z } from 'zod'

export const RESEARCH_SCHEMA_VERSION = 1 as const

// ── Activity and artifacts ────────────────────────────────────────────────

/** How the research invocation was entered. */
export const researchEntrySchema = z.enum(['explicit', 'adaptive'])
export type ResearchEntry = z.infer<typeof researchEntrySchema>

/**
 * `saved` requires an inspected canonical write receipt. `partial` keeps
 * findings/gaps without a saved artifact. `failed` has neither. `running` is
 * the open activity before its turn settles.
 */
export const researchActivityStatusSchema = z.enum(['running', 'saved', 'partial', 'failed'])
export type ResearchActivityStatus = z.infer<typeof researchActivityStatusSchema>

export const researchArtifactKindSchema = z.enum(['page', 'document', 'file'])
export type ResearchArtifactKind = z.infer<typeof researchArtifactKindSchema>

/** `output` = created by this activity; `revision` = an existing artifact it revised. */
export const researchArtifactRelationSchema = z.enum(['output', 'revision'])
export type ResearchArtifactRelation = z.infer<typeof researchArtifactRelationSchema>

/** A source the research consulted. `inspected` distinguishes a full read from a found link or snippet. */
export const researchSourceKindSchema = z.enum(['web', 'page', 'file', 'document', 'brain', 'connector', 'browser'])
export type ResearchSourceKind = z.infer<typeof researchSourceKindSchema>

export const researchSourceRefSchema = z.object({
  kind: researchSourceKindSchema,
  ref: z.string().trim().min(1).max(2048),
  title: z.string().trim().max(300).nullable().optional().default(null),
  readAt: z.string().datetime(),
  inspected: z.boolean(),
}).strict()
export type ResearchSourceRef = z.infer<typeof researchSourceRefSchema>

/**
 * The actual successful write a canonical writer reported. Built only from a
 * tool result, never from model prose; `verified` is set by the API after it
 * re-reads the saved artifact.
 */
export const researchWriteReceiptSchema = z.object({
  kind: researchArtifactKindSchema,
  artifactId: z.string().uuid(),
  version: z.number().int().nonnegative().nullable(),
  toolName: z.string().trim().min(1).max(128),
  toolUseId: z.string().trim().min(1).max(256),
  operation: z.enum(['create', 'update']),
}).strict()
export type ResearchWriteReceipt = z.infer<typeof researchWriteReceiptSchema>

/**
 * Canonical writers whose structured results can become research write
 * receipts, with the exact result shape each one reports:
 * - `renderPage` / `createSubPage`: `{ kind: 'doc_render' | 'doc_sub_page', pageId, version }`
 * - `patchPage`: `{ kind: 'doc_patch', pageId, version }`
 * - `delegateDocEdit`: `{ status: 'completed' | 'partial', pageIds[] }` (no version)
 * - `createOfficeArtifact`: `{ artifactId, jobId, status }`; `reviseOfficeArtifact` names its target in the input
 * - `fileWrite`: the line `Saved <path> (...). id=<uuid>`
 */
export const RESEARCH_WRITE_TOOLS: Readonly<Record<string, { kind: ResearchArtifactKind; operation: 'create' | 'update' }>> = {
  renderPage: { kind: 'page', operation: 'create' },
  createSubPage: { kind: 'page', operation: 'create' },
  patchPage: { kind: 'page', operation: 'update' },
  delegateDocEdit: { kind: 'page', operation: 'update' },
  createOfficeArtifact: { kind: 'document', operation: 'create' },
  reviseOfficeArtifact: { kind: 'document', operation: 'update' },
  fileWrite: { kind: 'file', operation: 'create' },
}

const EXACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readStructured(result: unknown): Record<string, unknown> | null {
  if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>
  if (typeof result !== 'string') return null
  const trimmed = result.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function firstVersion(record: Record<string, unknown>): number | null {
  for (const key of ['version', 'revision', 'versionNumber']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  }
  return null
}

function receipt(spec: { kind: ResearchArtifactKind; operation: 'create' | 'update' }, call: { toolName: string; toolUseId: string },
  id: unknown, version: number | null): ResearchWriteReceipt | null {
  if (typeof id !== 'string' || !EXACT_UUID_RE.test(id.trim())) return null
  const parsed = researchWriteReceiptSchema.safeParse({
    kind: spec.kind, artifactId: id.trim().toLowerCase(), version,
    toolName: call.toolName, toolUseId: call.toolUseId, operation: spec.operation,
  })
  return parsed.success ? parsed.data : null
}

/**
 * Turn one finished tool call into write receipts. Empty when the call is not
 * a canonical write, errored, or reported no artifact id in its structured
 * result. A UUID that only appears in error text or model narration never
 * becomes a saved artifact.
 */
export function extractResearchWriteReceipts(call: {
  toolName: string
  toolUseId: string
  isError: boolean
  result: unknown
  input?: unknown
}): ResearchWriteReceipt[] {
  const spec = RESEARCH_WRITE_TOOLS[call.toolName]
  if (!spec || call.isError) return []
  if (call.toolName === 'fileWrite') {
    const text = typeof call.result === 'string' ? call.result.trim() : ''
    const match = /^Saved .+\bid=([0-9a-f-]{36})\s*$/i.exec(text)
    const one = match ? receipt(spec, call, match[1], null) : null
    return one ? [one] : []
  }
  const record = readStructured(call.result)
  if (!record) return []
  if (record.ok === false || record.success === false || typeof record.error === 'string') return []
  if (call.toolName === 'delegateDocEdit') {
    if (record.status !== 'completed' && record.status !== 'partial') return []
    const ids = Array.isArray(record.pageIds) ? record.pageIds : []
    return ids.map((id) => receipt(spec, call, id, null)).filter((r): r is ResearchWriteReceipt => r !== null)
  }
  if (call.toolName === 'reviseOfficeArtifact') {
    if (typeof record.jobId !== 'string') return []
    const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {}
    const one = receipt(spec, call, firstString(input, ['artifactId', 'artifact_id']), null)
    return one ? [one] : []
  }
  if (call.toolName === 'createOfficeArtifact') {
    const one = receipt(spec, call, record.artifactId, null)
    return one ? [one] : []
  }
  const expected = { renderPage: 'doc_render', createSubPage: 'doc_sub_page', patchPage: 'doc_patch' }[call.toolName]
  if (expected && record.kind !== expected) return []
  const one = receipt(spec, call, record.pageId, firstVersion(record))
  return one ? [one] : []
}

/**
 * Delivery outcome. Saved requires at least one receipt the API re-read and
 * found. Findings without a verified receipt are partial work, never saved
 * delivery; a chat answer alone is not a saved result.
 */
export function deriveResearchDeliveryStatus(input: {
  verifiedReceipts: number
  findings: number
  gaps: number
}): Exclude<ResearchActivityStatus, 'running'> {
  if (input.verifiedReceipts > 0) return 'saved'
  if (input.findings > 0 || input.gaps > 0) return 'partial'
  return 'failed'
}

// ── Follow-up feedback ────────────────────────────────────────────────────

/**
 * Distinct meanings of a direct-member follow-up. `request_correction` is the
 * member correcting their own request, not the research. `deeper_exploration`
 * is neutral expansion. `uncertain` is recorded as such and never becomes a
 * verdict. Silence produces no row at all.
 */
export const researchFeedbackKindSchema = z.enum([
  'correction',
  'request_correction',
  'missing_coverage',
  'preference',
  'deeper_exploration',
  'changed_objective',
  'satisfaction',
  'uncertain',
])
export type ResearchFeedbackKind = z.infer<typeof researchFeedbackKindSchema>

export const researchFeedbackOriginSchema = z.enum(['machine', 'human'])
export type ResearchFeedbackOrigin = z.infer<typeof researchFeedbackOriginSchema>

/** Unknown stays `null`: it is never zero, never a pass. */
export type ResearchQualityVector = {
  claimsContradicted: boolean | null
  coverageGap: boolean | null
  preferenceMismatch: boolean | null
  satisfied: boolean | null
}

export function qualityVectorFor(kind: ResearchFeedbackKind): ResearchQualityVector {
  const unknown: ResearchQualityVector = { claimsContradicted: null, coverageGap: null, preferenceMismatch: null, satisfied: null }
  switch (kind) {
    case 'correction': return { ...unknown, claimsContradicted: true }
    case 'missing_coverage': return { ...unknown, coverageGap: true }
    case 'preference': return { ...unknown, preferenceMismatch: true }
    case 'satisfaction': return { ...unknown, satisfied: true }
    default: return unknown
  }
}

export type ResearchFollowupInterpretation = {
  kind: ResearchFeedbackKind
  uncertain: boolean
  interpreter: string
}

export const RESEARCH_HEURISTIC_INTERPRETER = 'heuristic-v1'

type Pattern = { kind: Exclude<ResearchFeedbackKind, 'uncertain'>; re: RegExp }

// Ordered: the first family that matches wins only when no other family does.
const FOLLOWUP_PATTERNS: readonly Pattern[] = [
  { kind: 'request_correction', re: /\b(i meant|what i meant|i should have (said|asked)|my (question|request) was|sorry,? i (meant|asked))\b|我的意思是|我係想問|我是想问/i },
  { kind: 'changed_objective', re: /\b(instead,? (look|research|focus)|forget (that|this|it)|change of plans?|switch(ing)? to|new (question|direction))\b|改為|改为|唔使理|不用管/i },
  { kind: 'correction', re: /\b(that'?s (wrong|incorrect|not right|outdated)|(is|are|was|were) (wrong|incorrect|inaccurate|outdated|not right)|incorrect|inaccurate|not true|you got .* wrong|actually,? (it|they|the)\b.*\b(is|are|was|were))|錯|错了|唔啱|不对|不正確|不正确/i },
  { kind: 'missing_coverage', re: /\b(you (missed|forgot|left out|didn'?t (cover|include|mention))|what about|missing|also (cover|include|check)|nothing (on|about))\b|漏咗|遗漏|遺漏|冇提|没提到|沒提到/i },
  { kind: 'preference', re: /\b(too (long|short|verbose|detailed)|shorter|more concise|bullet points?|as a table|use a table|in a table|format|tl;?dr|i prefer|please always)\b|太長|太长|簡短|简短|用表格/i },
  { kind: 'deeper_exploration', re: /\b(dig deeper|go deeper|more (detail|depth) on|tell me more|expand on|elaborate|drill (down|into))\b|詳細啲|详细一点|深入/i },
  { kind: 'satisfaction', re: /\b(perfect|great (work|job)|exactly what i (needed|wanted)|this is (great|helpful|useful)|thanks?,? (this|that) (is|was) (great|helpful|perfect))\b|好正|很好|正是我要的/i },
]

/**
 * Deterministic interpreter: one family match gives that label; none or
 * several conflicting families give `uncertain`. Machine-origin always - a
 * human acceptance is a separate, attributable correction.
 */
export function interpretResearchFollowup(text: string): ResearchFollowupInterpretation {
  const normalized = text.normalize('NFKC').trim()
  if (!normalized) return { kind: 'uncertain', uncertain: true, interpreter: RESEARCH_HEURISTIC_INTERPRETER }
  const hits = new Set(FOLLOWUP_PATTERNS.filter((p) => p.re.test(normalized)).map((p) => p.kind))
  // A request correction often also reads as "that's wrong" about the request;
  // the member speaking about their own words is the stronger reading.
  if (hits.has('request_correction')) return { kind: 'request_correction', uncertain: false, interpreter: RESEARCH_HEURISTIC_INTERPRETER }
  if (hits.size === 1) {
    const [kind] = [...hits]
    return { kind: kind!, uncertain: false, interpreter: RESEARCH_HEURISTIC_INTERPRETER }
  }
  return { kind: 'uncertain', uncertain: true, interpreter: RESEARCH_HEURISTIC_INTERPRETER }
}

// ── Follow-up association ─────────────────────────────────────────────────

export type ResearchFollowupCandidate = {
  activityId: string
  /** The assistant message that delivered this result in the chat, when known. */
  outputMessageId: string | null
}

export type ResearchFollowupAssociation =
  | { status: 'linked'; activityId: string; method: 'explicit_selection' | 'explicit_reply' | 'same_chat_continuation' }
  | { status: 'uncertain'; reason: 'multiple_outputs' | 'unrelated_or_uncertain' }
  | { status: 'none' }

/**
 * Selecting a saved result or replying to its message establishes the target.
 * An unambiguous same-chat continuation (one result in the chat and a
 * recognized follow-up meaning) can be linked. Several results, or a message
 * with no recognized follow-up meaning, stay unlinked: teaching against the
 * latest report by default would invent attribution.
 */
export function resolveResearchFollowupTarget(input: {
  selectedActivityId?: string | null
  replyToMessageId?: string | null
  candidates: readonly ResearchFollowupCandidate[]
  interpretation: ResearchFollowupInterpretation
}): ResearchFollowupAssociation {
  const { candidates } = input
  if (input.selectedActivityId) {
    const hit = candidates.find((c) => c.activityId === input.selectedActivityId)
    if (hit) return { status: 'linked', activityId: hit.activityId, method: 'explicit_selection' }
  }
  if (input.replyToMessageId) {
    const hit = candidates.find((c) => c.outputMessageId === input.replyToMessageId)
    if (hit) return { status: 'linked', activityId: hit.activityId, method: 'explicit_reply' }
  }
  if (candidates.length === 0) return { status: 'none' }
  if (candidates.length > 1) return { status: 'uncertain', reason: 'multiple_outputs' }
  if (input.interpretation.uncertain || input.interpretation.kind === 'changed_objective') {
    return { status: 'uncertain', reason: 'unrelated_or_uncertain' }
  }
  return { status: 'linked', activityId: candidates[0]!.activityId, method: 'same_chat_continuation' }
}

// ── Scoped lessons ────────────────────────────────────────────────────────

export const researchLessonScopeSchema = z.enum(['user', 'project', 'workspace'])
export type ResearchLessonScope = z.infer<typeof researchLessonScopeSchema>

/** Kinds that may support a behavioral research lesson. */
export const RESEARCH_LESSON_KINDS: readonly ResearchFeedbackKind[] = ['correction', 'missing_coverage', 'preference']

/** Mirrors the decision-reflection threshold (decision-learning.md). */
export const RESEARCH_LESSON_MIN_EVENTS = 3
export const RESEARCH_LESSON_MIN_ACTIVITIES = 2
export const RESEARCH_LESSON_WINDOW_DAYS = 30
export const MAX_ACTIVE_RESEARCH_LESSONS_PER_SCOPE = 6

export type ResearchLessonEvidence = {
  feedbackId: string
  activityId: string
  /** Output artifact/version the follow-up targeted; one output counts once. */
  outputKey: string
  actorUserId: string
  projectId: string | null
  kind: ResearchFeedbackKind
  uncertain: boolean
  /** False when the source message or activity is no longer current/admitted. */
  current: boolean
  createdAt: Date
}

export type ResearchLessonSupport = {
  units: number
  activities: number
  qualifies: boolean
  excluded: number
}

/**
 * Count support the way decision reflection does: at least three consistent
 * eligible events from two distinct research activities within 30 days.
 * Replays (same feedback id), several labels on one output, uncertain or
 * stale evidence, and ineligible kinds never multiply support.
 */
export function evaluateResearchLessonSupport(
  evidence: readonly ResearchLessonEvidence[],
  now: Date,
): ResearchLessonSupport {
  const windowStart = now.getTime() - RESEARCH_LESSON_WINDOW_DAYS * 86_400_000
  const seen = new Set<string>()
  const units = new Set<string>()
  const activities = new Set<string>()
  let excluded = 0
  for (const e of evidence) {
    if (seen.has(e.feedbackId)) continue
    seen.add(e.feedbackId)
    if (!e.current || e.uncertain || !RESEARCH_LESSON_KINDS.includes(e.kind) || e.createdAt.getTime() < windowStart) {
      excluded += 1
      continue
    }
    units.add(`${e.activityId}\u0000${e.outputKey}`)
    activities.add(e.activityId)
  }
  return {
    units: units.size,
    activities: activities.size,
    qualifies: units.size >= RESEARCH_LESSON_MIN_EVENTS && activities.size >= RESEARCH_LESSON_MIN_ACTIVITIES,
    excluded,
  }
}

/**
 * Personal and Project lessons activate automatically once qualified;
 * company (workspace) methods never do - they wait for owner review.
 */
export function researchLessonStatusFor(scope: ResearchLessonScope, support: ResearchLessonSupport): 'active' | 'suggested' {
  if (scope === 'workspace') return 'suggested'
  return support.qualifies ? 'active' : 'suggested'
}

/**
 * Scope validation over the supporting evidence. A user lesson needs one
 * actor; a Project lesson needs every activity in that Project; a workspace
 * method needs evidence from at least two members and is only ever a proposal.
 */
export function researchLessonScopeAdmissible(
  scope: ResearchLessonScope,
  evidence: readonly Pick<ResearchLessonEvidence, 'actorUserId' | 'projectId'>[],
  target: { actorUserId?: string | null; projectId?: string | null },
): boolean {
  if (evidence.length === 0) return false
  switch (scope) {
    case 'user':
      return !!target.actorUserId && evidence.every((e) => e.actorUserId === target.actorUserId)
    case 'project':
      return !!target.projectId && evidence.every((e) => e.projectId === target.projectId)
    case 'workspace':
      return new Set(evidence.map((e) => e.actorUserId)).size >= 2
  }
}

const PROHIBITED_LESSON_RE = /\b(permission|permit|grant|credential|password|token|api[ -]?key|budget|spend|allowance|quota|approv|confirm(ation)?|connector|authori[sz]|clearance|confidential|release|deploy|goal|objective|always allow|never ask)\b/i

/**
 * A lesson may change how research is done or presented. It may not change
 * goals, budgets, authorization, credentials, connector grants, tool
 * confirmation or release policy.
 */
export function isProhibitedResearchLesson(rule: string): boolean {
  return PROHIBITED_LESSON_RE.test(rule.normalize('NFKC'))
}

export const researchLessonProposalSchema = z.object({
  rule: z.string().trim().min(8).max(280),
  scope: researchLessonScopeSchema,
  feedbackIds: z.array(z.string().uuid()).min(1).max(30),
}).strict()
export type ResearchLessonProposal = z.infer<typeof researchLessonProposalSchema>

// ── Commands shared by REST, Brian and MCP ────────────────────────────────

export const researchFeedbackCorrectionSchema = z.object({
  kind: researchFeedbackKindSchema,
  note: z.string().trim().max(1000).nullable().optional().default(null),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict()
export type ResearchFeedbackCorrection = z.infer<typeof researchFeedbackCorrectionSchema>

export const researchLessonDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'retire']),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict()
export type ResearchLessonDecision = z.infer<typeof researchLessonDecisionSchema>

export const researchImprovementStatusSchema = z.enum(['proposed', 'evaluating', 'checked', 'deferred'])
export type ResearchImprovementStatus = z.infer<typeof researchImprovementStatusSchema>

export const researchImprovementNominationSchema = z.object({
  title: z.string().trim().min(3).max(200),
  pattern: z.string().trim().min(3).max(2000),
  desiredBehavior: z.string().trim().min(3).max(2000),
  feedbackIds: z.array(z.string().uuid()).max(50).default([]),
  activityIds: z.array(z.string().uuid()).max(50).default([]),
  taskId: z.string().uuid().nullable().optional().default(null),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict()
export type ResearchImprovementNomination = z.infer<typeof researchImprovementNominationSchema>
