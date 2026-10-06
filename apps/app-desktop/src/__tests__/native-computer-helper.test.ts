import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough, Writable } from 'node:stream'
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
import type { NativeClickScope } from '../computer-control/click-guardian-client.js'
import { PrivatePipeHelper } from '../computer-control/helper-client.js'
import { NativeComputerController } from '../computer-control/controller.js'
import { NATIVE_PROTOCOL, type NativeGrant } from '../computer-control/contracts.js'
const platform = process.platform
function descriptorFor(command?: Parameters<PrivatePipeHelper['execute']>[0]): NativeClickScope {
  const target = { appId: 'com.usebrian.NativeComputerFixture', processId: 12, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
  const fallback: Parameters<PrivatePipeHelper['execute']>[0] = { protocol: NATIVE_PROTOCOL, commandId: 'command', grantId: 'g',
    identity: { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'device', sessionId: 's', conversationId: 'c', taskId: 't' },
    epoch: 1, deadlineAt: Date.now() + 10000, action: { kind: 'click', target, observationId: 'o', frameId: 'f', x: 1, y: 2 } }
  const generation = { pid: 12, birth: '10', executable: '/package/fixture' }
  return { version: 1, command: structuredClone(command ?? fallback), worker: { ...generation, pid: 4242, executable: '/packaged/helper' },
    process: generation, windowNumber: 32, bounds: { x: 0, y: 0, width: 100, height: 100 }, width: 100, height: 100,
    pngDigest: 'a'.repeat(64), fingerprint: 'b'.repeat(64), displayLayout: 'c'.repeat(64), frameTime: 10, observationTime: 9,
    grantDeadline: 1000, commandDeadline: 500, privacy: 'publicCompleteSafeCanvas' }
}
function fakeChild() {
  let request: { id: string; method: string; payload?: { command?: Parameters<PrivatePipeHelper['execute']>[0] } }
  const sideReplies: unknown[] = []
  const side = new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) {
    sideReplies.push(JSON.parse(chunk.subarray(4).toString())); callback()
  } })
  const child = Object.assign(new EventEmitter(), {
    pid: 4242 as number | undefined, stdio: [null, null, null, side],
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk: Buffer, _encoding, callback) { request = JSON.parse(chunk.subarray(4).toString()); callback() } }),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('exit', null, 'SIGKILL')); return true }),
  })
  mocked.spawn.mockReturnValue(child)
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  function respond(result: unknown, wrongId = false, extra: Record<string, unknown> = {}) {
    const body = Buffer.from(JSON.stringify({ id: wrongId ? 'foreign' : request.id, ok: true, result, ...extra }))
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
    child.stdout.write(header.subarray(0, 2)); child.stdout.write(Buffer.concat([header.subarray(2), body]))
  }
  function handoff(id = request.id, descriptor = descriptorFor(request.payload?.command)) {
    const body = Buffer.from(JSON.stringify({ kind: 'handoff', requestId: id, descriptor }))
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
    side.emit('data', Buffer.concat([header, body]))
  }
  return { child, side, sideReplies, handoff, respond, lastRequest: () => request }
}
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); vi.useRealTimers(); vi.clearAllMocks() })
describe('[COMP:desktop/native-readiness] native private pipe', () => {
  function startGrant(remainingMs = 120_000): NativeGrant {
    return { protocol: NATIVE_PROTOCOL,
      identity: { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'device', sessionId: 's', conversationId: 'c', taskId: 't' },
      grantId: 'g', epoch: 1, expiresAt: Date.now() + remainingMs,
      targets: [{ appId: 'com.apple.TextEdit', processId: 12, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }],
      allowControl: true, allowCapture: false, requester: 'Brian', goal: 'test' }
  }
  function timedCommand(deadlineMs = 29_000) {
    const command = descriptorFor().command
    return { ...command, deadlineAt: Date.now() + deadlineMs, action: { kind: 'observe' as const, target: command.action.target } }
  }
  it.each(['execute', 'beginApproval', 'endApproval'] as const)('lets Mac %s complete after four seconds within the original command deadline', async method => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const command = timedCommand()
    const pending = method === 'execute' ? helper.execute(command, 'lease') : method === 'beginApproval' ? helper.beginApproval(command, 'lease') : helper.endApproval(command, 'lease', true)
    await vi.advanceTimersByTimeAsync(8000); expect(peer.child.kill).not.toHaveBeenCalled()
    peer.respond(method === 'execute' ? { commandId: command.commandId, outcome: 'executed', code: 'ok' } : true)
    await pending
    const ordinary = expect(helper.capabilities()).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(4000); await ordinary; await helper.kill()
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it.each([[undefined, 60_000, 30_000], [120_000, 60_000, 30_000], [undefined, 5000, 5000], [1000, 29_000, 1000]])('caps command transport with override %s and deadline %s at %s', async (override, deadline, expected) => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {}, override)
    const command = timedCommand(deadline)
    const pending = expect(helper.execute(command, 'lease')).rejects.toThrow('unavailable')
    command.deadlineAt += 120_000 // Caller mutation cannot extend serialized work.
    await vi.advanceTimersByTimeAsync(expected - 1); expect(peer.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await pending; await helper.kill()
    expect(helper.lifecycleDiagnostics()).toMatchObject({ method: 'execute', requestTimedOut: true, cause: 'timeout' })
    await expect(helper.execute(command, 'lease')).rejects.toThrow()
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('clips command transport to the retained grant expiry, detached from the caller', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const grant = startGrant(5000); const starting = helper.start(grant, 'lease'); peer.respond(true); await starting
    grant.expiresAt += 120_000
    const pending = expect(helper.execute(timedCommand(), 'lease')).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(4999); expect(peer.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await pending; await helper.kill()
  })
  it('Stop interrupts a Mac command beyond four seconds immediately without replay', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const pending = expect(helper.execute(timedCommand(), 'lease')).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(5000); expect(peer.child.kill).not.toHaveBeenCalled()
    const stopped = helper.kill(); expect(peer.child.kill).toHaveBeenCalledOnce(); await pending; await stopped
    expect(helper.lifecycleDiagnostics()).toMatchObject({ requestTimedOut: false, cause: 'stop' })
  })
  it('keeps Linux command transport at four seconds despite a longer command deadline', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); Object.defineProperty(process, 'platform', { value: 'linux' })
    const helper = new PrivatePipeHelper({ platform: 'linux', executable: '/usr/bin/python3', args: ['-Es', '/package/helper.py'] }, () => {})
    const pending = expect(helper.execute(timedCommand(), 'lease')).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(3999); expect(peer.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await pending; await helper.kill()
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('keeps retired raw click transport at four seconds', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const pending = expect(helper.execute(descriptorFor().command, 'lease')).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(4000); await pending; await helper.kill()
  })
  it('lets consented Mac Start finish beyond four seconds without extending later RPCs', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const starting = helper.start(startGrant(), 'lease')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(peer.child.kill).not.toHaveBeenCalled()
    peer.respond(true); await starting
    const next = expect(helper.capabilities()).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(4000); await next; await helper.kill()
    expect(peer.child.kill).toHaveBeenCalledOnce()
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it.each([undefined, 120_000])('bounds Mac Start at sixty seconds with override %s, kills the helper and never retries', async override => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {}, override)
    const starting = expect(helper.start(startGrant(), 'lease')).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(59_999); expect(peer.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await starting; await helper.kill()
    expect(helper.lifecycleDiagnostics()).toMatchObject({ method: 'start', requestTimedOut: true, cause: 'timeout', exitSignal: 'SIGKILL' })
    expect(peer.child.kill).toHaveBeenCalledOnce()
    await expect(helper.start(startGrant(), 'lease')).rejects.toThrow('unavailable')
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('caps Mac Start at the remaining grant lifetime', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const grant = startGrant(5000)
    const starting = expect(helper.start(grant, 'lease')).rejects.toThrow('unavailable')
    grant.expiresAt += 120_000
    await vi.advanceTimersByTimeAsync(4999); expect(peer.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await starting; await helper.kill()
    expect(helper.readinessDiagnostics().requestTimedOut).toBe(true)
    expect(peer.child.kill).toHaveBeenCalledOnce()
  })
  it('keeps explicit shorter Mac Start timeout overrides', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {}, 1000)
    const starting = expect(helper.start(startGrant(), 'lease')).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(999); expect(peer.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await starting; await helper.kill()
    expect(peer.child.kill).toHaveBeenCalledOnce()
  })
  it('Stop interrupts extended Mac Start immediately', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const starting = expect(helper.start(startGrant(), 'lease')).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(5000); await helper.kill(); await starting
    expect(peer.child.kill).toHaveBeenCalledOnce()
    expect(helper.readinessDiagnostics().requestTimedOut).toBe(false)
  })
  it.each(['win32', 'linux'] as const)('%s Start retains the four-second deadline', async platform => {
    vi.useFakeTimers()
    const peer = fakeChild(); Object.defineProperty(process, 'platform', { value: platform })
    const spec = platform === 'win32' ? { platform, executable: 'C:\\packaged\\helper.exe', args: [] }
      : { platform, executable: '/usr/bin/python3', args: ['-Es', '/packaged/helper.py'] }
    const helper = new PrivatePipeHelper(spec, () => {})
    const starting = expect(helper.start(startGrant(), 'lease')).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(4000); await starting; await helper.kill()
    expect(peer.child.kill).toHaveBeenCalledOnce()
  })
  it('lets the first Mac handshake finish beyond four seconds, then restores the normal deadline', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const startup = helper.capabilities()
    await vi.advanceTimersByTimeAsync(6000)
    expect(peer.child.kill).not.toHaveBeenCalled()
    peer.respond({ protocol: NATIVE_PROTOCOL, platform: 'darwin', axRead: false, semanticActions: false, windowCapture: false, input: false,
      accessibilityPermission: 'unknown', capturePermission: 'unknown', limitations: [] })
    await startup
    const next = expect(helper.capabilities()).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(4000); await next
    expect(peer.child.kill).toHaveBeenCalledOnce(); await helper.kill()
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('bounds the startup handshake at fifteen seconds without retrying', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const startup = expect(helper.capabilities()).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(14999)
    expect(peer.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await startup; await helper.kill()
    expect(helper.readinessDiagnostics().requestTimedOut).toBe(true)
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('allows Mac discovery beyond the action deadline after bootstrap, without extending later RPCs', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const startup = helper.capabilities()
    peer.respond({ protocol: NATIVE_PROTOCOL, platform: 'darwin', axRead: false, semanticActions: false, windowCapture: false, input: false,
      accessibilityPermission: 'unknown', capturePermission: 'unknown', limitations: [] })
    await startup
    const discovery = helper.listTargets()
    await vi.advanceTimersByTimeAsync(6000)
    expect(peer.child.kill).not.toHaveBeenCalled()
    peer.respond([]); expect(await discovery).toEqual([])
    const next = expect(helper.capabilities()).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(4000); await next; await helper.kill()
    expect(peer.child.kill).toHaveBeenCalledOnce()
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('bounds Mac discovery and exposes only fixed lifecycle metadata', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const discovery = expect(helper.listTargets()).rejects.toThrow('unavailable')
    peer.child.stderr.write('PRIVATE_WINDOW_TITLE')
    await vi.advanceTimersByTimeAsync(14999); expect(peer.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await discovery; await helper.kill()
    expect(helper.lifecycleDiagnostics()).toMatchObject({ method: 'listTargets', requestTimedOut: true, exitSignal: 'SIGKILL', exitObserved: true })
    expect(Object.keys(helper.lifecycleDiagnostics()).sort()).toEqual(['cause', 'elapsedMs', 'exitCode', 'exitObserved', 'exitSignal', 'method', 'requestTimedOut', 'spawnFailed'].sort())
    expect(helper.lifecycleDiagnostics().elapsedMs).toBeGreaterThanOrEqual(0)
    expect(helper.lifecycleDiagnostics().elapsedMs).toBeLessThanOrEqual(60000)
    expect(JSON.stringify(helper.lifecycleDiagnostics())).not.toContain('PRIVATE_WINDOW_TITLE')
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('Stop still interrupts the extended Mac discovery deadline immediately', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const discovery = expect(helper.listTargets()).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(5000); await helper.kill(); await discovery
    expect(peer.child.kill).toHaveBeenCalledOnce()
    expect(helper.readinessDiagnostics().requestTimedOut).toBe(false)
  })
  const discoveryMetadata = { version: 1, processes: 5, fenceRejected: 0, unsupportedProcess: 4, parentRejected: 0,
    signatureRejected: 0, admitted: 1, windowListRejected: 1, boundsRejected: 0, scopeRejected: 0, fenceChanged: 0,
    targets: 0, axCannotComplete: 1, axApiDisabled: 0, axInvalidElement: 0, axOtherError: 0 }
  it('publishes detached bounded discovery metadata without exposing it in target results', async () => {
    const peer = fakeChild(); const onDiscovery = vi.fn((_metadata: unknown) => { throw new Error('Diagnostic callback failed') })
    const helper = new PrivatePipeHelper('/packaged/helper', () => {}, undefined, undefined, { onDiscovery })
    const pending = helper.listTargets(); peer.respond([], false, { discoveryDiagnostics: discoveryMetadata })
    expect(await pending).toEqual([])
    expect(onDiscovery).not.toHaveBeenCalled()
    await new Promise(resolve => setImmediate(resolve))
    expect(onDiscovery).toHaveBeenCalledExactlyOnceWith(discoveryMetadata)
    expect(Object.isFrozen(onDiscovery.mock.calls[0][0])).toBe(true)
    expect(peer.child.kill).not.toHaveBeenCalled(); await helper.kill()
  })
  it.each(['extra', 'negative', 'fraction', 'oversize', 'missing', 'version', 'invalid-result', 'wrong-method'])('drops %s discovery diagnostics without changing operation outcomes', async variant => {
    const peer = fakeChild(); const onDiscovery = vi.fn()
    const helper = new PrivatePipeHelper('/packaged/helper', () => {}, undefined, undefined, { onDiscovery })
    const metadata: Record<string, unknown> = { ...discoveryMetadata }
    if (variant === 'extra') metadata.title = 'PRIVATE_WINDOW_TITLE'
    if (variant === 'negative') metadata.admitted = -1
    if (variant === 'fraction') metadata.admitted = 1.5
    if (variant === 'oversize') metadata.admitted = 65536
    if (variant === 'missing') delete metadata.admitted
    if (variant === 'version') metadata.version = 2
    const pending = variant === 'wrong-method' ? helper.capabilities() : helper.listTargets()
    const outcome = variant === 'invalid-result' ? expect(pending).rejects.toThrow() : pending
    const result = variant === 'wrong-method'
      ? { protocol: NATIVE_PROTOCOL, platform: 'darwin', axRead: false, semanticActions: false, windowCapture: false, input: false, accessibilityPermission: 'unknown', capturePermission: 'unknown', limitations: [] }
      : variant === 'invalid-result' ? [{}] : []
    peer.respond(result, false, { discoveryDiagnostics: metadata }); await outcome
    await new Promise(resolve => setImmediate(resolve))
    expect(onDiscovery).not.toHaveBeenCalled(); expect(peer.child.kill).not.toHaveBeenCalled(); await helper.kill()
  })
  it('reports actual exit separately after revocation, preserving the first cause and death barrier', async () => {
    const peer = fakeChild(); peer.child.kill.mockImplementation(() => false)
    const onExit = vi.fn((_metadata: unknown) => { throw new Error('Diagnostic callback failed') }); const onDeath = vi.fn()
    const helper = new PrivatePipeHelper('/packaged/helper', onDeath, undefined, undefined, { onExit })
    const pending = expect(helper.capabilities()).rejects.toThrow('unavailable')
    peer.child.stdin.emit('error', new Error('PRIVATE_PAYLOAD'))
    await pending
    expect(onDeath).toHaveBeenCalledOnce(); expect(onExit).not.toHaveBeenCalled()
    expect(helper.lifecycleDiagnostics()).toMatchObject({ cause: 'stdin_error', exitObserved: false })
    let complete = false; const death = helper.kill().then(() => { complete = true })
    await Promise.resolve(); expect(complete).toBe(false)
    peer.child.emit('exit', 72, null); await death
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).toHaveBeenCalledOnce()
    expect(onExit.mock.calls[0][0]).toMatchObject({ cause: 'stdin_error', exitObserved: true, exitCode: 72, method: 'capabilities' })
    expect(JSON.stringify(onExit.mock.calls)).not.toContain('PRIVATE_PAYLOAD')
    expect(onDeath).toHaveBeenCalledOnce()
  })
  it('keeps explicit discovery timeout overrides', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {}, 20)
    const discovery = expect(helper.listTargets()).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(20); await discovery; await helper.kill()
    expect(peer.child.kill).toHaveBeenCalledOnce()
  })
  it('Stop kills immediately while Mac bootstrap is still pending', async () => {
    vi.useFakeTimers()
    const peer = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const startup = expect(helper.capabilities()).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(5000)
    await helper.kill(); await startup
    expect(peer.child.kill).toHaveBeenCalledOnce()
    expect(helper.readinessDiagnostics().requestTimedOut).toBe(false)
  })
  it.each(['win32', 'linux'] as const)('%s startup retains the four-second deadline', async platform => {
    vi.useFakeTimers()
    const peer = fakeChild(); Object.defineProperty(process, 'platform', { value: platform })
    const spec = platform === 'win32' ? { platform, executable: 'C:\\packaged\\helper.exe', args: [] }
      : { platform, executable: '/usr/bin/python3', args: ['-Es', '/packaged/helper.py'] }
    const helper = new PrivatePipeHelper(spec, () => {})
    const startup = expect(helper.capabilities()).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(4000); await startup; await helper.kill()
    expect(peer.child.kill).toHaveBeenCalledOnce()
  })
  it('uses only inherited pipes and parses fragmented framed responses', async () => {
    const { child, respond } = fakeChild(); const death = vi.fn()
    const helper = new PrivatePipeHelper('/packaged/helper', death)
    const pending = helper.listTargets(); respond([]); expect(await pending).toEqual([])
    expect(mocked.spawn).toHaveBeenCalledWith('/packaged/helper', [], expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }))
    await helper.kill(); expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(death).toHaveBeenCalledOnce()
    await expect(helper.listTargets()).rejects.toThrow(); expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it.each(['darwin', 'win32', 'linux'] as const)('launches %s without shell, privileges or inherited overrides', async platform => {
    fakeChild(); Object.defineProperty(process, 'platform', { value: platform })
    for (const key of ['PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'GI_TYPELIB_PATH', 'NODE_OPTIONS', 'PATH']) vi.stubEnv(key, '/untrusted')
    vi.stubEnv('DISPLAY', ':7'); vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0')
    const executable = platform === 'win32' ? 'C:\\resources\\native\\computer-control\\windows\\Brian.NativeHelper.exe' : platform === 'linux' ? '/usr/bin/python3' : '/resources/helper'
    const args = platform === 'linux' ? ['-Es', '/resources/native/computer-control/linux/helper.py'] : []
    const helper = new PrivatePipeHelper({ platform, executable, args }, () => {})
    const [exe, argv, options] = mocked.spawn.mock.calls.at(-1)!
    expect(exe).toBe(executable); expect(argv).toEqual(args)
    expect(options.shell).toBe(false); expect(options.windowsHide).toBe(true); expect(options.cwd).not.toBe('/untrusted')
    expect(options.uid).toBeUndefined(); expect(options.gid).toBeUndefined(); expect(options.detached).toBeUndefined()
    for (const key of ['PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'GI_TYPELIB_PATH', 'NODE_OPTIONS']) expect(options.env[key]).toBeUndefined()
    expect(options.env.PATH).not.toBe('/untrusted')
    if (platform === 'linux') { expect(options.env.DISPLAY).toBe(':7'); expect(options.env.WAYLAND_DISPLAY).toBe('wayland-0') }
    await helper.kill(); vi.unstubAllEnvs()
  })
  it('rejects relative Windows paths and alternate Linux interpreters/arguments before spawn', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(() => new PrivatePipeHelper({ platform: 'win32', executable: 'C:helper.exe', args: [] }, () => {})).toThrow()
    Object.defineProperty(process, 'platform', { value: 'linux' })
    for (const spec of [{ executable: '/tmp/python3', args: ['-Es', '/resources/helper.py'] }, { executable: '/usr/bin/python3', args: ['-c', 'evil'] }]) {
      expect(() => new PrivatePipeHelper({ platform: 'linux', ...spec }, () => {})).toThrow()
    }
    expect(mocked.spawn).not.toHaveBeenCalled()
  })
  it('readiness lifecycle distinguishes bootstrap refusal from timeout without retaining stderr', async () => {
    const first = fakeChild(); const refused = new PrivatePipeHelper('/packaged/helper', () => {})
    const request = refused.capabilities(); const rejection = expect(request).rejects.toThrow('Native helper unavailable')
    first.child.stderr.write('PRIVATE_DIAGNOSTIC_MUST_NOT_BE_RETAINED')
    first.child.emit('exit', 77, null)
    await rejection; await refused.kill()
    expect(refused.readinessDiagnostics()).toEqual({ requestTimedOut: false, exitObserved: true, exitCode: 77, exitSignal: null, spawnFailed: false })
    expect(JSON.stringify(refused.readinessDiagnostics())).not.toContain('PRIVATE_DIAGNOSTIC')
    fakeChild(); const timedOut = new PrivatePipeHelper('/packaged/helper', () => {}, 10)
    await expect(timedOut.capabilities()).rejects.toThrow('Native helper unavailable')
    await timedOut.kill()
    expect(timedOut.readinessDiagnostics()).toEqual({ requestTimedOut: true, exitObserved: true, exitCode: null, exitSignal: 'SIGKILL', spawnFailed: false })
    expect(mocked.spawn).toHaveBeenCalledTimes(2) // explicit instances, never an automatic retry
  })
  it('reports native physical-input exit as takeover, not an automatic reconnect', async () => {
    const { child } = fakeChild(); const death = vi.fn()
    const helper = new PrivatePipeHelper('/packaged/helper', death)
    child.emit('exit', 73, null)
    expect(death).toHaveBeenCalledWith('takeover')
    await expect(helper.listTargets()).rejects.toThrow(); await helper.kill()
  })
  it('kills an unresponsive helper without waiting for AX and never reconnects', async () => {
    vi.useFakeTimers()
    const { child } = fakeChild(); const death = vi.fn(); const helper = new PrivatePipeHelper('/packaged/helper', death, 10)
    const pending = expect(helper.listTargets()).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(11); await pending
    expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(death).toHaveBeenCalledOnce()
    await expect(helper.listTargets()).rejects.toThrow(); expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('kills mismatched response IDs and oversized frames', async () => {
    for (const oversized of [false, true]) {
      const { child, respond } = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
      const pending = expect(helper.listTargets()).rejects.toThrow()
      if (oversized) { const header = Buffer.alloc(4); header.writeUInt32BE(4 * 1024 * 1024 + 1); child.stdout.write(header) }
      else respond([], true)
      await pending; expect(child.kill).toHaveBeenCalledWith('SIGKILL'); await helper.kill()
    }
  })
})

it('accepts mixed old and labelled helper discovery without conflating same-app windows', async () => {
  const { respond } = fakeChild()
  const helper = new PrivatePipeHelper('/packaged/helper', () => {})
  const base = { appId: 'com.apple.TextEdit', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
  const targets = [{ ...base, displayName: 'First document' }, { ...base, windowId: 'w2', windowInstanceId: 'wi2', displayName: 'Second document' }, { ...base, windowId: 'old' }]
  const pending = helper.listTargets(); respond(targets)
  expect(await pending).toEqual(targets)
  await helper.kill()
})


// A failed signal is revocation, not evidence of death. No real OS process or
// permission manipulation is needed to exercise Node's ChildProcess events.
describe('confirmed helper death barrier', () => {
  const killError = () => Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' })
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))

  it.each(['error', 'false', 'throw'] as const)('spawned PID: kill %s revokes pending commands but waits for actual exit', async failure => {
    const { child } = fakeChild(), onDeath = vi.fn()
    child.kill.mockImplementation(() => {
      expect(child.stdin.destroyed).toBe(true)
      expect(child.stdout.destroyed).toBe(true)
      if (failure === 'throw') throw killError()
      if (failure === 'error') child.emit('error', killError())
      return false
    })
    const helper = new PrivatePipeHelper('/packaged/helper', onDeath)
    child.emit('spawn')
    const pending = expect(helper.listTargets()).rejects.toThrow('unavailable')
    let exited = false
    const death = helper.kill()
    void death.then(() => { exited = true })
    await pending; await tick()
    expect(exited).toBe(false)
    expect(child.stdin.destroyed).toBe(true)
    expect(child.stdout.destroyed).toBe(true)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(onDeath).toHaveBeenCalledOnce()
    await expect(helper.listTargets()).rejects.toThrow('unavailable')
    expect(helper.kill()).toBe(death)
    // The listener must remain installed after the first kill error.
    expect(() => { child.emit('error', killError()); child.emit('error', killError()) }).not.toThrow()
    child.emit('close', null, null) // pipe closure alone is not a death witness
    await tick()
    expect(exited).toBe(false)
    expect(child.kill).toHaveBeenCalledOnce() // no uncertain retry
    expect(onDeath).toHaveBeenCalledOnce()
    child.emit('exit', null, 'SIGKILL')
    await death
    expect(exited).toBe(true)
    expect(onDeath).toHaveBeenCalledOnce()
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })

  it('immediate Stop before spawn event still fences a PID-assigned process until exit', async () => {
    const { child } = fakeChild(), onDeath = vi.fn()
    child.kill.mockImplementation(() => { child.emit('error', killError()); return false })
    const helper = new PrivatePipeHelper('/packaged/helper', onDeath)
    let exited = false
    const death = helper.kill().then(() => { exited = true })
    await tick()
    expect(exited).toBe(false)
    expect(onDeath).toHaveBeenCalledOnce()
    child.emit('spawn') // next-tick event can follow the immediate kill request
    child.emit('error', killError())
    await tick()
    expect(exited).toBe(false)
    child.emit('exit', null, 'SIGKILL'); await death
    expect(exited).toBe(true)
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('spawn evidence cannot be undone by a subsequently missing PID', async () => {
    const { child } = fakeChild()
    child.pid = undefined
    child.kill.mockReturnValue(false)
    const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    child.emit('spawn')
    let exited = false
    const death = helper.kill().then(() => { exited = true })
    child.emit('error', killError())
    await tick(); expect(exited).toBe(false)
    child.emit('exit', 1, null); await death
    expect(exited).toBe(true)
  })

  it.each([false, true])('actual spawn failure resolves without an exit event (early Stop=%s)', async earlyStop => {
    const { child } = fakeChild(), onDeath = vi.fn()
    child.pid = undefined
    child.kill.mockReturnValue(false)
    const helper = new PrivatePipeHelper('/packaged/helper', onDeath)
    const pending = expect(helper.listTargets()).rejects.toThrow('unavailable')
    let exited = false
    const early = earlyStop ? helper.kill().then(() => { exited = true }) : undefined
    await tick()
    expect(exited).toBe(false) // kill=false is never enough, even without a PID
    const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', syscall: 'spawn /packaged/helper' })
    child.emit('error', error)
    await pending; await helper.kill(); await early
    expect(onDeath).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(() => { child.emit('error', error); child.emit('error', error) }).not.toThrow()
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })

  it.each(['error', 'false', 'throw'] as const)('controller retains its lease through kill %s and releases only on real exit', async failure => {
    const { child, respond, lastRequest } = fakeChild()
    child.kill.mockImplementation(() => {
      expect(child.stdin.destroyed).toBe(true)
      expect(child.stdout.destroyed).toBe(true)
      if (failure === 'throw') throw killError()
      if (failure === 'error') child.emit('error', killError())
      return false
    })
    const lease = { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) }
    const controller = new NativeComputerController({ revalidateExecution: async () => true, enabled: true, platform: 'darwin', safetyControlsReady: () => true,
      helperFactory: onDeath => new PrivatePipeHelper('/packaged/helper', onDeath), lease,
      approveGrant: async () => true, approveAction: async () => true,
    })
    const identity = { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'device', sessionId: 's', conversationId: 'c', taskId: 't' }
    const target = { appId: 'fixture', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
    const grant: NativeGrant = { protocol: NATIVE_PROTOCOL, identity, grantId: 'g', epoch: 1, expiresAt: Date.now() + 60_000,
      targets: [target], allowControl: true, allowCapture: false, requester: 'Local user', goal: 'Read fixture' }
    const starting = controller.start(grant)
    await vi.waitFor(() => expect(lastRequest()?.method).toBe('capabilities'))
    child.emit('spawn')
    respond({ protocol: NATIVE_PROTOCOL, platform: 'darwin', axRead: true, semanticActions: true, windowCapture: false, input: false,
      accessibilityPermission: 'granted', capturePermission: 'denied', limitations: [] })
    await vi.waitFor(() => expect(lastRequest()?.method).toBe('start'))
    respond(true); await starting
    const command = controller.execute({ protocol: NATIVE_PROTOCOL, identity, grantId: grant.grantId, epoch: 1,
      commandId: 'read', deadlineAt: Date.now() + 30_000, action: { kind: 'observe', target } })
    await vi.waitFor(() => expect(lastRequest()?.method).toBe('execute'))
    let stopped = false
    const shutdown = controller.stop().then(() => { stopped = true })
    expect(await command).toMatchObject({ outcome: 'execution_unknown' })
    expect(controller.status().state).toBe('stopped')
    expect(child.stdin.destroyed).toBe(true)
    expect(child.stdout.destroyed).toBe(true)
    expect(lease.acquire).toHaveBeenCalledOnce()
    expect(lease.release).not.toHaveBeenCalled()
    child.emit('error', killError()); child.emit('error', killError())
    await tick()
    expect(stopped).toBe(false)
    expect(lease.release).not.toHaveBeenCalled()
    await expect(controller.start({ ...grant, epoch: 3 })).rejects.toThrow('Local Resume required')
    expect(mocked.spawn).toHaveBeenCalledOnce()
    child.emit('exit', null, 'SIGKILL'); await shutdown
    expect(stopped).toBe(true)
    expect(lease.release).toHaveBeenCalledOnce()
    await controller.dispose()
    expect(lease.release).toHaveBeenCalledOnce()
  })
})

it.skipIf(platform !== 'linux').each(['false', 'throw', 'error'] as const)('real inherited Node pipes revoke a blocked helper despite kill %s', async failure => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const directory = await mkdtemp(join(tmpdir(), 'native-channel-'))
  const safetyPath = fileURLToPath(new URL('../../native/computer-control/linux', import.meta.url))
  // No protocol reader: the command stays unread while the main worker blocks.
  // The parent remains alive; only peer closure can satisfy this watchdog.
  await writeFile(join(directory, 'helper.py'), `import sys,os,threading
sys.path.insert(0,${JSON.stringify(safetyPath)})
from safety import Safety
s=Safety.__new__(Safety)
s.lock=threading.Lock();s.lock.acquire()
threading.Thread(target=s.watch_channel,daemon=True).start()
os.write(2,b'ready\\n')
threading.Event().wait()
`)
  let child!: import('node:child_process').ChildProcessWithoutNullStreams
  let ready!: () => void, failed!: (error: Error) => void
  const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
  let exited = false
  mocked.spawn.mockImplementationOnce((...args: Parameters<typeof spawn>) => {
    // Non-FHS CI has /bin/python3 rather than /usr/bin/python3. Test-only
    // spawn substitution; the production fixed interpreter check is unchanged.
    args[0] = 'python3'
    child = spawn(...args) as typeof child
    child.stderr.once('data', chunk => { if (chunk.toString().startsWith('ready')) ready(); else failed(new Error(chunk.toString())) })
    child.once('error', failed)
    child.once('exit', code => { exited = true; failed(new Error(`fixture exited before ready: ${code}`)) })
    vi.spyOn(child, 'kill').mockImplementation(() => {
      expect(child.stdin.destroyed).toBe(true)
      expect(child.stdout.destroyed).toBe(true)
      if (failure === 'throw') throw new Error('simulated EPERM')
      if (failure === 'error') child.emit('error', new Error('simulated EPERM'))
      return false
    })
    return child
  })
  const onDeath = vi.fn()
  const helper = new PrivatePipeHelper({ platform: 'linux', executable: '/usr/bin/python3', args: ['-Es', join(directory, 'helper.py')] }, onDeath, 10_000)
  try {
    await started
    const command = expect(helper.listTargets()).rejects.toThrow('unavailable')
    const death = helper.kill()
    expect(exited).toBe(false) // stream closure cannot substitute for exit
    expect(onDeath).toHaveBeenCalledOnce()
    await command
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 2000 })
    await death
    expect(child.exitCode).toBe(70)
    expect(child.signalCode).toBeNull() // no signal terminated this process
    expect(child.kill).toHaveBeenCalledOnce()
  } finally {
    if (!exited && child.pid) process.kill(child.pid, 'SIGKILL')
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  }
})

// No controller wiring: diagnostics are exclusively a trusted constructor option.
describe('private helper source timing metadata', () => {
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))
  const capabilities = (platform: 'linux' | 'darwin' | 'win32' = 'linux') => ({ protocol: NATIVE_PROTOCOL, platform,
    axRead: true, semanticActions: true, windowCapture: true, input: false, accessibilityPermission: 'granted', capturePermission: 'granted', limitations: [] })
  async function setup(onMetadata = vi.fn(), enabled = true, negotiate = true, platform: 'linux' | 'darwin' | 'win32' = 'linux') {
    const f = fakeChild()
    Object.defineProperty(process, 'platform', { value: platform })
    let handshaking = negotiate
    const spec = platform === 'linux' ? { platform, executable: '/usr/bin/python3', args: ['-Es', '/packaged/helper.py'] }
      : { platform, executable: platform === 'win32' ? 'C:\\packaged\\helper.exe' : '/packaged/helper', args: [] }
    const helper = new PrivatePipeHelper(spec, vi.fn(), 4000,
      enabled ? { enabled: true, onMetadata: event => { if (!handshaking) return onMetadata(event) } } : undefined)
    const diagnostic = (overrides = {}) => ({ version: 1, instanceId: '12345678-1234-4234-8234-123456789012', clockId: '12345678-1234-4234-8234-123456789013',
      requestId: f.lastRequest().id, method: f.lastRequest().method, spans: [{ phase: 'request', startUs: 100, endUs: 160, durationUs: 60, status: 'returned' }], ...overrides })
    function respond(result: unknown, diagnostics?: unknown, envelope: Record<string, unknown> = {}) {
      const body = Buffer.from(JSON.stringify({ id: f.lastRequest().id, ok: true, result, ...(diagnostics === undefined ? {} : { diagnostics }), ...envelope }))
      const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
      f.child.stdout.write(Buffer.concat([header, body]))
    }
    if (negotiate) {
      const pending = helper.capabilities()
      expect(f.lastRequest()).not.toHaveProperty('diagnostics')
      respond(capabilities(platform), undefined, { diagnosticsVersion: 1 })
      await pending; await tick(); await tick()
      handshaking = false
    }
    return { ...f, helper, diagnostic, respond, onMetadata }
  }
  it.each(['linux', 'darwin', 'win32'] as const)('learns private support on %s only after the first validated capabilities response', async platform => {
    const f = await setup(vi.fn(), true, false, platform)
    const first = f.helper.capabilities()
    expect(f.lastRequest()).not.toHaveProperty('diagnostics')
    // Even a valid unsolicited DTO on the handshake was not requested. It must
    // not pin a clock or turn this first request into completed timing evidence.
    f.respond(capabilities(platform), f.diagnostic(), { diagnosticsVersion: 1 })
    expect(await first).toEqual(capabilities(platform)); await tick(); await tick()
    expect(f.onMetadata).toHaveBeenCalledWith(expect.objectContaining({ state: 'incomplete', reason: 'absent' }))
    const next = f.helper.listTargets()
    expect(f.lastRequest()).toHaveProperty('diagnostics', true)
    f.respond([], f.diagnostic({ clockId: '12345678-1234-4234-8234-123456789099', spans: [{ phase: 'request', startUs: 0, endUs: 10, durationUs: 10, status: 'returned' }] }))
    expect(await next).toEqual([]); await tick()
    expect(f.onMetadata.mock.calls[1][0]).toMatchObject({ state: 'complete' })
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it.each(['linux', 'darwin', 'win32'] as const)('old %s helper sees unchanged requests and absent metadata', async platform => {
    const f = await setup(vi.fn(), true, false, platform)
    const first = f.helper.capabilities(); expect(f.lastRequest()).not.toHaveProperty('diagnostics')
    f.respond(capabilities(platform)); await first; await tick(); await tick()
    const next = f.helper.listTargets()
    expect(Object.keys(f.lastRequest()).sort()).toEqual(['id', 'method', 'payload'])
    f.respond([]); expect(await next).toEqual([]); await tick()
    expect(f.onMetadata.mock.calls.map(([event]) => event.reason)).toEqual(['absent', 'absent'])
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it.each([false, true, '1', 0, 2, 1.5, null, {}, []])('malformed/unknown private version %j disables only diagnostics for this process', async version => {
    const f = await setup(vi.fn(), true, false)
    const first = f.helper.capabilities()
    f.respond(capabilities(), undefined, { diagnosticsVersion: version })
    expect(await first).toEqual(capabilities()); await tick(); await tick()
    expect(f.onMetadata.mock.calls[0][0]).toMatchObject({ state: 'incomplete', reason: 'invalid' })
    // No same-process recovery from a malformed/changing advertisement.
    const second = f.helper.capabilities(); expect(f.lastRequest()).not.toHaveProperty('diagnostics')
    f.respond(capabilities(), undefined, { diagnosticsVersion: 1 }); await second; await tick(); await tick()
    const next = f.helper.listTargets(); expect(f.lastRequest()).not.toHaveProperty('diagnostics')
    f.respond([]); expect(await next).toEqual([])
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it.each([undefined, false, '1', 2])('a changed advertised version %j cannot reset support or clock', async version => {
    const f = await setup()
    const first = f.helper.listTargets(); f.respond([], f.diagnostic()); await first; await tick(); await tick()
    const changed = f.helper.capabilities(); expect(f.lastRequest()).toHaveProperty('diagnostics', true)
    f.respond(capabilities(), f.diagnostic({ spans: [{ phase: 'request', startUs: 200, endUs: 210, durationUs: 10, status: 'returned' }] }),
      version === undefined ? {} : { diagnosticsVersion: version })
    expect(await changed).toEqual(capabilities()); await tick(); await tick()
    expect(f.onMetadata.mock.calls[1][0]).toMatchObject({ state: 'incomplete', reason: 'invalid' })
    const next = f.helper.listTargets(); expect(f.lastRequest()).not.toHaveProperty('diagnostics')
    f.respond([]); expect(await next).toEqual([])
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it('does not upgrade a previously absent advertisement in the same process', async () => {
    const f = await setup(vi.fn(), true, false)
    let pending = f.helper.capabilities(); f.respond(capabilities()); await pending; await tick(); await tick()
    pending = f.helper.capabilities(); f.respond(capabilities(), undefined, { diagnosticsVersion: 1 }); await pending; await tick(); await tick()
    expect(f.onMetadata.mock.calls[1][0]).toMatchObject({ state: 'incomplete', reason: 'invalid' })
    const next = f.helper.listTargets(); expect(f.lastRequest()).not.toHaveProperty('diagnostics'); f.respond([]); await next
    await f.helper.kill()
  })
  it.each(['instanceId', 'clockId', 'backwards'] as const)('repeated capability advertisement cannot reset source %s', async field => {
    const f = await setup()
    const first = f.helper.listTargets(); f.respond([], f.diagnostic()); await first; await tick(); await tick()
    const repeat = f.helper.capabilities()
    f.respond(capabilities(), f.diagnostic(field === 'backwards' ? {} : { [field]: '12345678-1234-4234-8234-123456789099', spans: [{ phase: 'request', startUs: 200, endUs: 210, durationUs: 10, status: 'returned' }] }), { diagnosticsVersion: 1 })
    expect(await repeat).toEqual(capabilities()); await tick(); await tick()
    expect(f.onMetadata.mock.calls[1][0]).toMatchObject({ state: 'incomplete', reason: 'invalid' })
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it('advertisement on another method cannot negotiate support', async () => {
    const f = await setup(vi.fn(), true, false)
    const next = f.helper.listTargets(); f.respond([], undefined, { diagnosticsVersion: 1 }); expect(await next).toEqual([]); await tick(); await tick()
    expect(f.onMetadata.mock.calls[0][0]).toMatchObject({ state: 'incomplete', reason: 'invalid' })
    const cap = f.helper.capabilities(); f.respond(capabilities(), undefined, { diagnosticsVersion: 1 }); await cap
    const again = f.helper.listTargets(); expect(f.lastRequest()).not.toHaveProperty('diagnostics'); f.respond([]); await again
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it.each(['invalid-result', 'wrong-platform', 'public-advertisement'] as const)('%s capabilities cannot negotiate', async bad => {
    const f = await setup(vi.fn(), true, false)
    const result = bad === 'invalid-result' ? {} : bad === 'wrong-platform' ? capabilities('win32') : { ...capabilities(), diagnosticsVersion: 1 }
    const pending = f.helper.capabilities()
    const assertion = bad === 'wrong-platform' ? expect(pending).resolves.toEqual(result) : expect(pending).rejects.toThrow()
    f.respond(result, undefined, bad === 'public-advertisement' ? {} : { diagnosticsVersion: 1 })
    await assertion; await tick(); await tick()
    expect(f.onMetadata.mock.calls[0][0]).toMatchObject({ state: 'incomplete', reason: 'invalid' })
    const next = f.helper.listTargets(); expect(f.lastRequest()).not.toHaveProperty('diagnostics'); f.respond([]); await next
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it.each(['wrong-id', 'failed'] as const)('preserves existing channel failure for %s handshake without learning advertisement', async bad => {
    const f = await setup(vi.fn(), true, false)
    const pending = expect(f.helper.capabilities()).rejects.toThrow('unavailable')
    f.respond(capabilities(), undefined, { diagnosticsVersion: 1, ...(bad === 'wrong-id' ? { id: 'foreign' } : { ok: false }) })
    await pending; await tick()
    expect(f.onMetadata.mock.calls[0][0]).toMatchObject({ state: 'incomplete', reason: 'lost_response' })
    expect(f.child.kill).toHaveBeenCalledOnce(); await expect(f.helper.listTargets()).rejects.toThrow('unavailable'); await f.helper.kill()
  })
  it('still refuses an unsupported host platform before spawning regardless of configured observer', () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd' })
    expect(() => new PrivatePipeHelper('/packaged/helper', vi.fn(), 4000, { enabled: true, onMetadata: vi.fn() })).toThrow('unsupported')
    expect(mocked.spawn).not.toHaveBeenCalled()
  })
  it('default off even with env opt-in; no callbacks or request metadata', async () => {
    vi.stubEnv('NATIVE_COMPUTER_TIMING', 'true')
    try {
      const f = await setup(vi.fn(), false)
      const pending = f.helper.listTargets()
      expect(f.lastRequest()).not.toHaveProperty('diagnostics')
      f.respond([], { arbitrary: 'ignored' }); expect(await pending).toEqual([])
      await tick(); expect(f.onMetadata).not.toHaveBeenCalled(); await f.helper.kill()
    } finally { vi.unstubAllEnvs() }
  })
  it('copies/freezes source durations and trusted pre-await session/epoch/command correlation', async () => {
    const f = await setup()
    const command = { protocol: NATIVE_PROTOCOL, identity: { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'device', sessionId: '12345678-1234-4234-8234-123456789014', conversationId: 'c', taskId: 't' },
      grantId: 'g', epoch: 3, commandId: '12345678-1234-4234-8234-123456789015', deadlineAt: Date.now() + 1000, action: { kind: 'setValue' as const, target: { appId: 'editor', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }, observationId: 'o', ref: 'private-ref', text: 'private-text' } }
    const pending = f.helper.execute(command, 'lease')
    expect(f.lastRequest()).toHaveProperty('diagnostics', true)
    command.identity.sessionId = 'changed'; command.epoch = 99; command.commandId = 'changed'
    const timing = f.diagnostic({ spans: [{ phase: 'request', startUs: 100, endUs: 160, durationUs: 60, status: 'returned' }, { phase: 'api_set_value', startUs: 110, endUs: 130, durationUs: 20, status: 'returned' }] })
    f.respond({ commandId: '12345678-1234-4234-8234-123456789015', outcome: 'executed', code: 'ok' }, timing)
    await pending; expect(f.onMetadata).not.toHaveBeenCalled()
    timing.spans[0].durationUs = 999
    await tick()
    const event = f.onMetadata.mock.calls[0][0]
    expect(event.state).toBe('complete'); expect(event.timing.spans[0].durationUs).toBe(60)
    expect(event.timing.spans[1].durationUs).toBe(20)
    expect(event.correlation).toEqual({ sessionId: '12345678-1234-4234-8234-123456789014', epoch: 3, commandId: '12345678-1234-4234-8234-123456789015' })
    expect(Object.isFrozen(event)).toBe(true); expect(Object.isFrozen(event.correlation)).toBe(true)
    expect(Object.isFrozen(event.timing)).toBe(true); expect(Object.isFrozen(event.timing.spans)).toBe(true); expect(Object.isFrozen(event.timing.spans[0])).toBe(true)
    expect(JSON.stringify(event)).not.toMatch(/private-text|private-ref|editor|grantId|deadlineAt|deviceId/)
    await f.helper.kill()
  })
  it('omits invalid correlation without changing helper outcomes and reports the loss next time', async () => {
    const f = await setup()
    const command = { identity: { sessionId: 'not-a-uuid' }, epoch: 0, commandId: 'not-a-uuid', action: { kind: 'invoke' } } as unknown as Parameters<PrivatePipeHelper['beginApproval']>[0]
    const pending = f.helper.beginApproval(command, 'lease')
    f.respond(true, f.diagnostic()); expect(await pending).toBe(true)
    await tick(); await tick(); expect(f.onMetadata).not.toHaveBeenCalled()
    const next = f.helper.listTargets()
    f.respond([], f.diagnostic({ spans: [{ phase: 'request', startUs: 200, endUs: 210, durationUs: 10, status: 'returned' }] }))
    expect(await next).toEqual([]); await tick()
    expect(f.onMetadata).toHaveBeenCalledWith(expect.objectContaining({ state: 'complete', droppedBefore: 1 }))
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it.each(['absent', 'wrong-id', 'wrong-method', 'bool', 'empty', 'raw-content', 'wrong-phase'] as const)('reports %s as incomplete without changing response or killing', async bad => {
    const f = await setup(); const pending = f.helper.listTargets()
    const timing = bad === 'absent' ? undefined : f.diagnostic(bad === 'wrong-id' ? { requestId: 'other' } : bad === 'wrong-method' ? { method: 'execute' } : bad === 'raw-content' ? { values: 'secret' } : bad === 'empty' ? { spans: [] } : bad === 'wrong-phase' ? { spans: [{ phase: 'api_invoke', startUs: 1, endUs: 2, durationUs: 1, status: 'returned' }] } : { version: true })
    f.respond([], timing); expect(await pending).toEqual([]); await tick()
    expect(f.onMetadata).toHaveBeenCalledWith(expect.objectContaining({ state: 'incomplete', reason: bad === 'absent' ? 'absent' : 'invalid' }))
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it.each(['instanceId', 'clockId', 'backwards'] as const)('pins source domain and ordering: rejects changed %s without authority changes', async field => {
    const f = await setup(); let pending = f.helper.listTargets(); f.respond([], f.diagnostic()); await pending; await tick(); await tick()
    pending = f.helper.listTargets()
    f.respond([], f.diagnostic(field === 'backwards' ? {} : { [field]: '12345678-1234-4234-8234-123456789099', spans: [{ phase: 'request', startUs: 200, endUs: 220, durationUs: 20, status: 'returned' }] }))
    expect(await pending).toEqual([]); await tick()
    expect(f.onMetadata.mock.calls[1][0]).toMatchObject({ state: 'incomplete', reason: 'invalid' })
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it('lost response reports missing evidence, never completed timing or process death from pipe close', async () => {
    const f = await setup(); f.child.kill.mockReturnValue(false)
    const pending = expect(f.helper.listTargets()).rejects.toThrow('unavailable')
    let exited = false
    const stop = f.helper.kill().then(() => { exited = true })
    await pending; f.child.emit('close'); await tick()
    expect(exited).toBe(false)
    expect(f.onMetadata).toHaveBeenCalledWith(expect.objectContaining({ state: 'incomplete', reason: 'lost_response' }))
    expect(f.onMetadata.mock.calls[0][0]).not.toHaveProperty('timing')
    f.child.emit('exit', 70); await stop
  })
  it.each(['throw', 'reject', 'hang'] as const)('callback %s does not await execution/Stop; at most one in flight', async behavior => {
    const callback = vi.fn(() => { if (behavior === 'throw') throw new Error('private failure'); if (behavior === 'reject') return Promise.reject(new Error('private failure')); return new Promise<void>(() => {}) })
    const f = await setup(callback)
    let pending = f.helper.listTargets(); f.respond([], f.diagnostic()); await pending; await tick(); await tick()
    for (let i = 0; i < 5; i++) {
      pending = f.helper.listTargets(); f.respond([], f.diagnostic({ spans: [{ phase: 'request', startUs: 200 + i * 100, endUs: 220 + i * 100, durationUs: 20, status: 'returned' }] })); expect(await pending).toEqual([])
    }
    await f.helper.kill(); await tick()
    if (behavior === 'hang') expect(callback).toHaveBeenCalledOnce()
    expect(f.child.kill).toHaveBeenCalledOnce()
  })
  it('bounds scheduled callback work and explicitly counts dropped evidence on the next available callback', async () => {
    const f = await setup()
    for (let i = 0; i < 3; i++) {
      const pending = f.helper.listTargets()
      f.respond([], f.diagnostic({ spans: [{ phase: 'request', startUs: i * 100, endUs: i * 100 + 10, durationUs: 10, status: 'returned' }] }))
      await pending // microtasks only: first callback remains scheduled
    }
    await tick(); await tick()
    expect(f.onMetadata).toHaveBeenCalledOnce()
    const pending = f.helper.listTargets()
    f.respond([], f.diagnostic({ spans: [{ phase: 'request', startUs: 400, endUs: 410, durationUs: 10, status: 'returned' }] }))
    await pending; await tick()
    expect(f.onMetadata.mock.calls[1][0]).toMatchObject({ state: 'complete', droppedBefore: 2 })
    await f.helper.kill()
  })
  it.each(['missing', 'wrong'] as const)('reports %s API invocation evidence without changing the executed receipt', async bad => {
    const f = await setup()
    const command = { protocol: NATIVE_PROTOCOL, identity: { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'device', sessionId: '12345678-1234-4234-8234-123456789014', conversationId: 'c', taskId: 't' },
      grantId: 'g', epoch: 1, commandId: '12345678-1234-4234-8234-123456789015', deadlineAt: Date.now() + 1000, action: { kind: 'invoke' as const, target: { appId: 'editor', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }, observationId: 'o', ref: 'r' } }
    const pending = f.helper.execute(command, 'lease')
    const timing = f.diagnostic()
    if (bad === 'wrong') timing.spans.push({ phase: 'api_select', startUs: 110, endUs: 120, durationUs: 10, status: 'returned' })
    f.respond({ commandId: '12345678-1234-4234-8234-123456789015', code: 'ok', outcome: 'executed' }, timing)
    expect(await pending).toMatchObject({ outcome: 'executed' }); await tick()
    expect(f.onMetadata).toHaveBeenCalledWith(expect.objectContaining({ state: 'incomplete', reason: 'invalid' }))
    expect(f.child.kill).not.toHaveBeenCalled(); await f.helper.kill()
  })
  it.each(['darwin', 'win32'] as const)('does not send an unsupported optional envelope to not-yet-instrumented %s', async platform => {
    const f = fakeChild(), callback = vi.fn()
    Object.defineProperty(process, 'platform', { value: platform })
    const helper = new PrivatePipeHelper({ platform, executable: platform === 'win32' ? 'C:\\packaged\\helper.exe' : '/packaged/helper', args: [] }, vi.fn(), 4000, { enabled: true, onMetadata: callback })
    const pending = helper.listTargets(); expect(f.lastRequest()).not.toHaveProperty('diagnostics')
    f.respond([]); await pending; await tick()
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ state: 'incomplete', reason: 'absent' })); await helper.kill()
  })
})

it.skipIf(platform !== 'linux')('real POSIX private helper source timings bind to requests without stdout side channels', async () => {
  const { fileURLToPath } = await import('node:url')
  const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  mocked.spawn.mockImplementationOnce((...args: Parameters<typeof spawn>) => {
    args[0] = 'python3' // test-only non-FHS interpreter; production launch allowlist unchanged
    return spawn(...args)
  })
  vi.stubEnv('WAYLAND_DISPLAY', 'unsupported-test-session')
  vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
  const events: import('@use-brian/computer-control/helper-timing.js').HelperTimingEvent[] = []
  const helper = new PrivatePipeHelper({ platform: 'linux', executable: '/usr/bin/python3', args: ['-Es', fileURLToPath(new URL('../../native/computer-control/linux/helper.py', import.meta.url))] }, vi.fn(), 4000,
    { enabled: true, onMetadata: event => { events.push(event) } })
  try {
    const capabilities = await helper.capabilities()
    expect(capabilities.input).toBe(false); expect(capabilities.axRead).toBe(false)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await helper.listTargets()).toEqual([])
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await helper.listTargets()).toEqual([])
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ state: 'incomplete', reason: 'absent', method: 'capabilities' })
    expect(events.slice(1).every(event => event.state === 'complete')).toBe(true)
    if (events[1].state === 'complete' && events[2].state === 'complete') {
      expect(events[1].timing.instanceId).toBe(events[2].timing.instanceId)
      expect(events[1].timing.clockId).toBe(events[2].timing.clockId)
      expect(events[1].requestId).not.toBe(events[2].requestId)
      expect(events[1].timing.spans[0].endUs).toBeLessThanOrEqual(events[2].timing.spans[0].startUs)
    }
  } finally { await helper.kill(); vi.unstubAllEnvs() }
})

// Private side-channel admission: no renderer/model protocol is added.
describe('guardian handoff binding to pending helper execute', () => {
  const commandId = '12345678-1234-4234-8234-123456789015'
  function authority() {
    const identity = { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'device',
      sessionId: '12345678-1234-4234-8234-123456789014', conversationId: 'c', taskId: 't' }
    const target = { appId: 'com.usebrian.NativeComputerFixture', processId: 12, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
    const grant: NativeGrant = { protocol: NATIVE_PROTOCOL, identity, grantId: 'g', epoch: 1, expiresAt: Date.now() + 60_000,
      targets: [target], allowControl: true, allowCapture: true, requester: 'Brian', goal: 'test' }
    const command: Parameters<PrivatePipeHelper['execute']>[0] = { protocol: NATIVE_PROTOCOL, identity, grantId: 'g', epoch: 1,
      commandId, deadlineAt: Date.now() + 10_000, action: { kind: 'click', target, observationId: 'o', frameId: 'f', x: 1, y: 2 } }
    return { grant, command }
  }
  it('rejects side-channel handoffs during metadata or with a foreign request id', async () => {
    for (const foreign of [true, false]) {
      const f = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
      const pending = expect(helper.capabilities()).rejects.toThrow()
      f.handoff(foreign ? 'foreign' : f.lastRequest().id)
      await pending; await helper.kill(); expect(mocked.spawn.mock.calls.at(-1)?.[1]).toEqual([])
    }
  })
  it.each(['approval', 'session', 'epoch', 'command', 'scope', 'lease', 'descriptor'] as const)('refuses mismatched %s without launching an owner', async mismatch => {
    const f = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const { grant, command } = authority()
    const start = helper.start(grant, 'lease'); f.respond(true); await start
    if (mismatch !== 'approval') {
      const approval = helper.endApproval(command, 'lease', true); f.respond(true); await approval
    }
    const altered = structuredClone(command)
    if (mismatch === 'session') altered.identity.sessionId = '12345678-1234-4234-8234-123456789099'
    if (mismatch === 'epoch') altered.epoch++
    if (mismatch === 'command') altered.commandId = '12345678-1234-4234-8234-123456789098'
    if (mismatch === 'scope') altered.action.target.windowInstanceId = 'foreign'
    const execute = helper.execute(altered, mismatch === 'lease' ? 'foreign' : 'lease')
    const descriptor = descriptorFor(altered)
    if (mismatch === 'descriptor') descriptor.command.commandId = 'another-command'
    f.handoff(f.lastRequest().id, descriptor); expect(f.sideReplies).toEqual([{ kind: 'refused', requestId: f.lastRequest().id }])
    f.respond({ commandId: altered.commandId, outcome: 'not_executed', code: 'denied' }); await execute
    expect(mocked.spawn).toHaveBeenCalledOnce(); await helper.kill()
  })
  it.each([true, false])('kill waits for BOTH worker and owner (worker first=%s), never kills owner', async workerFirst => {
    const f = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    if (!workerFirst) f.child.kill.mockImplementation(() => false)
    const { grant, command } = authority()
    const start = helper.start(grant, 'lease'); f.respond(true); await start
    const approval = helper.endApproval(command, 'lease', true); f.respond(true); await approval
    const owner = fakeChild().child // next spawn only; helper retains original worker
    const execute = expect(helper.execute(command, 'lease')).rejects.toThrow()
    f.handoff(); const id = f.lastRequest().id
    const readyBody = Buffer.from(JSON.stringify({ kind: 'ready', state: 'unconstructed' }))
    const readyHeader = Buffer.alloc(4); readyHeader.writeUInt32BE(readyBody.length)
    owner.stdout.write(Buffer.concat([readyHeader, readyBody]))
    expect(mocked.spawn).toHaveBeenCalledTimes(2)
    let released = false; const death = helper.kill().then(() => { released = true })
    await execute; await new Promise<void>(resolve => setImmediate(resolve)); expect(released).toBe(false)
    expect(owner.kill).not.toHaveBeenCalled()
    const body = Buffer.from(JSON.stringify({ kind: 'terminal', id, status: 'refused', cleanup: 'neverArmedNoEmission', reason: 'platformUnaccepted' }))
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
    owner.stdout.write(Buffer.concat([header, body])); await Promise.resolve(); expect(released).toBe(false)
    owner.emit('exit', 0, null); owner.emit('close', 0, null)
    if (!workerFirst) {
      await new Promise<void>(resolve => setImmediate(resolve)); expect(released).toBe(false)
      f.child.emit('exit', null, 'SIGKILL')
    }
    await death; expect(released).toBe(true)
  })
})

// Future accepted-owner wire transcripts only. These mocks never accept a native
// platform/profile or prove AX/CG delivery; written tests, not executed here.
describe('one-click grant followed by independent readback', () => {
  const pack = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
    return Buffer.concat([header, body])
  }
  async function admittedClick() {
    const worker = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    const descriptor = descriptorFor(), command = descriptor.command
    if (!('taskId' in command.identity)) throw new Error('Legacy task fixture required')
    const grant: NativeGrant = { protocol: NATIVE_PROTOCOL, identity: command.identity, grantId: command.grantId,
      epoch: command.epoch, expiresAt: Date.now() + 60_000, targets: [command.action.target],
      allowControl: true, allowCapture: true, requester: 'Brian', goal: 'one click, then verify' }
    const start = helper.start(grant, 'lease'); worker.respond(true); await start
    const approval = helper.endApproval(command, 'lease', true); worker.respond(true); await approval
    const owner = fakeChild().child
    const pending = helper.execute(command, 'lease')
    worker.handoff(worker.lastRequest().id, descriptor)
    const id = worker.lastRequest().id
    const ownerSays = (value: unknown) => owner.stdout.write(pack(value))
    const workerSays = (kind: string, requestId = id) => worker.side.emit('data', pack({ kind, requestId }))
    ownerSays({ kind: 'ready', state: 'unconstructed' })
    ownerSays({ kind: 'prepared', id }); workerSays('workerTransferred')
    const offerReturn = () => ownerSays({ kind: 'returnMonitor', id, cleanup: 'inputStreamReleasedCandidate' })
    const terminal = () => ownerSays({ kind: 'terminal', id, status: 'sequenceAttemptedUnproven',
      cleanup: 'inputStreamReleasedCandidate', reason: 'monitorReturned' })
    const ownerDies = () => { owner.emit('exit', 0, null); owner.emit('close', 0, null) }
    return { helper, worker, owner, descriptor, command, pending, id, ownerSays, workerSays, offerReturn, terminal, ownerDies }
  }
  it('exposes stream execution only after return acknowledgment and owner exit; then observes/captures freshly', async () => {
    const f = await admittedClick()
    f.offerReturn(); f.workerSays('workerMonitoring'); f.terminal()
    expect(f.worker.sideReplies.some(value => (value as { kind: string }).kind === 'delivered')).toBe(false)
    f.ownerDies()
    expect(f.worker.sideReplies.at(-1)).toEqual({ kind: 'delivered', requestId: f.id })
    f.worker.respond({ commandId: f.command.commandId, outcome: 'executed', code: 'ok' })
    expect(await f.pending).toEqual({ commandId: f.command.commandId, outcome: 'executed', code: 'ok' })
    // The click receipt contains NO completion observation/goal-success assertion.
    const observation = { identity: f.command.identity, epoch: f.command.epoch, id: 'independent-readback',
      capturedAt: Date.now(), monotonicMs: 100, target: f.command.action.target, foreground: true,
      bounds: f.descriptor.bounds, displayLayoutVersion: f.descriptor.displayLayout, completeness: 'complete', nodes: [] }
    const observe = { ...f.command, commandId: 'readback-observe', action: { kind: 'observe' as const, target: f.command.action.target } }
    const observed = f.helper.execute(observe, 'lease')
    f.worker.respond({ commandId: observe.commandId, outcome: 'executed', code: 'ok', observation })
    expect((await observed).observation?.id).toBe('independent-readback')
    const capture = { ...f.command, commandId: 'readback-capture', action: { kind: 'capture' as const,
      target: f.command.action.target, observationId: observation.id } }
    const captured = f.helper.execute(capture, 'lease')
    f.worker.respond({ commandId: capture.commandId, outcome: 'executed', code: 'ok', observation: { ...observation,
      frame: { id: 'new-readback-frame', mimeType: 'image/png', data: 'synthetic-wire-fixture', width: 100, height: 100,
        bounds: f.descriptor.bounds, displayLayoutVersion: f.descriptor.displayLayout } } })
    expect((await captured).observation?.frame?.id).toBe('new-readback-frame')
    const lastRequest = f.worker.lastRequest().id
    const target = f.command.action.target, observationId = observation.id
    const effects: Parameters<PrivatePipeHelper['execute']>[0]['action'][] = [
      { kind: 'click', target, observationId, frameId: 'new-readback-frame', x: 2, y: 2 },
      { kind: 'invoke', target, observationId, ref: 'button' },
      { kind: 'setValue', target, observationId, ref: 'field', text: 'not permitted' },
      { kind: 'scroll', target, observationId, ref: 'scroll', deltaY: 1 },
      { kind: 'key', target, observationId, key: 'Enter' },
      { kind: 'focus', target, observationId },
    ]
    for (const action of effects) await expect(f.helper.execute({ ...f.command, commandId: `second-${action.kind}`, action }, 'lease')).rejects.toThrow('spent')
    await expect(f.helper.execute(f.command, 'lease')).rejects.toThrow('spent') // no replay of the original
    await expect(f.helper.beginApproval(f.command, 'lease')).rejects.toThrow('spent')
    expect(f.worker.lastRequest().id).toBe(lastRequest)
    expect(mocked.spawn).toHaveBeenCalledTimes(2) // no second owner
    await f.helper.kill()
  })
  it('rejects executed worker output before normal owner death/transcript completion', async () => {
    const f = await admittedClick()
    const rejected = expect(f.pending).rejects.toThrow()
    f.worker.respond({ commandId: f.command.commandId, outcome: 'executed', code: 'ok' })
    await rejected
    // A genuine never-armed refusal can release cleanup, but cannot retroactively
    // turn the discarded early receipt into delivery.
    f.ownerSays({ kind: 'terminal', id: f.id, status: 'refused', cleanup: 'neverArmedNoEmission', reason: 'revoked' })
    f.ownerDies(); await f.helper.kill()
  })
  it('failed monitoring acknowledgement leaves the grant fenced after owner death', async () => {
    const f = await admittedClick(); const rejected = expect(f.pending).rejects.toThrow()
    f.offerReturn(); f.workerSays('workerMonitoring', 'stale-execute')
    await rejected; f.terminal(); f.ownerDies()
    let released = false; void f.helper.kill().then(() => { released = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(released).toBe(false)
    expect(f.worker.sideReplies.some(value => (value as { kind: string }).kind === 'delivered')).toBe(false)
  })
})

describe('private visual approval wire', () => {
  function visual() {
    const command = descriptorFor().command
    return { ...command, action: { ...command.action, kind: 'visualInvoke' as const } } as Parameters<PrivatePipeHelper['execute']>[0]
  }
  function binding() {
    const c = visual()
    return { bindingId: 'binding', commandId: c.commandId, frameId: 'f', action: { kind: 'invoke', target: c.action.target, observationId: 'o', ref: 'resolved' } }
  }
  it('freezes the native binding, requires exact echo and burns approved dispatch', async () => {
    const pipe = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    try {
      const c = visual()
      const begun = helper.beginApproval(c, 'lease'); pipe.respond(binding())
      const result = await begun
      expect(Object.isFrozen(result)).toBe(true)
      const ended = helper.endApproval(c, 'lease', true, 'binding')
      expect(pipe.lastRequest().payload).toMatchObject({ command: c, bindingId: 'binding' })
      pipe.respond(true); expect(await ended).toBe(true)
      const execution = helper.execute(c, 'lease'); pipe.respond({ commandId: c.commandId, outcome: 'executed', code: 'ok' })
      expect(await execution).toMatchObject({ outcome: 'executed' })
      await expect(helper.execute(c, 'lease')).rejects.toThrow('not approved')
    } finally { await helper.kill() }
  })
  it.each(['boolean', 'frame', 'target', 'legacy-object'] as const)('rejects incompatible approval %s', async fault => {
    const pipe = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    try {
      const c = visual(); const value = binding()
      if (fault === 'frame') value.frameId = 'other'
      if (fault === 'target') value.action.target.windowInstanceId = 'other'
      if (fault === 'legacy-object') c.action = { kind: 'invoke', target: c.action.target, observationId: 'o', ref: 'r' }
      const begun = helper.beginApproval(c, 'lease'); pipe.respond(fault === 'boolean' ? true : value)
      await expect(begun).rejects.toThrow()
      await expect(helper.endApproval(visual(), 'lease', true, 'binding')).rejects.toThrow()
    } finally { await helper.kill() }
  })
  it.each(['binding', 'lease', 'command', 'stop'] as const)('rejects changed approval or Stop: %s', async fault => {
    const pipe = fakeChild(); const helper = new PrivatePipeHelper('/packaged/helper', () => {})
    try {
      const c = visual(); const begun = helper.beginApproval(c, 'lease'); pipe.respond(binding()); await begun
      if (fault === 'stop') await helper.kill()
      if (fault === 'command') c.deadlineAt++
      await expect(helper.endApproval(c, fault === 'lease' ? 'other' : 'lease', true, fault === 'binding' ? 'other' : 'binding')).rejects.toThrow()
      await expect(helper.execute(c, 'lease')).rejects.toThrow()
    } finally { await helper.kill() }
  })
})
