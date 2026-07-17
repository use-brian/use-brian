/**
 * Leave-group endpoint. The API calls this when the official bot is added to a
 * group whose adder cannot be resolved to a Use Brian account — the bot leaves
 * rather than ingest a group it cannot attribute.
 *
 * See docs/architecture/channels/whatsapp.md -> "Official bot - group ingest".
 */

import { Router } from 'express'
import type { SocketManager } from '../socket-manager.js'

export function leaveRoutes(socketManager: SocketManager): Router {
  const router = Router()

  router.post('/:channelId', async (req, res) => {
    const groupJid = (req.body as { groupJid?: unknown })?.groupJid
    if (typeof groupJid !== 'string' || !groupJid) {
      res.status(400).json({ error: 'groupJid is required' })
      return
    }
    try {
      await socketManager.groupLeave(req.params.channelId, groupJid)
      res.json({ ok: true })
    } catch (err) {
      res.status(409).json({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  return router
}
