/** Feed's portable composition and command boundary. [COMP:feed/composition-model] */
import { z } from 'zod'
import { feedLinkedInContextSchema } from './feed-linkedin.js'
import { campaignEmailMetadataSchema } from './campaigns.js'

export const FEED_COMPOSITION_VERSION = 1 as const
export const FEED_CONTENT_LIMIT = 100_000
export const feedIdSchema = z.string().uuid()
const revision = z.number().int().min(0).max(2_000_000_000)
const safeUrl = z.string().max(2048).url().refine(value => /^https?:\/\//i.test(value), 'HTTP(S) URL required')
export const feedMediaSchema = z.object({
  fileId: feedIdSchema, mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  alt: z.string().max(1000).optional(),
}).strict()
export type FeedMedia = z.infer<typeof feedMediaSchema>
export const feedMarkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }).strict(),
  z.object({ type: z.literal('italic') }).strict(),
  z.object({ type: z.literal('link'), attrs: z.object({ href: safeUrl }).strict() }).strict(),
])
export type FeedMark = z.infer<typeof feedMarkSchema>
export const feedInlineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(FEED_CONTENT_LIMIT), marks: z.array(feedMarkSchema).max(3).optional() }).strict(),
  z.object({ type: z.literal('hardBreak') }).strict(),
])
export type FeedInline = z.infer<typeof feedInlineSchema>
export const feedPlaceholderAttrsSchema = z.object({
  id: feedIdSchema, kind: z.enum(['text', 'image']), brief: z.string().max(20_000),
  briefRevision: revision, intent: z.string().max(1000).optional(), length: z.number().int().min(1).max(100_000).optional(),
  aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional(), style: z.string().max(2000).optional(),
  altIntent: z.string().max(1000).optional(), baseImageFileId: feedIdSchema.optional(), references: z.array(z.union([
    z.object({ fileId: feedIdSchema }).strict(), z.object({ url: safeUrl }).strict(),
  ])).max(20),
}).strict()
export type FeedPlaceholderAttrs = z.infer<typeof feedPlaceholderAttrsSchema>
export type FeedNode =
  | { type: 'paragraph'; attrs: { id: string }; content?: FeedInline[] }
  | { type: 'heading'; attrs: { id: string; level: number }; content?: FeedInline[] }
  | { type: 'bulletList'; attrs: { id: string }; content: FeedNode[] }
  | { type: 'orderedList'; attrs: { id: string; start: number }; content: FeedNode[] }
  | { type: 'listItem' | 'blockquote'; attrs: { id: string }; content: FeedNode[] }
  | { type: 'image'; attrs: FeedMedia & { id: string; placement: 'inline' | 'attachment' } }
  | { type: 'generationPlaceholder'; attrs: FeedPlaceholderAttrs }
const idAttrs = z.object({ id: feedIdSchema }).strict()
const inlines = z.array(feedInlineSchema).max(10_000)
export const feedNodeSchema: z.ZodType<FeedNode> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), attrs: idAttrs, content: inlines.optional() }).strict(),
  z.object({ type: z.literal('heading'), attrs: idAttrs.extend({ level: z.number().int().min(1).max(6) }), content: inlines.optional() }).strict(),
  z.object({ type: z.literal('bulletList'), attrs: idAttrs, content: z.array(feedNodeSchema).min(1) }).strict(),
  z.object({ type: z.literal('orderedList'), attrs: idAttrs.extend({ start: z.number().int().min(1) }), content: z.array(feedNodeSchema).min(1) }).strict(),
  z.object({ type: z.literal('listItem'), attrs: idAttrs, content: z.array(feedNodeSchema).min(1) }).strict(),
  z.object({ type: z.literal('blockquote'), attrs: idAttrs, content: z.array(feedNodeSchema).min(1) }).strict(),
  z.object({ type: z.literal('image'), attrs: feedMediaSchema.extend({ id: feedIdSchema, placement: z.enum(['inline', 'attachment']) }) }).strict(),
  z.object({ type: z.literal('generationPlaceholder'), attrs: feedPlaceholderAttrsSchema }).strict(),
]))
export const feedSegmentSchema = z.object({
  id: feedIdSchema, content: z.array(feedNodeSchema).min(1).max(10_000),
  // Only the server importer sets this. Commands cannot forge a legacy baseline.
  legacy: z.object({ markdown: z.string().max(FEED_CONTENT_LIMIT), canonical: z.string().max(2_000_000) }).strict().optional(),
}).strict()
export const feedCompositionSchema = z.object({
  version: z.literal(FEED_COMPOSITION_VERSION), segments: z.array(feedSegmentSchema).min(1).max(100),
}).strict().superRefine((composition, ctx) => {
  const seen = new Set<string>(); let chars = 0; let count = 0
  const visit = (node: FeedNode, depth: number) => {
    if (depth > 16 || ++count > 10_000) { ctx.addIssue({ code: 'custom', message: 'Composition too complex' }); return }
    if (seen.has(node.attrs.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate block identity' })
    seen.add(node.attrs.id)
    if (node.type === 'generationPlaceholder') chars += node.attrs.brief.length
    if (node.type === 'paragraph' || node.type === 'heading') {
      chars += (node.content ?? []).reduce((n, inline) => n + (inline.type === 'text' ? inline.text.length : 1), 0)
    } else if ('content' in node) node.content.forEach(child => visit(child, depth + 1))
    if ((node.type === 'orderedList' || node.type === 'bulletList') && node.content.some(child => child.type !== 'listItem')) {
      ctx.addIssue({ code: 'custom', message: 'Lists require list items' })
    }
  }
  for (const segment of composition.segments) {
    if (seen.has(segment.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate segment identity' })
    seen.add(segment.id); segment.content.forEach(node => visit(node, 0))
  }
  if (chars > FEED_CONTENT_LIMIT) ctx.addIssue({ code: 'custom', message: 'Composition exceeds content limit' })
})
export type FeedComposition = z.infer<typeof feedCompositionSchema>
export const feedSpanSchema = z.object({ segmentId: feedIdSchema, blockId: feedIdSchema, from: revision, to: revision }).strict()
export type FeedSpan = z.infer<typeof feedSpanSchema>
export const feedTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('post') }).strict(),
  z.object({ kind: z.literal('block'), segmentId: feedIdSchema, blockId: feedIdSchema }).strict(),
  z.object({ kind: z.literal('range'), spans: z.array(feedSpanSchema).min(1).max(100) }).strict(),
])
export type FeedTarget = z.infer<typeof feedTargetSchema>
export const feedAnchorSchema = z.object({
  target: feedTargetSchema, quote: z.string().max(FEED_CONTENT_LIMIT), sourceRevision: revision,
  state: z.enum(['attached', 'stale', 'detached']).default('attached'),
}).strict()
export type FeedAnchor = z.infer<typeof feedAnchorSchema>
export const feedEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reshapeSegment'), segmentId: feedIdSchema, preimage: z.array(feedNodeSchema).min(1).max(10_000), replacement: z.array(feedNodeSchema).min(1).max(10_000) }).strict(),
  z.object({ kind: z.literal('splitBlock'), segmentId: feedIdSchema, blockId: feedIdSchema, preimage: feedNodeSchema, first: feedNodeSchema, second: feedNodeSchema }).strict(),
  z.object({ kind: z.literal('joinBlocks'), segmentId: feedIdSchema, blockId: feedIdSchema, secondId: feedIdSchema, preimage: z.tuple([feedNodeSchema, feedNodeSchema]), replacement: feedNodeSchema }).strict(),
  z.object({ kind: z.literal('replaceText'), spans: z.array(feedSpanSchema).min(1).max(100),
    preimage: z.array(z.array(feedInlineSchema)).min(1).max(100), replacement: z.array(z.array(feedInlineSchema)).min(1).max(100) }).strict(),
  z.object({ kind: z.literal('replaceBlock'), segmentId: feedIdSchema, blockId: feedIdSchema,
    preimage: feedNodeSchema, replacement: z.array(feedNodeSchema).max(100) }).strict(),
  z.object({ kind: z.literal('insertBlock'), segmentId: feedIdSchema, afterId: feedIdSchema.nullable(), parentId: feedIdSchema.optional(), node: feedNodeSchema }).strict(),
  z.object({ kind: z.literal('moveBlock'), segmentId: feedIdSchema, blockId: feedIdSchema, afterId: feedIdSchema.nullable(), parentId: feedIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('insertSegment'), afterId: feedIdSchema.nullable(), segment: feedSegmentSchema.omit({ legacy: true }) }).strict(),
  z.object({ kind: z.literal('removeSegment'), segmentId: feedIdSchema, preimage: feedSegmentSchema }).strict(),
])
export type FeedEdit = z.infer<typeof feedEditSchema>
export const feedCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upgrade'), seed: feedIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('edit'), edits: z.array(feedEditSchema).min(1).max(100), reasonThreadId: feedIdSchema.optional(), applicationId: feedIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('comment'), sourceRevision: revision.optional(), threadId: feedIdSchema, target: feedTargetSchema, text: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ kind: z.literal('reply'), threadId: feedIdSchema, text: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ kind: z.literal('resolve'), threadId: feedIdSchema, resolved: z.boolean() }).strict(),
  z.object({ kind: z.literal('reattach'), threadId: feedIdSchema, target: feedTargetSchema }).strict(),
  z.object({ kind: z.literal('propose'), sourceRevision: revision.optional(), suggestionId: feedIdSchema, threadId: feedIdSchema.optional(), parentId: feedIdSchema.optional(),
    edits: z.array(feedEditSchema).min(1).max(100), rationale: z.string().max(20_000), sourceMessageId: feedIdSchema.optional(),
    sourceProposal: z.object({ threadSegments: z.array(z.string().max(FEED_CONTENT_LIMIT)).min(1).max(100).optional(), index: z.number().int().min(1).max(99), text: z.string().max(FEED_CONTENT_LIMIT), label: z.string().max(30).optional(), imageBrief: z.string().max(2000).optional() }).strict().optional(),
    sourceRunId: feedIdSchema.optional(), sourceToolCallId: z.string().max(512).optional(), applicationId: feedIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('decide'), suggestionId: feedIdSchema, outcome: z.enum(['accepted', 'rejected', 'deferred']), reasonThreadId: feedIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('undo'), revision: revision }).strict(),
  z.object({ kind: z.literal('release'), audience: z.literal('public') }).strict(),
  z.object({ kind: z.literal('context'), selectedMemoryIds: z.array(feedIdSchema).max(100).optional(), goalId: feedIdSchema.nullable().optional(), reviewMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    title: z.string().max(200).optional(), privateBrief: z.string().max(20_000).optional(),
    postFormat: z.enum(['post', 'thread', 'article']).optional(),
    article: z.object({ sourceUrl: z.string().max(2048), title: z.string().max(2000), description: z.string().max(20_000) }).strict().optional() }).strict(),
  z.object({ kind: z.literal('linkedin'), metadata: feedLinkedInContextSchema.nullable() }).strict(),
  z.object({ kind: z.literal('email'), metadata: campaignEmailMetadataSchema }).strict(),
])
export type FeedCommand = z.infer<typeof feedCommandSchema>
export const feedCommandRequestSchema = z.object({ mutationId: feedIdSchema, expectedRevision: revision, commands: z.array(feedCommandSchema).min(1).max(100) }).strict()
export type FeedCommandRequest = z.infer<typeof feedCommandRequestSchema>
export type FeedCollaborationReceipt = { mutationId: string; revision: number; sequence: number; threadIds: string[]; suggestionIds: string[] }

export const feedChatTargetSchema = z.object({
  sessionId: feedIdSchema, revision, target: feedTargetSchema.optional(), threadId: feedIdSchema.optional(),
}).strict()
export type FeedChatTarget = z.infer<typeof feedChatTargetSchema>

/** One bounded vocabulary shared by Review's UI, tools, queue and model port. */
export const FEED_REVIEW_DIMENSIONS = ['monthly_plan', 'post_history', 'post_goal', 'memory', 'content'] as const
export const feedReviewDimensionSchema = z.enum(FEED_REVIEW_DIMENSIONS)
export type FeedReviewDimension = z.infer<typeof feedReviewDimensionSchema>
export const FEED_EDITORIAL_LIMITS = {
  version: 1, recentPosts: 30, olderPosts: 20, sourcesPerCheck: 80,
  inputCharacters: 160_000, sourceCharacters: 40_000, outputTokens: 6_000,
  findingsPerCheck: 12, attempts: 3, leaseMs: 120_000, callTimeoutMs: 90_000,
} as const
export const feedEditorialStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'unknown_outcome'])
export type FeedEditorialStatus = z.infer<typeof feedEditorialStatusSchema>
export const feedReviewCoverageSchema = z.object({
  state: z.enum(['checked', 'partial', 'unavailable', 'not_applicable', 'failed']),
  eligible: z.number().int().nonnegative(), retrieved: z.number().int().nonnegative(), reviewed: z.number().int().nonnegative(),
  limits: z.array(z.string().max(500)).max(30), oldest: z.string().nullable().optional(), newest: z.string().nullable().optional(),
  nextCursor: z.number().int().nonnegative().nullable().optional(),
}).strict()
export type FeedReviewCoverage = z.infer<typeof feedReviewCoverageSchema>
export const feedReviewFindingSchema = z.object({
  issueKey: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/), dimensions: z.array(feedReviewDimensionSchema).min(1).max(5),
  priority: z.enum(['high', 'medium', 'low']), target: feedTargetSchema,
  issue: z.string().trim().min(1).max(2000), nextStep: z.string().trim().min(1).max(2000),
  evidence: z.array(z.object({ sourceId: z.string().max(160), quote: z.string().max(2000).optional() }).strict()).max(12),
  suggestion: z.object({ edits: z.array(feedEditSchema).min(1).max(100), rationale: z.string().max(2000) }).strict().optional(),
}).strict()
export type FeedReviewFinding = z.infer<typeof feedReviewFindingSchema>
export const feedReviewOutputSchema = z.object({ findings: z.array(feedReviewFindingSchema).max(FEED_EDITORIAL_LIMITS.findingsPerCheck) }).strict()
export const feedReviewRequestSchema = z.object({
  mutationId: feedIdSchema, expectedRevision: revision, model: z.enum(['standard', 'pro', 'max']).default('standard'),
  locale: z.enum(['en', 'ja', 'zh', 'zh-cn']).default('en'), continuationRunId: feedIdSchema.optional(),
}).strict()
export type FeedReviewRequest = z.infer<typeof feedReviewRequestSchema>
export type FeedReviewSource = {
  id: string; kind: 'plan' | 'goal' | 'post' | 'memory' | 'playbook' | 'brand' | 'composition';
  title: string; hash: string; body: string; link?: string; date?: string; state?: 'planned' | 'published'; applicationId?: string;
}
export type FeedReviewContext = {
  version: 1; revision: number; composition: FeedComposition; platform: string; month: string; goalId: string | null;
  historyCursor?: number; brandId: string | null; historyAssistantIds: string[]; contextHash: string;
  learningScope?: FeedLearningScope;
  dimensions: Record<FeedReviewDimension, { sources: FeedReviewSource[]; coverage: FeedReviewCoverage }>;
}
export type FeedEditorialRunSummary = {
  id: string; kind: 'review' | 'text_generation' | 'image_generation' | 'confirmation_learning' | 'reconcile';
  revision: number; status: FeedEditorialStatus; attempts: number; error: string | null; createdAt: string;
  coverage: Partial<Record<FeedReviewDimension, FeedReviewCoverage>>; summaryThreadId: string | null;
  stale?: boolean; model: string; month?: string; goalTitle?: string; generation?: { slotId: string; segmentId: string; briefRevision: number; estimate: FeedGenerationEstimate };
}

/** Generation never changes a slot until its immutable candidate is accepted. */
export const FEED_GENERATION_LIMITS = { version: 1, estimateMinutes: 30, textCandidates: 5, imageCandidates: 1, outputCharacters: 20_000, referenceBytes: 160_000, references: 20 } as const
export const feedGenerationEstimateRequestSchema = z.object({
  imageProvider: z.enum(['gemini', 'openai-codex']).optional(),
  mutationId: feedIdSchema, expectedRevision: revision, segmentId: feedIdSchema, slotId: feedIdSchema,
  model: z.enum(['standard', 'pro', 'max']).default('standard'), count: z.number().int().min(1).max(5).default(1),
  locale: z.enum(['en', 'ja', 'zh', 'zh-cn']).default('en'),
}).strict()
export type FeedGenerationEstimateRequest = z.infer<typeof feedGenerationEstimateRequestSchema>
export const feedGenerationRequestSchema = z.object({ mutationId: feedIdSchema, estimateId: feedIdSchema, confirmed: z.literal(true) }).strict()
export type FeedGenerationRequest = z.infer<typeof feedGenerationRequestSchema>
export type FeedGenerationCandidate = { applicationId?: string; id: string; runId: string; segmentId: string; slotId: string; sourceRevision: number; briefRevision: number; edits: FeedEdit[]; rationale: string }
export type FeedGenerationPrice = { currency: 'USD'; maximumUsd: number | null; rateVersion: string; billing: 'included' | 'byo' | 'metered' | 'subscription'; credits?: number }
export type FeedGenerationEstimate = {
  id: string; expiresAt: string; revision: number; segmentId: string; slot: FeedPlaceholderAttrs; count: number;
  model: string; tier: string; price: FeedGenerationPrice; inputCharacters: number; maxTokens: number;
  sources: { id: string; title: string; hash: string }[]; omissions: string[]; confirmationRequired: true;
}

/** Editorial confirmation is distinct from saving a version or delivery. */
export const feedConfirmationRequestSchema = z.object({
  mutationId: feedIdSchema, expectedRevision: revision,
  reviewRunId: feedIdSchema.optional(), locale: z.enum(['en', 'ja', 'zh', 'zh-cn']).default('en'),
}).strict()
export type FeedConfirmationRequest = z.infer<typeof feedConfirmationRequestSchema>
export type FeedLearningScope = {
  platform: string; postFormat: 'post' | 'thread' | 'article'; brandId: string | null;
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'; compartments: string[]; projectIds: string[];
}
export type FeedConfirmationSummary = {
  id: string; revision: number; actorUserId: string; createdAt: string;
  priorConfirmationId: string | null; reviewRunId: string | null; revoked: boolean; current: boolean;
}
export const FEED_LEARNING_LIMITS = {
  detailCharacters: 16500, inputCharacters: 64_000, outputTokens: 6000, actors: 10, excerpts: 50, excerptCharacters: 1000, contextArtifacts: 20 } as const

/** UI and confirmed Brian actions share these selected-artifact commands. */
export const feedLearningCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('remember'), rule: z.string().trim().min(1).max(280) }).strict(),
  z.object({ action: z.literal('decideRule'), ruleId: feedIdSchema, decision: z.enum(['approve', 'dismiss', 'forget', 'restore']) }).strict(),
  z.object({ action: z.literal('editRule'), ruleId: feedIdSchema, rule: z.string().trim().min(1).max(280) }).strict(),
  z.object({ action: z.literal('scopeRule'), ruleId: feedIdSchema, scope: z.enum(['post', 'brand_voice']) }).strict(),
  z.object({ action: z.literal('editSummary'), summary: z.string().trim().min(1).max(1200), detail: z.string().trim().max(8000) }).strict(),
  z.object({ action: z.literal('forgetSummary') }).strict(),
  z.object({ action: z.literal('scopeSummary'), scope: z.enum(['post','future']) }).strict(),
  z.object({ action: z.literal('editVoice'), memoryId: feedIdSchema, summary: z.string().trim().min(1).max(280), detail: z.string().trim().max(4000) }).strict(),
  z.object({ action: z.literal('forgetVoice'), memoryId: feedIdSchema }).strict(),
  z.object({ action: z.literal('scopeVoice'), memoryId: feedIdSchema, scope: z.enum(['member', 'post']) }).strict(),
  z.object({ action: z.literal('retractSource'), eventId: feedIdSchema }).strict(),
  z.object({ action: z.literal('revoke') }).strict(),
])
export type FeedLearningCommand = z.infer<typeof feedLearningCommandSchema>
export const feedLearningCommandRequestSchema = z.object({ mutationId: feedIdSchema, expectedRevision: revision, confirmationId: feedIdSchema, command: feedLearningCommandSchema }).strict()
export type FeedLearningCommandRequest = z.infer<typeof feedLearningCommandRequestSchema>

export type FeedLearnedArtifact = {
  id: string; kind: 'rule' | 'voice'; text: string;
  status: 'suggested' | 'active' | 'rejected' | 'retired' | 'forgotten';
  actorUserId: string | null; scope: FeedLearningScope; sourceEventIds: string[];
  canEdit: boolean; canPromote: boolean; erased: boolean;
}
export type FeedLearnedDecisions = {
  canConfirm: boolean; privateSourcesOmitted: boolean;
  confirmations: Array<FeedConfirmationSummary & {
    run: FeedEditorialRunSummary | null;
    summary: { id: string; text: string; sourceEventIds: string[]; postOnly: boolean; correction: string | null; canEdit: boolean; decisions: Array<{ statement: string; sourceIds: string[]; actorUserId: string | null; outcome: string | null }>; conflicts: Array<{ statement: string; sourceIds: string[] }>; unresolved: string[] } | null;
    artifacts: FeedLearnedArtifact[]; coverage: Record<string, unknown>;
  }>;
  sources: Array<{ id: string; sessionId: string | null; actorUserId: string; eventKind: string; actorName: string | null; canRetract: boolean; revision: number | null; outcome: string | null; threadId: string | null }>;
}
