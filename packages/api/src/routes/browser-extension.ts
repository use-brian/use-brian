import { Router } from 'express'
import { z } from 'zod'
import { signBrowserExtPairToken } from '../auth/browser-ext-pair-token.js'

/**
 * Browser-extension pairing (computer-use.md §4, P1.3): an authed user mints
 * a short-lived pairing token bound to `{userId, workspaceId}`, pastes it
 * into the extension popup, and the extension `hello`s the relay with it.
 * Mounted behind `requireAuth` in boot.
 */

type WorkspaceMembershipCheck = {
  getMembership(userId: string, workspaceId: string): Promise<unknown | null>
}

export function browserExtensionRoutes(deps: {
  jwtSecret: string
  workspaceStore: WorkspaceMembershipCheck
  /** Relay websocket URL the extension should connect to (shown in the UI). */
  relayWsUrl: string | null
  /** Live "is this user's extension connected" probe; null when no relay is configured. */
  extensionConnected: ((userId: string) => Promise<boolean>) | null
}): Router {
  const router = Router()

  const PairBodySchema = z.object({ workspaceId: z.string().uuid() })

  router.post('/pair', async (req, res) => {
    const userId = req.userId as string
    const parsed = PairBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'workspaceId (uuid) is required' })
      return
    }
    if (!deps.relayWsUrl) {
      res.status(503).json({
        error: 'The browser extension relay is not configured on this deployment.',
      })
      return
    }
    const membership = await deps.workspaceStore.getMembership(userId, parsed.data.workspaceId)
    if (!membership) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }
    const pairingToken = signBrowserExtPairToken(
      { userId, workspaceId: parsed.data.workspaceId },
      deps.jwtSecret,
    )
    res.json({ pairingToken, relayUrl: deps.relayWsUrl, expiresInSeconds: 600 })
  })

  router.get('/status', async (req, res) => {
    const userId = req.userId as string
    if (!deps.extensionConnected) {
      res.json({ configured: false, connected: false })
      return
    }
    res.json({ configured: true, connected: await deps.extensionConnected(userId) })
  })

  return router
}
