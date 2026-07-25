/**
 * Public chat — the anonymous browser surface behind a chat-link token.
 *
 * Mounted at `/api` in the EARLY public block (before the bare
 * `requireAuth` guards, next to publicShareRoutes) — see
 * docs/architecture/features/public-chat-link.md.
 *
 *   GET  /public/chat/:token            — link meta (assistant name/icon)
 *   GET  /public/chat/:token/messages   — history hydrate (per visitor id)
 *   POST /public/chat/:token/messages   — one chat turn, synchronous JSON
 *
 * Auth is the token itself: resolved server-side to an active link whose
 * workspace still has external sharing enabled. Visitors are ALWAYS
 * Tier-2 anonymous — the request schema does not accept `identified`
 * or email, so the shared pipeline never grants memory tools here.
 * The browser never holds an `sk_live_` key.
 *
 * Abuse posture: per-IP fixed-window limiter (same in-file pattern as
 * public-share.ts) + per-link atomic daily cap + the workspace budget
 * gate inside the shared pipeline.
 *
 * [COMP:api/public-chat-route]
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import type { ChatLinkStore } from '../db/chat-link-store.js'
import {
  executePublicTurn,
  handlePublicHistory,
  fail,
  type PublicTurnDeps,
} from './public-turn.js'

export type PublicChatRouteOptions = PublicTurnDeps & {
  chatLinkStore: ChatLinkStore
  /** Hard cap on inbound message length, defaults to 16k chars. */
  maxMessageChars?: number
}

// ── Minimal fixed-window per-IP rate limiter ──────────────────────────
// Anonymous traffic on the autoscaling user API. Per-instance, fixed
// window — a cheap abuse backstop; production also fronts this with
// infra-level limits. Same pattern as public-share.ts / public-sites.ts.
function rateLimiter(limit: number, windowMs: number) {
  let windowStart = 0
  let hits = new Map<string, number>()
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now()
    if (now - windowStart > windowMs) {
      windowStart = now
      hits = new Map()
    }
    const ip = req.ip ?? 'unknown'
    const n = (hits.get(ip) ?? 0) + 1
    hits.set(ip, n)
    if (n > limit) {
      res.status(429).json({ error: 'Too many requests' })
      return
    }
    next()
  }
}

/**
 * Visitor-facing message schema — deliberately NARROWER than the keyed
 * public API's: no `identified`, no `externalUserEmail`, no
 * `externalUserName`. An anonymous stranger must not be able to
 * self-identify into Tier 1 (memory tools) on someone else's dime.
 * `visitorId` is a client-generated uuid persisted in localStorage.
 */
const turnSchema = z.object({
  visitorId: z.string().min(8).max(128),
  sessionId: z.string().min(1).max(256).optional(),
  message: z.string().min(1),
  truncateFromMessageId: z.string().uuid().optional(),
}).strict()

const historySchema = z.object({
  visitorId: z.string().min(8).max(128),
  sessionId: z.string().min(1).max(256).optional(),
})

export function publicChatRoutes(options: PublicChatRouteOptions): Router {
  const router = Router()
  const maxMessageChars = options.maxMessageChars ?? 16_000

  // Turns are expensive (a full model turn each) — throttle harder than
  // the read endpoints.
  const readLimit = rateLimiter(120, 60_000)
  const turnLimit = rateLimiter(30, 60_000)

  // ── GET /public/chat/:token — link meta for the page header ────────
  router.get<{ token: string }>('/public/chat/:token', readLimit, async (req, res) => {
    try {
      const link = await options.chatLinkStore.resolveToken(req.params.token)
      if (!link) return fail(res, 404, 'link_not_found')
      res.json({
        assistantName: link.assistantName,
        assistantIconSeed: link.assistantIconSeed,
        assistantBio: link.assistantBio,
      })
    } catch (err) {
      console.error('[public-chat] meta failed:', err)
      fail(res, 500, 'internal')
    }
  })

  // ── GET /public/chat/:token/messages — history hydrate ─────────────
  router.get<{ token: string }>('/public/chat/:token/messages', readLimit, async (req, res) => {
    const parsed = historySchema.safeParse(req.query)
    if (!parsed.success) {
      return fail(res, 400, 'invalid_input', parsed.error.message)
    }
    try {
      const link = await options.chatLinkStore.resolveToken(req.params.token)
      if (!link) return fail(res, 404, 'link_not_found')

      await handlePublicHistory(
        {
          assistantId: link.assistantId,
          identityNamespace: `chatlink:${link.linkId}`,
          externalUserId: parsed.data.visitorId,
          sessionId: parsed.data.sessionId,
          limit: 100,
        },
        res,
      )
    } catch (err) {
      console.error('[public-chat] history failed:', err)
      fail(res, 500, 'internal')
    }
  })

  // ── POST /public/chat/:token/messages — one turn ───────────────────
  router.post<{ token: string }>('/public/chat/:token/messages', turnLimit, async (req, res) => {
    const parsed = turnSchema.safeParse(req.body)
    if (!parsed.success) {
      return fail(res, 400, 'invalid_input', parsed.error.message)
    }
    const body = parsed.data
    if (body.message.length > maxMessageChars) {
      return fail(res, 400, 'invalid_input', `message exceeds ${maxMessageChars} chars`)
    }

    try {
      const link = await options.chatLinkStore.resolveToken(req.params.token)
      if (!link) return fail(res, 404, 'link_not_found')

      // Per-link daily cap — atomic increment-or-reset; counts every
      // accepted turn (even ones that later fail upstream: the counter
      // is an abuse ceiling, not an exact billing meter).
      const budget = await options.chatLinkStore.consumeDailyBudget(link.linkId)
      if (!budget.allowed) {
        return fail(
          res,
          429,
          'link_budget_exhausted',
          'This chat link has reached its daily message limit. Try again tomorrow.',
        )
      }

      await executePublicTurn(
        options,
        {
          assistantId: link.assistantId,
          identityNamespace: `chatlink:${link.linkId}`,
          body: {
            externalUserId: body.visitorId,
            sessionId: body.sessionId,
            message: body.message,
            truncateFromMessageId: body.truncateFromMessageId,
          },
          analyticsMeta: { chat_link_id: link.linkId, surface: 'chat_link' },
        },
        req,
        res,
      )
    } catch (err) {
      console.error('[public-chat] turn failed:', err)
      if (!res.headersSent) fail(res, 500, 'internal')
    }
  })

  return router
}
