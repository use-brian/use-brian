import { Router } from 'express'
import { z } from 'zod'
import type { BrowserProfileStore } from '@use-brian/core'
import { signBrowserExtPairToken } from '../auth/browser-ext-pair-token.js'

/**
 * Browser-extension pairing (computer-use.md §4, P1.3): an authed user mints
 * a short-lived pairing token bound to `{userId, workspaceId,
 * browserProfileId}`, pastes it
 * into the extension popup, and the extension `hello`s the relay with it.
 * Mounted behind `requireAuth` in boot.
 */

type WorkspaceMembershipCheck = {
  getMembership(userId: string, workspaceId: string): Promise<unknown | null>
}

export function browserExtensionRoutes(deps: {
  jwtSecret: string
  workspaceStore: WorkspaceMembershipCheck
  profileStore: BrowserProfileStore | null
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
    | ((
        userId: string,
        options: { browserProfileId?: string; workspaceId?: string },
      ) => Promise<{ connected: boolean; build: string | null; staleBuild: boolean } | null>)
    | null
}): Router {
  const router = Router()

  const PairBodySchema = z.object({
    workspaceId: z.string().uuid(),
    browserProfileId: z.string().min(1).max(64).optional(),
  })

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
    if (!deps.profileStore) {
      res.status(501).json({ error: 'Browser profiles are not configured on this deployment.' })
      return
    }
    let profile = parsed.data.browserProfileId
      ? await deps.profileStore.get(parsed.data.browserProfileId)
      : null
    if (!parsed.data.browserProfileId) {
      const candidates = (await deps.profileStore.list({ workspaceId: parsed.data.workspaceId })).filter(
        (item) => item.ownerUserId === userId && item.defaultBackend === 'local',
      )
      if (candidates.length !== 1) {
        res.status(409).json({
          error: 'Choose the Browser profile this local browser should connect to.',
          code: 'profile_required',
        })
        return
      }
      profile = candidates[0]
    }
    if (
      !profile ||
      profile.workspaceId !== parsed.data.workspaceId ||
      profile.ownerUserId !== userId
    ) {
      res.status(404).json({ error: 'No such browser profile (or it is not yours to pair).' })
      return
    }
    const pairingToken = signBrowserExtPairToken(
      { userId, workspaceId: parsed.data.workspaceId, browserProfileId: profile.id },
      deps.jwtSecret,
    )
    res.json({
      pairingToken,
      relayUrl: deps.relayWsUrl,
      browserProfileId: profile.id,
      expiresInSeconds: 600,
    })
  })

  router.get('/status', async (req, res) => {
    const userId = req.userId as string
    if (!deps.extensionStatus) {
      res.json({ configured: false, connected: false, build: null, staleBuild: false })
      return
    }
    const browserProfileId =
      typeof req.query.browserProfileId === 'string' ? req.query.browserProfileId : undefined
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined
    let profileWorkspaceId: string | undefined
    if (browserProfileId) {
      const profile = await deps.profileStore?.get(browserProfileId)
      if (!profile || profile.ownerUserId !== userId || (workspaceId && profile.workspaceId !== workspaceId)) {
        res.status(404).json({ error: 'No such browser profile (or it is not yours to inspect).' })
        return
      }
      profileWorkspaceId = profile.workspaceId
    }
    const membershipWorkspaceId = workspaceId ?? profileWorkspaceId
    if (membershipWorkspaceId) {
      const membership = await deps.workspaceStore.getMembership(userId, membershipWorkspaceId)
      if (!membership) {
        res.status(403).json({ error: 'Not a member of this workspace' })
        return
      }
    }
    const status = await deps.extensionStatus(userId, {
      browserProfileId,
      workspaceId: membershipWorkspaceId,
    })
    res.json({
      configured: true,
      connected: status?.connected === true,
      build: status?.build ?? null,
      staleBuild: status?.staleBuild === true,
    })
  })

  return router
}
