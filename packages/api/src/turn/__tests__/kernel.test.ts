import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const leaseCalls: string[] = []
vi.mock('../../db/notify-listener.js',()=>({registerNotifyChannel:vi.fn(),startNotifyListener:vi.fn()}))
vi.mock('../../db/sessions.js',()=>{
 const claim=vi.fn(async(..._args:any[])=>{leaseCalls.push('claim');return 'tok-1' as string|null})
 const release=vi.fn(async(..._args:any[])=>{leaseCalls.push('release');return true})
 return{claimTurnLease:claim,releaseTurnLease:release,
  claimTurnLeaseOutcome:vi.fn(async(id,assistant,started)=>{let recovered:any;const token=await claim(id,assistant,started,(r:any)=>{recovered=r});return token?{token,turnId:null,...recovered?{recovered}:{}}:null}),
  releaseTurnOutcome:vi.fn(async(id,reason,token)=>await release(id,reason,token)?{turnId:null,reason}:null),
  touchTurnLease:vi.fn(async()=>{leaseCalls.push('touch');return{held:true,cancelRequested:false}}),TURN_HEARTBEAT_INTERVAL_MS:5,
  addSessionMessage:vi.fn(async(row:any)=>({id:'fixture-row',sequenceNum:1,createdAt:new Date(),...row}))}
})

let simulateModelBoundaries = false
let loopBeforeEvent: ((index: number) => void) | null = null
let loopEvents: unknown[] = []
let loopThrows: Error | null = null
let loopCleanup: (() => Promise<void>) | null = null
const loopOptions: Array<Record<string, unknown>> = []
vi.mock('@use-brian/core/engine/query-loop-defaults.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@use-brian/core/engine/query-loop-defaults.js')>()
  const { assertModelOutputAuthority } = await import('@use-brian/agent-runtime/engine/query-loop.js')
  return {
    ...actual,
    queryLoop: vi.fn(async function* (options: Record<string, unknown>) {
      loopOptions.push(options)
      const context = options.context as import('@use-brian/agent-runtime/tools/types.js').ToolContext
      if (simulateModelBoundaries) await context.admitModelInput?.(context)
      for (const [index, event] of loopEvents.entries()) {
        loopBeforeEvent?.(index)
        if (options.dispatchOutput) await (options.dispatchOutput as (current: import('@use-brian/agent-runtime/tools/types.js').ToolContext, event: unknown) => Promise<void>)(context, event)
        else {
          if (simulateModelBoundaries) await assertModelOutputAuthority(context)
          yield event
        }
      }
      await loopCleanup?.()
      if (loopThrows) throw loopThrows
    }),
  }
})

const {admitModelInput,admitModelOutput}=vi.hoisted(()=>({admitModelInput:vi.fn(),admitModelOutput:vi.fn()}))
vi.mock('../../application-platform/model-source-authority.js',()=>({
 admitModelSourceEvidence: (context:unknown,action:string)=>action==='context'?admitModelInput(context):admitModelOutput(context),
}))
vi.mock('../../context-scope/attended-audience.js', () => ({
  admitAttendedAudienceEvidence: vi.fn(), createAttendedDeliveryAudienceAuthorizer: vi.fn(),
}))

import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { createExecutionContext, executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import type { Session } from '../../db/sessions.js'
import { createTurnDeliveryAdmission } from '../../context-scope/admission.js'
import { admitAttendedAudienceEvidence, createAttendedDeliveryAudienceAuthorizer } from '../../context-scope/attended-audience.js'
import { TurnRefusal, servedTurnModel, turnUsageIdentity, type TurnSinkKind } from '../kernel.js'
import { runAssistantTurn, openAssistantTurn } from './fixtures/owned-turn.js'
import { resolveTurnBilling } from '../billing.js'
import { claimTurnLease, touchTurnLease, releaseTurnLease } from '../../db/sessions.js'
import { AuthorityChangedError } from '../../context-scope/authority-lease.js'
import {turnAbortKind,TurnLeaseLostError,TurnStoppedError,abortLocalTurn} from '../lease.js'
import {localTurnInboxAssistant} from '../../turn-inbox.js'

const textTurn = (text: string) => ({
  type: 'assistant_turn',
  response: { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
})

function params(sink: TurnSinkKind, over: Partial<Parameters<typeof runAssistantTurn>[0]> = {}) {
  return {
    sessionId: 's-1',
    policy: { admission: 'personal' as const },
    sink: { kind: sink },
    abortController: new AbortController(),
    model: { provider: {} as never, model: 'gemini-flash', configuredProviders: undefined, customLlm: null },
    loop: { ledger: {} as never, systemPrompt: '', messages: [], tools: new Map(), context: {} as never },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  leaseCalls.length = 0
  simulateModelBoundaries = false
  loopBeforeEvent = null
  vi.mocked(admitModelInput).mockReset().mockResolvedValue(undefined)
  vi.mocked(admitModelOutput).mockReset().mockResolvedValue(undefined)
  vi.mocked(admitAttendedAudienceEvidence).mockReset().mockImplementation(async (execution, evidence) => { await execution.security.authority.assertCurrent(); return evidence })
  vi.mocked(createAttendedDeliveryAudienceAuthorizer).mockReset().mockReturnValue(vi.fn(async () => { throw new Error('Unexpected independent-source fallback') }))
  loopEvents = []
  loopThrows = null
  loopCleanup = null
  loopOptions.length = 0
  vi.mocked(claimTurnLease).mockImplementation(async () => { leaseCalls.push('claim'); return 'tok-1' })
})

describe('[COMP:api/turn-kernel] runAssistantTurn', () => {
  it('refuses an already cancelled admission without claiming',async()=>{
    const controller=new AbortController(),reason=new TurnStoppedError();controller.abort(reason)
    await expect(openAssistantTurn(params('sse',{abortController:controller}))).rejects.toBe(reason)
    expect(claimTurnLease).not.toHaveBeenCalled()
  })
  it('releases the exact acquired owner when cancellation races its claim',async()=>{
    const controller=new AbortController(),reason=new TurnStoppedError()
    vi.mocked(claimTurnLease).mockImplementationOnce(async()=>{controller.abort(reason);return 'original-raced-token'})
    await expect(openAssistantTurn(params('sse',{abortController:controller}))).rejects.toBe(reason)
    expect(releaseTurnLease).toHaveBeenCalledWith(expect.any(String),'stopped_by_user','original-raced-token')
  })

  it('announces an actual predecessor recovery before cleaning an aborted successor claim',async()=>{
    const controller=new AbortController(),reason=new TurnStoppedError(),recovered={turnId:'a'.repeat(64),reason:'publication_recovered' as const}
    const {claimTurnLeaseOutcome}=await import('../../db/sessions.js')
    vi.mocked(claimTurnLeaseOutcome).mockImplementationOnce(async()=>{controller.abort(reason);return{token:'new-raced-token',turnId:'b'.repeat(64),recovered}})
    const notify=vi.fn(()=>{expect(leaseCalls).not.toContain('release')})
    await expect(openAssistantTurn({...params('sse',{abortController:controller}),onReclaimed:notify})).rejects.toBe(reason)
    expect(notify).toHaveBeenCalledWith(recovered)
    expect(releaseTurnLease).toHaveBeenCalledWith(expect.any(String),'stopped_by_user','new-raced-token')
  })

  it('captures only original producer usage through output refusal and exposes detached facts for finally', async () => {
    const owner=await openAssistantTurn(params('sse'))
    const failure=new AuthorityChangedError(),snapshot={model:'fixture',totalUsage:{inputTokens:7,outputTokens:3}}
    loopBeforeEvent=()=>{(loopOptions.at(-1)!.observeUsage as (s:unknown)=>void)(snapshot)}
    loopEvents=[textTurn('Must be refused')]
    await expect(owner.run(params('sse',{sink:{kind:'sse',onEvent:()=>{throw failure}}}))).rejects.toBe(failure)
    snapshot.totalUsage.inputTokens=999
    expect(owner.usage).toEqual({model:'fixture',totalUsage:{inputTokens:7,outputTokens:3}})
    owner.usage!.totalUsage.inputTokens=123
    await owner.finish('failed')
    expect(owner.usage!.totalUsage.inputTokens).toBe(7)
    expect(owner.hasCommittedTerminalReply()).toBe(false)
  })

  it('settles reply presentation before delayed cleanup while keeping publication and lease held', async () => {
    const response = textTurn('Hello.').response
    loopEvents = [textTurn('Hello.'), { type: 'turn_complete', response, totalUsage: response.usage }]
    let finishCleanup!: () => void
    loopCleanup = () => new Promise<void>(resolve => { finishCleanup = resolve })
    const textComplete = vi.fn(), publish = vi.fn()
    const run = runAssistantTurn(params('sse', { sink: {
      kind: 'sse', onReplyTextComplete: textComplete, afterLoop: publish,
    } }))
    await vi.waitFor(() => expect(textComplete).toHaveBeenCalledOnce())
    expect(publish).not.toHaveBeenCalled()
    expect(leaseCalls).not.toContain('release')
    finishCleanup()
    await run
    expect(publish).toHaveBeenCalledOnce()
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('does not announce intermediate text, narration or output refused at the sink', async () => {
    const response = textTurn('Hello.').response
    for (const terminal of [false, true]) {
      loopEvents = [textTurn('Hello.')]
      if (terminal) loopEvents.push({ type: 'turn_complete', response, totalUsage: response.usage })
      const textComplete = vi.fn()
      const options = params('sse', { sink: { kind: 'sse', onReplyTextComplete: textComplete,
        ...(terminal ? { admitOutput: async () => { throw new AuthorityChangedError() } } : {}),
      } })
      if (terminal) {
        const authority = { assertCurrent: async () => {}, async execute<T>(operation: () => Promise<T>) { return operation() } }, executionContext = { security: { authority } }
        options.loop.context = { authority, executionContext, scopeAccumulator: { evidence: {} } } as never
      }
      if (terminal) await expect(runAssistantTurn(options)).rejects.toBeInstanceOf(AuthorityChangedError)
      else await runAssistantTurn(options)
      expect(textComplete).not.toHaveBeenCalled()
    }
    const narration = { ...response, content: [{ type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call', name: 'search', input: {} }] }
    loopEvents = [{ type: 'assistant_turn', response: narration },
      { type: 'turn_complete', response: narration, totalUsage: response.usage }]
    const textComplete = vi.fn()
    await runAssistantTurn(params('sse', { sink: { kind: 'sse', onReplyTextComplete: textComplete } }))
    expect(textComplete).not.toHaveBeenCalled()
  })

  it('provides the actual engine event kind to an adapter before dispatch', async () => {
    const options = params('adapter')
    const authority = { assertCurrent: async () => {}, async execute<T>(operation: () => Promise<T>) { return operation() } }
    const executionContext = { security: { authority } }
    options.loop.context = { authority, executionContext, scopeAccumulator: { evidence: {} } } as never
    loopEvents = [{ type: 'text_delta', text: 'Private buffer' }, textTurn('Final buffer')]
    const seen: string[] = []
    options.sink = {
      kind: 'adapter',
      admitOutput: async (_context, eventKind) => { seen.push(eventKind ? `admit:${eventKind}` : 'admit:final-result') },
      onEvent: event => { seen.push(`dispatch:${event.type}`) },
    }
    await runAssistantTurn(options)
    expect(seen).toEqual(['admit:text_delta', 'dispatch:text_delta', 'admit:assistant_turn', 'dispatch:assistant_turn', 'admit:final-result'])
  })

  it('distinguishes a refused follow-up after a published reply from a failed publication', async () => {
    for (const publicationFails of [false, true]) {
      loopEvents = [textTurn('hello')]
      const abortController = new AbortController()
      const boundary = await openAssistantTurn(params('sse', {abortController}))
      const laterWork = vi.fn()
      let failure: unknown
      try {
        await boundary.run(params('sse', { abortController, sink: {
          kind: 'sse', afterLoop: async result => {
            boundary.beginFinalization(result, false)
            if (publicationFails) throw new AuthorityChangedError()
            await boundary.publish({ disposition: 'reply', rows: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
              write: { scope: {} as never }, execute: operation => operation() })
            throw new AuthorityChangedError()
          },
        } }))
        laterWork()
      } catch (error) { failure = error } finally { await boundary.finish() }
      expect(laterWork).not.toHaveBeenCalled()
      expect(leaseCalls.at(-1)).toBe('release')
      expect(boundary.notice(failure)?.code ?? null)
        .toBe(publicationFails ? null : 'post_reply_authority_changed')
    }
  })

  for (const sink of ['sse', 'adapter', 'json', 'return', 'none'] as const) {
    it(`${sink} sink: takes the lease, runs, and releases it on success`, async () => {
      loopEvents = [textTurn('hello')]
      await runAssistantTurn(params(sink))
      expect(leaseCalls[0]).toBe('claim')
      expect(leaseCalls.at(-1)).toBe('release')
    })
  }

  it('releases the lease when the loop throws, and re-throws', async () => {
    loopThrows = new Error('provider exploded')
    await expect(runAssistantTurn(params('adapter'))).rejects.toThrow('provider exploded')
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('releases the lease when the sink throws', async () => {
    loopEvents = [textTurn('x')]
    await expect(runAssistantTurn(params('sse', { sink: { kind: 'sse', onEvent: () => { throw new Error('sink') } } })))
      .rejects.toThrow('sink')
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('refuses a route output hook that replaces the invocation before final sink handling',async () => {
    const afterLoop = vi.fn(),context = { scopeAccumulator: undefined,
      admitModelOutput: async (current: { scopeAccumulator?: unknown }) => { current.scopeAccumulator = {} } }
    await expect(runAssistantTurn(params('return',{ loop: { ...params('return').loop,context: context as never },
      sink: { kind: 'return',afterLoop } }))).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    expect(afterLoop).not.toHaveBeenCalled()
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('refuses a preaborted wrapper before claiming or running a provider', async () => {
    const abortController = new AbortController()
    abortController.abort()
    await expect(runAssistantTurn(params('adapter', { abortController }))).rejects.toBe(abortController.signal.reason)
    expect(leaseCalls).toEqual([])
    expect(loopOptions).toEqual([])
  })

  it('refuses a hook replacing the checked lease even when the original context remains unchanged', async () => {
    const authority = { assertCurrent: async () => {}, async execute<T>(operation: () => Promise<T>) { return operation() } }, executionContext = { security: { authority } }
    const seen = vi.fn(), afterLoop = vi.fn()
    const context = { authority, executionContext, scopeAccumulator: undefined,
      admitModelOutput: async (current: ToolContext) => { current.authority = { ...authority } as never } }
    loopEvents = [textTurn('withheld')]
    const options = params('return', { loop: { ...params('return').loop, context: context as never },
      sink: { kind: 'return', onEvent: seen, afterLoop } })
    await expect(runAssistantTurn(options)).rejects.toMatchObject({ reason: 'authority_changed' })
    context.admitModelOutput = async () => {}
    await expect(runAssistantTurn(options)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(seen).not.toHaveBeenCalled(); expect(afterLoop).not.toHaveBeenCalled()
  })

  it('heart-beats while the turn runs', async () => {
    loopEvents = [textTurn('x')]
    await runAssistantTurn(params('none', {
      sink: { kind: 'none', onEvent: () => new Promise((r) => setTimeout(r, 30)) },
    }))
    expect(leaseCalls).toContain('touch')
  })

  it('refuses a personal turn while a live lease holds the session', async () => {
    vi.mocked(claimTurnLease).mockResolvedValueOnce(null)
    await expect(runAssistantTurn(params('adapter'))).rejects.toBeInstanceOf(TurnRefusal)
    expect(leaseCalls).not.toContain('start')
  })

  it.each([false, true])('owns stale takeover even when its observer throws: %s', async fails => {
    vi.mocked(claimTurnLease).mockImplementationOnce(async (_id, _assistant, _started, reclaimed) => {
      leaseCalls.push('claim'); reclaimed?.({turnId:null,reason:'stalled_reclaimed'}); return 'successor'
    })
    const observer = vi.fn(() => { if (fails) throw new Error('notification unavailable') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const owner = await openAssistantTurn({ ...params('sse', { policy: { admission: 'room' } }), onReclaimed: observer })
    try {
      expect(owner.token).toBe('successor')
      expect(observer).toHaveBeenCalledTimes(1)
      expect(leaseCalls.filter(call => call === 'claim')).toHaveLength(1)
    } finally { await owner.finish(); log.mockRestore() }
    expect(releaseTurnLease).toHaveBeenCalledWith('s-1', 'completed', 'successor')
  })

  it('claims room admission atomically for a workspace session', async () => {
    await runAssistantTurn(params('sse', { policy: { admission: 'room' } }))
    expect(leaseCalls[0]).toBe('claim')
  })

  it('owns preparation and recovery heartbeat and Stop outside the loop, and releases once', async () => {
    const options = params('sse'), owner = await openAssistantTurn(options)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(leaseCalls).toContain('touch')
    await owner.run(options)
    const afterLoop = leaseCalls.filter(call => call === 'touch').length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(leaseCalls.filter(call => call === 'touch').length).toBeGreaterThan(afterLoop)
    expect(leaseCalls).not.toContain('release')
    await Promise.all([owner.finish(), owner.finish()])
    await owner.finish()
    expect(leaseCalls.filter(call => call === 'release')).toHaveLength(1)
    await expect(owner.run(options)).rejects.toThrow('already run or closed')
  })

  it('owns one preparation inbox and retires it even when database release needs retry', async () => {
    const owner = await openAssistantTurn({...params('sse'), assistantId:'fictional-assistant'})
    const first = owner.openInput()
    expect(owner.openInput().port).toBe(first.port)
    expect(localTurnInboxAssistant('s-1')).toBe('fictional-assistant')
    vi.mocked(releaseTurnLease).mockResolvedValueOnce(false)
    expect(await owner.finish('failed')).toBe(false)
    expect(localTurnInboxAssistant('s-1')).toBeUndefined()
    expect(()=>owner.openInput()).toThrow('already closed')
    expect(await owner.finish()).toBe(true)
  })

  it('observes remote Stop during leased preparation before any loop starts', async () => {
    const options = params('sse'), owner = await openAssistantTurn(options)
    vi.mocked(touchTurnLease).mockResolvedValueOnce({ held: true, cancelRequested: true })
    await vi.waitFor(() => expect(options.abortController.signal.aborted).toBe(true))
    expect(loopOptions).toHaveLength(0)
    await owner.finish()
  })

  it('retries a failed release in final cleanup without unlocking through a second owner', async () => {
    const owner = await openAssistantTurn(params('sse'))
    vi.mocked(releaseTurnLease).mockResolvedValueOnce(false)
    expect(await owner.finish('failed')).toBe(false)
    expect(owner.released).toBe(false)
    expect(await owner.finish('failed')).toBe(true)
    expect(owner.released).toBe(true)
  })

  it('keeps heartbeating through awaited post-turn persistence and propagates its refusal', async () => {
    loopEvents = [textTurn('Fictional final response')]
    const refused = Object.assign(new Error('Current context unavailable'), { reason: 'authority_changed' })
    await expect(runAssistantTurn(params('adapter', {
      sink: { kind: 'adapter', afterLoop: async () => {
        const touched = leaseCalls.filter(call => call === 'touch').length
        await new Promise(resolve => setTimeout(resolve, 30))
        expect(leaseCalls.filter(call => call === 'touch').length).toBeGreaterThan(touched)
        expect(leaseCalls).not.toContain('release')
        throw refused
      } },
    }))).rejects.toBe(refused)
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('stops delivering events once the turn is aborted', async () => {
    const abortController = new AbortController()
    const seen: unknown[] = []
    loopEvents = [textTurn('a'), textTurn('b')]
    await runAssistantTurn(params('sse', {
      abortController,
      sink: { kind: 'sse', onEvent: (e) => { seen.push(e); abortController.abort() } },
    }))
    expect(seen).toHaveLength(1)
  })

  it('records the delivered round at a Stop exit for the streaming sink only (M5Q-2)', async () => {
    const delta = (text: string) => ({ type: 'text_delta', text })
    for (const [sink, reason] of [['sse', new TurnStoppedError()], ['sse', new TurnLeaseLostError()], ['adapter', new TurnStoppedError()]] as const) {
      const abortController = new AbortController(), seen: Array<{ type: string; response?: { content: unknown; stopReason: string } }> = []
      loopEvents = [delta('Hello'), delta(' wor'), delta('ld'), textTurn('Hello world')]
      await runAssistantTurn(params(sink, { abortController, sink: { kind: sink, onEvent: (e) => {
        seen.push(e as never); if (seen.length === 2) abortController.abort(reason) } } }))
      const recorded = seen.filter(event => event.type === 'assistant_turn')
      if (sink === 'sse' && reason instanceof TurnStoppedError) {
        // Exactly the admitted, delivered text; nothing after Stop.
        expect(recorded).toEqual([expect.objectContaining({ response: expect.objectContaining({
          content: [{ type: 'text', text: 'Hello wor' }], stopReason: 'incomplete' }), toolResults: [] })])
      } else expect(recorded).toEqual([])
    }
    // A Stop landing inside an awaited output admission surfaces as its refusal:
    // still the Stop exit (recorded), unless the effect may have executed.
    for (const uncertain of [false, true]) {
      const abortController = new AbortController(), seen: Array<{ type: string }> = []
      loopEvents = [delta('Partial'), delta(' text')]
      loopThrows = Object.assign(new Error('Fictional refusal after Stop'), { reason: 'authority_changed', ...(uncertain ? { operationMayHaveExecuted: true } : {}) })
      const run = runAssistantTurn(params('sse', { abortController, sink: { kind: 'sse', onEvent: (e) => {
        seen.push(e as never); if (seen.length === 2) abortController.abort(new TurnStoppedError()) } } }))
      if (uncertain) { await expect(run).rejects.toMatchObject({ operationMayHaveExecuted: true }); expect(seen.filter(e => e.type === 'assistant_turn')).toEqual([]) }
      else { await expect(run).resolves.toMatchObject({ aborted: true }); expect(seen.filter(e => e.type === 'assistant_turn')).toHaveLength(1) }
    }
    loopThrows = null
  })

  it('sanitizes final text for final-only sinks, not for the SSE stream', async () => {
    loopEvents = [textTurn('Enjoy your Sunday! (Word count: ~65)')]
    const adapter = await runAssistantTurn(params('adapter'))
    expect(adapter.finalText).toBe('Enjoy your Sunday!')
    const sse = await runAssistantTurn(params('sse'))
    expect(sse.finalText).toBeNull()
  })

  it('runs the loop under the stall watchdog, never a wall clock', async () => {
    await runAssistantTurn(params('return'))
    expect(typeof loopOptions[0]?.stallIdleMs).toBe('number')
  })

  it('serves a custom endpoint as resolved and a registry model only when servable', () => {
    const custom = { provider: {} as never, model: 'custom:abc', configuredProviders: new Set(['gemini']) as never, customLlm: {} as never }
    expect(servedTurnModel(custom)).toBe('custom:abc')
    const platform = { provider: {} as never, model: 'gemini-flash', configuredProviders: undefined, customLlm: null }
    expect(servedTurnModel(platform)).toBe('gemini-flash')
  })
})

function snapshotTurnFixture() {
  const controller = new AbortController()
  const authority = { assertCurrent: vi.fn(async () => {}), execute: async <T,>(operation: () => Promise<T>) => operation() }
  const execution = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor', authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: 'workspace' },
    access: { workspaceId: 'workspace', userId: 'actor', assistantId: 'assistant', assistantKind: 'standard',
      clearance: 'confidential', compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: ['assistant'] },
    writeDefaults: { compartments: [], projectIds: [] }, authority,
    lifecycle: { sessionId: 's-1', channelType: 'web', channelId: 'channel', abortSignal: controller.signal },
  })
  const initial: ScopeSource = { resourceKind: 'memory', resourceId: 'initial', version: '1', workspaceId: 'workspace',
    userId: 'actor', assistantId: null, sensitivity: 'internal', compartments: ['finance'], projectIds: [] }
  const accumulator = new ContextScopeAccumulator({ sources: [initial] })
  const context: ToolContext = { ...executionToolContext(execution, { appId: 'chat' }), scopeAccumulator: accumulator }
  const session = { id: 's-1', userId: 'actor', channelType: 'web', channelId: 'channel',
    visibility: 'personal', anchorKind: 'none', appOrigin: 'chat' } as Session
  const snapshot = createTurnDeliveryAdmission(execution, accumulator, session)!
  expect(snapshot).toBeDefined()
  const options = params('sse', { abortController: controller,
    loop: { ...params('sse').loop, context },
    sink: { kind: 'sse', permissionContext: snapshot, admitOutput: snapshot.authorizeDelivery },
  })
  return { execution, authority, initial, accumulator, context, snapshot, options }
}

describe('[COMP:api/turn-kernel] response permission snapshot integration', () => {
  it('admits each streamed output and finalization once while retaining model-input authority', async () => {
    const f = snapshotTurnFixture(), routeInput = vi.fn(async () => {}), routeOutput = vi.fn(async () => {})
    f.context.admitModelInput = routeInput
    f.context.admitModelOutput = routeOutput
    simulateModelBoundaries = true
    loopEvents = Array.from({ length: 20 }, (_, index) => textTurn(`chunk ${index}`))
    const seen = vi.fn()
    f.options.sink.onEvent = seen
    await runAssistantTurn(f.options)
    expect(seen).toHaveBeenCalledTimes(20)
    expect(routeInput).toHaveBeenCalledTimes(1)
    expect(admitModelInput).toHaveBeenCalledTimes(1)
    expect(routeOutput).toHaveBeenCalledTimes(21) // engine per event plus final core boundary
    expect(admitAttendedAudienceEvidence).toHaveBeenCalledTimes(21)
    expect(admitAttendedAudienceEvidence).toHaveBeenCalledWith(f.execution, f.accumulator.evidence,
      expect.objectContaining({ userId: 'actor' }), { directHumanSource: true, turnDestinationSessionId: f.options.sessionId })
    expect(admitModelOutput).not.toHaveBeenCalled()
    expect(f.authority.assertCurrent).toHaveBeenCalled()
    // The exact hook handed to core remains a live input guard after a receipt exists.
    const coreContext = loopOptions[0].context as ToolContext
    await coreContext.admitModelInput!(coreContext)
    expect(admitModelInput).toHaveBeenCalledTimes(2)
    vi.mocked(admitModelInput).mockRejectedValueOnce(new Error('input source revoked'))
    await expect(coreContext.admitModelInput!(coreContext)).rejects.toThrow('input source revoked')
    expect(admitAttendedAudienceEvidence).toHaveBeenCalledTimes(21)
  })

  it('keeps live execution authority current with unchanged output evidence', async () => {
    const f = snapshotTurnFixture(), afterLoop = vi.fn()
    simulateModelBoundaries = true
    loopEvents = [textTurn('allowed'), textTurn('revoked')]
    const seen = vi.fn(() => {
      f.authority.assertCurrent.mockRejectedValue(new AuthorityChangedError())
    })
    f.options.sink.onEvent = seen
    f.options.sink.afterLoop = afterLoop
    await expect(runAssistantTurn(f.options)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(admitAttendedAudienceEvidence).toHaveBeenCalledTimes(2) // the complete owner refuses the second effect
    expect(afterLoop).not.toHaveBeenCalled()
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('admits all accumulated tool evidence before each subsequent output', async () => {
    const f = snapshotTurnFixture()
    const toolSource: ScopeSource = { ...f.initial, resourceKind: 'workspace_file', resourceId: 'tool-result',
      sensitivity: 'confidential', compartments: ['legal'], projectIds: ['project'] }
    simulateModelBoundaries = true
    loopEvents = [textTurn('before tool'), textTurn('after tool'), textTurn('unchanged')]
    loopBeforeEvent = index => { if (index === 1) f.accumulator.note({ sources: [toolSource] }) }
    const counts: number[] = []
    f.options.sink.onEvent = () => { counts.push(vi.mocked(admitAttendedAudienceEvidence).mock.calls.length) }
    await runAssistantTurn(f.options)
    expect(counts).toEqual([1, 2, 3])
    expect(admitAttendedAudienceEvidence).toHaveBeenNthCalledWith(2, f.execution,
      { sources: [f.initial, toolSource], sensitivity: 'confidential', compartments: ['finance', 'legal'], projectIds: ['project'] },
      expect.anything(), { directHumanSource: true, turnDestinationSessionId: f.options.sessionId })
    expect(admitModelInput).toHaveBeenCalledTimes(1)
    expect(admitModelOutput).not.toHaveBeenCalled()
  })

  it('does not render new tool evidence when snapshot admission refuses it', async () => {
    const f = snapshotTurnFixture(), seen = vi.fn(), afterLoop = vi.fn()
    simulateModelBoundaries = true
    loopEvents = [textTurn('safe'), textTurn('must not render')]
    loopBeforeEvent = index => {
      if (index !== 1) return
      f.accumulator.note({ sources: [{ ...f.initial, resourceId: 'new-tool-source' }] })
      vi.mocked(admitAttendedAudienceEvidence).mockRejectedValueOnce(new AuthorityChangedError())
    }
    f.options.sink.onEvent = seen
    f.options.sink.afterLoop = afterLoop
    await expect(runAssistantTurn(f.options)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(afterLoop).not.toHaveBeenCalled()
    expect(admitAttendedAudienceEvidence).toHaveBeenCalledTimes(2)
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it.each(['sse', 'adapter', 'json', 'return', 'none'] as const)('retains full live checks without a snapshot on the %s sink', async kind => {
    const f = snapshotTurnFixture()
    f.options.sink = { kind }
    simulateModelBoundaries = true
    loopEvents = [textTurn('one'), textTurn('two')]
    await runAssistantTurn(f.options)
    // User-facing outputs use delivery admission; internal returns use context.
    expect(admitModelInput).toHaveBeenCalledTimes(['return', 'none'].includes(kind) ? 4 : 1)
    expect(admitModelOutput).toHaveBeenCalledTimes(['sse', 'adapter', 'json'].includes(kind) ? 3 : 0)
    expect(admitAttendedAudienceEvidence).not.toHaveBeenCalled()
  })

  it('delegates the complete host admission without an extra kernel lease pair', async () => {
    const f = snapshotTurnFixture(), recipient = vi.fn(async () => {})
    f.options.sink = { kind: 'sse', admitOutput: recipient }
    simulateModelBoundaries = true
    loopEvents = [textTurn('one'), textTurn('two')]
    await runAssistantTurn(f.options)
    expect(admitModelInput).toHaveBeenCalledTimes(1)
    expect(recipient).toHaveBeenCalledTimes(3)
    // Model preparation checks its original authority twice and run preparation
    // its full admission plus lease once each; mocked host/input adapters add no loop pair.
    expect(f.authority.assertCurrent).toHaveBeenCalledTimes(4)
    expect(admitAttendedAudienceEvidence).not.toHaveBeenCalled()
  })

  it.each(['forged snapshot', 'changed callback', 'foreign execution', 'foreign accumulator', 'replaced snapshot', 'non-SSE sink'] as const)(
    'rejects %s before rendering or publication', async kind => {
      const f = snapshotTurnFixture(), seen = vi.fn(), afterLoop = vi.fn(), counterfeit = vi.fn(async () => {})
      if (kind === 'forged snapshot') {
        f.options.sink.permissionContext = { ...f.snapshot, authorizeDelivery: counterfeit }
        f.options.sink.admitOutput = counterfeit
      } else if (kind === 'changed callback') f.options.sink.admitOutput = counterfeit
      else if (kind === 'foreign execution') f.options.loop.context = snapshotTurnFixture().context
      else if (kind === 'foreign accumulator') f.context.scopeAccumulator = new ContextScopeAccumulator()
      else if (kind === 'non-SSE sink') f.options.sink.kind = 'adapter'
      else {
        // Replacement after the kernel has captured its response-bound capability.
        loopBeforeEvent = () => { f.options.sink.permissionContext = snapshotTurnFixture().snapshot }
      }
      simulateModelBoundaries = true
      loopEvents = [textTurn('not authorized')]
      f.options.sink.onEvent = seen
      f.options.sink.afterLoop = afterLoop
      await expect(runAssistantTurn(f.options)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
      expect(seen).not.toHaveBeenCalled()
      expect(afterLoop).not.toHaveBeenCalled()
      expect(counterfeit).not.toHaveBeenCalled()
      expect(admitAttendedAudienceEvidence).not.toHaveBeenCalled()
      expect(leaseCalls.at(-1)).toBe('release')
    },
  )

  it('refuses nested ceiling grant mutation before rendering another event', async () => {
    const f = snapshotTurnFixture(), afterLoop = vi.fn()
    const seen = vi.fn(() => {
      (f.execution.security.ceiling.visibilityAssistantIds as string[]).push('another-assistant')
    })
    simulateModelBoundaries = true
    loopEvents = [textTurn('allowed'), textTurn('must not render')]
    f.options.sink.onEvent = seen
    f.options.sink.afterLoop = afterLoop
    await expect(runAssistantTurn(f.options)).rejects.toThrow()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(afterLoop).not.toHaveBeenCalled()
    expect(admitAttendedAudienceEvidence).toHaveBeenCalledTimes(1)
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('rechecks callback identity after a rendered event rather than reusing its receipt', async () => {
    const f = snapshotTurnFixture(), replacement = vi.fn(async () => {}), seen = vi.fn(() => {
      f.options.sink.admitOutput = replacement
    })
    simulateModelBoundaries = true
    loopEvents = [textTurn('allowed'), textTurn('not allowed')]
    f.options.sink.onEvent = seen
    await expect(runAssistantTurn(f.options)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(replacement).not.toHaveBeenCalled()
    expect(admitAttendedAudienceEvidence).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:api/turn-kernel] turn billing (D2)', () => {
  const assistant = { id: 'a', ownerUserId: null, workspaceId: 'w' }

  it('bills a workspace-audience turn to the workspace party and records the addresser', async () => {
    const billing = await resolveTurnBilling({
      policy: { billing: 'workspace' }, assistant, actorUserId: 'addresser',
      resolveWorkspaceParty: async () => 'workspace-owner',
    })
    expect(turnUsageIdentity(billing)).toEqual({ userId: 'workspace-owner', actorUserId: 'addresser' })
  })

  it('bills a personal turn to its human', async () => {
    const billing = await resolveTurnBilling({
      policy: { billing: 'user' }, assistant, actorUserId: 'me',
      resolveWorkspaceParty: async () => 'workspace-owner',
    })
    expect(turnUsageIdentity(billing)).toEqual({ userId: 'me', actorUserId: 'me' })
  })

  it('takes a machine lane\'s explicit payer', async () => {
    const billing = await resolveTurnBilling({
      policy: { billing: 'workspace' }, assistant, actorUserId: null, explicitPayerUserId: 'caller',
    })
    expect(turnUsageIdentity(billing)).toEqual({ userId: 'caller' })
  })
  it.each(['stop','lease_lost'] as const)('preserves the canonical %s cause instead of treating every abort as Stop',async kind=>{
    const controller=new AbortController(),owner=await openAssistantTurn(params('none',{abortController:controller}))
    try{
      vi.mocked(touchTurnLease).mockResolvedValueOnce(kind==='stop'?{held:true,cancelRequested:true}:{held:false,cancelRequested:false})
      await new Promise(resolve=>setTimeout(resolve,15))
      expect(owner.abortKind).toBe(kind);expect(turnAbortKind(controller.signal)).toBe(kind)
      expect(controller.signal.reason).toBeInstanceOf(kind==='stop'?TurnStoppedError:TurnLeaseLostError)
    }finally{await owner.finish()}
  })
  it('a captured old token cannot abort a successor local handle',async()=>{
    const controller=new AbortController(),owner=await openAssistantTurn(params('none',{abortController:controller}))
    try{
      expect(abortLocalTurn('s-1','old-token')).toBe(false);expect(controller.signal.aborted).toBe(false)
      expect(abortLocalTurn('s-1',owner.token)).toBe(true);expect(owner.abortKind).toBe('stop')
    }finally{await owner.finish()}
  })

})

describe('[COMP:api/turn-kernel] original-owner main billing settlement', () => {
  const observed = { model: 'gemini-flash', totalUsage: { inputTokens: 7, outputTokens: 3, calculatedCostUsd: 0.25 } }
  function defer() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
  function bill(recordUsage = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => {})) {
    return { metadata: { userId: 'original-payer', actorUserId: 'original-actor', assistantId: 'assistant', sessionId: 's-1',
      modelTier: 'pro', source: 'api', userMessageId: 'original-message', triggerKey: 'main_response', providerKeySource: 'platform' as const },
      costPolicy: 'reported_or_calculated' as const, recordUsage }
  }
  function observe() { (loopOptions.at(-1)!.observeUsage as (value: unknown) => void)(observed) }
  it('pins original scalar metadata, bound recorder and error callbacks before run', async () => {
    const owner = await openAssistantTurn(params('sse'))
    const original = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => { throw new Error('bookkeeping unavailable') })
    const onError = vi.fn(), replacement = vi.fn()
    const registration = { ...bill(original), onError }
    owner.registerUsageBilling(registration)
    registration.metadata.userId = 'replacement-payer'
    registration.metadata.userMessageId = 'replacement-message'
    registration.recordUsage = replacement
    registration.onError = replacement
    loopBeforeEvent = observe; loopEvents = [textTurn('Actual answer')]
    await owner.run(params('sse'))
    const first = owner.settleUsage()
    expect(owner.settleUsage()).toBe(first)
    await expect(first).resolves.toMatchObject({ status: 'failed', error: expect.any(Error) })
    await owner.finish()
    await owner.finish()
    expect(original).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: 'original-payer', userMessageId: 'original-message', model: observed.model, inputTokens: 7, actualCostUsd: 0.25 }))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(replacement).not.toHaveBeenCalled()
    expect(owner.released).toBe(true)
    expect(releaseTurnLease).toHaveBeenCalledTimes(1)
  })
  it('awaits one deferred recorder before exact release across concurrent and repeated finish', async () => {
    const owner = await openAssistantTurn(params('sse')), pending = defer()
    const record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => { await pending.promise })
    owner.registerUsageBilling(bill(record)); loopBeforeEvent = observe; loopEvents = [textTurn('Actual answer')]
    await owner.run(params('sse'))
    const finish = owner.finish(); expect(owner.finish()).toBe(finish)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1)); expect(releaseTurnLease).not.toHaveBeenCalled()
    pending.resolve(); await finish
    expect(await owner.settleUsage()).toEqual({ status: 'recorded' })
    expect(await owner.finish()).toBe(true)
    expect(record).toHaveBeenCalledTimes(1); expect(releaseTurnLease).toHaveBeenCalledExactlyOnceWith('s-1', 'completed', 'tok-1')
  })
  it.each(['stop', 'lease_lost'] as const)('retains late %s during deferred settlement under the original token', async kind => {
    const controller = new AbortController(), owner = await openAssistantTurn(params('sse', { abortController: controller })), pending = defer()
    const record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => { await pending.promise })
    owner.registerUsageBilling(bill(record)); loopBeforeEvent = observe; loopEvents = [textTurn('Actual')]
    await owner.run(params('sse', { abortController: controller })); const finish = owner.finish(); expect(owner.finish()).toBe(finish)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    if (kind === 'stop') abortLocalTurn('s-1', owner.token)
    else { controller.abort(new TurnLeaseLostError()); vi.mocked(releaseTurnLease).mockResolvedValueOnce(false) }
    pending.resolve(); await finish
    expect(owner.abortKind).toBe(kind)
    expect(releaseTurnLease).toHaveBeenCalledExactlyOnceWith('s-1', kind === 'stop' ? 'stopped_by_user' : 'completed', 'tok-1')
    expect(owner.released).toBe(kind === 'stop')
    expect(record).toHaveBeenCalledTimes(1)
  })
  it('retains failed persistence outcome, awaits reporting and still exact-releases', async () => {
    const owner = await openAssistantTurn(params('sse')), reporting = defer(), failure = new Error('store refusal')
    const record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => { throw failure })
    const report = vi.fn(async () => { await reporting.promise })
    owner.registerUsageBilling({ ...bill(record), onError: report }); loopBeforeEvent = observe; loopEvents = [textTurn('Valid output')]
    await owner.run(params('sse')); const finish = owner.finish(); await tick()
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(failure)); expect(releaseTurnLease).not.toHaveBeenCalled()
    reporting.resolve(); await finish
    expect(await owner.settleUsage()).toEqual({ status: 'failed', error: failure })
    await owner.finish(); expect(record).toHaveBeenCalledTimes(1); expect(owner.released).toBe(true)
  })
  it.each(['stop', 'lease_lost', 'provider_failure', 'output_refusal'] as const)('settles producer facts on %s without terminal event admission', async kind => {
    const controller = new AbortController(), owner = await openAssistantTurn(params('sse', { abortController: controller }))
    const record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => {})
    owner.registerUsageBilling(bill(record)); loopEvents = [textTurn('Refused output')]
    loopBeforeEvent = () => { observe(); if (kind === 'stop') abortLocalTurn('s-1', owner.token); if (kind === 'lease_lost') controller.abort(new TurnLeaseLostError()) }
    if (kind === 'provider_failure') loopThrows = new Error('provider failed after spend')
    const failure = new AuthorityChangedError()
    if (kind === 'output_refusal') vi.mocked(admitModelOutput).mockRejectedValue(failure)
    try { await owner.run(params('sse', { abortController: controller })) } catch { /* original operation refusal */ }
    await owner.finish('failed')
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: observed.model, inputTokens: 7, outputTokens: 3 }))
    expect(owner.released).toBe(true)
    expect(owner.hasCommittedTerminalReply()).toBe(false)
  })
  it('allows terminal sink settlement without a run/settle cycle and ignores event-authored usage', async () => {
    const owner = await openAssistantTurn(params('sse')), record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => {})
    owner.registerUsageBilling(bill(record)); loopBeforeEvent = observe
    loopEvents = [{ type: 'turn_complete', response: textTurn('Actual').response, totalUsage: { inputTokens: 999, outputTokens: 999 } }]
    await owner.run(params('sse', { sink: { kind: 'sse', onEvent: async () => { expect(await owner.settleUsage()).toEqual({ status: 'recorded' }) } } }))
    await owner.finish()
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 7, outputTokens: 3 }))
  })
  it('does not retain a partial settlement when finish races still-running producer cleanup', async () => {
    const owner = await openAssistantTurn(params('sse')), producer = defer(), entered = defer()
    const record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => {})
    owner.registerUsageBilling(bill(record)); loopBeforeEvent = observe; loopEvents = [textTurn('Actual')]
    loopCleanup = async () => { entered.resolve(); await producer.promise; (loopOptions.at(-1)!.observeUsage as (value: unknown) => void)({ model: observed.model, totalUsage: { inputTokens: 70, outputTokens: 30 } }) }
    const afterLoop = vi.fn((result: import('../kernel.js').TurnLoopResult) => { expect(owner.beginFinalization(result, false)).toBe(true) })
    const run = owner.run(params('sse', { sink: { kind: 'sse', afterLoop } })); await entered.promise
    const finish = owner.finish(); await expect(owner.settleUsage()).rejects.toThrow('not terminal')
    expect(record).not.toHaveBeenCalled(); producer.resolve(); await run; await finish
    expect(afterLoop).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 70, outputTokens: 30 }))
  })
  it('refuses settlement from a synchronous budget hook before the running promise is assigned', async () => {
    const owner = await openAssistantTurn(params('sse')), record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => {})
    owner.registerUsageBilling(bill(record)); loopBeforeEvent = observe; loopEvents = [textTurn('Actual')]
    await owner.run(params('sse', { budget: async () => { await expect(owner.settleUsage()).rejects.toThrow('not terminal') } }))
    await owner.finish(); expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 7 }))
  })
  it('installs its run drain before a synchronous budget callback begins finish', async () => {
    const owner = await openAssistantTurn(params('sse')), record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => {})
    owner.registerUsageBilling(bill(record)); loopBeforeEvent = observe; loopEvents = [textTurn('Actual')]
    let finishing!: Promise<boolean>
    await owner.run(params('sse', { budget: async () => { finishing = owner.finish(); expect(releaseTurnLease).not.toHaveBeenCalled() } }))
    await finishing; expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 7 }))
    expect(owner.released).toBe(true)
  })
  it('retains original sink mutation refusal and still accounts the refused terminal producer', async () => {
    const owner = await openAssistantTurn(params('sse')), record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => {})
    const original = vi.fn(), counterfeit = vi.fn(), sink = { kind: 'sse' as const, onEvent: original }
    owner.registerUsageBilling(bill(record)); loopBeforeEvent = observe
    loopEvents = [{ type: 'turn_complete', response: textTurn('Actual').response, totalUsage: observed.totalUsage }]
    vi.mocked(admitModelOutput).mockImplementationOnce(async () => { sink.onEvent = counterfeit })
    await expect(owner.run(params('sse', { sink }))).rejects.toMatchObject({ reason: 'authority_changed' })
    await owner.finish('failed'); expect(original).not.toHaveBeenCalled(); expect(counterfeit).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 7 }))
  })
  it('distinguishes observed spend without billing configuration from absent spend', async () => {
    const owner = await openAssistantTurn(params('sse')); loopBeforeEvent = observe; loopEvents = [textTurn('Actual')]
    await owner.run(params('sse')); await owner.finish(); expect(await owner.settleUsage()).toEqual({ status: 'not_configured' })
  })
  it('rejects repeated or late registration and never charges terminal event usage without observed spend', async () => {
    const owner = await openAssistantTurn(params('sse')), record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => {})
    owner.registerUsageBilling(bill(record)); expect(() => owner.registerUsageBilling(bill())).toThrow('once before')
    loopEvents = [{ type: 'turn_complete', response: textTurn('Actual').response, totalUsage: observed.totalUsage }]
    await owner.run(params('sse')); expect(() => owner.registerUsageBilling(bill())).toThrow('once before')
    await owner.finish(); expect(await owner.settleUsage()).toEqual({ status: 'no_usage' }); expect(record).not.toHaveBeenCalled()
  })
})


describe('[COMP:api/turn-kernel] production web billing registration receiving', () => {
  const source = readFileSync(new URL('../../routes/chat.ts', import.meta.url), 'utf8')
  const start = source.indexOf('        let completedForMetering=false')
  const end = source.indexOf('        const turnLoopResult = await ownedTurn.run({', start)
  const register = (scope: Record<string, unknown>) => new Function(...Object.keys(scope),
    ts.transpileModule(source.slice(start, end) + '\nreturn () => { completedForMetering=true }',
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(scope)) as () => void
  it.each(['completed', 'stop', 'failed', 'legacy_byo', 'custom_byo', 'custom_platform'] as const)('awaits original COGS and preserves completion-only surcharge on %s', async ending => {
    const successful = ending !== 'stop' && ending !== 'failed'
    const usesUserKey = ending === 'legacy_byo' || ending === 'custom_byo'
    const controller = new AbortController(), owner = await openAssistantTurn(params('sse', { abortController: controller }))
    const record = vi.fn(async (_row: import('../billing.js').TurnUsageRow) => {}), replacement = vi.fn()
    let chargeDone!: () => void
    const pending = new Promise<void>(resolve => { chargeDone = resolve })
    const charge = vi.fn(async (_row: unknown) => { await pending; return { credits: 8 } })
    const options = { usageStore: { recordUsage: record }, analytics: { logEvent: vi.fn() }, chargeMeteredSurcharge: charge }
    const user = { id: 'original-actor' }, assistant = { id: 'original-assistant', workspaceId: 'original-workspace' }
    const meteredTurn = { alias: 'fixture-tier', profileId: 'original-profile', toolRounds: 3 }
    const complete = register({ options, user, assistant, meteredTurn, usedByoKey: usesUserKey || ending === 'custom_platform', customLlmRuntime: ending === 'custom_byo' ? { providerKeySource: 'user' } : ending === 'custom_platform' ? { providerKeySource: 'platform' } : null,
      ownedTurn: owner, storedUserMsg: { id: 'original-message' }, session: { id: 's-1' },
      turnBilling: { payerUserId: 'original-payer', actorUserId: user.id }, logicalTier: 'pro', userPlan: 'pro',
      turnUsageIdentity, sanitize: (value: string) => value })
    options.usageStore.recordUsage = replacement; options.chargeMeteredSurcharge = replacement
    user.id = 'replacement-actor'; assistant.workspaceId = 'replacement-workspace'; meteredTurn.profileId = 'replacement-profile'
    loopBeforeEvent = () => { (loopOptions.at(-1)!.observeUsage as (value: unknown) => void)({ model: 'gemini-flash', totalUsage: { inputTokens: 11, outputTokens: 4, calculatedCostUsd: 123 } }) }
    loopEvents = [textTurn('Answer'), { type: 'turn_complete', response: textTurn('Answer').response, totalUsage: { inputTokens: 999, outputTokens: 999 } }]
    if (ending === 'failed') loopThrows = new Error('provider failed')
    if (ending === 'stop') loopBeforeEvent = () => { (loopOptions.at(-1)!.observeUsage as (value: unknown) => void)({ model: 'gemini-flash', totalUsage: { inputTokens: 11, outputTokens: 4 } }); controller.abort(new TurnStoppedError()) }
    try { await owner.run(params('sse', { abortController: controller, ...(usesUserKey ? { model: { provider: {} as never, model: 'custom:fixture', configuredProviders: undefined, customLlm: { provider: {} as never, selector: 'custom:fixture', providerKeySource: 'user', supportsVision: true } as never } } : {}), sink: { kind: 'sse', onEvent: event => { if (event.type === 'turn_complete' && successful) complete() } } })) } catch { /* original failure */ }
    const finish = owner.finish(successful ? 'completed' : 'failed')
    if (successful) { await vi.waitFor(() => expect(charge).toHaveBeenCalledTimes(1)); expect(releaseTurnLease).not.toHaveBeenCalled() }
    chargeDone(); await finish
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: 'original-payer', actorUserId: 'original-actor', userMessageId: 'original-message', providerKeySource: usesUserKey ? 'user' : 'platform', inputTokens: 11, outputTokens: 4 }))
    expect(record.mock.calls[0][0].actualCostUsd).toBe(usesUserKey ? 0 : calculateCost('gemini-flash', { inputTokens: 11, outputTokens: 4, ...(ending !== 'stop' ? { calculatedCostUsd: 123 } : {}) }))
    expect(replacement).not.toHaveBeenCalled()
    expect(charge).toHaveBeenCalledTimes(successful ? 1 : 0)
    if (successful) expect(charge).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'original-workspace', requestId: 'original-message', profileId: 'original-profile', chargedByUserId: 'original-actor' }))
    expect(owner.released).toBe(true)
  })
})
