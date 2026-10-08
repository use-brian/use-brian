import { Router } from 'express'
import { z } from 'zod'
import type { BrowserProfile, BrowserProfileStore, DepartmentReadGrant } from '@use-brian/core'
import { humanCanReadBrowserProfile } from '../sandbox/profile-authority.js'
import { signBrowserExtPairToken, verifyBrowserExtHelloToken } from '../auth/browser-ext-pair-token.js'

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

/** Token-specific admission: mount before ordinary user-JWT middleware. */
export function browserExtensionAuthorityRoutes(deps: {
  jwtSecret: string
  workspaceStore: WorkspaceMembershipCheck
  profileStore: BrowserProfileStore | null
  getProfileReadGrant: (userId: string, workspaceId: string) => Promise<DepartmentReadGrant | null>
}): Router {
  const router = Router()
  router.post('/authority', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    const authorization = req.headers.authorization
    const identity = authorization?.startsWith('Bearer ')
      ? verifyBrowserExtHelloToken(authorization.slice(7), deps.jwtSecret) : null
    if (!identity) { res.status(401).json({ code: 'not_authorized' }); return }
    try {
      const profile = await deps.profileStore?.get(identity.browserProfileId)
      if (!profile || profile.workspaceId !== identity.workspaceId || profile.ownerUserId !== identity.userId
        || !(await deps.workspaceStore.getMembership(identity.userId, identity.workspaceId))
        || !humanCanReadBrowserProfile(profile, identity.userId,
          await deps.getProfileReadGrant(identity.userId, identity.workspaceId))) {
        res.status(403).json({ code: 'not_authorized' }); return
      }
      res.sendStatus(204)
    } catch {
      res.status(403).json({ code: 'not_authorized' })
    }
  })
  return router
}

export function browserExtensionRoutes(deps: {
  jwtSecret: string
  workspaceStore: WorkspaceMembershipCheck
  profileStore: BrowserProfileStore | null
  getProfileReadGrant?: (userId: string, workspaceId: string) => Promise<DepartmentReadGrant | null>
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

  async function admittedOwner(profile: BrowserProfile, userId: string): Promise<boolean> {
    if (profile.ownerUserId !== userId) return false
    try {
      if (!(await deps.workspaceStore.getMembership(userId, profile.workspaceId))) return false
      return humanCanReadBrowserProfile(profile, userId, await deps.getProfileReadGrant?.(userId, profile.workspaceId))
    } catch {
      return false
    }
  }

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
      const owned = (await deps.profileStore.list({ workspaceId: parsed.data.workspaceId })).filter(
        (item) => item.ownerUserId === userId && item.defaultBackend === 'local',
      )
      const candidates = (await Promise.all(owned.map(async (item) =>
        await admittedOwner(item, userId) ? item : null))).filter((item) => item !== null)
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
      !(await admittedOwner(profile, userId))
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
    if (!browserProfileId) {
      res.json({ configured: true, connected: false, build: null, staleBuild: false })
      return
    }
    let profileWorkspaceId: string | undefined
    if (browserProfileId) {
      const profile = await deps.profileStore?.get(browserProfileId)
      if (!profile || (workspaceId && profile.workspaceId !== workspaceId) || !(await admittedOwner(profile, userId))) {
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
    const current = await deps.profileStore?.get(browserProfileId).catch(() => null)
    if (!current || current.workspaceId !== membershipWorkspaceId || !(await admittedOwner(current, userId))) {
      res.status(404).json({ error: 'No such browser profile (or it is not yours to inspect).' })
      return
    }
    res.json({
      configured: true,
      connected: status?.connected === true,
      build: status?.build ?? null,
      staleBuild: status?.staleBuild === true,
    })
  })

  return router
}
