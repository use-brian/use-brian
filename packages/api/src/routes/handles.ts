/**
 * Handle management routes.
 *
 * Mounted at `/api/handles` behind requireAuth.
 *
 * [COMP:api/handles-route]
 *
 *   GET    /me                  — get current user's handle
 *   PATCH  /me                  — change handle
 *
 * The former handle-discovery endpoints (GET /search, GET /:handle/assistants)
 * were removed with the assistants.sharing_mode teardown — they gated on
 * `sharing_mode != 'off'`, which no assistant ever set. See
 * docs/plans/network-feature-teardown.md.
 */

import { Router } from 'express'
import { query } from '../db/client.js'
import { validateHandle, generateHandle } from '@use-brian/core'

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

  return router
}
