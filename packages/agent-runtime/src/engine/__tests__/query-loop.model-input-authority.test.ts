import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ContextScopeAccumulator } from '../../security/context-scope.js'
import { buildTool, type ToolContext } from '../../tools/types.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import { queryLoop, assertModelOutputAuthority, assertOutputOperationAuthority, type QueryEvent, type QueryLoopOptions } from '../query-loop.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import { registerInputAdmissionOwner } from '../../providers/input-authority.js'
vi.mock('../../compaction/compact.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../compaction/compact.js')>(),compactConversation: vi.fn(),
}))
import { compactConversation } from '../../compaction/compact.js'

// Provider-boundary mechanics only. API integration fixtures supply real source/SQL authority.
describe('[COMP:engine/model-input-authority] every model boundary', () => {
  beforeEach(() => vi.clearAllMocks())
  function provider(options: { tool?: boolean; overflow?: boolean } = {}) {
    const chunks: StreamChunk[] = options.tool ? [
      { type: 'message_start',model: 'mock-model' },
      { type: 'tool_use_start',id: 'call-1',name: 'observe' },
      { type: 'tool_use_delta',id: 'call-1',input: '{}' },
      { type: 'tool_use_end',id: 'call-1' },
      { type: 'message_end',stopReason: 'tool_use',usage: { inputTokens: 1,outputTokens: 1 } },
    ] : [
      { type: 'message_start',model: 'mock-model' },{ type: 'text_delta',text: 'Fictional answer' },
      { type: 'message_end',stopReason: 'end_turn',usage: { inputTokens: 1,outputTokens: 1 } },
    ]
    const send = vi.fn(() => (async function* () {
      if (options.overflow) throw new Error('context_length_exceeded')
      for (const chunk of chunks) yield chunk
    })())
    const stream = vi.fn(() => (async function* () { for (const chunk of chunks) yield chunk })())
    const createSession = vi.fn(() => ({ send }))
    return { value: { name: 'mock',models: ['mock-model'],stream,createSession } satisfies LLMProvider,send,stream,createSession }
  }
  const context = (hook: NonNullable<ToolContext['admitModelInput']>): ToolContext => ({
    userId: 'fictional-user',assistantId: 'fictional-assistant',sessionId: 'fictional-session',appId: 'fixture',channelType: 'web',channelId: 'fixture',
    abortSignal: new AbortController().signal,scopeAccumulator: new ContextScopeAccumulator(),admitModelInput: hook,
  })
  async function run(value: LLMProvider, ctx: ToolContext, extra: Partial<QueryLoopOptions> = {}) {
    const events: QueryEvent[] = []
    for await (const event of queryLoop({ provider: value,model: 'mock-model',systemPrompt: 'Fictional context',messages: [{ role: 'user',content: 'Read the input' }],
      tools: new Map(),ledger: NOOP_TURN_LEDGER,maxTurns: 2,context: ctx,...extra })) events.push(event)
    return events
  }
  it.each([false, true])('buffers raw provider fragments but freshly refuses queued output after revocation (%s)', async stateless => {
    let produced = 0, closed = false, revoked = false
    const sentSignals: AbortSignal[] = []
    async function* fragments(signal?: AbortSignal): AsyncGenerator<StreamChunk> {
      if (signal) sentSignals.push(signal)
      try {
        yield { type: 'message_start', model: 'mock-model' }
        for (let i = 0; i < 2000; i++) { produced++; yield { type: 'text_delta', text: 'x' } }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
      } finally { closed = true }
    }
    const p: LLMProvider = { name: 'mock', models: ['mock-model'],
      stream: request => fragments(request.signal),
      createSession: () => ({ send: (_messages, options) => fragments(options?.signal) }),
    }
    const output = vi.fn(async () => { if (revoked) throw new Error('Source withdrawn before flush') })
    const events = queryLoop({ provider: p, model: 'mock-model', stateless,
      systemPrompt: '', messages: [{ role: 'user', content: 'Fictional input' }],
      tools: new Map(), ledger: NOOP_TURN_LEDGER, maxTurns: 1,
      context: { ...context(async () => {}), admitModelOutput: output },
    })
    const first = await events.next()
    expect(first.value?.type).toBe('text_delta')
    await new Promise<void>(resolve => setImmediate(resolve))
    // Provider bytes can queue while the consumer waits, but do not confer
    // authority to emit a second frame or complete stateful model history.
    expect(produced).toBe(2000)
    expect(closed).toBe(false)
    revoked = true
    await expect(events.next()).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(output).toHaveBeenCalledTimes(2)
    expect(closed).toBe(true)
    expect(sentSignals).toHaveLength(1)
    expect(sentSignals[0].aborted).toBe(true)
  })

  it.each([false,true])('refuses before session construction or stateless dispatch (%s)', async stateless => {
    const p = provider(), hook = vi.fn(async () => { throw new Error('Input unavailable') })
    await expect(run(p.value,context(hook),{ stateless })).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    expect(p.createSession).not.toHaveBeenCalled(); expect(p.stream).not.toHaveBeenCalled(); expect(p.send).not.toHaveBeenCalled()
  })
  it('passes the live invocation accumulator before each stateful send', async () => {
    const p = provider(), hook = vi.fn(async (_context: ToolContext) => {}), ctx = context(hook)
    const events = await run(p.value,ctx)
    expect(hook).toHaveBeenCalledTimes(2)
    expect(hook.mock.calls.every(([current]) => current.scopeAccumulator === ctx.scopeAccumulator)).toBe(true)
    expect(p.send).toHaveBeenCalledTimes(1)
    expect(events.some(event => event.type === 'text_delta')).toBe(true)
  })
  it.each([false,true])('delegates owned preparation but preserves dispatch and output checks (%s)', async stateless => {
    const p = provider()
    const input = vi.fn(async () => {})
    const output = vi.fn(async () => {})
    const owned = registerInputAdmissionOwner({ ...p.value,
      async *stream(request) {
        await request.assertInputAuthority?.()
        yield* (p.value as LLMProvider).stream(request)
      },
      createSession(options) {
        return { send: (messages, opts) => this.stream({ ...options, messages,
          assertInputAuthority: opts?.assertInputAuthority ?? options.assertInputAuthority }) }
      },
    })
    await run(owned, { ...context(input), admitModelOutput: output }, { stateless })
    expect(input).toHaveBeenCalledTimes(1)
    expect(output).toHaveBeenCalled()
  })
  it('keeps the live provider guard across a tool round trip', async () => {
    const first = provider({ tool: true }), last = provider()
    const guards: Array<(() => Promise<void>) | undefined> = []
    const value = registerInputAdmissionOwner({ ...first.value,
      createSession(options) {
        guards.push(options.assertInputAuthority)
        return { async *send(_messages, opts) {
          guards.push(opts?.assertInputAuthority)
          await opts?.assertInputAuthority?.()
          yield* (guards.length === 2 ? first.send() : last.send())
        } }
      },
    })
    const read = buildTool({ name: 'observe', description: 'Read a fixture', inputSchema: z.object({}),
      isReadOnly: true, isConcurrencySafe: true, execute: async () => ({ data: 'ok' }) })
    const admit = vi.fn(async () => {})
    await run(value, context(admit), { tools: new Map([['observe', read]]) })
    expect(guards).toHaveLength(3)
    expect(guards[0]).toBeTypeOf('function')
    expect(new Set(guards).size).toBe(1)
    expect(admit).toHaveBeenCalledTimes(2)
  })
  it('carries the native lease to physical dispatch even without source facts', async () => {
    const p = provider(); let revoked = false
    let physicalCheck: (() => Promise<void>) | undefined
    const checked: LLMProvider = { ...p.value,createSession: options => {
      physicalCheck = options.assertInputAuthority
      return { send: () => (async function* () {
      revoked = true
      await options.assertInputAuthority?.()
      yield { type: 'text_delta' as const,text: 'Unreachable fictional content' }
    })() } } }
    const ctx = { ...context(async () => {}),authority: {
      assertCurrent: async () => { if (revoked) throw new Error('Native admission withdrawn') },
      execute: async <T>(operation: () => Promise<T>) => operation(),
    } }
    await expect(run(checked,ctx)).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    revoked = false
    await expect(physicalCheck!()).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(p.stream).not.toHaveBeenCalled()
  })
  const observedSource = { workspaceId: '11111111-1111-4111-8111-111111111111',userId: null,assistantId: null,
    resourceKind: 'memory',resourceId: '22222222-2222-4222-8222-222222222222',version: '1',sensitivity: 'internal' as const,compartments: [],projectIds: [] }
  it('checks evidence added by a tool before the next provider send', async () => {
    const p = provider({ tool: true })
    const ctx = context(async current => { if (current.scopeAccumulator?.evidence.sources?.length) throw new Error('New input unavailable') })
    const observe = buildTool({ name: 'observe',description: 'Observe a fictional source',inputSchema: z.object({}).strict(),isReadOnly: true,isConcurrencySafe: true,
      execute: async (_input, current) => { current.scopeAccumulator?.note({ sources: [observedSource] }); return { data: { value: 'Fictional record' } } } })
    await expect(run(p.value,ctx,{ tools: new Map([['observe',observe]]) })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(ctx.scopeAccumulator?.evidence.sources).toEqual([observedSource])
    expect(p.send).toHaveBeenCalledTimes(1); expect(p.stream).not.toHaveBeenCalled()
  })
  it('passes a nested invocation its own current accumulator', async () => {
    const p = provider({ tool: true }), child = provider(), childAccumulator = new ContextScopeAccumulator({ sources: [observedSource] })
    const hook = vi.fn(async (current: ToolContext) => { if (current.scopeAccumulator === childAccumulator) throw new Error('Child input unavailable') })
    const observe = buildTool({ name: 'observe',description: 'Run a fictional nested loop',inputSchema: z.object({}).strict(),isReadOnly: true,isConcurrencySafe: true,
      execute: async (_input, current) => {
        await run(child.value,{ ...current,scopeAccumulator: childAccumulator,sessionId: 'fictional-child' })
        return { data: { value: 'Unexpected child result' } }
      } })
    await expect(run(p.value,context(hook),{ tools: new Map([['observe',observe]]) })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(hook.mock.calls.some(([current]) => current.scopeAccumulator === childAccumulator)).toBe(true)
    expect(child.createSession).not.toHaveBeenCalled(); expect(child.send).not.toHaveBeenCalled(); expect(child.stream).not.toHaveBeenCalled()
  })
  it('refuses before reactive compaction rather than retrying the model', async () => {
    const p = provider({ overflow: true }); let checks = 0
    await expect(run(p.value,context(async () => { if (++checks === 3) throw new Error('Source no longer available') }),{ compactModel: 'mock-model' }))
      .rejects.toMatchObject({ reason: 'authority_changed' })
    expect(p.send).toHaveBeenCalledTimes(1); expect(compactConversation).not.toHaveBeenCalled(); expect(p.stream).not.toHaveBeenCalled()
  })
  it('refuses terminal synthesis without producing a fallback model response', async () => {
    const p = provider({ tool: true }); let checks = 0
    const observe = buildTool({ name: 'observe',description: 'Observe a fictional record',inputSchema: z.object({}).strict(),isReadOnly: true,isConcurrencySafe: true,
      execute: async () => ({ data: { value: 'Fictional record' } }) })
    await expect(run(p.value,{ ...context(async () => { if (++checks === 3) throw new Error('Source no longer available') }),channelType: 'assistant-call' },{
      tools: new Map([['observe',observe]]),maxTurns: 1,
    })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(p.send).toHaveBeenCalledTimes(1); expect(p.stream).not.toHaveBeenCalled()
  })
  it('checks current output authority before releasing each event and makes refusal sticky',async () => {
    let denied = false,requests = 0
    let delivered!: () => void
    const prefixReceived = new Promise<void>(resolve => { delivered = resolve })
    const observed: QueryEvent[] = []
    const value: LLMProvider = { name: 'fixture',models: ['mock-model'],stream: () => { throw new Error('Unexpected fallback') },
      createSession: () => ({ send: () => (async function* () {
        requests++
        yield { type: 'message_start' as const,model: 'mock-model' }
        yield { type: 'text_delta' as const,text: 'Allowed prefix' }
        await prefixReceived
        yield { type: 'text_delta' as const,text: 'Withheld continuation' }
        yield { type: 'message_end' as const,stopReason: 'end_turn' as const,usage: { inputTokens: 1,outputTokens: 1 } }
      })() }) }
    const ctx: ToolContext = { ...context(async () => {}),executionContext: {security:{authority:undefined}} as unknown as NonNullable<ToolContext['executionContext']>,
      admitModelOutput: async () => { if (denied) throw new Error('Current output unavailable') } }
    const invoke = async () => {
      for await (const event of queryLoop({ provider: value,model: 'mock-model',systemPrompt: 'Fictional context',messages: [{ role: 'user',content: 'Report the values' }],
        tools: new Map(),ledger: NOOP_TURN_LEDGER,maxTurns: 1,context: ctx })) {
        observed.push(event)
        denied = true; delivered()
      }
    }
    await expect(invoke()).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    expect(JSON.stringify(observed)).toContain('Allowed prefix')
    expect(JSON.stringify(observed)).not.toContain('Withheld continuation')
    denied = false
    await expect(invoke()).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    expect(requests).toBe(1)
    expect(compactConversation).not.toHaveBeenCalled()
  })
  it('passes the child accumulator to inherited output checks without releasing its response',async () => {
    const p = provider({ tool: true }),child = provider(),childAccumulator = new ContextScopeAccumulator({ sources: [observedSource] })
    const hook = vi.fn(async (current: ToolContext) => { if (current.scopeAccumulator === childAccumulator) throw new Error('Child output unavailable') })
    const observe = buildTool({ name: 'observe',description: 'Run a fictional child',inputSchema: z.object({}).strict(),isReadOnly: true,isConcurrencySafe: true,
      execute: async (_input,current) => {
        await run(child.value,{ ...current,scopeAccumulator: childAccumulator,sessionId: 'fictional-child' })
        return { data: { value: 'Unreachable child value' } }
      } })
    await expect(run(p.value,{ ...context(async () => {}),admitModelOutput: hook },{ tools: new Map([['observe',observe]]) }))
      .rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    expect(hook.mock.calls.some(([current]) => current.scopeAccumulator === childAccumulator)).toBe(true)
    expect(child.send).toHaveBeenCalledTimes(1)
    expect(p.send).toHaveBeenCalledTimes(1)
  })
  it('keeps final-sink refusal sticky before another model session can be created',async () => {
    const p = provider();let deny = false
    const ctx = { ...context(async () => {}),executionContext: {security:{authority:undefined}} as unknown as NonNullable<ToolContext['executionContext']>,
      admitModelOutput: async () => { if (deny) throw new Error('Final output unavailable') } }
    await run(p.value,ctx)
    deny = true
    await expect(assertModelOutputAuthority(ctx)).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    deny = false
    await expect(run(p.value,ctx)).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    expect(p.createSession).toHaveBeenCalledTimes(1);expect(p.send).toHaveBeenCalledTimes(1)
  })
  it('preserves destination refusal and latches denial before a later dispatch', async () => {
    const refusal = Object.assign(new Error('Fictional destination refusal'), { reason: 'delivery_audience_unverified', retrySafe: false })
    const ctx: ToolContext = { ...context(async () => {}), admitModelOutput: async () => { throw refusal } }
    const dispatch = vi.fn(), assertCurrent = vi.fn()
    await expect(assertModelOutputAuthority(ctx, { dispatch, assertCurrent })).rejects.toBe(refusal)
    ctx.admitModelOutput = async () => {}
    await expect(assertModelOutputAuthority(ctx, { dispatch, assertCurrent })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(dispatch).not.toHaveBeenCalled(); expect(assertCurrent).not.toHaveBeenCalled()
  })
  it('does not expose a destination-shaped refusal from model input preparation', async () => {
    const p = provider()
    const refusal = Object.assign(new Error('Fictional private input refusal'), { reason: 'delivery_audience_unverified' })
    await expect(run(p.value, context(async () => { throw refusal }))).rejects.toMatchObject({
      message: 'The model context is unavailable.', reason: 'authority_changed', retrySafe: false, cause: refusal,
    })
    expect(p.createSession).not.toHaveBeenCalled()
    expect(p.send).not.toHaveBeenCalled()
  })
  it('propagates a delivery refusal before emitting any loop event', async () => {
    const p = provider(), events: QueryEvent[] = []
    const refusal = Object.assign(new Error('The current destination is not authorized for this response.'), {
      reason: 'delivery_audience_unverified', retrySafe: false, diagnostic: 'teams',
    })
    const ctx: ToolContext = { ...context(async () => {}), admitModelOutput: async () => { throw refusal } }
    const collect = async () => {
      for await (const event of queryLoop({ provider: p.value, model: 'mock-model', systemPrompt: 'Fictional context',
        messages: [{ role: 'user', content: 'Read the input' }], tools: new Map(), ledger: NOOP_TURN_LEDGER,
        maxTurns: 2, context: ctx })) events.push(event)
    }
    await expect(collect()).rejects.toBe(refusal)
    expect(events).toEqual([])
  })
  it('keeps a final handoff fence refusal sticky', async () => {
    const ctx = context(async () => {}), dispatch = vi.fn()
    await expect(assertModelOutputAuthority(ctx, { dispatch, assertCurrent() { throw new Error('Fictional evidence mutation') } }))
      .rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    await expect(assertModelOutputAuthority(ctx)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('hands detached events to one output operation without a second yielded copy', async () => {
    const p = provider(), input = vi.fn(async () => {}), output = vi.fn(async () => {}), observed: QueryEvent[] = []
    const dispatchOutput = vi.fn(async (current: ToolContext, event: QueryEvent) => {
      await assertModelOutputAuthority(current, { assertCurrent() {}, dispatch() { observed.push(event) } })
    })
    const yielded = await run(p.value, { ...context(input), admitModelOutput: output }, { dispatchOutput })
    expect(yielded).toEqual([]); expect(observed.length).toBeGreaterThan(0)
    expect(output).toHaveBeenCalledTimes(observed.length); expect(input).toHaveBeenCalledTimes(2)
  })
  it('does not inherit the outer output operation into a nested loop', async () => {
    const p = provider({ tool: true }), child = provider(), childScope = new ContextScopeAccumulator()
    const output = vi.fn(async (current: ToolContext) => { if (current.scopeAccumulator === childScope) throw new Error('Fictional child denial') })
    const observe = buildTool({ name: 'observe', description: 'Run a fictional child', inputSchema: z.object({}).strict(), isReadOnly: true, isConcurrencySafe: true,
      execute: async (_input, current) => {
        expect('dispatchOutput' in current).toBe(false)
        await run(child.value, { ...current, scopeAccumulator: childScope })
        return { data: { value: 'Unreachable child output' } }
      } })
    await expect(run(p.value, { ...context(async () => {}), admitModelOutput: output }, {
      tools: new Map([['observe', observe]]), dispatchOutput: async current => assertModelOutputAuthority(current),
    })).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(output.mock.calls.some(([current]) => current.scopeAccumulator === childScope)).toBe(true)
  })
  it('closes the producer when the output operation stops the turn', async () => {
    const p = provider(), controller = new AbortController(), delivered: QueryEvent[] = []
    await run(p.value, { ...context(async () => {}), abortSignal: controller.signal }, {
      dispatchOutput: async (current, event) => assertModelOutputAuthority(current, {
        assertCurrent() {}, dispatch() { delivered.push(event); controller.abort() },
      }),
    })
    expect(delivered).toHaveLength(1)
  })
  it('preserves typed provider diagnostics at the host output operation', async () => {
    class FixtureFailure extends Error { readonly code = 'fixture_failure' }
    const failure = new FixtureFailure('Fictional provider failure'), p = provider(), delivered: QueryEvent[] = []
    p.send.mockImplementation(() => (async function* () { throw failure })())
    await run(p.value, context(async () => {}), { dispatchOutput: async (current, event) =>
      assertModelOutputAuthority(current, { assertCurrent() {}, dispatch() { delivered.push(event) } }),
    })
    const error = delivered.find(event => event.type === 'error')
    expect(error?.type).toBe('error')
    if (error?.type === 'error') {
      expect(error.error).toBeInstanceOf(FixtureFailure)
      expect(error.error).toHaveProperty('code', 'fixture_failure')
    }
  })
  it('refuses a concurrent denial arising while the output operation awaits', async () => {
    const p = provider(), ctx = { ...context(async () => {}), executionContext: {security:{authority:undefined}} as unknown as NonNullable<ToolContext['executionContext']> }
    const dispatch = vi.fn()
    const output = async (current: ToolContext) => {
      await expect(assertModelOutputAuthority({ ...current, admitModelOutput: async () => { throw new Error('Concurrent denial') } }))
        .rejects.toMatchObject({ reason: 'authority_changed' })
    }
    await expect(run(p.value, { ...ctx, admitModelOutput: output }, { dispatchOutput: async current => {
      await assertModelOutputAuthority(current, { assertCurrent() {}, dispatch })
    } })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(dispatch).not.toHaveBeenCalled()
  })
  // A host admission callback owns its fresh authority interval. Core tests
  // emulate the generic host; SQL admission is exercised by API integration.
  const completeAdmission=(proof:()=>Promise<void>):NonNullable<ToolContext['admitModelOutput']>=>async current=>{
    await current.authority?.assertCurrent()
    const before=JSON.stringify(current.scopeAccumulator?.evidence)
    await proof()
    await current.authority?.assertCurrent()
    if(JSON.stringify(current.scopeAccumulator?.evidence)!==before)throw new Error('Evidence changed during admission')
  }
  it('observes lease withdrawal during an output proof before dispatch', async () => {
    let revoked = false
    const dispatch = vi.fn(), ctx = { ...context(async () => {}),
      authority: { assertCurrent: async () => { if (revoked) throw new Error('Revoked lease') }, execute: async<T>(run: () => Promise<T>) => run() },
      admitModelOutput: completeAdmission(async () => { revoked = true }),
    }
    await expect(assertModelOutputAuthority(ctx, { assertCurrent() {}, dispatch })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('isolates destination refusal while keeping the original lease current for every output operation',async()=>{
    let revoked=false
    const authority={assertCurrent:vi.fn(async()=>{if(revoked)throw new Error('Revoked lease')}),execute:async<T>(run:()=>Promise<T>)=>run()}
    const executionContext={security:{authority}} as unknown as NonNullable<ToolContext['executionContext']>
    const first:ToolContext={...context(async()=>{}),authority,executionContext,admitModelOutput:async()=>{throw new Error('Recipient denied')}}
    await expect(assertOutputOperationAuthority(first)).rejects.toMatchObject({reason:'authority_changed'})
    first.admitModelOutput=completeAdmission(async()=>{})
    await expect(assertOutputOperationAuthority(first)).rejects.toMatchObject({reason:'authority_changed'})
    const second={...first}
    authority.assertCurrent.mockClear()
    await expect(assertOutputOperationAuthority(second)).resolves.toBeUndefined()
    expect(authority.assertCurrent).toHaveBeenCalledTimes(2)
    await expect(assertModelOutputAuthority({...second})).resolves.toBeUndefined()
    revoked=true
    await expect(assertOutputOperationAuthority({...second})).rejects.toMatchObject({reason:'authority_changed'})
  })
  it('delegates one complete admission per physical effect without redundant core lease reads',async()=>{
    const order:string[]=[]
    const ctx={...context(async()=>{}),
      authority:{assertCurrent:async()=>{order.push('lease')},execute:async<T>(run:()=>Promise<T>)=>run()},
      admitModelOutput:completeAdmission(async()=>{order.push('sources')}),
    }
    for(let index=0;index<2;index++)await assertModelOutputAuthority(ctx,{assertCurrent(){},dispatch(){order.push('sink')}})
    expect(order).toEqual(['lease','sources','lease','sink','lease','sources','lease','sink'])
  })
  it('refuses evidence changed during the final lease await and keeps refusal sticky',async()=>{
    let checks=0
    const ctx={...context(async()=>{}),
      authority:{assertCurrent:async()=>{if(++checks===2){await Promise.resolve();ctx.scopeAccumulator!.note({sources:[observedSource]})}},
        execute:async<T>(run:()=>Promise<T>)=>run()},
      admitModelOutput:completeAdmission(async()=>{}),
    }
    const dispatch=vi.fn()
    await expect(assertModelOutputAuthority(ctx,{assertCurrent(){},dispatch})).rejects.toMatchObject({reason:'authority_changed'})
    await expect(assertModelOutputAuthority(ctx,{assertCurrent(){},dispatch})).rejects.toMatchObject({reason:'authority_changed'})
    expect(dispatch).not.toHaveBeenCalled()
    expect(checks).toBe(2)
  })

})
