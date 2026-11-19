import { readFeedSelectedSources } from './source-authority.js'
/** Frozen, authorized source manifests for all five Feed Review checks. [COMP:feed/draft-review] */
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import { maxSensitivity } from '@use-brian/agent-runtime/security/sensitivity.js'
import { FEED_REVIEW_DIMENSIONS, FEED_EDITORIAL_LIMITS, FEED_LEARNING_LIMITS, type FeedReviewContext, type FeedReviewSource, type FeedReviewCoverage, type FeedReviewDimension, type FeedLearningScope } from '@use-brian/shared'
import { projectFeed, walkFeed } from '@use-brian/doc-model/feed.js'
import { type FeedActor, type FeedScope, type FeedReader, type StructuredFeedContent, readFeedCopy, requireFeedComposition, FeedCollaborationError, withFeedTransaction } from '../db/feed-collaboration-store.js'
import { query } from '../db/client.js'
import { feedEditorialHash } from '../db/feed-editorial-runs-store.js'
import { createContentPlanStore, parseMonthRange } from '../db/content-plan-store.js'
import { getGoalById } from '../db/goals.js'
import { getBrandStore } from '../db/brand-store.js'
import { listMemories } from '../db/memories.js'
import { listActivePlaybookRulesForActor } from '../db/playbook-store.js'
import { loadDecisionPlaybookContext, feedLearningScopeApplies } from '../decision-learning/playbook-context.js'
import { appendDecisionApplication } from '../db/decision-provenance-store.js'
import { readFeedPostHistory } from './post-history.js'
const source = (id: string, kind: FeedReviewSource['kind'], title: string, value: unknown): FeedReviewSource => { const body = typeof value === 'string' ? value : JSON.stringify(value); return { id, kind, title, body, hash: feedEditorialHash(body) } }
const coverage = (count = 0, state: FeedReviewCoverage['state'] = count ? 'checked' : 'unavailable', limits: string[] = []): FeedReviewCoverage => ({ state, eligible: count, retrieved: count, reviewed: 0, limits })
export function boundFeedReviewSources(sources: FeedReviewSource[], initial: FeedReviewCoverage) {
  let characters = 0; const kept: FeedReviewSource[] = []; const limits = [...initial.limits]
  for (const entry of sources) {
    if (entry.body.length > FEED_EDITORIAL_LIMITS.sourceCharacters || characters + entry.body.length > FEED_EDITORIAL_LIMITS.inputCharacters || kept.length >= FEED_EDITORIAL_LIMITS.sourcesPerCheck) { if (!limits.includes('whole_source_input_limit')) limits.push('whole_source_input_limit'); continue }
    characters += entry.body.length; kept.push(entry)
  }
  return { sources: kept, coverage: { ...initial, retrieved: kept.length, state: kept.length < sources.length ? 'partial' as const : initial.state, limits } }
}
export async function loadFeedReviewContext(actor: FeedActor, options: { month?: string; historyCursor?: number; source?: { revision: number; content: StructuredFeedContent }; now?: Date; additionalHistorySql?: string } = {}): Promise<FeedReviewContext> {
  // Release the session lock before loaders use the ordinary query pool.
  // Otherwise concurrent requests waiting for that lock could consume every
  // connection while the lock holder waits for a source-loader connection.
  const authorized = await withFeedTransaction(actor, async (client, scope) => {
    const copy = options.source ?? await readFeedCopy(client, actor.sessionId)
    if (!copy) throw new FeedCollaborationError(409, 'working_copy_required')
    return { scope, source: { revision: copy.revision, content: requireFeedComposition(copy.content) } }
  })
  return readFeedReviewContext({ query }, authorized.scope, actor, { ...options, source: authorized.source })
}
async function readFeedReviewContext(client: FeedReader, scope: FeedScope, actor: FeedActor, options: { month?: string; historyCursor?: number; source?: { revision: number; content: StructuredFeedContent }; now?: Date; additionalHistorySql?: string } = {}): Promise<FeedReviewContext> {
  const copy = options.source ?? await readFeedCopy(client, actor.sessionId)
  if (!copy) throw new FeedCollaborationError(409, 'working_copy_required')
  const content = requireFeedComposition(copy.content)
  const session = (await client.query(`SELECT s.title,s.context_compartments,s.context_project_id,u.timezone,(SELECT scheduled_for::text FROM content_plan_slots WHERE assistant_id=$2 AND session_id=$1 ORDER BY scheduled_for LIMIT 1) AS scheduled FROM sessions s JOIN users u ON u.id=$3 WHERE s.id=$1`, [actor.sessionId, actor.assistantId, actor.userId])).rows[0]
  const platform = /^\[([^\]]+)\]/.exec(session.title)?.[1] ?? 'threads'
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: session.timezone || 'UTC', year: 'numeric', month: '2-digit' }).format(options.now ?? new Date())
  const month = options.month ?? content.reviewMonth ?? session.scheduled?.slice(0, 7) ?? today
  if (!parseMonthRange(month)) throw new FeedCollaborationError(400, 'invalid_review_month')
  const dimensions = Object.fromEntries(FEED_REVIEW_DIMENSIONS.map(key => [key, { sources: [], coverage: coverage() }])) as unknown as FeedReviewContext['dimensions']
  const composition = source(`composition:${actor.sessionId}:${copy.revision}`, 'composition', content.title, projectFeed(content.composition).text)
  const hasImages = walkFeed(content.composition).some(item => item.node.type === 'image')
  dimensions.content = { sources: [composition], coverage: coverage(1, hasImages ? 'partial' : 'checked', ['external_facts_unverified', ...(hasImages ? ['image_visuals_not_checked'] : [])]) }
  const members = (await client.query<{ userId: string; clearance: AccessContext['clearance']; compartments: string[] | null }>('SELECT user_id AS "userId",clearance,compartments FROM workspace_members WHERE workspace_id=$1 FOR SHARE', [scope.workspaceId])).rows
  let brandId: string | null = null
  try {
    const brand = await getBrandStore().get(actor.userId, scope.workspaceId)
    const ranks = ['public', 'internal', 'confidential', 'restricted']
    if (brand?.activeRecord && members.every(member => ranks.indexOf(member.clearance ?? 'internal') >= ranks.indexOf(brand.sensitivity)) && ranks.indexOf(scope.clearance) >= ranks.indexOf(brand.sensitivity)) {
      brandId = brand.id
      dimensions.memory.sources.push(source(`brand:${brand.id}:${brand.activeVersionId}`, 'brand', brand.name, brand.activeRecord))
    }
  } catch { dimensions.memory.coverage = coverage(0, 'partial', ['brand_read_failed']) }
  // The existing brand binding is the approved workspace default. Without it,
  // do not assume that another Feed assistant represents this same brand.
  const historyAssistantIds = brandId ? (await client.query<{ id: string }>(`SELECT id FROM assistants WHERE workspace_id=$1 AND kind='app' AND app_type='distribution' AND (id=$2 OR EXISTS (SELECT 1 FROM assistant_capabilities ac WHERE ac.assistant_id=assistants.id AND ac.capability='brand' AND ac.revoked_at IS NULL)) ORDER BY id`, [scope.workspaceId, actor.assistantId])).rows.map(row => row.id) : [actor.assistantId]
  const linkedGoal = content.goalId ? await getGoalById(actor.userId, content.goalId) : null
  const goalCompartment = linkedGoal?.workspaceId === scope.workspaceId && linkedGoal.contextGroupId ? (await client.query('SELECT compartment_key FROM workspace_groups WHERE id=$1 AND workspace_id=$2', [linkedGoal.contextGroupId, scope.workspaceId])).rows[0]?.compartment_key as string | undefined : undefined
  const learningScope: FeedLearningScope = { platform, postFormat: content.postFormat, brandId, sensitivity: maxSensitivity(scope.clearance as 'public' | 'internal' | 'confidential', content.sourceSensitivity ?? 'public'), compartments: [...new Set([...(content.sourceCompartments ?? []), ...(session.context_compartments ?? []), ...(goalCompartment ? [goalCompartment] : [])])], projectIds: [...new Set([...(content.sourceProjectIds ?? []), ...(session.context_project_id ? [session.context_project_id] : []), ...(linkedGoal?.workspaceId === scope.workspaceId && linkedGoal.contextProjectId ? [linkedGoal.contextProjectId] : [])])] }
  const tasks: [FeedReviewDimension, () => Promise<void>][] = [
    ['monthly_plan', async () => {
      const store = createContentPlanStore(); const brief = await store.getBrief(actor.assistantId, month); const slots = await store.listSlots({ assistantId: actor.assistantId, month })
      const sources = [...(brief && (brief.brief || brief.themes.length) ? [source(`plan:${actor.assistantId}:${month}`, 'plan', month, brief)] : []), ...slots.map(slot => ({ ...source(`slot:${slot.id}`, 'plan', slot.title, slot), date: slot.scheduledFor, state: slot.status === 'posted' ? 'published' as const : 'planned' as const }))]
      dimensions.monthly_plan = { sources, coverage: coverage(sources.length) }
    }],
    ['post_goal', async () => {
      if (!content.goalId) { dimensions.post_goal.coverage = coverage(0, 'unavailable', ['no_linked_goal']); return }
      const goal = linkedGoal
      if (!goal || goal.workspaceId !== scope.workspaceId) { dimensions.post_goal.coverage = coverage(0, 'unavailable', ['linked_goal_unavailable']); return }
      dimensions.post_goal = { sources: [source(`goal:${goal.id}`, 'goal', goal.outcome, goal)], coverage: coverage(1) }
    }],
    ['post_history', async () => { dimensions.post_history = await readFeedPostHistory(client, { workspaceId: scope.workspaceId, assistantIds: historyAssistantIds, sessionId: actor.sessionId, text: composition.body, cursor: options.historyCursor, additionalHistorySql: options.additionalHistorySql }); if (!brandId) dimensions.post_history.coverage.limits.push('brand_unbound_current_feed_only') }],
    ['memory', async () => {
      const contexts = members.map(member => ({ workspaceId: scope.workspaceId, userId: member.userId, assistantId: actor.assistantId, assistantKind: 'app' as const, clearance: member.clearance, compartments: member.compartments }))
      contexts.push({ workspaceId: scope.workspaceId, userId: actor.userId, assistantId: actor.assistantId, assistantKind: 'app', clearance: scope.clearance as AccessContext['clearance'], compartments: scope.compartments })
      const lists = await Promise.all(contexts.map(ctx => listMemories(ctx, { limit: FEED_EDITORIAL_LIMITS.sourcesPerCheck })))
      const memoryExceptions = new Set((await client.query<{ id: string }>("SELECT jsonb_array_elements_text(coalesce(coverage->'postOnlyMemoryIds','[]'::jsonb)) AS id FROM feed_learning_outputs WHERE session_id=$1 AND actor_user_id=$2", [actor.sessionId, actor.userId])).rows.map(row => row.id))
      const visible = lists[0]!.memories.filter(memory => !memoryExceptions.has(memory.id) && !memory.retractedAt && lists.every(list => list.memories.some(other => other.id === memory.id))).filter(memory => {
        if (!memory.tags.includes('feed-post-decision') && !memory.tags.includes('feed-editorial-voice')) return true
        try { const detail = JSON.parse(memory.detail ?? '{}'); return (!detail.postOnlySessionId || detail.postOnlySessionId === actor.sessionId) && detail.scope && feedLearningScopeApplies(detail.scope, learningScope) }
        catch { return false }
      })
      const rules = await listActivePlaybookRulesForActor({ assistantId: actor.assistantId, actorUserId: actor.userId, externalPrincipal: false })
      const exceptions = new Set((await client.query<{ id: string }>("SELECT jsonb_array_elements_text(coalesce(coverage->'postOnlyRuleIds','[]'::jsonb)) AS id FROM feed_learning_outputs WHERE session_id=$1 AND actor_user_id=$2", [actor.sessionId, actor.userId])).rows.map(row => row.id))
      const ranks = ['public', 'internal', 'confidential', 'restricted']
      const audienceRank = Math.min(ranks.indexOf(scope.clearance), ...members.map(member => ranks.indexOf(member.clearance ?? 'internal')))
      const sharedRules = rules.filter(rule => !exceptions.has(rule.id) && (rule.appliesToUserId === null || members.every(member => member.userId === rule.appliesToUserId)) && ranks.indexOf(rule.decisionSensitivity) <= audienceRank)
      const playbook = await loadDecisionPlaybookContext({ workspaceId: scope.workspaceId, assistantId: actor.assistantId, actorUserId: actor.userId, externalPrincipal: false, allowedRuleIds: sharedRules.map(rule => rule.id), recordApplication: false, applicability: { kind: 'feed', scope: learningScope }, operationKind: 'feed_review', operationId: actor.sessionId, logLabel: 'feed-review' })
      const selectedRules = sharedRules.filter(rule => playbook.playbookRules.includes(rule.rule.trim()))
      const selected = await readFeedSelectedSources(client, actor, scope, 'memory', content.selectedMemoryIds ?? [])
      if (selected.length !== new Set(content.selectedMemoryIds ?? []).size) throw new FeedCollaborationError(403, 'memory_not_available_to_draft')
      const visibleIds = new Set(visible.map(memory => memory.id))
      dimensions.memory.sources.push(...selected.filter(memory => !visibleIds.has(memory.id)).map(memory => source(`memory:${memory.id}`, 'memory', memory.summary ?? 'Selected memory', { summary: memory.summary, detail: memory.detail })))
      dimensions.memory.sources.push(...visible.map(memory => source(`memory:${memory.id}`, 'memory', memory.summary, { summary: memory.summary, detail: memory.detail, tags: memory.tags })), ...selectedRules.map(rule => source(`playbook:${rule.id}`, 'playbook', 'Approved preference', rule.rule)))
      const limits = [...dimensions.memory.coverage.limits]; if (lists.some(list => list.total > visible.length) || selectedRules.length < rules.length) limits.push('private_or_bounded_sources_omitted')
      if (exceptions.size || memoryExceptions.size) limits.push('post_only_guidance_exception')
      dimensions.memory.coverage = { ...coverage(dimensions.memory.sources.length, limits.length ? 'partial' : dimensions.memory.sources.length ? 'checked' : 'unavailable', limits), eligible: dimensions.memory.sources.length }
    }],
  ]
  await Promise.all(tasks.map(async ([key, read]) => { try { await read() } catch { dimensions[key] = { sources: [], coverage: coverage(0, 'failed', ['source_read_failed']) } } }))
  for (const key of FEED_REVIEW_DIMENSIONS) dimensions[key] = boundFeedReviewSources(dimensions[key].sources, dimensions[key].coverage)
  if (dimensions.memory.sources.length > FEED_LEARNING_LIMITS.contextArtifacts) {
    dimensions.memory.sources = dimensions.memory.sources.slice(0, FEED_LEARNING_LIMITS.contextArtifacts)
    dimensions.memory.coverage = { ...dimensions.memory.coverage, state: 'partial', retrieved: dimensions.memory.sources.length, limits: [...dimensions.memory.coverage.limits, 'application_source_limit'] }
  }
  const context = { historyCursor: options.historyCursor ?? 0, version: 1 as const, revision: copy.revision, composition: content.composition, platform, month, goalId: content.goalId ?? null, brandId, historyAssistantIds, learningScope, dimensions }
  return { ...context, contextHash: feedEditorialHash(context) }
}

export type FeedReviewContextLoader = typeof loadFeedReviewContext
export function createFeedReviewContextLoader(additionalHistorySql?: string): FeedReviewContextLoader {
  return (actor, options = {}) => loadFeedReviewContext(actor, { ...options, additionalHistorySql })
}

/** Record only whole, authorized memory/rule sources actually sent to a model. */
export async function recordFeedContextApplication(actor: FeedActor, workspaceId: string, operationKind: 'feed_review' | 'feed_generation' | 'feed_chat', operationId: string, sources: FeedReviewSource[], scope?: FeedLearningScope): Promise<string | null> {
  const refs = sources.filter(source => source.kind === 'memory' || source.kind === 'playbook').map(source => ({ kind: source.kind === 'memory' ? 'memory' as const : 'assistant_playbook_rule' as const, id: source.id.slice(source.id.indexOf(':') + 1) }))
  if (!refs.length) return null
  const application = await appendDecisionApplication({ workspaceId, actorUserId: actor.userId, assistantId: actor.assistantId, operationKind, operationId, sourceKind: 'feed_session', sourceId: actor.sessionId, artifactRefs: refs, visibility: 'owner', sensitivity: scope?.sensitivity ?? 'internal' })
  const saved = (await query<{ artifact_refs: typeof refs }>('SELECT artifact_refs FROM decision_applications WHERE id=$1', [application.id])).rows[0]
  const keys = (items: typeof refs) => items.map(ref => `${ref.kind}:${ref.id}`).sort().join('\n')
  if (!saved || keys(saved.artifact_refs) !== keys(refs)) throw new FeedCollaborationError(409, 'learning_application_changed')
  return application.id
}
