import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, accessSync, statSync, constants } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { z } from 'zod'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, powerMonitor, screen, shell, systemPreferences } from 'electron'
import { NativeComputerController, NativeRelayClient, PrivatePipeHelper, LocalDeviceLease } from './computer-control/index.js'
import { CapabilitiesSchema, CommandSchema, IdentitySchema, TargetSchema, DiscoveredTargetSchema, NATIVE_PROTOCOL, MAX_SESSION_MS, sameIdentity, sameTarget, type NativeGrant, type NativeCommand, type NativeStatus, type DiscoveredTarget } from '@use-brian/computer-control/protocol.js'

import type { NativeBrokerObserverFactory } from './computer-control/trace.js'
import type { NativeActivity, NativeApprovalContext } from './computer-control/controller.js'
import { supportedNativePlatform, type HelperLaunchSpec, type HelperTimingOptions } from './computer-control/helper-client.js'

// Renderer labels are local display data, never grant authority or consent text.
const selection = { workspaceId: z.string().uuid(), assistantId: z.string().uuid(), conversationId: z.string().uuid(), taskId: z.string().uuid(), goal: z.string().min(1).max(2000), target: DiscoveredTargetSchema.transform(({ displayName: _ignored, ...target }) => TargetSchema.parse(target)), allowControl: z.boolean(), allowCapture: z.boolean() }
export const NativeUiRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }).strict(), z.object({ type: z.literal('targets') }).strict(),
  z.object({ type: z.literal('check-readiness') }).strict(),
  z.object({ type: z.literal('permissions') }).strict(), z.object({ type: z.literal('stop') }).strict(), z.object({ type: z.literal('disconnect') }).strict(),
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
  private readinessHelper?: PrivatePipeHelper
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
  private busy = false
  private session?: { id: string; auth: Auth }
  private requests = new AbortController()
  private deviceId = ''
  private readonly controlEnabled = process.env.NATIVE_COMPUTER_ENABLED === 'true' && supportedNativePlatform(process.platform)
    && (!app.isPackaged || process.env[process.platform === 'darwin' ? 'NATIVE_COMPUTER_PILOT_ACCEPTED' : process.platform === 'win32' ? 'NATIVE_COMPUTER_WINDOWS_ACCEPTED' : 'NATIVE_COMPUTER_LINUX_ACCEPTED'] === 'true')
  // Explicit local R1 development opt-in, not an assertion of pilot acceptance.
  // It grants only observation access; the controller independently caps helper authority.
  private readonly inspectorEnabled = process.platform === 'darwin' && app.isPackaged && process.env.NATIVE_COMPUTER_INSPECTOR_ENABLED === 'true'
  private readonly enabled = this.controlEnabled || this.inspectorEnabled
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
      this.readinessHelper = helper
      stage = 'capabilities'
      const advertised = await helper.capabilities()
      stage = 'validation'
      const capabilities = CapabilitiesSchema.parse(advertised)
      if (capabilities.platform !== 'darwin') throw new Error('Wrong helper platform')
      stage = 'shutdown'
      await helper.kill() // Successful metadata is published only after confirmed death.
      if (generation !== this.generation) return { ok: false }
      result = { ok: true, readiness: { helperAdmitted: true, capabilities } }
    } catch {
      // No raw exception, stderr, paths, account identity or desktop content.
      console.warn('[native-computer] readiness failed', { stage, ...helper?.readinessDiagnostics() })
      result = { ok: false, error: 'Packaged helper admission could not be verified. No native control was enabled.' }
    } finally {
      // A failed/unconfirmed kill must not release the device lease or clear the
      // busy fence. Stop remains able to signal the retained helper independently.
      if (helper) await helper.kill()
      if (acquired) await lease.release()
      if (this.readinessHelper === helper) this.readinessHelper = undefined
      this.busy = false
    }
    return generation === this.generation ? result : { ok: false }
  }
  private foregroundNotice(): string {
    return 'With your consent, the helper will attempt to restore only the selected window to the foreground at session start and after the approval dialog. It freshly rechecks the target and action; if focus restoration or validation fails, it fails closed.'
  }
  private makeController(): NativeComputerController {
    const controller: NativeComputerController = new NativeComputerController({ enabled: this.enabled, observationOnly: !this.controlEnabled, observerFactory: this.options.observerFactory,
      safetyControlsReady: () => this.ready && this.helperReady(),
      helperFactory: onDeath => new PrivatePipeHelper(this.helperLaunch(), onDeath, undefined, this.helperTiming), lease: new LocalDeviceLease(),
      approveGrant: (grant, signal) => this.consent('Allow Brian to use this computer?', [
        `Requester: ${JSON.stringify(grant.requester)}`, `Workspace: ${JSON.stringify(grant.identity.workspaceId)}`, `Deployment: ${JSON.stringify(grant.identity.deploymentId)}`,
        `Task: ${JSON.stringify(grant.goal)}`, `Selected windows (data): ${JSON.stringify(grant.targets.map(target => ({ displayName: this.selection.find(item => sameTarget(item, target))?.displayName, appId: target.appId, windowId: target.windowId })))}`,
        grant.allowControl ? 'Control: every action requires your local approval.' : 'Observation only. No input.',
        grant.allowCapture ? 'Scoped screenshot fallback is allowed for supported windows.' : 'No screenshot capture.',
        grant.allowControl || process.platform !== 'darwin' ? this.foregroundNotice() : 'Read-only inspection: Brian will not activate, raise or edit the selected window.',
        grant.allowControl ? 'Accessibility text and approved images are sent to your configured model provider. Local execution is not local inference.' : 'AX inspector: one read of the selected window is shown locally, then the session ends automatically. No model task or screenshot capture.',
        `Expires: ${new Date(grant.expiresAt).toLocaleTimeString()}. Stop: ${this.stopShortcut.label}.`,
      ].join('\n\n'), signal),
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
      onStatus: status => { if (this.controller === controller) this.changed(status) },
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
    ++this.generation; this.requests.abort(); this.requests = new AbortController()
    this.selection = []
    this.completedInspection = undefined
    // Main also calls Stop at logout/deployment changes, without an auth read.
    // Conservatively forget private grant data on every integration-level Stop.
    const shutdown = this.controller?.identityChanged()
    const readinessShutdown = this.readinessHelper?.kill()
    const relay = this.relay; this.relay = undefined; relay?.disconnect()
    const active = this.session; this.session = undefined
    // Local Stop never waits for a network revocation.
    if (active) void this.request(active.auth, `/sessions/${active.id}`, 'DELETE', undefined, AbortSignal.timeout(5000)).catch(() => {})
    await Promise.all([shutdown, readinessShutdown])
  }
  private async request(auth: Auth, path: string, method: string, body?: unknown, signal = this.requests.signal): Promise<unknown> {
    const base = new URL(auth.apiUrl)
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('Insecure native API')
    const response = await fetch(`${auth.apiUrl.replace(/\/$/, '')}/api/native-computer${path}`, { method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(path.endsWith('/run') ? 130_000 : 30_000)]), headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error('Native request denied')
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
    const parsed = NativeUiRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'Invalid native request' }
    const input = parsed.data
    if (input.type === 'stop' || input.type === 'disconnect') {
      void this.stop().catch(() => {})
      return { ok: true, status: this.redactedStatus() }
    }
    if (input.type === 'workspace-changed') {
      if (this.workspaceId !== input.workspaceId) {
        this.workspaceId = input.workspaceId
        void this.stop().catch(() => {})
      }
      return { ok: true, status: this.redactedStatus() }
    }
    if (input.type === 'check-readiness') return this.checkReadiness()
    if (!this.enabled || !this.ready) return { ok: false, error: 'Native control unavailable' }
    if ((input.type === 'start' || input.type === 'resume') &&
      ((!this.controlEnabled && (input.allowControl || input.allowCapture)) || (!input.allowControl && input.allowCapture))) {
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
    if (input.type === 'status') return { ok: true, status: this.authenticatedStatus(auth), deviceId: this.deviceId }
    if (this.busy) return { ok: false, error: 'Native setup busy' }
    this.busy = true
    const generation = this.generation
    let completionGeneration = generation
    try {
      if (input.type === 'permissions') {
        if (['active', 'awaiting_action_approval', 'awaiting_local_consent'].includes(this.controller?.status().state ?? '')) {
          return { ok: false, error: 'Stop the current native session before changing permissions.' }
        }
        if (process.platform !== 'darwin') return { ok: false, error: 'Configure desktop accessibility locally; readiness is checked by the helper.' }
        if (await this.consent('Open Accessibility permissions?', 'Only enable Use Brian if you intend to start an attended computer session. Screen Recording is separate and optional. No control starts automatically.', this.requests.signal)) {
          // Permission changes require a fresh helper/takeover monitor and fresh
          // target identities. Never retain an inactive, failed event-tap setup.
          const shutdown = this.stop()
          completionGeneration = this.generation
          await shutdown
          if (completionGeneration !== this.generation) return { ok: false }
          systemPreferences.isTrustedAccessibilityClient(true)
          await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
        }
        return { ok: true, status: this.controller?.status() }
      }
      if (input.type === 'targets') {
        const state = this.controller?.status().state
        if (state && ['active', 'awaiting_action_approval', 'awaiting_local_consent'].includes(state)) return { ok: true, targets: structuredClone(this.selection), status: this.controller?.status() }
        // Reuse the discovery helper: its opaque window/process identities are stable.
        // Only an explicit local discovery after Stop creates a new helper.
        if (!this.controller || state === 'stopped' || state === 'paused_for_user' || state === 'ended') {
          await this.controller?.dispose()
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
          await controller.dispose()
          if (generation !== this.generation) return { ok: false }
          controller = this.makeController()
          await controller.capabilities()
        }
        const targets = await controller.listTargets()
        // Discovery lazily initializes the Mac inspector. The first capabilities
        // request deliberately stays a permissionless bootstrap probe.
        if (process.platform === 'darwin') await controller.capabilities()
        if (generation !== this.generation || this.controller !== controller) return { ok: false, status: this.redactedStatus() }
        this.selection = targets
        return { ok: true, targets: structuredClone(this.selection), status: controller.status(), deviceId: this.deviceId }
      }
      if (!this.controller || input.workspaceId !== this.workspaceId || !this.selection.some(t => sameTarget(t, input.target))) throw new Error('Select a current target first')
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const created = z.object({ identity: IdentitySchema }).passthrough().parse(await this.request(auth, '/sessions', 'POST', { workspaceId: input.workspaceId, assistantId: input.assistantId, conversationId: input.conversationId, taskId: input.taskId, deviceId: this.deviceId, challenge }))
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
    } catch {
      // A late failure from an invalidated request must not stop a newer scope.
      if (completionGeneration === this.generation) await this.stop().catch(() => {})
      return { ok: false, error: 'Native control could not start. Check permissions, task access, and select the window again.', status: this.redactedStatus() }
    } finally { this.busy = false }
  }
}
