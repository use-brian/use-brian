/**
 * Open content-planning HTTP surface.
 *
 * Mounted at `/api/distribution` in OSS so app-web can reuse the same wire
 * contract. No handler connects to, publishes through, or reads from an
 * external platform.
 *
 * [COMP:feed/content-planning-routes]
 */

import { Router, type Response } from 'express'
import {
  canMemberDraftRole,
  getWorkspaceMembershipSystem,
} from '../db/workspace-store.js'
import { query } from '../db/client.js'
import { parsePostMedia } from '../content-planning/media.js'
import type { PostMedia } from '../db/content-planning-store.js'
import {
  createContentPlanningStore,
  isContentPlanningPlatform,
  type ContentDraftSeed,
  type ContentDraftSeedKind,
  type ContentPlanningPlatform,
  type ContentPlanningStore,
  type SavedContentDraft,
} from '../db/content-planning-store.js'
import {
  findSessionById,
  getSessionMessages,
} from '../db/sessions.js'
import { findUserById } from '../db/users.js'
import {
  getSessionPresence,
  setSessionTyping,
  subscribeSessionEvents,
  type SessionEvent,
} from '../session-event-bus.js'

const VALID_SEED_KINDS: readonly ContentDraftSeedKind[] = [
  'inspiration-reply',
  'inspiration-original',
  'freeform',
  'freeform-reply',
]

export type PlanningAccessContext = {
  userId: string
  workspaceId: string
  role: 'owner' | 'admin' | 'member'
  canDraft: boolean
}

export interface ContentPlanningRouteOptions {
  store?: ContentPlanningStore
  resolveAccess?: (
    userId: string,
    assistantId: string,
  ) => Promise<PlanningAccessContext | null>
  resolveWorkspaceAccess?: (
    userId: string,
    workspaceId: string,
  ) => Promise<boolean>
  /** Optional managed delivery after local approval. Unsupported drafts stay ready. */
  publishApproved?: (
    draft: SavedContentDraft,
  ) => Promise<
    | { status: 'posted'; permalink?: string }
    | { status: 'manual'; reason?: string }
  >
}

export function contentPlanningRoutes(
  options: ContentPlanningRouteOptions = {},
): Router {
  const router = Router()
  const store = options.store ?? createContentPlanningStore()
  const resolveAccess = options.resolveAccess ?? resolvePlanningAccess
  const resolveWorkspaceAccess =
    options.resolveWorkspaceAccess
    ?? (async (userId, workspaceId) =>
      (await getWorkspaceMembershipSystem(userId, workspaceId)) !== null)

  async function access(
    req: { userId?: string; params: { assistantId: string } },
    res: Response,
  ): Promise<PlanningAccessContext | null> {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const ctx = await resolveAccess(req.userId, req.params.assistantId)
    if (!ctx) {
      res.status(403).json({ error: 'Not a member of this workspace.' })
      return null
    }
    return ctx
  }

  function requireDraftPermission(
    ctx: PlanningAccessContext,
    res: Response,
  ): boolean {
    if (ctx.canDraft) return true
    res.status(403).json({
      error: 'Draft permission required. Ask a workspace admin to grant you draft access.',
    })
    return false
  }

  // The OSS build has no connected-provider profiles. Returning a successful
  // empty collection lets the shared surface distinguish "no connections"
  // from "the planning API is unavailable".
  router.get<{ workspaceId: string }>(
    '/team/:workspaceId/profiles',
    async (req, res) => {
      if (!req.userId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      if (!(await resolveWorkspaceAccess(req.userId, req.params.workspaceId))) {
        res.status(403).json({ error: 'Not a member of this workspace.' })
        return
      }
      res.json({ profiles: [] })
    },
  )

  router.post<{ assistantId: string }>(
    '/:assistantId/draft-sessions',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!isContentPlanningPlatform(body.platform)) {
        res.status(400).json({
          error: 'platform must be one of "instagram", "threads", "twitter", "xhs", "linkedin"',
        })
        return
      }
      const seed = parseContentDraftSeed(body.seed, body.platform)
      if (seed === 'invalid') {
        res.status(400).json({ error: 'invalid seed payload' })
        return
      }
      const title =
        typeof body.title === 'string'
          ? body.title.trim().slice(0, 200) || undefined
          : undefined
      try {
        const session = await store.createSession({
          assistantId: req.params.assistantId,
          userId: ctx.userId,
          platform: body.platform,
          title,
          seed: seed ?? undefined,
        })
        res.status(201).json({ session })
      } catch (error) {
        console.error('[content-planning] create session failed:', error)
        res.status(500).json({ error: 'Failed to create draft session' })
      }
    },
  )

  router.get<{ assistantId: string }>(
    '/:assistantId/draft-sessions',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      const platform =
        isContentPlanningPlatform(req.query.platform)
          ? req.query.platform
          : undefined
      try {
        res.json({
          sessions: await store.listSessions({
            assistantId: req.params.assistantId,
            platform,
          }),
        })
      } catch (error) {
        console.error('[content-planning] list sessions failed:', error)
        res.status(500).json({ error: 'Failed to list draft sessions' })
      }
    },
  )

  router.get<{ assistantId: string; sessionId: string }>(
    '/:assistantId/draft-sessions/:sessionId/saved-drafts',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      if (!(await store.sessionExists(req.params.assistantId, req.params.sessionId))) {
        res.status(404).json({ error: 'Draft session not found' })
        return
      }
      const drafts = await store.listSessionDrafts(
        req.params.assistantId,
        req.params.sessionId,
      )
      res.json({ drafts: drafts.map(toSavedDraftWire) })
    },
  )

  router.delete<{ assistantId: string; sessionId: string }>(
    '/:assistantId/draft-sessions/:sessionId',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      const isAdmin = ctx.role === 'owner' || ctx.role === 'admin'
      const removed = await store.discardSession({
        assistantId: req.params.assistantId,
        sessionId: req.params.sessionId,
        userId: ctx.userId,
        allowAnyone: isAdmin,
      })
      if (!removed) {
        res.status(isAdmin ? 404 : 403).json({
          error: isAdmin
            ? 'Draft session not found'
            : 'You can only discard drafts you started.',
        })
        return
      }
      res.json({ ok: true })
    },
  )

  router.post<{ assistantId: string; sessionId: string }>(
    '/:assistantId/draft-sessions/:sessionId/save-draft',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const parsed = parseContentDraftBody(req.body)
      if (parsed === 'invalid') {
        res.status(400).json({
          error: 'Body must include text and a supported platform.',
        })
        return
      }
      if (!(await store.sessionExists(req.params.assistantId, req.params.sessionId))) {
        res.status(404).json({ error: 'Draft session not found' })
        return
      }
      await store.saveDraft({
        assistantId: req.params.assistantId,
        sessionId: req.params.sessionId,
        userId: ctx.userId,
        ...parsed,
      })
      // Reply ids are retained as planning context. No provider resolution is
      // attempted in OSS; approval moves the draft to the manual queue.
      res.status(201).json({
        ok: true,
        ...(parsed.reply
          ? { reply: { resolved: false, reason: 'manual_posting' } }
          : {}),
      })
    },
  )

  router.get<{ assistantId: string }>(
    '/:assistantId/approvals',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      const requested = Number(req.query.limit)
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(requested, 1), 200)
        : 50
      const drafts = await store.listPending(req.params.assistantId, limit)
      res.json({ approvals: drafts.map(toApprovalWire) })
    },
  )

  router.post<{ assistantId: string; eventId: string }>(
    '/:assistantId/approvals/:eventId/approve',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const text =
        typeof req.body?.text === 'string'
          ? req.body.text.trim().slice(0, 4_000)
          : undefined
      const updated = await store.approve({
        assistantId: req.params.assistantId,
        draftId: req.params.eventId,
        userId: ctx.userId,
        finalText: text || undefined,
      })
      if (!updated) {
        res.status(409).json({
          error: 'This draft is no longer pending.',
          code: 'DRAFT_NOT_PENDING',
        })
        return
      }
      const draft = options.publishApproved
        ? await store.getDraft(req.params.assistantId, req.params.eventId)
        : null
      if (draft && options.publishApproved) {
        try {
          const delivery = await options.publishApproved(draft)
          if (delivery.status === 'posted') {
            await store.markPosted({
              assistantId: req.params.assistantId,
              draftId: req.params.eventId,
              userId: ctx.userId,
              permalink: delivery.permalink,
            })
            res.json({ ok: true, status: 'posted', permalink: delivery.permalink ?? null })
            return
          }
          res.json({ ok: true, status: 'ready', delivery: delivery.reason ?? 'manual_posting' })
          return
        } catch (error) {
          console.error('[content-planning] managed publish failed:', error)
          res.json({
            ok: true,
            status: 'ready',
            delivery: 'managed_publish_failed',
            error: error instanceof Error ? error.message : 'Managed publish failed',
          })
          return
        }
      }
      res.json({ ok: true, status: 'ready' })
    },
  )

  router.post<{ assistantId: string; eventId: string }>(
    '/:assistantId/approvals/:eventId/reject',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const updated = await store.reject({
        assistantId: req.params.assistantId,
        draftId: req.params.eventId,
        userId: ctx.userId,
      })
      if (!updated) {
        res.status(409).json({
          error: 'This draft is no longer pending.',
          code: 'DRAFT_NOT_PENDING',
        })
        return
      }
      res.json({ ok: true })
    },
  )

  router.get<{ assistantId: string }>(
    '/:assistantId/ready-posts',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      const ready = await store.listReady(req.params.assistantId)
      res.json({
        ready: ready.map((draft) => ({
          id: draft.id,
          platform: draft.platform,
          metadata: {
            finalText: draft.finalText ?? draft.draftText,
            imageBrief: draft.imageBrief,
            approvedBy: draft.resolvedBy,
            sessionId: draft.sessionId,
            postFormat: draft.postFormat,
            ...draft.formatData,
          },
          createdAt: draft.resolvedAt ?? draft.createdAt,
        })),
      })
    },
  )

  router.post<{ assistantId: string; eventId: string }>(
    '/:assistantId/ready-posts/:eventId/mark-posted',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const permalink =
        typeof req.body?.permalink === 'string'
          ? req.body.permalink.trim().slice(0, 2_048)
          : undefined
      if (permalink && !isHttpUrl(permalink)) {
        res.status(400).json({ error: 'permalink must be an http(s) URL' })
        return
      }
      const updated = await store.markPosted({
        assistantId: req.params.assistantId,
        draftId: req.params.eventId,
        userId: ctx.userId,
        permalink,
      })
      if (!updated) {
        res.status(409).json({ error: 'This post is no longer ready.' })
        return
      }
      res.json({ ok: true })
    },
  )

  router.post<{ assistantId: string; eventId: string }>(
    '/:assistantId/ready-posts/:eventId/discard',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const updated = await store.discardReady({
        assistantId: req.params.assistantId,
        draftId: req.params.eventId,
        userId: ctx.userId,
      })
      if (!updated) {
        res.status(409).json({ error: 'This post is no longer ready.' })
        return
      }
      res.json({ ok: true })
    },
  )

  router.post<{ assistantId: string; eventId: string }>(
    '/:assistantId/saved-drafts/:eventId/remove',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const updated = await store.removeDraft({
        assistantId: req.params.assistantId,
        draftId: req.params.eventId,
        userId: ctx.userId,
      })
      if (!updated) {
        res.status(404).json({ error: 'Saved draft not found' })
        return
      }
      res.json({ removed: true })
    },
  )

  // Local planning deliberately does not operate as a server-side fetch
  // proxy. Linked pages can still be read by the assistant's normal browser
  // capability during the chat turn.
  router.post<{ assistantId: string; sessionId: string }>(
    '/:assistantId/draft-sessions/:sessionId/post-preview',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
      if (!url || url.length > 2_000 || !isHttpUrl(url)) {
        res.status(400).json({ error: 'Body must be { url: http(s) URL }' })
        return
      }
      if (!(await store.sessionExists(req.params.assistantId, req.params.sessionId))) {
        res.status(404).json({ error: 'Draft session not found' })
        return
      }
      res.json({ post: null })
    },
  )

  router.get<{ assistantId: string; sessionId: string }>(
    '/:assistantId/draft-sessions/:sessionId/stream',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      const session = await findSessionById(req.params.sessionId)
      if (
        !session
        || session.assistantId !== req.params.assistantId
        || session.mode !== 'draft'
      ) {
        res.status(404).json({ error: 'Draft session not found' })
        return
      }
      const user = await findUserById(ctx.userId)
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.flushHeaders?.()
      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      const recent = await query<{ lastSequence: number }>(
        `SELECT COALESCE(MAX(sequence_num), 0)::int AS "lastSequence"
           FROM session_messages
          WHERE session_id = $1`,
        [req.params.sessionId],
      )
      send('hello', {
        presence: getSessionPresence(req.params.sessionId),
        lastSequence: recent.rows[0]?.lastSequence ?? 0,
      })
      const since = Number(req.query.since)
      if (Number.isFinite(since) && since >= 0) {
        const messages = await getSessionMessages(req.params.sessionId, {
          afterSequence: since,
          limit: 50,
        })
        if (messages.length > 0) {
          send('replay', {
            messages: messages.map((message) => ({
              id: message.id,
              role: message.role,
              content: message.content,
              sequenceNum: message.sequenceNum,
              senderUserId: message.senderUserId,
              createdAt: message.createdAt.toISOString(),
            })),
          })
        }
      }
      const unsubscribe = subscribeSessionEvents({
        sessionId: req.params.sessionId,
        userId: ctx.userId,
        name: user?.name ?? null,
        cb: (event: SessionEvent) => send(event.kind, event.payload),
      })
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000)
      keepalive.unref?.()
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(keepalive)
        unsubscribe()
        res.end()
      }
      req.on('close', close)
      req.on('aborted', close)
      res.on('error', close)
    },
  )

  router.post<{ assistantId: string; sessionId: string }>(
    '/:assistantId/draft-sessions/:sessionId/typing',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      if (!(await store.sessionExists(req.params.assistantId, req.params.sessionId))) {
        res.status(404).json({ error: 'Draft session not found' })
        return
      }
      setSessionTyping({
        sessionId: req.params.sessionId,
        userId: ctx.userId,
        isTyping: req.body?.isTyping === true,
      })
      res.status(204).end()
    },
  )

  return router
}

/**
 * Membership + draft-permission context for a distribution assistant.
 * Exported so the plan router (`content-plan.ts`) reuses this exact gate
 * rather than reimplementing it (docs/plans/feed-revamp.md §6).
 */
export async function resolvePlanningAccess(
  userId: string,
  assistantId: string,
): Promise<PlanningAccessContext | null> {
  const result = await query<{
    workspaceId: string | null
    kind: string
    appType: string | null
  }>(
    `SELECT workspace_id AS "workspaceId", kind, app_type AS "appType"
       FROM assistants
      WHERE id = $1`,
    [assistantId],
  )
  const assistant = result.rows[0]
  if (
    !assistant?.workspaceId
    || assistant.kind !== 'app'
    || assistant.appType !== 'distribution'
  ) {
    return null
  }
  const membership = await getWorkspaceMembershipSystem(
    userId,
    assistant.workspaceId,
  )
  if (!membership) return null
  return {
    userId,
    workspaceId: assistant.workspaceId,
    role: membership.role,
    canDraft: canMemberDraftRole(membership.role, membership.canDraft),
  }
}

export function parseContentDraftSeed(
  value: unknown,
  platform: ContentPlanningPlatform,
): ContentDraftSeed | null | 'invalid' {
  if (value === undefined || value === null) return null
  if (!isRecord(value) || !VALID_SEED_KINDS.includes(value.kind as ContentDraftSeedKind)) {
    return 'invalid'
  }
  const kind = value.kind as ContentDraftSeedKind
  if (kind === 'freeform') {
    const brief = typeof value.brief === 'string'
      ? value.brief.trim().slice(0, 4_000)
      : value.brief === undefined
        ? undefined
        : null
    if (brief === null) return 'invalid'
    const format = typeof value.format === 'string' ? value.format : undefined
    const validFormats = platform === 'twitter'
      ? ['post', 'thread']
      : platform === 'linkedin'
        ? ['post', 'article']
        : ['post']
    if (format && !validFormats.includes(format)) return 'invalid'
    if (value.link === undefined) {
      return {
        kind,
        ...(brief ? { brief } : {}),
        ...(format ? { format: format as ContentDraftSeed['format'] } : {}),
      }
    }
    if (
      typeof value.link !== 'string'
      || value.link.length > 2_048
      || !isHttpUrl(value.link)
    ) {
      return 'invalid'
    }
    return {
      kind,
      link: value.link,
      ...(brief ? { brief } : {}),
      ...(format ? { format: format as ContentDraftSeed['format'] } : {}),
    }
  }
  if (!isRecord(value.candidate)) return 'invalid'
  const candidate = value.candidate
  if (
    !isContentPlanningPlatform(candidate.platform)
    || candidate.platform !== platform
    || typeof candidate.externalId !== 'string'
    || !candidate.externalId
    || typeof candidate.authorHandle !== 'string'
    || !candidate.authorHandle
    || typeof candidate.text !== 'string'
    || (
      kind !== 'freeform-reply'
      && candidate.text.trim().length === 0
    )
    || (
      candidate.permalink !== undefined
      && (
        typeof candidate.permalink !== 'string'
        || !isHttpUrl(candidate.permalink)
      )
    )
  ) {
    return 'invalid'
  }
  return {
    kind,
    candidate: {
      platform: candidate.platform,
      externalId: candidate.externalId.slice(0, 300),
      authorHandle: candidate.authorHandle.slice(0, 200),
      text: candidate.text.slice(0, 8_000),
      ...(typeof candidate.permalink === 'string'
        ? { permalink: candidate.permalink.slice(0, 2_048) }
        : {}),
    },
  }
}

export function parseContentDraftBody(value: unknown):
  | {
      text: string
      platform: ContentPlanningPlatform
      imageBrief?: string
      media?: PostMedia[]
      topicTag?: string
      postFormat?: 'post' | 'thread' | 'article'
      threadSegments?: string[]
      article?: {
        sourceUrl: string
        title: string
        description: string
      }
      reply?: {
        externalId: string
        authorHandle: string
        text?: string
        permalink?: string
      }
    }
  | 'invalid' {
  if (
    !isRecord(value)
    || typeof value.text !== 'string'
    || !value.text.trim()
    || value.text.length > 10_000
    || !isContentPlanningPlatform(value.platform)
  ) {
    return 'invalid'
  }
  const postFormat = value.postFormat === 'thread' || value.postFormat === 'article'
    ? value.postFormat
    : 'post'
  if (postFormat === 'thread') {
    if (
      value.platform !== 'twitter'
      || !Array.isArray(value.threadSegments)
      || value.threadSegments.length < 2
      || value.threadSegments.length > 25
      || value.threadSegments.some(
        (part) => typeof part !== 'string' || !part.trim() || xWeightedLength(part) > 280,
      )
    ) return 'invalid'
  }
  let article: { sourceUrl: string; title: string; description: string } | undefined
  if (postFormat === 'article') {
    if (
      value.platform !== 'linkedin'
      || !isRecord(value.article)
      || typeof value.article.sourceUrl !== 'string'
      || !isHttpUrl(value.article.sourceUrl)
      || typeof value.article.title !== 'string'
      || !value.article.title.trim()
      || typeof value.article.description !== 'string'
    ) return 'invalid'
    article = {
      sourceUrl: value.article.sourceUrl.slice(0, 2_048),
      title: value.article.title.trim().slice(0, 300),
      description: value.article.description.trim().slice(0, 1_000),
    }
  }
  if (
    value.imageBrief !== undefined
    && (typeof value.imageBrief !== 'string' || value.imageBrief.length > 2_000)
  ) {
    return 'invalid'
  }
  const media = parsePostMedia(value.media)
  if (!media.ok) return 'invalid'
  if (
    value.topicTag !== undefined
    && (typeof value.topicTag !== 'string' || value.topicTag.length > 200)
  ) {
    return 'invalid'
  }
  let reply: {
    externalId: string
    authorHandle: string
    text?: string
    permalink?: string
  } | undefined
  if (value.reply !== undefined) {
    if (
      !isRecord(value.reply)
      || typeof value.reply.externalId !== 'string'
      || !value.reply.externalId
      || typeof value.reply.authorHandle !== 'string'
      || !value.reply.authorHandle
      || (
        value.reply.text !== undefined
        && typeof value.reply.text !== 'string'
      )
      || (
        value.reply.permalink !== undefined
        && (
          typeof value.reply.permalink !== 'string'
          || !isHttpUrl(value.reply.permalink)
        )
      )
    ) {
      return 'invalid'
    }
    reply = {
      externalId: value.reply.externalId.slice(0, 300),
      authorHandle: value.reply.authorHandle.slice(0, 200),
      ...(typeof value.reply.text === 'string'
        ? { text: value.reply.text.slice(0, 8_000) }
        : {}),
      ...(typeof value.reply.permalink === 'string'
        ? { permalink: value.reply.permalink.slice(0, 2_048) }
        : {}),
    }
  }
  return {
    text: value.text.trim(),
    platform: value.platform,
    media: media.media,
    ...(typeof value.imageBrief === 'string' && value.imageBrief.trim()
      ? { imageBrief: value.imageBrief.trim() }
      : {}),
    ...(typeof value.topicTag === 'string' && value.topicTag.trim()
      ? { topicTag: value.topicTag.trim() }
      : {}),
    ...(reply ? { reply } : {}),
    postFormat,
    ...(postFormat === 'thread'
      ? { threadSegments: (value.threadSegments as string[]).map((part) => part.trim()) }
      : {}),
    ...(article ? { article } : {}),
  }
}

function toSavedDraftWire(draft: SavedContentDraft) {
  return {
    id: draft.id,
    platform: draft.platform,
    platformReplyId: draft.replyExternalId,
    draftText: draft.draftText,
    postedText:
      draft.status === 'posted'
        ? draft.finalText ?? draft.draftText
        : null,
    postedMediaId: null,
    postedPermalink: draft.postedPermalink,
    replyAuthor: draft.replyAuthor,
    replyText: draft.replyText,
    status: draft.status,
    createdAt: draft.createdAt,
    resolvedAt: draft.resolvedAt,
    postFormat: draft.postFormat,
    ...(Array.isArray(draft.formatData.threadSegments)
      ? { threadSegments: draft.formatData.threadSegments }
      : {}),
    ...(isRecord(draft.formatData.article)
      ? { article: draft.formatData.article }
      : {}),
  }
}

function toApprovalWire(draft: SavedContentDraft) {
  return {
    id: draft.id,
    assistantId: draft.assistantId,
    platform: draft.platform,
    eventType: 'drafted',
    metadata: {
      draftText: draft.draftText,
      text: draft.draftText,
      replyAuthor: draft.replyAuthor ?? undefined,
      replyText: draft.replyText ?? undefined,
      replyPermalink: draft.replyPermalink ?? undefined,
      sessionId: draft.sessionId,
      imageBrief: draft.imageBrief ?? undefined,
      postFormat: draft.postFormat,
      ...draft.formatData,
    },
    createdAt: draft.createdAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Mirror X's published weighted-length rules at the HTTP boundary: links
 * count as 23 and Unicode ranges use the platform's one/two-weight model.
 */
function xWeightedLength(text: string): number {
  let count = 0
  let cursor = 0
  for (const match of text.matchAll(/https?:\/\/[^\s]+/gu)) {
    const index = match.index ?? cursor
    count += weightedXCodePoints(text.slice(cursor, index))
    count += 23
    cursor = index + match[0].length
  }
  return count + weightedXCodePoints(text.slice(cursor))
}

function weightedXCodePoints(text: string): number {
  let count = 0
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0
    const single =
      (point >= 0 && point <= 4_351)
      || (point >= 8_192 && point <= 8_205)
      || (point >= 8_208 && point <= 8_223)
      || (point >= 8_242 && point <= 8_247)
    count += single ? 1 : 2
  }
  return count
}
