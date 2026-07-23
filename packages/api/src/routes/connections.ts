/**
 * Assistant connection routes — the A2A follow graph read/manage surface.
 *
 * Mounted at `/api/connections` behind requireAuth. Consumed by the Studio
 * Network (modes) tab. The graph itself is populated by intra-workspace
 * auto-seeding (seedWorkspacePrimaryFollows) and read in-process by the A2A
 * relay (askAssistant/listConnectedAssistants) via the connection store, not
 * these routes.
 *
 * [COMP:api/connections-route]
 *
 *   POST   /unfollow            — unfollow
 *   POST   /:id/accept          — accept a pending follow request
 *   POST   /:id/reject          — reject a pending follow request
 *   GET    /following?assistantId=  — who I follow
 *   GET    /followers?assistantId=  — who follows me
 *   GET    /pending?assistantId=    — pending follow requests
 *   GET    /counts?assistantId=     — follower + following counts
 *   GET    /activity?assistantId=   — recent inter-assistant interactions
 *
 * The discovery/social write surface (follow, block/unblock, remove-follower,
 * note, mutuals, pending-outgoing) was removed with the sharing_mode teardown —
 * it had no frontend caller and POST /follow gated on the dropped column. See
 * docs/plans/network-feature-teardown.md.
 */

import { Router } from 'express'
import { query } from '../db/client.js'
import { requireAssistantMember } from './route-helpers.js'
import type { ConnectionStore } from '../db/connection-store.js'

type ConnectionRouteOptions = {
  connectionStore: ConnectionStore
}

export function connectionRoutes({ connectionStore }: ConnectionRouteOptions): Router {
  const router = Router()

  // ── POST /unfollow ───────────────────────────────────────────

  router.post('/unfollow', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { followerAssistantId, followingAssistantId } = req.body as {
      followerAssistantId?: string
      followingAssistantId?: string
    }
    if (!followerAssistantId || !followingAssistantId) {
      res.status(400).json({ error: 'followerAssistantId and followingAssistantId are required' })
      return
    }
    if (!(await requireAssistantMember(userId, followerAssistantId, res))) return

    try {
      await connectionStore.unfollow(followerAssistantId, followingAssistantId)
      res.json({ ok: true })
    } catch (err) {
      console.error('[connections] unfollow failed:', err)
      res.status(500).json({ error: 'Failed to unfollow' })
    }
  })

  // ── POST /:id/accept ────────────────────────────────────────

  router.post('/:id/accept', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    // Optional mode_id binds the connection to a destination-side mode at
    // accept time. Omit / null = free (full access). Per migration plan
    // decision #3.
    const modeIdRaw = (req.body as { modeId?: unknown } | undefined)?.modeId
    const modeId =
      typeof modeIdRaw === 'string' && modeIdRaw.length > 0 ? modeIdRaw : null

    // Ownership gate: only the owner of the assistant BEING FOLLOWED may
    // accept its pending requests. The store mutates by id alone (no owner
    // predicate), so without this a follower could self-approve a follow of
    // another user's private assistant and gain A2A read access. Mirrors the
    // follower-side check in POST /:id/note (which uses follower_assistant_id).
    const target = await query<{ followingAssistantId: string }>(
      `SELECT following_assistant_id AS "followingAssistantId"
       FROM assistant_connections WHERE id = $1`,
      [req.params.id],
    )
    if (target.rows.length === 0) {
      res.status(404).json({ error: 'Pending request not found' })
      return
    }
    if (!(await requireAssistantMember(userId, target.rows[0].followingAssistantId, res))) return

    try {
      const connection = await connectionStore.acceptRequest(req.params.id, modeId)
      if (!connection) {
        res.status(404).json({ error: 'Pending request not found' })
        return
      }
      res.json(connection)
    } catch (err) {
      console.error('[connections] accept failed:', err)
      res.status(500).json({ error: 'Failed to accept' })
    }
  })

  // ── POST /:id/reject ────────────────────────────────────────

  router.post('/:id/reject', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    // Ownership gate (see /:id/accept): only the owner of the assistant being
    // followed may reject its pending requests — otherwise any authenticated
    // user who learns a connection id could deny others' pending requests.
    const target = await query<{ followingAssistantId: string }>(
      `SELECT following_assistant_id AS "followingAssistantId"
       FROM assistant_connections WHERE id = $1`,
      [req.params.id],
    )
    if (target.rows.length === 0) {
      res.status(404).json({ error: 'Pending request not found' })
      return
    }
    if (!(await requireAssistantMember(userId, target.rows[0].followingAssistantId, res))) return

    try {
      const rejected = await connectionStore.rejectRequest(req.params.id)
      if (!rejected) {
        res.status(404).json({ error: 'Pending request not found' })
        return
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[connections] reject failed:', err)
      res.status(500).json({ error: 'Failed to reject' })
    }
  })

  // ── GET /following ───────────────────────────────────────────

  router.get('/following', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const assistantId = req.query.assistantId as string
    if (!assistantId) { res.status(400).json({ error: 'assistantId required' }); return }
    if (!(await requireAssistantMember(userId, assistantId, res))) return
    try {
      const connections = await connectionStore.getFollowing(assistantId)
      res.json({ connections })
    } catch (err) {
      console.error('[connections] following failed:', err)
      res.status(500).json({ error: 'Failed to list' })
    }
  })

  // ── GET /followers ───────────────────────────────────────────

  router.get('/followers', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const assistantId = req.query.assistantId as string
    if (!assistantId) { res.status(400).json({ error: 'assistantId required' }); return }
    if (!(await requireAssistantMember(userId, assistantId, res))) return
    try {
      const connections = await connectionStore.getFollowers(assistantId)
      res.json({ connections })
    } catch (err) {
      console.error('[connections] followers failed:', err)
      res.status(500).json({ error: 'Failed to list' })
    }
  })

  // ── GET /pending ─────────────────────────────────────────────

  router.get('/pending', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const assistantId = req.query.assistantId as string
    if (!assistantId) { res.status(400).json({ error: 'assistantId required' }); return }
    if (!(await requireAssistantMember(userId, assistantId, res))) return
    try {
      const connections = await connectionStore.getPendingRequests(assistantId)
      res.json({ connections })
    } catch (err) {
      console.error('[connections] pending failed:', err)
      res.status(500).json({ error: 'Failed to list' })
    }
  })

  // ── GET /counts ──────────────────────────────────────────────

  router.get('/counts', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const assistantId = req.query.assistantId as string
    if (!assistantId) { res.status(400).json({ error: 'assistantId required' }); return }
    try {
      const [followers, following] = await Promise.all([
        connectionStore.followerCount(assistantId),
        connectionStore.followingCount(assistantId),
      ])
      res.json({ followers, following })
    } catch (err) {
      console.error('[connections] counts failed:', err)
      res.status(500).json({ error: 'Failed to get counts' })
    }
  })

  // ── GET /activity — recent inter-assistant interactions ────────

  router.get('/activity', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const assistantId = req.query.assistantId as string
    if (!assistantId) { res.status(400).json({ error: 'assistantId required' }); return }
    if (!(await requireAssistantMember(userId, assistantId, res))) return

    try {
      const result = await query<{
        sessionId: string
        channelId: string
        role: string
        text: string
        createdAt: string
      }>(
        `SELECT s.id AS "sessionId", s.channel_id AS "channelId",
                sm.role, sm.created_at AS "createdAt",
                (SELECT string_agg(b->>'text', ' ')
                 FROM jsonb_array_elements(sm.content::jsonb) b
                 WHERE b->>'type' = 'text') AS text
         FROM session_messages sm
         JOIN sessions s ON s.id = sm.session_id
         WHERE s.assistant_id = $1
           AND s.channel_type = 'assistant-call'
           AND s.channel_id NOT LIKE 'snapshot-%'
         ORDER BY sm.created_at DESC
         LIMIT 30`,
        [assistantId],
      )

      // Group by session, enrich with caller info
      const sessions = new Map<string, { channelId: string; messages: typeof result.rows }>()
      for (const row of result.rows) {
        if (!sessions.has(row.sessionId)) {
          sessions.set(row.sessionId, { channelId: row.channelId, messages: [] })
        }
        sessions.get(row.sessionId)!.messages.push(row)
      }

      // Resolve caller assistant names
      const activity = await Promise.all(
        Array.from(sessions.entries()).map(async ([sessionId, { channelId, messages }]) => {
          let callerName = 'Unknown'
          let callerHandle: string | null = null
          let callerIconSeed: number | undefined = undefined
          let callerAssistId: string = channelId
          try {
            // channelId format: "callerAssistantId:timestamp" or plain UUID
            const callerAssistantId = channelId.includes(':') ? channelId.split(':')[0] : channelId
            const caller = await query<{ name: string; handle: string; iconSeed: number | null; assistantId: string }>(
              `SELECT a.name, u.handle, a.icon_seed AS "iconSeed", a.id AS "assistantId" FROM assistants a JOIN users u ON u.id = a.owner_user_id WHERE a.id = $1`,
              [callerAssistantId],
            )
            callerName = caller.rows[0]?.name ?? 'Unknown'
            callerHandle = caller.rows[0]?.handle ?? null
            callerIconSeed = caller.rows[0]?.iconSeed ?? undefined
            callerAssistId = caller.rows[0]?.assistantId ?? channelId
          } catch { /* ignore — use defaults */ }
          return {
            sessionId,
            callerName,
            callerHandle,
            callerIconSeed,
            callerAssistantId: callerAssistId,
            messages: messages.reverse().map((m) => ({
              role: m.role,
              text: m.text ?? '',
              createdAt: m.createdAt,
            })),
          }
        }),
      )

      res.json({ activity })
    } catch (err) {
      console.error('[connections] activity failed:', err)
      res.status(500).json({ error: 'Failed to get activity' })
    }
  })

  return router
}
