import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, accessSync, statSync, constants } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { z } from 'zod'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, powerMonitor, screen, shell, systemPreferences } from 'electron'
import { NativeComputerController, NativeRelayClient, PrivatePipeHelper, LocalDeviceLease } from './computer-control/index.js'
import { CapabilitiesSchema, CommandSchema, TaskIdentitySchema, ProfileIdentitySchema, ProfileGrantSchema, TargetSchema, DiscoveredTargetSchema, NATIVE_PROTOCOL, MAX_SESSION_MS, sameIdentity, sameTarget, type NativeGrant, type NativeCommand, type NativeStatus, type DiscoveredTarget } from '@use-brian/computer-control/protocol.js'

import type { NativeBrokerObserverFactory } from './computer-control/trace.js'
import type { NativeActivity, NativeApprovalContext } from './computer-control/controller.js'
import { supportedNativePlatform, type HelperLaunchSpec, type HelperTimingOptions } from './computer-control/helper-client.js'

const ProfilePollSchema = z.object({ request: z.object({ id: z.string().uuid(), workspaceId: z.string().uuid(), assistantId: z.string().uuid(), conversationId: z.string().uuid(), requester: z.string().min(1).max(200) }).strict().nullable() }).strict()

// Renderer labels are local display data, never grant authority or consent text.
const selection = { workspaceId: z.string().uuid(), assistantId: z.string().uuid(), conversationId: z.string().uuid(), taskId: z.string().uuid(), goal: z.string().min(1).max(2000), target: DiscoveredTargetSchema.transform(({ displayName: _ignored, ...target }) => TargetSchema.parse(target)), allowControl: z.boolean(), allowCapture: z.boolean() }
export const NativeUiRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connect-profile'), workspaceId: selection.workspaceId, profileId: z.string().uuid(), target: selection.target, allowControl: z.boolean(), allowCapture: z.boolean() }).strict(),
  z.object({ type: z.literal('disconnect-profile') }).strict(),
  z.object({ type: z.literal('status') }).strict(), z.object({ type: z.literal('targets') }).strict(),
  z.object({ type: z.literal('check-readiness') }).strict(),
  z.object({ type: z.literal('acknowledge-verification') }).strict(),
  z.object({ type: z.literal('permissions'), permission: z.enum(['accessibility', 'screen-recording']).optional() }).strict(), z.object({ type: z.literal('stop') }).strict(), z.object({ type: z.literal('disconnect') }).strict(),
  z.object({ type: z.literal('workspace-changed'), workspaceId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('start'), ...selection }).strict(), z.object({ type: z.literal('resume'), ...selection }).strict(),
])
/** Local indicator IPC only; deliberately excludes identity, content and credentials. */
export type NativeIndicatorData = Readonly<{ state: NativeStatus['state']; activity: NativeActivity | null; shortcut: string }>

// Only allowlisted terminal codes become UI copy. Never display provider text,
// reasons, errors, or arbitrary outcome strings (including duplicate receipts).
const taskMessages = {
  completed: 'The task completed.',
  paused: 'The task paused before completion.',
  cancelled: 'The task was cancelled.',
  execution_unknown: 'The task ended with an uncertain execution result. Do not repeat actions without checking the application.',
  unavailable: 'Native computer execution is unavailable.',
  unsupported: 'This native computer task is not supported.',
} as const
const taskResultSchema = z.object({
  sessionId: z.string().uuid(),
  duplicate: z.literal(false).optional(), isError: z.boolean().optional(),
  data: z.object({ duplicate: z.literal(false).optional(), outcome: z.enum(['completed', 'paused', 'cancelled', 'execution_unknown', 'unavailable', 'unsupported']) }),
})
function taskNotice(raw: unknown, sessionId: string): { type: 'info' | 'warning'; detail: string } {
  const result = taskResultSchema.safeParse(raw)
  if (!result.success || result.data.sessionId !== sessionId || (result.data.isError && result.data.data.outcome === 'completed')) {
    return { type: 'warning', detail: 'The task could not be completed or its result could not be confirmed.' }
  }
  const outcome = result.data.data.outcome
  return { type: outcome === 'completed' ? 'info' : 'warning', detail: taskMessages[outcome] }
}

// Constructed only at the authenticated HTTP boundary, never from helper errors.
export type NativeProfileErrorCode = 'native_execution_unavailable' | 'computer_profiles_schema_unavailable' | 'sign_in_required' | 'computer_profiles_forbidden' | 'api_not_supported' | 'network_unreachable' | 'computer_profiles_unavailable'
class NativeBackendRequestError extends Error {
  constructor(readonly code: NativeProfileErrorCode) { super(code) }
}

type Auth = { userId: string; accessToken: string; apiUrl: string; accountKey: string }
export type NativeIntegrationOptions = {
  directory: string
  getAuth(): Promise<Auth | null>
  /** Trusted main only; absent in production unless explicitly wired. */
  observerFactory?: NativeBrokerObserverFactory
  /** Detached helper metadata only. No authority, IPC/env selection, or observer rebinding. */
  helperTimingObserver?: HelperTimingOptions['onMetadata']
}

/** Owns native authority in main. UI receives neither grants nor PKCE/token material. */
export class NativeComputerIntegration {
  private controller?: NativeComputerController
  private setupHelper?: PrivatePipeHelper
  private relay?: NativeRelayClient
  private indicator?: BrowserWindow
  private activity: NativeActivity | null = null
  private indicatorState: NativeStatus['state'] = 'unavailable'
  private epoch = 0
  private generation = 0
  private workspaceId?: string
  private authIdentity?: string
  // Metadata-only receipt for same-account inspector polling. Never a grant,
  // goal or AX cache; every Stop/scope invalidation discards it synchronously.
  private completedInspection?: { status: NativeStatus; authIdentity: string; controller: NativeComputerController; generation: number }
  // Canonical helper discovery metadata. Never include it in API, relay or status payloads.
  private selection: DiscoveredTarget[] = []
  private ready = false
  // Ctrl+Shift+Escape is reserved for Windows Task Manager; never rely on it
  // as an installable independent execution gate on Windows/Linux.
  private readonly stopShortcut = process.platform === 'darwin'
    ? { accelerator: 'CommandOrControl+Shift+Escape', label: '⌘⇧Esc' }
    : { accelerator: 'Control+Alt+Shift+Escape', label: 'Ctrl+Alt+Shift+Esc' }
  // Rejections deliberately remain fenced: only confirmed teardown removes an entry.
  private readonly teardown = new Set<Promise<void>>()
  private readonly terminalControllers = new WeakSet<NativeComputerController>()
  private trackCleanup(operation: () => Promise<void>): Promise<void> {
    let pending: Promise<void>
    try { pending = operation() } catch { pending = Promise.reject(new Error('Cleanup unconfirmed')) }
    this.teardown.add(pending)
    void pending.then(() => { this.teardown.delete(pending) }, () => {})
    return pending
  }
  private localInspection?: { grant: NativeGrant; authIdentity: string; generation: number }
  private profile?: { id: string; connectionId: string; auth: Auth; workspaceId: string; target?: DiscoveredTarget; allowControl: boolean; allowCapture: boolean }
  private profilePermissionRequirements?: { controller: NativeComputerController; generation: number; allowControl: boolean; allowCapture: boolean }
  private retiredSessionId?: string
  private releasingController?: NativeComputerController
  private profileTimer?: ReturnType<typeof setInterval>
  private pollingProfile = false
  private heartbeatingProfile = false
  private busy = false
  private session?: { id: string; auth: Auth }
  private requests = new AbortController()
  private deviceId = ''
  private readonly controlEnabled = process.env.NATIVE_COMPUTER_ENABLED === 'true' && supportedNativePlatform(process.platform)
    && (!app.isPackaged || process.env[process.platform === 'darwin' ? 'NATIVE_COMPUTER_PILOT_ACCEPTED' : process.platform === 'win32' ? 'NATIVE_COMPUTER_WINDOWS_ACCEPTED' : 'NATIVE_COMPUTER_LINUX_ACCEPTED'] === 'true')
  // Explicit local R1 development opt-in, not an assertion of pilot acceptance.
  // It grants only observation access; the controller independently caps helper authority.
  private readonly inspectorEnabled = process.platform === 'darwin' && app.isPackaged && process.env.NATIVE_COMPUTER_INSPECTOR_ENABLED === 'true'
  // Eligibility is not admission. A fresh attended local acknowledgment is required.
  private readonly verificationAvailable = process.platform === 'darwin' && app.isPackaged && process.env.NATIVE_COMPUTER_ENABLED === 'true'
  private verificationConsent?: { generation: number; workspaceId: string; authIdentity: string }
  private verificationAllowed(): boolean {
    const consent = this.verificationConsent
    return !!consent && consent.generation === this.generation && consent.workspaceId === this.workspaceId && consent.authIdentity === this.authIdentity
  }
  private readonly enabled = this.controlEnabled || this.inspectorEnabled || this.verificationAvailable
  private readonly helperTiming?: HelperTimingOptions
  constructor(private readonly options: NativeIntegrationOptions) {
    // Snapshot the callback once. PrivatePipeHelper captures original per-request
    // correlation and contains callback failures/backpressure. Do not retag events
    // using current auth/session, or redirect late events to a replacement observer.
    if (typeof options.helperTimingObserver === 'function') this.helperTiming = Object.freeze({ enabled: true, onMetadata: options.helperTimingObserver })
  }
  install(): void {
    if (!this.enabled) return
    const file = join(app.getPath('userData'), 'native-computer-device-id')
    try { this.deviceId = z.string().uuid().parse(readFileSync(file, 'utf8').trim()) }
    catch { this.deviceId = randomUUID(); writeFileSync(file, this.deviceId, { mode: 0o600 }) }
    const registered = globalShortcut.register(this.stopShortcut.accelerator, () => { void this.stop() })
    powerMonitor.on('lock-screen', () => { void this.stop() })
    powerMonitor.on('suspend', () => { void this.stop() })
    app.on('before-quit', () => { void this.stop() })
    ipcMain.on('Use Brian:native-emergency-stop', event => {
      if (this.indicator && event.sender === this.indicator.webContents && event.senderFrame === this.indicator.webContents.mainFrame) void this.stop()
    })
    // Helper independently monitors physical input, parent death and permission revocation.
    this.ready = registered
    this.makeController()
  }
  private helperLaunch(): HelperLaunchSpec {
    const platform = process.platform
    if (!supportedNativePlatform(platform)) throw new Error('Unsupported platform')
    const paths = platform === 'win32' ? win32 : posix
    if (platform === 'darwin') return { platform, executable: app.isPackaged
      ? paths.join(process.resourcesPath, 'computer-control', 'brian-native-computer-helper')
      : paths.resolve(this.options.directory, '..', 'native', 'computer-control', 'build', 'brian-native-computer-helper'), args: [] }
    const root = app.isPackaged ? paths.join(process.resourcesPath, 'native', 'computer-control')
      : paths.resolve(this.options.directory, '..', 'native', 'computer-control')
    return platform === 'win32'
      ? { platform, executable: paths.join(root, 'windows', ...(app.isPackaged ? [] : ['out', 'win-x64']), 'Brian.NativeHelper.exe'), args: [] }
      : { platform, executable: '/usr/bin/python3', args: ['-Es', paths.join(root, 'linux', 'helper.py')] }
  }
  private helperReady(): boolean {
    try {
      const spec = this.helperLaunch()
      const paths = spec.platform === 'win32' ? win32 : posix
      const files = spec.platform === 'linux'
        ? ['helper.py', 'contract.py', 'x11.py', 'xinput.py', 'safety.py', 'atspi_backend.py', 'fixture.py', 'dependencies.json'].map(file => paths.join(paths.dirname(spec.args[1]), file)) : []
      for (const file of [spec.executable, ...files]) {
        if (!paths.isAbsolute(file) || !statSync(file).isFile()) return false
        accessSync(file, file === spec.executable && spec.platform !== 'win32' ? constants.X_OK : constants.R_OK)
      }
      // Library, logind and input-desktop checks belong to the helper, not inferred here.
      return true
    } catch { return false }
  }
  /** Explicit local metadata check, including while rollout is disabled. It uses
   * the existing private helper protocol but can only request capabilities—no
   * target discovery, consent grant, API/relay/model call or authority override. */
  private async checkReadiness(): Promise<unknown> {
    if (process.platform !== 'darwin' || !app.isPackaged || !this.helperReady()) {
      return { ok: false, error: 'Readiness requires the signed macOS desktop package.' }
    }
    if (this.busy || ['active', 'awaiting_action_approval', 'awaiting_local_consent'].includes(this.controller?.status().state ?? '')) {
      return { ok: false, error: 'Stop the current native session before checking readiness.' }
    }
    this.busy = true
    const generation = this.generation
    const lease = new LocalDeviceLease()
    let acquired = false
    let helper: PrivatePipeHelper | undefined
    let result: unknown = { ok: false }
    let stage = 'lease'
    try {
      await lease.acquire(); acquired = true
      if (generation !== this.generation) return { ok: false }
      stage = 'spawn'
      helper = new PrivatePipeHelper(this.helperLaunch(), () => {})
      this.setupHelper = helper
      stage = 'capabilities'
      const advertised = await helper.capabilities()
      stage = 'validation'
      const capabilities = CapabilitiesSchema.parse(advertised)
      if (capabilities.platform !== 'darwin') throw new Error('Wrong helper platform')
      stage = 'shutdown'
      await this.trackCleanup(() => helper!.kill()) // Successful metadata is published only after confirmed death.
      if (generation !== this.generation) return { ok: false }
      result = { ok: true, readiness: { helperAdmitted: true, capabilities } }
    } catch {
      // No raw exception, stderr, paths, account identity or desktop content.
      console.warn('[native-computer] readiness failed', { stage, ...helper?.readinessDiagnostics() })
      const diagnostics = helper?.readinessDiagnostics()
      const readinessErrorCode = diagnostics?.requestTimedOut ? 'startup_timeout'
        : diagnostics?.spawnFailed ? 'spawn_failed'
        : diagnostics?.exitCode === 77 ? 'startup_refused' : 'unavailable'
      result = { ok: false, readinessErrorCode, error: 'Packaged helper admission could not be verified. No native control was enabled.' }
    } finally {
      // A failed/unconfirmed kill must not release the device lease or clear the
      // busy fence. Stop remains able to signal the retained helper independently.
      if (helper) await this.trackCleanup(() => helper!.kill())
      if (acquired) await this.trackCleanup(() => lease.release())
      if (this.setupHelper === helper) this.setupHelper = undefined
      this.busy = false
    }
    return generation === this.generation ? result : { ok: false }
  }
  private foregroundNotice(): string {
    return 'With your consent, the helper will attempt to restore only the selected window to the foreground at session start and after the approval dialog. It freshly rechecks the target and action; if focus restoration or validation fails, it fails closed.'
  }
  private makeController(): NativeComputerController {
    const integration = this
    const controller: NativeComputerController = new NativeComputerController({ enabled: this.enabled, get observationOnly() { return !integration.controlEnabled && !integration.verificationAllowed() }, observerFactory: this.options.observerFactory,
      safetyControlsReady: () => this.ready && this.helperReady(),
      helperFactory: onDeath => new PrivatePipeHelper(this.helperLaunch(), onDeath, undefined, this.helperTiming), lease: new LocalDeviceLease(),
      approveGrant: async (grant, signal) => {
        const generation = this.generation
        const profile = this.profile
        const local = this.localInspection
        const allowed = await this.consent('Allow Brian to use this computer?', [
        `Requester: ${JSON.stringify(grant.requester)}`, `Workspace: ${JSON.stringify(grant.identity.workspaceId)}`, `Deployment: ${JSON.stringify(grant.identity.deploymentId)}`,
        'purpose' in grant ? local?.grant.grantId === grant.grantId ? 'One-shot local Accessibility inspection. No chat tools or model provider.' : `Interactive chat tools. Conversation (data): ${JSON.stringify(grant.identity.conversationId)}` : `Task: ${JSON.stringify(grant.goal)}`, `Selected windows (data): ${JSON.stringify(grant.targets.map(target => ({ displayName: this.selection.find(item => sameTarget(item, target))?.displayName, appId: target.appId, windowId: target.windowId })))}`,
        grant.allowControl ? 'Initial semantic scope: TextEdit and supported fixtures only. Every action requires your local approval; unavailable capabilities are not substituted.' : 'Observation only. No input.',
        grant.allowCapture ? 'Screenshot support: selected reviewed fixture windows only. Screenshot-guided actions require a uniquely resolved Accessibility invoke and exact local approval. No raw coordinate input or no-AX canvas actions.' : 'No screenshot capture.',
        grant.allowControl || process.platform !== 'darwin' ? this.foregroundNotice() : 'Read-only inspection: Brian will not activate, raise or edit the selected window.',
        grant.allowControl
          ? 'Accessibility text is sent to your configured model provider. Local execution is not local inference.' + (grant.allowCapture ? ' Images may be sent to that provider only after separate image-upload approval and model-policy checks; capture consent alone is not sufficient.' : '')
          : 'AX inspector: one read of the selected window is shown locally, then the session ends automatically. No model task or screenshot capture.',
        `Expires: ${new Date(grant.expiresAt).toLocaleTimeString()}. Stop: ${this.stopShortcut.label}.`,
      ].join('\n\n'), signal)
        if (!allowed || signal.aborted) return false
        if ('purpose' in grant) {
          const fresh = await this.readAuth(AbortSignal.any([signal, this.requests.signal, AbortSignal.timeout(5000)]))
          if (local && this.localInspection === local && local.grant.grantId === grant.grantId) {
            return generation === this.generation && local.generation === generation && !signal.aborted &&
              !grant.allowControl && !grant.allowCapture && grant.identity.workspaceId === this.workspaceId &&
              !!fresh && this.authKey(fresh) === local.authIdentity
          }
          return generation === this.generation && !signal.aborted && !!profile && this.profile === profile &&
            profile.workspaceId === this.workspaceId && grant.identity.profileId === profile.id &&
            !!fresh && this.authKey(fresh) === this.authKey(profile.auth)
        }
        return true
      },
      approveAction: (command, signal, context) => this.approveAction(command, signal, context),
      revalidateExecution: async (command, signal): Promise<boolean> => {
        const generation = this.generation
        const session = this.session
        const requestSignal = AbortSignal.any([signal, this.requests.signal, AbortSignal.timeout(Math.max(1, command.deadlineAt - Date.now()))])
        const current = () => {
          const status = controller.status()
          return !requestSignal.aborted && command.deadlineAt > Date.now() && generation === this.generation &&
            this.controller === controller && this.session === session && status.epoch === command.epoch &&
            !!status.identity && sameIdentity(status.identity, command.identity) &&
            (status.expiresAt === undefined || status.expiresAt > Date.now())
        }
        const local = this.localInspection
        if (local) {
          if (!current() || local.generation !== generation || command.action.kind !== 'observe' ||
            local.grant.allowControl || local.grant.allowCapture || local.grant.grantId !== command.grantId ||
            !sameIdentity(local.grant.identity, command.identity)) return false
          const auth = await this.readAuth(requestSignal)
          return current() && this.localInspection === local && !!auth && this.authKey(auth) === local.authIdentity
        }
        if (!current() || !session || session.id !== command.identity.sessionId) return false
        const authIdentity = this.authKey(session.auth)
        // Auth providers need not support cancellation. Detach hung/late reads on
        // Stop/deadline without letting them restore authority in another scope.
        const readAuth = () => this.readAuth(requestSignal)
        const auth = await readAuth()
        if (!current() || !auth || this.authKey(auth) !== authIdentity) return false
        // Snapshot the credential primitive, not the mutable auth-provider object.
        // Even same-user token rotation during HTTP must fail closed, without retry.
        const requestToken = auth.accessToken
        const result = await this.request({ ...auth, accessToken: requestToken }, `/sessions/${session.id}/revalidate`, 'POST', {
          commandId: command.commandId, grantId: command.grantId, epoch: command.epoch, deadlineAt: command.deadlineAt,
          digest: createHash('sha256').update(JSON.stringify(CommandSchema.parse(command))).digest('hex'),
        }, requestSignal)
        if (!current() || !z.object({ authorized: z.literal(true) }).strict().safeParse(result).success) return false
        // Logout/account replacement can occur without an invalidation event
        // while HTTP is pending; generation/session object equality is not auth.
        const finalAuth = await readAuth()
        return current() && !!finalAuth && finalAuth.accessToken === requestToken &&
          this.authKey(finalAuth) === authIdentity && this.authKey(session.auth) === authIdentity
      },
      onReleased: status => this.releaseProfileLease(controller, status),
      onStatus: status => { if (this.controller === controller) {
        if (this.releasingController === controller) {
          // Only our synchronous identityChanged -> stopped transition is expected.
          // Takeover/other terminal transitions during teardown still disconnect.
          if (status.state !== 'stopped') void this.stop().catch(() => {})
          this.changed(status)
          return
        }
        if (['stopped', 'paused_for_user', 'ended'].includes(status.state) && !this.terminalControllers.has(controller)) {
          this.verificationConsent = undefined
          this.terminalControllers.add(controller)
          if (this.profile) void this.stop().catch(() => {})
          this.trackCleanup(() => controller.stop())
        }
        this.changed(status)
      } },
      onActivity: activity => { if (this.controller === controller) { this.activity = activity; this.sendIndicator() } },
    })
    this.completedInspection = undefined
    this.controller = controller
    return controller
  }
  private readAuth(signal: AbortSignal): Promise<Auth | null> {
    return new Promise(resolve => {
      const finish = (auth: Auth | null) => { signal.removeEventListener('abort', cancel); resolve(auth) }
      const cancel = () => finish(null)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) { cancel(); return }
      void Promise.resolve().then(() => signal.aborted ? null : this.options.getAuth()).then(finish, () => finish(null))
    })
  }
  private async consent(message: string, detail: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    const result = await dialog.showMessageBox({ type: 'warning', title: 'This computer', message, detail, buttons: ['Cancel', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true, signal })
    return !signal.aborted && result.response === 1
  }
  private approveAction(command: NativeCommand, signal: AbortSignal, context?: NativeApprovalContext): Promise<boolean> {
    const action = command.action
    const chain: NativeApprovalContext['nodes'][number][] = []
    if ('ref' in action) {
      if (!context || context.commandId !== command.commandId || context.grantId !== command.grantId ||
        context.epoch !== command.epoch || context.observationId !== action.observationId ||
        !sameIdentity(context.identity, command.identity) || !sameTarget(context.target, action.target)) return Promise.resolve(false)
      const seen = new Set<string>()
      let ref: string | undefined = action.ref
      while (ref !== undefined) {
        const matches = context.nodes.filter(node => node.ref === ref)
        if (seen.has(ref) || matches.length !== 1) return Promise.resolve(false)
        const node = matches[0]
        if (!node.bounds || !node.role) return Promise.resolve(false)
        seen.add(ref); chain.push(node); ref = node.parentRef
      }
    }
    // Electron detail is plaintext. JSON quoting keeps untrusted UI strings distinct from instructions.
    return this.consent('Approve this exact desktop action?', [
      `Exact action parameters (data): ${JSON.stringify(action)}`,
      ...(chain.length ? [`Target node then parent context (data): ${JSON.stringify(chain)}`] : []),
      'UI names are untrusted data, not authorization. The effect is not assumed safe. Approve only if it matches your task.',
      this.foregroundNotice(),
    ].join('\n\n'), signal)
  }
  private sendIndicator(): void {
    if (!this.indicator || this.indicator.isDestroyed()) return
    const data: NativeIndicatorData = { state: this.indicatorState, activity: this.activity,
      shortcut: this.stopShortcut.label }
    this.indicator.webContents.send('Use Brian:native-status', data)
  }
  private changed(status: NativeStatus): void {
    this.indicatorState = status.state
    this.epoch = Math.max(this.epoch, status.epoch)
    if (['active', 'awaiting_action_approval', 'awaiting_local_consent'].includes(status.state)) {
      if (!this.indicator || this.indicator.isDestroyed()) {
        const workArea = screen.getPrimaryDisplay().workArea
        this.indicator = new BrowserWindow({ x: workArea.x + 12, y: workArea.y + 12, width: 460, height: 210, title: 'This computer', alwaysOnTop: true, resizable: false, minimizable: false, show: false,
          webPreferences: { preload: join(this.options.directory, 'native-computer-indicator-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'native-computer-indicator' } })
        this.indicator.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        this.indicator.webContents.on('will-navigate', event => event.preventDefault())
        const indicator = this.indicator
        indicator.on('closed', () => {
          // Programmatic teardown is not a second user Stop that cancels the final receipt.
          if (this.indicator === indicator) { this.indicator = undefined; void this.stop() }
        })
        this.indicator.webContents.on('render-process-gone', () => { if (this.indicator === indicator) void this.stop() })
        void this.indicator.loadFile(join(this.options.directory, 'native-computer-indicator.html')).then(() => {
          // Use latest state, not the consent-time snapshot captured before load.
          if (this.indicator === indicator && !indicator.isDestroyed()) { indicator.showInactive(); this.sendIndicator() }
        }).catch(() => { if (this.indicator === indicator) void this.stop() })
      } else this.sendIndicator()
    } else if (status.state === 'stopped' || status.state === 'paused_for_user' || status.state === 'ended') {
      const relay = this.relay; this.relay = undefined; relay?.disconnect()
      const indicator = this.indicator; this.indicator = undefined; indicator?.destroy()
    }
  }
  async stop(): Promise<void> {
    this.verificationConsent = undefined
    this.profilePermissionRequirements = undefined
    this.releasingController = undefined
    this.retiredSessionId = undefined
    this.localInspection = undefined
    const profile = this.profile; this.profile = undefined
    clearInterval(this.profileTimer); this.profileTimer = undefined
    if (profile) void this.request(profile.auth, `/profiles/${profile.id}/disconnect`, 'POST', { connectionId: profile.connectionId }, AbortSignal.timeout(5000)).catch(() => {})
    ++this.generation; this.requests.abort(); this.requests = new AbortController()
    this.selection = []
    this.completedInspection = undefined
    // Main also calls Stop at logout/deployment changes, without an auth read.
    // Conservatively forget private grant data on every integration-level Stop.
    if (this.controller) this.terminalControllers.add(this.controller)
    const shutdown = this.controller && this.trackCleanup(() => this.controller!.identityChanged())
    const setupShutdown = this.setupHelper && this.trackCleanup(() => this.setupHelper!.kill())
    const relay = this.relay; this.relay = undefined; relay?.disconnect()
    const active = this.session; this.session = undefined
    // Local Stop never waits for a network revocation.
    if (active) void this.request(active.auth, `/sessions/${active.id}`, 'DELETE', undefined, AbortSignal.timeout(5000)).catch(() => {})
    await Promise.all([shutdown, setupShutdown])
  }
  private profilePermissionsGranted(caps: NativeStatus['capabilities'], requested: { allowControl: boolean; allowCapture: boolean }): boolean {
    return caps.axRead && caps.accessibilityPermission === 'granted' &&
      (!requested.allowControl || caps.semanticActions) &&
      (!requested.allowCapture || caps.windowCapture && caps.capturePermission === 'granted')
  }
  private profilePermissionStatus(status: NativeStatus | undefined): NativeStatus | undefined {
    const requested = this.profilePermissionRequirements
    if (status && requested && requested.controller === this.controller && requested.generation === this.generation &&
      ['ready', 'permission_required'].includes(status.state) && !this.profilePermissionsGranted(status.capabilities, requested)) {
      return { ...status, state: 'permission_required' }
    }
    return status
  }
  private async connectProfile(input: Extract<z.infer<typeof NativeUiRequestSchema>, { type: 'connect-profile' }>, auth: Auth, generation: number): Promise<unknown> {
    const signal = this.requests.signal
    const current = async () => {
      const fresh = await this.readAuth(AbortSignal.any([signal, AbortSignal.timeout(5000)]))
      if (signal.aborted || generation !== this.generation || input.workspaceId !== this.workspaceId || !fresh || this.authKey(fresh) !== this.authKey(auth)) throw new Error('Profile scope changed')
    }
    if (this.profile || this.session || !this.controller || input.workspaceId !== this.workspaceId || !z.string().uuid().safeParse(this.deviceId).success) throw new Error('Profile unavailable')
    if (!input.allowControl && input.allowCapture) throw new Error('Local inspection does not capture')
    await current()
    if (!this.controlEnabled && !this.verificationAllowed() && (input.allowControl || !this.inspectorEnabled)) {
      if (!this.verificationAvailable || !this.helperReady()) throw new Error('Verification unavailable')
      const allowed = await this.consent('Allow attended packaged Mac verification?',
        'This is verification before pilot acceptance, not production rollout or safety certification. Stay present and review every action. Only Accessibility-backed actions are supported. Stop revokes further work best-effort. This temporary acknowledgment does not enable pilot acceptance.', signal)
      await current()
      if (!allowed) return { ok: false }
      // Keep the discovered helper/window generation. Its control ceiling is
      // main-owned and only opens after this scoped attended acknowledgment.
      this.verificationConsent = { generation, workspaceId: input.workspaceId, authIdentity: this.authKey(auth) }
    }
    if (['stopped', 'paused_for_user', 'ended'].includes(this.controller!.status().state)) {
      await this.trackCleanup(() => this.controller!.dispose())
      await current()
      this.makeController()
    }
    const controller = this.controller!
    this.profilePermissionRequirements = { controller, generation, allowControl: input.allowControl, allowCapture: input.allowCapture }
    const denied = (capabilities: NativeStatus['capabilities']) => ({ ok: false, profileConnected: false,
      error: 'Grant the requested system permissions or choose supported permissions, then retry.',
      status: { ...controller.status(), capabilities, state: 'permission_required' as const },
      verificationAvailable: this.verificationAvailable, verificationConsented: this.verificationAllowed() })
    const refresh = async () => {
      // Read under the newly acknowledged main ceiling, not the pre-consent
      // renderer status. Acknowledgment itself is never a TCC grant.
      const caps = await controller.capabilities()
      await current()
      if (this.controller !== controller || !['ready', 'permission_required'].includes(controller.status().state)) throw new Error('Helper unavailable')
      return caps
    }
    let caps = await refresh()
    // Known TCC denial cannot lead to discovery or a server connection. Unknown
    // bootstrap metadata may initialize through local discovery, then refresh.
    if (caps.accessibilityPermission === 'denied' || input.allowCapture && caps.capturePermission === 'denied') return denied(caps)
    const targets = await controller.listTargets()
    caps = await refresh()
    if (!this.profilePermissionsGranted(caps, input)) return denied(caps)
    const target = targets.find(t => sameTarget(t, input.target))
    if (!target) throw new Error('Select a current target')
    this.selection = targets
    if (!input.allowControl) return this.inspectProfile(input.profileId, target, auth, generation)
    if (!await this.consent('Connect this computer profile?',
      `Profile (data): ${JSON.stringify(input.profileId)}\nWindow (data): ${JSON.stringify(target)}\nControl: ${input.allowControl}. Capture: ${input.allowCapture}. Connecting does not authorize chat tools. Each chat lease requires fresh local approval.`, signal)) return { ok: false }
    caps = await refresh() // TCC may change while the connection dialog is open.
    if (!this.profilePermissionsGranted(caps, input)) return denied(caps)
    const connected = z.object({ connectionId: z.string().uuid() }).strict().parse(await this.request(auth, `/profiles/${input.profileId}/connect`, 'POST', { workspaceId: input.workspaceId, deviceId: this.deviceId }))
    try { await current() } catch (error) {
      void this.request(auth, `/profiles/${input.profileId}/disconnect`, 'POST', connected, AbortSignal.timeout(5000)).catch(() => {})
      throw error
    }
    this.profile = { id: input.profileId, ...connected, auth, workspaceId: input.workspaceId, target, allowControl: input.allowControl, allowCapture: input.allowCapture }
    this.profileTimer = setInterval(() => {
      if (this.pollingProfile || this.busy || this.releasingController) void this.heartbeatProfile()
      else void this.pollProfile()
    }, 5000)
    this.profileTimer.unref()
    return { ok: true, profileId: input.profileId, profileConnected: true, status: this.authenticatedStatus(auth) }
  }
  /** A local-only lease: synthetic protocol context never goes to the server or relay. */
  private async inspectProfile(profileId: string, target: DiscoveredTarget, auth: Auth, generation: number): Promise<unknown> {
    const controller = this.controller!
    const { displayName: _label, ...canonical } = target
    const grant = ProfileGrantSchema.parse({ protocol: NATIVE_PROTOCOL, purpose: 'chat-tools',
      identity: { deploymentId: new URL(auth.apiUrl).origin, userId: auth.userId, workspaceId: this.workspaceId,
        deviceId: this.deviceId, profileId, conversationId: randomUUID(), sessionId: randomUUID() },
      requester: 'You (local inspection only)', epoch: ++this.epoch, grantId: randomUUID(),
      expiresAt: Date.now() + MAX_SESSION_MS - 1000, targets: [canonical], allowControl: false, allowCapture: false })
    this.localInspection = { grant, authIdentity: this.authKey(auth), generation }
    await controller.start(grant)
    if (generation !== this.generation) throw new Error('Inspection stopped')
    const inspection = await controller.inspectSelected()
    const status = controller.status()
    if (generation !== this.generation || this.controller !== controller || status.state !== 'active' ||
      !status.identity || !sameIdentity(status.identity, grant.identity)) throw new Error('Inspection revoked')
    const shutdown = this.stop()
    const completedGeneration = this.generation
    const signal = this.requests.signal
    await shutdown
    const fresh = await this.readAuth(AbortSignal.any([signal, AbortSignal.timeout(5000)]))
    if (signal.aborted || completedGeneration !== this.generation || this.controller !== controller ||
      !fresh || this.authKey(fresh) !== this.authKey(auth) || this.workspaceId !== grant.identity.workspaceId) throw new Error('Inspection revoked')
    const snapshotStatus = { ...controller.status(), identity: status.identity, expiresAt: status.expiresAt }
    this.completedInspection = { status: structuredClone(snapshotStatus), authIdentity: this.authKey(fresh), controller, generation: completedGeneration }
    return { ok: true, profileConnected: false, status: snapshotStatus, deviceId: this.deviceId, inspection }
  }
  private async releaseProfileLease(controller: NativeComputerController, status: NativeStatus): Promise<void> {
    const profile = this.profile
    const identity = status.identity
    if (!profile || this.controller !== controller || this.releasingController || this.teardown.size ||
      !identity || !('profileId' in identity) || identity.profileId !== profile.id ||
      identity.workspaceId !== profile.workspaceId || identity.userId !== profile.auth.userId ||
      identity.deviceId !== this.deviceId || this.session?.id !== identity.sessionId ||
      status.state !== 'active' || !status.expiresAt || status.expiresAt <= Date.now() || !this.relay) {
      await this.stop(); return
    }
    const generation = ++this.generation
    this.requests.abort(); this.requests = new AbortController()
    this.releasingController = controller
    this.retiredSessionId = identity.sessionId
    this.verificationConsent = undefined
    this.completedInspection = undefined
    this.localInspection = undefined
    this.selection = []
    profile.target = undefined // Helper-local window IDs cannot survive helper death.
    this.session = undefined // API already retired this exact idle lease under lock.
    this.relay = undefined // Client already detached; expected socket close is inert.
    try {
      // A timeout disconnects the profile but never clears the real death fence.
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([this.trackCleanup(() => controller.identityChanged()), new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Release teardown timed out')), 5000)
        })])
      } finally { clearTimeout(timeout) }
      await this.trackCleanup(() => controller.dispose())
      const signal = this.requests.signal
      const fresh = await this.readAuth(AbortSignal.any([signal, AbortSignal.timeout(5000)]))
      if (generation !== this.generation) return
      if (signal.aborted || this.profile !== profile || this.releasingController !== controller ||
        this.workspaceId !== profile.workspaceId || !fresh || this.authKey(fresh) !== this.authKey(profile.auth) ||
        controller.status().state !== 'stopped' || this.teardown.size) throw new Error('Release not confirmed')
      this.terminalControllers.add(controller)
      this.releasingController = undefined
      this.makeController() // No helper, grant, evidence or session authority survives.
    } catch {
      if (generation === this.generation) await this.stop().catch(() => {})
    }
  }
  /** Opaque window IDs die with the helper. A new chat explicitly selects a new
   * canonical discovery target, never matches old labels or resurrects old IDs. */
  private async selectReleasedProfileTarget(targets: DiscoveredTarget[], requester: string, conversationId: string, signal: AbortSignal): Promise<DiscoveredTarget | undefined> {
    const choices = targets.slice(0, 20)
    if (!choices.length || signal.aborted) return undefined
    const selected = await dialog.showMessageBox({ type: 'warning', title: 'This computer', message: 'Select a window for this new chat lease',
      detail: `Requester (data): ${JSON.stringify(requester)}\nConversation (data): ${JSON.stringify(conversationId)}\nThe previous lease ended. Select a current window, then review fresh local permission consent.`,
      buttons: ['Cancel', ...choices.map((target, i) => `${i + 1}: ${JSON.stringify(target.displayName ?? target.appId)} (PID ${target.processId})`)],
      defaultId: 0, cancelId: 0, noLink: true, signal })
    return !signal.aborted && selected.response > 0 ? choices[selected.response - 1] : undefined
  }
  private async heartbeatProfile(): Promise<void> {
    const profile = this.profile
    if (!profile || this.heartbeatingProfile) return
    this.heartbeatingProfile = true
    const generation = this.generation
    try {
      const signal = AbortSignal.any([this.requests.signal, AbortSignal.timeout(5000)])
      const auth = await this.readAuth(signal)
      if (generation !== this.generation || this.profile !== profile) return
      if (!auth || this.authKey(auth) !== this.authKey(profile.auth)) throw new Error('Identity changed')
      const result = ProfilePollSchema.parse(await this.request(auth, `/profiles/${profile.id}/poll`, 'POST', { connectionId: profile.connectionId }, signal))
      if (result.request && result.request.workspaceId !== profile.workspaceId) throw new Error('Wrong request scope')
    } catch { if (generation === this.generation) await this.stop().catch(() => {}) }
    finally { this.heartbeatingProfile = false }
  }
  /** Main-owned heartbeat and consent. Renderer polling never conveys approval. */
  private async pollProfile(): Promise<void> {
    const profile = this.profile
    if (!profile || this.releasingController || this.pollingProfile || this.busy || this.teardown.size) return
    this.pollingProfile = true
    this.busy = true
    const generation = this.generation
    const signal = this.requests.signal
    const current = async () => {
      const fresh = await this.readAuth(AbortSignal.any([signal, AbortSignal.timeout(5000)]))
      if (signal.aborted || generation !== this.generation || this.profile !== profile || this.workspaceId !== profile.workspaceId || !fresh || this.authKey(fresh) !== this.authKey(profile.auth)) throw new Error('Profile scope changed')
      return fresh
    }
    let acceptedId: string | undefined
    let requestId: string | undefined
    try {
      const auth = await current()
      const pending = ProfilePollSchema.parse(
        await this.request(auth, `/profiles/${profile.id}/poll`, 'POST', { connectionId: profile.connectionId }, AbortSignal.any([signal, AbortSignal.timeout(5000)])))
      await current()
      if (!pending.request) return
      const request = pending.request
      requestId = request.id
      if (request.workspaceId !== profile.workspaceId) throw new Error('Wrong request scope')
      if (this.session) return
      if (!this.controlEnabled && !this.verificationAllowed()) {
        if (!this.verificationAvailable || !await this.consent('Allow attended packaged Mac verification?',
          'This is verification before pilot acceptance, not production rollout. Stay present and review every action. The previous session consent was cleared. Only Accessibility-backed actions are supported; Stop revokes further work best-effort.', signal)) throw new Error('Verification declined')
        await current()
        this.verificationConsent = { generation, workspaceId: profile.workspaceId, authIdentity: this.authKey(auth) }
      }
      const controller = this.controller!
      const targets = await controller.listTargets()
      await current()
      const target = profile.target ? targets.find(t => sameTarget(t, profile.target!)) :
        await this.selectReleasedProfileTarget(targets, request.requester, request.conversationId, signal)
      await current()
      if (!target) throw new Error('Target changed or selection declined')
      profile.target = target
      this.selection = targets
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const accepted = z.object({ protocol: z.literal(NATIVE_PROTOCOL), identity: ProfileIdentitySchema.extend({ sessionId: z.string().uuid() }), expiresAt: z.number().int().positive(), state: z.literal('awaiting_local_consent') }).strict().parse(
        await this.request(auth, `/profiles/${profile.id}/requests/${request.id}/accept`, 'POST', { connectionId: profile.connectionId, challenge }))
      acceptedId = accepted.identity.sessionId
      await current()
      const identity = accepted.identity
      if (identity.profileId !== profile.id || identity.workspaceId !== profile.workspaceId || identity.conversationId !== request.conversationId || identity.userId !== auth.userId || identity.deviceId !== this.deviceId || accepted.expiresAt <= Date.now()) throw new Error('Wrong accepted scope')
      this.session = { id: identity.sessionId, auth }
      const grant = ProfileGrantSchema.parse({ protocol: NATIVE_PROTOCOL, identity, purpose: 'chat-tools', requester: request.requester,
        epoch: ++this.epoch, grantId: randomUUID(), expiresAt: Math.min(accepted.expiresAt, Date.now() + MAX_SESSION_MS - 1000), targets: [TargetSchema.parse({ appId: target.appId, processId: target.processId, processInstanceId: target.processInstanceId, windowId: target.windowId, windowInstanceId: target.windowInstanceId })], allowControl: profile.allowControl, allowCapture: profile.allowCapture })
      await controller.start(grant)
      await current()
      const paired = z.object({ token: z.string(), relayUrl: z.string(), expiresAt: z.number() }).strict().parse(await this.request(auth, `/sessions/${identity.sessionId}/exchange`, 'POST', { verifier, grant }))
      await current()
      this.relay = new NativeRelayClient(controller, identity)
      this.relay.connect(paired.relayUrl, paired.token)
      await this.relay.waitUntilReady(signal)
      await current()
      // Chat tools dispatch separately. Never launch a task or /run here.
    } catch {
      if (acceptedId && acceptedId !== this.retiredSessionId) void this.request(profile.auth, `/sessions/${acceptedId}`, 'DELETE', undefined, AbortSignal.timeout(5000)).catch(() => {})
      if (requestId && (!acceptedId || acceptedId !== this.retiredSessionId)) void this.request(profile.auth, `/profiles/${profile.id}/requests/${requestId}/deny`, 'POST', { connectionId: profile.connectionId }, AbortSignal.timeout(5000)).catch(() => {})
      if (generation === this.generation) await this.stop().catch(() => {})
    } finally { this.pollingProfile = false; this.busy = false }
  }
  private async request(auth: Auth, path: string, method: string, body?: unknown, signal = this.requests.signal): Promise<unknown> {
    const base = new URL(auth.apiUrl)
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('Insecure native API')
    let response: Response
    try {
      response = await fetch(`${auth.apiUrl.replace(/\/$/, '')}/api/native-computer${path}`, { method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(path.endsWith('/run') ? 130_000 : 30_000)]), headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch {
      // Stop is cancellation, not an unreachable backend.
      if (signal.aborted) throw new Error('Native request cancelled')
      throw new NativeBackendRequestError('network_unreachable')
    }
    if (!response.ok) {
      let code: unknown
      try {
        const bytes = await response.arrayBuffer()
        if (bytes.byteLength <= 64 * 1024) code = (JSON.parse(Buffer.from(bytes).toString()) as { code?: unknown } | null)?.code
      } catch { /* Never retain or echo server text. */ }
      if (signal.aborted) throw new Error('Native request cancelled')
      throw new NativeBackendRequestError(response.status === 401 ? 'sign_in_required'
        : response.status === 403 ? 'computer_profiles_forbidden'
        : response.status === 404 ? 'api_not_supported'
        : response.status === 503 && (code === 'native_execution_unavailable' || code === 'computer_profiles_schema_unavailable') ? code
        : 'computer_profiles_unavailable')
    }
    if (response.status === 204) return null
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > 64 * 1024) throw new Error('Native metadata too large')
    return JSON.parse(Buffer.from(bytes).toString()) as unknown
  }
  private redactedStatus(): NativeStatus | undefined {
    const status = this.controller?.status()
    if (!status) return undefined
    const { identity: _identity, expiresAt: _expiresAt, ...publicStatus } = status
    return publicStatus
  }
  private authKey(auth: Auth): string { return JSON.stringify([auth.accountKey, auth.userId, auth.apiUrl]) }
  private authenticatedStatus(auth: Auth): NativeStatus | undefined {
    const completed = this.completedInspection
    if (completed && completed.authIdentity === this.authKey(auth) && completed.generation === this.generation &&
      completed.controller === this.controller && completed.status.identity?.workspaceId === this.workspaceId) return structuredClone(completed.status)
    return this.controller?.status()
  }
  async handle(raw: unknown): Promise<unknown> {
    const result = await this.handleRequest(raw) as Record<string, unknown>
    // Pending cleanup is device-wide, fixed metadata, including across account changes.
    // Never send the previous task's status, targets or receipt with it.
    return this.teardown.size ? { ok: result.ok, cleanupPending: true } : { ...result, ...(result.status ? { status: this.profilePermissionStatus(result.status as NativeStatus) } : {}), ...(this.profile ? { profileConnected: true, profileId: this.profile.id } : {}), cleanupPending: false }
  }
  private async handleRequest(raw: unknown): Promise<unknown> {
    const parsed = NativeUiRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'Invalid native request' }
    const input = parsed.data
    if (input.type === 'stop' || input.type === 'disconnect' || input.type === 'disconnect-profile') {
      void this.stop().catch(() => {})
      return { ok: true, profileConnected: false, status: this.redactedStatus() }
    }
    if (input.type === 'workspace-changed') {
      if (this.workspaceId !== input.workspaceId) {
        this.workspaceId = input.workspaceId
        void this.stop().catch(() => {})
      }
      return { ok: true, status: this.redactedStatus() }
    }
    if (this.teardown.size) return { ok: input.type === 'status' }
    if (this.profile && (input.type === 'check-readiness' || input.type === 'acknowledge-verification')) return { ok: false }
    if (input.type === 'check-readiness') return this.checkReadiness()
    if (input.type !== 'permissions' && (!this.enabled || !this.ready)) return { ok: false, error: 'Native control unavailable' }
    if (!this.controlEnabled && !this.inspectorEnabled && !this.verificationAllowed() &&
      ['start', 'resume'].includes(input.type)) return { ok: false, error: 'Native control unavailable' }
    if ((input.type === 'start' || input.type === 'resume') &&
      ((!this.controlEnabled && !this.verificationAllowed() && (input.allowControl || input.allowCapture)) || (!input.allowControl && input.allowCapture))) {
      return { ok: false, error: 'This inspector supports observation only, without control or screenshots.' }
    }
    // An auth read begun in an old generation cannot restore its scope after Stop.
    const authGeneration = this.generation
    let auth: Auth | null
    try { auth = await this.readAuth(AbortSignal.any([this.requests.signal, AbortSignal.timeout(5000)])) }
    catch {
      if (authGeneration === this.generation) void this.stop().catch(() => {})
      return { ok: false, error: 'Sign in required', status: this.redactedStatus() }
    }
    if (authGeneration !== this.generation) return { ok: false, status: this.redactedStatus() }
    if (!auth) { void this.stop().catch(() => {}); return { ok: false, error: 'Sign in required' } }
    const authIdentity = this.authKey(auth)
    if (this.authIdentity && this.authIdentity !== authIdentity) {
      this.authIdentity = authIdentity
      void this.stop().catch(() => {})
      return { ok: false, error: 'Native identity changed' }
    }
    this.authIdentity = authIdentity
    if (input.type === 'status') { void this.pollProfile(); return { ok: true, profileId: this.profile?.id, profileConnected: !!this.profile, status: this.authenticatedStatus(auth), deviceId: this.deviceId, verificationAvailable: this.verificationAvailable, verificationConsented: this.verificationAllowed() } }
    if (this.teardown.size || this.busy || this.releasingController) return { ok: false, error: 'Native setup busy' }
    this.busy = true
    const generation = this.generation
    let completionGeneration = generation
    try {
      if (input.type === 'connect-profile') return await this.connectProfile(input, auth, generation)
      if (this.profile && (input.type === 'start' || input.type === 'resume')) return { ok: false }
      if (input.type === 'acknowledge-verification') {
        if (!this.verificationAvailable || !this.workspaceId || !this.helperReady() ||
          ['active', 'awaiting_action_approval', 'awaiting_local_consent'].includes(this.controller?.status().state ?? '')) return { ok: false }
        this.verificationConsent = undefined
        this.selection = []
        const workspaceId = this.workspaceId
        const signal = this.requests.signal
        const allowed = await this.consent('Allow attended packaged Mac verification?',
          'This is verification before pilot acceptance, not production rollout or a safety certification. Stay present and review every action. Stop revokes further work best-effort, including handoff; macOS may finish an action already sent. Accessibility-backed actions only; no-AX canvases are deferred. Normal task authorization, signed-helper admission, target consent and separate capture consent still apply. This acknowledgment is temporary and is cleared by Stop, workspace/account changes or session end.', signal)
        const fresh = allowed ? await this.readAuth(AbortSignal.any([signal, AbortSignal.timeout(5000)])) : null
        if (!allowed || signal.aborted || generation !== this.generation || workspaceId !== this.workspaceId || !fresh || this.authKey(fresh) !== authIdentity) return { ok: false }
        // Replace discovery under the new ceiling only after confirmed teardown.
        if (this.controller) await this.trackCleanup(() => this.controller!.dispose())
        if (signal.aborted || generation !== this.generation || workspaceId !== this.workspaceId) return { ok: false }
        const finalAuth = await this.readAuth(AbortSignal.any([signal, AbortSignal.timeout(5000)]))
        if (signal.aborted || generation !== this.generation || !finalAuth || this.authKey(finalAuth) !== authIdentity) return { ok: false }
        this.selection = []
        this.verificationConsent = { generation, workspaceId, authIdentity }
        this.makeController()
        return { ok: true, verificationConsented: true }
      }
      if (input.type === 'permissions') {
        if (['active', 'awaiting_action_approval', 'awaiting_local_consent'].includes(this.controller?.status().state ?? '')) {
          return { ok: false, error: 'Stop the current native session before changing permissions.' }
        }
        if (process.platform !== 'darwin') return { ok: false, error: 'Configure desktop accessibility locally; readiness is checked by the helper.' }
        // Renderer supplies a closed permission name, never a URL. Omitted name
        // preserves the legacy Accessibility setup request.
        const permission = input.permission ?? 'accessibility'
        if (permission === 'accessibility' && !app.isPackaged) {
          return { ok: false, error: 'Accessibility permission requests require the signed macOS desktop package.' }
        }
        const destination = permission === 'accessibility'
          ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
          : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
        const label = permission === 'accessibility' ? 'Accessibility' : 'Screen Recording'
        const workspaceId = this.workspaceId
        const controller = this.controller
        const current = (expectedGeneration: number) => expectedGeneration === this.generation &&
          workspaceId === this.workspaceId && this.controller === controller && this.authIdentity === authIdentity &&
          !['active', 'awaiting_action_approval', 'awaiting_local_consent'].includes(controller?.status().state ?? '')
        const revalidate = async (expectedGeneration: number) => {
          const fresh = await this.readAuth(AbortSignal.any([this.requests.signal, AbortSignal.timeout(5000)]))
          return current(expectedGeneration) && !!fresh && this.authKey(fresh) === authIdentity
        }
        const allowed = await this.consent(permission === 'accessibility' ? 'Request Accessibility permission?' : `Open ${label} settings?`,
          permission === 'accessibility'
            ? 'Request macOS Accessibility permission for Use Brian, then open Accessibility settings. Enable Use Brian there to allow computer use. macOS may suppress a repeated permission dialog. This stops any existing connection and does not read windows, capture the screen or start control.'
            : 'Open only the macOS Screen Recording settings pane. Change permissions there yourself only if intended. Screen Recording is optional and separate from Accessibility. This does not request an OS permission prompt, capture the screen, or start control.', this.requests.signal)
        if (!allowed) return { ok: false }
        if (!current(generation) || !await revalidate(generation) || !current(generation)) return { ok: false }
        // Permission changes require fresh helper/target identities. Revalidate
        // again after helper death: account replacement need not emit Stop.
        const shutdown = this.stop()
        completionGeneration = this.generation
        await shutdown
        if (!current(completionGeneration) || !await revalidate(completionGeneration) || !current(completionGeneration)) return { ok: false }
        if (permission === 'accessibility') {
          // macOS schedules the prompt asynchronously. Request from the signed
          // application that remains alive, never from a helper we immediately
          // kill. Its boolean is current trust, not completion or a control grant.
          const currentlyTrusted = systemPreferences.isTrustedAccessibilityClient(true)
          console.info('[native-computer] accessibility request issued', { currentlyTrusted })
        }
        await shell.openExternal(destination)
        return { ok: true, status: this.controller?.status() }
      }
      if (input.type === 'targets') {
        const state = this.controller?.status().state
        if (state && ['active', 'awaiting_action_approval', 'awaiting_local_consent'].includes(state)) return { ok: true, targets: structuredClone(this.selection), status: this.controller?.status() }
        // Reuse the discovery helper: its opaque window/process identities are stable.
        // Only an explicit local discovery after Stop creates a new helper.
        if (!this.controller || state === 'stopped' || state === 'paused_for_user' || state === 'ended') {
          if (this.controller) await this.trackCleanup(() => this.controller!.dispose())
          if (generation !== this.generation) return { ok: false }
          this.makeController()
        }
        let controller = this.controller!
        const previousPermission = controller.status().capabilities.accessibilityPermission
        const capabilities = await controller.capabilities()
        // macOS creates the takeover event tap at helper startup. A helper that
        // first saw denied AX permission cannot become usable merely by changing
        // its permission bit; recreate it once on the observed grant transition.
        if (process.platform === 'darwin' && previousPermission !== 'granted' &&
          capabilities.accessibilityPermission === 'granted' && !capabilities.axRead) {
          this.selection = []
          await this.trackCleanup(() => controller.dispose())
          if (generation !== this.generation) return { ok: false }
          controller = this.makeController()
          await controller.capabilities()
        }
        const targets = await controller.listTargets()
        // Discovery lazily initializes the Mac inspector. The first capabilities
        // request deliberately stays a permissionless bootstrap probe.
        if (process.platform === 'darwin') await controller.capabilities()
        if (generation !== this.generation || this.controller !== controller) return { ok: false, status: this.redactedStatus() }
        const status = controller.status()
        // Controller failures revoke the helper and return old capability data.
        // An empty list from that stopped backend is not a successful discovery.
        if (status.state !== 'ready' || !status.capabilities.axRead || status.capabilities.accessibilityPermission !== 'granted') {
          this.selection = []
          return { ok: false, status }
        }
        this.selection = targets
        return { ok: true, targets: structuredClone(this.selection), status, deviceId: this.deviceId }
      }
      if (!this.controller || input.workspaceId !== this.workspaceId || !this.selection.some(t => sameTarget(t, input.target))) throw new Error('Select a current target first')
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const created = z.object({ identity: TaskIdentitySchema }).passthrough().parse(await this.request(auth, '/sessions', 'POST', { workspaceId: input.workspaceId, assistantId: input.assistantId, conversationId: input.conversationId, taskId: input.taskId, deviceId: this.deviceId, challenge }))
      if (generation !== this.generation || created.identity.userId !== auth.userId || created.identity.workspaceId !== input.workspaceId || created.identity.deviceId !== this.deviceId || created.identity.conversationId !== input.conversationId || created.identity.taskId !== input.taskId) throw new Error('Native identity changed')
      this.session = { id: created.identity.sessionId, auth }
      const grant: NativeGrant = { protocol: NATIVE_PROTOCOL, identity: created.identity, epoch: ++this.epoch, grantId: randomUUID(), expiresAt: Date.now() + MAX_SESSION_MS - 1000,
        targets: [input.target], allowCapture: input.allowControl && input.allowCapture, allowControl: input.allowControl, requester: 'Your selected Brian assistant', goal: input.goal }
      await this.controller.start(grant)
      if (generation !== this.generation) throw new Error('Stopped')
      const paired = z.object({ token: z.string(), relayUrl: z.string(), expiresAt: z.number() }).strict().parse(await this.request(auth, `/sessions/${created.identity.sessionId}/exchange`, 'POST', { verifier, grant }))
      if (generation !== this.generation) throw new Error('Stopped')
      this.relay = new NativeRelayClient(this.controller, grant.identity)
      this.relay.connect(paired.relayUrl, paired.token)
      await this.relay.waitUntilReady(this.requests.signal)
      if (generation !== this.generation) throw new Error('Stopped')
      if (!grant.allowControl) {
        const controller = this.controller
        const inspection = await controller.inspectSelected()
        const status = controller.status()
        if (generation !== this.generation || this.controller !== controller ||
          this.workspaceId !== grant.identity.workspaceId || status.state !== 'active' || status.epoch !== grant.epoch ||
          !status.identity || !sameIdentity(status.identity, grant.identity)) throw new Error('Inspection revoked')
        // Detach this session so ordinary Stop stays network-independent. This one-shot
        // completion awaits both helper death/lease release and server revocation.
        this.session = undefined
        const shutdown = this.stop() // synchronously closes local/relay authority
        const completedGeneration = this.generation
        completionGeneration = completedGeneration
        const completionSignal = this.requests.signal
        await Promise.all([shutdown, this.request(auth, `/sessions/${created.identity.sessionId}`, 'DELETE', undefined, AbortSignal.timeout(5000))])
        // Use the cleanup budget; Stop detaches even an auth provider that never settles.
        // Capture the scope before cleanup so a Stop during helper death cannot be missed.
        const finalAuth = await this.readAuth(AbortSignal.any([completionSignal, AbortSignal.timeout(5000)]))
        const stopped = controller.status()
        if (completedGeneration !== this.generation || this.controller !== controller || !finalAuth ||
          finalAuth.accountKey !== auth.accountKey || finalAuth.userId !== auth.userId || finalAuth.apiUrl !== auth.apiUrl ||
          this.workspaceId !== grant.identity.workspaceId || stopped.state !== 'stopped' || stopped.epoch !== grant.epoch + 1) throw new Error('Inspection revoked during cleanup')
        // The controller has already forgotten both the grant and its private goal.
        // Retain only a scoped receipt so reauthenticated polls preserve the local
        // snapshot display. Pre-auth/error paths never use this receipt.
        const snapshotStatus = { ...stopped, identity: status.identity, expiresAt: status.expiresAt }
        this.completedInspection = { status: structuredClone(snapshotStatus), authIdentity: this.authKey(finalAuth), controller, generation: completedGeneration }
        return { ok: true, status: snapshotStatus, deviceId: this.deviceId, inspection }
      }
      const runSignal = this.requests.signal
      // The server uses the approved grant goal; no free-form authority or action crosses IPC.
      const controller = this.controller
      const finishRun = async (notice: ReturnType<typeof taskNotice>) => {
        if (generation !== this.generation) return
        // Automatic target polling must not replace the controller during cleanup
        // and silently discard the result. Stop/account invalidation remain pre-busy.
        this.busy = true
        try {
          const shutdown = this.stop() // closes local authority immediately
          const completedGeneration = this.generation
          const completionSignal = this.requests.signal
          await shutdown // retain helper-death and lease-release barriers
          if (completedGeneration !== this.generation) return
          const finalAuth = await this.readAuth(AbortSignal.any([completionSignal, AbortSignal.timeout(5000)]))
          if (completedGeneration !== this.generation || this.controller !== controller || !finalAuth ||
            this.authKey(finalAuth) !== authIdentity || this.authIdentity !== authIdentity ||
            this.workspaceId !== grant.identity.workspaceId) return
          await dialog.showMessageBox({ ...notice, title: 'This computer', message: 'Native computer task ended',
            detail: `${notice.detail} Review the selected application before starting another task.`, buttons: ['OK'], signal: completionSignal })
        } finally { this.busy = false }
      }
      // Separate request rejection from cleanup/dialog failure; never retry or
      // publish a result when local shutdown could not be confirmed.
      void this.request(auth, `/sessions/${created.identity.sessionId}/run`, 'POST', {}, runSignal).then(
        rawResult => finishRun(taskNotice(rawResult, created.identity.sessionId)),
        () => finishRun({ type: 'warning', detail: 'The task request failed. Its result could not be confirmed.' }),
      ).catch(() => {})
      return { ok: true, status: this.controller.status(), deviceId: this.deviceId }
    } catch (error) {
      if (input.type === 'permissions') console.warn('[native-computer] permission setup failed')
      const profileErrorCode = input.type === 'connect-profile' && completionGeneration === this.generation &&
        error instanceof NativeBackendRequestError ? error.code : undefined
      // A late failure from an invalidated request must not stop a newer scope.
      if (completionGeneration === this.generation) await this.stop().catch(() => {})
      return { ok: false, ...(input.type === 'connect-profile' ? { profileConnected: false } : {}), ...(profileErrorCode ? { profileErrorCode } : {}), error: profileErrorCode ? 'Computer profile backend request failed.' : input.type === 'connect-profile' ? 'Computer profile could not connect. Check permissions and select the window again.' : 'Native control could not start. Check permissions, task access, and select the window again.', status: this.redactedStatus() }
    } finally { this.busy = false }
  }
}
