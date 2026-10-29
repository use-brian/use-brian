/**
 * Production wiring for research delivery and follow-up capture: the DB
 * store, the canonical page writer and the viewer-scoped inspector. Routes
 * (chat, channel pipeline) call these; tests drive the port-based services
 * in delivery.ts / feedback.ts directly.
 *
 * [COMP:api/research-delivery] [COMP:api/research-feedback]
 */
import { createHash, randomUUID } from 'node:crypto'
import { markdownToBlocks, normalizeMarkdownBlocks, interpretResearchFollowup, resolveResearchFollowupTarget, type SavedViewStore } from '@use-brian/core'
import {
  artifactReadableForViewer,
  findSessionMessageByChannelIdSystem,
  getResearchActivityForViewer,
  getResearchMessageSystem,
  listResearchActivitiesForViewer,
  listResearchMessagesAfterSystem,
  openResearchActivitySystem,
  recordResearchFeedbackSystem,
  researchDefaultPageSourceForViewer,
  researchSourceUnavailable,
  settleResearchActivitySystem,
  type ResearchActivity,
  type ResearchSensitivity,
} from '../db/research-store.js'
import { getPool } from '../db/client.js'
import { readFeedbackFrame, readFeedbackMessage, replyActivity, discoverFeedbackMessages, claimFeedbackRetries, prepareFeedbackAttempt, releaseFeedbackAttempt, renewFeedbackAttempt, feedbackTargetExists, readFeedbackReceipt, rejectFeedbackSelection, type FeedbackAttempt, type FeedbackFrame, type AttemptLease } from '../db/research-feedback-attempt-store.js'
import { createDbSavedViewStore } from '../db/saved-views-store.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { publishPageLifecycle } from '../page-event-fanout.js'
import { researchTitleFor, type ResearchDeliveryDeps } from './delivery.js'
import { captureResearchFollowup, outputKeyFor, ownFollowupText, type FollowupCaptureResult, type FollowupMessage, type ResearchFeedbackDeps } from './feedback.js'

const RANK: Record<ResearchSensitivity, number> = { public: 0, internal: 1, confidential: 2 }

/** One activity per research invocation: session + persisted request message. */
export function researchIdempotencyKey(sessionId: string, requestMessageId: string): string {
  return `research:${createHash('sha256').update(`${sessionId}\u0000${requestMessageId}`).digest('hex').slice(0, 48)}`
}

export async function beginResearchActivity(input: {
  workspaceId: string
  sessionId: string
  requestMessageId: string
  actorUserId: string
  assistantId: string
  projectId: string | null
  entry: 'explicit' | 'adaptive'
  runtime: Record<string, unknown>
  sensitivity?: ResearchSensitivity | null
  compartments?: readonly string[] | null
  taskId?: string | null
}): Promise<ResearchActivity> {
  const message = await getResearchMessageSystem(input.requestMessageId)
  const sensitivity = [input.sensitivity ?? 'internal', message?.sensitivity ?? 'internal']
    .reduce<ResearchSensitivity>((a, b) => (RANK[b as ResearchSensitivity] > RANK[a] ? b as ResearchSensitivity : a), 'internal')
  const compartments = [...new Set([...(input.compartments ?? []), ...(message?.compartments ?? [])])].sort()
  const { activity } = await openResearchActivitySystem({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    requestMessageId: input.requestMessageId,
    requestMessageVersion: message?.version ?? null,
    actorUserId: input.actorUserId,
    assistantId: input.assistantId,
    projectId: input.projectId,
    taskId: input.taskId ?? null,
    entry: input.entry,
    idempotencyKey: researchIdempotencyKey(input.sessionId, input.requestMessageId),
    plannedPageId: randomUUID(),
    runtime: input.runtime,
    sensitivity,
    compartments,
  })
  return activity
}

async function sharedProjectActive(projectId: string, workspaceId: string): Promise<boolean> {
  const r = await getPool().query(
    `SELECT 1 FROM project_shared_scopes s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.project_id = $1 AND s.workspace_id = $2 AND s.status = 'active' AND w.project_shared_spaces`, [projectId, workspaceId])
  return r.rows.length > 0
}

let cachedStore: SavedViewStore | null = null

/**
 * The default Page goes through the same lifecycle-emitting store the
 * assistant's own page tools use, so a page-event workflow sees it the same way.
 */
export function createResearchDeliveryDeps(savedViewStore?: SavedViewStore): ResearchDeliveryDeps {
  const store = () => savedViewStore ?? (cachedStore ??= createDbSavedViewStore({ onPageLifecycle: publishPageLifecycle }))
  return {
    async settle(input) {
      const settled = await settleResearchActivitySystem(input)
      notifyWorkspaceChange(settled.workspaceId, 'research', 'update', settled.id)
      return settled
    },
    inspect: artifactReadableForViewer,
    async currentActivity(userId,workspaceId,activityId) {
      return (await getResearchActivityForViewer(userId,workspaceId,activityId))?.activity ?? null
    },
    async writeDefaultPage(input) {
      // The canonical writer places a new page at `internal`; it has no
      // clearance input. A confidential source floor therefore fails closed
      // (partial, with the recovery action) instead of downgrading the output.
      if (input.sensitivity === 'confidential') {
        throw Object.assign(new Error('research output is confidential'), { code: 'research_confidential_floor' })
      }
      const source = await researchDefaultPageSourceForViewer({ userId:input.userId,workspaceId:input.workspaceId,
        activityId:input.activityId,requestMessageId:input.requestMessageId,pageId:input.pageId })
      if (source.projectId !== input.projectId) throw researchSourceUnavailable()
      const blocks = normalizeMarkdownBlocks(markdownToBlocks(input.markdown))
      const shared = input.projectId ? await sharedProjectActive(input.projectId, input.workspaceId) : false
      const view = await store().createDraft({
        id: input.pageId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        writtenBy: 'system',
        name: source.private ? researchTitleFor(source.requestText) : input.title,
        nameOrigin: 'user',
        icon: null,
        entity: 'tasks',
        viewType: 'table',
        binding: { entity: 'tasks', viewType: 'table' },
        page: { blocks },
        state: 'saved',
        originPrompt: source.private ? source.requestText : input.originPrompt ?? undefined,
        ...(source.private ? { teamspaceId: null } : {}),
        ...(input.projectId ? (shared ? { sharedProjectId: input.projectId } : { projectId: input.projectId }) : {}),
      } as Parameters<SavedViewStore['createDraft']>[0], source.private ? { provenance: { kind:'research-private',actorId:input.userId,
        activityId:input.activityId,requestMessageId:input.requestMessageId!,pageId:input.pageId } } : undefined)
      const inspected = await artifactReadableForViewer(input.userId,'page',view.id)
      if (!inspected.readable || inspected.version === null) throw researchSourceUnavailable()
      return { pageId: view.id, version: inspected.version }
    },
  }
}

export function createResearchFeedbackDeps(): ResearchFeedbackDeps & {
  listMessagesAfter: (sessionId: string, afterMessageId: string, limit: number) => ReturnType<typeof listResearchMessagesAfterSystem>
} {
  return {
    listSessionActivities: (actor, workspaceId, sessionId) => listResearchActivitiesForViewer(actor, workspaceId, { sessionId, limit: 20 }),
    async getActivity(actor, workspaceId, activityId) {
      const detail = await getResearchActivityForViewer(actor, workspaceId, activityId)
      return detail ? { activity: detail.activity, artifacts: detail.artifacts } : null
    },
    async record(input) {
      const result = await recordResearchFeedbackSystem(input)
      if (result.inserted) notifyWorkspaceChange(input.workspaceId, 'research', 'update', input.activityId)
      return result
    },
    listMessagesAfter: listResearchMessagesAfterSystem,
    async findReplyActivity(actor, workspaceId, output) {
      const id = await replyActivity(actor,workspaceId,output)
      const detail = id ? await getResearchActivityForViewer(actor,workspaceId,id) : null
      return detail ? { activity:detail.activity,artifacts:detail.artifacts } : null
    },
    replayDurable: params => replayDurableFeedback(params),
  }
}

type FeedbackCaptureParams = Parameters<typeof captureResearchFollowupForMessage>[0]
function leaseFor(attempt: FeedbackAttempt): AttemptLease {
  if (!attempt.leaseToken) throw new Error('research_feedback_attempt_unclaimed')
  return { messageId:attempt.messageId,messageVersion:attempt.messageVersion,leaseToken:attempt.leaseToken }
}
/** Actual admitted context is read again for every item; ledger references never grant access. */
async function captureStoredFeedback(params: FeedbackCaptureParams, message: FollowupMessage, frame: FeedbackFrame, pending?: FeedbackAttempt): Promise<FollowupCaptureResult> {
  const actor = params.actorUserId!, workspace = params.workspaceId!
  const deps = createResearchFeedbackDeps()
  deps.listSessionActivities = async () => frame.activities
  deps.record = async input => {
    const existing = await readFeedbackReceipt(actor,input.messageId)
    if (existing) return { feedback:existing,inserted:false }
    if (pending && (input.activityId!==pending.targetActivityId || input.outputKey!==pending.targetOutputKey)) throw new Error('research_feedback_context_changed')
    const intent = pending ?? await prepareFeedbackAttempt({ workspaceId:workspace,sessionId:params.sessionId,assistantId:params.assistantId,
      actorUserId:actor,messageId:message.id,messageVersion:message.version,contextKey:frame.key,targetActivityId:input.activityId,
      targetOutputKey:input.outputKey,association:input.association,selectedActivityId:params.selectedActivityId,replyToMessageId:params.replyToMessageId })
    if (!intent) throw new Error('research_feedback_attempt_busy')
    const lease = leaseFor(intent)
    try {
      const result = await recordResearchFeedbackSystem({ ...input,association:pending?.association ?? input.association,attemptLease:lease })
      if (result.inserted) notifyWorkspaceChange(workspace,'research','update',input.activityId)
      return result
    } catch (error) { await releaseFeedbackAttempt(lease); throw error }
  }
  const result = await captureResearchFollowup(deps, { workspaceId:workspace,sessionId:params.sessionId,assistantId:params.assistantId,
    message,externalPrincipal:false,selectedActivityId:pending?.targetActivityId ?? params.selectedActivityId,
    replyToMessageId:params.replyToMessageId })
  if (!pending && params.selectedActivityId && (result.outcome==='no_research' || (result.outcome==='unlinked' && result.reason==='not_visible'))) {
    await rejectFeedbackSelection({workspaceId:workspace,sessionId:params.sessionId,assistantId:params.assistantId,actorUserId:actor,
      messageId:message.id,messageVersion:message.version,contextKey:frame.key,selectedActivityId:params.selectedActivityId})
    return result
  }
  if (!pending && result.outcome!=='recorded' && result.outcome!=='replayed') {
    const reason = result.outcome==='not_member' ? 'no_member_text' : result.outcome==='no_research' ? 'no_research'
      : 'reason' in result && result.reason==='multiple_outputs' ? 'multiple_outputs' : 'unrelated_or_uncertain'
    // Derive source-only validity from canonical member-owned meaning, never
    // the fallback storage reason (which can also describe authority refusal).
    const ownText = ownFollowupText(message.content)
    const interpretation = interpretResearchFollowup(ownText)
    const sourceOnlyEvaluation = !params.selectedActivityId && !params.replyToMessageId
      && (!ownText || interpretation.uncertain || interpretation.kind==='changed_objective')
    await prepareFeedbackAttempt({ workspaceId:workspace,sessionId:params.sessionId,assistantId:params.assistantId,actorUserId:actor,
      messageId:message.id,messageVersion:message.version,contextKey:frame.key,reason,sourceOnlyEvaluation })
  }
  return result
}
async function replayDurableFeedback(params: { workspaceId:string;sessionId:string;assistantId:string;actorUserId:string;excludeMessageId?:string|null }, onError?: (error:unknown) => void): Promise<number> {
  let recorded = 0
  // A denied triggering turn cannot use retained assistant authority to replay.
  if(!await readFeedbackFrame(params.actorUserId,params.workspaceId,params.sessionId,params.assistantId)) return recorded
  const retries = await claimFeedbackRetries(params.actorUserId,params.workspaceId,params.sessionId,params.excludeMessageId ?? null)
  for (let pending of retries) {
    let lease = leaseFor(pending)
    try {
      const retryParams={...params,assistantId:pending.assistantId}
      const frame = await readFeedbackFrame(params.actorUserId,params.workspaceId,params.sessionId,retryParams.assistantId)
      const message = await readFeedbackMessage(params.actorUserId,params.workspaceId,params.sessionId,retryParams.assistantId,pending.messageId)
      if (!frame || !message) continue // Temporary hold/revocation remains recoverable.
      // A pinned implicit target preserves identity, not explicit-selection
      // meaning. Re-admit current words with the canonical implicit resolver.
      if (pending.association==='same_chat_continuation' && resolveResearchFollowupTarget({
        candidates:[{activityId:pending.targetActivityId!,outputMessageId:null}],
        interpretation:interpretResearchFollowup(ownFollowupText(message.content)),
      }).status!=='linked') continue

      if (message.version!==pending.messageVersion) {
        const renewed = await renewFeedbackAttempt(lease,message.version,frame.key)
        if (!renewed) continue
        pending=renewed;lease=leaseFor(renewed)
      }
      const target = pending.targetActivityId ? await getResearchActivityForViewer(params.actorUserId,params.workspaceId,pending.targetActivityId) : null
      if (!target) {
        if (!pending.targetActivityId || !(await feedbackTargetExists(pending.targetActivityId))) await releaseFeedbackAttempt(lease,true)
        continue
      }
      const currentOutput = outputKeyFor(target.activity,target.artifacts)
      if (currentOutput!==pending.targetOutputKey) {
        // An omitted artifact can be temporarily hidden; retain its retry.
        if (target.artifacts.some(a => a.relation==='output') || pending.targetOutputKey?.startsWith('message:')) await releaseFeedbackAttempt(lease,true)
        continue
      }
      const result = await captureStoredFeedback({ ...retryParams,messageId:message.id,externalPrincipal:false },message,frame,pending)
      if (result.outcome==='recorded') recorded++
    } catch (error) { onError?.(error) }
    finally { await releaseFeedbackAttempt(lease).catch(error => onError?.(error)) }
  }
  const frame = await readFeedbackFrame(params.actorUserId,params.workspaceId,params.sessionId,params.assistantId)
  if (!frame) return recorded
  const messages = await discoverFeedbackMessages(params.actorUserId,params.workspaceId,params.sessionId,params.assistantId,frame,params.excludeMessageId ?? null)
  for (const id of messages) {
    try {
      const currentFrame = await readFeedbackFrame(params.actorUserId,params.workspaceId,params.sessionId,params.assistantId)
      const message = await readFeedbackMessage(params.actorUserId,params.workspaceId,params.sessionId,params.assistantId,id)
      if (!currentFrame || !message) continue
      const result = await captureStoredFeedback({ ...params,messageId:id,externalPrincipal:false },message,currentFrame)
      if (result.outcome==='recorded') recorded++
    } catch (error) { onError?.(error) }
  }
  return recorded
}

/** Feedback recovery cannot prevent direct capture or the ordinary reply. */
export async function captureResearchFollowupForMessage(params: {
  workspaceId: string | null
  sessionId: string
  assistantId: string
  messageId: string
  actorUserId: string | null
  externalPrincipal: boolean
  selectedActivityId?: string | null
  replyToMessageId?: string | null
  /** A channel-native reply target, resolved to its persisted message. */
  replyToChannelMessageId?: string | null
  onError?: (error: unknown) => void
}): Promise<FollowupCaptureResult | null> {
  if (!params.workspaceId || !params.actorUserId || params.externalPrincipal) return null
  try {
    await replayDurableFeedback({ workspaceId:params.workspaceId,sessionId:params.sessionId,assistantId:params.assistantId,
      actorUserId:params.actorUserId,excludeMessageId:params.messageId },params.onError)
  } catch (error) { params.onError?.(error) }
  try {
    const frame = await readFeedbackFrame(params.actorUserId,params.workspaceId,params.sessionId,params.assistantId)
    const message = await readFeedbackMessage(params.actorUserId,params.workspaceId,params.sessionId,params.assistantId,params.messageId)
    if (!frame || !message) return null
    const replyToMessageId = params.replyToMessageId
      ?? (params.replyToChannelMessageId ? await findSessionMessageByChannelIdSystem(params.sessionId,params.replyToChannelMessageId) : null)
    return await captureStoredFeedback({ ...params,replyToMessageId },message,frame)
  } catch (error) { params.onError?.(error); return null }
}
