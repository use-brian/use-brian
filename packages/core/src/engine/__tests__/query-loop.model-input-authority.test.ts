import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ContextScopeAccumulator } from '../../security/context-scope.js'
import { buildTool, type ToolContext } from '../../tools/types.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import { queryLoop, type QueryEvent, type QueryLoopOptions } from '../query-loop.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
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
  const context = (hook: NonNullable<ToolContext['assertModelInputAuthority']>): ToolContext => ({
    userId: 'fictional-user',assistantId: 'fictional-assistant',sessionId: 'fictional-session',appId: 'fixture',channelType: 'web',channelId: 'fixture',
    abortSignal: new AbortController().signal,scopeAccumulator: new ContextScopeAccumulator(),assertModelInputAuthority: hook,
  })
  async function run(value: LLMProvider, ctx: ToolContext, extra: Partial<QueryLoopOptions> = {}) {
    const events: QueryEvent[] = []
    for await (const event of queryLoop({ provider: value,model: 'mock-model',systemPrompt: 'Fictional context',messages: [{ role: 'user',content: 'Read the input' }],
      tools: new Map(),ledger: NOOP_TURN_LEDGER,maxTurns: 2,context: ctx,...extra })) events.push(event)
    return events
  }
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
})
