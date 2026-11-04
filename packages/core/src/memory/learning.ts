import { z } from 'zod'
import { countDecisionEvidence } from '../decision-learning/evidence.js'

/** [COMP:memory/learning] Semantic eligibility; never a substitute for authorization. */
export const MEMORY_LEARNING_VERSION = 1 as const
export const MEMORY_EVIDENCE_WINDOW_DAYS = 30
export const MEMORY_CANDIDATE_RETENTION_DAYS = 30
const DAY = 86_400_000

export const memoryApplicabilitySchema = z.object({
  projectId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  operation: z.enum(['email', 'tool', 'feed']).optional(),
  operationKey: z.string().min(1).max(256).optional(),
  activity: z.enum(['status_update', 'client_report']).optional(),
  exceptionTo: z.string().uuid().optional(),
}).strict().refine(value => !value.operationKey || !!value.operation, 'An operation key requires an operation')
export type MemoryApplicability = z.infer<typeof memoryApplicabilitySchema>
export type MemoryLearningContext = Omit<MemoryApplicability, 'exceptionTo'>

export const memoryLearningProposalSchema = z.object({
  intent: z.enum(['one_off', 'explicit', 'inferred']),
  kind: z.enum(['preference', 'instruction', 'fact']).default('fact'),
  contradictsMemoryId: z.string().uuid().optional(),
  /** A source span is a proposal. Only a trusted source reader can admit it. */
  quote: z.string().min(1).max(8000),
  applicability: memoryApplicabilitySchema.default({}),
  appliesFrom: z.string().datetime({ offset: true }).nullable().optional(),
  appliesUntil: z.string().datetime({ offset: true }).nullable().optional(),
  timezone: z.string().max(100).optional(),
}).strict().refine(value => !value.appliesFrom || !value.appliesUntil ||
  Date.parse(value.appliesFrom) < Date.parse(value.appliesUntil), 'Expiry must be after the start')
export type MemoryLearningProposal = z.infer<typeof memoryLearningProposalSchema>

/** Human-confirmed edits share the canonical applicability and date vocabulary. */
export const memoryLearningEditSchema = z.object({
  applicability: memoryApplicabilitySchema.optional(),
  appliesFrom: z.string().datetime({offset:true}).nullable().optional(),
  appliesUntil: z.string().datetime({offset:true}).nullable().optional(),
}).strict().refine(value=>Object.keys(value).length>0,'Provide an applicability or validity change')

export const memoryLearningSchema = z.object({
  version: z.literal(MEMORY_LEARNING_VERSION),
  state: z.enum(['legacy', 'candidate', 'established', 'retired']),
  origin: z.enum(['explicit', 'inferred', 'derived', 'legacy']),
  applicability: memoryApplicabilitySchema.default({}),
  appliesFrom: z.string().datetime({ offset: true }).nullable().default(null),
  appliesUntil: z.string().datetime({ offset: true }).nullable().default(null),
  timezone: z.string().max(100).nullable().default(null),
  lastSupportedAt: z.string().datetime({ offset: true }).nullable().default(null),
  candidateUntil: z.string().datetime({ offset: true }).nullable().default(null),
  claimKey: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  confirmed: z.boolean().default(false),
  evidenceCount: z.number().int().nonnegative().default(0),
  independentSources: z.number().int().nonnegative().default(0),
  evidenceGroups: z.array(z.array(z.string().uuid()).min(1)).default([]),
}).strict()
export type MemoryLearning = z.infer<typeof memoryLearningSchema>

/** Host/source-reader supplied. Not part of a model input schema. */
export type MemoryObservation = {
  messageId: string
  sessionId: string
  userId: string
  text: string
}
export type MemoryEvidence = {
  eventId: string
  root: string
  aliases?: string[]
  rootStartedAt?: string
  at: string
  relation: 'supports' | 'contradicts' | 'invalidates'
}

export function countIndependentMemoryEvidence(events: readonly MemoryEvidence[], now: Date) {
  const cutoff = now.getTime() - MEMORY_EVIDENCE_WINDOW_DAYS * DAY
  const seen = new Set<string>()
  const rootStarts = new Map<string,number>()
  const support: Array<{eventKey:string;sourceKey:string;aliases?:string[]}> = []
  let contradictions = 0
  for (const event of events) {
    const at = Date.parse(event.at)
    if (!Number.isFinite(at) || at > now.getTime() || seen.has(event.eventId)) continue
    seen.add(event.eventId)
    if (event.relation !== 'supports') { contradictions++; continue }
    if (at < cutoff) continue
    if (!event.root) continue
    const rootStart = Date.parse(event.rootStartedAt ?? event.at)
    if (Number.isFinite(rootStart)) rootStarts.set(event.root,Math.min(rootStarts.get(event.root) ?? Infinity,rootStart))
    support.push({eventKey:event.aliases?.[0] ?? event.eventId,sourceKey:event.root,aliases:event.aliases})
  }
  const counts = countDecisionEvidence(support)
  return { events: counts.eventCount, roots: counts.distinctSources, contradictions,
    lastIndependentSupportAt: rootStarts.size ? new Date(Math.max(...rootStarts.values())).toISOString() : null,
    eligible: counts.eventCount >= 3 && counts.distinctSources >= 2 && contradictions === 0 }
}

/** Conservative fast path. Ambiguous/quoted intent remains tentative, never silently global. */
export function isExplicitDurableStatement(text: string): boolean {
  const value = text.trim()
  if (/^[>"'`]|\b(?:said|says|wrote|example|hypothetically|if I|don't remember)\b/i.test(value)) return false
  return /^(?:(?:please|brian)[,:]?\s+)?(?:remember\b|from now on\b|I (?:always |generally )?prefer\b|my preference is\b|always\b|请记住|請記住|我(?:更)?(?:喜欢|喜歡|偏好)|今後は|覚えて|私は.{0,40}(?:好み|好き))/iu.test(value)
}

export function proposeMemoryLearning(proposal: MemoryLearningProposal | undefined,
  observation: MemoryObservation | undefined, now = new Date()): MemoryLearning {
  if (proposal?.intent === 'one_off' || (observation && /\b(?:just this (?:reply|time)|for this (?:reply|answer) only|this time only)\b/i.test(observation.text))) throw new Error('memory_one_off: keep this instruction in the current conversation')
  if (proposal && (!observation || !observation.text.includes(proposal.quote))) {
    throw new Error('memory_source_mismatch: cite the current user message or save a tentative inference without claiming explicit intent')
  }
  // Match the entire source on the explicit path: a quoted sentence cannot impersonate its speaker.
  const explicit = proposal?.intent === 'explicit' && !!observation &&
    proposal.quote.trim() === observation.text.trim() && isExplicitDurableStatement(observation.text)
  return memoryLearningSchema.parse({
    version: 1, state: explicit ? 'established' : 'candidate', origin: explicit ? 'explicit' : 'inferred',
    applicability: proposal?.applicability ?? {}, appliesFrom: proposal?.appliesFrom ?? null,
    appliesUntil: proposal?.appliesUntil ?? null, timezone: proposal?.timezone ?? null,
    lastSupportedAt: observation ? now.toISOString() : null,
    candidateUntil: explicit ? null : new Date(now.getTime() + MEMORY_CANDIDATE_RETENTION_DAYS * DAY).toISOString(),
    confirmed: explicit,
  })
}

export function memoryIsEligible(learning: MemoryLearning | null | undefined,
  context: MemoryLearningContext = {}, now = new Date(), review = false): boolean {
  if (!learning) return true // Existing unassessed records retain their prior contract.
  if (!memoryLearningSchema.safeParse(learning).success) return false
  if (review) return true // Caller must independently prove review authority.
  if (!['legacy', 'established'].includes(learning.state)) return false
  const at = now.getTime()
  if (learning.appliesFrom && at < Date.parse(learning.appliesFrom)) return false
  if (learning.appliesUntil && at >= Date.parse(learning.appliesUntil)) return false
  for (const key of ['projectId', 'taskId', 'operation', 'operationKey', 'activity'] as const) {
    if (learning.applicability[key] && learning.applicability[key] !== context[key]) return false
  }
  return true
}

/** Summaries cannot shed a contributing source's semantic restrictions. */
export function deriveMemoryLearning(inputs: readonly (MemoryLearning | null | undefined)[]): MemoryLearning | null {
  const values = inputs.filter((value): value is MemoryLearning => !!value)
  if (!values.length) return null
  if (values.some(value => !['legacy', 'established'].includes(value.state))) throw new Error('memory_source_tentative')
  const applicability: MemoryApplicability = {}
  for (const value of values) {
    for (const key of ['projectId', 'taskId', 'operation', 'operationKey', 'activity'] as const) {
      const candidate = value.applicability[key]
      if (!candidate) continue
      if (applicability[key] && applicability[key] !== candidate) throw new Error('memory_applicability_conflict')
      Object.assign(applicability, { [key]: candidate })
    }
  }
  const starts = values.flatMap(value => value.appliesFrom ? [value.appliesFrom] : []).sort((a,b) => Date.parse(a)-Date.parse(b))
  const ends = values.flatMap(value => value.appliesUntil ? [value.appliesUntil] : []).sort((a,b) => Date.parse(a)-Date.parse(b))
  if (starts.length && ends.length && Date.parse(starts.at(-1)!) >= Date.parse(ends[0])) throw new Error('memory_applicability_conflict')
  return memoryLearningSchema.parse({ version: 1, state: 'established', origin: 'derived', applicability,
    appliesFrom: starts.at(-1) ?? null, appliesUntil: ends[0] ?? null,
    evidenceGroups: values.flatMap(value=>value.evidenceGroups ?? []) })
}

/** A bounded hint only; absence never grants operation-specific applicability. */
export function memoryActivityFromText(text: string | undefined): MemoryLearningContext['activity'] | undefined {
  if (!text) return undefined
  // Mere discussion, quotations and negated requests cannot select an activity.
  if (!/^(?:(?:please|can you|could you)\s+)?(?:write|draft|prepare|create|give me|send|compose|generate)\b|^(?:请|請)?(?:写|寫|起草|生成|準備|准备)|^(?:作成|書いて|作って)/iu.test(text.trim()) ||
      /\b(?:not|don't|instead|example|quoted)\b|[>"`]/iu.test(text)) return undefined
  const status = /\bstatus update\b|进度更新|進度更新|進捗報告/iu.test(text)
  const client = /\bclient report\b|客户报告|客戶報告|顧客向けレポート/iu.test(text)
  return status === client ? undefined : status ? 'status_update' : 'client_report'
}
