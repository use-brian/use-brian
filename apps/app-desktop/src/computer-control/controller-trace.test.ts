import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { NativeComputerController, type NativeControllerOptions } from './controller.js'
import type { NativeHelper } from './helper-client.js'
import type { NativeGrant, NativeCommand, NativeReceipt, NativeCapabilities } from './contracts.js'
import type { NativeBrokerTraceEvent, NativeBrokerObserverFactory } from './trace.js'
const flush = async () => { for (let i = 0; i < 120; i++) await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function grant(epoch = 1): NativeGrant {
  return { protocol: 'native-computer-v1', identity: { sessionId: randomUUID(), userId: 'private-user', workspaceId: 'private-workspace', deploymentId: 'private-deployment', deviceId: 'private-device', conversationId: 'private-conversation', taskId: 'private-task' },
    epoch, grantId: 'private-grant', expiresAt: Date.now() + 60_000, targets: [{ appId: 'private-app', processId: 42, processInstanceId: 'private-process', windowId: 'private-window', windowInstanceId: 'private-instance' }], allowControl: true, allowCapture: false, requester: 'private-name', goal: 'private-goal' }
}
function command(g: NativeGrant): NativeCommand {
  return { protocol: g.protocol, identity: g.identity, grantId: g.grantId, epoch: g.epoch, commandId: randomUUID(), deadlineAt: Date.now() + 30_000,
    action: { kind: 'setValue', target: g.targets[0], ref: 'private-ref', observationId: 'private-observation', text: 'private-text' } }
}
function setup(overrides: Partial<NativeHelper> = {}, options: Partial<NativeControllerOptions> = {}) {
  const events: NativeBrokerTraceEvent[] = []
  const factory = vi.fn<NativeBrokerObserverFactory>(() => event => { events.push(event) })
  const helper: NativeHelper = { capabilities: vi.fn(async (): Promise<NativeCapabilities> => ({ protocol: 'native-computer-v1', platform: 'darwin', axRead: true, semanticActions: true, windowCapture: false, input: false, accessibilityPermission: 'granted', capturePermission: 'denied', limitations: [] })),
    listTargets: vi.fn(async () => []), start: vi.fn(async () => {}), beginApproval: vi.fn(async () => true), endApproval: vi.fn(async () => true),
    execute: vi.fn(async (c: NativeCommand): Promise<NativeReceipt> => ({ commandId: c.commandId, code: 'ok', outcome: 'executed' })), kill: vi.fn(async () => {}), ...overrides }
  const lease = { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) }
  const controller = new NativeComputerController({ enabled: true, platform: 'darwin', safetyControlsReady: () => true, helperFactory: () => helper, lease,
    approveGrant: async () => true, approveAction: async () => true, revalidateExecution: async () => true, observerFactory: factory, ...options })
  return { controller, helper, lease, events, factory }
}
describe('broker source-only timing', () => {
  it('records immutable admission, approval, authority and RPC metadata without any private content', async () => {
    const { controller, events } = setup(); const g = grant(); const c = command(g)
    await controller.start(g); expect((await controller.execute(c)).code).toBe('ok'); await controller.stop(); await flush()
    for (const event of ['command_admission', 'approval_wait', 'authority_check', 'helper_rpc_wait', 'helper_rpc_settlement', 'stop_requested', 'local_gate_revoked', 'helper_lifetime_barrier']) expect(events.some(e => e.event === event)).toBe(true)
    expect(events.some(e => e.event === 'authority_check' && e.operation === 'remote' && e.outcome === 'resolved')).toBe(true)
    expect(events.filter(e => e.command).every(e => e.command?.commandId === c.commandId && e.command.actionKind === 'setValue')).toBe(true)
    expect(events.every(e => e.sessionId === g.identity.sessionId && e.epoch === g.epoch && Object.isFrozen(e))).toBe(true)
    expect(JSON.stringify(events)).not.toContain('private-')
    expect(JSON.stringify(events)).not.toMatch(/physical|target_drain|os_dispatch|ax_time/)
    expect(events.map(e => e.sequence)).toEqual(events.map((_, i) => i + 1))
    const request = events.find(e => e.event === 'stop_requested')!
    const revoked = events.find(e => e.event === 'local_gate_revoked')!
    expect(revoked.sequence).toBe(request.sequence + 1)
    expect(revoked.durationMs).toBeGreaterThanOrEqual(0)
    expect(events.find(e => e.event === 'helper_lifetime_barrier' && e.outcome === 'resolved')!.sequence).toBeGreaterThan(revoked.sequence)
  })
  it('revokes synchronously with a pending RPC, retains lease until lifetime barrier, and labels late settlement only', async () => {
    const rpc = deferred<NativeReceipt>(); const death = deferred<void>()
    const { controller, helper, lease, events } = setup({ execute: vi.fn(() => rpc.promise), kill: vi.fn(() => death.promise) })
    const g = grant(); const c = { ...command(g), action: { kind: 'observe' as const, target: g.targets[0] } }
    await controller.start(g); const executing = controller.execute(c)
    await vi.waitFor(() => expect(helper.execute).toHaveBeenCalledOnce())
    const stopping = controller.stop()
    expect(controller.status().state).toBe('stopped'); expect(helper.kill).toHaveBeenCalledOnce(); expect(lease.release).not.toHaveBeenCalled()
    expect((await executing).outcome).toBe('execution_unknown'); await flush()
    expect(events).toContainEqual(expect.objectContaining({ event: 'helper_rpc_wait', operation: 'execute', outcome: 'cancelled' }))
    expect(events.some(e => e.event === 'helper_lifetime_barrier' && e.outcome === 'resolved')).toBe(false)
    rpc.resolve({ commandId: c.commandId, code: 'ok', outcome: 'executed' }); await flush()
    expect(controller.status().state).toBe('stopped'); expect(lease.release).not.toHaveBeenCalled()
    expect(events).toContainEqual(expect.objectContaining({ event: 'helper_rpc_settlement', operation: 'execute', outcome: 'late_resolved' }))
    death.resolve(); await stopping; await flush(); expect(lease.release).toHaveBeenCalledOnce()
    expect(events).toContainEqual(expect.objectContaining({ event: 'helper_lifetime_barrier', outcome: 'resolved', durationMs: expect.any(Number) }))
  })
  it.each(['reject', 'throw'] as const)('a %s from kill cannot mark the lifetime barrier resolved or release the lease', async failure => {
    const { controller, events, lease } = setup({ kill: vi.fn(() => { if (failure === 'throw') throw new Error('private-kill'); return Promise.reject(new Error('private-kill')) }) })
    await controller.start(grant()); const shutdown = controller.stop()
    expect(controller.status().state).toBe('stopped'); await expect(shutdown).rejects.toThrow(); await flush()
    expect(lease.release).not.toHaveBeenCalled()
    expect(events).toContainEqual(expect.objectContaining({ event: 'helper_lifetime_barrier', outcome: 'failed' }))
    expect(events.some(e => e.event === 'helper_lifetime_barrier' && e.outcome === 'resolved')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('private-kill')
  })
  it('late rejected old-scope RPC keeps its old source/session/epoch and cannot resurrect resumed authority', async () => {
    const rpc = deferred<NativeReceipt>()
    const { controller, helper, events } = setup({ execute: vi.fn(() => rpc.promise) })
    const old = grant(); const c = { ...command(old), action: { kind: 'observe' as const, target: old.targets[0] } }
    await controller.start(old); const executing = controller.execute(c); await vi.waitFor(() => expect(helper.execute).toHaveBeenCalledOnce())
    await controller.identityChanged(); await executing
    const next = grant(3); await controller.resume(next); const before = controller.status()
    rpc.reject(new Error('private-late-error')); await flush()
    expect(controller.status()).toEqual(before)
    const late = events.find(e => e.event === 'helper_rpc_settlement' && e.outcome === 'late_failed')!
    expect(late).toMatchObject({ sessionId: old.identity.sessionId, epoch: old.epoch })
    expect(events.find(e => e.sessionId === next.identity.sessionId)!.sourceId).not.toBe(late.sourceId)
    expect(events.filter(e => e.command?.commandId === c.commandId).every(e => e.sessionId === old.identity.sessionId)).toBe(true)
    await controller.stop()
  })
  it('pending approval cancellation and observer failure never delay Stop or perform an action', async () => {
    for (const observer of [() => { throw new Error('private-observer') }, () => Promise.reject(new Error('private-observer')), () => new Promise<void>(() => {})]) {
      const approval = deferred<boolean>()
      const { controller, helper } = setup({}, { approveAction: () => approval.promise, observerFactory: () => observer })
      const g = grant(); await controller.start(g); const executing = controller.execute(command(g))
      await vi.waitFor(() => expect(controller.status().state).toBe('awaiting_action_approval'))
      const shutdown = controller.stop(); expect(controller.status().state).toBe('stopped'); expect(helper.kill).toHaveBeenCalledOnce()
      await shutdown; await executing; approval.resolve(true); await flush(); expect(helper.execute).not.toHaveBeenCalled()
    }
  })
  it('default-off leaves the execution and Stop paths unchanged', async () => {
    const { controller, factory } = setup({}, { observerFactory: undefined }); const g = grant()
    await controller.start(g); expect((await controller.execute(command(g))).code).toBe('ok'); await controller.stop(); await flush()
    expect(factory).not.toHaveBeenCalled()
  })
})
