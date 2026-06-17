/**
 * OAuth authorization management routes — the Studio ▸ Programmatic Access
 * "Connected apps" section.
 *
 *   GET    /api/workspaces/:workspaceId/oauth-authorizations        — list grants
 *   DELETE /api/workspaces/:workspaceId/oauth-authorizations/:id    — revoke a grant
 *
 * Mounted behind requireAuth in apps/api. The OAuth authorization rows have
 * an RLS policy that already gates list/revoke to workspace owner/admin
 * (migration 208) — the route's `gate()` is an explicit pre-check so the
 * UI gets a 403 rather than an empty list when a member peeks.
 *
 * Component tag: [COMP:api/brain-oauth].
 * Spec: docs/architecture/features/programmatic-access.md → "OAuth 2.1 mode".
 */

import { Router, type Request, type Response } from 'express'
import type { OAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'

type Options = {
  authorizationStore: OAuthAuthorizationStore
  workspaceStore: WorkspaceStore
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function oauthAuthorizationsRoutes(opts: Options): Router {
  const router = Router({ mergeParams: true })

  async function gate(req: Request, res: Response): Promise<string | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const rawWorkspaceId = req.params.workspaceId
    const workspaceId = typeof rawWorkspaceId === 'string' ? rawWorkspaceId : ''
    if (!UUID_RE.test(workspaceId)) {
      res.status(400).json({ error: 'Invalid workspace id' })
      return null
    }
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Workspace not found' })
      return null
    }
    if (role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'Only workspace admins can manage connected apps' })
      return null
    }
    return workspaceId
  }

  // ── GET / — list connected apps for the workspace ──
  router.get('/', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    try {
      const rows = await opts.authorizationStore.listForWorkspace(req.userId!, workspaceId)
      res.json({
        authorizations: rows.map((r) => ({
          id: r.id,
          clientId: r.clientId,
          clientName: r.clientName,
          clientUri: r.clientUri,
          scope: r.scope,
          status: r.revokedAt ? 'revoked' : 'active',
          createdAt: r.createdAt,
          lastUsedAt: r.lastUsedAt,
        })),
      })
    } catch (err) {
      console.error('[oauth-authorizations] list failed:', err)
      res.status(500).json({ error: 'Failed to list connected apps' })
    }
  })

  // ── DELETE /:id — revoke a grant (idempotent) ──
  router.delete('/:id', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const rawId = req.params.id
    const id = typeof rawId === 'string' ? rawId : ''
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'Authorization not found' })
      return
    }
    try {
      const ok = await opts.authorizationStore.revoke(req.userId!, id)
      if (!ok) {
        res.status(404).json({ error: 'Authorization not found' })
        return
      }
      res.status(204).end()
    } catch (err) {
      console.error('[oauth-authorizations] revoke failed:', err)
      res.status(500).json({ error: 'Failed to revoke authorization' })
    }
  })

  return router
}
