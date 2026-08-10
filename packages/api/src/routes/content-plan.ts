/**
 * Marketing-plan HTTP surface: dated plan slots and the month brief.
 *
 * Mounted at `/api/distribution` in BOTH editions, unconditionally, before
 * whichever planning router the edition mounts after it. Plan slots carry no
 * provider integration, so they must not join the `/api/distribution` fork
 * that already 404s edition-specific routes (docs/plans/feed-revamp.md §6 and
 * the connector-route-parity anti-pattern in the root CLAUDE.md). Paths this
 * router does not match fall through untouched.
 *
 * [COMP:feed/content-plan-routes]
 */

import { Router, type Response } from 'express'
import {
  createContentPlanStore,
  deriveSlotStatus,
  isContentPlanPlatform,
  isPlanSlotMark,
  parseIsoDate,
  parseMonthRange,
  PLAN_CHANNEL_ID,
  type ContentPlanStore,
} from '../db/content-plan-store.js'
import {
  createContentPlanningStore,
  type ContentPlanningStore,
} from '../db/content-planning-store.js'
import {
  resolvePlanningAccess,
  type PlanningAccessContext,
} from './content-planning.js'

export interface ContentPlanRouteOptions {
  store?: ContentPlanStore
  planningStore?: ContentPlanningStore
  resolveAccess?: (
    userId: string,
    assistantId: string,
  ) => Promise<PlanningAccessContext | null>
}

const MAX_TITLE = 200
const MAX_BRIEF = 4_000
const MAX_THEMES = 12
const MAX_THEME = 80
/** Posts per week, ceiling 21 = 3/day (feed-revamp-depth D28). */
const MAX_CADENCE = 21

const SCHEDULED_MINUTE_ERROR =
  'scheduledMinute must be an integer from 0 to 1439, or null'
const CADENCE_ERROR = `cadencePerWeek must be an integer from 1 to ${MAX_CADENCE}, or null`

/**
 * `scheduled_minute` is minutes past LOCAL midnight, never a timestamp
 * (feed-revamp-depth D26). `undefined` means "not in this request" and is the
 * caller's business; `null` clears the time. Anything else must be a whole
 * minute inside a single day, because a value outside that range could only
 * mean the caller thinks this column carries a date, which it does not.
 */
function parseScheduledMinute(
  raw: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false }
  if (raw < 0 || raw > 1439) return { ok: false }
  return { ok: true, value: raw }
}

function parseCadence(
  raw: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false }
  if (raw < 1 || raw > MAX_CADENCE) return { ok: false }
  return { ok: true, value: raw }
}

export function contentPlanRoutes(
  options: ContentPlanRouteOptions = {},
): Router {
  const router = Router()
  const store = options.store ?? createContentPlanStore()
  const planningStore = options.planningStore ?? createContentPlanningStore()
  const resolveAccess = options.resolveAccess ?? resolvePlanningAccess

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

  /** Reads need membership; every mutation needs the same gate drafting does. */
  function requireDraftPermission(
    ctx: PlanningAccessContext,
    res: Response,
  ): boolean {
    if (ctx.canDraft) return true
    res.status(403).json({
      error:
        'Draft permission required. Ask a workspace admin to grant you draft access.',
    })
    return false
  }

  function readMonth(value: unknown, res: Response): string | null {
    const month = typeof value === 'string' ? value : ''
    if (!parseMonthRange(month)) {
      res.status(400).json({ error: 'month must be YYYY-MM' })
      return null
    }
    return month
  }

  // ── Slots ───────────────────────────────────────────────────────────────

  router.get<{ assistantId: string }>(
    '/:assistantId/plan-slots',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      const month = readMonth(req.query.month, res)
      if (!month) return
      try {
        const slots = await store.listSlots({
          assistantId: req.params.assistantId,
          month,
        })
        res.json({ slots })
      } catch (error) {
        console.error('[content-plan] list slots failed:', error)
        res.status(500).json({ error: 'Failed to load plan slots' })
      }
    },
  )

  router.post<{ assistantId: string }>(
    '/:assistantId/plan-slots',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!isContentPlanPlatform(body.platform)) {
        res.status(400).json({
          error: 'platform must be one of "instagram", "threads", "twitter", "xhs", "linkedin"',
        })
        return
      }
      const scheduledFor = parseIsoDate(body.scheduledFor)
      if (!scheduledFor) {
        res.status(400).json({ error: 'scheduledFor must be YYYY-MM-DD' })
        return
      }
      const title =
        typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE) : ''
      if (!title) {
        res.status(400).json({ error: 'title is required' })
        return
      }
      const minute = parseScheduledMinute(body.scheduledMinute)
      if (!minute.ok) {
        res.status(400).json({ error: SCHEDULED_MINUTE_ERROR })
        return
      }
      try {
        const slot = await store.createSlot({
          assistantId: req.params.assistantId,
          userId: ctx.userId,
          platform: body.platform,
          scheduledFor,
          scheduledMinute: minute.value,
          title,
          brief:
            typeof body.brief === 'string'
              ? body.brief.trim().slice(0, MAX_BRIEF) || undefined
              : undefined,
        })
        res.status(201).json({ slot })
      } catch (error) {
        console.error('[content-plan] create slot failed:', error)
        res.status(500).json({ error: 'Failed to create plan slot' })
      }
    },
  )

  router.patch<{ assistantId: string; slotId: string }>(
    '/:assistantId/plan-slots/:slotId',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const body = (req.body ?? {}) as Record<string, unknown>
      const patch: Parameters<ContentPlanStore['updateSlot']>[0]['patch'] = {}

      if (body.scheduledFor !== undefined) {
        const scheduledFor = parseIsoDate(body.scheduledFor)
        if (!scheduledFor) {
          res.status(400).json({ error: 'scheduledFor must be YYYY-MM-DD' })
          return
        }
        patch.scheduledFor = scheduledFor
      }
      if (body.scheduledMinute !== undefined) {
        const patched = parseScheduledMinute(body.scheduledMinute)
        if (!patched.ok) {
          res.status(400).json({ error: SCHEDULED_MINUTE_ERROR })
          return
        }
        patch.scheduledMinute = patched.value
      }
      if (body.title !== undefined) {
        const title =
          typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE) : ''
        if (!title) {
          res.status(400).json({ error: 'title cannot be empty' })
          return
        }
        patch.title = title
      }
      if (body.brief !== undefined) {
        patch.brief =
          typeof body.brief === 'string'
            ? body.brief.trim().slice(0, MAX_BRIEF) || null
            : null
      }
      if (body.status !== undefined) {
        // Only the operator's own marks are writable. Every other status is
        // derived from what the slot is bound to (D7), so accepting one here
        // would let a caller create exactly the drift the design forbids.
        if (!isPlanSlotMark(body.status)) {
          res.status(400).json({
            error: 'status must be "planned" or "skipped"; other states are derived',
          })
          return
        }
        patch.mark = body.status
      }

      try {
        const slot = await store.updateSlot({
          assistantId: req.params.assistantId,
          slotId: req.params.slotId,
          patch,
        })
        if (!slot) {
          res.status(404).json({ error: 'Plan slot not found' })
          return
        }
        res.json({ slot })
      } catch (error) {
        console.error('[content-plan] update slot failed:', error)
        res.status(500).json({ error: 'Failed to update plan slot' })
      }
    },
  )

  router.delete<{ assistantId: string; slotId: string }>(
    '/:assistantId/plan-slots/:slotId',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      try {
        const removed = await store.deleteSlot(
          req.params.assistantId,
          req.params.slotId,
        )
        if (!removed) {
          res.status(404).json({ error: 'Plan slot not found' })
          return
        }
        res.status(204).end()
      } catch (error) {
        console.error('[content-plan] delete slot failed:', error)
        res.status(500).json({ error: 'Failed to delete plan slot' })
      }
    },
  )

  /**
   * Start drafting a slot: open a draft session seeded from the slot's own
   * brief and bind it, so the chip flips to `drafting` without the operator
   * restating the intent. Idempotent - a slot that already has a session
   * returns it rather than opening a second one.
   */
  router.post<{ assistantId: string; slotId: string }>(
    '/:assistantId/plan-slots/:slotId/draft',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const { assistantId, slotId } = req.params
      try {
        const slot = await store.getSlot(assistantId, slotId)
        if (!slot) {
          res.status(404).json({ error: 'Plan slot not found' })
          return
        }
        if (slot.sessionId) {
          res.json({ slot, sessionId: slot.sessionId })
          return
        }
        const session = await planningStore.createSession({
          assistantId,
          userId: ctx.userId,
          platform: slot.platform,
          title: slot.title,
        })
        const bound = await store.updateSlot({
          assistantId,
          slotId,
          patch: { sessionId: session.id },
        })
        res.status(201).json({ slot: bound ?? slot, sessionId: session.id })
      } catch (error) {
        console.error('[content-plan] draft from slot failed:', error)
        res.status(500).json({ error: 'Failed to start drafting this slot' })
      }
    },
  )

  /**
   * Open (or resume) the operator's plan conversation. Idempotent, and
   * deliberately a POST: it creates a row on first call. The Plan surface
   * calls it on mount so the dock has a `mode='plan'` session to resume,
   * which is what gives the assistant the `proposePlan` cardboard tool.
   */
  router.post<{ assistantId: string }>(
    '/:assistantId/plan-session',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      try {
        const { sessionId } = await store.ensurePlanSession({
          assistantId: req.params.assistantId,
          userId: ctx.userId,
        })
        res.json({ sessionId, channelId: PLAN_CHANNEL_ID })
      } catch (error) {
        console.error('[content-plan] ensure plan session failed:', error)
        res.status(500).json({ error: 'Failed to open the plan conversation' })
      }
    },
  )

  // ── Month brief ─────────────────────────────────────────────────────────

  router.get<{ assistantId: string }>(
    '/:assistantId/plan-brief',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx) return
      const month = readMonth(req.query.month, res)
      if (!month) return
      try {
        const brief = await store.getBrief(req.params.assistantId, month)
        // An unwritten brief is the normal first state, not an error: the
        // client renders an empty editable document either way.
        res.json({
          brief: brief ?? {
            assistantId: req.params.assistantId,
            monthStart: parseMonthRange(month)!.start,
            brief: '',
            themes: [],
            cadencePerWeek: null,
            updatedBy: null,
            updatedAt: null,
          },
        })
      } catch (error) {
        console.error('[content-plan] get brief failed:', error)
        res.status(500).json({ error: 'Failed to load the plan brief' })
      }
    },
  )

  router.put<{ assistantId: string }>(
    '/:assistantId/plan-brief',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const body = (req.body ?? {}) as Record<string, unknown>
      const month = readMonth(body.month, res)
      if (!month) return
      const themes = Array.isArray(body.themes)
        ? body.themes
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim().slice(0, MAX_THEME))
            .filter(Boolean)
            .slice(0, MAX_THEMES)
        : []
      const cadence = parseCadence(body.cadencePerWeek)
      if (!cadence.ok) {
        res.status(400).json({ error: CADENCE_ERROR })
        return
      }
      try {
        const brief = await store.upsertBrief({
          assistantId: req.params.assistantId,
          userId: ctx.userId,
          month,
          brief:
            typeof body.brief === 'string' ? body.brief.slice(0, MAX_BRIEF) : '',
          themes,
          cadencePerWeek: cadence.value,
        })
        res.json({ brief })
      } catch (error) {
        console.error('[content-plan] upsert brief failed:', error)
        res.status(500).json({ error: 'Failed to save the plan brief' })
      }
    },
  )

  return router
}

export { deriveSlotStatus }
