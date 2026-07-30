/**
 * Idea-backlog persistence: raw, undated jots the operator captures the
 * moment they occur, developed into plan slots or draft sessions later.
 *
 * Open and provider-independent, exactly like `content-plan-store.ts`: an
 * idea needs no credential and no `distribution_profiles` row, so both
 * editions mount it unconditionally.
 *
 * An idea's status is DERIVED from what it is bound to, never stored - the
 * same no-drift rule plan slots follow (feed-revamp.md D7). `ON DELETE SET
 * NULL` on both links means deleting the slot or session an idea became
 * returns the idea to the open backlog rather than silently losing it.
 *
 * Spec: docs/architecture/feed/operator-app.md -> "Ideas backlog".
 * [COMP:feed/content-ideas-store]
 */

import { query } from './client.js'
import type { ContentPlanningPlatform } from './content-planning-store.js'

/** Where an idea came from. `manual` is the rail's quick-add. */
export type IdeaSource = 'manual' | 'chat' | 'inspiration' | 'voice'

export const IDEA_SOURCES: readonly IdeaSource[] = [
  'manual',
  'chat',
  'inspiration',
  'voice',
]

/** Derived at read time; the table stores only the links and `discarded_at`. */
export type IdeaStatus = 'open' | 'promoted' | 'discarded'

export type ContentIdea = {
  id: string
  assistantId: string
  /** The jot itself. */
  text: string
  /** Optional elaboration added later. */
  note: string | null
  /** A leaning, not a commitment - the slot picks the real platform. */
  platformHint: ContentPlanningPlatform | null
  source: IdeaSource
  /** Derived per `deriveIdeaStatus`, never stored. */
  status: IdeaStatus
  slotId: string | null
  sessionId: string | null
  discardedAt: Date | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export function isIdeaSource(value: unknown): value is IdeaSource {
  return (
    typeof value === 'string' && (IDEA_SOURCES as readonly string[]).includes(value)
  )
}

/**
 * The derivation, as one pure function. The SQL `CASE` in `IDEA_SELECT`
 * mirrors it and the unit test pins them together. A binding outranks a
 * discard: promoting an idea is what happened to it, and the links are live
 * foreign keys, so "promoted" is always the truer answer.
 */
export function deriveIdeaStatus(input: {
  hasSlot: boolean
  hasSession: boolean
  discarded: boolean
}): IdeaStatus {
  if (input.hasSlot || input.hasSession) return 'promoted'
  if (input.discarded) return 'discarded'
  return 'open'
}

type IdeaRow = {
  id: string
  assistantId: string
  text: string
  note: string | null
  platformHint: ContentPlanningPlatform | null
  source: IdeaSource
  status: IdeaStatus
  slotId: string | null
  sessionId: string | null
  discardedAt: Date | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

const IDEA_SELECT = `
  SELECT i.id,
         i.assistant_id::text AS "assistantId",
         i.text,
         i.note,
         i.platform_hint AS "platformHint",
         i.source,
         CASE
           WHEN i.slot_id IS NOT NULL OR i.session_id IS NOT NULL THEN 'promoted'
           WHEN i.discarded_at IS NOT NULL THEN 'discarded'
           ELSE 'open'
         END AS status,
         i.slot_id::text AS "slotId",
         i.session_id::text AS "sessionId",
         i.discarded_at AS "discardedAt",
         i.created_by::text AS "createdBy",
         i.created_at AS "createdAt",
         i.updated_at AS "updatedAt"
    FROM content_ideas i`

export interface ContentIdeasStore {
  /** Newest first. `status` filters on the derived value; omit for all. */
  listIdeas(params: {
    assistantId: string
    status?: IdeaStatus
  }): Promise<ContentIdea[]>
  getIdea(assistantId: string, ideaId: string): Promise<ContentIdea | null>
  createIdea(params: {
    assistantId: string
    userId: string
    text: string
    note?: string
    platformHint?: ContentPlanningPlatform
    source?: IdeaSource
  }): Promise<ContentIdea>
  updateIdea(params: {
    assistantId: string
    ideaId: string
    patch: {
      text?: string
      note?: string | null
      platformHint?: ContentPlanningPlatform | null
      /** Bind the slot (or session) the idea became. */
      slotId?: string | null
      sessionId?: string | null
      /** true discards, false restores. */
      discarded?: boolean
    }
  }): Promise<ContentIdea | null>
  deleteIdea(assistantId: string, ideaId: string): Promise<boolean>
}

export function createContentIdeasStore(): ContentIdeasStore {
  return {
    async listIdeas(params) {
      const values: unknown[] = [params.assistantId]
      let where = 'WHERE i.assistant_id = $1'
      if (params.status) {
        values.push(params.status)
        where += ` AND (CASE
           WHEN i.slot_id IS NOT NULL OR i.session_id IS NOT NULL THEN 'promoted'
           WHEN i.discarded_at IS NOT NULL THEN 'discarded'
           ELSE 'open'
         END) = $${values.length}`
      }
      const result = await query<IdeaRow>(
        `${IDEA_SELECT}
          ${where}
          ORDER BY i.created_at DESC`,
        values,
      )
      return result.rows
    },

    async getIdea(assistantId, ideaId) {
      const result = await query<IdeaRow>(
        `${IDEA_SELECT}
          WHERE i.assistant_id = $1 AND i.id = $2`,
        [assistantId, ideaId],
      )
      return result.rows[0] ?? null
    },

    async createIdea(params) {
      const inserted = await query<{ id: string }>(
        `INSERT INTO content_ideas (
           assistant_id, text, note, platform_hint, source, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          params.assistantId,
          params.text,
          params.note ?? null,
          params.platformHint ?? null,
          params.source ?? 'manual',
          params.userId,
        ],
      )
      const idea = await this.getIdea(params.assistantId, inserted.rows[0].id)
      if (!idea) throw new Error('content idea vanished after insert')
      return idea
    },

    async updateIdea(params) {
      const sets: string[] = []
      const values: unknown[] = [params.assistantId, params.ideaId]
      const push = (fragment: string, value: unknown) => {
        values.push(value)
        sets.push(`${fragment} = $${values.length}`)
      }
      const { patch } = params
      if (patch.text !== undefined) push('text', patch.text)
      if (patch.note !== undefined) push('note', patch.note)
      if (patch.platformHint !== undefined) push('platform_hint', patch.platformHint)
      if (patch.slotId !== undefined) push('slot_id', patch.slotId)
      if (patch.sessionId !== undefined) push('session_id', patch.sessionId)
      if (patch.discarded !== undefined) {
        sets.push(`discarded_at = ${patch.discarded ? 'now()' : 'NULL'}`)
      }
      if (sets.length === 0) return this.getIdea(params.assistantId, params.ideaId)

      const result = await query<{ id: string }>(
        `UPDATE content_ideas
            SET ${sets.join(', ')}, updated_at = now()
          WHERE assistant_id = $1 AND id = $2
          RETURNING id`,
        values,
      )
      if (result.rows.length === 0) return null
      return this.getIdea(params.assistantId, params.ideaId)
    },

    async deleteIdea(assistantId, ideaId) {
      const result = await query(
        `DELETE FROM content_ideas
          WHERE assistant_id = $1 AND id = $2
          RETURNING id`,
        [assistantId, ideaId],
      )
      return result.rows.length > 0
    },
  }
}
