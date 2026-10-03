import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HelperTimingEvent } from '@use-brian/computer-control/helper-timing.js'
import type { NativeComputerController } from '../computer-control/controller.js'
import type { NativeCommand, NativeGrant } from '@use-brian/computer-control/protocol.js'
const mocks = vi.hoisted(() => ({ directory: '', packaged: false, spawn: vi.fn(), acquire: vi.fn(async () => {}), release: vi.fn(async () => {}), relay: vi.fn(), ready: vi.fn(async () => {}), consent: vi.fn(async () => ({ response: 1 })) }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), statSync: () => ({ isFile: () => true }), accessSync: () => {} }))
vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.packaged }, getPath: () => mocks.directory, on: vi.fn() }, globalShortcut: { register: () => true }, powerMonitor: { on: vi.fn() }, ipcMain: { on: vi.fn() },
  dialog: { showMessageBox: mocks.consent }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0 } }) }, shell: {}, systemPreferences: {},
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), send: vi.fn() }
    on = vi.fn(); loadFile = async () => {}; showInactive = vi.fn(); destroy = vi.fn(); isDestroyed = () => false
  },
}))
// Keep the real controller and PrivatePipeHelper: only network/OS process/lease are fixtures.
vi.mock('../computer-control/index.js', async original => ({ ...await original<typeof import('../computer-control/index.js')>(),
  LocalDeviceLease: class { acquire = mocks.acquire; release = mocks.release },
  NativeRelayClient: class { constructor(controller: NativeComputerController) { mocks.relay(controller) }; connect = vi.fn(); disconnect = vi.fn(); waitUntilReady = mocks.ready },
}))
import { NativeComputerIntegration, type NativeIntegrationOptions } from '../native-computer-integration.js'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const target = { appId: 'private-app', processId: 42, processInstanceId: 'private-process', windowId: 'private-window', windowInstanceId: 'private-instance' }
const selection = { type: 'start', workspaceId: uuid(1), assistantId: uuid(2), conversationId: uuid(3), taskId: uuid(4), goal: 'private-goal', target, allowControl: false, allowCapture: false }
type Request = { id: string; method: string; diagnostics?: boolean; payload: { command?: NativeCommand; grant?: NativeGrant } }
let integration: NativeComputerIntegration
let platform: PropertyDescriptor
let auth: { userId: string; accessToken: string; apiUrl: string; accountKey: string }
let requests: Request[]
let holdExecute: boolean
let holdCapabilities: boolean
let lazyCapabilities: boolean
let authorized: boolean
let resourcesPath: PropertyDescriptor | undefined
let held: { request: Request; respond: () => void } | undefined
let sessionNumber: number
const paths: string[] = []
function fakeChild() {
  let clock = 0
  let discovered = false
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk: Buffer, _encoding, callback) {
      const request = JSON.parse(chunk.subarray(4).toString()) as Request; requests.push(request); callback()
      const respond = () => {
        const c = request.payload.command
        if (request.method === 'listTargets') discovered = true
        const usable = !lazyCapabilities || discovered
        const result = request.method === 'capabilities' ? { protocol: 'native-computer-v1', platform: process.platform, axRead: usable, semanticActions: usable, windowCapture: false, input: false, accessibilityPermission: usable ? 'granted' : 'unknown', capturePermission: 'denied', limitations: [] }
          : request.method === 'listTargets' ? [target] : ['start', 'beginApproval', 'endApproval'].includes(request.method) ? true
          : c!.action.kind !== 'observe' ? { commandId: c!.commandId, outcome: 'executed', code: 'ok' }
          : { commandId: c!.commandId, outcome: 'executed', code: 'ok', observation: {
            identity: c!.identity, epoch: c!.epoch, id: 'private-snapshot', capturedAt: Date.now(), monotonicMs: 1, target, foreground: true,
            bounds: { x: 0, y: 0, width: 100, height: 100 }, displayLayoutVersion: 'private-layout', completeness: 'complete',
            nodes: [{ ref: 'private-ref', role: 'textbox', name: 'private-AX-text', value: 'private-value', bounds: { x: 0, y: 0, width: 100, height: 100 }, enabled: true, focused: false, selected: false, sensitive: false, actions: ['setValue'] }],
          } }
        clock += 100
        const diagnostics = { version: 1, instanceId: uuid(50), clockId: uuid(51), requestId: request.id, method: request.method,
          spans: [{ phase: request.method === 'execute' ? 'observe_request' : 'request', startUs: clock, endUs: clock + 10, durationUs: 10, status: 'returned' }] }
        // Synthetic protocol peer, not platform execution/AX acceptance. Support
        // is negotiated in the private envelope; the initial probe is untimed.
        const body = Buffer.from(JSON.stringify({ id: request.id, ok: true, result,
          ...(request.method === 'capabilities' ? { diagnosticsVersion: 1 } : {}),
          ...(request.diagnostics ? { diagnostics } : {}) }))
        const header = Buffer.alloc(4); header.writeUInt32BE(body.length); child.stdout.write(Buffer.concat([header, body]))
      }
      if ((holdExecute && request.method === 'execute') || (holdCapabilities && request.method === 'capabilities')) held = { request, respond }
      else setImmediate(respond)
    } }),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('exit', null, 'SIGKILL')); return true }),
  })
  return child
}
beforeEach(() => {
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  mocks.packaged = false; holdCapabilities = false; lazyCapabilities = false; authorized = true
  mocks.ready.mockReset().mockResolvedValue(undefined); mocks.consent.mockReset().mockResolvedValue({ response: 1 })
  mocks.acquire.mockClear(); mocks.release.mockClear(); mocks.relay.mockClear()
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  vi.stubEnv('NATIVE_COMPUTER_ENABLED', 'true')
  mocks.directory = mkdtempSync(join(tmpdir(), 'native-helper-timing-'))
  mocks.spawn.mockReset().mockImplementation(fakeChild); requests = []; paths.length = 0; holdExecute = false; held = undefined; sessionNumber = 10
  auth = { userId: uuid(5), accessToken: 'private-token', apiUrl: 'https://api.example', accountKey: 'private-account' }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    paths.push(new URL(url).pathname)
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (url.endsWith('/revalidate')) return Response.json({ authorized })
    if (url.endsWith('/run')) return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new Error('aborted'))
      init.signal!.addEventListener('abort', abort, { once: true }); if (init.signal!.aborted) abort()
    })
    if (url.endsWith('/exchange')) return Response.json({ token: 'private-relay-token', relayUrl: 'wss://relay.example', expiresAt: Date.now() + 60000 })
    const body = JSON.parse(init.body as string)
    return Response.json({ identity: { deploymentId: 'private-deployment', userId: auth.userId, workspaceId: body.workspaceId, deviceId: body.deviceId, sessionId: uuid(++sessionNumber), conversationId: body.conversationId, taskId: body.taskId } })
  }))
})
afterEach(async () => {
  await integration?.stop(); await tick()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platform)
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath)
  else Reflect.deleteProperty(process, 'resourcesPath')
  rmSync(mocks.directory, { recursive: true, force: true })
})
function install(observer?: NativeIntegrationOptions['helperTimingObserver']) {
  const options: NativeIntegrationOptions = { directory: mocks.directory, getAuth: async () => auth, ...(observer ? { helperTimingObserver: observer } : {}) }
  integration = new NativeComputerIntegration(options); integration.install(); return options
}
async function discover() {
  await integration.handle({ type: 'workspace-changed', workspaceId: selection.workspaceId })
  await tick() // Discovery must wait for confirmed scope teardown.
  expect(await integration.handle({ type: 'targets' })).toMatchObject({ ok: true })
}
describe('trusted main helper timing port with real pipe adapter', () => {
  function packagedMac(accepted: boolean) {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    Object.defineProperty(process, 'resourcesPath', { value: '/fixture/Use Brian.app/Contents/Resources', configurable: true })
    mocks.packaged = true; lazyCapabilities = true
    // Test fixtures only: not evidence of operational or signed-platform acceptance.
    vi.stubEnv('NATIVE_COMPUTER_PILOT_ACCEPTED', String(accepted))
    vi.stubEnv('NATIVE_COMPUTER_INSPECTOR_ENABLED', 'true')
    install()
  }

  it.each([false, true])('refreshes lazy Mac capabilities after discovery with accepted control=%s', async accepted => {
    packagedMac(accepted)
    expect(await integration.handle({ type: 'status' })).toMatchObject({ status: { capabilities: { axRead: false, semanticActions: false, windowCapture: false, input: false } } })
    expect(mocks.spawn).not.toHaveBeenCalled()
    await integration.handle({ type: 'workspace-changed', workspaceId: selection.workspaceId })
  await tick() // Discovery must wait for confirmed scope teardown.
    expect(await integration.handle({ type: 'targets' })).toMatchObject({ ok: true, status: { state: 'ready', capabilities: { axRead: true, semanticActions: accepted, windowCapture: false, input: false } } })
    expect(requests.map(r => r.method)).toEqual(['capabilities', 'listTargets', 'capabilities'])
    expect(mocks.spawn).toHaveBeenCalledOnce()
    if (!accepted) {
      for (const [allowControl, allowCapture] of [[true, false], [false, true], [true, true]]) {
        expect(await integration.handle({ ...selection, allowControl, allowCapture })).toMatchObject({ ok: false })
      }
      expect(fetch).not.toHaveBeenCalled()
      expect(requests.some(r => r.method === 'start')).toBe(false)
      expect(await integration.handle(selection)).toMatchObject({ ok: true, inspection: { id: 'private-snapshot' }, status: { capabilities: { axRead: true, semanticActions: false, windowCapture: false, input: false } } })
      expect(mocks.consent).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('will not activate, raise or edit') }))
      expect(paths.some(p => p.endsWith('/run'))).toBe(false)
    }
  })

  it('accepted Mac control waits for relay READY and retains exact action consent and API revalidation', async () => {
    packagedMac(true); await discover()
    let ready!: () => void
    mocks.ready.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve }))
    const start = integration.handle({ ...selection, allowControl: true })
    await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce())
    expect(paths.some(p => p.endsWith('/exchange'))).toBe(true)
    expect(paths.some(p => p.endsWith('/run'))).toBe(false)
    ready()
    expect(await start).toMatchObject({ ok: true, status: { state: 'active', capabilities: { semanticActions: true, windowCapture: false, input: false } } })
    expect(paths.some(p => p.endsWith('/run'))).toBe(true)
    const controller = mocks.relay.mock.calls[0][0] as NativeComputerController
    const grant = requests.find(r => r.method === 'start')!.payload.grant!
    const base = { protocol: grant.protocol, identity: grant.identity, epoch: grant.epoch, grantId: grant.grantId, deadlineAt: Date.now() + 30000 }
    expect(await controller.execute({ ...base, commandId: 'observe', action: { kind: 'observe', target } })).toMatchObject({ code: 'ok' })
    const action = { kind: 'setValue' as const, target, observationId: 'private-snapshot', ref: 'private-ref', text: 'exact replacement' }
    const execute = (commandId: string) => controller.execute({ ...base, commandId, action })
    const validations = () => paths.filter(p => p.endsWith('/revalidate')).length
    mocks.consent.mockResolvedValueOnce({ response: 0 })
    const beforeDenial = validations()
    expect(await execute('denied')).toMatchObject({ code: 'approval_required' })
    expect(validations()).toBe(beforeDenial)
    expect(requests.some(r => r.method === 'execute' && r.payload.command?.commandId === 'denied')).toBe(false)
    expect(await execute('approved')).toMatchObject({ code: 'ok', outcome: 'executed' })
    // Authority is checked after consent and again immediately before dispatch.
    expect(validations()).toBe(beforeDenial + 2)
    expect(mocks.consent).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Approve this exact desktop action?', detail: expect.stringContaining(JSON.stringify(action)) }))
    expect(requests.filter(r => r.payload.command?.commandId === 'approved').map(r => r.method)).toEqual(['beginApproval', 'endApproval', 'execute'])
    // Effects invalidate the approval snapshot; obtain fresh context before another action.
    expect(await controller.execute({ ...base, commandId: 'observe-again', action: { kind: 'observe', target } })).toMatchObject({ code: 'ok' })
    const beforeRevocation = validations()
    authorized = false
    expect(await execute('revoked')).not.toMatchObject({ outcome: 'executed' })
    expect(validations()).toBe(beforeRevocation + 1)
    expect(requests.some(r => r.method === 'execute' && r.payload.command?.commandId === 'revoked')).toBe(false)
  })
  // Packaged-darwin flags and executable are fixtures; these Linux-hosted tests
  // exercise the real private transport, not signature/native admission or AX.
  it.each(['success', 'stop-hung-metadata', 'stop-after-metadata'] as const)(
    'rollout-disabled packaged readiness: %s respects the exit/lease barrier', async mode => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      Object.defineProperty(process, 'resourcesPath', { value: '/fixture/Use Brian.app/Contents/Resources', configurable: true })
      mocks.packaged = true
      vi.stubEnv('NATIVE_COMPUTER_ENABLED', 'false')
      vi.stubEnv('NATIVE_COMPUTER_PILOT_ACCEPTED', 'false')
      holdCapabilities = mode === 'stop-hung-metadata'
      const options = install()
      const getAuth = vi.fn(async () => { throw new Error('Readiness must not read auth') })
      options.getAuth = getAuth
      const child = fakeChild()
      child.kill.mockImplementation(() => true) // Signal/stream closure is not death.
      mocks.spawn.mockReturnValueOnce(child)
      let settled = false
      const readiness = integration.handle({ type: 'check-readiness' }).then(result => { settled = true; return result })
      try {
        await vi.waitFor(() => expect(requests).toHaveLength(1))
        expect(requests[0]).toMatchObject({ method: 'capabilities', payload: {} })
        expect(requests[0]).not.toHaveProperty('diagnostics')
        expect(mocks.acquire).toHaveBeenCalledTimes(1)
        expect(mocks.spawn).toHaveBeenCalledWith(
          '/fixture/Use Brian.app/Contents/Resources/computer-control/brian-native-computer-helper', [],
          expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false }),
        )
        if (mode === 'stop-hung-metadata') {
          expect(held).toBeDefined()
          expect(child.kill).not.toHaveBeenCalled()
        } else await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'))
        if (mode !== 'success') {
          expect(await integration.handle({ type: 'stop' })).toMatchObject({ ok: true })
          // Stop signals immediately, without waiting for metadata or helper exit.
          expect(child.kill).toHaveBeenCalledWith('SIGKILL')
          held?.respond() // Late successful metadata must not restore readiness.
        }
        await tick()
        expect(settled).toBe(false)
        expect(mocks.release).not.toHaveBeenCalled()
        expect(await integration.handle({ type: 'check-readiness' })).toMatchObject({ ok: false })
        expect(mocks.spawn).toHaveBeenCalledTimes(1)
      } finally {
        child.emit('exit', null, 'SIGKILL') // Always unblock cleanup, even on assertion failure.
      }
      const result = await readiness
      expect(result).toEqual(mode === 'success' ? {
        ok: true, cleanupPending: false, readiness: { helperAdmitted: true, capabilities: {
          protocol: 'native-computer-v1', platform: 'darwin', axRead: true, semanticActions: true,
          windowCapture: false, input: false, accessibilityPermission: 'granted', capturePermission: 'denied', limitations: [],
        } },
      } : { ok: false, cleanupPending: false })
      expect(mocks.release).toHaveBeenCalledTimes(1)
      expect(requests.map(request => request.method)).toEqual(['capabilities'])
      expect(getAuth).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expect(mocks.relay).not.toHaveBeenCalled()
    },
  )

  it.each(['stop', 'timeout'] as const)('hung final inspector auth detaches on %s after real controller/helper cleanup', async mode => {
    const options = install(); await discover()
    const child = mocks.spawn.mock.results[0].value as ReturnType<typeof fakeChild>
    child.kill.mockImplementation(() => true) // Requesting death is not proof of exit.
    let resolveAuth!: (value: typeof auth) => void
    const lateAuth = new Promise<typeof auth>(resolve => { resolveAuth = resolve })
    const getAuth = vi.fn(async () => auth)
    getAuth.mockResolvedValueOnce(auth).mockImplementationOnce(() => lateAuth)
    options.getAuth = getAuth
    const start = integration.handle(selection)
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalled())
    expect(getAuth).toHaveBeenCalledTimes(1)
    expect(await integration.handle({ type: 'targets' })).toMatchObject({ ok: false, cleanupPending: true })
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    child.emit('exit', null, 'SIGKILL')
    await vi.waitFor(() => expect(getAuth).toHaveBeenCalledTimes(2))
    if (mode === 'stop') await integration.handle({ type: 'stop' })
    expect(await start).toMatchObject({ ok: false })
    expect(await integration.handle({ type: 'targets' })).toMatchObject({ ok: true })
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    resolveAuth(auth); await tick()
    const poll = await integration.handle({ type: 'status' })
    expect(poll).toMatchObject({ ok: true, status: { state: 'ready' } })
    expect(poll).not.toHaveProperty('status.identity')
    expect(poll).not.toHaveProperty('inspection')
    expect(await integration.handle(selection)).toMatchObject({ ok: true, inspection: { id: 'private-snapshot' } })
  }, 10000)
  it('default-off never adds diagnostics, even with renderer/environment hints', async () => {
    vi.stubEnv('NATIVE_COMPUTER_HELPER_TIMING', 'true'); install()
    expect(await integration.handle({ type: 'targets', diagnostics: true })).toMatchObject({ ok: false })
    expect(await integration.handle({ ...selection, helperTimingObserver: true })).toMatchObject({ ok: false })
    await discover(); expect(await integration.handle(selection)).toMatchObject({ ok: true })
    expect(requests.every(r => !('diagnostics' in r))).toBe(true)
  })
  it.each(['linux', 'darwin', 'win32'] as const)('%s synthetic negotiated peer preserves inspector privacy', async os => {
    Object.defineProperty(process, 'platform', { value: os })
    const events: HelperTimingEvent[] = []; install(e => { events.push(e) }); await discover()
    const result = await integration.handle(selection); await tick(); await tick()
    expect(result).toMatchObject({ ok: true, status: { state: 'stopped' }, inspection: { nodes: [{ name: 'private-AX-text' }] } })
    expect(requests[0].method).toBe('capabilities')
    expect(requests[0]).not.toHaveProperty('diagnostics')
    expect(requests.some(r => r.method === 'execute' && r.diagnostics === true)).toBe(true)
    expect(events.some(e => e.state === 'complete' && e.method === 'execute')).toBe(true)
    expect(events.every(e => e.state === 'complete' || e.reason === 'absent')).toBe(true)
    expect(JSON.stringify(events)).not.toContain('private-')
    expect(JSON.stringify(result)).not.toMatch(/spans|diagnostics|requestId|durationUs/)
    expect(paths.some(p => p.endsWith('/run'))).toBe(false)
  })
  it('late observer arrival retains original request correlation after account/session replacement, without redirection', async () => {
    const events: HelperTimingEvent[] = []; const options = install(e => { events.push(e) }); await discover()
    holdExecute = true; const first = integration.handle(selection)
    await vi.waitFor(() => expect(held).toBeDefined()); await tick(); await tick()
    let deliver!: () => void
    const immediate = vi.spyOn(globalThis, 'setImmediate').mockImplementationOnce(((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      deliver = () => callback(...args); return {} as NodeJS.Immediate
    }) as typeof setImmediate)
    const original = held!.request.payload.command!; held!.respond(); immediate.mockRestore()
    expect(await first).toMatchObject({ ok: true }); expect(deliver).toBeTypeOf('function')
    const redirected = vi.fn(); options.helperTimingObserver = redirected
    auth = { ...auth, userId: uuid(90), accountKey: 'private-new-account' }
    expect(await integration.handle({ type: 'status' })).toMatchObject({ ok: false })
    holdExecute = false; await discover(); expect(await integration.handle(selection)).toMatchObject({ ok: true })
    deliver(); await tick(); await tick()
    const old = events.find(e => e.correlation?.commandId === original.commandId)!
    expect(old.correlation).toEqual({ sessionId: original.identity.sessionId, epoch: original.epoch, commandId: original.commandId })
    expect(Object.isFrozen(old)).toBe(true); expect(Object.isFrozen(old.correlation)).toBe(true)
    expect(redirected).not.toHaveBeenCalled()
    expect((await integration.handle({ type: 'status' })) as object).not.toHaveProperty('inspection')
  })
  it.each(['throw', 'reject', 'hang'] as const)('%s in observer never waits, changes inspection authority, or prevents Stop', async failure => {
    install(() => { if (failure === 'throw') throw new Error('private-error'); return failure === 'reject' ? Promise.reject(new Error('private-error')) : new Promise<void>(() => {}) })
    await discover(); expect(await integration.handle(selection)).toMatchObject({ ok: true, status: { state: 'stopped' } })
    expect(await integration.handle({ type: 'stop' })).toMatchObject({ ok: true })
    expect(requests.filter(r => r.method === 'execute')).toHaveLength(1)
    expect(paths.some(p => p.endsWith('/run'))).toBe(false)
  })
})
