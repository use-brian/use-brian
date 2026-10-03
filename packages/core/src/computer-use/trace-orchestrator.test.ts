import { describe, expect, it, vi } from 'vitest'
import type { NativeCommand, NativeGrant, NativeObservation, NativeReceipt, NativeStatus } from '@use-brian/computer-control/protocol.js'
import { NativeComputerOrchestrator } from './orchestrator.js'
import { NativeRunTrace, NativeTraceEventSchema, type NativeTraceCorrelation } from './trace.js'
import { nativeModelContext } from './context.js'
import type { NativeComputerProvider, NativeDecisionRuntime, NativeLlmAdapter, NativeModelInput, NativeSafetyPolicy } from './types.js'
import { executeDecisionCascade, type DecisionCompletionRoute } from '../decisions/hydra.js'

function fixture() {
  const identity = { deploymentId: 'private-deployment', userId: 'private-user', workspaceId: 'private-workspace', deviceId: 'private-device', sessionId: 'private-session', conversationId: 'private-conversation', taskId: 'private-task' }
  const target = { appId: 'private-app', processId: 1, processInstanceId: 'private-process', windowId: 'private-window', windowInstanceId: 'private-instance' }
  const grant: NativeGrant = { protocol: 'native-computer-v1', identity, grantId: 'private-grant', epoch: 1, expiresAt: Date.now() + 60000, targets: [target], allowControl: true, allowCapture: true, requester: 'private-requester', goal: 'private-goal' }
  const controller = new AbortController(), commands: NativeCommand[] = [], correlations: NativeTraceCorrelation[] = []
  let selected = false, seq = 0
  const observation = (): NativeObservation => ({ identity, target, epoch: 1, id: `private-observation-${++seq}`, capturedAt: Date.now(), monotonicMs: seq, foreground: true, completeness: 'complete', displayLayoutVersion: 'private-layout', bounds: { x: 0, y: 0, width: 100, height: 100 }, nodes: [{ ref: `private-ref-${seq}`, role: 'checkbox', name: 'private-AX-name', value: 'private-AX-value', selected, sensitive: false, enabled: true, focused: false, actions: ['select'] }] })
  const status: NativeStatus = { protocol: 'native-computer-v1', state: 'active', identity, epoch: 1, expiresAt: grant.expiresAt, capabilities: { protocol: 'native-computer-v1', platform: 'darwin', axRead: true, semanticActions: true, windowCapture: true, input: true, accessibilityPermission: 'granted', capturePermission: 'granted', limitations: [] } }
  const provider: NativeComputerProvider = {
    status: async () => status,
    observe: vi.fn(async command => { commands.push(command); return observation() }),
    execute: vi.fn<NativeComputerProvider['execute']>(async command => { commands.push(command); selected = true; return { commandId: command.commandId, outcome: 'executed', code: 'ok' } }),
  }
  const record = (input: NativeModelInput) => {
    if (input.trace) {
      correlations.push(input.trace)
      expect(Object.isFrozen(input.trace)).toBe(true)
      expect(JSON.stringify(nativeModelContext(input))).not.toContain(input.trace.spanId)
    }
  }
  const llm: NativeLlmAdapter = {
    select: vi.fn(async input => { record(input); return { result: input.candidates[0]!.id, providerId: 'private-provider', model: { catalogId: 'private-model', wireId: 'private-wire' } } }),
    decompose: vi.fn(async input => { record(input) }),
    verify: vi.fn(async input => { record(input); return { result: input.observation.nodes[0]?.selected ? 'complete' : 'continue', providerId: 'private-provider', model: { catalogId: 'private-model', wireId: 'private-wire' } } }),
  }
  const policy: NativeSafetyPolicy = { allows: () => true, allowsCapture: () => true, isComplete: o => o.nodes.some(n => n.selected) }
  const options = { authority: { grant, target, assertCurrent: async () => {} }, goal: grant.goal, signal: controller.signal, deadlineAt: Date.now() + 60000 }
  return { provider, llm, policy, options, observation, commands, controller, correlations, record }
}
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }

describe('existing native loop trace seam', () => {
  it.each([false, true])('preserves behavior and correlates RPCs and high-level phases (Hydra: %s)', async hydra => {
    const f = fixture(), trace = new NativeRunTrace(), requests: string[] = []
    const runtime: NativeDecisionRuntime = {
      resolveRoute: async () => ({ mode: 'llm_only' }), observe: vi.fn(),
      run: ({ request, operation }) => {
        requests.push(request.runId)
        expect(JSON.stringify(request.state)).not.toContain(trace.runId)
        expect(JSON.stringify(request.state)).not.toContain(request.runId)
        expect(trace.snapshot().events.find(e => e.spanId === request.runId)).toMatchObject({ kind: 'span-start' })
        return executeDecisionCascade({ request: { ...request, model: { catalogId: 'test', wireId: 'test' } }, route: { mode: 'llm_only' }, operation: { ...operation, completeWithLlm: ctx => operation.completeWithLlm({ ...ctx, llm: {} as DecisionCompletionRoute }) } })
      },
    }
    const result = await new NativeComputerOrchestrator({ ...f, trace, ...(hydra ? { decisionRuntime: runtime } : {}) }).run(f.options)
    expect(result).toEqual({ outcome: 'completed', reason: 'Verified goal postconditions', actions: 1 })
    const snapshot = trace.snapshot(), events = snapshot.events
    expect(events.filter(e => e.kind === 'span-start').map(e => e.phase)).toEqual(['observation-rpc', 'selection', 'decomposition', 'effect-rpc', 'observation-rpc', 'verification'])
    expect(events.filter(e => e.kind === 'span-start' && e.scope === 'rpc').map(e => e.commandId)).toEqual(f.commands.map(c => c.commandId))
    expect(events.filter(e => e.kind === 'span-start' && e.scope === 'rpc').map(e => e.actionKind)).toEqual(['observe', 'select', 'observe'])
    expect(events.filter(e => e.kind === 'run-terminal')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ outcome: 'completed', step: 1, drain: 'not_observed' })
    expect(snapshot).toMatchObject({ pendingSpans: 0, evidence: 'valid' })
    expect(f.correlations).toHaveLength(3)
    for (const correlation of f.correlations) expect(events.some(e => e.spanId === correlation.spanId && e.runId === correlation.runId && e.clockId === correlation.clockId)).toBe(true)
    if (hydra) expect(requests).toEqual([f.correlations[0]!.spanId, f.correlations[2]!.spanId])
    for (const event of events) expect(NativeTraceEventSchema.safeParse(event).success).toBe(true)
    expect(JSON.stringify(snapshot)).not.toMatch(/private-|goal|nodes|target|credential|image|hash|error/i)
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
  })
  it('does not create a second logical run or terminal when the existing instance is busy', async () => {
    const f = fixture(), trace = new NativeRunTrace()
    let entered: () => void = () => {}, release: () => void = () => {}
    const planning = new Promise<void>(resolve => { entered = resolve })
    f.llm.select = async input => {
      f.record(input); entered()
      await new Promise<void>(resolve => { release = resolve })
      return { result: 'c0', providerId: 'private-provider', model: { catalogId: 'test', wireId: 'test' } }
    }
    const loop = new NativeComputerOrchestrator({ ...f, trace })
    const first = loop.run(f.options)
    await planning
    expect(await loop.run(f.options)).toMatchObject({ outcome: 'paused', actions: 0, reason: 'Session already running' })
    expect(trace.snapshot().events.filter(e => e.kind === 'run-terminal')).toHaveLength(0)
    release()
    expect((await first).outcome).toBe('completed')
    expect(trace.snapshot().events.filter(e => e.kind === 'run-start')).toHaveLength(1)
    expect(trace.snapshot().events.filter(e => e.kind === 'run-terminal')).toHaveLength(1)
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])('does not change a same-turn certified receipt/cancel race (traced: %s)', async traced => {
    const f = fixture(), trace = traced ? new NativeRunTrace() : undefined
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async command => {
      f.controller.abort()
      return { commandId: command.commandId, outcome: 'not_executed', code: 'stale_observation' }
    })
    expect(await new NativeComputerOrchestrator({ ...f, trace }).run(f.options)).toMatchObject({ outcome: 'cancelled', actions: 1 })
    if (trace) expect(trace.snapshot().events.filter(e => e.phase === 'effect-rpc').map(e => e.kind)).toEqual(['span-start', 'span-settled'])
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
  })
  it('covers generation/capture/vision and passes correlation only to trusted model input', async () => {
    const f = fixture(), trace = new NativeRunTrace()
    let clicked = false
    const execute = f.provider.execute
    f.provider.observe = vi.fn(async command => { f.commands.push(command); const o = f.observation(); return clicked ? o : { ...o, nodes: [] } })
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async (command, signal) => {
      if (command.action.kind === 'capture') {
        f.commands.push(command)
        const o = f.observation()
        return { commandId: command.commandId, outcome: 'executed', code: 'ok', observation: { ...o, nodes: [], frame: { id: 'private-frame', mimeType: 'image/png', data: 'private-pixels', width: 100, height: 100, bounds: o.bounds, displayLayoutVersion: o.displayLayoutVersion } } }
      }
      clicked = true
      return execute(command, signal)
    })
    f.llm.plan = async input => { f.record(input); return [] }
    f.llm.vision = { nativeGrounding: true, propose: async input => { f.record(input); return { kind: 'click', target: input.observation.target, observationId: input.observation.id, frameId: input.observation.frame!.id, x: 10, y: 10 } } }
    expect((await new NativeComputerOrchestrator({ ...f, trace }).run(f.options)).outcome).toBe('completed')
    expect(trace.snapshot().events.filter(e => e.kind === 'span-start').map(e => e.phase)).toEqual(['observation-rpc', 'generation', 'decomposition', 'observation-rpc', 'capture-rpc', 'vision-grounding', 'effect-rpc', 'observation-rpc', 'verification'])
    expect(JSON.stringify(trace.snapshot())).not.toContain('private-')
    expect(f.llm.select).not.toHaveBeenCalled()
  })
  it('records logical cancellation of a nonsettling observation without fabricating settlement or drain', async () => {
    const f = fixture(), trace = new NativeRunTrace()
    f.provider.observe = async () => { f.controller.abort(); return new Promise<NativeObservation>(() => {}) }
    expect(await new NativeComputerOrchestrator({ ...f, trace }).run(f.options)).toMatchObject({ outcome: 'cancelled', actions: 0 })
    expect(trace.snapshot()).toMatchObject({ pendingSpans: 1, logicalTerminal: true, drain: 'not_observed' })
    expect(trace.snapshot().events.map(e => e.kind)).toEqual(['run-start', 'span-start', 'span-interrupted', 'run-terminal'])
    expect(f.provider.execute).not.toHaveBeenCalled()
  })
  it('late generation settlement produces metadata only, never a delayed dispatch', async () => {
    const f = fixture(), trace = new NativeRunTrace()
    let release: () => void = () => {}
    f.provider.observe = async () => { const o = f.observation(); o.nodes[0]!.actions = ['setValue']; return o }
    f.llm.plan = input => new Promise(resolve => {
      release = () => resolve([{ id: 'generated', action: { kind: 'setValue', target: input.observation.target, observationId: input.observation.id, ref: input.observation.nodes[0]!.ref, text: 'private-generated-text' } }])
      f.controller.abort()
    })
    expect((await new NativeComputerOrchestrator({ ...f, trace }).run(f.options)).outcome).toBe('cancelled')
    expect(trace.snapshot().pendingSpans).toBe(1)
    release(); await flush()
    expect(trace.snapshot().events.at(-1)).toMatchObject({ kind: 'span-settled', phase: 'generation', outcome: 'fulfilled', late: true })
    expect(f.provider.execute).not.toHaveBeenCalled()
    expect(JSON.stringify(trace.snapshot())).not.toContain('private-')
  })
  it.each(['fulfills', 'rejects', 'never'] as const)('unknown effect remains fenced when the underlying RPC %s after logical terminal', async settlement => {
    const f = fixture(), trace = new NativeRunTrace()
    let settle: () => void = () => {}
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(command => new Promise<NativeReceipt>((resolve, reject) => {
      settle = () => settlement === 'fulfills' ? resolve({ commandId: command.commandId, outcome: 'executed', code: 'ok' }) : reject(new Error('private-helper-error'))
      f.controller.abort()
    }))
    const loop = new NativeComputerOrchestrator({ ...f, trace })
    expect((await loop.run(f.options)).outcome).toBe('execution_unknown')
    expect(trace.snapshot().pendingSpans).toBe(1)
    if (settlement !== 'never') { settle(); await flush(); expect(trace.snapshot().events.at(-1)).toMatchObject({ kind: 'span-settled', phase: 'effect-rpc', late: true }) }
    const before = trace.snapshot().events.length
    expect((await loop.run(f.options)).outcome).toBe('execution_unknown')
    expect(trace.snapshot().events).toHaveLength(before)
    expect(trace.snapshot().events.filter(e => e.kind === 'run-terminal')).toHaveLength(1)
    expect(trace.snapshot().events.find(e => e.kind === 'run-terminal')).toMatchObject({ outcome: 'execution_unknown', drain: 'not_observed' })
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(trace.snapshot())).not.toContain('private-')
  })
  it.each(['throws', 'rejects', 'hangs', 'bad-clock', 'overflow', 'off'] as const)('observer %s cannot change task semantics', async mode => {
    const f = fixture()
    const trace = mode === 'off' ? undefined : new NativeRunTrace(() => {
      if (mode === 'throws') throw new Error('private-observer-error')
      if (mode === 'rejects') return Promise.reject(new Error('private-observer-error'))
      if (mode === 'hangs') return new Promise<void>(() => {})
    }, mode === 'bad-clock' ? { clock: () => NaN } : mode === 'overflow' ? { maxEvents: 16 } : {})
    expect(await new NativeComputerOrchestrator({ ...f, trace }).run(f.options)).toEqual({ outcome: 'completed', reason: 'Verified goal postconditions', actions: 1 })
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
    await flush()
    if (mode === 'off') expect(f.correlations).toHaveLength(0)
    else expect(trace!.snapshot().logicalTerminal).toBe(true)
  })
})
