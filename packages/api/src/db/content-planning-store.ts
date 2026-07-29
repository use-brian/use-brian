/**
 * Open, provider-independent content-planning persistence.
 *
 * [COMP:feed/content-planning-store]
 */

import { randomUUID } from 'node:crypto'
import { query } from './client.js'
import { addSessionMessage } from './sessions.js'

export const CONTENT_PLANNING_PLATFORMS = [
  'instagram',
  'threads',
  'twitter',
  'xhs',
] as const

export type ContentPlanningPlatform = (typeof CONTENT_PLANNING_PLATFORMS)[number]
export type ContentDraftStatus = 'pending' | 'ready' | 'posted' | 'rejected'
export type ContentDraftSeedKind =
  | 'inspiration-reply'
  | 'inspiration-original'
  | 'freeform'
  | 'freeform-reply'

export type ContentDraftSeed = {
  kind: ContentDraftSeedKind
  link?: string
  candidate?: {
    platform: ContentPlanningPlatform
    externalId: string
    authorHandle: string
    text: string
    permalink?: string
  }
}

export type ContentDraftSessionSummary = {
  id: string
  platform: ContentPlanningPlatform
  title: string
  startedBy: { id: string; name: string | null }
  createdAt: Date
  lastActiveAt: Date
  preview: string | null
  replyTarget: {
    authorHandle: string
    text: string
    permalink: string | null
  } | null
  draftText: string | null
  selectedDraft: { text: string; status: ContentDraftStatus } | null
  draftCounts: {
    pending: number
    ready: number
    posted: number
    rejected: number
    deleted: number
  }
  seedKind: ContentDraftSeedKind | null
}

export type SavedContentDraft = {
  id: string
  assistantId: string
  sessionId: string
  platform: ContentPlanningPlatform
  draftText: string
  finalText: string | null
  imageBrief: string | null
  topicTag: string | null
  replyExternalId: string | null
  replyAuthor: string | null
  replyText: string | null
  replyPermalink: string | null
  status: ContentDraftStatus
  createdBy: string | null
  resolvedBy: string | null
  createdAt: Date
  resolvedAt: Date | null
  postedPermalink: string | null
}

const TITLE_PREFIX: Record<ContentPlanningPlatform, string> = {
  instagram: '[instagram]',
  threads: '[threads]',
  twitter: '[twitter]',
  xhs: '[xhs]',
}

const SEED_BODY_RE =
  /(?:draft a reply to this|post that caught my eye, by) [^\n]+ by @([^:\n]+):\n\n> ([\s\S]*?)(?:\n\nSource:|\n\nPlease|\n\nUse it|$)/i
const SEED_SOURCE_RE = /\n\nSource: (https?:\/\/\S+)/i

export function isContentPlanningPlatform(
  value: unknown,
): value is ContentPlanningPlatform {
  return typeof value === 'string'
    && (CONTENT_PLANNING_PLATFORMS as readonly string[]).includes(value)
}

/**
 * A session title guaranteed to carry its platform prefix. An untitled
 * session falls back to the platform default; a titled one is prefixed unless
 * it already carries a known prefix (so re-titling stays idempotent).
 */
export function withPlatformTitlePrefix(
  platform: ContentPlanningPlatform,
  title: string | null | undefined,
  seed?: ContentDraftSeed,
): string {
  const trimmed = title?.trim()
  if (!trimmed) return defaultContentDraftTitle(platform, seed)
  if (getContentDraftTitlePrefix(trimmed)) return trimmed
  return `${TITLE_PREFIX[platform]} ${trimmed}`
}

export function defaultContentDraftTitle(
  platform: ContentPlanningPlatform,
  seed?: ContentDraftSeed,
): string {
  const prefix = TITLE_PREFIX[platform]
  if (
    (seed?.kind === 'inspiration-reply' || seed?.kind === 'freeform-reply')
    && seed.candidate
  ) {
    return `${prefix} Reply to @${seed.candidate.authorHandle}`
  }
  if (seed?.kind === 'inspiration-original' && seed.candidate) {
    return `${prefix} Inspired by @${seed.candidate.authorHandle}`
  }
  if (seed?.kind === 'freeform' && seed.link) {
    try {
      return `${prefix} From ${new URL(seed.link).hostname.replace(/^www\./, '')}`
    } catch {
      // The route validates the URL. Keep this helper total for callers/tests.
    }
  }
  return `${prefix} New draft`
}

const DEFAULT_TITLE_RE =
  /^\[(instagram|threads|twitter|xhs)\] (New draft|New Chat|Reply to @\S+|Inspired by @\S+|From \S+)$/

export function isDefaultContentDraftTitle(
  title: string | null | undefined,
): boolean {
  return !!title && DEFAULT_TITLE_RE.test(title)
}

export function getContentDraftTitlePrefix(
  title: string | null | undefined,
): string | null {
  if (!title) return null
  for (const prefix of Object.values(TITLE_PREFIX)) {
    if (title === prefix || title.startsWith(`${prefix} `)) return prefix
  }
  return null
}

export function platformFromContentDraftTitle(
  title: string | null | undefined,
): ContentPlanningPlatform {
  if (title) {
    for (const platform of CONTENT_PLANNING_PLATFORMS) {
      if (title.startsWith(TITLE_PREFIX[platform])) return platform
    }
  }
  return 'threads'
}

export function seedFirstContentDraftMessage(seed: ContentDraftSeed): string | null {
  if (seed.kind === 'freeform') {
    return seed.link ? `Draft posts from this link: ${seed.link}` : null
  }
  const candidate = seed.candidate
  if (!candidate) return null
  const source = candidate.permalink ? `\n\nSource: ${candidate.permalink}` : ''
  if (seed.kind === 'inspiration-original') {
    return `Here's a ${candidate.platform} post that caught my eye, by @${candidate.authorHandle}:\n\n> ${candidate.text}${source}\n\nUse it as inspiration to draft an original post for our account.`
  }
  return `I want to draft a reply to this ${candidate.platform} post by @${candidate.authorHandle}:\n\n> ${candidate.text}${source}\n\nPlease draft a reply that fits our voice.`
}

export function parseContentDraftReplyTarget(
  firstUserMessage: string | null,
): ContentDraftSessionSummary['replyTarget'] {
  if (!firstUserMessage) return null
  const body = firstUserMessage.match(SEED_BODY_RE)
  if (!body) return null
  return {
    authorHandle: body[1],
    text: body[2].trim(),
    permalink: firstUserMessage.match(SEED_SOURCE_RE)?.[1] ?? null,
  }
}

function mapDraftRow(row: {
  id: string
  assistantId: string
  sessionId: string
  platform: ContentPlanningPlatform
  draftText: string
  finalText: string | null
  imageBrief: string | null
  topicTag: string | null
  replyExternalId: string | null
  replyAuthor: string | null
  replyText: string | null
  replyPermalink: string | null
  status: ContentDraftStatus
  createdBy: string | null
  resolvedBy: string | null
  createdAt: Date
  resolvedAt: Date | null
  postedPermalink: string | null
}): SavedContentDraft {
  return row
}

export interface ContentPlanningStore {
  createSession(params: {
    assistantId: string
    userId: string
    platform: ContentPlanningPlatform
    title?: string
    seed?: ContentDraftSeed
  }): Promise<ContentDraftSessionSummary>
  listSessions(params: {
    assistantId: string
    platform?: ContentPlanningPlatform
  }): Promise<ContentDraftSessionSummary[]>
  sessionExists(assistantId: string, sessionId: string): Promise<boolean>
  discardSession(params: {
    assistantId: string
    sessionId: string
    userId: string
    allowAnyone: boolean
  }): Promise<boolean>
  saveDraft(params: {
    assistantId: string
    sessionId: string
    userId: string
    platform: ContentPlanningPlatform
    text: string
    imageBrief?: string
    topicTag?: string
    reply?: {
      externalId: string
      authorHandle: string
      text?: string
      permalink?: string
    }
  }): Promise<SavedContentDraft>
  listSessionDrafts(assistantId: string, sessionId: string): Promise<SavedContentDraft[]>
  listPending(assistantId: string, limit: number): Promise<SavedContentDraft[]>
  listReady(assistantId: string): Promise<SavedContentDraft[]>
  approve(params: {
    assistantId: string
    draftId: string
    userId: string
    finalText?: string
  }): Promise<boolean>
  reject(params: {
    assistantId: string
    draftId: string
    userId: string
  }): Promise<boolean>
  markPosted(params: {
    assistantId: string
    draftId: string
    userId: string
    permalink?: string
  }): Promise<boolean>
  discardReady(params: {
    assistantId: string
    draftId: string
    userId: string
  }): Promise<boolean>
  removeDraft(params: {
    assistantId: string
    draftId: string
    userId: string
  }): Promise<boolean>
}

export function createContentPlanningStore(): ContentPlanningStore {
  return {
    async createSession(params) {
      const channelId = `draft:${randomUUID()}`
      // The platform lives in the TITLE PREFIX (`platformFromContentDraftTitle`
      // is how `listSessions` filters), so a caller-supplied title must carry
      // one or the session becomes invisible to every platform-scoped query.
      // Enforced here, at the one chokepoint, rather than trusting each
      // caller to remember: a plan slot's "Launch recap" silently vanished
      // from the Threads list exactly this way.
      const title = withPlatformTitlePrefix(
        params.platform,
        params.title,
        params.seed,
      )
      const seedKind = params.seed?.kind ?? 'freeform'
      const result = await query<{
        id: string
        createdAt: Date
        lastActiveAt: Date
        starterId: string
        starterName: string | null
      }>(
        `WITH inserted AS (
           INSERT INTO sessions (
             assistant_id, user_id, channel_type, channel_id, title, mode,
             seed_kind, visibility, workspace_id
           )
           SELECT $1, $2, 'web', $3, $4, 'draft', $5, 'workspace', a.workspace_id
             FROM assistants a
            WHERE a.id = $1
           RETURNING id, user_id, created_at, last_active_at
         )
         SELECT i.id,
                i.created_at AS "createdAt",
                i.last_active_at AS "lastActiveAt",
                i.user_id::text AS "starterId",
                u.name AS "starterName"
           FROM inserted i
           LEFT JOIN users u ON u.id = i.user_id`,
        [params.assistantId, params.userId, channelId, title, seedKind],
      )
      const row = result.rows[0]
      if (!row) throw new Error('assistant not found')

      const seededMessage = params.seed
        ? seedFirstContentDraftMessage(params.seed)
        : null
      if (seededMessage) {
        await addSessionMessage({
          sessionId: row.id,
          role: 'user',
          content: [{ type: 'text', text: seededMessage }],
          senderUserId: params.userId,
        })
      }
      return {
        id: row.id,
        platform: params.platform,
        title,
        startedBy: { id: row.starterId, name: row.starterName },
        createdAt: row.createdAt,
        lastActiveAt: row.lastActiveAt,
        preview: seededMessage,
        replyTarget:
          seedKind === 'inspiration-reply' || seedKind === 'freeform-reply'
            ? parseContentDraftReplyTarget(seededMessage)
            : null,
        draftText: null,
        selectedDraft: null,
        draftCounts: {
          pending: 0,
          ready: 0,
          posted: 0,
          rejected: 0,
          deleted: 0,
        },
        seedKind,
      }
    },

    async listSessions(params) {
      const result = await query<{
        id: string
        title: string | null
        starterId: string
        starterName: string | null
        createdAt: Date
        lastActiveAt: Date
        seedKind: ContentDraftSeedKind | null
        preview: string | null
        firstUserMessage: string | null
        selectedText: string | null
        selectedStatus: ContentDraftStatus | null
        pendingCount: string
        readyCount: string
        postedCount: string
        rejectedCount: string
      }>(
        `SELECT s.id,
                s.title,
                s.user_id::text AS "starterId",
                u.name AS "starterName",
                s.created_at AS "createdAt",
                s.last_active_at AS "lastActiveAt",
                s.seed_kind AS "seedKind",
                latest.text AS preview,
                first_user.text AS "firstUserMessage",
                selected.text AS "selectedText",
                selected.status AS "selectedStatus",
                COALESCE(counts.pending, 0)::text AS "pendingCount",
                COALESCE(counts.ready, 0)::text AS "readyCount",
                COALESCE(counts.posted, 0)::text AS "postedCount",
                COALESCE(counts.rejected, 0)::text AS "rejectedCount"
           FROM sessions s
           LEFT JOIN users u ON u.id = s.user_id
           LEFT JOIN LATERAL (
             SELECT sm.content #>> '{0,text}' AS text
               FROM session_messages sm
              WHERE sm.session_id = s.id
              ORDER BY sm.sequence_num DESC
              LIMIT 1
           ) latest ON true
           LEFT JOIN LATERAL (
             SELECT sm.content #>> '{0,text}' AS text
               FROM session_messages sm
              WHERE sm.session_id = s.id AND sm.role = 'user'
              ORDER BY sm.sequence_num
              LIMIT 1
           ) first_user ON true
           LEFT JOIN LATERAL (
             SELECT COALESCE(d.final_text, d.draft_text) AS text, d.status
               FROM content_planning_drafts d
              WHERE d.session_id = s.id AND d.removed_at IS NULL
              ORDER BY CASE d.status
                         WHEN 'pending' THEN 0
                         WHEN 'ready' THEN 1
                         WHEN 'posted' THEN 2
                         ELSE 3
                       END,
                       d.created_at DESC
              LIMIT 1
           ) selected ON true
           LEFT JOIN LATERAL (
             SELECT count(*) FILTER (WHERE d.status = 'pending') AS pending,
                    count(*) FILTER (WHERE d.status = 'ready') AS ready,
                    count(*) FILTER (WHERE d.status = 'posted') AS posted,
                    count(*) FILTER (WHERE d.status = 'rejected') AS rejected
               FROM content_planning_drafts d
              WHERE d.session_id = s.id AND d.removed_at IS NULL
           ) counts ON true
          WHERE s.assistant_id = $1
            AND s.mode = 'draft'
            AND ($2::text IS NULL OR s.title LIKE '[' || $2 || ']%')
          ORDER BY s.last_active_at DESC`,
        [params.assistantId, params.platform ?? null],
      )
      return result.rows.map((row) => {
        const platform = platformFromContentDraftTitle(row.title)
        return {
          id: row.id,
          platform,
          title: row.title ?? defaultContentDraftTitle(platform),
          startedBy: { id: row.starterId, name: row.starterName },
          createdAt: row.createdAt,
          lastActiveAt: row.lastActiveAt,
          seedKind: row.seedKind,
          preview: row.preview,
          replyTarget:
            row.seedKind === 'inspiration-reply' || row.seedKind === 'freeform-reply'
              ? parseContentDraftReplyTarget(row.firstUserMessage)
              : null,
          draftText: null,
          selectedDraft:
            row.selectedText && row.selectedStatus
              ? { text: row.selectedText, status: row.selectedStatus }
              : null,
          draftCounts: {
            pending: Number(row.pendingCount),
            ready: Number(row.readyCount),
            posted: Number(row.postedCount),
            rejected: Number(row.rejectedCount),
            deleted: 0,
          },
        }
      })
    },

    async sessionExists(assistantId, sessionId) {
      const result = await query(
        `SELECT 1 FROM sessions
          WHERE id = $1 AND assistant_id = $2 AND mode = 'draft'`,
        [sessionId, assistantId],
      )
      return result.rows.length > 0
    },

    async discardSession(params) {
      const result = await query(
        `DELETE FROM sessions
          WHERE id = $1
            AND assistant_id = $4
            AND mode = 'draft'
            AND ($3::boolean OR user_id = $2)
          RETURNING id`,
        [
          params.sessionId,
          params.userId,
          params.allowAnyone,
          params.assistantId,
        ],
      )
      return result.rows.length > 0
    },

    async saveDraft(params) {
      const result = await query<Parameters<typeof mapDraftRow>[0]>(
        `INSERT INTO content_planning_drafts (
           assistant_id, session_id, platform, draft_text, image_brief,
           topic_tag, reply_external_id, reply_author, reply_text,
           reply_permalink, created_by
         )
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
           FROM sessions s
          WHERE s.id = $2
            AND s.assistant_id = $1
            AND s.mode = 'draft'
         RETURNING id,
                   assistant_id::text AS "assistantId",
                   session_id::text AS "sessionId",
                   platform,
                   draft_text AS "draftText",
                   final_text AS "finalText",
                   image_brief AS "imageBrief",
                   topic_tag AS "topicTag",
                   reply_external_id AS "replyExternalId",
                   reply_author AS "replyAuthor",
                   reply_text AS "replyText",
                   reply_permalink AS "replyPermalink",
                   status,
                   created_by::text AS "createdBy",
                   resolved_by::text AS "resolvedBy",
                   created_at AS "createdAt",
                   resolved_at AS "resolvedAt",
                   posted_permalink AS "postedPermalink"`,
        [
          params.assistantId,
          params.sessionId,
          params.platform,
          params.text,
          params.imageBrief ?? null,
          params.topicTag ?? null,
          params.reply?.externalId ?? null,
          params.reply?.authorHandle ?? null,
          params.reply?.text ?? null,
          params.reply?.permalink ?? null,
          params.userId,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('draft session not found')
      return mapDraftRow(row)
    },

    async listSessionDrafts(assistantId, sessionId) {
      const result = await query<Parameters<typeof mapDraftRow>[0]>(
        `${DRAFT_SELECT}
          WHERE d.assistant_id = $1
            AND d.session_id = $2
            AND d.removed_at IS NULL
          ORDER BY d.created_at`,
        [assistantId, sessionId],
      )
      return result.rows.map(mapDraftRow)
    },

    async listPending(assistantId, limit) {
      const result = await query<Parameters<typeof mapDraftRow>[0]>(
        `${DRAFT_SELECT}
          WHERE d.assistant_id = $1
            AND d.status = 'pending'
            AND d.removed_at IS NULL
          ORDER BY d.created_at DESC
          LIMIT $2`,
        [assistantId, limit],
      )
      return result.rows.map(mapDraftRow)
    },

    async listReady(assistantId) {
      const result = await query<Parameters<typeof mapDraftRow>[0]>(
        `${DRAFT_SELECT}
          WHERE d.assistant_id = $1
            AND d.status = 'ready'
            AND d.removed_at IS NULL
          ORDER BY d.created_at DESC`,
        [assistantId],
      )
      return result.rows.map(mapDraftRow)
    },

    async approve(params) {
      return updateDraftStatus({
        assistantId: params.assistantId,
        draftId: params.draftId,
        userId: params.userId,
        from: 'pending',
        to: 'ready',
        finalText: params.finalText,
      })
    },

    async reject(params) {
      return updateDraftStatus({
        assistantId: params.assistantId,
        draftId: params.draftId,
        userId: params.userId,
        from: 'pending',
        to: 'rejected',
      })
    },

    async markPosted(params) {
      const result = await query(
        `UPDATE content_planning_drafts
            SET status = 'posted',
                posted_permalink = $4,
                resolved_by = $3,
                resolved_at = now(),
                updated_at = now()
          WHERE id = $1
            AND assistant_id = $2
            AND status = 'ready'
            AND removed_at IS NULL
          RETURNING id`,
        [params.draftId, params.assistantId, params.userId, params.permalink ?? null],
      )
      return result.rows.length > 0
    },

    async discardReady(params) {
      return updateDraftStatus({
        assistantId: params.assistantId,
        draftId: params.draftId,
        userId: params.userId,
        from: 'ready',
        to: 'rejected',
      })
    },

    async removeDraft(params) {
      const result = await query(
        `UPDATE content_planning_drafts
            SET removed_at = now(),
                resolved_by = $3,
                updated_at = now()
          WHERE id = $1 AND assistant_id = $2 AND removed_at IS NULL
          RETURNING id`,
        [params.draftId, params.assistantId, params.userId],
      )
      return result.rows.length > 0
    },
  }
}

const DRAFT_SELECT = `
  SELECT d.id,
         d.assistant_id::text AS "assistantId",
         d.session_id::text AS "sessionId",
         d.platform,
         d.draft_text AS "draftText",
         d.final_text AS "finalText",
         d.image_brief AS "imageBrief",
         d.topic_tag AS "topicTag",
         d.reply_external_id AS "replyExternalId",
         d.reply_author AS "replyAuthor",
         d.reply_text AS "replyText",
         d.reply_permalink AS "replyPermalink",
         d.status,
         d.created_by::text AS "createdBy",
         d.resolved_by::text AS "resolvedBy",
         d.created_at AS "createdAt",
         d.resolved_at AS "resolvedAt",
         d.posted_permalink AS "postedPermalink"
    FROM content_planning_drafts d`

async function updateDraftStatus(params: {
  assistantId: string
  draftId: string
  userId: string
  from: ContentDraftStatus
  to: ContentDraftStatus
  finalText?: string
}): Promise<boolean> {
  const result = await query(
    `UPDATE content_planning_drafts
        SET status = $5,
            final_text = CASE
              WHEN $6::text IS NOT NULL THEN $6
              WHEN $5 = 'ready' THEN draft_text
              ELSE final_text
            END,
            resolved_by = $3,
            resolved_at = now(),
            updated_at = now()
      WHERE id = $1
        AND assistant_id = $2
        AND status = $4
        AND removed_at IS NULL
      RETURNING id`,
    [
      params.draftId,
      params.assistantId,
      params.userId,
      params.from,
      params.to,
      params.finalText ?? null,
    ],
  )
  return result.rows.length > 0
}
