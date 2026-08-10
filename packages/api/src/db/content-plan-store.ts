/**
 * Marketing-plan persistence: dated plan slots and the month brief they
 * belong to.
 *
 * Open and provider-independent, exactly like `content-planning-store.ts`.
 * A slot needs no credential and no `distribution_profiles` row, which is
 * the test `docs/architecture/feed/operator-app.md` sets for the Create half
 * of the surface, so both editions mount it (docs/plans/feed-revamp.md D10).
 *
 * Spec: docs/plans/feed-revamp.md §4/§5.
 * [COMP:feed/content-plan-store]
 */

import { query } from './client.js'
import type { PostMedia } from './content-planning-store.js'
import {
  CONTENT_PLANNING_PLATFORMS,
  type ContentPlanningPlatform,
} from './content-planning-store.js'

/**
 * What the operator can mark a slot by hand. Everything else about a slot's
 * state is derived from what it is bound to, never stored (D7) - so a slot
 * and its draft cannot drift.
 */
export type { PostMedia } from './content-planning-store.js'

export type PlanSlotMark = 'planned' | 'skipped'

/** The status a caller reads. `PlanSlotMark` plus the derived states. */
export type PlanSlotStatus = PlanSlotMark | 'drafting' | 'ready' | 'posted'

export const PLAN_SLOT_STATUSES: readonly PlanSlotStatus[] = [
  'planned',
  'drafting',
  'ready',
  'posted',
  'skipped',
]

export type PlanSlot = {
  id: string
  assistantId: string
  platform: ContentPlanningPlatform
  /** `YYYY-MM-DD`. A calendar plans days, not instants (§4). */
  scheduledFor: string
  /**
   * Minutes past LOCAL midnight, or null for "that day, no time"
   * (feed-revamp-depth D26). Deliberately not a timestamp: `scheduledFor`
   * remains the sole authority for which day, so nothing here can shift a slot
   * across a day boundary. It is a label a human reads before posting by hand;
   * nothing schedules from it.
   */
  scheduledMinute: number | null
  title: string
  brief: string | null
  /** Media on the bound draft, projected for the calendar chip thumbnail. */
  media: PostMedia[]
  /** Derived per §5 - not the stored `slot_status` column. */
  status: PlanSlotStatus
  draftId: string | null
  sessionId: string | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * The sticky channel the plan conversation lives on, mirroring the tuning
 * chat's `channel_id='tuning'`: one row per (assistant, operator), so the
 * conversation resumes wherever they open the Plan.
 */
export const PLAN_CHANNEL_ID = 'plan'

export type PlanBrief = {
  assistantId: string
  /** `YYYY-MM-01`. */
  monthStart: string
  brief: string
  themes: string[]
  /**
   * Posts per week this month's plan intends, or null. An integer rather than
   * prose so the calendar's dashed gap ghosts are derivable in a pure client
   * function (feed-revamp-depth D28). Drives no engine and creates nothing.
   */
  cadencePerWeek: number | null
  updatedBy: string | null
  updatedAt: Date | null
}

/**
 * `YYYY-MM` -> the month's first and next-first day as `YYYY-MM-DD`, or null
 * when the input is not a real month. Pure; the route validates with it.
 */
export function parseMonthRange(
  month: string,
): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return null
  const year = Number(m[1])
  const monthIndex = Number(m[2])
  if (monthIndex < 1 || monthIndex > 12) return null
  const nextYear = monthIndex === 12 ? year + 1 : year
  const nextMonth = monthIndex === 12 ? 1 : monthIndex + 1
  return {
    start: `${m[1]}-${m[2]}-01`,
    end: `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`,
  }
}

/** `YYYY-MM-DD` for a real calendar day, else null. Pure. */
export function parseIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    return null
  }
  return value
}

export function isContentPlanPlatform(
  value: unknown,
): value is ContentPlanningPlatform {
  return typeof value === 'string'
    && (CONTENT_PLANNING_PLATFORMS as readonly string[]).includes(value)
}

export function isPlanSlotMark(value: unknown): value is PlanSlotMark {
  return value === 'planned' || value === 'skipped'
}

/**
 * The §5 derivation, as one pure function. The SQL `CASE` in
 * `SLOT_SELECT` mirrors it and the shared unit test pins them together;
 * app-web imports the same rule so a chip never disagrees with the server.
 */
export function deriveSlotStatus(input: {
  mark: PlanSlotMark
  draftStatus: 'pending' | 'ready' | 'posted' | 'rejected' | null
  hasSession: boolean
}): PlanSlotStatus {
  if (input.draftStatus) {
    switch (input.draftStatus) {
      case 'pending':
        return 'drafting'
      case 'ready':
        return 'ready'
      case 'posted':
        return 'posted'
      // A rejected draft leaves the day still needing content.
      case 'rejected':
        return 'planned'
    }
  }
  if (input.hasSession) return 'drafting'
  return input.mark
}

type SlotRow = {
  id: string
  assistantId: string
  platform: ContentPlanningPlatform
  scheduledFor: string
  scheduledMinute: number | null
  title: string
  brief: string | null
  media: PostMedia[]
  status: PlanSlotStatus
  draftId: string | null
  sessionId: string | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * The derived-status projection (§5). `to_char` keeps `scheduled_for` a
 * calendar day on the wire - `date` would otherwise arrive as a local-midnight
 * Date and shift a day for operators west of UTC.
 */
const SLOT_SELECT = `
  SELECT s.id,
         s.assistant_id::text AS "assistantId",
         s.platform,
         to_char(s.scheduled_for, 'YYYY-MM-DD') AS "scheduledFor",
         s.scheduled_minute AS "scheduledMinute",
         s.title,
         s.brief,
         COALESCE(d.media, '[]'::jsonb) AS media,
         CASE
           WHEN d.status = 'pending'  THEN 'drafting'
           WHEN d.status = 'ready'    THEN 'ready'
           WHEN d.status = 'posted'   THEN 'posted'
           WHEN d.status = 'rejected' THEN 'planned'
           WHEN s.session_id IS NOT NULL THEN 'drafting'
           ELSE s.slot_status
         END AS status,
         s.draft_id::text AS "draftId",
         s.session_id::text AS "sessionId",
         s.created_by::text AS "createdBy",
         s.created_at AS "createdAt",
         s.updated_at AS "updatedAt"
    FROM content_plan_slots s
    LEFT JOIN content_planning_drafts d
      ON d.id = s.draft_id AND d.removed_at IS NULL`

export interface ContentPlanStore {
  listSlots(params: {
    assistantId: string
    /** `YYYY-MM`. */
    month: string
  }): Promise<PlanSlot[]>
  getSlot(assistantId: string, slotId: string): Promise<PlanSlot | null>
  createSlot(params: {
    assistantId: string
    userId: string
    platform: ContentPlanningPlatform
    scheduledFor: string
    scheduledMinute?: number | null
    title: string
    brief?: string
  }): Promise<PlanSlot>
  updateSlot(params: {
    assistantId: string
    slotId: string
    patch: {
      scheduledFor?: string
      scheduledMinute?: number | null
      title?: string
      brief?: string | null
      mark?: PlanSlotMark
      sessionId?: string | null
      draftId?: string | null
    }
  }): Promise<PlanSlot | null>
  deleteSlot(assistantId: string, slotId: string): Promise<boolean>
  /**
   * The operator's sticky plan conversation for this assistant, created on
   * first use. `mode='plan'` is what injects the `proposePlan` cardboard tool
   * and its prompt addendum (feed-revamp.md D9), and the chat route's
   * resume-by-channel path reuses the row rather than creating a mode-less
   * one, so the mode survives every later turn.
   */
  ensurePlanSession(params: {
    assistantId: string
    userId: string
  }): Promise<{ sessionId: string }>
  getBrief(assistantId: string, month: string): Promise<PlanBrief | null>
  upsertBrief(params: {
    assistantId: string
    userId: string
    month: string
    brief: string
    themes: string[]
    cadencePerWeek?: number | null
  }): Promise<PlanBrief>
}

export function createContentPlanStore(): ContentPlanStore {
  return {
    async listSlots(params) {
      const range = parseMonthRange(params.month)
      if (!range) return []
      const result = await query<SlotRow>(
        `${SLOT_SELECT}
          WHERE s.assistant_id = $1
            AND s.scheduled_for >= $2::date
            AND s.scheduled_for < $3::date
          ORDER BY s.scheduled_for, s.created_at`,
        [params.assistantId, range.start, range.end],
      )
      return result.rows
    },

    async getSlot(assistantId, slotId) {
      const result = await query<SlotRow>(
        `${SLOT_SELECT}
          WHERE s.assistant_id = $1 AND s.id = $2`,
        [assistantId, slotId],
      )
      return result.rows[0] ?? null
    },

    async createSlot(params) {
      const inserted = await query<{ id: string }>(
        `INSERT INTO content_plan_slots (
           assistant_id, platform, scheduled_for, scheduled_minute, title, brief, created_by
         )
         VALUES ($1, $2, $3::date, $4, $5, $6, $7)
         RETURNING id`,
        [
          params.assistantId,
          params.platform,
          params.scheduledFor,
          params.scheduledMinute ?? null,
          params.title,
          params.brief ?? null,
          params.userId,
        ],
      )
      const slot = await this.getSlot(params.assistantId, inserted.rows[0].id)
      if (!slot) throw new Error('plan slot vanished after insert')
      return slot
    },

    async updateSlot(params) {
      const sets: string[] = []
      const values: unknown[] = [params.assistantId, params.slotId]
      const push = (fragment: string, value: unknown) => {
        values.push(value)
        sets.push(`${fragment} = $${values.length}`)
      }
      const { patch } = params
      if (patch.scheduledFor !== undefined) {
        values.push(patch.scheduledFor)
        sets.push(`scheduled_for = $${values.length}::date`)
      }
      if (patch.scheduledMinute !== undefined) {
        push('scheduled_minute', patch.scheduledMinute)
      }
      if (patch.title !== undefined) push('title', patch.title)
      if (patch.brief !== undefined) push('brief', patch.brief)
      if (patch.mark !== undefined) push('slot_status', patch.mark)
      if (patch.sessionId !== undefined) push('session_id', patch.sessionId)
      if (patch.draftId !== undefined) push('draft_id', patch.draftId)
      if (sets.length === 0) return this.getSlot(params.assistantId, params.slotId)

      const result = await query<{ id: string }>(
        `UPDATE content_plan_slots
            SET ${sets.join(', ')}, updated_at = now()
          WHERE assistant_id = $1 AND id = $2
          RETURNING id`,
        values,
      )
      if (result.rows.length === 0) return null
      return this.getSlot(params.assistantId, params.slotId)
    },

    async deleteSlot(assistantId, slotId) {
      const result = await query(
        `DELETE FROM content_plan_slots
          WHERE assistant_id = $1 AND id = $2
          RETURNING id`,
        [assistantId, slotId],
      )
      return result.rows.length > 0
    },

    async ensurePlanSession(params) {
      const find = async () => {
        const existing = await query<{ id: string }>(
          `SELECT id
             FROM sessions
            WHERE assistant_id = $1
              AND user_id = $2
              AND channel_type = 'web'
              AND channel_id = $3
            LIMIT 1`,
          [params.assistantId, params.userId, PLAN_CHANNEL_ID],
        )
        return existing.rows[0]?.id ?? null
      }

      const found = await find()
      if (found) return { sessionId: found }

      try {
        const inserted = await query<{ id: string }>(
          `INSERT INTO sessions (
             assistant_id, user_id, channel_type, channel_id, title, mode,
             visibility, workspace_id
           )
           SELECT $1, $2, 'web', $3, 'Marketing plan', 'plan', 'workspace',
                  a.workspace_id
             FROM assistants a
            WHERE a.id = $1
           RETURNING id`,
          [params.assistantId, params.userId, PLAN_CHANNEL_ID],
        )
        const id = inserted.rows[0]?.id
        if (id) return { sessionId: id }
      } catch {
        // Two tabs opening the Plan at once race here. The unique constraint
        // on (assistant_id, user_id, channel_type, channel_id, app_id) makes
        // the loser's insert fail, and re-reading converges both on one row.
      }

      const raced = await find()
      if (!raced) throw new Error('failed to open a plan session')
      return { sessionId: raced }
    },

    async getBrief(assistantId, month) {
      const range = parseMonthRange(month)
      if (!range) return null
      const result = await query<{
        assistantId: string
        monthStart: string
        brief: string
        themes: string[]
        cadencePerWeek: number | null
        updatedBy: string | null
        updatedAt: Date
      }>(
        `SELECT assistant_id::text AS "assistantId",
                to_char(month_start, 'YYYY-MM-DD') AS "monthStart",
                brief,
                themes,
                cadence_per_week AS "cadencePerWeek",
                updated_by::text AS "updatedBy",
                updated_at AS "updatedAt"
           FROM content_plan_briefs
          WHERE assistant_id = $1 AND month_start = $2::date`,
        [assistantId, range.start],
      )
      return result.rows[0] ?? null
    },

    async upsertBrief(params) {
      const range = parseMonthRange(params.month)
      if (!range) throw new Error('invalid month')
      const result = await query<{
        assistantId: string
        monthStart: string
        brief: string
        themes: string[]
        cadencePerWeek: number | null
        updatedBy: string | null
        updatedAt: Date
      }>(
        `INSERT INTO content_plan_briefs (
           assistant_id, month_start, brief, themes, cadence_per_week, updated_by, updated_at
         )
         VALUES ($1, $2::date, $3, $4, $5, $6, now())
         ON CONFLICT (assistant_id, month_start) DO UPDATE
            SET brief = EXCLUDED.brief,
                themes = EXCLUDED.themes,
                cadence_per_week = EXCLUDED.cadence_per_week,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
         RETURNING assistant_id::text AS "assistantId",
                   to_char(month_start, 'YYYY-MM-DD') AS "monthStart",
                   brief,
                   themes,
                   cadence_per_week AS "cadencePerWeek",
                   updated_by::text AS "updatedBy",
                   updated_at AS "updatedAt"`,
        [
          params.assistantId,
          range.start,
          params.brief,
          params.themes,
          params.cadencePerWeek ?? null,
          params.userId,
        ],
      )
      return result.rows[0]
    },
  }
}
