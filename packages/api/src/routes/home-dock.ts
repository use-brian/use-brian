/**
 * Home dock routes (authenticated).
 *
 *   GET  /api/home-dock?workspaceId=X  — the resolved "Suggested for you" dock
 *                                         (assistant artifact merged over live
 *                                         signals; deterministic when none).
 *   POST /api/home-dock/refresh?workspaceId=X — run the primary assistant once
 *                                         to (re)curate, then return the dock.
 *
 * The GET assembles fresh signals every call, so numbers are never stale; the
 * merge drops any card whose signal is gone (the freshness contract). Refresh
 * is best-effort: a failed curation turn just leaves the deterministic
 * fallback. See docs/architecture/features/home-dock.md.
 *
 * [COMP:api/home-dock-routes]
 */

import { Router, type Request, type Response } from 'express'
import { mergeHomeDock } from '@use-brian/core/home/merge.js'
import type { HomeDockStore, HomeSignals } from '@use-brian/core/home/types.js'
import type { HomeDockResponse } from '@use-brian/shared/home-dock'

export type HomeDockRoutesDeps = {
  homeDockStore: HomeDockStore
  isWorkspaceMember: (userId: string, workspaceId: string) => Promise<boolean>
  assembleSignals: (userId: string, workspaceId: string) => Promise<HomeSignals>
  /** Run the primary assistant once to curate. Best-effort (may reject). */
  refresh: (userId: string, workspaceId: string) => Promise<void>
}

export function homeDockRoutes(deps: HomeDockRoutesDeps): Router {
  const router = Router()

  async function sendDock(res: Response, userId: string, workspaceId: string, failure: string): Promise<void> {
    try {
      const [layout, signals] = await Promise.all([
        deps.homeDockStore.get(userId, workspaceId),
        deps.assembleSignals(userId, workspaceId),
      ])
      res.json({ dock: mergeHomeDock(layout, signals) } satisfies HomeDockResponse)
    } catch (err) {
      console.error(failure, err)
      res.status(500).json({ error: 'Failed to load home dock' })
    }
  }

  async function gate(
    req: Request,
    res: Response,
  ): Promise<{ userId: string; workspaceId: string } | null> {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return null
    }
    // Same 404-as-missing membership gate as the chat-home reads, so we don't
    // leak workspace existence.
    if (!(await deps.isWorkspaceMember(userId, workspaceId))) {
      res.status(404).json({ error: 'Not found' })
      return null
    }
    return { userId, workspaceId }
  }

  router.get('/', async (req, res) => {
    const ok = await gate(req, res)
    if (!ok) return
    await sendDock(res, ok.userId, ok.workspaceId, '[home-dock] resolve failed:')
  })

  router.post('/refresh', async (req, res) => {
    const ok = await gate(req, res)
    if (!ok) return
    try {
      await deps.refresh(ok.userId, ok.workspaceId)
    } catch (err) {
      // Best-effort: fall through to the deterministic dock.
      console.error('[home-dock] refresh failed:', err)
    }
    await sendDock(res, ok.userId, ok.workspaceId, '[home-dock] resolve after refresh failed:')
  })

  return router
}
