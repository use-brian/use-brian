import { Router } from 'express'
import { z } from 'zod'
import type {
  BrowserProfileStore,
  BrowserSkillGrantStore,
  BrowserSkillStore,
  SandboxOrchestrator,
  SandboxProvider,
  SessionVault,
} from '@sidanclaw/core'

/**
 * Computer-use web surface (computer-use.md §5, §7):
 *
 *  - the Take-Over live view's backend — frame polling + input relay +
 *    capture/resume around an interactive login (§4.8);
 *  - the live backend toggle (R2-3) — a per-session flip between the cloud
 *    sandbox and the user's own browser;
 *  - Profile-Management (R2-4) — create / share / enable-per-assistant /
 *    default-backend / per-site session revoke over `browser_profiles`.
 *
 * Mounted behind `requireAuth` in boot. Every task route checks the task
 * belongs to the caller; profile mutations are owner-only, reads are
 * workspace-member (existence is always governance-visible, R2-4).
 */

const InputEventSchema = z.union([
  z.object({ kind: z.literal('click'), x: z.number(), y: z.number() }),
  z.object({ kind: z.literal('key'), text: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('scroll'), deltaY: z.number() }),
])

const ClearanceSchema = z.enum(['public', 'internal', 'confidential'])
const BackendSchema = z.enum(['local', 'cloud'])

const CreateProfileSchema = z.object({
  workspaceId: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  clearance: ClearanceSchema.optional(),
  defaultBackend: BackendSchema.optional(),
  proxyUrl: z.string().url().max(1024).nullish(),
})

const UpdateProfileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  clearance: ClearanceSchema.optional(),
  defaultBackend: BackendSchema.optional(),
  proxyUrl: z.string().url().max(1024).nullish().optional(),
  enabledAssistantIds: z.array(z.string().min(1).max(64)).max(200).optional(),
})

export function computerRoutes(deps: {
  orchestrator: SandboxOrchestrator | null
  provider: SandboxProvider | null
  vault: SessionVault | null
  /** Closed store; null → the Profile-Management surface reports unconfigured. */
  profileStore: BrowserProfileStore | null
  /** Block-scoped grants (R2-2) — listed + revocable per profile. */
  grants?: BrowserSkillGrantStore | null
  /** Skill lookups so a grant row can show its block's name. */
  skills?: BrowserSkillStore | null
  /** Workspace-membership check (existence reads are member-visible). */
  getWorkspaceRole: (userId: string, workspaceId: string) => Promise<string | null>
  /** The live backend toggle (R2-3) — flips the session's browse backend. */
  setSessionBackend?: (sessionId: string, backend: 'local' | 'cloud' | null) => void
}): Router {
  const router = Router()

  async function ownedTask(sessionId: string, userId: string) {
    if (!deps.orchestrator) return null
    const task = await deps.orchestrator.getActiveTask(sessionId)
    if (!task || task.userId !== userId) return null
    return task
  }

  router.get('/tasks/:sessionId', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    res.json({
      taskId: task.taskId,
      status: task.status,
      profileId: task.profileId,
      injectedSite: task.injectedSite,
      workspaceId: task.workspaceId,
      createdAt: task.createdAt,
    })
  })

  // The live view opening = the user arrived for the Take-Over → resume the
  // paused sandbox (§4.8: pause covers the WAIT, not the takeover itself).
  router.post('/tasks/:sessionId/resume', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task || !deps.orchestrator) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    await deps.orchestrator.resumeAfterTakeover(req.params.sessionId)
    res.json({ ok: true })
  })

  // Screencast frame poll (~1 fps from the client). Polling over SSE keeps
  // Cloud Run connection lifetimes trivial at the takeover's low frame rate.
  router.get('/tasks/:sessionId/frame', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task || !deps.provider) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    try {
      const takeover = deps.provider.browser(task.sandboxId).takeover()
      const frame = await takeover.nextFrame()
      await takeover.close()
      if (!frame) {
        res.status(204).end()
        return
      }
      res.json(frame)
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'frame capture failed' })
    }
  })

  router.post('/tasks/:sessionId/input', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task || !deps.provider) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    const parsed = InputEventSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input event' })
      return
    }
    try {
      const takeover = deps.provider.browser(task.sandboxId).takeover()
      await takeover.input(parsed.data)
      await takeover.close()
      res.json({ ok: true })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'input relay failed' })
    }
  })

  // "I signed in" — capture the authenticated session into the PROFILE's
  // vault (§4.4, R2-4) so every later task on this site skips the login.
  // A task that started identity-less must name the profile to bind.
  router.post('/tasks/:sessionId/captured', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task || !deps.orchestrator) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    const body = z
      .object({ site: z.string().min(1).max(253), profileId: z.string().min(1).max(64).optional() })
      .safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'site is required' })
      return
    }
    if (!task.profileId && !body.data.profileId) {
      res.status(409).json({
        error: 'This task has no browser profile — pick or create one to save the session into.',
        code: 'profile_required',
      })
      return
    }
    try {
      await deps.orchestrator.captureSession(req.params.sessionId, body.data.site, body.data.profileId)
      res.json({ ok: true })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'session capture failed' })
    }
  })

  // Close-to-stop (§4.15/§4.8): ends the task now — capture + pull + kill.
  router.post('/tasks/:sessionId/complete', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task || !deps.orchestrator) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    const outcome = req.body?.outcome === 'failed' ? 'failed' : 'completed'
    const done = await deps.orchestrator.completeTask(req.params.sessionId, outcome)
    res.json({ ok: true, status: done?.status ?? outcome })
  })

  // The live backend toggle (R2-3): the user's flip wins for this chat
  // session; null clears back to the profile default. In-memory,
  // api-instance-local — an honest 501 when boot wired no toggle.
  router.post('/sessions/:sessionId/backend', async (req, res) => {
    if (!deps.setSessionBackend) {
      res.status(501).json({ error: 'The backend toggle is not available on this deployment' })
      return
    }
    const body = z.object({ backend: BackendSchema.nullable() }).safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'backend must be "local", "cloud", or null' })
      return
    }
    deps.setSessionBackend(req.params.sessionId, body.data.backend)
    res.json({ ok: true, backend: body.data.backend })
  })

  // ── Profile-Management (R2-4) ────────────────────────────────

  async function requireMember(userId: string, workspaceId: string): Promise<boolean> {
    try {
      return (await deps.getWorkspaceRole(userId, workspaceId)) !== null
    } catch {
      return false
    }
  }

  router.get('/profiles', async (req, res) => {
    const workspaceId = String(req.query.workspaceId ?? '')
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }
    if (!deps.profileStore) {
      res.json({ configured: false, profiles: [] })
      return
    }
    if (!(await requireMember(req.userId as string, workspaceId))) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }
    const profiles = await deps.profileStore.list({ workspaceId })
    const withSessions = await Promise.all(
      profiles.map(async (p) => {
        const grants = deps.grants
          ? (await deps.grants.list({ workspaceId, profileId: p.id }).catch(() => [])).filter(
              (g) => g.status === 'active',
            )
          : []
        const namedGrants = await Promise.all(
          grants.map(async (g) => ({
            id: g.id,
            skillId: g.skillId,
            skillName: deps.skills ? ((await deps.skills.get(g.skillId).catch(() => null))?.name ?? g.skillId) : g.skillId,
            createdAt: g.createdAt,
            lastUsedAt: g.lastUsedAt,
          })),
        )
        return {
          ...p,
          sessions: deps.vault ? await deps.vault.list({ profileId: p.id }).catch(() => []) : [],
          grants: namedGrants,
        }
      }),
    )
    res.json({ configured: true, profiles: withSessions })
  })

  router.post('/profiles', async (req, res) => {
    if (!deps.profileStore) {
      res.status(501).json({ error: 'Browser profiles are not configured on this deployment' })
      return
    }
    const body = CreateProfileSchema.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'Invalid profile' })
      return
    }
    if (!(await requireMember(req.userId as string, body.data.workspaceId))) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }
    try {
      const profile = await deps.profileStore.create({
        workspaceId: body.data.workspaceId,
        ownerUserId: req.userId as string,
        name: body.data.name,
        clearance: body.data.clearance,
        defaultBackend: body.data.defaultBackend,
        proxyUrl: body.data.proxyUrl ?? null,
      })
      res.json({ profile })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'create failed'
      if (/unique|duplicate/i.test(message)) {
        res.status(409).json({ error: 'A profile with this name already exists' })
        return
      }
      res.status(500).json({ error: message })
    }
  })

  /** Profile mutations are OWNER-only — the identity belongs to its owner. */
  async function ownedProfile(profileId: string, userId: string) {
    if (!deps.profileStore) return null
    const profile = await deps.profileStore.get(profileId)
    if (!profile || profile.ownerUserId !== userId) return null
    return profile
  }

  router.patch('/profiles/:id', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile || !deps.profileStore) {
      res.status(404).json({ error: 'No such profile (or not yours to change)' })
      return
    }
    const body = UpdateProfileSchema.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'Invalid profile update' })
      return
    }
    const updated = await deps.profileStore.update(req.params.id, body.data)
    res.json({ profile: updated })
  })

  router.delete('/profiles/:id', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile || !deps.profileStore) {
      res.status(404).json({ error: 'No such profile (or not yours to delete)' })
      return
    }
    await deps.profileStore.delete(req.params.id)
    res.json({ ok: true })
  })

  // Revoke one site's session inside a profile (the cookie jar keeps the rest).
  router.delete('/profiles/:id/sessions/:site', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile || !deps.vault) {
      res.status(404).json({ error: 'No such profile (or not yours to change)' })
      return
    }
    await deps.vault.revoke({ profileId: req.params.id, site: req.params.site })
    res.json({ ok: true })
  })

  // Revoke a standing block grant on a profile (R2-2: revocable here).
  router.delete('/profiles/:id/grants/:grantId', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile || !deps.grants) {
      res.status(404).json({ error: 'No such profile (or not yours to change)' })
      return
    }
    const grants = await deps.grants.list({
      workspaceId: profile.workspaceId,
      profileId: profile.id,
    })
    if (!grants.some((g) => g.id === req.params.grantId)) {
      res.status(404).json({ error: 'No such grant on this profile' })
      return
    }
    await deps.grants.revoke(req.params.grantId)
    res.json({ ok: true })
  })

  return router
}
