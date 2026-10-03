import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeComputerController, type NativeControllerOptions, type NativeApprovalContext } from '../computer-control/controller.js'
import { LocalDeviceLease } from '../computer-control/lease.js'
import type { NativeHelper } from '../computer-control/helper-client.js'
import { NATIVE_PROTOCOL, type NativeGrant, type NativeCommand, type NativeCapabilities, type NativeReceipt } from '../computer-control/contracts.js'
const capabilities: NativeCapabilities = { protocol: NATIVE_PROTOCOL, platform: 'darwin', axRead: true, semanticActions: true, windowCapture: false, input: false, accessibilityPermission: 'granted', capturePermission: 'denied', limitations: [] }
const identity = { deploymentId: 'deployment', userId: 'user', workspaceId: 'workspace', deviceId: 'device', sessionId: 'session', conversationId: 'conversation', taskId: 'task' }
const target = { appId: 'fixture', processId: 42, processInstanceId: 'process-launch', windowId: 'window', windowInstanceId: 'window-instance' }
function grant(epoch = 1): NativeGrant { return { protocol: NATIVE_PROTOCOL, identity: { ...identity }, grantId: 'grant', epoch, expiresAt: Date.now() + 60_000, targets: [target], allowControl: true, allowCapture: false, requester: 'Alice', goal: 'Fixture' } }
function command(commandId = 'command', epoch = 1): NativeCommand { return { protocol: NATIVE_PROTOCOL, identity: { ...identity }, grantId: 'grant', epoch, commandId, deadlineAt: Date.now() + 30_000, action: { kind: 'invoke', target, observationId: 'observation', ref: 'ref' } } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function setup(override: Partial<NativeHelper> = {}, approval: NativeControllerOptions['approveAction'] = async () => true, platform: NodeJS.Platform = 'darwin', revalidateExecution: NativeControllerOptions['revalidateExecution'] = async () => true) {
  const helper: NativeHelper = { beginApproval: vi.fn(async () => true), endApproval: vi.fn(async () => true), capabilities: vi.fn(async () => capabilities), listTargets: vi.fn(async () => [target]), start: vi.fn(async () => {}), execute: vi.fn(async (c: NativeCommand): Promise<NativeReceipt> => ({ commandId: c.commandId, outcome: 'executed', code: 'ok' })), kill: vi.fn(async () => {}), ...override }
  const lease = { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) }
  const approveGrant = vi.fn(async () => true)
  const controller = new NativeComputerController({ enabled: true, platform, safetyControlsReady: () => true, helperFactory: () => helper, lease, approveGrant, approveAction: approval, revalidateExecution })
  return { controller, helper, lease, approveGrant }
}
describe('native main broker', () => {
  it('independently enforces the observation ceiling before consent, lease or helper creation', async () => {
    const advertised = { ...capabilities, windowCapture: true, input: true }
    const { helper, lease, approveGrant } = setup({ capabilities: vi.fn(async () => advertised) })
    const helperFactory = vi.fn(() => helper)
    const controller = new NativeComputerController({ enabled: true, observationOnly: true, platform: 'darwin',
      safetyControlsReady: () => true, helperFactory, lease, approveGrant, approveAction: async () => true })
    try {
      for (const [allowControl, allowCapture] of [[true, false], [false, true], [true, true]]) {
        await expect(controller.start({ ...grant(), allowControl, allowCapture })).rejects.toThrow('Observation-only')
      }
      expect(helperFactory).not.toHaveBeenCalled()
      expect(lease.acquire).not.toHaveBeenCalled()
      expect(approveGrant).not.toHaveBeenCalled()
      const masked = { axRead: true, semanticActions: false, windowCapture: false, input: false }
      expect(await controller.capabilities()).toMatchObject(masked)
      expect(controller.status().capabilities).toMatchObject(masked)
      expect(advertised).toMatchObject({ semanticActions: true, windowCapture: true, input: true })
      await controller.start({ ...grant(), allowControl: false })
      expect(helper.start).toHaveBeenCalledWith(expect.objectContaining({ allowControl: false, allowCapture: false }), expect.any(String))
      expect(controller.status().capabilities).toMatchObject(masked)
      await controller.stop()
      await expect(controller.resume(grant(3))).rejects.toThrow('Observation-only')
      expect(helper.start).toHaveBeenCalledOnce()
    } finally { await controller.dispose() }
  })
  it.each(['darwin', 'win32', 'linux'] as const)('%s uses helper capabilities, separate read/control/capture and independent Stop', async platform => {
    const caps = { ...capabilities, platform, semanticActions: false, input: false, windowCapture: false }
    const { controller, helper } = setup({ capabilities: vi.fn(async () => caps) }, async () => true, platform)
    expect((await controller.capabilities()).semanticActions).toBe(false)
    await controller.start({ ...grant(), allowControl: false })
    expect((await controller.execute(command())).code).toBe('denied')
    expect((await controller.execute({ ...command('read'), action: { kind: 'observe', target } })).code).toBe('denied')
    controller.lockOrSleep(); expect(helper.kill).toHaveBeenCalledOnce(); await controller.dispose()
    for (const patch of [{ axRead: false }, { semanticActions: false }, { windowCapture: false }]) {
      const next = setup({ capabilities: vi.fn(async () => ({ ...capabilities, platform, ...patch })) }, async () => true, platform)
      await expect(next.controller.start({ ...grant(), allowCapture: 'windowCapture' in patch })).rejects.toThrow()
      expect(next.helper.start).not.toHaveBeenCalled(); await next.controller.dispose()
    }
  })
  it('rejects a helper reporting the wrong platform', async () => {
    const { controller, helper } = setup({}, async () => true, 'linux')
    await expect(controller.start(grant())).rejects.toThrow('platform mismatch')
    expect(helper.start).not.toHaveBeenCalled(); await controller.dispose()
  })
  it('requires fresh local consent and an exact identity/window-instance grant', async () => {
    const { controller, helper, approveGrant } = setup()
    expect((await controller.execute(command())).code).toBe('stopped')
    await controller.start(grant()); expect(approveGrant).toHaveBeenCalledOnce()
    for (const field of Object.keys(identity)) {
      const c = command(); (c.identity as Record<string, string>)[field] = 'other'
      expect((await controller.execute(c)).code).toBe('denied')

    }
    const c = command(); c.action = { ...c.action, target: { ...target, windowInstanceId: 'reused-window' } }
    expect((await controller.execute(c)).code).toBe('wrong_target')
    expect(helper.execute).not.toHaveBeenCalled(); await controller.dispose()
  })
  it('requires approval for EVERY side effect and does not trust effect labels', async () => {
    const approval = vi.fn(async () => false)
    const { controller, helper } = setup({}, approval)
    await controller.start(grant())
    expect((await controller.execute(command())).code).toBe('approval_required')
    expect(approval).toHaveBeenCalledOnce(); expect(helper.execute).not.toHaveBeenCalled()
    await controller.dispose()
  })
  it('passes only frozen scoped helper context, without extra reads, and clears it on resume', async () => {
    const contexts: (NativeApprovalContext | undefined)[] = []
    const bounds = { x: 0, y: 0, width: 200, height: 100 }
    const observation = { identity, epoch: 1, id: 'observation', capturedAt: Date.now(), monotonicMs: 1,
      target, foreground: true, bounds, displayLayoutVersion: 'layout', completeness: 'complete' as const,
      nodes: [{ ref: 'ref', parentRef: 'parent', role: 'button', name: 'Save', value: 'secret', bounds,
        enabled: true, focused: false, selected: false, sensitive: false, actions: ['invoke' as const] }] }
    const { controller, helper } = setup({ execute: vi.fn(async (c: NativeCommand): Promise<NativeReceipt> => ({ commandId: c.commandId, outcome: 'executed', code: 'ok', observation })) },
      async (_c, _signal, context) => { contexts.push(context); return false })
    await controller.start(grant())
    await controller.execute({ ...command('read'), action: { kind: 'observe', target } })
    observation.nodes[0].name = 'mutated after receipt'
    await controller.execute(command())
    const context = contexts[0]!
    expect(context).toMatchObject({ commandId: 'command', grantId: 'grant', observationId: 'observation', identity, target,
      nodes: [{ ref: 'ref', parentRef: 'parent', role: 'button', name: 'Save', bounds }] })
    expect(Object.keys(context.nodes[0]).sort()).toEqual(['bounds', 'name', 'parentRef', 'ref', 'role'])
    expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.nodes)).toBe(true)
    expect(Object.isFrozen(context.nodes[0].bounds)).toBe(true); expect(Object.isFrozen(context.identity)).toBe(true)
    await controller.execute({ ...command('wrong-observation'), action: { ...command().action, observationId: 'other' } } as NativeCommand)
    expect(contexts[1]).toBeUndefined()
    expect(helper.execute).toHaveBeenCalledOnce()
    await controller.stop(); await controller.resume(grant(3))
    await controller.execute(command('resumed', 3)); expect(contexts[2]).toBeUndefined()
    await controller.dispose()
  })
  it('requires a positive initial grant epoch', async () => {
    const { controller, helper } = setup()
    await expect(controller.start(grant(0))).rejects.toThrow()
    expect(helper.start).not.toHaveBeenCalled(); await controller.dispose()
  })
  it('binds both sides of the local approval bracket to the exact immutable command', async () => {
    const approval = vi.fn(async () => true)
    const { controller, helper } = setup({}, approval)
    await controller.start(grant())
    const c = { ...command(), action: { kind: 'setValue' as const, target, observationId: 'observation', ref: 'ref', text: 'exact payload' } }
    expect((await controller.execute(c)).outcome).toBe('executed')
    const approved = approval.mock.calls as unknown as [NativeCommand, AbortSignal][]
    expect(Object.isFrozen(approved[0][0].action)).toBe(true)
    expect(helper.beginApproval).toHaveBeenCalledWith(c, expect.any(String))
    expect(helper.endApproval).toHaveBeenCalledWith(c, expect.any(String), true)
    expect(helper.execute).toHaveBeenCalledWith(c, expect.any(String))
    await controller.dispose()
  })
  it('does not prompt or dispatch when the native proposal is already stale', async () => {
    const approval = vi.fn(async () => true)
    const { controller, helper } = setup({ beginApproval: vi.fn(async () => false) }, approval)
    await controller.start(grant())
    expect((await controller.execute(command())).code).toBe('stale_observation')
    expect(approval).not.toHaveBeenCalled(); expect(helper.execute).not.toHaveBeenCalled()
    await controller.dispose()
  })
  it('stops rather than rebinds or replays when dialog return changes target semantics/geometry', async () => {
    const { controller, helper } = setup({ endApproval: vi.fn(async () => false) })
    await controller.start(grant()); const c = command()
    expect((await controller.execute(c)).code).toBe('stale_observation')
    expect(controller.status().state).toBe('stopped')
    expect((await controller.execute(c)).outcome).toBe('not_executed')
    expect(helper.execute).not.toHaveBeenCalled(); await controller.dispose()
  })
  it('does not dispatch after takeover during native post-dialog revalidation', async () => {
    const end = deferred<boolean>()
    const { controller, helper } = setup({ endApproval: vi.fn(() => end.promise) })
    await controller.start(grant()); const pending = controller.execute(command())
    await vi.waitFor(() => expect(helper.endApproval).toHaveBeenCalledOnce())
    controller.userTakeover(); end.resolve(true)
    expect((await pending).outcome).toBe('not_executed')
    expect(helper.execute).not.toHaveBeenCalled(); await controller.dispose()
  })
  it('requires BOTH control and capture consent for a vision click even with input capability', async () => {
    for (const allowed of [{ allowControl: true, allowCapture: false }, { allowControl: false, allowCapture: true }]) {
      const { controller, helper } = setup({ capabilities: vi.fn(async () => ({ ...capabilities, windowCapture: true, input: true })) })
      await controller.start({ ...grant(), ...allowed })
      const c: NativeCommand = { ...command(), action: { kind: 'click', target, observationId: 'obs', frameId: 'frame', x: 10, y: 20 } }
      expect((await controller.execute(c)).code).toBe('denied')
      expect(helper.beginApproval).not.toHaveBeenCalled(); expect(helper.execute).not.toHaveBeenCalled()
      await controller.dispose()
    }
  })
  it('locally approves exact frame and coordinates and refuses duplicate coordinate substitution', async () => {
    const approval = vi.fn(async () => true)
    const { controller, helper } = setup({ capabilities: vi.fn(async () => ({ ...capabilities, windowCapture: true, input: true })) }, approval)
    await controller.start({ ...grant(), allowCapture: true })
    const c: NativeCommand = { ...command(), action: { kind: 'click', target, observationId: 'obs', frameId: 'frame', x: 10, y: 20 } }
    expect((await controller.execute(c)).outcome).toBe('executed')
    expect(approval).toHaveBeenCalledWith(c, expect.any(AbortSignal), undefined)
    expect((await controller.execute({ ...c, action: { ...c.action, x: 11 } } as NativeCommand)).code).toBe('denied')
    expect(helper.execute).toHaveBeenCalledOnce(); await controller.dispose()
  })
  it('deduplicates serial dispatch and denies reuse with changed payload', async () => {
    const pending = deferred<NativeReceipt>()
    const { controller, helper } = setup({ execute: vi.fn(() => pending.promise) })
    await controller.start(grant())
    const c = command(); const first = controller.execute(c); const duplicate = controller.execute(c)
    await vi.waitFor(() => expect(helper.execute).toHaveBeenCalledOnce())
    expect((await controller.execute({ ...c, action: { ...c.action, observationId: 'changed' } } as NativeCommand)).code).toBe('denied')
    pending.resolve({ commandId: c.commandId, outcome: 'executed', code: 'ok' })
    expect(await first).toEqual(await duplicate); expect(helper.execute).toHaveBeenCalledOnce()
    await controller.dispose()
  })
  it('kills immediately while AX is blocked; queued work is cancelled; stop is latched', async () => {
    const blocked = deferred<NativeReceipt>()
    const { controller, helper } = setup({ execute: vi.fn(() => blocked.promise) })
    await controller.start(grant())
    const first = controller.execute(command()); const queued = controller.execute(command('queued'))
    await vi.waitFor(() => expect(helper.execute).toHaveBeenCalledOnce())
    const stopped = controller.stop()
    expect(helper.kill).toHaveBeenCalledOnce(); expect(controller.status().state).toBe('stopped')
    expect((await first).outcome).toBe('execution_unknown'); expect((await queued).outcome).toBe('not_executed')
    await stopped; expect(helper.execute).toHaveBeenCalledOnce()
    await expect(controller.start(grant(3))).rejects.toThrow()
    expect((await controller.execute(command('retry'))).code).toBe('stopped')
    await controller.dispose()
  })
  it('does not dispatch after stop during approval; only local resume with new epoch works', async () => {
    const approval = deferred<boolean>()
    const { controller, helper } = setup({}, () => approval.promise)
    await controller.start(grant()); const pending = controller.execute(command())
    await vi.waitFor(() => expect(controller.status().state).toBe('awaiting_action_approval'))
    await controller.stop(); approval.resolve(true)
    expect((await pending).outcome).toBe('not_executed'); expect(helper.execute).not.toHaveBeenCalled()
    await expect(controller.resume(grant(1))).rejects.toThrow()
    await controller.resume(grant(3)); expect(controller.status().epoch).toBe(3)
    expect((await controller.execute(command())).code).toBe('denied'); await controller.dispose()
  })
  it('latches unknown outcomes and cross-scope helper receipts without replay', async () => {
    const { controller, helper } = setup({ execute: vi.fn(async (c: NativeCommand): Promise<NativeReceipt> => ({ commandId: 'foreign', outcome: 'executed', code: 'ok' })) })
    await controller.start(grant())
    expect((await controller.execute(command())).outcome).toBe('execution_unknown')
    expect(controller.status().state).toBe('stopped'); expect(helper.execute).toHaveBeenCalledOnce()
    await controller.dispose()
  })
  it('revokes on takeover, lock, identity and relay loss', async () => {
    for (const hook of ['userTakeover', 'lockOrSleep', 'identityChanged', 'relayDisconnected'] as const) {
      const { controller, helper } = setup(); await controller.start(grant()); controller[hook]()
      expect(helper.kill).toHaveBeenCalledOnce(); expect((await controller.execute(command())).code).toBe('stopped'); await controller.dispose()
    }
  })
  it('fails closed on unsupported platforms, disabled or missing safety hooks', async () => {
    const helperFactory = vi.fn()
    for (const opts of [{ platform: 'freebsd' as const, enabled: true, safetyControlsReady: () => true }, { platform: 'darwin' as const, enabled: false, safetyControlsReady: () => true }, { platform: 'darwin' as const, enabled: true, safetyControlsReady: () => false }]) {
      const c = new NativeComputerController({ ...opts, helperFactory, lease: { acquire: async () => {}, release: async () => {} }, approveGrant: async () => true, approveAction: async () => true })
      expect((await c.capabilities()).axRead).toBe(false); await expect(c.start(grant())).rejects.toThrow(); await c.dispose()
    }
    expect(helperFactory).not.toHaveBeenCalled()
  })
  it('unknown execution is journaled and cannot be blindly retried even after Stop', async () => {
    const { controller, helper } = setup({ execute: vi.fn(async (c: NativeCommand): Promise<NativeReceipt> => ({ commandId: c.commandId, outcome: 'execution_unknown', code: 'helper_error' })) })
    await controller.start(grant()); const c = command()
    const first = await controller.execute(c)
    expect(first.outcome).toBe('execution_unknown'); expect(controller.status().state).toBe('stopped')
    expect(await controller.execute(c)).toEqual(first); expect(helper.execute).toHaveBeenCalledOnce()
    expect((await controller.execute({ ...c, identity: { ...identity, userId: 'foreign' } })).outcome).toBe('not_executed')
    await controller.dispose()
  })
  it('holds the physical lease until the helper has actually exited', async () => {
    const exit = deferred<void>()
    const { controller, lease } = setup({ kill: vi.fn(() => exit.promise) })
    await controller.start(grant()); const stopping = controller.stop()
    expect(controller.status().state).toBe('stopped'); expect(lease.release).not.toHaveBeenCalled()
    exit.resolve(); await stopping; expect(lease.release).toHaveBeenCalledOnce()
  })
  it('will not grant control or capture absent real OS capabilities', async () => {
    const { controller, helper } = setup({ capabilities: vi.fn(async () => ({ ...capabilities, accessibilityPermission: 'denied' as const, axRead: false })) })
    await expect(controller.start(grant())).rejects.toThrow('Permissions')
    expect(helper.start).not.toHaveBeenCalled(); await controller.dispose()
    const next = setup()
    await expect(next.controller.start({ ...grant(), allowCapture: true })).rejects.toThrow('Permissions')
    expect(next.helper.start).not.toHaveBeenCalled(); await next.controller.dispose()
  })
  it('rejects expired deadlines and read-only side effects before approval/dispatch', async () => {
    const approval = vi.fn(async () => true)
    const { controller, helper } = setup({}, approval)
    await controller.start({ ...grant(), allowControl: false })
    expect((await controller.execute(command())).code).toBe('denied')
    expect((await controller.execute({ ...command(), deadlineAt: Date.now() - 1 })).code).toBe('denied')
    expect(approval).not.toHaveBeenCalled(); expect(helper.execute).not.toHaveBeenCalled()
    await controller.dispose()
  })
  it('does not release another instance lease when acquisition fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-computer-'))
    const a = new LocalDeviceLease(root); const b = new LocalDeviceLease(root)
    try {
      await a.acquire()
      const helperFactory = vi.fn()
      const c = new NativeComputerController({ enabled: true, platform: 'darwin', safetyControlsReady: () => true, helperFactory, lease: b, approveGrant: async () => true, approveAction: async () => true })
      await expect(c.start(grant())).rejects.toThrow()
      await expect(b.acquire()).rejects.toThrow(); expect(helperFactory).not.toHaveBeenCalled()
      await c.dispose(); await a.release()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('a physical device lease cannot be stolen across instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-computer-'))
    try {
      const a = new LocalDeviceLease(root); const b = new LocalDeviceLease(root)
      await a.acquire(); await expect(b.acquire()).rejects.toThrow(); await b.release()
      await expect(b.acquire()).rejects.toThrow(); await a.release(); await b.acquire(); await b.release()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('local selected-window inspector', () => {
  function observation() { return { identity, epoch: 1, id: 'local-read', capturedAt: Date.now(), monotonicMs: 1,
    target, foreground: true, bounds: { x: 0, y: 0, width: 100, height: 100 }, displayLayoutVersion: 'layout', completeness: 'partial' as const,
    nodes: [{ ref: 'secure', role: 'textbox', name: '', enabled: true, focused: false, selected: false, sensitive: true, actions: [] }] } }
  it('creates exactly one authorized observe and projects only bounded redacted AX data', async () => {
    const { controller, helper } = setup({ execute: vi.fn(async (c: NativeCommand): Promise<NativeReceipt> => ({ commandId: c.commandId, outcome: 'executed', code: 'ok', observation: observation() })) })
    await controller.start({ ...grant(), allowControl: false })
    const result = await controller.inspectSelected()
    expect(helper.execute).toHaveBeenCalledOnce()
    expect(vi.mocked(helper.execute).mock.calls[0][0]).toMatchObject({ identity, epoch: 1, grantId: 'grant', action: { kind: 'observe', target } })
    expect(result).toEqual({ id: 'local-read', capturedAt: expect.any(Number), completeness: 'partial', nodes: [{ ref: 'secure', role: 'textbox', name: '', enabled: true, sensitive: true }] })
    await controller.dispose()
  })
  it('relay cannot observe concurrently, replay the private read, or race helper death and lease release', async () => {
    const read = deferred<NativeReceipt>(); const death = deferred<void>(); let sent!: NativeCommand
    const { controller, helper, lease } = setup({ execute: vi.fn(c => { sent = c; return read.promise }), kill: vi.fn(() => death.promise) })
    await controller.start({ ...grant(), allowControl: false })
    const remote = { ...command('remote-read'), action: { kind: 'observe' as const, target } }
    expect(await controller.execute(remote)).toEqual({ commandId: 'remote-read', code: 'denied', outcome: 'not_executed' })
    const local = controller.inspectSelected()
    await vi.waitFor(() => expect(sent).toBeDefined())
    await expect(controller.inspectSelected()).rejects.toThrow()
    expect((await controller.execute(sent)).code).toBe('denied')
    expect((await controller.execute(remote)).code).toBe('denied')
    read.resolve({ commandId: sent.commandId, outcome: 'executed', code: 'ok', observation: observation() })
    expect((await local).id).toBe('local-read')
    const shutdown = controller.stop()
    expect(helper.kill).toHaveBeenCalledOnce(); expect(lease.release).not.toHaveBeenCalled()
    expect(await controller.execute(sent)).not.toHaveProperty('observation')
    expect(helper.execute).toHaveBeenCalledOnce()
    death.resolve(); await shutdown
    expect(lease.release).toHaveBeenCalledOnce()
  })
  it('denies inspector during a control session and before consent', async () => {
    const { controller, helper } = setup()
    await expect(controller.inspectSelected()).rejects.toThrow()
    await controller.start(grant())
    await expect(controller.inspectSelected()).rejects.toThrow('Read-only')
    expect(helper.execute).not.toHaveBeenCalled(); await controller.dispose()
  })
  it.each(['stop', 'takeover', 'identity', 'wrong-target', 'secure-leak'])('fails closed for %s during inspection', async reason => {
    const read = deferred<NativeReceipt>(); let sent!: NativeCommand
    const { controller } = setup({ execute: vi.fn(c => { sent = c; return read.promise }) })
    await controller.start({ ...grant(), allowControl: false })
    const result = controller.inspectSelected(); const rejected = expect(result).rejects.toThrow()
    await vi.waitFor(() => expect(sent).toBeDefined())
    if (reason === 'stop') void controller.stop()
    if (reason === 'takeover') controller.userTakeover()
    if (reason === 'identity') controller.identityChanged()
    const data = observation()
    if (reason === 'wrong-target') data.target = { ...target, windowInstanceId: 'other' }
    if (reason === 'secure-leak') data.nodes[0].name = 'password'
    read.resolve({ commandId: sent.commandId, code: 'ok', outcome: 'executed', observation: data })
    await rejected; await controller.dispose()
  })
})

it('validates optional local discovery metadata independently of strict grant authority', async () => {
  const discovered = [{ ...target, displayName: 'First document' }, { ...target, windowId: 'other', windowInstanceId: 'other-instance', displayName: 'Second document' }, target]
  const { controller, helper } = setup({ listTargets: vi.fn(async () => discovered) })
  expect(await controller.listTargets()).toEqual(discovered)
  await expect(controller.start({ ...grant(), targets: [discovered[0]] })).rejects.toThrow()
  expect(helper.start).not.toHaveBeenCalled()
  const baseGrant = grant()
  await controller.start(baseGrant)
  expect(helper.start).toHaveBeenCalledWith(baseGrant, expect.any(String))
  await controller.dispose()
})

it('rejects overlong helper labels rather than allowing extra discovery authority', async () => {
  const { controller, helper } = setup({ listTargets: vi.fn(async () => [{ ...target, displayName: '😀'.repeat(129) }]) })
  expect(await controller.listTargets()).toEqual([])
  expect(helper.kill).toHaveBeenCalledOnce()
})

it('identity invalidation forgets private grant data but preserves the unknown fence and pending death barrier', async () => {
  const death = deferred<void>()
  const { controller, helper, lease } = setup({
    kill: vi.fn(() => death.promise),
    execute: vi.fn(async (c: NativeCommand): Promise<NativeReceipt> => ({ commandId: c.commandId, outcome: 'execution_unknown', code: 'helper_error' })),
  })
  await controller.start({ ...grant(), goal: 'private old-account goal' })
  const c = command()
  const unknown = await controller.execute(c)
  const epoch = controller.status().epoch
  const invalidated = controller.identityChanged()
  expect(controller.status()).toMatchObject({ state: 'stopped', epoch })
  expect(controller.status()).not.toHaveProperty('identity')
  expect(controller.status()).not.toHaveProperty('expiresAt')
  expect((controller as unknown as { grant?: NativeGrant }).grant).toBeUndefined()
  expect(await controller.execute(c)).toEqual(unknown)
  await expect(controller.start(grant(epoch + 1))).rejects.toThrow('Local Resume required')
  expect(helper.start).toHaveBeenCalledOnce()
  expect(helper.kill).toHaveBeenCalledOnce()
  expect(lease.release).not.toHaveBeenCalled()
  expect(controller.identityChanged()).toBe(invalidated)
  death.resolve(); await invalidated
  expect(lease.release).toHaveBeenCalledOnce()
  expect(controller.status().epoch).toBe(epoch)
})

it('invalidation during helper start never restores identity or releases the lease before confirmed death', async () => {
  const starting = deferred<void>(), death = deferred<void>()
  const { controller, helper, lease } = setup({ start: vi.fn(() => starting.promise), kill: vi.fn(() => death.promise) })
  const run = controller.start({ ...grant(), goal: 'private pending goal' })
  const rejected = expect(run).rejects.toThrow('Stopped')
  await vi.waitFor(() => expect(helper.start).toHaveBeenCalledOnce())
  const shutdown = controller.identityChanged()
  const epoch = controller.status().epoch
  starting.resolve()
  await Promise.resolve(); await Promise.resolve()
  expect(lease.release).not.toHaveBeenCalled()
  expect(controller.status()).not.toHaveProperty('identity')
  death.resolve(); await shutdown; await rejected
  expect(controller.status()).toMatchObject({ state: 'stopped', epoch })
  expect(controller.status()).not.toHaveProperty('identity')
  expect((controller as unknown as { grant?: NativeGrant }).grant).toBeUndefined()
  expect(helper.start).toHaveBeenCalledOnce()
})

it.each(['revoked', 'missing', 'stop', 'timeout'] as const)('execution authority %s never restores focus or dispatches after approval', async mode => {
  const approval = deferred<boolean>(); const check = deferred<boolean>()
  const verify = vi.fn(() => mode === 'revoked' ? Promise.resolve(false) : check.promise)
  const { controller, helper } = setup({}, () => approval.promise, 'darwin', mode === 'missing' ? undefined : verify)
  // setup defaults deliberately fake authority; explicitly remove it for this case.
  if (mode === 'missing') (controller as any).options.revalidateExecution = undefined
  await controller.start(grant())
  const c = command(); if (mode === 'timeout') c.deadlineAt = Date.now() + 300
  const result = controller.execute(c)
  await vi.waitFor(() => expect(helper.beginApproval).toHaveBeenCalledOnce())
  expect(verify).not.toHaveBeenCalled(); approval.resolve(true)
  if (mode === 'stop' || mode === 'timeout') await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce())
  if (mode === 'stop') await controller.stop()
  expect((await result).outcome).toBe('not_executed')
  check.resolve(true)
  await Promise.resolve()
  expect(helper.endApproval).not.toHaveBeenCalled(); expect(helper.execute).not.toHaveBeenCalled()
  await controller.dispose()
})
it('remote reads check authority but the fixed local inspector does not', async () => {
  const verify = vi.fn(async () => false)
  const { controller, helper } = setup({}, async () => true, 'darwin', verify)
  await controller.start(grant())
  expect((await controller.execute({...command(), action:{kind:'observe',target}})).outcome).toBe('not_executed')
  expect(verify).toHaveBeenCalledOnce(); expect(helper.execute).not.toHaveBeenCalled()
  await controller.dispose()
})
it('authorized execution checks after approval and before focus restoration; stale checks cannot stop a new grant',async()=>{
 const check=deferred<boolean>(); const order:string[]=[]
 const verify=vi.fn(async()=>{order.push('verify');return check.promise})
 const {controller,helper}=setup({endApproval:vi.fn(async()=>{order.push('restore');return true}),execute:vi.fn(async (c: NativeCommand): Promise<NativeReceipt>=>{order.push('effect');return {commandId:c.commandId,code:'ok',outcome:'executed'}})},async()=>{order.push('approval');return true},'darwin',verify)
 await controller.start(grant())
 const result=controller.execute(command())
 await vi.waitFor(()=>expect(verify).toHaveBeenCalledOnce())
 expect(order).toEqual(['approval','verify'])
 check.resolve(true); expect((await result).code).toBe('ok')
 expect(order).toEqual(['approval','verify','restore','verify','effect'])
 const stale=deferred<boolean>(); verify.mockImplementationOnce(()=>stale.promise)
 const old=controller.execute(command('old'))
 await vi.waitFor(()=>expect(verify).toHaveBeenCalledTimes(3))
 await controller.stop(); expect((await old).outcome).toBe('not_executed')
 await controller.resume(grant(3)); stale.resolve(false); await Promise.resolve(); await Promise.resolve()
 expect(controller.status().state).toBe('active'); expect(helper.execute).toHaveBeenCalledOnce()
 await controller.dispose()
})

it('revocation while endApproval is pending prevents input after focus validation', async () => {
  const end = deferred<boolean>(); let allowed = true
  const verify = vi.fn(async () => allowed)
  const { controller, helper } = setup({ endApproval: vi.fn(() => end.promise) }, async () => true, 'darwin', verify)
  await controller.start(grant())
  const result = controller.execute(command())
  await vi.waitFor(() => expect(helper.endApproval).toHaveBeenCalledOnce())
  expect(verify).toHaveBeenCalledOnce(); allowed = false; end.resolve(true)
  expect((await result).outcome).toBe('not_executed')
  expect(verify).toHaveBeenCalledTimes(2); expect(helper.execute).not.toHaveBeenCalled()
  await controller.dispose()
})
it('declining approval makes no authority requests', async () => {
  const verify = vi.fn(async () => true)
  const { controller, helper } = setup({}, async () => false, 'darwin', verify)
  await controller.start(grant())
  expect((await controller.execute(command())).code).toBe('approval_required')
  expect(verify).not.toHaveBeenCalled(); expect(helper.execute).not.toHaveBeenCalled()
  await controller.dispose()
})
