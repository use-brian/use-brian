// Transport/bookkeeping only, NOT native acceptance. Written, not executed.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough, Writable } from 'node:stream'
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
import { ClickGuardianClient, type GuardianHandoff, type NativeClickScope } from '../computer-control/click-guardian-client.js'
import { MAX_MESSAGE_BYTES } from '../computer-control/contracts.js'
const pack = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4); head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}
function nativeScope(): NativeClickScope {
  const identity = { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'dev', sessionId: 's', conversationId: 'c', taskId: 't' }
  const target = { appId: 'com.usebrian.NativeComputerFixture', processId: 120, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
  const generation = { pid: 120, birth: '10', executable: '/package/fixture' }
  return { version: 1, command: { protocol: 'native-computer-v1', commandId: 'command', grantId: 'grant', identity, epoch: 1,
    deadlineAt: Date.now() + 10000, action: { kind: 'click', target, observationId: 'o', frameId: 'f', x: 1, y: 2 } },
    worker: { ...generation, pid: 200, executable: '/package/helper' }, process: generation, windowNumber: 32,
    bounds: { x: 0, y: 0, width: 100, height: 100 }, width: 100, height: 100, pngDigest: 'a'.repeat(64),
    fingerprint: 'b'.repeat(64), displayLayout: 'c'.repeat(64), frameTime: 10, observationTime: 9,
    grantDeadline: 1000, commandDeadline: 500, privacy: 'publicCompleteSafeCanvas' }
}
function fixture(bind: (id: string, descriptor: NativeClickScope) => GuardianHandoff | undefined = vi.fn((id: string, descriptor: NativeClickScope): GuardianHandoff | undefined => ({
  requestId: id, command: descriptor.command, grant: {} as GuardianHandoff['grant'], leaseId: 'lease', descriptor,
}))) {
  const writes: unknown[] = [], admits: unknown[] = []
  const side = new Duplex({ read() {}, write(chunk: Buffer, _e, cb) { writes.push(JSON.parse(chunk.subarray(4).toString())); cb() } })
  const child = Object.assign(new EventEmitter(), { pid: 300 as number | undefined,
    stdin: new Writable({ write(chunk: Buffer, _e, cb) { admits.push(JSON.parse(chunk.subarray(4).toString())); cb() } }),
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  mocked.spawn.mockReturnValue(child)
  const loss = vi.fn()
  let current = true
  const client = new ClickGuardianClient('/package/helper', 200, side, bind, loss, id => current && id === 'r')
  const setCurrent = (value: boolean) => { current = value }
  const ready = () => child.stdout.write(pack({ kind: 'ready', state: 'unconstructed' }))
  const scope = nativeScope()
  const handoff = (id = 'r', bootstrap = true) => {
    side.emit('data', pack({ kind: 'handoff', requestId: id, descriptor: scope }))
    if (bootstrap && mocked.spawn.mock.calls.length) ready()
  }
  const terminal = (extra = {}) => child.stdout.write(pack({ kind: 'terminal', id: 'r', status: 'refused', cleanup: 'neverArmedNoEmission', reason: 'platformUnaccepted', ...extra }))
  const die = (code = 0, signal: string | null = null) => { child.emit('exit', code, signal); child.emit('close', code, signal) }
  const transfer = () => {
    child.stdout.write(pack({ kind: 'prepared', id: 'r' }))
    side.emit('data', pack({ kind: 'workerTransferred', requestId: 'r' }))
  }
  const returnOffer = () => child.stdout.write(pack({ kind: 'returnMonitor', id: 'r', cleanup: 'inputStreamReleasedCandidate' }))
  const monitoring = (id = 'r') => side.emit('data', pack({ kind: 'workerMonitoring', requestId: id }))
  return { client, child, side, writes, admits, loss, bind, handoff, ready, terminal, die, scope, setCurrent, transfer, returnOffer, monitoring }
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })
describe('private surviving guardian lifecycle', () => {
  it('does not launch/probe on construction or metadata-only teardown', async () => {
    const f = fixture(); f.client.revoke(); await f.client.waitForSafety()
    expect(mocked.spawn).not.toHaveBeenCalled(); expect(f.bind).not.toHaveBeenCalled()
  })
  it('does not launch without a locally approved pending binding', async () => {
    const f = fixture(vi.fn(() => undefined)); f.handoff()
    expect(f.writes).toEqual([{ kind: 'refused', requestId: 'r' }])
    expect(mocked.spawn).not.toHaveBeenCalled(); f.client.revoke(); await f.client.waitForSafety()
  })
  it('uses the same binary in a closed role outside worker process-group cleanup', () => {
    const f = fixture(); f.handoff()
    expect(mocked.spawn).toHaveBeenCalledWith('/package/helper', ['--click-guardian'], expect.objectContaining({
      stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false, env: { PATH: '/usr/bin:/bin' },
    }))
    expect(f.admits).toEqual([{ kind: 'admit', id: 'r', workerPid: 200, command: f.scope.command, grant: {}, leaseId: 'lease', descriptor: f.scope }])
    f.client.revoke(); expect(f.child.stdin.destroyed).toBe(true); expect(f.child.kill).not.toHaveBeenCalled()
  })
  it('requires no-emission proof AND observed owner death/complete transcript', async () => {
    const f = fixture(); f.handoff(); let safe = false
    void f.client.waitForSafety().then(() => { safe = true })
    f.terminal(); await Promise.resolve(); expect(safe).toBe(false)
    f.child.emit('exit', 0, null); await Promise.resolve(); expect(safe).toBe(false)
    f.child.emit('close', 0, null); await f.client.waitForSafety(); expect(safe).toBe(true)
  })
  it.each([
    { status: 'sequenceAttemptedUnproven', cleanup: 'fencedLeaseRetained' },
    { status: 'refused', cleanup: 'fencedLeaseRetained' },
    { status: 'sequenceAttemptedUnproven', cleanup: 'neverArmedNoEmission' },
    { status: 'executed', cleanup: 'releasedAndDrained' },
    { id: 'wrong' }, { extra: true }, { status: ['refused'] }, { cleanup: ['neverArmedNoEmission'] }, { reason: ['revoked'] }, { status: 'sequenceAttemptedUnproven', cleanup: 'inputStreamReleasedCandidate', reason: 'monitorReturned' },
  ])('retains authority on uncertain or forged terminal %j', async terminal => {
    vi.useFakeTimers(); const f = fixture(); f.handoff(); let safe = false
    void f.client.waitForSafety().then(() => { safe = true })
    f.terminal(terminal); f.die(); await vi.advanceTimersByTimeAsync(100_000)
    expect(safe).toBe(false); expect(f.writes).toEqual([]); expect(f.child.kill).not.toHaveBeenCalled()
  })
  it('retains on owner death/channel loss without receipt; never restarts', async () => {
    const f = fixture(); f.handoff(); let safe = false
    void f.client.waitForSafety().then(() => { safe = true })
    f.side.emit('end'); f.die(); await Promise.resolve()
    expect(safe).toBe(false); expect(f.loss).toHaveBeenCalled(); expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('ignores no trailing data: duplicate proof invalidates before close', async () => {
    const f = fixture(); f.handoff(); let safe = false
    void f.client.waitForSafety().then(() => { safe = true })
    f.terminal(); f.terminal(); f.die(); await Promise.resolve(); expect(safe).toBe(false)
  })
  it('releases bootstrap refusal only after death, without ever sending an admission', async () => {
    const f = fixture(); f.handoff('r', false); expect(f.admits).toEqual([])
    f.die(); await f.client.waitForSafety()
  })
  it('revokes late bootstrap and refuses premature worker completion', async () => {
    const f = fixture(); f.handoff('r', false)
    expect(f.client.acceptsWorkerResponse('r')).toBe(false)
    f.client.revoke(); f.ready(); expect(f.admits).toEqual([]); f.die(); await f.client.waitForSafety()
  })
  it('allows proven spawn failure without inventing cleanup for a running owner', async () => {
    const f = fixture(); f.child.pid = undefined; f.handoff('r', false)
    f.child.emit('error', new Error('spawn failed')); await f.client.waitForSafety()
    expect(f.loss).toHaveBeenCalled()
  })
  it.each([{ kind: 'handoff', requestId: 'r', intent: {} }, { kind: 'execute', requestId: 'r' }, { kind: 'handoff', requestId: '' }])('rejects open/foreign side messages %j', message => {
    const f = fixture(); f.side.emit('data', pack(message)); expect(f.loss).toHaveBeenCalled(); expect(mocked.spawn).not.toHaveBeenCalled()
  })
  it('bounds fragments and rejects oversized lengths before JSON decoding', () => {
    const f = fixture(); const h = Buffer.alloc(4); h.writeUInt32BE(MAX_MESSAGE_BYTES + 1)
    f.side.emit('data', h.subarray(0, 2)); expect(f.loss).not.toHaveBeenCalled()
    f.side.emit('data', h.subarray(2)); expect(f.loss).toHaveBeenCalled(); expect(mocked.spawn).not.toHaveBeenCalled()
  })
})

it('requires reverse monitor acknowledgment, normal owner exit and complete transcript before delivered', async () => {
  const f = fixture(); f.handoff(); f.transfer(); f.returnOffer()
  expect(f.writes.at(-1)).toEqual({ kind: 'returnMonitor', requestId: 'r' })
  expect(f.client.acceptsExecutedClick('r', f.scope.command.commandId)).toBe(false)
  f.monitoring()
  expect(f.admits.at(-1)).toEqual({ kind: 'workerMonitoring', id: 'r' })
  f.terminal({ status: 'sequenceAttemptedUnproven', cleanup: 'inputStreamReleasedCandidate', reason: 'monitorReturned' })
  expect(f.writes.some(value => (value as { kind: string }).kind === 'delivered')).toBe(false)
  expect(f.client.acceptsWorkerResponse('r')).toBe(false)
  f.child.emit('exit', 0, null)
  expect(f.client.acceptsExecutedClick('r', f.scope.command.commandId)).toBe(false)
  f.child.emit('close', 0, null)
  expect(f.writes.at(-1)).toEqual({ kind: 'delivered', requestId: 'r' })
  expect(f.client.acceptsExecutedClick('r', f.scope.command.commandId)).toBe(true)
  expect(f.client.acceptsExecutedClick('r', 'stale-command')).toBe(false)
  await f.client.waitForSafety()
})

it.each(['no-offer', 'stale-id', 'duplicate', 'stale-execute', 'loss', 'bad-exit', 'late-message'] as const)(
  'return handshake %s never exposes delivery and retains fence', async failure => {
    const f = fixture(); f.handoff(); f.transfer()
    if (failure !== 'no-offer') f.returnOffer()
    if (failure === 'stale-execute') f.setCurrent(false)
    if (failure === 'loss') f.side.emit('end')
    f.monitoring(failure === 'stale-id' ? 'old-request' : 'r')
    if (failure === 'duplicate') f.monitoring()
    f.terminal({ status: 'sequenceAttemptedUnproven', cleanup: 'inputStreamReleasedCandidate', reason: 'monitorReturned' })
    if (failure === 'late-message') f.child.stdout.write(pack({ kind: 'prepared', id: 'r' }))
    let safe = false; void f.client.waitForSafety().then(() => { safe = true })
    f.die(failure === 'bad-exit' ? 1 : 0); await Promise.resolve()
    expect(f.writes.some(value => (value as { kind: string }).kind === 'delivered')).toBe(false)
    expect(f.client.acceptsExecutedClick('r', f.scope.command.commandId)).toBe(false)
    expect(safe).toBe(false)
  })
it('handles buffered terminal after owner exit without exposing before close', async () => {
  const f = fixture(); f.handoff(); f.transfer(); f.returnOffer(); f.monitoring()
  f.child.emit('exit', 0, null)
  f.terminal({ status: 'sequenceAttemptedUnproven', cleanup: 'inputStreamReleasedCandidate', reason: 'monitorReturned' })
  expect(f.client.acceptsExecutedClick('r', f.scope.command.commandId)).toBe(false)
  f.child.emit('close', 0, null)
  expect(f.client.acceptsExecutedClick('r', f.scope.command.commandId)).toBe(true)
  await f.client.waitForSafety()
})
it('refuses transfer before a prepared owner and malformed native descriptors', () => {
  for (const message of [
    { kind: 'workerTransferred', requestId: 'r' },
    { kind: 'handoff', requestId: 'r', descriptor: { ...nativeScope(), nativeValidated: true } },
    { kind: 'handoff', requestId: 'r', descriptor: { ...nativeScope(), worker: { ...nativeScope().worker, pid: 999 } } },
  ]) {
    const f = fixture(); f.side.emit('data', pack(message)); expect(f.loss).toHaveBeenCalled()
  }
})

it('handles coalesced owner-prepared/refusal without treating a pipe chunk as a frame', async () => {
  const f = fixture(); f.handoff()
  f.child.stdout.write(Buffer.concat([
    pack({ kind: 'prepared', id: 'r' }),
    pack({ kind: 'terminal', id: 'r', status: 'refused', cleanup: 'neverArmedNoEmission', reason: 'scopeRejected' }),
  ]))
  expect(f.writes).toEqual([{ kind: 'ownerPrepared', requestId: 'r' }, { kind: 'refused', requestId: 'r' }])
  f.die(); await f.client.waitForSafety()
})

it.each(['exit', 'stop'] as const)('drains coalesced prepared/refusal after %s without forwarding preparation', async stale => {
  const f = fixture(); f.handoff()
  let safe = false
  void f.client.waitForSafety().then(() => { safe = true })
  if (stale === 'exit') f.child.emit('exit', 0, null)
  else f.client.revoke()
  f.child.stdout.write(Buffer.concat([
    pack({ kind: 'prepared', id: 'r' }),
    pack({ kind: 'terminal', id: 'r', status: 'refused', cleanup: 'neverArmedNoEmission', reason: 'scopeRejected' }),
  ]))
  await Promise.resolve()
  expect(safe).toBe(false)
  expect(f.loss).not.toHaveBeenCalled()
  // A live worker can receive refusal after owner exit, but never a transfer offer.
  expect(f.writes).toEqual(stale === 'exit' ? [{ kind: 'refused', requestId: 'r' }] : [])
  expect(f.admits).toHaveLength(1)
  expect(f.client.acceptsExecutedClick('r', f.scope.command.commandId)).toBe(false)
  if (stale === 'stop') {
    f.child.emit('exit', 0, null)
    await Promise.resolve(); expect(safe).toBe(false)
  }
  f.child.emit('close', 0, null)
  await f.client.waitForSafety(); expect(safe).toBe(true)
})

it.each(['exit', 'stop'] as const)('still poisons invalid buffered transcripts after %s', async stale => {
  const prepared = { kind: 'prepared', id: 'r' }
  const terminal = { kind: 'terminal', id: 'r', status: 'refused', cleanup: 'neverArmedNoEmission', reason: 'scopeRejected' }
  for (const messages of [
    [prepared, prepared, terminal],
    [{ ...prepared, id: 'foreign' }, terminal],
    [{ ...prepared, extra: true }, terminal],
    [terminal, prepared],
    [prepared, terminal, terminal],
    [prepared, { ...terminal, cleanup: 'unknown' }],
    [prepared, { kind: 'unknown' }, terminal],
  ]) {
    const f = fixture(); f.handoff()
    let safe = false
    void f.client.waitForSafety().then(() => { safe = true })
    if (stale === 'exit') f.child.emit('exit', 0, null)
    else f.client.revoke()
    f.child.stdout.write(Buffer.concat(messages.map(pack)))
    if (stale === 'stop') f.child.emit('exit', 0, null)
    f.child.emit('close', 0, null)
    await Promise.resolve()
    expect(safe).toBe(false)
    expect(f.loss).toHaveBeenCalled()
    expect(f.writes).not.toContainEqual({ kind: 'ownerPrepared', requestId: 'r' })
    expect(f.client.acceptsExecutedClick('r', f.scope.command.commandId)).toBe(false)
  }
})
