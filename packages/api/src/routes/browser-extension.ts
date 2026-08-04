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
  /**
   * Live probe of this user's extension connection; null when no relay is
   * configured. Returns the whole status rather than a bare boolean so the
   * connect surface can report a stale build — an extension that is connected
   * and out of date looks identical to a healthy one through a boolean.
   * Null result means the relay itself was unreachable; never infer a
   * disconnect from that.
   */
  extensionStatus:
    | ((userId: string) => Promise<{ connected: boolean; build: string | null; staleBuild: boolean } | null>)
    | null
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
    if (!deps.extensionStatus) {
      res.json({ configured: false, connected: false, build: null, staleBuild: false })
      return
    }
    const status = await deps.extensionStatus(userId)
    res.json({
      configured: true,
      connected: status?.connected === true,
      build: status?.build ?? null,
      staleBuild: status?.staleBuild === true,
    })
  })

  return router
}
