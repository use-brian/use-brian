import { Router } from 'express'
import { getHomeGlance, getHomeSetupState, isWorkspaceMember } from '../db/home-store.js'
import { getDismissedNudges, updateDismissedNudges } from '../db/users.js'

/**
 * Chat-home routes (authenticated).
 *
 *   GET  /api/home/setup-state?workspaceId=X  — onboarding-nudge signals + dismissals
 *   GET  /api/home/glance?workspaceId=X       — read-only "Your brain" glance
 *   GET  /api/home/dismissed-nudges           — per-user nudge dismissals only
 *   POST /api/home/dismiss-nudge { key }      — persist a per-user nudge dismissal
 *
 * Drives the chat-centric home's nudge visibility + brain glance
 * (docs/architecture/features/web-ui.md → "The chat-centric home"). The
 * lightweight `dismissed-nudges` read lets other surfaces (e.g. the Brain
 * page's `brain-unconfirmed` banner) check dismissals without paying for
 * the workspace-scoped setup-state signal queries — dismissals are
 * per-user, not per-workspace, so no workspaceId is required.
 * [COMP:api/home-setup-state] [COMP:api/home-glance] [COMP:api/home-dismiss]
 */
export function homeRoutes(): Router {
  const router = Router()

  router.get('/setup-state', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    // Gate workspace-scoped reads on membership (same 404 as missing so we
    // don't leak workspace existence).
    if (!(await isWorkspaceMember(userId, workspaceId))) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const [state, dismissedNudges] = await Promise.all([
      getHomeSetupState(userId, workspaceId),
      getDismissedNudges(userId),
    ])
    res.json({ ...state, dismissedNudges })
  })

  router.get('/glance', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    // Gate workspace-scoped reads on membership (same 404 as missing so we
    // don't leak workspace existence).
    if (!(await isWorkspaceMember(userId, workspaceId))) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    // `since` scopes "learned recently" — the client passes a recent window
    // (e.g. 30 days ago). Fall back to a rolling 24h window if absent /
    // unparseable (never "most recent of all time").
    const sinceParam = typeof req.query.since === 'string' ? req.query.since : null
    const since =
      sinceParam && !Number.isNaN(Date.parse(sinceParam))
        ? new Date(sinceParam).toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    res.json(await getHomeGlance(userId, workspaceId, since))
  })

  router.get('/dismissed-nudges', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    // Dismissals are per-user (not workspace-scoped), so no membership
    // gate is needed — the user only ever reads their own row.
    res.json({ dismissed: await getDismissedNudges(userId) })
  })

  router.post('/dismiss-nudge', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const body = req.body as { key?: unknown }
    const key = typeof body?.key === 'string' ? body.key : null
    if (!key || key.length === 0 || key.length > 64) {
      res.status(400).json({ error: 'key (non-empty string ≤64 chars) is required' })
      return
    }
    await updateDismissedNudges(userId, key)
    res.json({ ok: true })
  })

  return router
}
