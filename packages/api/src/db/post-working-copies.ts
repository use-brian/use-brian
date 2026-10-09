/** Durable unfinished Feed compositions. [COMP:feed/post-working-copies] */
import { admitAnchoredSession } from '../workspace-access/session-create-admission.js'
import { maxSensitivity } from '@use-brian/core'
import type { CampaignEmailMetadata, FeedComposition, FeedLinkedInContext } from '@use-brian/shared'
import { getPool, query } from './client.js'
import { seedFirstContentDraftMessage, withPlatformTitlePrefix, type ContentPlanningPlatform, type PostMedia } from './content-planning-store.js'

export type PostWorkingContent = {
  /** Server-stamped, monotonic classification of selected source material. */
  sourceSensitivity?: 'public' | 'internal' | 'confidential'
  selectedMemoryIds?: string[]
  sourceCompartments?: string[]
  sourceProjectIds?: string[]
  sourceFileIds?: string[]
  sourceMemoryIds?: string[]
  schemaVersion?: 2
  composition?: FeedComposition
  goalId?: string | null
  reviewMonth?: string
  title: string
  privateBrief: string
  text: string
  textEdited?: boolean
  postFormat: 'post' | 'thread' | 'article'
  threadSegments: string[]
  article: { sourceUrl: string; title: string; description: string }
  /** Present only for the Email channel; revisioned with the composition. */
  linkedin?: FeedLinkedInContext
  email?: CampaignEmailMetadata
  media: PostMedia[]
}
export type PostWorkingCopy = { revision: number; mutationId: string; content: PostWorkingContent }
export type WorkingCopyInput = PostWorkingCopy & { baseTitle?: string; create?: { platform: ContentPlanningPlatform } }
export class WorkingCopyError extends Error {
  constructor(public status: number) { super(`Working copy ${status}`) }
}
export const postWorkingCopiesStore = {
  async get(assistantId: string, sessionId: string): Promise<PostWorkingCopy | null> {
    const result = await query<PostWorkingCopy>(
      `SELECT w.revision, w.mutation_id AS "mutationId", w.content
       FROM feed_post_working_copies w JOIN sessions s ON s.id = w.session_id
       WHERE s.id = $1 AND s.assistant_id = $2 AND s.mode = 'draft' AND feed_draft_audience_allowed(s.id)`,
      [sessionId, assistantId],
    )
    return result.rows[0] ?? null
  },
  async put(assistantId: string, sessionId: string, userId: string, input: WorkingCopyInput): Promise<PostWorkingCopy> {
    input = { ...input, content: structuredClone(input.content) }
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      let created = false
      if (input.create) {
        // Admitted by its anchor (unified-sessions L12) when it is new.
        const exists = (await client.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId])).rows.length > 0
        const admitted = exists ? null : await admitAnchoredSession(client, {
          assistantId, userId, channelType: 'web', channelId: `draft:${sessionId}`,
          anchorKind: 'feed_draft', anchorRef: sessionId,
        })
        const inserted = await client.query(
          `INSERT INTO sessions (id, assistant_id, user_id, channel_type, channel_id,
             title, title_manually_set, mode, seed_kind, visibility, workspace_id,
             anchor_kind, anchor_ref, effective_clearance)
           SELECT $1, a.id, $3, 'web', $4, $5, true, 'draft', 'freeform', 'workspace', a.workspace_id,
             'feed_draft', $1::text, COALESCE($6, a.clearance, 'internal')
           FROM assistants a WHERE a.id = $2
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [sessionId, assistantId, userId, `draft:${sessionId}`,
            withPlatformTitlePrefix(input.create.platform, input.content.title), admitted?.effectiveClearance ?? null],
        )
        created = inserted.rows.length > 0
      }
      // The session exists even before its first working copy. Lock it to
      // serialize first writes, retries, renames and competing devices.
      const session = (await client.query<{ userId: string; title: string }>(
        `SELECT user_id AS "userId", title FROM sessions
         WHERE id = $1 AND assistant_id = $2 AND mode = 'draft' FOR UPDATE`,
        [sessionId, assistantId],
      )).rows[0]
      if (!session) throw new WorkingCopyError(404)
      const previous = (await client.query<PostWorkingCopy>(
        `SELECT revision, mutation_id AS "mutationId", content
         FROM feed_post_working_copies WHERE session_id = $1`, [sessionId],
      )).rows[0]
      if (input.create && !created && (session.userId !== userId || !previous)) {
        throw new WorkingCopyError(409)
      }
      if (previous?.content.schemaVersion === 2 || input.content.schemaVersion === 2) throw new WorkingCopyError(409)
      if (previous?.mutationId === input.mutationId) {
        await client.query('COMMIT')
        return previous
      }
      if ((previous?.revision ?? 0) !== input.revision) throw new WorkingCopyError(409)
      if (!created && !previous && input.baseTitle !== undefined && session.title !== input.baseTitle) {
        throw new WorkingCopyError(409)
      }
      const platformPrefix = session.title.match(/^\[(instagram|threads|twitter|xhs|linkedin|email)\]/)?.[0] ?? '[threads]'
      const oldTitle = session.title.replace(/^\[[^\]]+\]\s*/, '')
      if (previous && input.content.title !== previous.content.title &&
          oldTitle !== previous.content.title && input.content.title !== oldTitle) throw new WorkingCopyError(409)
      if (created) {
        const seed = seedFirstContentDraftMessage({ kind: 'freeform',
          format: input.content.postFormat, brief: input.content.privateBrief })
        if (seed) await client.query(
          `INSERT INTO session_messages (session_id, role, content, sequence_num, sender_user_id)
           VALUES ($1, 'user', $2, 1, $3)`,
          [sessionId, JSON.stringify([{ type: 'text', text: seed }]), userId],
        )
      }
      // Do not rewrite a legacy title just because caption text changed.
      if (!previous || input.content.title !== previous.content.title) {
        await client.query(
          `UPDATE sessions SET title = $2, title_manually_set = true WHERE id = $1`,
          [sessionId, `${platformPrefix} ${input.content.title.trim() || 'New draft'}`],
        )
      }
      input.content = { ...input.content, sourceSensitivity: maxSensitivity(previous?.content.sourceSensitivity ?? 'public', input.content.sourceSensitivity ?? 'public'),
        sourceFileIds: [...new Set([...(previous?.content.sourceFileIds ?? []), ...(input.content.sourceFileIds ?? [])])],
        sourceMemoryIds: [...new Set([...(previous?.content.sourceMemoryIds ?? []), ...(input.content.sourceMemoryIds ?? [])])],
        sourceCompartments: [...new Set([...(previous?.content.sourceCompartments ?? []), ...(input.content.sourceCompartments ?? [])])],
        sourceProjectIds: [...new Set([...(previous?.content.sourceProjectIds ?? []), ...(input.content.sourceProjectIds ?? [])])] }
      const sourceRows = (await client.query<{ sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; project_ids: string[] }>(`SELECT sensitivity,compartments,project_ids FROM workspace_files WHERE workspace_id=(SELECT workspace_id FROM sessions WHERE id=$1) AND id=ANY($2::uuid[])
        UNION ALL SELECT sensitivity,compartments,project_ids FROM memories WHERE workspace_id=(SELECT workspace_id FROM sessions WHERE id=$1) AND id=ANY($3::uuid[])`, [sessionId, input.content.sourceFileIds, input.content.sourceMemoryIds])).rows
      input.content.sourceSensitivity = maxSensitivity(input.content.sourceSensitivity ?? 'public', ...sourceRows.map(row => row.sensitivity))
      input.content.sourceCompartments = [...new Set([...(input.content.sourceCompartments ?? []), ...sourceRows.flatMap(row => row.compartments)])]
      input.content.sourceProjectIds = [...new Set([...(input.content.sourceProjectIds ?? []), ...sourceRows.flatMap(row => row.project_ids)])]
      const copy = { revision: input.revision + 1, mutationId: input.mutationId, content: input.content }
      await client.query(
        `INSERT INTO feed_post_working_copies (session_id, revision, mutation_id, content)
         VALUES ($1, $2, $3, $4) ON CONFLICT (session_id) DO UPDATE
         SET revision = EXCLUDED.revision, mutation_id = EXCLUDED.mutation_id,
             content = EXCLUDED.content, updated_at = now()`,
        [sessionId, copy.revision, copy.mutationId, JSON.stringify(copy.content)],
      )
      if (!(await client.query('SELECT feed_draft_audience_allowed($1) AS allowed', [sessionId])).rows[0]?.allowed) throw new WorkingCopyError(403)
      await client.query('COMMIT')
      return copy
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  },
}
