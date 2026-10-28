/**
 * Production wiring for research delivery and follow-up capture: the DB
 * store, the canonical page writer and the viewer-scoped inspector. Routes
 * (chat, channel pipeline) call these; tests drive the port-based services
 * in delivery.ts / feedback.ts directly.
 *
 * [COMP:api/research-delivery] [COMP:api/research-feedback]
 */
import { createHash, randomUUID } from 'node:crypto'
import { markdownToBlocks, normalizeMarkdownBlocks, type SavedViewStore } from '@use-brian/core'
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
import { createDbSavedViewStore } from '../db/saved-views-store.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { publishPageLifecycle } from '../page-event-fanout.js'
import { researchTitleFor, type ResearchDeliveryDeps } from './delivery.js'
import { captureResearchFollowup, replayResearchFollowups, type FollowupCaptureResult, type ResearchFeedbackDeps } from './feedback.js'

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
  }
}

/**
 * Capture one persisted member message as a research follow-up, after first
 * replaying any earlier message in the session a previous capture missed.
 * Never throws: research capture must not block the ordinary reply.
 */
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
    const deps = createResearchFeedbackDeps()
    await replayResearchFollowups(deps, {
      workspaceId: params.workspaceId, sessionId: params.sessionId, assistantId: params.assistantId, actorUserId: params.actorUserId,
      excludeMessageId: params.messageId,
    })
    const message = await getResearchMessageSystem(params.messageId)
    if (!message || message.senderUserId !== params.actorUserId) return null
    const replyToMessageId = params.replyToMessageId
      ?? (params.replyToChannelMessageId ? await findSessionMessageByChannelIdSystem(params.sessionId, params.replyToChannelMessageId) : null)
    return await captureResearchFollowup(deps, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      assistantId: params.assistantId,
      message,
      externalPrincipal: false,
      selectedActivityId: params.selectedActivityId ?? null,
      replyToMessageId: replyToMessageId ?? null,
    })
  } catch (error) {
    params.onError?.(error)
    return null
  }
}
