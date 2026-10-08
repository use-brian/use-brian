import { assertBrowserTaskPublication, browserPublicationBusy, type BrowserTaskPublication } from './task-publication.js'
import { AuthoritySourceSchema, type AuthoritySource } from '../security/authority-source.js'
import { parseBrowserInputScope, mergeBrowserInputScope, type BrowserInputScope } from './input-scope.js'
import { accessCeilingContains, parseAuthoringAuthority, type AuthoringAuthority } from '../security/access-ceiling.js'
import type { CurrentAuthorityBoundary } from '../tools/types.js'
/**
 * The stateless sandbox orchestrator (spec §5): resolves a chat session's
 * active cloud task (creating one, budget-gated, with vault re-injection),
 * probes for silently-dead sessions, and owns task completion — capture
 * session deltas to the vault, pull downloads, kill the sandbox. Holds no
 * live browser: every op goes back through `SandboxProvider.connect(id)`.
 *
 * The task store is a port: production backs it with the open `sandbox_tasks`
 * table; tests use the in-memory impl below (sandboxes are
 * task-scoped and disposable, so lost in-memory state costs a re-login at
 * worst — the vault is the durable thing).
 */
import { randomUUID } from 'node:crypto'
import { getDomain } from 'tldts'
import type { SandboxTaskBinding } from './cloud-browser-provider.js'
import type { SandboxMeter } from './metering.js'
import { canUseProfile, BrowserProfileAuthoritySchema, type BrowserProfileAuthority, type BrowserProfile, type BrowserProfileStore } from './profiles.js'
import type {
  BrowserCallContext,
  SandboxProvider,
  SessionVault,
} from './types.js'
import { BrowserBackendError } from './types.js'

export type SandboxTaskStatus = 'running' | 'paused' | 'completed' | 'failed'

export type SandboxTaskRecord = {
  taskId: string
  sandboxId: string
  userId: string
  workspaceId: string
  sessionId: string
  status: SandboxTaskStatus
  /**
   * The browser profile the task browses as (R2-4) — the vault scope for
   * inject/capture/probe. Null = an identity-less task (no session reuse).
   */
  profileId: string | null
  /** Original profile floor. Legacy bound tasks without evidence cannot resume or capture. */
  sourceAuthority?: AuthoritySource | null
  inputScope?: BrowserInputScope | null
  executionAuthority?: AuthoringAuthority | null
  profileAuthority?: BrowserProfileAuthority | null
  /** Registrable domain whose vault bundle was injected at start (probe target). */
  injectedSite: string | null
  /**
   * First real browser-path resolution. Null means this shared sandbox has
   * only served compute/file-bridge work and must not appear as a live browser.
   */
  browserStartedAt: number | null
  authorizedBudgetUsd: number
  createdAt: number
  lastActivityAt: number
}

export type SandboxTaskStore = {
  withPublication<T>(expected: BrowserTaskPublication, operation: () => Promise<T>): Promise<T>
  noteInputScope(taskId: string, input: BrowserInputScope): Promise<BrowserInputScope | null>
  getActiveBySession(sessionId: string): Promise<SandboxTaskRecord | null>
  /** Running/paused tasks that have entered a browser path — the discovery surface (§5). */
  listActiveByWorkspace(workspaceId: string): Promise<SandboxTaskRecord[]>
  create(record: SandboxTaskRecord): Promise<void>
  update(taskId: string, patch: Partial<SandboxTaskRecord>): Promise<void>
  /** Tasks still running/paused whose last activity is older than the cutoff. */
  listStale(cutoffMs: number): Promise<SandboxTaskRecord[]>
  /**
   * Per-task spend accumulator for the §4.9 dollar cap (the DB impl
   * backs it with `sandbox_tasks.spent_usd`). Optional — absent, boot falls
   * back to an in-memory accumulator.
   */
  addSpend?(taskId: string, usd: number): Promise<{ spentUsd: number; authorizedBudgetUsd: number }>
}

export function createInMemorySandboxTaskStore(): SandboxTaskStore & {
  tasks: Map<string, SandboxTaskRecord>
} {
  const tasks = new Map<string, SandboxTaskRecord>()
  const publishing = new Set<string>()
  const mutable = (sessionId: string) => { if (publishing.has(sessionId)) throw browserPublicationBusy() }
  return {
    async withPublication(expected, operation) {
      mutable(expected.sessionId)
      publishing.add(expected.sessionId)
      try {
        const active = [...tasks.values()].find(t => t.sessionId === expected.sessionId && ['running', 'paused'].includes(t.status)) ?? null
        assertBrowserTaskPublication(expected, active)
        return await operation()
      } finally { publishing.delete(expected.sessionId) }
    },
    tasks,
    async noteInputScope(taskId, input) {
      const task = tasks.get(taskId)
      if (task) mutable(task.sessionId)
      if (!task || !['running', 'paused'].includes(task.status)) throw Object.assign(new Error('Task unavailable'), { code: 'profile_authority_denied' })
      task.inputScope = mergeBrowserInputScope(task.inputScope, input, task.workspaceId)
      return task.inputScope ? structuredClone(task.inputScope) : null
    },
    async getActiveBySession(sessionId) {
      for (const task of tasks.values()) {
        if (task.sessionId === sessionId && (task.status === 'running' || task.status === 'paused')) {
          return task
        }
      }
      return null
    },
    async listActiveByWorkspace(workspaceId) {
      return [...tasks.values()].filter(
        (t) =>
          t.workspaceId === workspaceId &&
          t.browserStartedAt !== null &&
          (t.status === 'running' || t.status === 'paused'),
      )
    },
    async create(record) {
      mutable(record.sessionId)
      const frozen = record.executionAuthority ? parseAuthoringAuthority(record.executionAuthority) : null
      if (record.executionAuthority && (!frozen || frozen.ceiling.userId !== record.userId || frozen.ceiling.workspaceId !== record.workspaceId)) {
        throw Object.assign(new Error('Task authority unavailable'), { code: 'profile_authority_denied' })
      }
      if (record.sourceAuthority && !frozen) throw Object.assign(new Error('Task source authority unavailable'), { code: 'profile_authority_denied' })
      tasks.set(record.taskId, { ...record, inputScope: record.inputScope ? parseBrowserInputScope(record.inputScope, record.workspaceId) : null, executionAuthority: frozen, sourceAuthority: record.sourceAuthority ? AuthoritySourceSchema.parse(record.sourceAuthority) : null })
    },
    async update(taskId, patch) {
      if (patch.inputScope !== undefined) throw Object.assign(new Error('Task input protection requires monotonic admission'), { code: 'profile_authority_denied' })
      const existing = tasks.get(taskId)
      if (existing) mutable(existing.sessionId)
      if (existing && (['taskId', 'sessionId', 'workspaceId', 'userId', 'sandboxId'] as const)
        .some(key => patch[key] !== undefined && patch[key] !== existing[key])) {
        throw Object.assign(new Error('Browser task identity is immutable'), { code: 'profile_authority_denied' })
      }
      if (patch.sourceAuthority !== undefined && !patch.executionAuthority) throw Object.assign(new Error('Task source authority unavailable'), { code: 'profile_authority_denied' })
      if (patch.executionAuthority !== undefined) {
        const frozen = parseAuthoringAuthority(patch.executionAuthority)
        if (!existing || existing.executionAuthority || existing.browserStartedAt !== null || !frozen
          || frozen.ceiling.userId !== existing.userId || frozen.ceiling.workspaceId !== existing.workspaceId) {
          throw Object.assign(new Error('Task execution authority unavailable'), { code: 'profile_authority_denied' })
        }
        patch = { ...patch, executionAuthority: frozen, sourceAuthority: patch.sourceAuthority ? AuthoritySourceSchema.parse(patch.sourceAuthority) : null }
      }
      if (patch.profileAuthority) {
        if (!existing || existing.profileId || existing.profileAuthority || !['running', 'paused'].includes(existing.status)
          || patch.profileId !== patch.profileAuthority.id || existing.workspaceId !== patch.profileAuthority.workspaceId) {
          throw Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
        }
      }
      if ((patch.profileAuthority !== undefined && !patch.profileAuthority)
        || (patch.profileId !== undefined && !patch.profileAuthority && patch.profileId !== existing?.profileId)) {
        throw Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
      }
      if (existing) tasks.set(taskId, { ...existing, ...patch })
    },
    async listStale(cutoffMs) {
      return [...tasks.values()].filter(
        (t) => (t.status === 'running' || t.status === 'paused') && t.lastActivityAt < cutoffMs,
      )
    },
  }
}

/** URL shapes that mean "the session is not signed in here" (silent-death probe, §6). */
const LOGIN_WALL_PATTERN =
  /\/(login|log-in|logon|sign-in|signin|checkpoint|authwall|sessions\/new)([./_?#-]|$)/i

export function looksLikeLoginWall(url: string): boolean {
  return LOGIN_WALL_PATTERN.test(url)
}

/**
 * Heuristics for "this page is a human-verification challenge" (captcha /
 * bot-check interstitial). Unlike the login-wall regex these read the whole
 * snapshot — the major walls (Cloudflare "Just a moment", Google /sorry/,
 * reCAPTCHA/hCaptcha widgets, PerimeterX press-and-hold, Amazon robot check,
 * DataDome's "DataDome Device Check" iframe on an otherwise-empty snapshot)
 * mostly serve the challenge at the ORIGINAL url, so a URL test alone can
 * never catch them. Kept deliberately specific: a plain page that merely
 * MENTIONS captchas must not trip it.
 */
const CAPTCHA_URL_PATTERN = /\/sorry\/|__cf_chl|\/cdn-cgi\/challenge-platform\/|captcha/i
const CAPTCHA_TITLE_PATTERN =
  /just a moment|attention required|verify you are human|are you a robot|robot check|unusual traffic|security check|please verify/i
const CAPTCHA_NODE_PATTERN = /recaptcha|hcaptcha|datadome|verify you are human|i'?m not a robot|press & hold/i

export function looksLikeCaptcha(page: {
  url: string
  title?: string
  nodes?: Array<{ role: string; name: string }>
}): boolean {
  if (CAPTCHA_URL_PATTERN.test(page.url)) return true
  if (page.title && CAPTCHA_TITLE_PATTERN.test(page.title)) return true
  return (page.nodes ?? []).some((n) => CAPTCHA_NODE_PATTERN.test(n.name))
}

/**
 * Heuristic for "the site refused the connection at its network edge" — a hard
 * reject that happens BEFORE any page loads, so Chrome surfaces it as a thrown
 * navigation error (`net::ERR_HTTP2_PROTOCOL_ERROR`, a connection reset/close,
 * or an SSL/QUIC handshake failure), never as a snapshot. In our pipeline the
 * `&&`-chained navigate exec fails fast at `open`, so these arrive as a thrown
 * `BrowserBackendError` message, not a page.
 *
 * This is categorically different from a captcha: a captcha is a page you can
 * watch and take over; a connection block is NOTHING rendered. On the cloud
 * backend it is almost always the anti-bot edge (Akamai / DataDome / PerimeterX)
 * dropping the sandbox's datacenter IP + automation fingerprint on the first
 * packet — so retrying, or handing the user a live-view / take-over link, both
 * dead-end against a page that never loaded (the Cathay Pacific flow, 2026-07-21).
 * The durable unblock is a real residential identity (the local real-Chrome
 * backend, or a residential proxy on the profile), not persistence.
 *
 * Deliberately narrow: only the "edge slammed the connection shut / never
 * handshook" codes, plus a landed `chrome-error://` document. A plain timeout
 * or DNS miss (site-down / typo) is left to the generic error path.
 */
const CONNECTION_BLOCK_PATTERN =
  /ERR_HTTP2_PROTOCOL_ERROR|ERR_SPDY_PROTOCOL_ERROR|ERR_QUIC_PROTOCOL_ERROR|ERR_SSL_PROTOCOL_ERROR|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_SSL_VERSION_OR_CIPHER_MISMATCH|chrome-error:\/\//i

export function looksLikeConnectionBlock(message: string): boolean {
  return CONNECTION_BLOCK_PATTERN.test(message)
}

export function registrableSiteOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return getDomain(host, { allowPrivateDomains: true }) ?? host
  } catch {
    return null
  }
}

export type SandboxOrchestratorDeps = {
  provider: SandboxProvider
  taskStore: SandboxTaskStore
  /** Encrypted DB impl; null means session reuse is not configured. */
  vault?: SessionVault | null
  /**
   * Profile lookups and original-floor renewal, including the BYOP proxy at
   * create time. Missing wiring permits only identity-less tasks.
   */
  profileStore?: Pick<BrowserProfileStore, 'get'> | null
  /** Rebuild current original-assistant authority for a persisted task. */
  resolveExecutionAuthority?: (task: SandboxTaskRecord, caller?: CurrentAuthorityBoundary) => Promise<CurrentAuthorityBoundary>
  /**
   * Pre-task gates (Phase 4 wires the real credit gate + budget
   * authorization; the defaults are permissive-but-bounded).
   */
  budget?: {
    /** Throws (with a user-facing message) when the workspace is out of credit. */
    checkCreditBudget?: (ctx: BrowserCallContext) => Promise<void>
    /** The per-session dollar cap authorized for a new task. */
    authorizeBudgetUsd?: (ctx: BrowserCallContext) => Promise<number>
  }
  /** Region hint for create (impossible-travel guard, §4.6). */
  regionFor?: (ctx: BrowserCallContext) => string | undefined
  /** Dormant BYOP hook (§4.6): a proxy URL for a specific site, when one is configured. */
  proxyUrlFor?: (site: string | null) => string | undefined
  /** Per-task non-browser egress allowlist (deny-by-default posture, §8). */
  egressAllowlistFor?: (ctx: BrowserCallContext) => string[]
  /** Sink for auto-pulled downloads (workspace-scoped ABOVE the provider seam). */
  saveDownload?: (
    ctx: { userId: string; workspaceId: string; sessionId: string; task: SandboxTaskRecord; authority?: CurrentAuthorityBoundary },
    file: { path: string; bytes: Uint8Array },
  ) => Promise<void>
  /**
   * The §4.9 meter. When present, every task touch records the sandbox-
   * seconds delta since the last touch and enforces the per-session dollar
   * cap: crossing it fails the task gracefully mid-flight, not at the end.
   */
  meter?: SandboxMeter | null
  maxLifetimeSeconds?: number
  now?: () => number
}

export const DEFAULT_SESSION_BUDGET_USD = 2

export type SandboxOrchestrator = {
  /** The binding CloudBrowserProvider resolves through (creates on demand). */
  binding: SandboxTaskBinding & {
    onNavigated(ctx: BrowserCallContext, url: string): Promise<void>
  }
  getActiveTask(sessionId: string): Promise<SandboxTaskRecord | null>
  /** Workspace-wide discovery (§5): every live task, for the shell pill / list. */
  listActiveTasks(workspaceId: string): Promise<SandboxTaskRecord[]>
  /** Pause during a Take-Over wait (RAM freed, cookies preserved — §4.8). */
  pauseForTakeover(sessionId: string): Promise<void>
  resumeAfterTakeover(sessionId: string): Promise<void>
  assertTaskAuthority(task: SandboxTaskRecord): Promise<void>
  /**
   * Capture the (post-login) session for a site into the profile's vault.
   * `profileId` binds a previously identity-less task to a profile on its
   * first capture (the Take-Over first-login flow).
   */
  captureSession(sessionId: string, site: string, profileId?: string, authority?: CurrentAuthorityBoundary): Promise<void>
  /** Task end: capture session deltas → pull downloads → kill (§4.10). */
  completeTask(sessionId: string, outcome?: 'completed' | 'failed', authority?: CurrentAuthorityBoundary): Promise<SandboxTaskRecord | null>
  /** Trusted owner-admitted teardown, without session capture or download publication. */
  discardTask(sessionId: string, expectedTaskId: string): Promise<boolean>
  /** Reaper sweep: kill + fail tasks idle past the abandonment window. */
  reapStale(abandonmentMs: number): Promise<number>
}

export function createSandboxOrchestrator(deps: SandboxOrchestratorDeps): SandboxOrchestrator {
  const now = deps.now ?? Date.now

  async function authorized<T>(authority: CurrentAuthorityBoundary | undefined, operation: () => Promise<T>): Promise<T> {
    return authority ? authority.execute(operation) : operation()
  }

  const denied = () => Object.assign(new Error('Browser profile authority changed. Start a new task after checking department access.'), { code: 'profile_authority_denied' })

  async function currentProfile(profileId: string, actor: { userId: string; workspaceId: string }): Promise<BrowserProfile> {
    const profile = await deps.profileStore?.get(profileId)
    if (!profile || profile.id !== profileId || profile.workspaceId !== actor.workspaceId
      || (profile.scope === 'owner' && profile.ownerUserId !== actor.userId)) throw denied()
    return profile
  }

  async function taskAuthority(task: SandboxTaskRecord, caller?: CurrentAuthorityBoundary): Promise<CurrentAuthorityBoundary | undefined> {
    if (!task.executionAuthority) { if (task.sourceAuthority) throw denied(); return caller }
    const frozen = parseAuthoringAuthority(task.executionAuthority)
    if (!frozen || frozen.ceiling.userId !== task.userId || frozen.ceiling.workspaceId !== task.workspaceId
      || !deps.resolveExecutionAuthority) throw denied()
    const retained = await deps.resolveExecutionAuthority(task, caller)
    return {
      ...(caller?.snapshotSource ? { snapshotSource: () => caller.snapshotSource!() } : {}),
      async assertCurrent() { await retained.assertCurrent(); await caller?.assertCurrent(); await admitTaskProfile(task) },
      async execute<T>(operation: () => Promise<T>): Promise<T> {
        return retained.execute(() => authorized(caller, async () => {
          await admitTaskProfile(task)
          const result = await operation()
          await admitTaskProfile(task)
          return result
        }))
      },
    }
  }

  async function currentProfileFloor(profileId: string, actor: { userId: string; workspaceId: string }): Promise<BrowserProfileAuthority> {
    return BrowserProfileAuthoritySchema.parse(await currentProfile(profileId, actor))
  }

  async function admitTaskProfile(task: SandboxTaskRecord): Promise<BrowserProfileAuthority | null> {
    if (!task.profileId) {
      if (task.profileAuthority) throw denied()
      return null
    }
    const parsed = BrowserProfileAuthoritySchema.safeParse(task.profileAuthority)
    if (!parsed.success || parsed.data.id !== task.profileId || parsed.data.workspaceId !== task.workspaceId) throw denied()
    const original = parsed.data
    const current = await currentProfile(task.profileId, task)
    if (current.ownerUserId !== original.ownerUserId || current.scope !== original.scope
      || current.clearance !== original.clearance || (current.departmentId ?? null) !== (original.departmentId ?? null)) throw denied()
    if (task.executionAuthority) {
      const frozen = parseAuthoringAuthority(task.executionAuthority)
      if (!frozen || !canUseProfile(current, { userId: task.userId, workspaceId: task.workspaceId,
        assistantId: frozen.assistantId, assistantClearance: frozen.ceiling.clearance,
        departmentRead: frozen.ceiling.departmentRead }).ok) throw denied()
    }
    return original
  }

  function assertTaskActor(task: SandboxTaskRecord, ctx: BrowserCallContext): void {
    if (task.userId !== ctx.userId || task.workspaceId !== ctx.workspaceId || task.sessionId !== ctx.sessionId) throw denied()
  }

  async function injectVaultBundle(
    profileId: string | null,
    sandboxId: string,
    site: string | null,
    expectedProfile: BrowserProfileAuthority | null,
    authority?: CurrentAuthorityBoundary,
  ): Promise<string | null> {
    // Session reuse is profile-scoped (R2-4): no profile → no injection.
    if (!deps.vault || !site || !profileId) return null
    if (!expectedProfile) throw denied()
    const bundle = await authorized(authority, () => deps.vault!.get({ profileId, site }, expectedProfile))
    if (!bundle) return null
    await authorized(authority, () => deps.provider.browser(sandboxId).injectStorageState(bundle))
    await authorized(authority, () => deps.vault!.touch({ profileId, site }, expectedProfile))
    return site
  }

  /**
   * Meter the sandbox-seconds delta since the task's last touch and enforce
   * the per-session dollar cap (§4.9). Cap crossed → the task fails
   * gracefully NOW (capture/pull/kill) and the caller gets a clear error.
   * Paused spans are excluded: a paused sandbox holds no compute.
   */
  async function meterTouch(task: SandboxTaskRecord, wasRunning: boolean, authority?: CurrentAuthorityBoundary): Promise<void> {
    if (!deps.meter || !wasRunning) return
    const seconds = Math.max(0, (now() - task.lastActivityAt) / 1000)
    const { capExceeded } = await deps.meter.recordSandboxSeconds(task, seconds)
    if (capExceeded) {
      await completeTaskInternal(task, 'failed', authority)
      throw new Error(
        `This browser task reached its authorized budget (about $${task.authorizedBudgetUsd.toFixed(2)}) and was stopped. Ask the user to raise the workspace's computer-use budget to continue.`,
      )
    }
  }

  function registerBrowserInvocationFinalizer(ctx: BrowserCallContext): void {
    ctx.registerInvocationFinalizer?.(
      `sandbox-browser:${ctx.sessionId}`,
      async () => {
        const task = await deps.taskStore.getActiveBySession(ctx.sessionId)
        if (!task || task.browserStartedAt === null) return
        // A paused task is waiting for an explicit human Take-Over (login or
        // captcha). Killing it at the assistant turn boundary would make the
        // live-view hand-off a dead link. Once resumed, the next invocation
        // registers this finalizer again; explicit Stop and the reaper remain
        // the closure paths if the user never resumes it.
        if (task.status === 'paused') return
        await completeTaskInternal(task, 'completed', ctx.authority)
      },
    )
  }

  async function resolve(
    ctx: BrowserCallContext,
    hint?: { url?: string; browser?: boolean },
  ): Promise<{ sandboxId: string; authority?: CurrentAuthorityBoundary }> {
    await ctx.authority?.assertCurrent()
    if (ctx.inputScope) ctx = { ...ctx, inputScope: parseBrowserInputScope(ctx.inputScope, ctx.workspaceId) }
    let existing = await deps.taskStore.getActiveBySession(ctx.sessionId)
    if (ctx.taskId && existing?.taskId !== ctx.taskId) throw denied()
    if (existing) {
      assertTaskActor(existing, ctx)
      if (ctx.executionAuthority) {
        if (!existing.executionAuthority) {
          if (existing.browserStartedAt !== null) throw denied()
          await deps.taskStore.update(existing.taskId, { executionAuthority: ctx.executionAuthority, sourceAuthority: ctx.sourceAuthority ?? null })
          existing = { ...existing, executionAuthority: ctx.executionAuthority, sourceAuthority: ctx.sourceAuthority ?? null }
        } else if (existing.executionAuthority.assistantId !== ctx.executionAuthority.assistantId
          || !accessCeilingContains(ctx.executionAuthority.ceiling, existing.executionAuthority.ceiling)) throw denied()
      }
      ctx = { ...ctx, authority: await taskAuthority(existing, ctx.authority) }
      await ctx.authority?.assertCurrent()
      if (ctx.inputScope) existing = { ...existing, inputScope: await deps.taskStore.noteInputScope(existing.taskId, ctx.inputScope) }
      if (hint?.browser && existing.profileId !== (ctx.profileId ?? null)) {
        // Compute and browser share one sandbox. Bind an untouched compute-only
        // task once before its first browser navigation; never switch an existing identity.
        if (existing.profileId || existing.browserStartedAt !== null || !ctx.profileId || !hint.url) throw denied()
        const floor = await currentProfileFloor(ctx.profileId, ctx)
        const boundTask = { ...existing, profileId: ctx.profileId, profileAuthority: floor }
        const boundAuthority = await taskAuthority(boundTask, ctx.authority)
        await boundAuthority?.assertCurrent()
        await deps.taskStore.update(existing.taskId, {profileId:ctx.profileId,profileAuthority:floor})
        existing = boundTask
        ctx = { ...ctx, authority: boundAuthority }
      }
      const floor = await admitTaskProfile(existing)
      if (hint?.browser && existing.browserStartedAt === null && !hint.url) {
        throw new BrowserBackendError(
          'No browser page is active for this session. Open a target URL with browserNavigate before reading or acting on the page.',
          'no_active_browser',
        )
      }
      if (hint?.browser) registerBrowserInvocationFinalizer(ctx)
      await meterTouch(existing, existing.status === 'running', ctx.authority)
      const touchedAt = now()
      const browserStartedPatch =
        hint?.browser && existing.browserStartedAt === null
          ? { browserStartedAt: touchedAt }
          : {}
      if (existing.status === 'paused') await authorized(ctx.authority, () => deps.provider.resume(existing!.sandboxId))
      const injectionPatch = hint?.browser && existing.browserStartedAt === null && hint.url
        ? {injectedSite:await injectVaultBundle(existing.profileId,existing.sandboxId,registrableSiteOf(hint.url),floor,ctx.authority)}
        : {}
      await deps.taskStore.update(existing.taskId, {
        ...(existing.status === 'paused' ? {status:'running' as const} : {}),
        lastActivityAt: touchedAt,
        ...browserStartedPatch,
        ...injectionPatch,
      })
      return { sandboxId: existing.sandboxId, authority: ctx.authority }
    }

    if (hint?.browser && !hint.url) {
      throw new BrowserBackendError(
        'No browser page is active for this session. Open a target URL with browserNavigate before reading or acting on the page.',
        'no_active_browser',
      )
    }
    if (hint?.browser) registerBrowserInvocationFinalizer(ctx)

    await deps.budget?.checkCreditBudget?.(ctx)
    const authorizedBudgetUsd =
      (await deps.budget?.authorizeBudgetUsd?.(ctx)) ?? DEFAULT_SESSION_BUDGET_USD

    const taskId = randomUUID()
    const site = hint?.url ? registrableSiteOf(hint.url) : null
    const profileId = ctx.profileId ?? null
    // Per-profile BYOP proxy (R2-3) wins over the per-site fallback hook.
    const profile = profileId ? await currentProfile(profileId, ctx) : null
    const profileAuthority = profile ? BrowserProfileAuthoritySchema.parse(profile) : null
    ctx = { ...ctx, authority: await taskAuthority({
      taskId, sandboxId: '', userId: ctx.userId, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
      status: 'running', profileId, profileAuthority, executionAuthority: ctx.executionAuthority ?? null, sourceAuthority: ctx.sourceAuthority ?? null,
      injectedSite: null, browserStartedAt: hint?.browser ? now() : null,
      authorizedBudgetUsd, createdAt: now(), lastActivityAt: now(),
    }, ctx.authority) }
    await ctx.authority?.assertCurrent()
    const { sandboxId } = await deps.provider.create({
      workspaceId: ctx.workspaceId,
      taskId,
      region: deps.regionFor?.(ctx),
      proxyUrl: profile?.proxyUrl ?? deps.proxyUrlFor?.(site),
      egressAllowlist: deps.egressAllowlistFor?.(ctx) ?? [],
      maxLifetimeSeconds: deps.maxLifetimeSeconds,
    })
    // From here the micro-VM is BILLING, so every path out must either record
    // the task row or kill the sandbox. Without this the vault injection or
    // the insert could throw and leave an orphan running until its
    // max-lifetime reaper — which is exactly what a malformed session id did
    // (`sandbox_tasks.session_id` is `uuid NOT NULL`; the sign-in route's
    // decorated id 502'd every call and leaked a sandbox each time).
    try {
      await ctx.authority?.assertCurrent()
      // Session reuse (§4.4): inject the profile's vaulted bundle BEFORE the
      // first navigation so the site is already signed in.
      const injectedSite = await injectVaultBundle(profileId, sandboxId, site, profileAuthority, ctx.authority)

      const createdAt = now()
      await deps.taskStore.create({
        taskId,
        sandboxId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        status: 'running',
        profileId,
        profileAuthority,
        executionAuthority: ctx.executionAuthority ?? null,
        sourceAuthority: ctx.sourceAuthority ?? null,
        inputScope: ctx.inputScope ? parseBrowserInputScope(ctx.inputScope, ctx.workspaceId) : null,
        injectedSite,
        browserStartedAt: hint?.browser ? createdAt : null,
        authorizedBudgetUsd,
        createdAt,
        lastActivityAt: createdAt,
      })
    } catch (err) {
      // Best-effort: a failed kill must not mask the original cause.
      await deps.provider.kill(sandboxId).catch(() => {})
      throw err
    }
    return { sandboxId, authority: ctx.authority }
  }

  async function onNavigated(ctx: BrowserCallContext, url: string): Promise<void> {
    // Silent-death probe (§6): a re-injected session that still lands on a
    // login wall is dead server-side — mark it so the UI can prompt re-auth
    // instead of silently reusing a corpse next task.
    const task = await deps.taskStore.getActiveBySession(ctx.sessionId)
    if (!task) return
    assertTaskActor(task, ctx)
    ctx = { ...ctx, authority: await taskAuthority(task, ctx.authority) }
    await ctx.authority?.assertCurrent()
    if (!task.injectedSite || !task.profileId || !deps.vault) return
    const floor = await admitTaskProfile(task)
    if (!floor) throw denied()
    const site = registrableSiteOf(url)
    if (site === task.injectedSite && looksLikeLoginWall(url)) {
      await authorized(ctx.authority, () => deps.vault!.markDead({ profileId: task.profileId!, site }, floor))
      await deps.taskStore.update(task.taskId, { injectedSite: null })
    }
  }

  async function captureFor(task: SandboxTaskRecord, site: string, profileId?: string, authority?: CurrentAuthorityBoundary): Promise<void> {
    authority = await taskAuthority(task, authority)
    await authority?.assertCurrent()
    const pid = profileId ?? task.profileId
    if (!deps.vault || !pid) return
    if (pid !== task.profileId) throw denied()
    const floor = await admitTaskProfile(task)
    if (!floor) throw denied()
    const bundle = await authorized(authority, () => deps.provider.browser(task.sandboxId).captureStorageState(site))
    await authorized(authority, () => deps.vault!.put({ profileId: pid, site, bundle }, floor))
  }

  async function completeTaskInternal(
    task: SandboxTaskRecord,
    outcome: 'completed' | 'failed',
    authority?: CurrentAuthorityBoundary,
  ): Promise<SandboxTaskRecord> {
    // Final sandbox-seconds delta (running spans only) — recorded WITHOUT
    // cap-recursion (a task being torn down cannot be torn down again).
    if (deps.meter && task.status === 'running') {
      const seconds = Math.max(0, (now() - task.lastActivityAt) / 1000)
      await deps.meter.recordSandboxSeconds(task, seconds).catch(() => ({}))
    }
    // Order matters (§4.10): capture the session while the sandbox lives,
    // pull downloads into our store, THEN kill. Killing loses nothing —
    // the sandbox FS is scratch by design (§4.12).
    try {
      if (task.injectedSite) await captureFor(task, task.injectedSite, undefined, authority)
    } catch {
      /* capture is best-effort — an expired page must not block teardown */
    }
    try {
      if (deps.saveDownload) {
        const downloadAuthority = await taskAuthority(task, authority)
        const downloads = await authorized(downloadAuthority, () => deps.provider.bridge.pullDownloads(task.sandboxId))
        for (const file of downloads) {
          await authorized(downloadAuthority, () => deps.saveDownload!(
            { userId: task.userId, workspaceId: task.workspaceId, sessionId: task.sessionId, task: structuredClone(task), authority: downloadAuthority },
            file,
          ))
        }
      }
    } catch {
      // Teardown must still run, but lost/denied publication is not a successful completion.
      outcome = 'failed'
    }
    await deps.provider.kill(task.sandboxId)
    await deps.taskStore.update(task.taskId, { status: outcome, lastActivityAt: now() })
    return { ...task, status: outcome }
  }

  return {
    binding: { resolve, onNavigated },

    async assertTaskAuthority(task) { await (await taskAuthority(task))?.assertCurrent() },

    getActiveTask: (sessionId) => deps.taskStore.getActiveBySession(sessionId),

    listActiveTasks: (workspaceId) => deps.taskStore.listActiveByWorkspace(workspaceId),

    async pauseForTakeover(sessionId) {
      const task = await deps.taskStore.getActiveBySession(sessionId)
      if (!task || task.status !== 'running') return
      await deps.provider.pause(task.sandboxId)
      await deps.taskStore.update(task.taskId, { status: 'paused', lastActivityAt: now() })
    },

    async resumeAfterTakeover(sessionId) {
      const task = await deps.taskStore.getActiveBySession(sessionId)
      if (!task || task.status !== 'paused') return
      await admitTaskProfile(task)
      await authorized(await taskAuthority(task), () => deps.provider.resume(task.sandboxId))
      await deps.taskStore.update(task.taskId, { status: 'running', lastActivityAt: now() })
    },

    async captureSession(sessionId, site, profileId, authority) {
      await authority?.assertCurrent()
      const task = await deps.taskStore.getActiveBySession(sessionId)
      if (!task) return
      const pid = profileId ?? task.profileId
      if (!pid) {
        throw new Error(
          'This task has no browser profile to save the session into. Create or pick a profile first.',
        )
      }
      if (task.profileId && task.profileId !== pid) throw denied()
      if (!task.profileId) {
        const floor = await currentProfileFloor(pid, task)
        if (floor.ownerUserId !== task.userId) throw denied()
        await (await taskAuthority({ ...task, profileId: pid, profileAuthority: floor }, authority))?.assertCurrent()
        await deps.taskStore.update(task.taskId, { profileId: pid, profileAuthority: floor })
        task.profileId = pid
        task.profileAuthority = floor
      }
      await captureFor(task, site, pid, authority)
      await deps.taskStore.update(task.taskId, {
        injectedSite: site,
        profileId: pid,
        lastActivityAt: now(),
      })
    },

    async completeTask(sessionId, outcome = 'completed', authority) {
      const task = await deps.taskStore.getActiveBySession(sessionId)
      if (!task) return null
      return completeTaskInternal(task, outcome, authority)
    },

    async discardTask(sessionId, expectedTaskId) {
      const task = await deps.taskStore.getActiveBySession(sessionId)
      if (!task || task.taskId !== expectedTaskId) return false
      await deps.provider.kill(task.sandboxId)
      if (deps.meter && task.status === 'running') {
        const seconds = Math.max(0, (now() - task.lastActivityAt) / 1000)
        await deps.meter.recordSandboxSeconds(task, seconds).catch(() => ({}))
      }
      await deps.taskStore.update(task.taskId, { status: 'failed', lastActivityAt: now() })
      return true
    },

    async reapStale(abandonmentMs) {
      const stale = await deps.taskStore.listStale(now() - abandonmentMs)
      for (const task of stale) {
        // Meter the abandoned span too (a leaked sandbox still billed us).
        if (deps.meter && task.status === 'running') {
          const seconds = Math.max(0, (now() - task.lastActivityAt) / 1000)
          await deps.meter.recordSandboxSeconds(task, seconds).catch(() => ({}))
        }
        try {
          await deps.provider.kill(task.sandboxId)
        } catch {
          /* already gone */
        }
        await deps.taskStore.update(task.taskId, { status: 'failed', lastActivityAt: now() })
      }
      return stale.length
    },
  }
}
