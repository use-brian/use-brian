/**
 * Idea-backlog HTTP surface: capture a raw jot now, develop it later.
 *
 * Mounted at `/api/distribution` in BOTH editions, unconditionally, beside
 * `contentPlanRoutes` and for the same reason: an idea carries no provider
 * integration, so it must not join the fork that 404s edition-specific
 * routes (docs/plans/feed-revamp.md §6). Paths this router does not match
 * fall through untouched.
 *
 * [COMP:feed/content-ideas-routes]
 */

import { Router, type Response } from 'express'
import {
  createContentIdeasStore,
  deriveIdeaStatus,
  isIdeaSource,
  type ContentIdeasStore,
  type IdeaStatus,
} from '../db/content-ideas-store.js'
import {
  createContentPlanStore,
  isContentPlanPlatform,
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

export interface ContentIdeasRouteOptions {
  store?: ContentIdeasStore
  planStore?: ContentPlanStore
  /** Draft-session creation for the direct idea → draft escalation (P7). */
  planningStore?: ContentPlanningStore
  resolveAccess?: (
    userId: string,
    assistantId: string,
  ) => Promise<PlanningAccessContext | null>
}

const MAX_TEXT = 2_000
const MAX_NOTE = 4_000

function isIdeaStatus(value: unknown): value is IdeaStatus {
  return value === 'open' || value === 'promoted' || value === 'discarded'
}

export function contentIdeasRoutes(
  options: ContentIdeasRouteOptions = {},
): Router {
  const router = Router()
  const store = options.store ?? createContentIdeasStore()
  const planStore = options.planStore ?? createContentPlanStore()
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

  router.get<{ assistantId: string }>('/:assistantId/ideas', async (req, res) => {
    const ctx = await access(req, res)
    if (!ctx) return
    const rawStatus = req.query.status
    if (rawStatus !== undefined && !isIdeaStatus(rawStatus)) {
      res.status(400).json({
        error: 'status must be "open", "promoted", or "discarded"',
      })
      return
    }
    try {
      const ideas = await store.listIdeas({
        assistantId: req.params.assistantId,
        ...(rawStatus !== undefined ? { status: rawStatus } : {}),
      })
      res.json({ ideas })
    } catch (error) {
      console.error('[content-ideas] list failed:', error)
      res.status(500).json({ error: 'Failed to load ideas' })
    }
  })

  router.post<{ assistantId: string }>('/:assistantId/ideas', async (req, res) => {
    const ctx = await access(req, res)
    if (!ctx || !requireDraftPermission(ctx, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const text =
      typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
    if (!text) {
      res.status(400).json({ error: 'text is required' })
      return
    }
    if (body.platformHint !== undefined && !isContentPlanPlatform(body.platformHint)) {
      res.status(400).json({ error: 'platformHint is not a known platform' })
      return
    }
    if (body.source !== undefined && !isIdeaSource(body.source)) {
      res.status(400).json({
        error: 'source must be one of "manual", "chat", "inspiration", "voice"',
      })
      return
    }
    try {
      const idea = await store.createIdea({
        assistantId: req.params.assistantId,
        userId: ctx.userId,
        text,
        note:
          typeof body.note === 'string'
            ? body.note.trim().slice(0, MAX_NOTE) || undefined
            : undefined,
        ...(isContentPlanPlatform(body.platformHint)
          ? { platformHint: body.platformHint }
          : {}),
        ...(isIdeaSource(body.source) ? { source: body.source } : {}),
      })
      res.status(201).json({ idea })
    } catch (error) {
      console.error('[content-ideas] create failed:', error)
      res.status(500).json({ error: 'Failed to save the idea' })
    }
  })

  router.patch<{ assistantId: string; ideaId: string }>(
    '/:assistantId/ideas/:ideaId',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const body = (req.body ?? {}) as Record<string, unknown>
      const patch: Parameters<ContentIdeasStore['updateIdea']>[0]['patch'] = {}

      // Status is derived from the links and `discarded_at` (the plan-slot D7
      // rule); accepting one over the wire would create exactly that drift.
      if (body.status !== undefined) {
        res.status(400).json({
          error: 'status is derived; send discarded, or bind a slotId',
        })
        return
      }
      if (body.text !== undefined) {
        const text =
          typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
        if (!text) {
          res.status(400).json({ error: 'text cannot be empty' })
          return
        }
        patch.text = text
      }
      if (body.note !== undefined) {
        patch.note =
          typeof body.note === 'string'
            ? body.note.trim().slice(0, MAX_NOTE) || null
            : null
      }
      if (body.platformHint !== undefined) {
        if (body.platformHint !== null && !isContentPlanPlatform(body.platformHint)) {
          res.status(400).json({ error: 'platformHint is not a known platform' })
          return
        }
        patch.platformHint = body.platformHint
      }
      if (body.discarded !== undefined) {
        if (typeof body.discarded !== 'boolean') {
          res.status(400).json({ error: 'discarded must be a boolean' })
          return
        }
        patch.discarded = body.discarded
      }
      if (body.slotId !== undefined) {
        if (body.slotId === null) {
          patch.slotId = null
        } else if (typeof body.slotId === 'string') {
          // The FK guarantees the slot exists but not that it belongs to this
          // assistant; without this check a member could link across brands.
          const slot = await planStore.getSlot(req.params.assistantId, body.slotId)
          if (!slot) {
            res.status(404).json({ error: 'Plan slot not found' })
            return
          }
          patch.slotId = body.slotId
        } else {
          res.status(400).json({ error: 'slotId must be a string or null' })
          return
        }
      }

      try {
        const idea = await store.updateIdea({
          assistantId: req.params.assistantId,
          ideaId: req.params.ideaId,
          patch,
        })
        if (!idea) {
          res.status(404).json({ error: 'Idea not found' })
          return
        }
        res.json({ idea })
      } catch (error) {
        console.error('[content-ideas] update failed:', error)
        res.status(500).json({ error: 'Failed to update the idea' })
      }
    },
  )

  /**
   * Draft directly from an idea — the escalation that skips the calendar
   * (docs/plans/feed-plan-chat-first.md §5/P7): creates a draft session
   * seeded from the jot and binds `session_id`, which is what derives the
   * idea `promoted` (migration 384's contract). The idea's `platformHint`
   * wins over the caller's default; a jot with neither refuses rather than
   * guessing. Idempotent — an idea already bound returns its session.
   * A discarded idea refuses (restore it first); `ON DELETE SET NULL`
   * self-heals a bind whose session died, so a dangling id falls through
   * to a fresh session rather than erroring.
   */
  router.post<{ assistantId: string; ideaId: string }>(
    '/:assistantId/ideas/:ideaId/draft',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      const { assistantId, ideaId } = req.params
      const body = (req.body ?? {}) as Record<string, unknown>
      if (body.platform !== undefined && !isContentPlanPlatform(body.platform)) {
        res.status(400).json({ error: 'platform is not a known platform' })
        return
      }
      try {
        const idea = await store.getIdea(assistantId, ideaId)
        if (!idea) {
          res.status(404).json({ error: 'Idea not found' })
          return
        }
        if (idea.discardedAt) {
          res.status(409).json({ error: 'Idea is discarded; restore it first' })
          return
        }
        if (idea.sessionId) {
          // Already promoted to a draft — hand back the existing session so a
          // double-click or a stale tab never forks a second one.
          const sessions = await planningStore.listSessions({ assistantId })
          const existing = sessions.find((s) => s.id === idea.sessionId)
          if (existing) {
            res.json({
              idea,
              sessionId: existing.id,
              platform: existing.platform,
            })
            return
          }
          // Bound session no longer exists — treat as unbound and re-draft.
        }
        const platform =
          idea.platformHint ??
          (isContentPlanPlatform(body.platform) ? body.platform : null)
        if (!platform) {
          res.status(400).json({
            error: 'platform is required for an idea with no platform hint',
          })
          return
        }
        // Same derivation the slot editor prefill uses: first line titles,
        // the overflow plus any note travels as the freeform seed brief.
        const text = idea.text.trim()
        const firstLine = text.split('\n')[0]?.trim().slice(0, 200) ?? ''
        const title = firstLine || text.slice(0, 200)
        const overflow = text.length > title.length ? text : ''
        const brief = [overflow, idea.note?.trim() ?? '']
          .filter(Boolean)
          .join('\n\n')
        const session = await planningStore.createSession({
          assistantId,
          userId: ctx.userId,
          platform,
          title,
          ...(brief ? { seed: { kind: 'freeform' as const, brief } } : {}),
        })
        const bound = await store.updateIdea({
          assistantId,
          ideaId,
          patch: { sessionId: session.id },
        })
        res.status(201).json({
          idea: bound ?? idea,
          sessionId: session.id,
          platform,
        })
      } catch (error) {
        console.error('[content-ideas] draft from idea failed:', error)
        res.status(500).json({ error: 'Failed to start drafting this idea' })
      }
    },
  )

  router.delete<{ assistantId: string; ideaId: string }>(
    '/:assistantId/ideas/:ideaId',
    async (req, res) => {
      const ctx = await access(req, res)
      if (!ctx || !requireDraftPermission(ctx, res)) return
      try {
        const removed = await store.deleteIdea(
          req.params.assistantId,
          req.params.ideaId,
        )
        if (!removed) {
          res.status(404).json({ error: 'Idea not found' })
          return
        }
        res.status(204).end()
      } catch (error) {
        console.error('[content-ideas] delete failed:', error)
        res.status(500).json({ error: 'Failed to delete the idea' })
      }
    },
  )

  return router
}

export { deriveIdeaStatus }
