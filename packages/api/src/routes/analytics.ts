import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { sanitize } from '@use-brian/core'
import type { AnalyticsStore } from '@use-brian/core'
import { isValidDateString } from './route-helpers.js'

/**
 * Analytics API routes.
 *
 * GET /api/analytics/daily?date=2026-04-08   — daily system report
 * GET /api/analytics/weekly?date=2026-04-08  — weekly report ending on date
 *
 * The daily/weekly/errors reads and the destructive POST /prune return
 * system-wide, cross-workspace data. The router is mounted with
 * `optionalAuth`, so each of those routes is guarded on an authenticated
 * user via `requireUserId` — without it they were reachable ANONYMOUSLY,
 * including `POST /prune` wiping the `analytics_events` audit log (WS3
 * boundary finding #1). This closes the anonymous access; admin-level
 * gating (`X-Admin-Key`) and relocating these operator routes to
 * `apps/api-admin` (where the analytics surface already lives) is the queued
 * follow-up — see docs/plans/overnight-review-queue.md. `POST /events` (the
 * apps/web client funnel bridge) keeps its own `req.userId` check.
 */
export function analyticsRoutes(analyticsStore: AnalyticsStore): Router {
  const router = Router()

  // Guard for the operator-only system routes: reject when the optionalAuth
  // mount produced no authenticated user.
  function requireUserId(req: Request, res: Response, next: NextFunction): void {
    if (!(req as { userId?: string }).userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    next()
  }

  router.get('/daily', requireUserId, async (req, res) => {
    try {
      const date = req.query.date as string | undefined
      if (date && !isValidDateString(date)) {
        res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' })
        return
      }
      const report = await analyticsStore.getDailyReport(date)
      res.json(report)
    } catch (err) {
      console.error('Analytics daily report error:', err)
      res.status(500).json({ error: 'Failed to generate daily report' })
    }
  })

  router.get('/weekly', requireUserId, async (req, res) => {
    try {
      const date = req.query.date as string | undefined
      if (date && !isValidDateString(date)) {
        res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' })
        return
      }
      const report = await analyticsStore.getWeeklyReport(date)
      res.json(report)
    } catch (err) {
      console.error('Analytics weekly report error:', err)
      res.status(500).json({ error: 'Failed to generate weekly report' })
    }
  })

  /**
   * GET /api/analytics/errors?sinceHours=24&limit=100 — recent error events.
   * Use this for the "read log, fix bug" daily triage routine.
   */
  router.get('/errors', requireUserId, async (req, res) => {
    try {
      const sinceHours = parseInt((req.query.sinceHours as string) ?? '24', 10)
      const limit = parseInt((req.query.limit as string) ?? '100', 10)
      if (isNaN(sinceHours) || sinceHours < 1 || sinceHours > 720) {
        res.status(400).json({ error: 'sinceHours must be between 1 and 720' })
        return
      }
      const errors = await analyticsStore.listErrors({ sinceHours, limit })
      res.json({ errors, count: errors.length, sinceHours })
    } catch (err) {
      console.error('Analytics errors list error:', err)
      res.status(500).json({ error: 'Failed to list errors' })
    }
  })

  /**
   * GET /api/analytics/errors/summary?sinceHours=24 — grouped error summary.
   * Returns one row per (event_name, error_type) with counts + affected users.
   */
  router.get('/errors/summary', requireUserId, async (req, res) => {
    try {
      const sinceHours = parseInt((req.query.sinceHours as string) ?? '24', 10)
      if (isNaN(sinceHours) || sinceHours < 1 || sinceHours > 720) {
        res.status(400).json({ error: 'sinceHours must be between 1 and 720' })
        return
      }
      const summary = await analyticsStore.summarizeErrors({ sinceHours })
      const totalErrors = summary.reduce((s, e) => s + e.count, 0)
      res.json({ summary, totalErrors, sinceHours })
    } catch (err) {
      console.error('Analytics errors summary error:', err)
      res.status(500).json({ error: 'Failed to summarize errors' })
    }
  })

  /**
   * POST /api/analytics/prune — delete raw events older than retention period.
   * Default: 30 days. Override with ?days=N query param.
   */
  router.post('/prune', requireUserId, async (req, res) => {
    try {
      const days = parseInt(req.query.days as string ?? '30', 10)
      if (isNaN(days) || days < 1) {
        res.status(400).json({ error: 'Invalid days parameter' })
        return
      }
      const deleted = await analyticsStore.pruneOldEvents(days)
      res.json({ deleted, retentionDays: days })
    } catch (err) {
      console.error('Analytics prune error:', err)
      res.status(500).json({ error: 'Failed to prune events' })
    }
  })

  // Client funnel bridge — accepts a small batch of allowlisted chat-home
  // activation events from apps/web. `userId` is forced server-side; metadata
  // is sanitized to safe values; only known event names are recorded.
  // analytics_events is metadata-only (no PII). Consent-flag gating is a
  // follow-up once a user-level analytics opt-out exists. [COMP:api/analytics-client]
  const HOME_FUNNEL_EVENTS = new Set([
    'home_viewed',
    'onboarding_nudge_shown',
    'onboarding_nudge_tapped',
    'onboarding_nudge_dismissed',
    'onboarding_configured',
    'home_first_message_sent',
    'home_session_resumed',
  ])
  router.post('/events', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const body = req.body as { events?: unknown }
    const events = Array.isArray(body?.events) ? body.events : null
    if (!events || events.length === 0 || events.length > 50) {
      res.status(400).json({ error: 'events must be a non-empty array (≤50)' })
      return
    }
    let accepted = 0
    for (const raw of events) {
      if (typeof raw !== 'object' || raw === null) continue
      const e = raw as { eventName?: unknown; metadata?: unknown; sessionId?: unknown }
      if (typeof e.eventName !== 'string' || !HOME_FUNNEL_EVENTS.has(e.eventName)) continue
      const metadata: Record<string, number | boolean | ReturnType<typeof sanitize>> = {}
      if (e.metadata && typeof e.metadata === 'object') {
        for (const [k, v] of Object.entries(e.metadata as Record<string, unknown>)) {
          if (Object.keys(metadata).length >= 20) break
          if (typeof v === 'number' || typeof v === 'boolean') metadata[k] = v
          else if (typeof v === 'string' && v.length <= 120) metadata[k] = sanitize(v)
        }
      }
      await analyticsStore.record({
        userId,
        eventName: e.eventName,
        metadata,
        channelType: 'web',
        sessionId: typeof e.sessionId === 'string' ? e.sessionId : undefined,
      })
      accepted++
    }
    res.json({ accepted })
  })

  return router
}
