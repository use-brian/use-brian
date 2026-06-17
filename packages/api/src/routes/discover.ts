/**
 * Public discovery routes — browseable directory of public assistants.
 *
 * Mounted at `/api/discover`, no auth required (world-readable).
 *
 * [COMP:api/discover-route]
 *
 *   GET  /assistants           — paginated list of public assistants
 *   GET  /assistants/:id       — one public assistant's detail
 *
 * Public-ness is gated on `assistants.sharing_mode = 'public'`. See
 * `docs/architecture/platform/discover.md`.
 */

import { Router } from 'express'
import { query } from '../db/client.js'

// Owner email whose assistants populate the Featured section on /discover.
// The email itself is PII and never leaves the server — only the derived
// boolean does.
const OFFICIAL_OWNER_EMAIL = 'contact@sidan.io'

type PublicAssistantRow = {
  id: string
  name: string
  bio: string | null
  iconSeed: number | null
  ownerHandle: string | null
  ownerName: string | null
  followerCount: string
  isOfficial: boolean
}

function serialize(row: PublicAssistantRow) {
  return {
    id: row.id,
    name: row.name,
    bio: row.bio,
    iconSeed: row.iconSeed ?? 0,
    ownerHandle: row.ownerHandle,
    ownerName: row.ownerName,
    followerCount: parseInt(row.followerCount, 10) || 0,
    isOfficial: row.isOfficial,
  }
}

export function discoverRoutes(): Router {
  const router = Router()

  // ── GET /assistants ────────────────────────────────────────────

  router.get('/assistants', async (req, res) => {
    const rawLimit = parseInt((req.query.limit as string) ?? '24', 10)
    const rawOffset = parseInt((req.query.offset as string) ?? '0', 10)
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 24, 1), 100)
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0)

    try {
      const [list, count] = await Promise.all([
        query<PublicAssistantRow>(
          `SELECT a.id, a.name, a.bio, a.icon_seed AS "iconSeed",
                  u.handle AS "ownerHandle", u.name AS "ownerName",
                  (SELECT COUNT(*) FROM assistant_connections ac
                   WHERE ac.following_assistant_id = a.id AND ac.status = 'accepted')::text AS "followerCount",
                  (LOWER(u.email) = LOWER($3)) AS "isOfficial"
           FROM assistants a
           LEFT JOIN assistant_members am ON am.assistant_id = a.id AND am.role = 'owner'
           LEFT JOIN users u ON u.id = am.user_id
           WHERE a.sharing_mode = 'public'
           ORDER BY a.created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset, OFFICIAL_OWNER_EMAIL],
        ),
        query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM assistants WHERE sharing_mode = 'public'`,
        ),
      ])

      res.json({
        assistants: list.rows.map(serialize),
        total: parseInt(count.rows[0]?.total ?? '0', 10) || 0,
        limit,
        offset,
      })
    } catch (err) {
      console.error('[discover] list failed:', err)
      res.status(500).json({ error: 'Failed to list public assistants' })
    }
  })

  // ── GET /assistants/:id ───────────────────────────────────────

  router.get('/assistants/:id', async (req, res) => {
    const { id } = req.params
    try {
      const result = await query<PublicAssistantRow>(
        `SELECT a.id, a.name, a.bio, a.icon_seed AS "iconSeed",
                u.handle AS "ownerHandle", u.name AS "ownerName",
                (SELECT COUNT(*) FROM assistant_connections ac
                 WHERE ac.following_assistant_id = a.id AND ac.status = 'accepted')::text AS "followerCount",
                (LOWER(u.email) = LOWER($2)) AS "isOfficial"
         FROM assistants a
         LEFT JOIN assistant_members am ON am.assistant_id = a.id AND am.role = 'owner'
         LEFT JOIN users u ON u.id = am.user_id
         WHERE a.id = $1 AND a.sharing_mode = 'public'`,
        [id, OFFICIAL_OWNER_EMAIL],
      )
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Assistant not found or not public' })
        return
      }
      res.json(serialize(result.rows[0]))
    } catch (err) {
      console.error('[discover] detail failed:', err)
      res.status(500).json({ error: 'Failed to load assistant' })
    }
  })

  return router
}
