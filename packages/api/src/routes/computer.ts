import { assertBrowserTaskPublication, browserPublicationBusy, type BrowserTaskPublication } from '@use-brian/core'
import { assertLocalTaskExecutionAuthority } from '../sandbox/local-task-authority.js'
import { parseBrowserInputScope, mergeBrowserInputScope, type BrowserInputScope } from '@use-brian/core'
import type { BrowserTaskDiscard } from '../sandbox/task-discard.js'
import { humanCanReadBrowserProfile } from '../sandbox/profile-authority.js'
import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { AuthoritySourceSchema, parseAuthoringAuthority, BrowserBackendError, BrowserProfileAuthoritySchema, createCloudBrowserProvider, registrableSiteOf } from '@use-brian/core'
import type {
  AuthoringAuthority,
  AuthoritySource,
  CurrentAuthorityBoundary,
  BrowserBackendErrorCode,
  BrowserProfile,
  BrowserProfileAuthority,
  DepartmentReadGrant,
  BrowserAuthBroker,
  BrowserCredentialAdminStore,
  BrowserProfileStore,
  BrowserProvider,
  BrowserSkillGrantStore,
  BrowserSkillStore,
  SandboxOrchestrator,
  SandboxProvider,
  SessionVault,
  SandboxTaskRecord,
} from '@use-brian/core'

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
 * belongs to the caller; profile mutations are owner-only and all profile reads/mutations retain
 * current membership and department authority.
 */

const InputEventSchema = z.union([
  z.object({
    kind: z.literal('click'),
    x: z.number(),
    y: z.number(),
    frameW: z.number().positive().optional(),
    frameH: z.number().positive().optional(),
  }),
  z.object({
    kind: z.literal('pointer'),
    action: z.enum(['down', 'move', 'up']),
    x: z.number(),
    y: z.number(),
    frameW: z.number().positive().optional(),
    frameH: z.number().positive().optional(),
  }),
  z.object({ kind: z.literal('key'), text: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('scroll'), deltaY: z.number() }),
  // Take-over toolbar navigation (§5): goto must carry an http(s) url — the
  // seam re-validates, but a bad scheme is rejected here first.
  z
    .object({
      kind: z.literal('navigate'),
      action: z.enum(['back', 'forward', 'reload', 'goto']),
      url: z.string().url().max(2048).optional(),
    })
    .refine((e) => e.action !== 'goto' || (!!e.url && /^https?:\/\//i.test(e.url)), {
      message: 'goto requires an http(s) url',
    }),
])

const ClearanceSchema = z.enum(['public', 'internal', 'confidential'])
/** WHOSE turns may use the profile, independent of the rung (migration 451). */
const ScopeSchema = z.enum(['owner', 'workspace'])
const BackendSchema = z.enum(['local', 'cloud'])
const AssistantRoutingNotesSchema = z
  .record(
    z.string().min(1).max(64),
    z.string().min(1).max(500).refine((note) => note === note.trim()),
  )
  .refine((notes) => Object.keys(notes).length <= 200)

const TERMINAL_LOCAL_ERROR_CODES = new Set([
  'stopped',
  'tab_closed',
])
const ALREADY_STOPPED_LOCAL_ERROR_CODES = new Set([
  ...TERMINAL_LOCAL_ERROR_CODES,
])

function isTerminalLocalTaskError(error: unknown): boolean {
  return error instanceof BrowserBackendError && TERMINAL_LOCAL_ERROR_CODES.has(error.code)
}

function isAlreadyStoppedLocalTaskError(error: unknown): boolean {
  return error instanceof BrowserBackendError && ALREADY_STOPPED_LOCAL_ERROR_CODES.has(error.code)
}

// Local session capture (D5, browser-session-portability.md): each refusal
// the extension/relay can report reaches the caller as ITS OWN status and
// message — "no extension" and "wrong tab's site" must stay distinguishable,
// never flattened into one generic capture failure. Anything not listed here
// (timeout, stopped, tab_closed, consent_denied, the Firefox codes,
// backend_error) is a transient backend fault, same as every other relay op
// in this file.
const CAPTURE_ERROR_STATUS: Partial<Record<BrowserBackendErrorCode, number>> = {
  not_configured: 501,
  no_extension: 409,
  no_eligible_tab: 409,
  site_mismatch: 409,
  detached: 409,
}

function captureErrorResponse(err: unknown): { status: number; error: string; code?: string } {
  if (err && typeof err === 'object' && (('code' in err && err.code === 'profile_authority_denied') || ('reason' in err && err.reason === 'authority_changed'))) {
    return { status: 403, error: 'Profile authority unavailable.', code: 'not_authorized' }
  }
  if (err instanceof BrowserBackendError) {
    return { status: CAPTURE_ERROR_STATUS[err.code] ?? 502, error: err.message, code: err.code }
  }
  return { status: 502, error: err instanceof Error ? err.message : 'session capture failed' }
}

export type LocalComputerTaskRecord = {
  taskId: string
  userId: string
  workspaceId: string
  sessionId: string
  status: 'running'
  profileId: string | null
  profileAuthority?: BrowserProfileAuthority | null
  executionAuthority?: AuthoringAuthority | null
  sourceAuthority?: AuthoritySource | null
  inputScope?: BrowserInputScope | null
  /** Original host-owned lease; never serialized onto the wire. */
  authority?: CurrentAuthorityBoundary
  injectedSite: string | null
  destinationOrigin?: string | null
  createdAt: number
  lastActivityAt: number
}

export type LocalComputerTaskStore = {
  withPublication<T>(expected: BrowserTaskPublication, operation: () => Promise<T>): Promise<T>
  noteInputScope(sessionId: string, expectedTaskId: string, input: BrowserInputScope): void
  touch(
    context: {
      userId: string
      workspaceId?: string | null
      sessionId: string
      profileId?: string | null
      profileAuthority?: BrowserProfileAuthority | null
      executionAuthority?: AuthoringAuthority | null
      sourceAuthority?: AuthoritySource | null
      inputScope?: BrowserInputScope | null
      authority?: CurrentAuthorityBoundary
    },
    site?: string | null,
    destinationOrigin?: string | null,
  ): void
  getActiveBySession(sessionId: string): LocalComputerTaskRecord | null
  listActiveByWorkspace(workspaceId: string): LocalComputerTaskRecord[]
  complete(sessionId: string, expectedTaskId?: string): void
}

const LOCAL_TASK_TTL_MS = 20 * 60 * 1000

/** Process-local by design: the extension/tab binding is itself ephemeral. */
export function createInMemoryLocalComputerTaskStore(now: () => number = Date.now): LocalComputerTaskStore {
  const tasks = new Map<string, LocalComputerTaskRecord>()
  const publishing = new Set<string>()
  const mutable = (task: LocalComputerTaskRecord | undefined) => { if (task && publishing.has(task.taskId)) throw browserPublicationBusy() }
  const active = (task: LocalComputerTaskRecord) => now() - task.lastActivityAt < LOCAL_TASK_TTL_MS
  const prune = () => {
    for (const [sessionId, task] of tasks) if (!active(task) && !publishing.has(task.taskId)) tasks.delete(sessionId)
  }
  return {
    async withPublication(expected, operation) {
      prune()
      const task = tasks.get(expected.sessionId)
      mutable(task)
      assertBrowserTaskPublication(expected, task ?? null)
      publishing.add(expected.taskId)
      try { return await operation() } finally { publishing.delete(expected.taskId) }
    },
    noteInputScope(sessionId, expectedTaskId, input) {
      prune()
      const task = tasks.get(sessionId)
      mutable(task)
      if (!task || task.taskId !== expectedTaskId) throw Object.assign(new Error('Task unavailable'), { code: 'profile_authority_denied' })
      task.inputScope = mergeBrowserInputScope(task.inputScope, input, task.workspaceId)
    },
    touch(context, site, destinationOrigin) {
      if (!context.workspaceId) return
      prune()
      const profileId = context.profileId ?? null
      const previous = tasks.get(context.sessionId)
      mutable(previous)
      for (const task of tasks.values()) {
        if (task.userId === context.userId && task.profileId === profileId) mutable(task)
      }
      if (previous && (previous.profileId !== profileId || previous.userId !== context.userId
        || previous.workspaceId !== context.workspaceId)) return
      const existing = previous
      const executionAuthority = existing ? existing.executionAuthority ?? null : parseAuthoringAuthority(context.executionAuthority)
      if (!existing && ((context.executionAuthority && (!executionAuthority || !context.authority))
        || (context.sourceAuthority && !executionAuthority))) throw Object.assign(new Error('Task authority unavailable'), { code: 'profile_authority_denied' })
      const sourceAuthority = existing ? existing.sourceAuthority ?? null
        : context.sourceAuthority ? AuthoritySourceSchema.parse(context.sourceAuthority) : null
      const inputScope = existing ? mergeBrowserInputScope(existing.inputScope, context.inputScope, context.workspaceId)
        : context.inputScope ? parseBrowserInputScope(context.inputScope, context.workspaceId) : null
      // One extension connection controls one consented tab per PROFILE. A
      // newer task adopts that profile's tab; other paired profiles stay live.
      for (const [sessionId, task] of tasks) {
        if (
          task.userId === context.userId &&
          task.profileId === profileId &&
          sessionId !== context.sessionId
        ) {
          tasks.delete(sessionId)
        }
      }
      tasks.set(context.sessionId, {
        taskId: existing?.taskId ?? `local-${randomUUID()}`,
        userId: context.userId,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        status: 'running',
        profileId,
        profileAuthority: existing ? existing.profileAuthority ?? null
          : BrowserProfileAuthoritySchema.safeParse(context.profileAuthority).data ?? null,
        executionAuthority,
        sourceAuthority,
        inputScope,
        authority: existing ? existing.authority : context.authority,
        injectedSite: site ?? existing?.injectedSite ?? null,
        destinationOrigin: destinationOrigin === undefined ? existing?.destinationOrigin ?? null : destinationOrigin,
        createdAt: existing?.createdAt ?? now(),
        lastActivityAt: now(),
      })
    },
    getActiveBySession(sessionId) {
      prune()
      return tasks.get(sessionId) ?? null
    },
    listActiveByWorkspace(workspaceId) {
      prune()
      return [...tasks.values()].filter((task) => task.workspaceId === workspaceId)
    },
    complete(sessionId, expectedTaskId) {
      mutable(tasks.get(sessionId))
      if (expectedTaskId && tasks.get(sessionId)?.taskId !== expectedTaskId) return
      tasks.delete(sessionId)
    },
  }
}

const CreateProfileSchema = z.object({
  workspaceId: z.string().min(1).max(64),
  departmentId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  scope: ScopeSchema.optional(),
  clearance: ClearanceSchema.optional(),
  defaultBackend: BackendSchema.optional(),
  localControlMode: z.enum(['task_tabs', 'full_browser']).optional(),
  proxyUrl: z.string().url().max(1024).nullish(),
})

const UpdateProfileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  scope: ScopeSchema.optional(),
  clearance: ClearanceSchema.optional(),
  defaultBackend: BackendSchema.optional(),
  localControlMode: z.enum(['task_tabs', 'full_browser']).optional(),
  proxyUrl: z.string().url().max(1024).nullish().optional(),
  enabledAssistantIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  assistantRoutingNotes: AssistantRoutingNotesSchema.optional(),
}).strict()

const SaveCredentialSchema = z.object({
  loginUrl: z.string().url().max(2048).refine((url) => url.startsWith('https://')),
  accountLabel: z.string().trim().min(1).max(120).nullish(),
  username: z.string().min(1).max(512).refine((value) => !value.includes('\0')),
  password: z.string().min(1).max(2048).refine((value) => !value.includes('\0')),
})

export function computerRoutes(deps: {
  orchestrator: SandboxOrchestrator | null
  provider: SandboxProvider | null
  protectedFillEnabled?: boolean
  protectedBrowserSupported?: (userId: string, browserProfileId: string) => Promise<boolean>
  protectedFillBlocked?: (userId: string, sessionId: string) => boolean
  localProvider?: BrowserProvider | null
  localTasks?: LocalComputerTaskStore | null
  /** Null means relay status was unavailable, never that the extension disconnected. */
  localStatus?: ((userId: string, browserProfileId?: string) => Promise<{
    connected: boolean
    terminalEvent: 'stopped' | 'tab_closed' | null
  } | null>) | null
  vault: SessionVault | null
  /** Open DB store in normal compositions; null leaves profiles unconfigured. */
  profileStore: BrowserProfileStore | null
  /** Metadata/write/revoke only. This route object has no decrypt method. */
  credentials?: BrowserCredentialAdminStore | null
  /** Host-owned test + automatic reauthentication lane. */
  authBroker?: BrowserAuthBroker | null
  /** Block-scoped grants (R2-2) — listed + revocable per profile. */
  grants?: BrowserSkillGrantStore | null
  /** Skill lookups so a grant row can show its block's name. */
  skills?: BrowserSkillStore | null
  /** Current human authority; null is a legacy workspace. Failures must throw. */
  getProfileReadGrant?: (userId: string, workspaceId: string) => Promise<DepartmentReadGrant | null>
  admitProfileDestination?: (userId: string, workspaceId: string, destination: {
    departmentId: string; sensitivity: 'public' | 'internal' | 'confidential'
  }) => Promise<void>
  previewProfileDestination?: (userId: string, workspaceId: string) => Promise<{
    departments: { id: string; name: string; clearance: 'public' | 'internal' | 'confidential' }[]
  }>
  /** Current workspace-membership check. */
  getWorkspaceRole: (userId: string, workspaceId: string) => Promise<string | null>
  discardTask?: BrowserTaskDiscard
  /** The live backend toggle (R2-3) — flips the session's browse backend. */
  setSessionBackend?: (sessionId: string, backend: 'local' | 'cloud' | null) => void
}): Router {
  const router = Router()
  router.post('/tasks/:sessionId/discard', async (req, res) => {
    const body = z.object({ workspaceId: z.string().min(1).max(64) }).strict().safeParse(req.body)
    if (!body.success) { res.status(400).json({ error: 'workspaceId is required' }); return }
    if (!deps.discardTask) { res.status(503).json({ error: 'Browser discard unavailable.', code: 'discard_failed' }); return }
    try {
      const status = await deps.discardTask({ userId: req.userId as string, workspaceId: body.data.workspaceId, sessionId: String(req.params.sessionId) })
      res.json({ ok: true, status })
    } catch { res.status(502).json({ error: 'Browser discard could not be confirmed.', code: 'discard_failed' }) }
  })
  // Task lifecycle/backend toggles are not an escape hatch from disclosure.
  router.use(['/tasks/:sessionId', '/sessions/:sessionId'], (req, res, next) => {
    if (req.method !== 'GET' && deps.protectedFillBlocked?.(req.userId as string, String(req.params.sessionId))) {
      res.status(403).json({ error: 'Protected fill unavailable', code: 'protected_fill_denied' })
      return
    }
    next()
  })

  async function readableTask(task: SandboxTaskRecord | LocalComputerTaskRecord, userId: string): Promise<boolean> {
    if (task.userId !== userId || !(await requireMember(userId, task.workspaceId))) return false
    if (!('sandboxId' in task)) {
      try { await assertLocalTaskExecutionAuthority(task) } catch { return false }
    }
    if ('sandboxId' in task && task.executionAuthority) {
      try {
        if (!deps.orchestrator?.assertTaskAuthority) return false
        await deps.orchestrator.assertTaskAuthority(task)
      } catch { return false }
    }
    // ON DELETE SET NULL must not relabel a formerly bound task as
    // identity-less work. Legacy bound tasks cannot reconstruct their floor.
    if (!task.profileId) return !task.profileAuthority
    try {
      const profile = await deps.profileStore?.get(task.profileId)
      if (!profile || profile.id !== task.profileId || profile.workspaceId !== task.workspaceId) return false
      {
        const retained = BrowserProfileAuthoritySchema.safeParse(task.profileAuthority)
        if (!retained.success) return false
        const floor = retained.data
        if (floor.id !== profile.id || floor.workspaceId !== profile.workspaceId
          || floor.ownerUserId !== profile.ownerUserId || floor.scope !== profile.scope
          || floor.clearance !== profile.clearance || (floor.departmentId ?? null) !== (profile.departmentId ?? null)) return false
      }
      return await readableProfile(profile, userId)
    } catch {
      return false
    }
  }

  async function ownedTask(
    sessionId: string,
    userId: string,
  ): Promise<{ backend: 'local'; task: LocalComputerTaskRecord } | { backend: 'cloud'; task: SandboxTaskRecord } | null> {
    const local = deps.localTasks?.getActiveBySession(sessionId)
    if (local?.userId === userId) return await readableTask(local, userId) ? { backend: 'local', task: local } : null
    if (!deps.orchestrator) return null
    const cloud = await deps.orchestrator.getActiveTask(sessionId)
    if (!cloud || !(await readableTask(cloud, userId))) return null
    return { backend: 'cloud', task: cloud }
  }

  // Workspace-wide discovery (§5): the caller's live tasks, so the app shell
  // can surface "a browser is running" from anywhere — not just the one chat
  // whose composer chip already knows. Scoped to the CALLER's tasks: the
  // frame/input/resume routes are ownership-gated, so listing a teammate's
  // task would advertise a live view the caller cannot open (cross-user
  // watching is a governance call the clearance model doesn't make yet).
  router.get('/tasks', async (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : ''
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }
    if (!deps.orchestrator && !deps.localTasks) {
      res.json({ tasks: [] })
      return
    }
    const role = await deps.getWorkspaceRole(req.userId as string, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Workspace not found' })
      return
    }
    const cloudCandidates = deps.orchestrator ? await deps.orchestrator.listActiveTasks(workspaceId) : []
    const cloudTasks = (await Promise.all(cloudCandidates.map(async task => await readableTask(task, req.userId as string) ? task : null))).filter((task): task is SandboxTaskRecord => task !== null)
    const localCandidates = deps.localTasks?.listActiveByWorkspace(workspaceId) ?? []
    let localTasks = (await Promise.all(localCandidates.map(async task => await readableTask(task, req.userId as string) ? task : null))).filter((task): task is LocalComputerTaskRecord => task !== null)
    const callerLocalTasks = localTasks.filter((task) => task.userId === (req.userId as string))
    if (callerLocalTasks.length > 0 && deps.localStatus) {
      for (const task of callerLocalTasks) {
        const status = await deps.localStatus(task.userId, task.profileId ?? undefined)
        if (status?.terminalEvent) {
          deps.localTasks?.complete(task.sessionId)
          localTasks = localTasks.filter((item) => item.sessionId !== task.sessionId)
        } else if (status && !status.connected) {
          // Hide during reconnect, but retain the record so Stop can still
          // clear it and a successful reconnect can restore this profile.
          localTasks = localTasks.filter((item) => item.sessionId !== task.sessionId)
        }
      }
    }
    const localSessions = new Set(localTasks.map((task) => task.sessionId))
    res.json({
      tasks: [
        ...localTasks.map((task) => ({ ...task, backend: 'local' as const })),
        ...cloudTasks
          .filter((task) => !localSessions.has(task.sessionId))
          .map((task) => ({ ...task, backend: 'cloud' as const })),
      ]
        .filter((task) => task.userId === (req.userId as string))
        .map((task) => ({
          taskId: task.taskId,
          sessionId: task.sessionId,
          status: task.status,
          profileId: task.profileId,
          injectedSite: task.injectedSite,
          createdAt: task.createdAt,
          lastActivityAt: task.lastActivityAt,
          backend: task.backend,
        })),
    })
  })

  router.get('/tasks/:sessionId', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    let connectionState: 'connected' | 'disconnected' | 'unknown' | undefined
    if (task.backend === 'local' && deps.localStatus) {
      const status = await deps.localStatus(task.task.userId, task.task.profileId ?? undefined)
      if (status?.terminalEvent) {
        deps.localTasks?.complete(task.task.sessionId)
        res.status(404).json({ error: 'No active computer task for this session' })
        return
      }
      connectionState = status ? (status.connected ? 'connected' : 'disconnected') : 'unknown'
    }
    res.json({
      taskId: task.task.taskId,
      status: task.task.status,
      profileId: task.task.profileId,
      injectedSite: task.task.injectedSite,
      ...(task.backend === 'local' && deps.protectedFillEnabled && task.task.profileId &&
        await deps.protectedBrowserSupported?.(req.userId as string, task.task.profileId) &&
        !deps.protectedFillBlocked?.(req.userId as string, req.params.sessionId)
        ? { destinationOrigin: task.task.destinationOrigin ?? null } : {}),
      workspaceId: task.task.workspaceId,
      createdAt: task.task.createdAt,
      backend: task.backend,
      ...(connectionState ? { connectionState } : {}),
    })
  })

  // The live view opening = the user arrived for the Take-Over → resume the
  // paused sandbox (§4.8: pause covers the WAIT, not the takeover itself).
  router.post('/tasks/:sessionId/resume', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    try {
      if (task.backend === 'cloud') await deps.orchestrator?.resumeAfterTakeover(req.params.sessionId)
      res.json({ ok: true })
    } catch (err) {
      const failure = captureErrorResponse(err)
      res.status(failure.status).json({error:failure.error,...(failure.code ? {code:failure.code} : {})})
    }
  })

  // Frame poll (~1 fps from the client): cloud fallback or the local relay's
  // bounded screenshot path. Every request remains ownership-gated here.
  router.get('/tasks/:sessionId/frame', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    try {
      let frame
      if (task.backend === 'local') {
        if (!deps.localProvider?.nextTakeoverFrame) {
          res.status(501).json({ error: 'Local browser live view is not supported by this deployment' })
          return
        }
        frame = await deps.localProvider.nextTakeoverFrame({
          userId: task.task.userId,
          workspaceId: task.task.workspaceId,
          sessionId: task.task.sessionId,
          taskId: task.task.taskId,
          ...(task.task.profileId ? { profileId: task.task.profileId } : {}),
        })
        deps.localTasks?.touch(task.task, task.task.injectedSite)
      } else {
        if (!deps.provider) {
          res.status(404).json({ error: 'No active computer task for this session' })
          return
        }
        const takeover = deps.provider.browser(task.task.sandboxId).takeover()
        try {
          frame = await takeover.nextFrame()
        } finally {
          await takeover.close()
        }
      }
      if (!(await readableTask(task.task, req.userId as string))) {
        res.status(404).json({ error: 'No active computer task for this session' })
        return
      }
      if (!frame) {
        res.status(204).end()
        return
      }
      res.json(frame)
    } catch (err) {
      if (task.backend === 'local' && isTerminalLocalTaskError(err)) {
        deps.localTasks?.complete(task.task.sessionId)
      }
      res.status(502).json({ error: err instanceof Error ? err.message : 'frame capture failed' })
    }
  })

  // Live-stream mint (§5): have the provider start (or reuse) the in-sandbox
  // bridge and hand back its capability URLs. The browser then streams frames
  // and posts input DIRECTLY to the sandbox host — this route is the auth
  // gate, not the data path. 501 → the page stays on the polled fallback.
  router.post('/tasks/:sessionId/stream-session', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    if (task.backend === 'local') {
      res.status(501).json({ error: 'Direct live streaming is not available for local browser tasks' })
      return
    }
    if (!deps.provider) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    const browser = deps.provider.browser(task.task.sandboxId)
    if (!browser.openTakeoverStream) {
      res.status(501).json({ error: 'Live streaming is not supported by this sandbox backend' })
      return
    }
    try {
      const info = await browser.openTakeoverStream()
      if (!info) {
        res.status(501).json({ error: 'Live streaming is not available for this task' })
        return
      }
      if (!(await readableTask(task.task, req.userId as string))) {
        res.status(404).json({ error: 'No active computer task for this session' })
        return
      }
      res.json(info)
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'stream session failed' })
    }
  })

  router.post('/tasks/:sessionId/input', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    const parsed = InputEventSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input event' })
      return
    }
    try {
      if (task.backend === 'local') {
        if (!deps.localProvider?.sendTakeoverInput) {
          res.status(501).json({ error: 'Local browser Take-Over input is not supported by this deployment' })
          return
        }
        await deps.localProvider.sendTakeoverInput(
          {
            userId: task.task.userId,
            workspaceId: task.task.workspaceId,
            sessionId: task.task.sessionId,
            taskId: task.task.taskId,
            ...(task.task.profileId ? { profileId: task.task.profileId } : {}),
          },
          parsed.data,
        )
        deps.localTasks?.touch(task.task, task.task.injectedSite)
      } else {
        if (!deps.provider) {
          res.status(404).json({ error: 'No active computer task for this session' })
          return
        }
        const takeover = deps.provider.browser(task.task.sandboxId).takeover()
        try {
          await takeover.input(parsed.data)
        } finally {
          await takeover.close()
        }
      }
      res.json({ ok: true })
    } catch (err) {
      if (task.backend === 'local' && isTerminalLocalTaskError(err)) {
        deps.localTasks?.complete(task.task.sessionId)
      }
      res.status(502).json({ error: err instanceof Error ? err.message : 'input relay failed' })
    }
  })

  // "I signed in" — capture the authenticated session into the PROFILE's
  // vault (§4.4, R2-4) so every later task on this site skips the login.
  // A task that started identity-less must name the profile to bind.
  router.post('/tasks/:sessionId/captured', async (req, res) => {
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    if (task.backend === 'local') {
      res.status(409).json({
        error: 'Local browser sessions stay in the user browser and are not captured to the cloud vault.',
        code: 'local_session',
      })
      return
    }
    if (!deps.orchestrator) {
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
    if (!task.task.profileId && !body.data.profileId) {
      res.status(409).json({
        error: 'This task has no browser profile — pick or create one to save the session into.',
        code: 'profile_required',
      })
      return
    }
    const destinationId = body.data.profileId ?? task.task.profileId!
    const destination = await ownedProfile(destinationId, req.userId as string)
    if (!destination || destination.workspaceId !== task.task.workspaceId ||
      (task.task.profileId && task.task.profileId !== destinationId)) {
      res.status(404).json({ error: 'Browser profile unavailable' })
      return
    }
    try {
      await deps.orchestrator.captureSession(req.params.sessionId, body.data.site, destinationId)
      res.json({ ok: true, site: body.data.site })
    } catch (err) {
      const failure = captureErrorResponse(err)
      res.status(failure.status).json({error:failure.error,...(failure.code ? {code:failure.code} : {})})
    }
  })

  // Close-to-stop (§4.15/§4.8): ends the task now — capture + pull + kill.
  router.post('/tasks/:sessionId/complete', async (req, res) => {
    const outcome = req.body?.outcome === 'failed' ? 'failed' : 'completed'
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task) {
      const active = deps.localTasks?.getActiveBySession(req.params.sessionId)
        ?? await deps.orchestrator?.getActiveTask(req.params.sessionId)
      if (active?.userId === req.userId) {
        res.status(404).json({ error: 'No active computer task for this session' })
        return
      }
      // Idempotent close: a crashed browser may already have been retired by
      // frame/list liveness cleanup before the user presses Stop.
      res.json({ ok: true, status: outcome })
      return
    }
    if (task.backend === 'local') {
      if (!deps.localProvider) {
        res.status(501).json({ error: 'Local browser control is not supported by this deployment' })
        return
      }
      try {
        await deps.localProvider.stop({
          userId: task.task.userId,
          workspaceId: task.task.workspaceId,
          sessionId: task.task.sessionId,
          taskId: task.task.taskId,
          ...(task.task.profileId ? { profileId: task.task.profileId } : {}),
        })
      } catch (err) {
        if (isAlreadyStoppedLocalTaskError(err)) {
          deps.localTasks?.complete(req.params.sessionId)
          res.json({ ok: true, status: outcome })
          return
        }
        res.status(502).json({ error: err instanceof Error ? err.message : 'local browser stop failed' })
        return
      }
      deps.localTasks?.complete(req.params.sessionId)
      res.json({ ok: true, status: outcome })
      return
    }
    const done = await deps.orchestrator?.completeTask(req.params.sessionId, outcome)
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
    const task = await ownedTask(req.params.sessionId, req.userId as string)
    if (!task) {
      res.status(404).json({ error: 'No active computer task for this session' })
      return
    }
    const local = task.backend === 'local' ? task.task : null
    if (local && body.data.backend !== 'local') {
      if (!deps.localProvider) {
        res.status(501).json({ error: 'Local browser control is not supported by this deployment' })
        return
      }
      try {
        await deps.localProvider.stop({
          userId: local.userId,
          workspaceId: local.workspaceId,
          sessionId: local.sessionId,
          taskId: local.taskId,
          ...(local.profileId ? { profileId: local.profileId } : {}),
        })
      } catch (err) {
        if (!isAlreadyStoppedLocalTaskError(err)) {
          res.status(502).json({ error: err instanceof Error ? err.message : 'local browser stop failed' })
          return
        }
      }
      deps.localTasks?.complete(local.sessionId)
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

  // Every metadata and owner-management operation crosses the same read floor.
  // Unassigned shared identities stay owner-visible for classification recovery.
  async function readableProfile(profile: BrowserProfile, userId: string): Promise<boolean> {
    if (!(await requireMember(userId, profile.workspaceId))) return false
    if (profile.scope === 'owner' && profile.ownerUserId !== userId) return false
    try {
      const grant = await deps.getProfileReadGrant?.(userId, profile.workspaceId)
      return humanCanReadBrowserProfile(profile, userId, grant)
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
      res.json({ configured: false, credentialAuthConfigured: false, profiles: [] })
      return
    }
    if (!(await requireMember(req.userId as string, workspaceId))) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }
    const candidates = await deps.profileStore.list({ workspaceId })
    const admitted = await Promise.all(candidates.map(async (profile) =>
      await readableProfile(profile, req.userId as string) ? profile : null))
    const profiles = admitted.filter((profile): profile is BrowserProfile => profile !== null)
    const withSessions = await Promise.all(
      profiles.map(async (p) => {
        const canManage = p.ownerUserId === (req.userId as string)
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
          // Routing notes are owner-managed profile metadata. Workspace
          // members may discover a shared profile's existence, but do not
          // receive notes belonging to its owner's assistant configuration.
          assistantRoutingNotes: canManage ? (p.assistantRoutingNotes ?? {}) : {},
          // Proxy URLs may contain credentials; sharing an identity does not
          // disclose its owner's infrastructure secrets.
          proxyUrl: canManage ? p.proxyUrl : null,
          canManage,
          sessions: deps.vault ? await deps.vault.list({ profileId: p.id }).catch(() => []) : [],
          credentials:
            deps.credentials && canManage
              ? await deps.credentials.list({ profileId: p.id }).catch(() => [])
              : [],
          grants: namedGrants,
        }
      }),
    )
    // Metadata joins can outlive a department grant or profile classification.
    // Revalidate only after every join has settled, immediately before disclosure.
    const renewed = await Promise.all(withSessions.map(async (projection) => {
      const current = await deps.profileStore!.get(projection.id).catch(() => null)
      if (!current || current.workspaceId !== projection.workspaceId
        || current.ownerUserId !== projection.ownerUserId
        || current.departmentId !== projection.departmentId
        || current.scope !== projection.scope || current.clearance !== projection.clearance
        || current.updatedAt !== projection.updatedAt
        || !(await readableProfile(current, req.userId as string))) return null
      return projection
    }))
    res.json({
      configured: true,
      credentialAuthConfigured: Boolean(deps.credentials && deps.authBroker),
      profiles: renewed.filter((profile) => profile !== null),
    })
  })

  router.get('/profile-destinations', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : ''
    try {
      if (!workspaceId || !(await requireMember(req.userId as string, workspaceId)) || !deps.previewProfileDestination) {
        res.status(403).json({ code: 'not_authorized' }); return
      }
      const preview = await deps.previewProfileDestination(req.userId as string, workspaceId)
      res.json({ departments: preview.departments })
    } catch { res.status(403).json({ code: 'not_authorized' }) }
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
      const grant = await deps.getProfileReadGrant?.(req.userId as string, body.data.workspaceId)
      if (grant && body.data.scope === 'workspace' && !body.data.departmentId) {
        res.status(400).json({ error: 'Choose an owning department for this shared profile.', code: 'department_required' })
        return
      }
      if (body.data.departmentId) {
        if (!deps.admitProfileDestination) throw new Error('admission unavailable')
        await deps.admitProfileDestination(req.userId as string, body.data.workspaceId, {
          departmentId: body.data.departmentId, sensitivity: body.data.clearance ?? 'confidential',
        })
      }
    } catch {
      res.status(403).json({ error: 'Profile destination unavailable.', code: 'not_authorized' })
      return
    }
    try {
      const profile = await deps.profileStore.create({
        workspaceId: body.data.workspaceId,
        ownerUserId: req.userId as string,
        departmentId: body.data.departmentId,
        name: body.data.name,
        scope: body.data.scope,
        clearance: body.data.clearance,
        defaultBackend: body.data.defaultBackend,
        localControlMode: body.data.localControlMode,
        proxyUrl: body.data.proxyUrl ?? null,
      }, { userId: req.userId as string })
      res.json({ profile })
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'profile_authority_denied') {
        res.status(403).json({ error: 'Profile destination unavailable.', code: 'not_authorized' })
        return
      }
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
    if (!profile || profile.ownerUserId !== userId || !(await readableProfile(profile, userId))) return null
    return profile
  }

  router.post('/profiles/:id/department', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile) { res.status(404).json({error:'Profile unavailable'}); return }
    const body = z.object({departmentId:z.string().uuid().nullable(),expectedDepartmentId:z.string().uuid().nullable(),reason:z.string().trim().min(1).max(1000),confirmed:z.literal(true)}).strict().safeParse(req.body)
    if (!body.success) { res.status(400).json({error:'Invalid profile classification'}); return }
    if ((profile.departmentId ?? null) !== body.data.expectedDepartmentId) {
      res.status(409).json({error:'Profile changed. Refresh and retry.',code:'profile_changed'}); return
    }
    if (!deps.profileStore?.classifyDepartment) { res.status(503).json({error:'Profile classification unavailable'}); return }
    try {
      const { expectedDepartmentId: _reviewedDepartment, ...command } = body.data
      const updated = await deps.profileStore.classifyDepartment(profile.id,{...command,userId:req.userId as string,expected:profile})
      res.json({profile:updated})
    } catch (error) {
      const code = (error as {code?:string}).code
      if (code === 'profile_changed' || code === 'unchanged') { res.status(409).json({error:'Profile changed. Refresh and retry.',code}); return }
      if (['profile_authority_denied','admin_confirmation_required','department_required','confirmation_required','reason_required'].includes(code ?? '')) {
        res.status(403).json({error:'Profile classification unavailable',code}); return
      }
      res.status(500).json({error:'Profile classification failed'})
    }
  })

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
    try {
      const grant = await deps.getProfileReadGrant?.(req.userId as string, profile.workspaceId)
      if (grant && body.data.scope === 'workspace' && !profile.departmentId) {
        res.status(400).json({ error: 'Choose an owning department for this shared profile.', code: 'department_required' })
        return
      }
      if (profile.departmentId) {
        const clearance = body.data.clearance ?? profile.clearance
        const tiers = ['public', 'internal', 'confidential']
        // Metadata mutation cannot release the protection of saved browser state.
        if (tiers.indexOf(clearance) < tiers.indexOf(profile.clearance)) {
          res.status(409).json({ error: 'Protected profile clearance requires a reviewed change.', code: 'source_scope_required' })
          return
        }
        if (!deps.admitProfileDestination) throw new Error('admission unavailable')
        await deps.admitProfileDestination(req.userId as string, profile.workspaceId, {
          departmentId: profile.departmentId, sensitivity: clearance,
        })
      }
    } catch {
      res.status(403).json({ error: 'Profile destination unavailable.', code: 'not_authorized' })
      return
    }
    const updated = await deps.profileStore.update(req.params.id, body.data, profile)
    if (!updated) {
      res.status(409).json({ error: 'Profile authority changed. Reload before editing.', code: 'profile_changed' })
      return
    }
    res.json({ profile: updated })
  })

  router.delete('/profiles/:id', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile || !deps.profileStore) {
      res.status(404).json({ error: 'No such profile (or not yours to delete)' })
      return
    }
    const deleted = await deps.profileStore.delete(req.params.id, profile)
    if (!deleted) {
      res.status(409).json({ error: 'Profile authority changed. Reload before deleting.', code: 'profile_changed' })
      return
    }
    res.json({ ok: true })
  })

  // Saved login credentials are owner-only, write-only over REST, and scoped
  // to the registrable site derived HERE from the saved HTTPS login URL. No
  // route receives the resolver/decrypt capability.
  router.post('/profiles/:id/credentials', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile) {
      res.status(404).json({ error: 'No such profile (or not yours to change)' })
      return
    }
    if (!deps.credentials) {
      res.status(501).json({ error: 'Encrypted browser credentials are not configured on this deployment' })
      return
    }
    if (profile.defaultBackend !== 'cloud') {
      res.status(409).json({
        error: 'My Browser profiles use the logins already in that browser and do not store cloud credentials.',
        code: 'local_profile',
      })
      return
    }
    const body = SaveCredentialSchema.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'A valid HTTPS login URL, username, and password are required' })
      return
    }
    const site = registrableSiteOf(body.data.loginUrl)
    if (!site) {
      res.status(400).json({ error: 'The login URL has no valid site' })
      return
    }
    try {
      const credential = await deps.credentials.upsert({
        workspaceId: profile.workspaceId,
        profileId: profile.id,
        ownerUserId: profile.ownerUserId,
        site,
        loginUrl: body.data.loginUrl,
        accountLabel: body.data.accountLabel ?? null,
        secret: { username: body.data.username, password: body.data.password },
      }, profile)
      res.json({ credential })
    } catch (err) {
      const mapped = captureErrorResponse(err)
      if (mapped.status === 403) {
        res.status(403).json({ error: mapped.error, code: mapped.code })
        return
      }
      // Never reflect a database/crypto/provider message from a secret write.
      res.status(500).json({ error: 'Could not save the encrypted browser credential' })
    }
  })

  router.delete('/profiles/:id/credentials/:credentialId', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile || !deps.credentials) {
      res.status(404).json({ error: 'No such profile or credential' })
      return
    }
    let removed: boolean
    try {
      removed = await deps.credentials.revoke({
        profileId: profile.id,
        credentialId: req.params.credentialId,
      }, profile)
    } catch (err) {
      const mapped = captureErrorResponse(err)
      if (mapped.status !== 403) throw err
      res.status(403).json({ error: mapped.error, code: mapped.code })
      return
    }
    if (!removed) {
      res.status(404).json({ error: 'No such credential on this profile' })
      return
    }
    res.json({ ok: true })
  })

  // Owner-triggered verification uses the exact same model-free auth lane as
  // automatic session refresh. The response contains only typed status.
  router.post('/profiles/:id/credentials/:credentialId/test', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile) {
      res.status(404).json({ error: 'No such profile (or not yours to test)' })
      return
    }
    if (!deps.credentials || !deps.authBroker) {
      res.status(501).json({ error: 'Headless browser authentication is not configured on this deployment' })
      return
    }
    const credentials = await deps.credentials.list({ profileId: profile.id })
    const credential = credentials.find((item) => item.id === req.params.credentialId)
    if (!credential) {
      res.status(404).json({ error: 'No such credential on this profile' })
      return
    }
    const result = await deps.authBroker.authenticate({
      userId: req.userId as string,
      workspaceId: profile.workspaceId,
      profileId: profile.id,
      site: credential.site,
      credentialId: credential.id,
    })
    if (result.kind === 'authenticated') {
      res.json({ ok: true, status: result.kind, site: result.site })
      return
    }
    res.status(result.kind === 'unavailable' ? 409 : 422).json({
      ok: false,
      status: result.kind,
      code: result.code,
    })
  })

  // User-initiated sign-in (§7): "Sign in to a site" in Profile-Management
  // starts a cloud browser task bound to THIS profile under a synthetic
  // session id, navigates to the login page, and hands back the session id
  // for the Take-Over live view (`/w/<ws>/computer/<sessionId>?flow=login`).
  // The user signs in there and captures the session into the profile —
  // no assistant turn involved. Owner-only: a capture writes the identity.
  // Explicitly cloud regardless of the profile's default backend (capture
  // only exists in the cloud sandbox; the button says so — this is the
  // user's own deliberate routing, not the silent re-route R2-7 forbids).
  router.post('/profiles/:id/login', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile) {
      res.status(404).json({ error: 'No such profile (or not yours to sign in)' })
      return
    }
    if (!deps.orchestrator || !deps.provider) {
      res.status(501).json({ error: 'Cloud browsing is not configured on this deployment' })
      return
    }
    const body = z.object({ url: z.string().url().max(2048) }).safeParse(req.body)
    if (!body.success || !/^https?:\/\//i.test(body.data.url)) {
      res.status(400).json({ error: 'url must be an http(s) URL' })
      return
    }
    // A BARE uuid, never a decorated one: this id is persisted as
    // `sandbox_tasks.session_id`, which is `uuid NOT NULL` (open migration
    // 438; historical hosted migration 315). The original synthetic
    // `plogin_<uuid>` made every insert throw
    // `invalid input syntax for type uuid`, so this route 502'd on every call
    // from the day it shipped — the in-memory task store used in tests takes
    // any string, so the suite stayed green. Nothing reads the prefix; the
    // sign-in flow is marked by the UI's `?flow=login` query instead.
    const sessionId = randomUUID()
    const cloud = createCloudBrowserProvider({
      provider: deps.provider,
      binding: deps.orchestrator.binding,
    })
    try {
      // Rides the same task-creation path as a chat browse: credit gate,
      // budget authorization, vault injection, and metering all apply.
      await cloud.navigate(
        {
          userId: req.userId as string,
          workspaceId: profile.workspaceId,
          sessionId,
          profileId: profile.id,
        },
        body.data.url,
      )
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'could not open the browser' })
      return
    }
    res.json({ sessionId, site: registrableSiteOf(body.data.url) })
  })

  // "Save this login from my browser" (browser-session-portability.md D5):
  // capture a site's already-signed-in cookies straight out of the caller's
  // own connected Chrome, into THIS profile's vault, for a later CLOUD
  // browse under the same profile to replay. Unlike "Sign in to a site"
  // above, capture is not a property of a live task — the relay keys the
  // extension by (userId, browserProfileId) and asks for tab consent on its
  // own, so there is nothing to resolve except the profile itself. No sandbox task is
  // created or required. Owner-only, same as every other route that writes
  // an identity into a profile.
  router.post('/profiles/:id/capture', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile) {
      res.status(404).json({ error: 'No such profile (or not yours to save a login into)' })
      return
    }
    // A provider with no `captureState` (or no vault to write into) is a
    // typed refusal, never a crash.
    if (!deps.localProvider?.captureState) {
      res.status(501).json({
        error: 'Session capture is not supported for the local browser on this deployment',
        code: 'capture_unsupported',
      })
      return
    }
    if (!deps.vault) {
      res.status(501).json({
        error: 'Browser session storage is not configured on this deployment',
        code: 'capture_unsupported',
      })
      return
    }
    const body = z.object({ site: z.string().min(1).max(253) }).safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'site is required' })
      return
    }
    // A BARE uuid for the same reason `/profiles/:id/login` mints one above:
    // this id only ever needs to be a stable identity handle for the local
    // provider's call context, and it plainly documents that no request
    // reuses one task/session across calls here.
    const sessionId = randomUUID()
    try {
      const bundle = await deps.localProvider.captureState(
        { userId: req.userId as string, workspaceId: profile.workspaceId, sessionId, profileId: profile.id },
        body.data.site,
      )
      await deps.vault.put({ profileId: profile.id, site: body.data.site, bundle }, profile)
      res.json({ ok: true, site: body.data.site, capturedAt: bundle.capturedAt })
    } catch (err) {
      const mapped = captureErrorResponse(err)
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.code ? { code: mapped.code } : {}) })
    }
  })

  // Revoke one site's session inside a profile (the cookie jar keeps the rest).
  router.delete('/profiles/:id/sessions/:site', async (req, res) => {
    const profile = await ownedProfile(req.params.id, req.userId as string)
    if (!profile || !deps.vault) {
      res.status(404).json({ error: 'No such profile (or not yours to change)' })
      return
    }
    try {
      await deps.vault.revoke({ profileId: req.params.id, site: req.params.site }, profile)
    } catch (err) {
      const mapped = captureErrorResponse(err)
      if (mapped.status !== 403) throw err
      res.status(403).json({ error: mapped.error, code: mapped.code })
      return
    }
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
    try {
      await deps.grants.revoke(req.params.grantId, profile)
    } catch (err) {
      const mapped = captureErrorResponse(err)
      if (mapped.status !== 403) throw err
      res.status(403).json({ error: mapped.error, code: mapped.code })
      return
    }
    res.json({ ok: true })
  })

  return router
}
