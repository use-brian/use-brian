import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import type { NativeControllerOptions, NativeApprovalContext } from '../computer-control/controller.js'
import type { NativeCommand, NativeGrant, NativeStatus, NativeCapabilities } from '@use-brian/computer-control/protocol.js'

const mocks = vi.hoisted(() => ({ directory: '', files: new Set<string>(), launches: [] as any[], helperArgs: [] as any[], helpers: [] as any[], leases: [] as any[], controllers: [] as any[], relays: [] as any[], indicators: [] as any[], ready: async (_signal: AbortSignal): Promise<unknown> => undefined,
  readinessCaps: {} as unknown, readinessDeath: Promise.resolve() as Promise<void> }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, statSync: vi.fn((file: string) => { if (!mocks.files.has(file)) throw new Error('missing'); return { isFile: () => true } }),
    accessSync: vi.fn((file: string) => { if (!mocks.files.has(file)) throw new Error('unreadable') }) }
})
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => mocks.directory, on: vi.fn() },
  globalShortcut: { register: vi.fn(() => true) }, powerMonitor: { on: vi.fn() }, ipcMain: { on: vi.fn() },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0 } }) },
  shell: { openExternal: vi.fn() }, systemPreferences: { isTrustedAccessibilityClient: vi.fn() },
  BrowserWindow: class {
    constructor() { mocks.indicators.push(this) }
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), send: vi.fn() }
    on = vi.fn(); loadFile = vi.fn(async () => {}); showInactive = vi.fn(); destroy = vi.fn(); isDestroyed = () => false
  },
}))
vi.mock('../computer-control/index.js', () => ({
  NativeComputerController: class {
    state: NativeStatus['state'] = 'ready'
    grant?: NativeGrant
    epoch = 0
    caps: NativeCapabilities = { protocol: 'native-computer-v1', platform: process.platform as NativeCapabilities['platform'],
      axRead: true, semanticActions: true, windowCapture: false, input: false,
      accessibilityPermission: 'granted', capturePermission: 'denied', limitations: [] }
    constructor(readonly options: NativeControllerOptions) { mocks.controllers.push(this) }
    status = () => ({ protocol: 'native-computer-v1', state: this.state, capabilities: this.caps, epoch: Math.max(this.epoch, this.grant?.epoch ?? 0), ...(this.grant ? { identity: this.grant.identity } : {}) })
    capabilities = vi.fn(async () => this.caps)
    listTargets = vi.fn(async () => [{ appId: 'editor', processId: 42, processInstanceId: 'process-instance', windowId: 'window', windowInstanceId: 'window-instance' }])
    start = vi.fn(async (grant: NativeGrant) => { this.grant = grant; this.state = 'active' })
    inspectSelected = vi.fn(async () => ({ id: 'local-ax', capturedAt: Date.now(), completeness: 'complete', nodes: [] }))
    stop = vi.fn(async () => { if (this.state !== 'stopped') this.epoch = this.status().epoch + 1; this.state = 'stopped'; this.options.onStatus?.(this.status() as NativeStatus) })
    identityChanged = vi.fn(() => {
      const epoch = this.status().epoch + (this.state === 'stopped' ? 0 : 1)
      const shutdown = this.stop()
      this.epoch = epoch; this.grant = undefined
      return shutdown
    })
    dispose = vi.fn(async () => {})
  },
  NativeRelayClient: class {
    constructor() { mocks.relays.push(this) }
    connect = vi.fn(); disconnect = vi.fn()
    waitUntilReady = vi.fn((signal: AbortSignal) => mocks.ready(signal))
  },
  PrivatePipeHelper: class {
    constructor(spec: unknown, onDeath: unknown, timeout: unknown, timing: unknown) { mocks.launches.push(spec); mocks.helperArgs.push([spec, onDeath, timeout, timing]); mocks.helpers.push(this) }
    readinessDiagnostics = vi.fn(() => ({ requestTimedOut: false, exitObserved: true, exitCode: 77, exitSignal: null, spawnFailed: false }))
    capabilities = vi.fn(async () => mocks.readinessCaps)
    kill = vi.fn(() => mocks.readinessDeath)
  },
  LocalDeviceLease: class {
    constructor() { mocks.leases.push(this) }
    acquire = vi.fn(async () => {})
    release = vi.fn(async () => {})
  },
}))
import { app, powerMonitor, globalShortcut, dialog, shell, systemPreferences } from 'electron'
import { NativeComputerIntegration, NativeUiRequestSchema } from '../native-computer-integration.js'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const target = { appId: 'editor', processId: 42, processInstanceId: 'process-instance', windowId: 'window', windowInstanceId: 'window-instance' }
const selection = { type: 'start', workspaceId: uuid(1), assistantId: uuid(2), conversationId: uuid(3), taskId: uuid(4), goal: 'Read the selected window', target, allowControl: true, allowCapture: false }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function pending(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => { const abort = () => reject(new Error('aborted')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() })
}
let integration: NativeComputerIntegration
let auth: { userId: string; accessToken: string; apiUrl: string; accountKey: string } | null
let fetchMock: ReturnType<typeof vi.fn>
let platform: PropertyDescriptor
let resourcesPath: PropertyDescriptor | undefined
let pairingBlocked: boolean
const requests: { path: string; init: RequestInit }[] = []
beforeEach(() => {
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  vi.stubEnv('NATIVE_COMPUTER_ENABLED', 'true')
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true }); mocks.files.clear(); mocks.launches.length = 0; mocks.helperArgs.length = 0
  mocks.directory = mkdtempSync(join(tmpdir(), 'native-integration-'))
  mocks.controllers.length = 0; mocks.relays.length = 0; mocks.indicators.length = 0; requests.length = 0; pairingBlocked = false
  mocks.ready = async () => {}
  mocks.helpers.length = 0; mocks.leases.length = 0; mocks.readinessDeath = Promise.resolve()
  mocks.readinessCaps = { protocol: 'native-computer-v1', platform: 'darwin', axRead: false, semanticActions: false, windowCapture: false, input: false,
    accessibilityPermission: 'unknown', capturePermission: 'unknown', limitations: ['Operational acceptance pending.'] }
  auth = { userId: uuid(5), accessToken: 'private-access-token', apiUrl: 'https://api.example', accountKey: 'account-one' }
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname; requests.push({ path, init })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (path.endsWith('/run') || (path.endsWith('/exchange') && pairingBlocked)) return pending(init.signal!)
    if (path.endsWith('/exchange')) return Response.json({ token: 'private-relay-token', relayUrl: 'wss://relay.example', expiresAt: Date.now() + 60000 })
    const body = JSON.parse(init.body as string)
    return Response.json({ identity: { deploymentId: 'deployment', userId: auth!.userId, workspaceId: body.workspaceId, deviceId: body.deviceId, sessionId: uuid(6), conversationId: body.conversationId, taskId: body.taskId } })
  })
  vi.stubGlobal('fetch', fetchMock)
  integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth: async () => auth })
  integration.install()
})
afterEach(async () => {
  await integration.stop()
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', platform)
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath)
  else Reflect.deleteProperty(process, 'resourcesPath')
  rmSync(mocks.directory, { recursive: true, force: true })
})
async function discover() {
  await integration.handle({ type: 'workspace-changed', workspaceId: selection.workspaceId })
  return integration.handle({ type: 'targets' })
}
const controller = () => mocks.controllers.at(-1)!

describe('task result notices', () => {
  async function runResponse(response: Promise<Response>) {
    await discover()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((url: string, init: RequestInit) => url.endsWith('/run') ? response : original(url, init))
    vi.mocked(dialog.showMessageBox).mockClear()
    expect(await integration.handle(selection)).toMatchObject({ ok: true })
  }
  it.each(['completed', 'paused', 'cancelled', 'execution_unknown', 'unavailable', 'unsupported'])('shows fixed copy for %s', async outcome => {
    await runResponse(Promise.resolve(Response.json({ sessionId: uuid(6), data: { outcome, reason: 'PRIVATE_REASON', text: 'PRIVATE_TEXT' } })))
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledTimes(1))
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: outcome === 'completed' ? 'info' : 'warning' }))
    expect(JSON.stringify(vi.mocked(dialog.showMessageBox).mock.calls)).not.toContain('PRIVATE')
    expect(controller().identityChanged).toHaveBeenCalled()
    const signal = vi.mocked(dialog.showMessageBox).mock.calls[0][0].signal!
    expect(signal.aborted).toBe(false)
    await integration.handle({ type: 'stop' })
    expect(signal.aborted).toBe(true)
  })
  it.each([
    { data: 'Native runtime unavailable', isError: true },
    { data: 'PRIVATE_ACCOUNTING_ERROR', isError: true },
    { data: { outcome: 'PRIVATE_FOREIGN_OUTCOME' } },
    { data: { outcome: 'x'.repeat(1000) } },
    null, {}, { data: { outcome: 123 } },
    { duplicate: true, data: { outcome: 'completed' } },
    { data: { duplicate: true, outcome: 'completed' } },
    { data: { outcome: 'completed' }, isError: true },
    { sessionId: uuid(99), data: { outcome: 'completed' } },
    { sessionId: undefined, data: { outcome: 'completed' } },
  ])('warns without echoing malformed, foreign or duplicate data: %#', async body => {
    await runResponse(Promise.resolve(Response.json({ sessionId: uuid(6), ...body })))
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledTimes(1))
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning',
      detail: 'The task could not be completed or its result could not be confirmed. Review the selected application before starting another task.' }))
  })
  it.each(['http', 'rejection', 'json'])('surfaces %s failure', async failure => {
    const response = deferred<Response>()
    await runResponse(response.promise.then(value => { if (failure === 'rejection') throw new Error('PRIVATE_ERROR'); return value }))
    response.resolve(new Response('PRIVATE_BODY', { status: failure === 'http' ? 503 : 200 }))
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledTimes(1))
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning',
      detail: 'The task request failed. Its result could not be confirmed. Review the selected application before starting another task.' }))
  })
  it.each(['success', 'stop', 'workspace', 'account', 'sign-out', 'cleanup-failed'])('waits for cleanup and drops invalidated result: %s', async change => {
    const response = deferred<Response>()
    await runResponse(response.promise)
    const death = deferred<void>()
    controller().stop.mockImplementationOnce(() => death.promise.then(() => { if (change === 'cleanup-failed') throw new Error('PRIVATE'); }))
    const previous = controller().identityChanged.mock.calls.length
    response.resolve(Response.json({ sessionId: uuid(6), data: { outcome: 'completed' } }))
    await vi.waitFor(() => expect(controller().identityChanged.mock.calls.length).toBe(previous + 1))
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(await integration.handle({ type: 'status' })).toEqual({ ok: true, cleanupPending: true })
    const completingController = controller()
    expect(await integration.handle({ type: 'targets' })).toMatchObject({ ok: false })
    expect(controller()).toBe(completingController) // Polling cannot consume the terminal result.
    if (change === 'stop') await integration.handle({ type: 'stop' })
    if (change === 'workspace') await integration.handle({ type: 'workspace-changed', workspaceId: uuid(99) })
    if (change === 'account') auth = { ...auth!, accountKey: 'replacement' }
    if (change === 'sign-out') auth = null
    death.resolve()
    if (change === 'success') await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledTimes(1))
    else { await new Promise(resolve => setTimeout(resolve, 20)); expect(dialog.showMessageBox).not.toHaveBeenCalled() }
    expect(await integration.handle({ type: 'status' })).toMatchObject({ cleanupPending: change === 'cleanup-failed' })
  })
})

describe('trusted main native computer setup', () => {
  async function packagedReadiness() {
    await integration.stop()
    vi.stubEnv('NATIVE_COMPUTER_ENABLED', 'false'); vi.stubEnv('NATIVE_COMPUTER_PILOT_ACCEPTED', 'false')
    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true })
    Object.defineProperty(process, 'resourcesPath', { value: '/signed/Use Brian.app/Contents/Resources', configurable: true })
    mocks.files.add('/signed/Use Brian.app/Contents/Resources/computer-control/brian-native-computer-helper')
    const getAuth = vi.fn(async () => { throw new Error('Readiness must not contact auth or the API') })
    integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth }); integration.install()
    return getAuth
  }

  it('packaged Mac tasks remain unavailable with rollout enabled but pilot acceptance absent', async () => {
    await packagedReadiness()
    vi.stubEnv('NATIVE_COMPUTER_ENABLED', 'true')
    vi.stubEnv('NATIVE_COMPUTER_INSPECTOR_ENABLED', 'false')
    const getAuth = vi.fn(async () => auth)
    integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth }); integration.install()
    await discover()
    expect(await integration.handle(selection)).toMatchObject({ ok: false, error: 'Native control unavailable' })
    expect(getAuth).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(process.env.NATIVE_COMPUTER_PILOT_ACCEPTED).toBe('false')
  })

  it('packaged inspector opt-in authorizes only a one-shot read, not control/capture or pilot acceptance', async () => {
    await packagedReadiness()
    vi.stubEnv('NATIVE_COMPUTER_INSPECTOR_ENABLED', 'true')
    integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth: async () => auth }); integration.install()
    await discover()
    expect(controller().options.observationOnly).toBe(true)
    expect(controller().caps.semanticActions).toBe(true) // UI gate must not rely on helper refusal.
    for (const [allowControl, allowCapture] of [[true, false], [false, true], [true, true]]) {
      expect(await integration.handle({ ...selection, allowControl, allowCapture })).toMatchObject({ ok: false })
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await integration.handle({ ...selection, allowControl: false, allowCapture: false })).toMatchObject({ ok: true, inspection: { id: 'local-ax' } })
    expect(requests.some(row => row.path.endsWith('/run'))).toBe(false)
    expect(requests.some(row => row.path.endsWith('/exchange'))).toBe(true)
    expect(controller().start.mock.calls[0][0]).toMatchObject({ allowControl: false, allowCapture: false })
    expect(process.env.NATIVE_COMPUTER_PILOT_ACCEPTED).toBe('false')
  })

  it('readiness logs fixed lifecycle diagnostics, never raw helper or auth errors', async () => {
    await packagedReadiness()
    mocks.readinessCaps = { privateText: 'DO_NOT_LOG' }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await integration.handle({ type: 'check-readiness' })).toMatchObject({ ok: false })
      expect(warning).toHaveBeenCalledWith('[native-computer] readiness failed', {
        stage: 'validation', requestTimedOut: false, exitObserved: true, exitCode: 77, exitSignal: null, spawnFailed: false,
      })
      expect(JSON.stringify(warning.mock.calls)).not.toContain('DO_NOT_LOG')
    } finally { warning.mockRestore() }
  })

  it('explicit packaged readiness uses only capabilities with rollout disabled and retains the lease until death', async () => {
    const getAuth = await packagedReadiness()
    const count = mocks.controllers.length
    const result = await integration.handle({ type: 'check-readiness' })
    expect(result).toMatchObject({ ok: true, readiness: { helperAdmitted: true, capabilities: { axRead: false, input: false } } })
    expect(getAuth).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.controllers).toHaveLength(count); expect(mocks.relays).toHaveLength(0)
    expect(mocks.helpers).toHaveLength(1)
    expect(mocks.helpers[0].capabilities).toHaveBeenCalledOnce()
    expect(mocks.leases.at(-1).acquire).toHaveBeenCalledOnce()
    expect(mocks.leases.at(-1).release).toHaveBeenCalledOnce()
    expect(mocks.helpers[0].kill.mock.invocationCallOrder[0]).toBeLessThan(mocks.leases.at(-1).release.mock.invocationCallOrder[0])
    expect(await integration.handle({ type: 'targets' })).toMatchObject({ ok: false, error: 'Native control unavailable' })
  })

  it('readiness refuses a development parent and never starts a helper', async () => {
    expect(await integration.handle({ type: 'check-readiness' })).toMatchObject({ ok: false })
    expect(mocks.helpers).toHaveLength(0)
  })

  it('Stop remains immediate during readiness cleanup and discards the late admission result', async () => {
    await packagedReadiness()
    const death = deferred<void>(); mocks.readinessDeath = death.promise
    const check = integration.handle({ type: 'check-readiness' })
    await vi.waitFor(() => expect(mocks.helpers[0]?.kill).toHaveBeenCalledOnce())
    const lease = mocks.leases.at(-1)
    expect(lease.release).not.toHaveBeenCalled()
    expect(await integration.handle({ type: 'stop' })).toMatchObject({ ok: true })
    expect(lease.release).not.toHaveBeenCalled()
    expect(await integration.handle({ type: 'check-readiness' })).toMatchObject({ ok: false })
    death.resolve()
    expect(await check).toEqual({ ok: false, cleanupPending: false })
    expect(lease.release).toHaveBeenCalledOnce()
  })

  it('readiness refuses wrong-platform capability metadata without any grant or network call', async () => {
    await packagedReadiness()
    mocks.readinessCaps = { ...(mocks.readinessCaps as object), platform: 'win32' }
    expect(await integration.handle({ type: 'check-readiness' })).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.leases.at(-1).release).toHaveBeenCalledOnce()
  })
  it('Stop detaches an initial auth read that never settles and allows fresh discovery', async () => {
    await integration.stop()
    const hung = deferred<typeof auth>()
    const getAuth = vi.fn().mockReturnValueOnce(hung.promise).mockResolvedValue(auth)
    integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth }); integration.install()
    const setup = integration.handle({ type: 'targets' })
    await vi.waitFor(() => expect(getAuth).toHaveBeenCalledOnce())
    await integration.handle({ type: 'stop' })
    expect(await setup).toMatchObject({ ok: false })
    const fresh = await integration.handle({ type: 'targets' })
    expect(fresh).toMatchObject({ ok: true, targets: [target] })
    hung.resolve(auth)
    expect(controller().listTargets).toHaveBeenCalledOnce()
  })

  it('permission schema is closed and preserves the legacy request', () => {
    for (const request of [{ type: 'permissions' }, { type: 'permissions', permission: 'accessibility' }, { type: 'permissions', permission: 'screen-recording' }]) {
      expect(NativeUiRequestSchema.safeParse(request).success).toBe(true)
    }
    for (const extra of [{ permission: 'camera' }, { permission: 'Privacy_ScreenCapture' }, { permission: null }, { url: 'https://example.com' }, { permission: 'screen-recording', url: 'x-apple.systempreferences:anything' }]) {
      expect(NativeUiRequestSchema.safeParse({ type: 'permissions', ...extra }).success).toBe(false)
    }
  })

  it.each(['accessibility', 'screen-recording'] as const)('%s settings require consent and only open the exact pane without OS prompts', async permission => {
    await discover()
    vi.mocked(dialog.showMessageBox).mockClear(); vi.mocked(shell.openExternal).mockClear()
    vi.mocked(systemPreferences.isTrustedAccessibilityClient).mockClear()
    expect(await integration.handle({ type: 'permissions', permission })).toMatchObject({ ok: true })
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: `Open ${permission === 'accessibility' ? 'Accessibility' : 'Screen Recording'} settings?`, defaultId: 0, cancelId: 0 }))
    expect(shell.openExternal).toHaveBeenCalledOnce()
    expect(shell.openExternal).toHaveBeenCalledWith(`x-apple.systempreferences:com.apple.preference.security?${permission === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture'}`)
    expect(systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalled()
    expect(controller().start).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['accessibility', 'screen-recording'] as const)('%s cancellation opens nothing and does not start or stop a session', async permission => {
    await discover()
    const current = controller()
    vi.mocked(shell.openExternal).mockClear()
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await integration.handle({ type: 'permissions', permission })).toEqual({ ok: false, cleanupPending: false })
    expect(shell.openExternal).not.toHaveBeenCalled()
    expect(current.identityChanged).not.toHaveBeenCalled()
    expect(current.start).not.toHaveBeenCalled()
  })

  it.each(['account', 'logout', 'workspace', 'stop', 'active'] as const)('rejects stale Screen Recording consent after %s changes', async change => {
    await discover()
    vi.mocked(dialog.showMessageBox).mockClear()
    const consent = deferred<{ response: number; checkboxChecked: boolean }>()
    vi.mocked(dialog.showMessageBox).mockReturnValueOnce(consent.promise)
    vi.mocked(shell.openExternal).mockClear()
    const setting = integration.handle({ type: 'permissions', permission: 'screen-recording' })
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalled())
    if (change === 'account') auth = { ...auth!, accountKey: 'replacement' }
    if (change === 'logout') auth = null
    if (change === 'workspace') await integration.handle({ type: 'workspace-changed', workspaceId: uuid(99) })
    if (change === 'stop') await integration.stop()
    if (change === 'active') controller().state = 'active'
    consent.resolve({ response: 1, checkboxChecked: false })
    expect(await setting).toMatchObject({ ok: false })
    expect(shell.openExternal).not.toHaveBeenCalled()
    expect(controller().start).not.toHaveBeenCalled()
  })

  it('revalidates account after permission helper shutdown', async () => {
    await discover()
    const death = deferred<void>()
    controller().identityChanged.mockImplementationOnce(() => death.promise)
    vi.mocked(shell.openExternal).mockClear()
    const setting = integration.handle({ type: 'permissions', permission: 'screen-recording' })
    await vi.waitFor(() => expect(controller().identityChanged).toHaveBeenCalledOnce())
    auth = { ...auth!, accountKey: 'replacement' }
    death.resolve()
    expect(await setting).toMatchObject({ ok: false })
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it.each(['accessibility', 'screen-recording'] as const)('%s setup is rejected during a live session without opening another dialog', async permission => {
    await discover()
    controller().state = 'active'
    vi.mocked(dialog.showMessageBox).mockClear(); vi.mocked(shell.openExternal).mockClear()
    expect(await integration.handle({ type: 'permissions', permission })).toMatchObject({ ok: false })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('permission setup clears old selection and waits for helper death before opening settings', async () => {
    await discover()
    const current = controller(), death = deferred<void>()
    current.identityChanged.mockImplementationOnce(() => { current.state = 'stopped'; return death.promise })
    vi.mocked(shell.openExternal).mockClear()
    const setting = integration.handle({ type: 'permissions' })
    await vi.waitFor(() => expect(current.identityChanged).toHaveBeenCalledOnce())
    expect(shell.openExternal).not.toHaveBeenCalled()
    death.resolve()
    expect(await setting).toMatchObject({ ok: true, status: { state: 'stopped' } })
    expect(shell.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    expect(await integration.handle(selection)).toMatchObject({ ok: false })
    expect(current.start).not.toHaveBeenCalled()
  })

  it('a newly granted Mac AX permission recreates a helper whose takeover tap is missing', async () => {
    await discover()
    const old = controller()
    old.caps = { ...old.caps, axRead: false, semanticActions: false, accessibilityPermission: 'denied' }
    old.state = 'permission_required'
    old.capabilities.mockImplementationOnce(async () => {
      old.caps = { ...old.caps, accessibilityPermission: 'granted' }
      return old.caps
    })
    old.listTargets.mockClear()
    expect(await integration.handle({ type: 'targets' })).toMatchObject({ ok: true })
    expect(old.dispose).toHaveBeenCalledOnce()
    expect(old.listTargets).not.toHaveBeenCalled()
    expect(controller()).not.toBe(old)
    expect(controller().capabilities).toHaveBeenCalledTimes(2)
    expect(controller().listTargets).toHaveBeenCalledOnce()
  })
  it.each(['darwin', 'win32', 'linux'] as const)('%s requires its own packaged acceptance, fixed readable files and Stop hooks', async platform => {
    await integration.stop(); mocks.controllers.length = 0
    Object.defineProperty(process, 'platform', { value: platform })
    const previous = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: platform === 'win32' ? 'C:\\resources' : '/resources' })
    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true })
    const flags = { darwin: 'NATIVE_COMPUTER_PILOT_ACCEPTED', win32: 'NATIVE_COMPUTER_WINDOWS_ACCEPTED', linux: 'NATIVE_COMPUTER_LINUX_ACCEPTED' }
    for (const flag of Object.values(flags)) vi.stubEnv(flag, flag === flags[platform] ? 'false' : 'true')
    integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth: async () => auth }); integration.install()
    expect(mocks.controllers).toHaveLength(0)
    vi.stubEnv(flags[platform], 'true')
    integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth: async () => auth }); integration.install()
    const options = controller().options as NativeControllerOptions
    expect(options.safetyControlsReady()).toBe(false)
    options.helperFactory(() => {})
    const spec = mocks.launches.at(-1)
    const paths = platform === 'win32' ? win32 : posix
    expect(spec).toEqual(platform === 'darwin'
      ? { platform, executable: '/resources/computer-control/brian-native-computer-helper', args: [] }
      : platform === 'win32' ? { platform, executable: 'C:\\resources\\native\\computer-control\\windows\\Brian.NativeHelper.exe', args: [] }
      : { platform, executable: '/usr/bin/python3', args: ['-Es', '/resources/native/computer-control/linux/helper.py'] })
    mocks.files.add(spec.executable)
    if (platform === 'linux') {
      expect(options.safetyControlsReady()).toBe(false)
      for (const file of ['helper.py', 'contract.py', 'x11.py', 'xinput.py', 'safety.py', 'atspi_backend.py', 'fixture.py', 'dependencies.json']) mocks.files.add(paths.join(paths.dirname(spec.args[1]), file))
    }
    expect(options.safetyControlsReady()).toBe(true)
    if (platform === 'linux') {
      const xinput = paths.join(paths.dirname(spec.args[1]), 'xinput.py')
      mocks.files.delete(xinput); expect(options.safetyControlsReady()).toBe(false); mocks.files.add(xinput)
    }
    mocks.files.delete(spec.executable); expect(options.safetyControlsReady()).toBe(false)
    expect(powerMonitor.on).toHaveBeenCalledWith('lock-screen', expect.any(Function))
    expect(powerMonitor.on).toHaveBeenCalledWith('suspend', expect.any(Function))
    const [accelerator, stop] = vi.mocked(globalShortcut.register).mock.calls.at(-1)!
    expect(accelerator).toBe(platform === 'darwin' ? 'CommandOrControl+Shift+Escape' : 'Control+Alt+Shift+Escape')
    stop()
    expect(controller().stop).toHaveBeenCalled()
    if (platform !== 'darwin') {
      vi.mocked(shell.openExternal).mockClear()
      expect(await integration.handle({ type: 'permissions' })).toMatchObject({ ok: false })
      expect(shell.openExternal).not.toHaveBeenCalled()
    }
    if (previous) Object.defineProperty(process, 'resourcesPath', previous)
    else delete (process as any).resourcesPath
  })
  it.each(['darwin', 'win32', 'linux'])('%s approval discloses checked focus restoration without a manual-return timer', async platform => {
    Object.defineProperty(process, 'platform', { value: platform })
    vi.useFakeTimers()
    try {
      const approving = controller().options.approveGrant({ requester: 'User', identity: { workspaceId: 'w', deploymentId: 'd' }, goal: 'Read', allowControl: true, targets: [target], expiresAt: Date.now() + 60000 }, new AbortController().signal)
      expect(await approving).toBe(true)
      const detail = vi.mocked(dialog.showMessageBox).mock.calls.at(-1)![0].detail!
      expect(detail).toContain('restore only the selected window'); expect(detail).toContain('fails closed')
      expect(detail).not.toContain('5 seconds'); expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it.each([[true, true], [true, false], [false, true], [false, false]])('consent for control=%s capture=%s discloses capture-only support and model use accurately', async (allowControl, allowCapture) => {
    await discover()
    controller().start.mockImplementation(async (grant: NativeGrant) => {
      expect(await controller().options.approveGrant(grant, new AbortController().signal)).toBe(true)
      controller().grant = grant; controller().state = 'active'
    })
    const result = await integration.handle({ ...selection, allowControl, allowCapture })
    if (!allowControl && allowCapture) {
      expect(result).toMatchObject({ ok: false })
      expect(controller().start).not.toHaveBeenCalled()
      expect(dialog.showMessageBox).not.toHaveBeenCalled()
      return
    }
    expect(result).toMatchObject({ ok: true })
    expect(controller().start.mock.calls[0][0]).toMatchObject({ allowControl, allowCapture })
    const detail = vi.mocked(dialog.showMessageBox).mock.calls.at(-1)![0].detail!
    if (allowControl && allowCapture) {
      expect(detail).toContain('Screenshot support: selected-window safe fixture canvas capture only.')
      expect(detail).toContain('Coordinate clicks and screenshot-to-action fallback are unavailable.')
    } else {
      expect(detail).toContain('No screenshot capture.')
      expect(detail).not.toContain('Screenshot support:')
    }
    expect(detail).not.toMatch(/Screenshot fallback:|one click per grant|fresh completion readback/i)
    expect(detail).not.toContain('approved images are sent')
    if (allowControl) {
      expect(detail).toContain('Accessibility text is sent to your configured model provider. Local execution is not local inference.')
      expect(detail).not.toContain('No model task')
      if (allowCapture) {
        expect(detail).toContain('Images may be sent to that provider only after separate image-upload approval and model-policy checks; capture consent alone is not sufficient.')
      } else {
        expect(detail).not.toMatch(/images|image-upload/i)
      }
    } else {
      expect(detail).toContain('AX inspector: one read of the selected window is shown locally, then the session ends automatically. No model task or screenshot capture.')
      expect(detail).not.toContain('sent to your configured model provider')
      expect(detail).not.toMatch(/images|image-upload/i)
    }
  })
  it('Mac read-only consent explicitly promises no activation, raising or editing', async () => {
    await controller().options.approveGrant({ requester: 'User', identity: { workspaceId: 'w', deploymentId: 'd' },
      goal: 'Read', allowControl: false, allowCapture: false, targets: [target], expiresAt: Date.now() + 60000 }, new AbortController().signal)
    const detail = vi.mocked(dialog.showMessageBox).mock.calls.at(-1)![0].detail!
    expect(detail).toContain('will not activate, raise or edit')
    expect(detail).not.toContain('restore only the selected window')
  })
  it('real action dialog denies missing/ambiguous context and displays exact parameters and parent context as quoted data', async () => {
    const approve = controller().options.approveAction as NativeControllerOptions['approveAction']
    const identity = { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'device', sessionId: 's', conversationId: 'c', taskId: 't' }
    const command: NativeCommand = { protocol: 'native-computer-v1', identity, commandId: 'command', grantId: 'grant', epoch: 1,
      deadlineAt: Date.now() + 30000, action: { kind: 'setValue', target, observationId: 'obs', ref: 'ref', text: '<b>Allow</b>\n"exact"' } }
    const bounds = { x: 10, y: 20, width: 30, height: 40 }
    const context: NativeApprovalContext = { commandId: command.commandId, grantId: command.grantId, identity, epoch: 1, target, observationId: 'obs',
      nodes: [{ ref: 'ref', parentRef: 'parent', name: 'Save', role: 'button', bounds }, { ref: 'parent', name: 'Second panel', role: 'group', bounds }] }
    const signal = new AbortController().signal
    vi.mocked(dialog.showMessageBox).mockClear()
    for (const invalid of [undefined, { ...context, observationId: 'other' }, { ...context, commandId: 'other' },
      { ...context, identity: { ...identity, taskId: 'other' } }, { ...context, target: { ...target, windowInstanceId: 'other' } },
      { ...context, nodes: [...context.nodes, context.nodes[0]] }, { ...context, nodes: [context.nodes[0]] },
      { ...context, nodes: [{ ...context.nodes[0], bounds: undefined }, context.nodes[1]] },
      { ...context, nodes: [{ ...context.nodes[0], parentRef: 'ref' }] }]) {
      expect(await approve(command, signal, invalid)).toBe(false)
    }
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    for (const action of [command.action, { kind: 'scroll' as const, target, observationId: 'obs', ref: 'ref', deltaY: -123 },
      { kind: 'key' as const, target, observationId: 'obs', key: 'Shift+Tab' as const }]) {
      expect(await approve({ ...command, action }, signal, context)).toBe(true)
      const detail = vi.mocked(dialog.showMessageBox).mock.calls.at(-1)![0].detail!
      expect(detail).toContain(JSON.stringify(action))
      if ('ref' in action) expect(detail).toContain(JSON.stringify(context.nodes))
    }
  })
  it('keeps opaque target identities and the discovery controller stable across polls', async () => {
    const first = await discover(); const current = controller(); const count = mocks.controllers.length
    expect(first).toMatchObject({ ok: true, targets: [target] })
    for (let i = 0; i < 3; i++) expect(await integration.handle({ type: 'targets' })).toEqual(first)
    expect(mocks.controllers).toHaveLength(count)
    expect(current.dispose).not.toHaveBeenCalled()
    expect(current.listTargets).toHaveBeenCalledTimes(4)
  })
  it.each(['awaiting_local_consent', 'awaiting_action_approval', 'active'])('polling targets in %s never disposes or rediscovers', async state => {
    await discover(); const current = controller(); current.state = state
    expect(await integration.handle({ type: 'targets' })).toMatchObject({ ok: true, targets: [target] })
    expect(current.dispose).not.toHaveBeenCalled(); expect(current.listTargets).toHaveBeenCalledOnce()
  })
  it('does not dispose or change selection while start is awaiting local approval', async () => {
    await discover(); const current = controller(); const approval = deferred<void>()
    current.start.mockImplementationOnce(async () => { current.state = 'awaiting_local_consent'; await approval.promise })
    const starting = integration.handle(selection)
    await vi.waitFor(() => expect(current.state).toBe('awaiting_local_consent'))
    expect(await integration.handle({ type: 'targets' })).toMatchObject({ ok: false, error: 'Native setup busy' })
    expect(current.dispose).not.toHaveBeenCalled(); expect(current.listTargets).toHaveBeenCalledOnce()
    approval.resolve(); expect(await starting).toMatchObject({ ok: true })
  })
  it.each(['userId', 'workspaceId', 'deviceId', 'conversationId', 'taskId'])('rejects changed server %s before granting local authority', async field => {
    await discover()
    const status = await integration.handle({ type: 'status' }) as { deviceId: string }
    fetchMock.mockResolvedValueOnce(Response.json({ identity: {
      deploymentId: 'deployment', userId: auth!.userId, workspaceId: selection.workspaceId,
      deviceId: status.deviceId, sessionId: uuid(6), conversationId: selection.conversationId,
      taskId: selection.taskId, [field]: uuid(99),
    } }))
    expect(await integration.handle(selection)).toMatchObject({ ok: false })
    expect(controller().start).not.toHaveBeenCalled(); expect(mocks.relays).toHaveLength(0)
  })
  it.each(['appId', 'processId', 'processInstanceId', 'windowId', 'windowInstanceId'])('rejects forged target %s before any network authority', async field => {
    await discover()
    expect(await integration.handle({ ...selection, target: { ...target, [field]: field === 'processId' ? 99 : 'forged' } })).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled(); expect(controller().start).not.toHaveBeenCalled()
  })
  it('read-only pairs, waits for READY, then reads once locally without POST run or capture authority', async () => {
    await discover()
    const ready = deferred<void>(); mocks.ready = () => ready.promise
    const result = integration.handle({ ...selection, allowControl: false, allowCapture: false })
    await vi.waitFor(() => expect(mocks.relays).toHaveLength(1))
    expect(controller().inspectSelected).not.toHaveBeenCalled()
    ready.resolve()
    const response = await result
    expect(response).toMatchObject({ ok: true, status: { state: 'stopped', identity: controller().start.mock.calls[0][0].identity }, inspection: { id: 'local-ax' } })
    expect(controller().stop).toHaveBeenCalledOnce()
    expect(mocks.relays[0].disconnect).toHaveBeenCalledOnce()
    expect(requests.filter(r => r.init.method === 'DELETE')).toHaveLength(1)
    expect(controller().inspectSelected).toHaveBeenCalledExactlyOnceWith()
    expect(controller().start.mock.calls[0][0].allowCapture).toBe(false)
    expect(controller().grant).toBeUndefined()
    expect(requests.some(r => r.path.endsWith('/exchange'))).toBe(true)
    expect(requests.some(r => r.path.endsWith('/run'))).toBe(false)
    for (const secret of ['private-access-token', 'private-relay-token', 'verifier', 'grantId', 'frame']) expect(JSON.stringify(response)).not.toContain(secret)
  })
  it.each(['stop', 'sign-out', 'workspace', 'account', 'success', 'revoke-failed'])('one-shot waits for cleanup and drops response on %s', async change => {
    await discover()
    const death = deferred<void>(); const revoke = deferred<Response>()
    const current = controller()
    current.stop.mockImplementationOnce(async () => { current.state = 'stopped'; await death.promise })
    const originalFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((url: string, init: RequestInit) => init.method === 'DELETE' ? revoke.promise : originalFetch(url, init))
    let settled = false
    const starting = integration.handle({ ...selection, allowControl: false }).then(result => { settled = true; return result })
    await vi.waitFor(() => expect(current.stop).toHaveBeenCalledOnce())
    expect(settled).toBe(false); expect(mocks.relays[0].disconnect).toHaveBeenCalledOnce()
    if (change === 'stop') await integration.stop()
    if (change === 'sign-out') auth = null
    if (change === 'account') auth = { ...auth!, accountKey: 'other' }
    if (change === 'workspace') await integration.handle({ type: 'workspace-changed', workspaceId: uuid(90) })
    revoke.resolve(new Response(null, { status: change === 'revoke-failed' ? 500 : 204 }))
    await Promise.resolve(); expect(settled).toBe(false)
    death.resolve()
    const response = await starting
    expect(response).toMatchObject({ ok: change === 'success' })
    if (change !== 'success') expect(response).not.toHaveProperty('inspection')
    expect(requests.some(r => r.path.endsWith('/run'))).toBe(false)
  })
  it('rechecks generation after the final asynchronous auth check', async () => {
    await integration.stop()
    const authCheck = deferred<typeof auth>(); let calls = 0
    integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth: async () => ++calls === 3 ? authCheck.promise : auth })
    integration.install(); await discover()
    const result = integration.handle({ ...selection, allowControl: false })
    await vi.waitFor(() => expect(calls).toBe(3))
    await integration.stop(); authCheck.resolve(auth)
    const response = await result
    expect(response).toMatchObject({ ok: false }); expect(response).not.toHaveProperty('inspection')
  })
  it.each(['stop', 'workspace', 'account', 'sign-out'])('drops late inspection after %s', async change => {
    await discover()
    const read = deferred<unknown>()
    controller().inspectSelected.mockImplementationOnce(() => read.promise)
    const result = integration.handle({ ...selection, allowControl: false })
    await vi.waitFor(() => expect(controller().inspectSelected).toHaveBeenCalledOnce())
    if (change === 'stop') await integration.stop()
    if (change === 'workspace') await integration.handle({ type: 'workspace-changed', workspaceId: uuid(90) })
    if (change === 'account') auth = { ...auth!, accountKey: 'other' }
    if (change === 'sign-out') auth = null
    read.resolve({ id: 'private-late-read', nodes: [] })
    const response = await result
    expect(response).toMatchObject({ ok: false })
    expect(JSON.stringify(response)).not.toContain('private-late-read')
    expect(requests.some(r => r.path.endsWith('/run'))).toBe(false)
  })
  it('waits for relay READY before POST run and returns no credentials or grant material', async () => {
    const targets = await discover()
    const ready = deferred<void>()
    mocks.ready = signal => Promise.race([ready.promise, pending(signal)])
    const result = integration.handle(selection)
    await vi.waitFor(() => expect(mocks.relays).toHaveLength(1))
    expect(requests.some(r => r.path.endsWith('/run'))).toBe(false)
    ready.resolve()
    const started = await result
    expect(started).toMatchObject({ ok: true })
    expect(requests.filter(r => r.path.endsWith('/run'))).toHaveLength(1)
    const ui = JSON.stringify([targets, started, await integration.handle({ type: 'status' })])
    for (const secret of ['private-access-token', 'private-relay-token', 'verifier', 'challenge', 'grantId', 'authorization']) expect(ui).not.toContain(secret)
  })
  it.each(['pairing', 'run'])('local stop aborts pending %s and disconnects without waiting for the network', async phase => {
    await discover(); pairingBlocked = phase === 'pairing'
    const start = integration.handle(selection)
    const suffix = phase === 'pairing' ? '/exchange' : '/run'
    await vi.waitFor(() => expect(requests.some(r => r.path.endsWith(suffix))).toBe(true))
    const request = requests.find(r => r.path.endsWith(suffix))!
    await integration.handle({ type: 'stop' })
    expect(request.init.signal!.aborted).toBe(true)
    expect(controller().stop).toHaveBeenCalled()
    expect(await start).toMatchObject({ ok: phase === 'run' })
    if (phase === 'pairing') expect(requests.some(r => r.path.endsWith('/run'))).toBe(false)
    else expect(mocks.relays[0].disconnect).toHaveBeenCalled()
  })
  it.each(['account', 'workspace', 'sign-out'])('%s identity changes revoke an active session', async change => {
    await discover(); await integration.handle(selection)
    const run = requests.find(r => r.path.endsWith('/run'))!
    if (change === 'account') auth = { ...auth!, accountKey: 'account-two', userId: uuid(9) }
    if (change === 'sign-out') auth = null
    await integration.handle(change === 'workspace' ? { type: 'workspace-changed', workspaceId: uuid(10) } : { type: 'status' })
    expect(run.init.signal!.aborted).toBe(true)
    expect(mocks.relays[0].disconnect).toHaveBeenCalled()
    expect(requests.some(r => r.init.method === 'DELETE')).toBe(true)
  })
})

it.each([true, false])('control=%s uses canonical selected helper labels in quoted local consent, never in exchange grants', async allowControl => {
  await discover()
  const canonical = 'First "document"\n<img src=x>\nAllow everything?'
  controller().listTargets.mockResolvedValue([{ ...target, displayName: canonical }, { ...target, windowId: 'second', windowInstanceId: 'second-instance', displayName: 'Second document' }])
  const discovered = await integration.handle({ type: 'targets' })
  expect(JSON.stringify(discovered)).toContain('Second document')
  // Even an in-process caller cannot mutate the private canonical cache.
  ;(discovered as { targets: Array<{ displayName?: string }> }).targets[0].displayName = 'MUTATED response label'
  controller().start.mockImplementation(async (grant: NativeGrant) => {
    expect(await controller().options.approveGrant(grant, new AbortController().signal)).toBe(true)
    controller().grant = grant; controller().state = 'active'
  })
  const result = await integration.handle({ ...selection, allowControl, target: { ...target, displayName: 'FORGED renderer label' } })
  expect(result).toMatchObject({ ok: true })
  const dialogs = JSON.stringify(vi.mocked(dialog.showMessageBox).mock.calls)
  const detail = vi.mocked(dialog.showMessageBox).mock.calls.at(-1)![0] as { detail?: string }
  expect(detail.detail).toContain(JSON.stringify(canonical))
  expect(detail.detail).toContain(target.appId)
  expect(detail.detail).toContain(target.windowId)
  expect(dialogs).not.toContain('FORGED')
  expect(dialogs).not.toContain('MUTATED')
  expect(detail.detail).not.toContain('Second document')
  const outbound = requests.filter(r => r.init.body).map(r => String(r.init.body)).join('\n')
  expect(outbound).not.toContain('displayName')
  expect(outbound).not.toContain('FORGED')
  expect(controller().start.mock.calls[0][0].targets).toEqual([target])
})

describe('status identity isolation after invalidation', () => {
  function expectRedacted(response: unknown) {
    expect(response).not.toHaveProperty('status.identity')
    expect(response).not.toHaveProperty('status.expiresAt')
    expect(JSON.stringify(response)).not.toMatch(/private-access-token|private-relay-token|Read the selected window/)
  }
  async function startA() {
    await discover()
    expect(await integration.handle(selection)).toMatchObject({ ok: true, status: { identity: { userId: uuid(5) } } })
    expect(controller().grant).toBeDefined()
    return controller()
  }
  it.each(['stop', 'disconnect', 'workspace-changed'] as const)('%s is pre-auth redacted, then two B polls never recover A', async type => {
    const current = await startA(), epoch = current.status().epoch
    auth = null // logout happens before the renderer's early cleanup call
    const early = await integration.handle(type === 'workspace-changed' ? { type, workspaceId: uuid(90) } : { type })
    expect(early).toMatchObject({ ok: true, status: { state: 'stopped', epoch: epoch + 1 } })
    expectRedacted(early)
    expect(current.grant).toBeUndefined()
    auth = { userId: uuid(91), accountKey: 'account-B', apiUrl: 'https://other-api.example', accessToken: 'B-token' }
    for (let i = 0; i < 2; i++) expectRedacted(await integration.handle({ type: 'status' }))
    expect(current.grant).toBeUndefined()
    expect(current.status().epoch).toBe(epoch + 1)
    expect(mocks.controllers.at(-1)).toBe(current) // no automatic replacement/resume
    expect(current.start).toHaveBeenCalledOnce()
  })
  it.each(['logout', 'accountKey', 'userId', 'apiUrl'] as const)('authenticated %s detection forgets scope even without an early Stop', async change => {
    const current = await startA()
    if (change === 'logout') auth = null
    else auth = { ...auth!, [change]: change === 'userId' ? uuid(92) : change === 'apiUrl' ? 'https://deployment-B.example' : 'account-B' }
    for (let i = 0; i < 2; i++) expectRedacted(await integration.handle({ type: 'status' }))
    expect(current.grant).toBeUndefined()
    expect(current.status().state).toBe('stopped')
    expect(current.start).toHaveBeenCalledOnce()
  })
  it('same-workspace notification still redacts its pre-auth response without interrupting the live grant', async () => {
    const current = await startA()
    expectRedacted(await integration.handle({ type: 'workspace-changed', workspaceId: selection.workspaceId }))
    expect(current.grant).toBeDefined()
    expect(current.stop).not.toHaveBeenCalled()
  })
  it.each(['stop', 'disconnect', 'workspace-changed'] as const)('%s does not wait for blocked auth, network revocation or helper death', async type => {
    await integration.stop()
    const authRead = deferred<typeof auth>(), death = deferred<void>(), revocation = deferred<Response>()
    let block = false
    const getAuth = vi.fn(async () => block ? authRead.promise : auth)
    integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth }); integration.install()
    const current = await startA(), oldAuth = auth
    current.stop.mockImplementationOnce(async () => { current.state = 'stopped'; await death.promise })
    const originalFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((url: string, init: RequestInit) => init.method === 'DELETE' ? revocation.promise : originalFetch(url, init))
    block = true
    const oldPoll = integration.handle({ type: 'status' })
    const calls = getAuth.mock.calls.length
    try {
      const early = await integration.handle(type === 'workspace-changed' ? { type, workspaceId: uuid(90) } : { type })
      expectRedacted(early)
      expect(early).toEqual({ ok: true, cleanupPending: true })
      expect(getAuth).toHaveBeenCalledTimes(calls)
      expect(current.grant).toBeUndefined()
      expect(current.stop).toHaveBeenCalledOnce()
      // The old authenticated poll also cannot restore scope after Stop.
      authRead.resolve(oldAuth)
      expectRedacted(await oldPoll)
    } finally { death.resolve(); revocation.resolve(new Response(null, { status: 204 })) }
  })
  it('drops late start errors after workspace/account invalidation and keeps subsequent polls redacted', async () => {
    await discover()
    const current = controller(), failure = deferred<void>()
    current.start.mockImplementationOnce(async (grant: NativeGrant) => {
      current.grant = grant; current.state = 'awaiting_local_consent'
      await failure.promise
      throw new Error('old private setup error')
    })
    const starting = integration.handle(selection)
    await vi.waitFor(() => expect(current.grant).toBeDefined())
    await integration.handle({ type: 'workspace-changed', workspaceId: uuid(90) })
    auth = { ...auth!, userId: uuid(91), accountKey: 'account-B' }
    expectRedacted(await integration.handle({ type: 'status' }))
    expectRedacted(await integration.handle({ type: 'status' }))
    const calls = current.stop.mock.calls.length
    failure.resolve()
    expectRedacted(await starting)
    expect(current.stop).toHaveBeenCalledTimes(calls) // old catch cannot stop the new generation
    expect(current.grant).toBeUndefined()
    for (let i = 0; i < 2; i++) expectRedacted(await integration.handle({ type: 'status' }))
  })
  it('reauthenticated inspector and same-account polls retain display identity only until explicit Stop', async () => {
    await discover()
    const response = await integration.handle({ ...selection, allowControl: false })
    expect(response).toMatchObject({ ok: true, inspection: { id: 'local-ax' }, status: { state: 'stopped', identity: { userId: auth!.userId, workspaceId: selection.workspaceId } } })
    expect(controller().grant).toBeUndefined()
    for (let i = 0; i < 2; i++) {
      const poll = await integration.handle({ type: 'status' })
      expect(poll).toMatchObject({ ok: true, status: (response as { status: NativeStatus }).status })
      expect(poll).not.toHaveProperty('inspection') // main retains metadata only, not AX
    }
    expectRedacted(await integration.handle({ type: 'stop' }))
    expectRedacted(await integration.handle({ type: 'status' }))
    expect(response).toHaveProperty('status.identity.userId', auth!.userId) // detached snapshot remains displayable
  })
  it.each(['logout', 'account', 'deployment', 'workspace'] as const)('completed inspector receipt is forgotten on %s, including the second poll', async change => {
    await discover()
    expect(await integration.handle({ ...selection, allowControl: false })).toHaveProperty('inspection')
    if (change === 'logout') auth = null
    if (change === 'account') auth = { ...auth!, userId: uuid(91), accountKey: 'B' }
    if (change === 'deployment') auth = { ...auth!, apiUrl: 'https://deployment-B.example' }
    if (change === 'workspace') expectRedacted(await integration.handle({ type: 'workspace-changed', workspaceId: uuid(90) }))
    for (let i = 0; i < 2; i++) expectRedacted(await integration.handle({ type: 'status' }))
    expect((integration as unknown as { completedInspection?: unknown }).completedInspection).toBeUndefined()
  })
  it('ignores replaced controllers and old indicator callbacks without destroying a new indicator or scope', async () => {
    const old = await startA()
    old.options.onStatus(old.status())
    const oldIndicator = mocks.indicators.at(-1)
    expect(oldIndicator).toBeDefined()
    await integration.handle({ type: 'stop' })
    await integration.handle({ type: 'targets' })
    const current = controller()
    expect(current).not.toBe(old)
    expect(await integration.handle(selection)).toMatchObject({ ok: true })
    current.options.onStatus(current.status())
    current.options.onActivity({ appId: 'new-app', perception: 'ax' })
    const indicator = mocks.indicators.at(-1), relay = mocks.relays.at(-1)
    const sends = indicator.webContents.send.mock.calls.length
    old.options.onStatus({ ...old.status(), state: 'stopped', epoch: 999 })
    old.options.onStatus({ ...old.status(), state: 'active', epoch: 999 })
    old.options.onActivity({ appId: 'old-app', perception: 'vision' })
    oldIndicator.webContents.on.mock.calls.find(([event]: [string]) => event === 'render-process-gone')[1]()
    oldIndicator.on.mock.calls.find(([event]: [string]) => event === 'closed')[1]()
    expect(current.grant).toBeDefined()
    expect(current.stop).not.toHaveBeenCalled()
    expect(indicator.destroy).not.toHaveBeenCalled()
    expect(relay.disconnect).not.toHaveBeenCalled()
    expect(indicator.webContents.send).toHaveBeenCalledTimes(sends)
    expect(indicator.webContents.send.mock.calls.at(-1)[1].activity).toEqual({ appId: 'new-app', perception: 'ax' })
    expect(current.status().epoch).toBeLessThan(999)
  })
})

it.each(['authorized','revoked','stop','account'] as const)('main execution revalidation uses current auth, metadata and generation: %s', async mode => {
 await discover(); await integration.handle(selection)
 const broker=controller(); const grant=broker.grant as NativeGrant
 const command:NativeCommand={protocol:grant.protocol,identity:grant.identity,grantId:grant.grantId,epoch:grant.epoch,commandId:'verify-command',deadlineAt:Date.now()+10000,action:{kind:'observe',target}}
 const response=deferred<Response>()
 fetchMock.mockImplementationOnce(async (url:string,init:RequestInit)=>{
  expect(url).toContain(`/sessions/${grant.identity.sessionId}/revalidate`)
  expect((init.headers as Record<string,string>).authorization).toBe('Bearer fresh-token')
  const body=JSON.parse(init.body as string)
  expect(Object.keys(body).sort()).toEqual(['commandId','deadlineAt','digest','epoch','grantId'])
  expect(body.digest).toMatch(/^[a-f0-9]{64}$/)
  return response.promise
 })
 auth={...auth!,accessToken:'fresh-token'}
 if(mode==='account') auth={...auth,accountKey:'foreign'}
 const check=broker.options.revalidateExecution(command,new AbortController().signal)
 if(mode==='account') {expect(await check).toBe(false);return}
 await vi.waitFor(()=>expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/revalidate'),expect.anything()))
 if(mode==='stop') await integration.stop()
 response.resolve(Response.json({authorized:mode!=='revoked'}))
 expect(await check).toBe(mode==='authorized')
})

it('auth A to B during revalidation HTTP without an invalidation event fails closed', async () => {
  await discover(); await integration.handle(selection)
  const broker = controller(); const grant = broker.grant as NativeGrant
  const command: NativeCommand = { protocol: grant.protocol, identity: grant.identity, grantId: grant.grantId, epoch: grant.epoch, commandId: 'auth-race', deadlineAt: Date.now()+10000, action: { kind: 'observe', target } }
  const response = deferred<Response>()
  fetchMock.mockImplementationOnce(() => response.promise)
  const check = broker.options.revalidateExecution(command, new AbortController().signal)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/revalidate'), expect.anything()))
  auth = { ...auth!, accountKey: 'B', userId: uuid(99) }
  response.resolve(Response.json({ authorized: true }))
  expect(await check).toBe(false)
  expect(broker.status().state).toBe('active') // No Stop/invalidation event was involved.
})
it.each(['stop', 'deadline'] as const)('hung final auth read detaches on %s; late auth cannot authorize a new scope', async mode => {
  const late = deferred<typeof auth>()
  const getAuth = vi.fn(async () => auth)
  await integration.stop()
  integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth }); integration.install()
  await discover(); await integration.handle(selection)
  const broker = controller(); const grant = broker.grant as NativeGrant
  const command: NativeCommand = { protocol: grant.protocol, identity: grant.identity, grantId: grant.grantId, epoch: grant.epoch, commandId: 'late-auth', deadlineAt: Date.now()+ (mode === 'deadline' ? 500 : 10000), action: { kind: 'observe', target } }
  getAuth.mockClear(); getAuth.mockResolvedValueOnce(auth).mockImplementationOnce(() => late.promise)
  fetchMock.mockImplementationOnce(async () => Response.json({ authorized: true }))
  const check = broker.options.revalidateExecution(command, new AbortController().signal)
  await vi.waitFor(() => expect(getAuth).toHaveBeenCalledTimes(2))
  if (mode === 'stop') await integration.stop()
  expect(await check).toBe(false) // Completes without resolving the auth provider.
  if (mode === 'stop') { await discover(); await integration.handle(selection) }
  late.resolve(auth); await Promise.resolve(); await Promise.resolve()
  expect(controller().status().state).toBe('active')
})

it.each([
  ['observe', 'replacement'], ['observe', 'mutation'],
  ['invoke', 'replacement'], ['invoke', 'mutation'],
] as const)('%s revalidation rejects same-user token %s during HTTP without invalidation', async (kind, change) => {
  await discover(); await integration.handle(selection)
  const broker = controller(); const grant = broker.grant as NativeGrant
  const command: NativeCommand = {
    protocol: grant.protocol, identity: grant.identity, grantId: grant.grantId, epoch: grant.epoch,
    commandId: 'token-race', deadlineAt: Date.now() + 10000,
    action: kind === 'observe' ? { kind, target } : { kind, target, observationId: 'observation', ref: 'save' },
  }
  const originalAuth = auth!
  const requestToken = originalAuth.accessToken
  const response = deferred<Response>()
  fetchMock.mockImplementationOnce(() => response.promise)
  const check = broker.options.revalidateExecution(command, new AbortController().signal)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/revalidate'), expect.anything()))
  const sent = fetchMock.mock.calls.at(-1)![1] as RequestInit
  expect((sent.headers as Record<string, string>).authorization === `Bearer ${requestToken}`).toBe(true)
  const requestCount = fetchMock.mock.calls.length
  if (change === 'replacement') auth = { ...originalAuth, accessToken: 'replacement-session-token' }
  else originalAuth.accessToken = 'replacement-session-token'
  response.resolve(Response.json({ authorized: true }))
  expect(await check).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(requestCount) // No retry on rotation.
  expect(broker.status().state).toBe('active') // No invalidation event was involved.
})

it('broker observer wiring is trusted-constructor-only, default-off and rejected by IPC', async () => {
  expect(controller().options.observerFactory).toBeUndefined()
  await integration.stop()
  const observerFactory = vi.fn(() => vi.fn())
  integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth: async () => auth, observerFactory })
  integration.install()
  expect(controller().options.observerFactory).toBe(observerFactory)
  expect(await integration.handle({ type: 'status', observerFactory })).toMatchObject({ ok: false })
  expect(await integration.handle({ ...selection, trace: true })).toMatchObject({ ok: false })
  expect(observerFactory).not.toHaveBeenCalled()
})

it('helper timing is default-off, constructor-captured and not IPC/environment selectable', async () => {
  controller().options.helperFactory(() => {})
  expect(mocks.helperArgs.at(-1)[3]).toBeUndefined()
  await integration.stop()
  const helperTimingObserver = vi.fn()
  const options = { directory: mocks.directory, getAuth: async () => auth, helperTimingObserver }
  integration = new NativeComputerIntegration(options)
  options.helperTimingObserver = vi.fn() // must not redirect existing or future helpers
  integration.install()
  controller().options.helperFactory(() => {})
  const timing = mocks.helperArgs.at(-1)[3]
  expect(timing).toEqual({ enabled: true, onMetadata: helperTimingObserver }); expect(Object.isFrozen(timing)).toBe(true)
  for (const type of ['status', 'targets', 'start', 'stop']) expect(await integration.handle({ ...(type === 'start' ? selection : {}), type, helperTimingObserver: true })).toMatchObject({ ok: false })
  expect(helperTimingObserver).not.toHaveBeenCalled(); expect(options.helperTimingObserver).not.toHaveBeenCalled()
  await integration.stop()
  vi.stubEnv('NATIVE_COMPUTER_HELPER_TIMING', 'true')
  integration = new NativeComputerIntegration({ directory: mocks.directory, getAuth: async () => auth }); integration.install()
  controller().options.helperFactory(() => {})
  expect(mocks.helperArgs.at(-1)[3]).toBeUndefined()
})


describe('cleanup polling fence', () => {
  it('tracks outstanding teardown across repeated Stop and account/workspace changes, blocks commands, and clears only on completion', async () => {
    await discover()
    await integration.handle(selection)
    const current = controller(), death = deferred<void>()
    current.stop.mockImplementation(async () => { current.state = 'stopped'; await death.promise })
    vi.mocked(dialog.showMessageBox).mockClear()
    const controllers = mocks.controllers.length
    try {
      expect(await integration.handle({ type: 'stop' })).toEqual({ ok: true, cleanupPending: true })
      expect(await integration.handle({ type: 'stop' })).toEqual({ ok: true, cleanupPending: true })
      auth = { ...auth!, accountKey: 'replacement', userId: uuid(99) }
      expect(await integration.handle({ type: 'workspace-changed', workspaceId: uuid(98) })).toEqual({ ok: true, cleanupPending: true })
      expect(await integration.handle({ type: 'status' })).toEqual({ ok: true, cleanupPending: true })
      for (const command of [{ type: 'targets' }, selection, { ...selection, type: 'resume' }, { type: 'permissions' }, { type: 'check-readiness' }]) {
        expect(await integration.handle(command)).toEqual({ ok: false, cleanupPending: true })
      }
      expect(mocks.controllers).toHaveLength(controllers)
      expect(dialog.showMessageBox).not.toHaveBeenCalled()
      expect(shell.openExternal).not.toHaveBeenCalled()
    } finally { death.resolve(); await integration.stop() }
    await integration.handle({ type: 'status' }) // detect replacement auth without recovering old scope
    const result = await integration.handle({ type: 'status' })
    expect(result).toMatchObject({ cleanupPending: false })
    expect(result).not.toHaveProperty('status.identity')
    expect(await integration.handle({ type: 'targets' })).toMatchObject({ ok: true, cleanupPending: false })
  })
  it('does not clear a rejected teardown with a later successful Stop', async () => {
    await discover()
    controller().identityChanged.mockRejectedValueOnce(new Error('private guardian uncertainty'))
    expect(await integration.handle({ type: 'stop' })).toEqual({ ok: true, cleanupPending: true })
    expect(await integration.handle({ type: 'stop' })).toEqual({ ok: true, cleanupPending: true })
    expect(await integration.handle({ type: 'status' })).toEqual({ ok: true, cleanupPending: true })
    expect(await integration.handle({ type: 'targets' })).toEqual({ ok: false, cleanupPending: true })
  })
})
