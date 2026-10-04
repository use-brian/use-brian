import { describe, expect, it, vi } from 'vitest'
import { NATIVE_PROTOCOL } from '@use-brian/computer-control/protocol.js'
import type { NativeGrant, NativeObservation, NativeStatus } from '@use-brian/computer-control/protocol.js'
import { executeDecisionCascade, type DecisionCompletionRoute, type DecisionEvaluationProfile } from '../decisions/hydra.js'
import { buildNativeCandidates, NativeComputerOrchestrator } from './orchestrator.js'
import { approvedNativeProfile, createNativeDecisionOperation, createNativeProgressOperation, NATIVE_VERIFY_PROGRESS, NATIVE_NEXT_ACTION } from './decision.js'
import { createNativeComputerTools } from './tools.js'
import type { NativeComputerProvider, NativeDecisionRuntime, NativeLlmAdapter, NativeSafetyPolicy, NativeInferenceBudget } from './types.js'

function fixture() {
  const identity = { deploymentId: 'd', userId: 'u', workspaceId: 'w', deviceId: 'dev', sessionId: 's', conversationId: 'c', taskId: 't' }
  const target = { appId: 'fixture', processId: 1, processInstanceId: 'p', windowId: 'win', windowInstanceId: 'wi' }
  const grant: NativeGrant = { protocol: NATIVE_PROTOCOL, identity, grantId: 'g', epoch: 1, expiresAt: Date.now() + 60_000, targets: [target], allowControl: true, allowCapture: true, requester: 'user', goal: 'select' }
  let selected = false
  const observation = (): NativeObservation => ({ identity, epoch: 1, id: 'o', capturedAt: Date.now(), monotonicMs: 1, target, foreground: true, bounds: { x: 0, y: 0, width: 100, height: 100 }, displayLayoutVersion: 'l', completeness: 'complete', nodes: [{ ref: 'r', role: 'checkbox', name: 'fixture', enabled: true, focused: false, sensitive: false, selected, actions: ['select'] }] })
  const status: NativeStatus = { protocol: NATIVE_PROTOCOL, state: 'active', epoch: 1, identity, expiresAt: grant.expiresAt, capabilities: { protocol: NATIVE_PROTOCOL, platform: 'darwin', axRead: true, semanticActions: true, windowCapture: true, input: true, accessibilityPermission: 'granted', capturePermission: 'granted', limitations: [] } }
  const provider: NativeComputerProvider = { status: vi.fn(async () => status), observe: vi.fn(async () => observation()), execute: vi.fn<NativeComputerProvider['execute']>(async command => { selected = true; return { commandId: command.commandId, outcome: 'executed', code: 'ok' } }) }
  const llm: NativeLlmAdapter = { select: vi.fn(async () => ({ result: 'c0', providerId: 'llm', model: { catalogId: 'test', wireId: 'test' } })) }
  const policy: NativeSafetyPolicy = { allows: () => true, allowsCapture: () => true, isComplete: o => o.nodes.some(n => n.selected) }
  const options = { authority: { grant, target, assertCurrent: vi.fn(async () => {}) }, goal: 'select fixture', signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 }
  return { provider, llm, policy, options, observation, status }
}
function visualFixture() {
  const f = fixture()
  f.options.authority.target.appId = 'com.usebrian.NativeComputerFixture'
  f.options.goal = f.options.authority.grant.goal = 'Activate the outlined triangle; finish when Result is Triangle.'
  f.status.capabilities.visualInvokeVersion = 1
  f.status.capabilities.input = false
  const old = f.observation
  let seq = 0, value = 'None'
  f.observation = () => ({ ...old(), captureCohort: 'public-shapes-v1', id: `o${++seq}`, monotonicMs: seq,
    nodes: [{ ...old().nodes[0]!, role: 'AXStaticText', name: 'Result', value, actions: [] }] })
  f.provider.observe = vi.fn(async () => f.observation())
  f.policy.isComplete = o => o.nodes.some(n => n.value === 'Triangle')
  f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async c => {
    if (c.action.kind === 'capture') {
      const o = f.observation()
      return { commandId: c.commandId, outcome: 'executed', code: 'ok', observation: { ...o,
        frame: { id: 'frame', mimeType: 'image/png', data: '', width: 100, height: 100, bounds: o.bounds, displayLayoutVersion: 'l' } } }
    }
    value = 'Triangle'
    return { commandId: c.commandId, outcome: 'executed', code: 'ok' }
  })
  f.llm.vision = { nativeGrounding: true, propose: vi.fn<NonNullable<NativeLlmAdapter['vision']>['propose']>(async i => ({ kind: 'visualInvoke', target: i.observation.target, observationId: i.observation.id, frameId: i.observation.frame!.id, x: 10, y: 10 })) }
  return f
}
describe('native orchestration', () => {
  it('offers both semantic scroll directions without truncation or policy bypass', () => {
    const f = fixture(), o = f.observation()
    o.nodes[0]!.actions = ['scroll']
    expect(buildNativeCandidates(o, f.policy).map(c => c.action)).toEqual([
      expect.objectContaining({ kind: 'scroll', deltaY: 400 }),
      expect.objectContaining({ kind: 'scroll', deltaY: -400 }),
    ])
    expect(buildNativeCandidates(o, { ...f.policy, allows: a => a.kind === 'scroll' && a.deltaY < 0 })).toEqual([
      { id: 'c0', action: expect.objectContaining({ deltaY: -400 }) },
    ])
    o.nodes = Array.from({ length: 13 }, (_, i) => ({ ...o.nodes[0]!, ref: `r${i}`, name: `Scroll ${i}` }))
    expect(buildNativeCandidates(o, f.policy)).toEqual([])
  })
  it('retains scroll direction in the bounded decision state', async () => {
    const f = fixture()
    f.provider.observe = async () => {
      const o = f.observation(); o.nodes[0]!.actions = ['scroll']; return o
    }
    const run = vi.fn<NativeDecisionRuntime['run']>(async ({ request }) => {
      expect(request.state).toMatchObject({ candidates: [
        { id: 'c0', action: 'scroll', ref: 'r', deltaY: 400 },
        { id: 'c1', action: 'scroll', ref: 'r', deltaY: -400 },
      ] })
      throw new Error('stop before dispatch')
    })
    const decisionRuntime: NativeDecisionRuntime = {
      resolveRoute: async () => ({ mode: 'llm_only', operatorOverride: false }),
      run: async options => { await run(options); throw new Error('unreachable') },
      observe: async () => { throw new Error('not used') },
    }
    expect((await new NativeComputerOrchestrator({ ...f, decisionRuntime }).run(f.options)).outcome).toBe('paused')
    expect(run).toHaveBeenCalledOnce()
    expect(f.provider.execute).not.toHaveBeenCalled()
  })

  it('AX-first lifecycle verifies fresh postcondition and never captures', async () => {
    const f = fixture(); const events: string[] = []
    const result = await new NativeComputerOrchestrator(f).run({ ...f.options, onProgress: e => events.push(e.phase) })
    expect(result).toMatchObject({ outcome: 'completed', actions: 1 })
    expect(f.provider.observe).toHaveBeenCalledTimes(2)
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
    expect(events).toContain('executing')
    expect(vi.mocked(f.llm.select).mock.calls[0]![0].observation.frame).toBeUndefined()
  })
  it('does not invoke the generation planner before a bounded AX decision', async () => {
    const f = fixture(); f.llm.plan = vi.fn(async () => [])
    expect((await new NativeComputerOrchestrator(f).run(f.options)).outcome).toBe('completed')
    expect(f.llm.plan).not.toHaveBeenCalled()
    expect(f.llm.select).toHaveBeenCalledTimes(1)
  })
  it('selects bounded AX before whole-goal decomposition and dispatch', async () => {
    const f = fixture(), order: string[] = []
    f.llm.select = async () => { order.push('select'); return { result: 'c0', providerId: 'llm', model: { catalogId: 'test', wireId: 'test' } } }
    f.llm.decompose = async () => { order.push('decompose') }
    const execute = f.provider.execute
    f.provider.execute = async (c, signal) => { order.push('execute'); return execute(c, signal) }
    expect((await new NativeComputerOrchestrator(f).run(f.options)).outcome).toBe('completed')
    expect(order).toEqual(['select', 'decompose', 'execute'])
  })
  it('invokes semantically once, checks fresh Result before budget pause, and never reopens the run', async () => {
    const f = visualFixture(), loop = new NativeComputerOrchestrator(f)
    f.llm.plan = vi.fn(async () => [])
    expect(buildNativeCandidates(f.observation(), f.policy)).toEqual([])
    expect(await loop.run({ ...f.options, maxActions: 1 })).toMatchObject({ outcome: 'completed', actions: 1 })
    expect(vi.mocked(f.provider.execute).mock.calls.map(([c]) => c.action.kind)).toEqual(['capture', 'visualInvoke'])
    expect(await loop.run({ ...f.options, maxActions: 20 })).toMatchObject({ outcome: 'paused', actions: 0 })
    expect(f.llm.plan).not.toHaveBeenCalled()
    expect(f.llm.select).not.toHaveBeenCalled()
  })
  it.each(['missing-version', 'no-control', 'no-capture', 'permission', 'marker', 'layout', 'bounds', 'capture-denied', 'vision-null', 'budget', 'stale-result', 'wrong-frame', 'wrong-observation', 'wrong-target', 'edge', 'raw-click', 'extra', 'unknown', 'lost', 'wrong-result', 'stop-model', 'stop-dispatch', 'stop-success'])(
    'fails closed without a second trial: %s', async failure => {
      const f = visualFixture(), controller = new AbortController()
      if (failure === 'missing-version') delete f.status.capabilities.visualInvokeVersion
      if (failure === 'no-control') f.options.authority.grant.allowControl = false
      if (failure === 'no-capture') f.options.authority.grant.allowCapture = false
      if (failure === 'permission') f.status.capabilities.capturePermission = 'denied'
      const originalObserve = f.provider.observe
      let firstResult: NativeObservation | undefined
      f.provider.observe = vi.fn(async (c, signal) => {
        const o = await originalObserve(c, signal)
        if (failure === 'stale-result' && firstResult) return firstResult
        return o
      })
      const execute = f.provider.execute
      f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async (c, signal) => {
        if (c.action.kind === 'visualInvoke') {
          if (failure === 'lost') throw new Error('lost')
          if (failure === 'unknown') return { commandId: c.commandId, outcome: 'execution_unknown', code: 'helper_error' }
          if (failure === 'stop-dispatch') { controller.abort(); return new Promise<never>(() => {}) }
          if (failure === 'stop-success') controller.abort()
          if (failure === 'wrong-result') return { commandId: c.commandId, outcome: 'executed', code: 'ok' }
        }
        const receipt = await execute(c, signal)
        if (receipt.observation) {
          firstResult = receipt.observation
          if (failure === 'marker') delete receipt.observation.captureCohort
          if (failure === 'layout') receipt.observation.frame!.displayLayoutVersion = 'changed'
          if (failure === 'bounds') receipt.observation.frame!.bounds = { ...receipt.observation.bounds, x: 1 }
          if (failure === 'capture-denied') return { commandId: c.commandId, outcome: 'not_executed', code: 'denied' }
        }
        return receipt
      })
      const propose = f.llm.vision!.propose
      f.llm.vision!.propose = vi.fn(async input => {
        if (failure === 'vision-null') return null
        if (failure === 'stop-model') { controller.abort(); return new Promise<never>(() => {}) }
        const a = await propose(input)
        return { ...a, ...(failure === 'wrong-frame' ? { frameId: 'old' } : {}),
          ...(failure === 'wrong-observation' ? { observationId: 'old' } : {}),
          ...(failure === 'wrong-target' ? { target: { ...input.observation.target, windowId: 'other' } } : {}),
          ...(failure === 'edge' ? { x: 100 } : {}), ...(failure === 'raw-click' ? { kind: 'click' } : {}),
          ...(failure === 'extra' ? { ref: 'forged' } : {}) } as never
      })
      const loop = new NativeComputerOrchestrator({ ...f, inferenceBudget: { reserve: async () => failure !== 'budget' } })
      const result = await loop.run({ ...f.options, signal: controller.signal, maxActions: 20 })
      expect(result.outcome).not.toBe('completed')
      if (!['unknown', 'lost', 'wrong-result', 'stale-result', 'stop-dispatch', 'stop-success'].includes(failure)) expect(result.actions).toBe(0)
      if (failure === 'stop-model') expect(result.outcome).toBe('cancelled')
      if (['lost', 'unknown', 'stop-dispatch'].includes(failure)) expect(result.outcome).toBe('execution_unknown')
      expect(vi.mocked(f.provider.execute).mock.calls.filter(([c]) => c.action.kind === 'visualInvoke').length).toBeLessThanOrEqual(1)
      const count = vi.mocked(f.provider.execute).mock.calls.length
      await loop.run(f.options)
      expect(f.provider.execute).toHaveBeenCalledTimes(count)
    })
  it('cannot discard a rejected visual cohort on a later run to restore ordinary effects', async () => {
    const f = visualFixture(), loop = new NativeComputerOrchestrator(f)
    expect(await loop.run({ ...f.options, goal: 'Different goal' })).toMatchObject({ outcome: 'paused', actions: 0 })
    f.provider.observe = vi.fn(async () => {
      const o = f.observation()
      delete o.captureCohort
      o.nodes[0]!.actions = ['invoke']
      return o
    })
    expect(await loop.run(f.options)).toMatchObject({ outcome: 'paused', actions: 0 })
    expect(f.provider.execute).not.toHaveBeenCalled()
    expect(f.llm.select).not.toHaveBeenCalled()
    expect(f.llm.vision!.propose).not.toHaveBeenCalled()
  })
  it('ignores a late visual proposal after Stop and cannot reopen the consumed attempt', async () => {
    const f = visualFixture(), controller = new AbortController()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const propose = f.llm.vision!.propose
    f.llm.vision!.propose = vi.fn(async input => { entered(); await blocked; return propose(input) })
    const loop = new NativeComputerOrchestrator(f)
    const running = loop.run({ ...f.options, signal: controller.signal })
    await waiting
    controller.abort()
    expect(await running).toMatchObject({ outcome: 'cancelled', actions: 0 })
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await loop.run(f.options)).toMatchObject({ outcome: 'paused', actions: 0 })
    expect(vi.mocked(f.provider.execute).mock.calls.map(([c]) => c.action.kind)).toEqual(['capture'])
    expect(f.llm.vision!.propose).toHaveBeenCalledOnce()
  })
  it.each([1, 2])('selects only ambiguous generated proposals (%s proposals)', async count => {
    const f = fixture(), order: string[] = []
    f.provider.observe = vi.fn(async () => {
      const o = f.observation()
      return { ...o, nodes: o.nodes.map(n => ({ ...n, actions: [] })) }
    })
    f.llm.plan = async input => {
      order.push('plan')
      return Array.from({ length: count }, (_, i) => ({ id: `generated-${i}`, action: { kind: 'setValue' as const, target: input.observation.target, observationId: input.observation.id, ref: 'r', text: `value-${i}` } }))
    }
    f.llm.select = vi.fn(async () => { order.push('select'); return { result: 'p0', providerId: 'llm', model: { catalogId: 'test', wireId: 'test' } } })
    f.llm.decompose = async () => { order.push('decompose') }
    const execute = f.provider.execute
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async (c, signal) => { order.push('execute'); return execute(c, signal) })
    const budget = { reserve: vi.fn(async () => true) }
    expect(await new NativeComputerOrchestrator({ ...f, inferenceBudget: budget }).run({ ...f.options, maxModelCalls: count === 1 ? 2 : 3 })).toMatchObject({ outcome: 'completed', actions: 1 })
    expect(order).toEqual(count === 1 ? ['plan', 'decompose', 'execute'] : ['plan', 'select', 'decompose', 'execute'])
    expect(f.llm.select).toHaveBeenCalledTimes(count === 1 ? 0 : 1)
    expect(budget.reserve).toHaveBeenCalledTimes(count === 1 ? 2 : 3)
  })
  it.each(['stale', 'wrong-target', 'policy'])('does not directly dispatch an invalid single proposal: %s', async invalid => {
    const f = fixture()
    f.provider.observe = vi.fn(async () => ({ ...f.observation(), nodes: [] }))
    f.llm.plan = async input => [{ id: 'generated', action: { kind: 'setValue', target: { ...input.observation.target, ...(invalid === 'wrong-target' ? { windowId: 'other' } : {}) }, observationId: invalid === 'stale' ? 'old' : input.observation.id, ref: 'r', text: 'value' } }]
    if (invalid === 'policy') f.policy.allows = () => false
    expect(await new NativeComputerOrchestrator(f).run(f.options)).toMatchObject({ outcome: 'paused', actions: 0 })
    expect(f.provider.execute).not.toHaveBeenCalled()
    expect(f.llm.select).not.toHaveBeenCalled()
  })
  it.each(['failure', 'cancel'] as const)('never dispatches a visual invoke after decomposition %s', async failure => {
    const f = visualFixture(), controller = new AbortController(), order: string[] = []
    f.provider.observe = vi.fn(async () => f.observation())
    f.llm.vision = { nativeGrounding: true, propose: async input => { order.push('vision'); return { kind: 'visualInvoke', target: input.observation.target, observationId: input.observation.id, frameId: 'frame', x: 20, y: 20 } } }
    let release: () => void = () => {}
    f.llm.decompose = vi.fn(async input => {
      order.push('decompose')
      expect(input.observation.frame).toBeUndefined()
      if (failure === 'failure') throw new Error('No grounded goal contract')
      controller.abort()
      await new Promise<void>(resolve => { release = resolve })
    })
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async c => {
      order.push(c.action.kind)
      return { commandId: c.commandId, outcome: 'executed', code: 'ok', observation: { ...f.observation(), frame: { id: 'frame', mimeType: 'image/png', data: 'private', width: 100, height: 100, bounds: f.observation().bounds, displayLayoutVersion: 'l' } } }
    })
    expect(await new NativeComputerOrchestrator(f).run({ ...f.options, signal: controller.signal })).toMatchObject({ outcome: failure === 'cancel' ? 'cancelled' : 'paused', actions: 0 })
    release(); await new Promise(r => setTimeout(r, 0))
    expect(order).toEqual(['decompose'])
    expect(f.provider.execute).not.toHaveBeenCalled()
    expect(f.llm.select).not.toHaveBeenCalled()
  })
  it.each([0, 2000, 6000])('decomposes before fresh capture without extending frame age (grounding delay: %s ms)', async groundingMs => {
    vi.useFakeTimers()
    try {
      const f = visualFixture(), order: string[] = []
      let seq = 0, clicked = false
      f.provider.observe = vi.fn(async () => {
        order.push('observe')
        return { ...f.observation(), id: `o${++seq}`, monotonicMs: seq, nodes: f.observation().nodes.map(n => ({ ...n, value: clicked ? 'Triangle' : 'None' })) }
      })
      f.policy.isComplete = () => clicked
      f.llm.decompose = async input => {
        order.push('decompose')
        expect(input.observation.id).toBe('o1')
        expect(input.observation.frame).toBeUndefined()
        await new Promise(resolve => setTimeout(resolve, 6000))
      }
      f.llm.vision = { nativeGrounding: true, propose: async input => {
        order.push('vision')
        expect(input.observation.id).toBe('o2')
        expect(Date.now() - input.observation.capturedAt).toBe(0)
        if (groundingMs) await new Promise(resolve => setTimeout(resolve, groundingMs))
        return { kind: 'visualInvoke', target: input.observation.target, observationId: input.observation.id, frameId: 'fresh-frame', x: 20, y: 20 }
      } }
      f.llm.verify = async input => {
        order.push('verify')
        expect(input.observation.id).toBe('o3')
        return { result: 'complete', providerId: 'llm', model: { catalogId: 'test', wireId: 'test' } }
      }
      f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async command => {
        order.push(command.action.kind)
        if (command.action.kind === 'capture') {
          expect(command.action.observationId).toBe('o2')
          return { commandId: command.commandId, outcome: 'executed', code: 'ok', observation: {
            ...f.observation(), id: 'o2', monotonicMs: 2,
            frame: { id: 'fresh-frame', mimeType: 'image/png', data: '', width: 100, height: 100, bounds: f.observation().bounds, displayLayoutVersion: 'l' },
          } }
        }
        expect(command.action).toMatchObject({ kind: 'visualInvoke', observationId: 'o2', frameId: 'fresh-frame' })
        clicked = true
        f.status.capabilities.input = false
        f.status.capabilities.semanticActions = false
        return { commandId: command.commandId, outcome: 'executed', code: 'ok' }
      })
      const run = new NativeComputerOrchestrator(f).run(f.options)
      await vi.advanceTimersByTimeAsync(6001 + groundingMs)
      expect(await run).toMatchObject({ outcome: groundingMs >= 5000 ? 'paused' : 'completed', actions: groundingMs >= 5000 ? 0 : 1 })
      expect(order).toEqual(['observe', 'decompose', 'observe', 'capture', 'vision', ...(groundingMs >= 5000 ? [] : ['visualInvoke', 'observe'])])
    } finally { vi.useRealTimers() }
  })
  it('refreshes unchanged AX state after inference without reusing stale refs', async () => {
    const f = fixture(); let sequence = 0
    f.provider.observe = vi.fn(async () => {
      const o = f.observation()
      if (++sequence === 1) o.capturedAt -= 2000
      o.id = `snapshot-${sequence}`
      o.nodes[0]!.ref = `ref-${sequence}`
      return o
    })
    expect((await new NativeComputerOrchestrator(f).run(f.options)).outcome).toBe('completed')
    expect(vi.mocked(f.provider.execute).mock.calls[0]![0].action).toMatchObject({ observationId: 'snapshot-2', ref: 'ref-2' })
  })
  it('discards and replans when only the parent relationship changes during inference refresh', async () => {
    const f = fixture(); let seq = 0
    f.provider.observe = vi.fn(async () => {
      const o = f.observation(); seq++
      const group = { ...o.nodes[0]!, role: 'group', actions: [] as NativeObservation['nodes'][number]['actions'], selected: false }
      return { ...o, id: `o${seq}`, monotonicMs: seq, capturedAt: o.capturedAt - (seq === 1 ? 2000 : 0), nodes: [
        { ...group, ref: `primary-${seq}`, name: 'Primary' }, { ...group, ref: `secondary-${seq}`, name: 'Secondary' },
        { ...o.nodes[0]!, ref: `field-${seq}`, parentRef: `${seq === 1 ? 'primary' : 'secondary'}-${seq}` },
      ] }
    })
    expect(await new NativeComputerOrchestrator(f).run(f.options)).toMatchObject({ outcome: 'completed', actions: 1 })
    expect(f.llm.select).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.provider.execute).mock.calls[0]![0].action).toMatchObject({ observationId: 'o3', ref: 'field-3' })
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
  })
  it('stopped/permission-denied sessions cannot invoke a model or action', async () => {
    const f = fixture(); f.status.state = 'stopped'
    expect((await new NativeComputerOrchestrator(f).run(f.options)).outcome).toBe('paused')
    expect(f.llm.select).not.toHaveBeenCalled(); expect(f.provider.execute).not.toHaveBeenCalled()
  })
  it('unknown receipt latches across runs; no whole-goal fallback or replay', async () => {
    const f = fixture(); f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async () => { throw new Error('lost receipt') })
    const loop = new NativeComputerOrchestrator(f)
    expect((await loop.run(f.options)).outcome).toBe('execution_unknown')
    expect((await loop.run(f.options)).outcome).toBe('execution_unknown')
    expect(f.provider.execute).toHaveBeenCalledTimes(1); expect(f.llm.select).toHaveBeenCalledTimes(1)
  })
  it('cancellation of a hung dispatched action is unknown, not retryable', async () => {
    const f = fixture(); const controller = new AbortController()
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async () => { controller.abort(); return new Promise<never>(() => {}) })
    expect((await new NativeComputerOrchestrator(f).run({ ...f.options, signal: controller.signal })).outcome).toBe('execution_unknown')
  })
  it('invalid candidate abstains without dispatch', async () => {
    const f = fixture(); f.llm.select = vi.fn(async () => ({ result: 'invented', providerId: 'llm', model: { catalogId: 'test', wireId: 'test' } }))
    expect((await new NativeComputerOrchestrator(f).run(f.options)).actions).toBe(0)
    expect(f.provider.execute).not.toHaveBeenCalled()
  })
  it.each(['partial', 'complete'] as const)('refuses unadmitted %s AX canvases even when capture is allowed', async completeness => {
    const f = fixture(); let done = false
    f.provider.observe = vi.fn<NativeComputerProvider['observe']>(async () => ({ ...f.observation(), completeness, nodes: done ? [{ ...f.observation().nodes[0]!, selected: true }] : [] }))
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async c => {
      if (c.action.kind === 'capture') return { commandId: c.commandId, outcome: 'executed', code: 'ok', observation: { ...f.observation(), completeness: 'partial', nodes: [], frame: { id: 'frame', mimeType: 'image/png', data: '', width: 100, height: 100, bounds: f.observation().bounds, displayLayoutVersion: 'l' } } }
      done = true; return { commandId: c.commandId, outcome: 'executed', code: 'ok' }
    })
    f.llm.vision = { nativeGrounding: true, propose: vi.fn<NonNullable<NativeLlmAdapter['vision']>['propose']>(async () => ({ kind: 'visualInvoke', target: f.options.authority.target, observationId: 'o', frameId: 'frame', x: 20, y: 20 })) }
    expect((await new NativeComputerOrchestrator(f).run(f.options)).outcome).toBe('paused')
    expect(f.llm.select).not.toHaveBeenCalled(); expect(f.llm.vision!.propose).not.toHaveBeenCalled(); expect(f.provider.execute).not.toHaveBeenCalled()
  })
  it('no vision adapter means no capture', async () => {
    const f = fixture(); f.provider.observe = vi.fn<NativeComputerProvider['observe']>(async () => ({ ...f.observation(), nodes: [], completeness: 'unavailable' }))
    expect((await new NativeComputerOrchestrator(f).run(f.options)).reason).toBe('No safe grounding')
    expect(f.provider.execute).not.toHaveBeenCalled()
  })
  it('enforces action budget and no-progress bound', async () => {
    const f = fixture(); f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async c => ({ commandId: c.commandId, outcome: 'executed', code: 'ok' }))
    expect((await new NativeComputerOrchestrator(f).run({ ...f.options, maxActions: 1 })).reason).toBe('Budget exhausted')
  })
  it('has actual capability-gated tools with no model authority arguments', () => {
    const tools = createNativeComputerTools({ resolve: async () => null })
    expect(tools.nativeComputerTask.requiresCapability).toBe('native_computer')
    expect(tools.nativeComputerTask.inputSchema.safeParse({ goal: 'ok', userId: 'forged' }).success).toBe(false)
  })
})

describe('certified semantic recovery', () => {
  function recoveryFixture() {
    const f = fixture()
    let sequence = 0, selected = false
    f.provider.observe = vi.fn(async () => {
      const o = f.observation(), seq = ++sequence
      return { ...o, id: `o${seq}`, monotonicMs: seq, nodes: [{ ...o.nodes[0]!, ref: `r${seq}`, selected }] }
    })
    f.llm.decompose = vi.fn(async () => {})
    f.llm.verify = vi.fn<NonNullable<NativeLlmAdapter['verify']>>(async input => ({ result: input.observation.nodes.every(n => n.selected) ? 'complete' : 'continue', providerId: 'llm', model: { catalogId: 'test', wireId: 'test' } }))
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async c => {
      selected = true
      return { commandId: c.commandId, outcome: 'executed', code: 'ok' }
    })
    return f
  }
  it('replans one certified stale non-delivery with fresh refs and a new approved command', async () => {
    const f = recoveryFixture(), execute = f.provider.execute
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>().mockImplementationOnce(async c => ({ commandId: c.commandId, outcome: 'not_executed', code: 'stale_observation' })).mockImplementation(execute)
    expect(await new NativeComputerOrchestrator(f).run(f.options)).toMatchObject({ outcome: 'completed', actions: 2 })
    const commands = vi.mocked(f.provider.execute).mock.calls.map(([c]) => c)
    expect(commands.map(c => c.action)).toMatchObject([{ observationId: 'o1', ref: 'r1' }, { observationId: 'o2', ref: 'r2' }])
    expect(new Set(commands.map(c => c.commandId)).size).toBe(2)
    expect(f.llm.select).toHaveBeenCalledTimes(2)
    expect(f.llm.decompose).toHaveBeenCalledTimes(1)
    expect(f.llm.verify).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.llm.verify!).mock.calls[0]![0].observation.id).toBe('o3')
    expect(f.options.authority.assertCurrent).toHaveBeenCalled()
  })
  it.each(['no-progress', 'actions', 'model'] as const)('bounds repeated stale attempts by existing %s budget', async bound => {
    const f = recoveryFixture()
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async c => ({ commandId: c.commandId, outcome: 'not_executed', code: 'stale_observation' }))
    const options = { ...f.options, ...(bound === 'actions' ? { maxActions: 1 } : bound === 'model' ? { maxModelCalls: 2 } : {}) }
    expect(await new NativeComputerOrchestrator(f).run(options)).toMatchObject({ outcome: 'paused', actions: bound === 'no-progress' ? 2 : 1, reason: bound === 'no-progress' ? 'No verified progress' : 'Budget exhausted' })
    expect(f.llm.verify).not.toHaveBeenCalled()
    expect(f.llm.decompose).toHaveBeenCalledTimes(1)
  })
  it('preserves committed parts and the frozen goal when a later step is stale', async () => {
    const f = recoveryFixture(); let seq = 0, first = false, second = false, attempts = 0
    f.provider.observe = vi.fn(async () => {
      const o = f.observation(); seq++
      return { ...o, id: `o${seq}`, monotonicMs: seq, nodes: [
        { ...o.nodes[0]!, ref: `first-${seq}`, name: 'First', selected: first },
        { ...o.nodes[0]!, ref: `second-${seq}`, name: 'Second', selected: second },
      ] }
    })
    f.policy.isComplete = o => o.nodes.every(n => n.selected)
    f.llm.select = vi.fn<NativeLlmAdapter['select']>(async input => ({ result: input.candidates.find(c => { const action = c.action; return 'ref' in action && input.observation.nodes.some(n => n.ref === action.ref && !n.selected) })!.id, providerId: 'llm', model: { catalogId: 'test', wireId: 'test' } }))
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async c => {
      attempts++
      if (attempts === 2) return { commandId: c.commandId, outcome: 'not_executed', code: 'stale_observation' }
      if ('ref' in c.action && c.action.ref.startsWith('first')) first = true
      else second = true
      return { commandId: c.commandId, outcome: 'executed', code: 'ok' }
    })
    expect(await new NativeComputerOrchestrator(f).run(f.options)).toMatchObject({ outcome: 'completed', actions: 3 })
    expect(vi.mocked(f.provider.execute).mock.calls.map(([c]) => 'ref' in c.action && c.action.ref)).toEqual(['first-1', 'second-2', 'second-3'])
    expect(f.llm.decompose).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.llm.verify!).mock.calls.map(([input]) => input.observation.id)).toEqual(['o2', 'o4'])
  })
  it.each(['semantics', 'geometry', 'layout'] as const)('discards an undispatched proposal after inference changes %s, then freshly replans', async change => {
    const f = recoveryFixture(), observe = f.provider.observe
    let seq = 0
    f.provider.observe = vi.fn(async (c, signal) => {
      const o = await observe(c, signal)
      if (++seq === 1) return { ...o, capturedAt: Date.now() - 2000 }
      if (change === 'semantics') o.nodes[0]!.name = 'Changed label'
      if (change === 'geometry') o.bounds.x = 10
      if (change === 'layout') o.displayLayoutVersion = 'new-layout'
      return o
    })
    expect(await new NativeComputerOrchestrator(f).run({ ...f.options, maxActions: 1 })).toMatchObject({ outcome: 'completed', actions: 1 })
    expect(vi.mocked(f.llm.select).mock.calls.map(([input]) => input.observation.id)).toEqual(['o1', 'o3'])
    expect(vi.mocked(f.provider.execute).mock.calls[0]![0].action).toMatchObject({ observationId: 'o3', ref: 'r3' })
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
    expect(f.llm.decompose).toHaveBeenCalledTimes(1)
  })
  it('bounds repeated pre-dispatch invalidation even when every semantic state is different', async () => {
    const f = recoveryFixture(), observe = f.provider.observe
    let seq = 0, now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    f.provider.observe = vi.fn(async (c, signal) => {
      now += 2500
      const o = await observe(c, signal); seq++
      o.nodes[0]!.name = `changing-${seq}`
      if (seq % 2 === 1) o.capturedAt = now - 2000
      return o
    })
    try {
      expect(await new NativeComputerOrchestrator(f).run({ ...f.options, maxModelCalls: 3 })).toMatchObject({ outcome: 'paused', actions: 0, reason: 'Budget exhausted' })
      expect(f.llm.select).toHaveBeenCalledTimes(2)
      expect(f.llm.decompose).toHaveBeenCalledTimes(1)
      expect(f.provider.execute).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })
  it('cancellation after certified non-delivery does not dispatch another command', async () => {
    const f = recoveryFixture(), controller = new AbortController()
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async c => {
      controller.abort()
      return { commandId: c.commandId, outcome: 'not_executed', code: 'stale_observation' }
    })
    expect(await new NativeComputerOrchestrator(f).run({ ...f.options, signal: controller.signal })).toMatchObject({ outcome: 'cancelled', actions: 1 })
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
    expect(f.llm.verify).not.toHaveBeenCalled()
  })
  it.each(['stopped', 'stopped-during-observe', 'authority', 'permission', 'foreign-window', 'foreign-identity', 'background', 'old-observation'] as const)('cannot recover across %s', async denied => {
    const f = recoveryFixture(), observe = f.provider.observe
    f.llm.vision = { nativeGrounding: true, propose: vi.fn(async () => null) }
    let stale = false
    f.provider.observe = vi.fn(async (c, signal) => {
      const o = await observe(c, signal)
      if (!stale) return o
      if (denied === 'stopped-during-observe') f.status.state = 'stopped'
      if (denied === 'foreign-window') o.target = { ...o.target, windowInstanceId: 'other' }
      if (denied === 'foreign-identity') o.identity = { ...o.identity, sessionId: 'other' }
      if (denied === 'background') o.foreground = false
      if (denied === 'old-observation') o.id = 'o1'
      return o
    })
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async c => {
      stale = true
      if (denied === 'stopped') f.status.state = 'stopped'
      if (denied === 'permission') f.status.capabilities.accessibilityPermission = 'denied'
      if (denied === 'authority') f.options.authority.assertCurrent.mockRejectedValue(new Error('revoked'))
      return { commandId: c.commandId, outcome: 'not_executed', code: 'stale_observation' }
    })
    expect(await new NativeComputerOrchestrator(f).run(f.options)).toMatchObject({ outcome: 'paused', actions: 1 })
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
    expect(f.llm.select).toHaveBeenCalledTimes(1)
    expect(f.llm.vision.propose).not.toHaveBeenCalled()
  })
  it.each([false, true])('Stop during inference refresh forbids dispatch (changed state: %s)', async changed => {
    const f = recoveryFixture(), observe = f.provider.observe
    let seq = 0
    f.provider.observe = vi.fn(async (c, signal) => {
      const o = await observe(c, signal)
      if (++seq === 1) return { ...o, capturedAt: Date.now() - 2000 }
      f.status.state = 'stopped'
      if (changed) o.nodes[0]!.name = 'changed'
      return o
    })
    expect(await new NativeComputerOrchestrator(f).run(f.options)).toMatchObject({ outcome: 'paused', actions: 0 })
    expect(f.provider.execute).not.toHaveBeenCalled()
    expect(f.llm.select).toHaveBeenCalledTimes(1)
  })
  it.each(['unknown', 'mismatched-stale', 'transport', 'executed-stale', 'denied', 'unsupported', 'transport_error', 'stopped', 'wrong_target', 'expired'] as const)('never recovers a %s receipt/failure', async failure => {
    const f = recoveryFixture()
    f.llm.vision = { nativeGrounding: true, propose: vi.fn(async () => null) }
    f.provider.execute = vi.fn<NativeComputerProvider['execute']>(async c => {
      if (failure === 'transport') throw new Error('lost receipt')
      if (failure === 'unknown') return { commandId: c.commandId, outcome: 'execution_unknown', code: 'stale_observation' }
      if (failure === 'mismatched-stale') return { commandId: 'wrong-command', outcome: 'not_executed', code: 'stale_observation' }
      if (failure === 'executed-stale') return { commandId: c.commandId, outcome: 'executed', code: 'stale_observation' }
      return { commandId: c.commandId, outcome: 'not_executed', code: failure }
    })
    const unknown = ['unknown', 'mismatched-stale', 'transport'].includes(failure), loop = new NativeComputerOrchestrator(f)
    expect(await loop.run(f.options)).toMatchObject({ outcome: unknown ? 'execution_unknown' : 'paused', actions: 1 })
    if (unknown) expect((await loop.run(f.options)).outcome).toBe('execution_unknown')
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
    expect(f.llm.select).toHaveBeenCalledTimes(1)
    expect(f.llm.verify).not.toHaveBeenCalled()
    expect(f.llm.vision.propose).not.toHaveBeenCalled()
  })
})

describe('native decision context byte admission', () => {
  function contextFixture(progress: boolean, values: string[], profile?: DecisionEvaluationProfile) {
    const f = fixture(); let seq = 0
    f.provider.observe = vi.fn(async () => {
      const o = f.observation(); seq++
      const nodes: NativeObservation['nodes'] = progress && seq === 1
        ? [{ ...o.nodes[0]!, actions: ['setValue'] }]
        : values.map((value, i) => ({ ...o.nodes[0]!, ref: `r${i}`, name: `Field ${i}`, value, actions: i === 0 ? ['select'] : [] }))
      return { ...o, id: `o${seq}`, monotonicMs: seq, nodes }
    })
    f.llm.plan = vi.fn<NonNullable<NativeLlmAdapter['plan']>>(async input => [{ id: 'generated', action: { kind: 'setValue', target: input.observation.target, observationId: input.observation.id, ref: input.observation.nodes[0]!.ref, text: 'generated' } }])
    f.llm.verify = progress ? vi.fn() : undefined
    f.llm.vision = { nativeGrounding: true, propose: vi.fn(async () => null) }
    const inferenceBudget = { reserve: vi.fn<NativeInferenceBudget['reserve']>(async () => true) }
    const runtime: NativeDecisionRuntime = {
      resolveRoute: vi.fn(async () => ({ mode: 'llm_only' as const, profile })), observe: vi.fn(),
      run: async ({ request, operation }) => ({ runId: request.runId, result: operation.validateResult((progress ? 'complete' : 'c0') as never), path: 'llm_only', attempts: 1 }),
    }
    vi.spyOn(runtime, 'run')
    const run = () => new NativeComputerOrchestrator({ ...f, decisionRuntime: runtime, inferenceBudget }).run(f.options)
    return { ...f, runtime, inferenceBudget, run }
  }
  it.each([
    [false, 'multi-byte', Array(6).fill('界'.repeat(1500))],
    [true, 'multi-byte', Array(6).fill('界'.repeat(1500))],
    [false, 'JSON escapes', Array(6).fill('\u0001'.repeat(1000))],
    [true, 'JSON escapes', Array(6).fill('\u0001'.repeat(1000))],
    [false, '500 full values', Array(500).fill('x'.repeat(4096))],
    [true, '500 full values', Array(500).fill('x'.repeat(4096))],
  ] as const)('rejects %s progress / %s context before decision reservation, without truncation or CV', async (progress, _name, values) => {
    const f = contextFixture(progress, values)
    expect(await f.run()).toMatchObject({ outcome: 'paused', actions: progress ? 1 : 0 })
    expect(f.runtime.run).not.toHaveBeenCalled()
    expect(f.inferenceBudget.reserve.mock.calls.some(([input]) => input.lane === 'decision')).toBe(false)
    expect(f.provider.execute).toHaveBeenCalledTimes(progress ? 1 : 0)
    expect(f.llm.select).not.toHaveBeenCalled()
    expect(f.llm.vision!.propose).not.toHaveBeenCalled()
    if (progress) expect(f.llm.verify).not.toHaveBeenCalled()
    else expect(f.llm.plan).not.toHaveBeenCalled()
  })
  it.each([false, true])('preserves all fields, goal, choices and questions below the bound (progress: %s)', async progress => {
    const values = Array.from({ length: 6 }, (_, i) => `required-${i}:` + '界\n"'.repeat(150))
    const f = contextFixture(progress, values)
    f.options.goal = 'Complete ALL six required fields, including the last field'
    // A model's complete classification cannot bypass the full-goal policy.
    f.policy.isComplete = o => o.nodes.every(n => n.selected) && o.nodes.at(-1)?.value === values.at(-1)
    expect(await f.run()).toMatchObject({ outcome: 'completed', actions: 1 })
    expect(f.runtime.run).toHaveBeenCalledTimes(1)
    const { request } = vi.mocked(f.runtime.run).mock.calls[0]![0]
    const state = request.state as { goal: string; nodes: NativeObservation['nodes']; candidates?: unknown[] }
    expect(state.goal).toBe(f.options.goal)
    expect(state.nodes.map(n => n.value)).toEqual(values)
    expect(state.nodes.map(n => n.ref)).toEqual(values.map((_, i) => `r${i}`))
    expect(request.questions[0]).toMatchObject({ kind: 'choice', prompt: expect.any(String), options: progress ? [{ value: 'complete' }, { value: 'continue' }, { value: 'abstain' }, { value: 'ask_user' }] : [{ value: 'c0' }, { value: 'abstain' }, { value: 'ask_user' }] })
    if (!progress) expect(state.candidates).toEqual([{ id: 'c0', action: 'select', ref: 'r0' }])
  })
  it('keeps an unmet final field in progress evidence and cannot declare partial goal completion', async () => {
    const f = contextFixture(true, ['done', 'still unmet'])
    f.policy.isComplete = o => o.nodes.length === 2 && o.nodes[1]!.value === 'done'
    expect(await f.run()).toMatchObject({ outcome: 'paused', actions: 1, reason: 'Completion evidence contradicted or incomplete' })
    const state = vi.mocked(f.runtime.run).mock.calls[0]![0].request.state as { nodes: NativeObservation['nodes'] }
    expect(state.nodes.map(n => n.value)).toEqual(['done', 'still unmet'])
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])('bounds the full request envelope plus profile at exactly 24000 UTF-8 bytes (progress: %s)', async progress => {
    const profile: DecisionEvaluationProfile = { id: 'native', version: '1', mode: 'hybrid', operationId: progress ? 'computer.verify-progress' : 'computer.next-action', operationVersion: '1', stateVersion: (progress ? NATIVE_VERIFY_PROGRESS : NATIVE_NEXT_ACTION).stateVersion, questionVersion: '1', modelCatalogId: 'jev', modelWireId: 'pinned', evaluationSegment: 'global', status: 'approved', evidence: 'recorded', totalTimeoutMs: 1000, primaryTimeoutMs: 500, maxAttempts: 2, policy: { padding: '' } }
    const baseline = contextFixture(progress, ['value'], profile)
    await baseline.run()
    const { request, workspaceId } = vi.mocked(baseline.runtime.run).mock.calls[0]![0]
    const size = Buffer.byteLength(JSON.stringify({ workspaceId, request, profile }), 'utf8')
    for (const extra of [0, 1]) {
      const boundaryProfile = { ...profile, policy: { padding: 'x'.repeat(24000 - size + extra) } }
      const f = contextFixture(progress, ['value'], boundaryProfile)
      expect(await f.run()).toMatchObject({ outcome: extra === 0 ? 'completed' : 'paused' })
      expect(f.runtime.run).toHaveBeenCalledTimes(extra === 0 ? 1 : 0)
      expect(f.inferenceBudget.reserve.mock.calls.filter(([input]) => input.lane === 'decision')).toHaveLength(extra === 0 ? 1 : 0)
      expect(f.provider.execute).toHaveBeenCalledTimes(progress || extra === 0 ? 1 : 0)
    }
  })
})

describe('native decision gate', () => {
  const profile = { id: 'native', version: '1', mode: 'hybrid' as const, operationId: 'computer.next-action', operationVersion: '1', stateVersion: NATIVE_NEXT_ACTION.stateVersion, questionVersion: '1', modelCatalogId: 'jev', modelWireId: 'pinned', evaluationSegment: 'global', status: 'approved' as const, evidence: 'recorded' as const, totalTimeoutMs: 1000, primaryTimeoutMs: 500, maxAttempts: 2 as const, policy: { minProbability: 0.95 } }
  it('requires exact approved recorded profile and pinned model', () => {
    expect(approvedNativeProfile(profile, { catalogId: 'jev', wireId: 'pinned' })).toBe(true)
    expect(approvedNativeProfile({ ...profile, status: 'operator_override' })).toBe(false)
    expect(approvedNativeProfile({ ...profile, questionVersion: '2' })).toBe(false)
    expect(approvedNativeProfile({ ...profile, stateVersion: '1' })).toBe(false)
    expect(approvedNativeProfile({ ...profile, stateVersion: '2' })).toBe(false)
    expect(approvedNativeProfile({ ...profile, stateVersion: '3' })).toBe(false)
    expect(approvedNativeProfile({ ...profile, operationId: 'unknown' }, undefined, 'unknown')).toBe(false)
    expect(approvedNativeProfile(profile, { catalogId: 'jev', wireId: 'new' })).toBe(false)
    const f = fixture(); const input = { goal: 'select', observation: f.observation(), candidates: [], signal: f.options.signal, deadlineAt: f.options.deadlineAt }
    const response = { providerId: 'jev', model: { catalogId: 'jev', wireId: 'pinned' }, answers: [{ kind: 'choice' as const, questionId: 'next', value: 'abstain', evidence: { source: 'native_distribution' as const, probabilities: { abstain: 1 } } }] }
    expect(createNativeDecisionOperation(input, f.llm, false).decide(response, { profile }).kind).toBe('follow_up')
    expect(createNativeDecisionOperation(input, f.llm, true).decide(response, { profile }).kind).toBe('complete')
    expect(createNativeDecisionOperation(input, f.llm, true).decide(response, { profile: { ...profile, stateVersion: '3' } }).kind).toBe('follow_up')
  })
  it.each(['llm_only', 'shadow', 'hybrid'] as const)('composes existing runtime in %s mode, rejecting operatorOverride', async mode => {
    const f = fixture()
    const runtime: NativeDecisionRuntime = {
      resolveRoute: async () => ({ mode, profile, operatorOverride: true }),
      observe: vi.fn(),
      run: async ({ operation }) => {
        const disposition = operation.decide({ providerId: 'jev', model: { catalogId: 'jev', wireId: 'pinned' }, answers: [{ questionId: 'next', kind: 'choice', value: 'c0', evidence: { source: 'native_distribution', probabilities: { c0: 1 } } }] }, { profile })
        expect(disposition.kind).toBe('follow_up')
        // Emulate runtime LLM lane (real Hydra signature is exercised through operation).
        return { runId: 'r', result: operation.validateResult('c0' as never), attempts: 2, path: 'uncertainty_review' }
      },
    }
    expect((await new NativeComputerOrchestrator({ ...f, decisionRuntime: runtime }).run(f.options)).outcome).toBe('completed')
  })
  it.each(['llm_only', 'shadow', 'hybrid'] as const)('runs real Hydra %s with one executor and correct LLM routing', async mode => {
    const f = fixture()
    const routeProfile = { ...profile, modelCatalogId: 'pinned', mode: mode === 'shadow' ? 'shadow' as const : 'hybrid' as const, shadowSampleRate: 1 }
    const primary = {
      id: 'jev', supportsNativeStrict: true as const,
      capabilities: { primitives: ['choice'] as const, batch: true, maxOptions: 32, maxQuestions: 1, maxRubricLevels: 0, maxInputTokens: 10000, uncertainty: ['native_distribution'] as const },
      evaluate: vi.fn(async () => ({ providerId: 'jev', nativeMetadata: { actualModel: 'pinned', usage: { inputTokens: 1, outputTokens: 1 } }, model: { catalogId: 'jev', wireId: 'pinned' }, answers: [{ questionId: 'next', kind: 'choice' as const, value: 'c0', evidence: { source: 'native_distribution' as const, probabilities: { c0: 1 } } }] })),
    }
    const runtime: NativeDecisionRuntime = {
      resolveRoute: async () => ({ mode, profile: routeProfile }),
      observe: vi.fn(),
      run: ({ request, operation }) => executeDecisionCascade({
        request: { ...request, model: { catalogId: 'pinned', wireId: 'pinned' } },
        route: { mode, profile: routeProfile, primary },
        operation: { ...operation, completeWithLlm: context => operation.completeWithLlm({ ...context, llm: {} as DecisionCompletionRoute }) },
      }),
    }
    expect((await new NativeComputerOrchestrator({ ...f, decisionRuntime: runtime }).run(f.options)).outcome).toBe('completed')
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
    expect(f.llm.select).toHaveBeenCalledTimes(mode === 'hybrid' ? 0 : 1)
    expect(primary.evaluate).toHaveBeenCalledTimes(mode === 'llm_only' ? 0 : 1)
  })
  it('progress has separate versioned profile authority; next-action approval cannot approve progress', () => {
    const f = fixture(), input = { goal: 'select', observation: f.observation(), candidates: [], signal: f.options.signal, deadlineAt: f.options.deadlineAt }
    const response = { providerId: 'jev', model: { catalogId: 'jev', wireId: 'pinned' }, answers: [{ questionId: 'next', kind: 'choice' as const, value: 'complete', evidence: { source: 'native_distribution' as const, probabilities: { complete: 1 } } }] }
    const op = createNativeProgressOperation(input, f.llm, true)
    expect(op.decide(response, { profile }).kind).toBe('follow_up')
    const progressProfile = { ...profile, operationId: NATIVE_VERIFY_PROGRESS.id, stateVersion: NATIVE_VERIFY_PROGRESS.stateVersion }
    expect(NATIVE_NEXT_ACTION.stateVersion).toBe('4')
    expect(NATIVE_VERIFY_PROGRESS.stateVersion).toBe('3')
    expect(op.decide(response, { profile: progressProfile }).kind).toBe('complete')
    expect(op.decide(response, { profile: { ...progressProfile, stateVersion: '4' } }).kind).toBe('follow_up')
    expect(op.decide(response, { profile: { ...progressProfile, stateVersion: '1' } }).kind).toBe('follow_up')
    expect(op.decide(response, { profile: { ...progressProfile, stateVersion: '2' } }).kind).toBe('follow_up')
    expect(op.decide(response, { profile: { ...progressProfile, status: 'operator_override' } }).kind).toBe('follow_up')
    expect(op.decide({ ...response, model: { catalogId: 'jev', wireId: 'other' } }, { profile: progressProfile }).kind).toBe('follow_up')
  })
  it.each(['llm_only', 'shadow', 'hybrid'] as const)('routes progress through real Hydra %s and still rejects contradicted local postconditions', async mode => {
    const f = fixture(); let seq = 0
    f.provider.observe = vi.fn(async () => ({ ...f.observation(), id: `o${++seq}`, monotonicMs: seq }))
    f.policy.isComplete = () => false
    f.llm.verify = vi.fn(async () => ({ result: 'complete', providerId: 'llm', model: { catalogId: 'test', wireId: 'test' } }))
    const seen: string[] = []
    const runtime: NativeDecisionRuntime = {
      resolveRoute: async ({ operation }) => ({ mode, profile: { ...profile, modelCatalogId: 'pinned', mode: mode === 'shadow' ? 'shadow' : 'hybrid', operationId: operation.id, stateVersion: operation.stateVersion, shadowSampleRate: 1 } }), observe: vi.fn(),
      run: ({ request, operation }) => {
        seen.push(request.operation.id)
        const value = request.operation.id === NATIVE_VERIFY_PROGRESS.id ? 'complete' : 'c0'
        return executeDecisionCascade({ request: { ...request, model: { catalogId: 'pinned', wireId: 'pinned' } }, route: { mode,
          profile: { ...profile, modelCatalogId: 'pinned', mode: mode === 'shadow' ? 'shadow' : 'hybrid', operationId: request.operation.id, stateVersion: request.operation.stateVersion, shadowSampleRate: 1 },
          primary: { id: 'jev', supportsNativeStrict: true, capabilities: { primitives: ['choice'], batch: true, maxOptions: 32, maxQuestions: 1, maxRubricLevels: 0, maxInputTokens: 10000, uncertainty: ['native_distribution'] },
            evaluate: async () => ({ providerId: 'jev', nativeMetadata: { actualModel: 'pinned', usage: { inputTokens: 1, outputTokens: 1 } }, model: { catalogId: 'jev', wireId: 'pinned' }, answers: [{ questionId: 'next', kind: 'choice', value, evidence: { source: 'native_distribution', probabilities: { [value]: 1 } } }] }) },
        }, operation: { ...operation, completeWithLlm: context => operation.completeWithLlm({ ...context, llm: {} as DecisionCompletionRoute }) } })
      },
    }
    const result = await new NativeComputerOrchestrator({ ...f, decisionRuntime: runtime }).run(f.options)
    expect(result).toMatchObject({ outcome: 'paused', actions: 1, reason: 'Completion evidence contradicted or incomplete' })
    expect(seen).toEqual(['computer.next-action', 'computer.verify-progress'])
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
    expect(f.llm.verify).toHaveBeenCalledTimes(mode === 'hybrid' ? 0 : 1)
  })
  it('rejects receipt-only completion and stale progress observations', async () => {
    const f = fixture()
    f.llm.verify = vi.fn(async () => ({ result: 'complete', providerId: 'llm', model: { catalogId: 'test', wireId: 'test' } }))
    expect(await new NativeComputerOrchestrator(f).run(f.options)).toMatchObject({ outcome: 'paused', actions: 1, reason: 'No fresh post-action evidence' })
    expect(f.llm.verify).not.toHaveBeenCalled()
  })
  it('falls back to generation after a pre-dispatch selection failure only', async () => {
    const f = fixture()
    vi.mocked(f.llm.select).mockRejectedValueOnce(new Error('model timeout')).mockResolvedValueOnce({ result: 'p0', providerId: 'llm', model: { catalogId: 'test', wireId: 'test' } })
    f.llm.plan = vi.fn(async input => input.candidates)
    expect(await new NativeComputerOrchestrator(f).run(f.options)).toMatchObject({ outcome: 'completed', actions: 1 })
    expect(f.llm.plan).toHaveBeenCalledTimes(1)
    expect(f.llm.select).toHaveBeenCalledTimes(1)
    expect(f.provider.execute).toHaveBeenCalledTimes(1)
  })
  it('projects both primary operations from full raw state without dropping candidates, ancestors or frozen objectives', async () => {
    const f = fixture(); f.options.authority.target.appId = 'org.gnome.gedit'
    let seq = 0
    f.provider.observe = vi.fn(async () => {
      const o = f.observation(); seq++
      const passive = { ...o.nodes[0]!, role: 'label', focused: false, actions: [] as NativeObservation['nodes'][number]['actions'], value: 'x'.repeat(200) }
      return { ...o, id: `o${seq}`, monotonicMs: seq, nodes: [
        { ...passive, ref: 'root', role: 'window', name: 'Document window' },
        { ...o.nodes[0]!, parentRef: 'root' },
        { ...passive, ref: 'result', parentRef: 'root', name: 'Result', value: 'ready' },
        ...Array.from({ length: 230 }, (_, i) => ({ ...passive, ref: `chrome${i}`, parentRef: 'root' })),
      ] }
    })
    f.llm.contextObjectives = vi.fn<NonNullable<NativeLlmAdapter['contextObjectives']>>(input => {
      expect(input.observation.nodes).toHaveLength(233)
      return [{ role: 'label', name: 'Result', property: 'value', equals: 'ready' }]
    })
    f.llm.verify = vi.fn()
    const requests: string[] = []
    const runtime: NativeDecisionRuntime = {
      resolveRoute: async ({ operation }) => ({ mode: 'hybrid', profile: { ...profile, operationId: operation.id, stateVersion: operation.stateVersion } }), observe: vi.fn(),
      run: async ({ request, operation }) => {
        requests.push(request.operation.id)
        const state = request.state as { nodes: NativeObservation['nodes']; context: { omittedPassiveNodes: number }; candidates?: unknown[] }
        expect(state.context.omittedPassiveNodes).toBe(230)
        expect(state.nodes.map(n => n.ref)).toEqual(['root', 'r', 'result'])
        expect(state.nodes[1]!.parentRef).toBe('root')
        expect(state.nodes[2]!.value).toBe('ready')
        expect(request.operation.stateVersion).toBe(request.operation.id === NATIVE_NEXT_ACTION.id ? '4' : '3')
        const value = request.operation.id === NATIVE_VERIFY_PROGRESS.id ? 'complete' : 'c0'
        if (value === 'c0') expect(state.candidates).toEqual([{ id: 'c0', action: 'select', ref: 'r' }])
        const disposition = operation.decide({ providerId: 'jev', model: { catalogId: 'jev', wireId: 'pinned' }, answers: [{ questionId: 'next', kind: 'choice', value, evidence: { source: 'native_distribution', probabilities: { [value]: 1 } } }] }, { profile: { ...profile, operationId: request.operation.id, stateVersion: request.operation.stateVersion } })
        if (disposition.kind !== 'complete') throw new Error('Expected exact approved primary')
        return { runId: request.runId, result: operation.validateResult(disposition.result), attempts: 1, path: 'primary_complete' }
      },
    }
    expect(await new NativeComputerOrchestrator({ ...f, decisionRuntime: runtime }).run(f.options)).toMatchObject({ outcome: 'completed', actions: 1 })
    expect(requests).toEqual(['computer.next-action', 'computer.verify-progress'])
    expect(f.llm.select).not.toHaveBeenCalled()
    expect(f.llm.verify).not.toHaveBeenCalled()
  })
  it('cost/token admission denial prevents inference and execution', async () => {
    const f = fixture()
    const inferenceBudget = { reserve: vi.fn(async () => false) }
    expect((await new NativeComputerOrchestrator({ ...f, inferenceBudget }).run(f.options)).actions).toBe(0)
    expect(f.llm.select).not.toHaveBeenCalled()
    expect(f.provider.execute).not.toHaveBeenCalled()
  })

})
