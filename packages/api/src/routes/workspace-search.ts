import { WORKSPACE_SEARCH_FAMILIES, type WorkspaceSearchFamily } from '@use-brian/shared'
import type { readSearchItem } from '../workspace-search/adapters.js'
import { Router } from 'express'
import { z } from 'zod'
import { InvalidSearchRequest, parseSearchRequest, type createWorkspaceSearchService } from '../workspace-search/service.js'

export function workspaceSearchRoutes(deps: {
  isMember(userId: string, workspaceId: string): Promise<boolean>
  search: ReturnType<typeof createWorkspaceSearchService>
  readItem?: typeof readSearchItem
}): Router {
  const router = Router()
  router.get('/workspace-search/:workspaceId', async (req, res) => {
    const raw = req.query
    // Access-log/error middleware must never retain the search string.
    req.url = req.url.split('?')[0]!
    req.originalUrl = req.originalUrl.split('?')[0]!
    res.setHeader('Cache-Control', 'private, no-store')
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' })
    const workspace = z.string().uuid().safeParse(req.params.workspaceId)
    if (!workspace.success) return res.status(400).json({ error: 'Invalid workspace search request' })
    const controller = new AbortController()
    const abort = () => controller.abort()
    res.once('close', abort)
    try {
      const input = parseSearchRequest(raw)
      if (!await deps.isMember(req.userId, workspace.data)) return res.status(403).json({ error: 'Workspace unavailable' })
      const result = await deps.search({ userId: req.userId, workspaceId: workspace.data }, input, controller.signal)
      if (!res.destroyed) return res.json(result)
    } catch (error) {
      if (!res.destroyed) return res.status(error instanceof InvalidSearchRequest ? 400 : 503)
        .json({ error: error instanceof InvalidSearchRequest ? 'Invalid workspace search request' : 'Workspace search unavailable' })
    } finally { res.removeListener('close', abort) }
  })
  router.get('/workspace-search/:workspaceId/items/:kind/:key', async (req,res) => {
    res.setHeader('Cache-Control','private, no-store')
    if (!req.userId) return res.status(401).json({error:'Unauthorized'})
    const workspace=z.string().uuid().safeParse(req.params.workspaceId)
    const kind=req.params.kind as WorkspaceSearchFamily
    if (!workspace.success || !WORKSPACE_SEARCH_FAMILIES.includes(kind) || req.params.key.length>100 || Object.keys(req.query).length) return res.status(400).json({error:'Invalid workspace search request'})
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),2000)
    const abort=()=>controller.abort();res.once('close',abort)
    try {
      if (!await deps.isMember(req.userId,workspace.data)) return res.status(403).json({error:'Workspace unavailable'})
      const item=await deps.readItem?.({userId:req.userId,workspaceId:workspace.data},kind,req.params.key,controller.signal)
      if (!res.destroyed) return item ? res.json(item) : res.status(404).json({error:'Item unavailable'})
    } catch { if (!res.destroyed) return res.status(503).json({error:'Item unavailable'}) }
    finally {clearTimeout(timer);res.removeListener('close',abort)}
  })
  return router
}
