/**
 * Handle management routes.
 *
 * Mounted at `/api/handles` behind requireAuth (except search).
 *
 * [COMP:api/handles-route]
 *
 *   GET    /me                  — get current user's handle
 *   PATCH  /me                  — change handle
 *   GET    /search?q=           — search users by handle prefix
 *   GET    /:handle/assistants  — list public assistants for a handle
 */

import { Router } from 'express'
import { query } from '../db/client.js'
import { validateHandle, generateHandle } from '@sidanclaw/core'

export function handleRoutes(): Router {
  const router = Router()

  // ── GET /me — get current user's handle ──────────────────────

  router.get('/me', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      const result = await query<{ handle: string | null }>(
        `SELECT handle FROM users WHERE id = $1`,
        [userId],
      )
      let handle = result.rows[0]?.handle ?? null

      // Auto-generate handle for existing users who don't have one
      if (!handle) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const candidate = generateHandle()
          try {
            await query(
              `UPDATE users SET handle = $1 WHERE id = $2 AND handle IS NULL`,
              [candidate, userId],
            )
            handle = candidate
            break
          } catch (err: unknown) {
            if ((err as { code?: string }).code === '23505') continue
            throw err
          }
        }
      }

      res.json({ handle })
    } catch (err) {
      console.error('[handles] get failed:', err)
      res.status(500).json({ error: 'Failed to get handle' })
    }
  })

  // ── PATCH /me — change handle ────────────────────────────────

  router.patch('/me', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { handle } = req.body as { handle?: string }
    if (!handle || typeof handle !== 'string') {
      res.status(400).json({ error: 'Handle is required' })
      return
    }

    const normalized = handle.trim().toLowerCase()
    if (!validateHandle(normalized)) {
      res.status(400).json({ error: 'Handle must be 3-30 characters, lowercase alphanumeric and hyphens only' })
      return
    }

    try {
      const result = await query(
        `UPDATE users SET handle = $1, updated_at = now() WHERE id = $2`,
        [normalized, userId],
      )
      if ((result.rowCount ?? 0) === 0) {
        res.status(404).json({ error: 'User not found' })
        return
      }
      res.json({ handle: normalized })
    } catch (err: any) {
      if (err?.code === '23505') {
        res.status(409).json({ error: 'Handle is already taken' })
        return
      }
      console.error('[handles] update failed:', err)
      res.status(500).json({ error: 'Failed to update handle' })
    }
  })

  // ── GET /search?q= — search users by handle prefix ──────────

  router.get('/search', async (req, res) => {
    const q = req.query.q as string | undefined
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      res.status(400).json({ error: 'Query must be at least 2 characters' })
      return
    }

    const prefix = q.trim().toLowerCase()

    try {
      const result = await query<{
        handle: string
        name: string | null
        avatarUrl: string | null
        userId: string
      }>(
        `SELECT handle, name, avatar_url AS "avatarUrl", id AS "userId"
         FROM users
         WHERE handle LIKE $1 AND handle IS NOT NULL
         ORDER BY handle ASC
         LIMIT 20`,
        [`${prefix}%`],
      )

      // For each user, get their assistants (name + id only — limited public info)
      const users = await Promise.all(
        result.rows.map(async (u) => {
          const assistants = await query<{ id: string; name: string; bio: string | null; iconSeed: number | null; connectionCount: string; sharingMode: string }>(
            // Personal assistants are owned via assistant_members; team
            // assistants (post-089) have no assistant_members rows and
            // are owned by teams.owner_user_id. Both shapes count.
            `SELECT a.id, a.name, a.bio, a.icon_seed AS "iconSeed", a.sharing_mode AS "sharingMode",
                    (SELECT COUNT(*) FROM assistant_connections ac
                     WHERE ac.following_assistant_id = a.id AND ac.status = 'accepted')::text AS "connectionCount"
             FROM assistants a
             WHERE a.sharing_mode != 'off'
               AND (
                 EXISTS (
                   SELECT 1 FROM assistant_members am
                   WHERE am.assistant_id = a.id AND am.user_id = $1 AND am.role = 'owner'
                 )
                 OR (
                   a.workspace_id IS NOT NULL
                   AND EXISTS (
                     SELECT 1 FROM workspaces t
                     WHERE t.id = a.workspace_id AND t.owner_user_id = $1
                   )
                 )
               )
             ORDER BY a.created_at ASC`,
            [u.userId],
          )
          return {
            handle: u.handle,
            name: u.name,
            avatarUrl: u.avatarUrl,
            assistants: assistants.rows.map((a) => ({
              id: a.id,
              name: a.name,
              bio: a.bio,
              iconSeed: a.iconSeed ?? 0,
              connectionCount: parseInt(a.connectionCount, 10),
              sharingMode: a.sharingMode,
            })),
          }
        }),
      )

      res.json({ users: users.filter((u) => u.assistants.length > 0) })
    } catch (err) {
      console.error('[handles] search failed:', err)
      res.status(500).json({ error: 'Failed to search handles' })
    }
  })

  // ── GET /:handle/assistants — list assistants for a handle ───

  router.get('/:handle/assistants', async (req, res) => {
    const { handle } = req.params

    try {
      const userResult = await query<{ id: string; name: string | null; avatarUrl: string | null }>(
        `SELECT id, name, avatar_url AS "avatarUrl"
         FROM users WHERE handle = $1`,
        [handle.toLowerCase()],
      )
      if (userResult.rows.length === 0) {
        res.status(404).json({ error: 'User not found' })
        return
      }

      const user = userResult.rows[0]
      const assistants = await query<{ id: string; name: string }>(
        `SELECT a.id, a.name FROM assistants a
         WHERE
           EXISTS (
             SELECT 1 FROM assistant_members am
             WHERE am.assistant_id = a.id AND am.user_id = $1 AND am.role = 'owner'
           )
           OR (
             a.workspace_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM workspaces t
               WHERE t.id = a.workspace_id AND t.owner_user_id = $1
             )
           )
         ORDER BY a.created_at ASC`,
        [user.id],
      )

      res.json({
        handle,
        name: user.name,
        avatarUrl: user.avatarUrl,
        assistants: assistants.rows.map((a) => ({ id: a.id, name: a.name })),
      })
    } catch (err) {
      console.error('[handles] get assistants failed:', err)
      res.status(500).json({ error: 'Failed to get assistants' })
    }
  })

  return router
}
