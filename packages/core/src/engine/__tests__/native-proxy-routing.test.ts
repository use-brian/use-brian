import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { createMemoryTools } from '../../memory/tools.js'
import type { MemoryStore } from '../../memory/types.js'
import { buildToolIndex, createMcpSearchTools, type ToolSource } from '../../mcp/tool-search.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { ContentBlock, LLMProvider, Message, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { askQuestionTool } from '@use-brian/agent-runtime/tools/base/ask-question.js'
import { createToolExecutor, type ToolExecutorOptions } from '@use-brian/agent-runtime/engine/tool-executor.js'
import { createLoopDetector } from '@use-brian/agent-runtime/engine/loop-detector.js'
import { queryLoop, type QueryEvent } from '@use-brian/agent-runtime/engine/query-loop.js'
import { NOOP_TURN_LEDGER } from '@use-brian/agent-runtime/engine/turn-ledger.js'

const context: ToolContext = { userId: 'fixture-user', assistantId: 'fixture-assistant', sessionId: 'fixture-session',
  appId: 'fixture', channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal }
const usage = { inputTokens: 1, outputTokens: 1 }
function registry(target: Tool, sources: ToolSource[] = []) {
  const proxy = createMcpSearchTools({ index: buildToolIndex(sources), settingsStore: {} as McpSettingsStore,
    assistantId: context.assistantId, userId: context.userId })
  return new Map([...proxy, target].map(tool => [tool.name, tool]))
}
function native(name = 'saveMemory') {
  return buildTool({ name, description: 'Fictional native operation', inputSchema: z.object({ summary: z.string() }),
    isReadOnly: false, execute: vi.fn(async () => ({ data: 'Fictional success' })) })
}
async function drain(executor: ReturnType<typeof createToolExecutor>) {
  const blocks: ContentBlock[] = []
  for await (const batch of executor.getRemainingResults()) blocks.push(...batch.blocks)
  return blocks
}
function executor(tools: Map<string, Tool>, options: Partial<ToolExecutorOptions> = {}) {
  return createToolExecutor({ tools, context, loopDetector: createLoopDetector(), ...options })
}
function* call(name: string, input: Record<string, unknown>, id: string): Generator<StreamChunk> {
  yield { type: 'tool_use_start', id, name }
  yield { type: 'tool_use_delta', id, input: JSON.stringify(input) }
  yield { type: 'tool_use_end', id }
  yield { type: 'message_end', stopReason: 'tool_use', usage }
}

describe('[COMP:engine/native-proxy-routing]', () => {
  it.each(['Brian', 'brian'])('executes the real memory tool through canonical guards for server=%s', async server => {
    // Real tool implementation, in-memory fake store; no database or user data.
    const create = vi.fn(async input => ({ ...input, id: '10000000-0000-4000-8000-000000000001' }))
    const memory = createMemoryTools({ create } as unknown as MemoryStore).saveMemory
    const onToolStart = vi.fn(), onToolEnd = vi.fn()
    const run = executor(registry(memory), { onToolStart, onToolEnd })
    run.addTool('memory-call', 'mcp_call', { server, tool: 'saveMemory', args: { summary: 'Fictional durable preference' } })
    expect(await drain(run)).toEqual([expect.objectContaining({ type: 'tool_result', toolUseId: 'memory-call',
      name: 'mcp_call', isError: undefined, content: expect.stringContaining('Saved memory') })])
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ summary: 'Fictional durable preference',
      userId: context.userId, assistantId: context.assistantId, sourceSessionId: context.sessionId }))
    expect(onToolStart).toHaveBeenCalledWith('memory-call', 'saveMemory')
    expect(onToolEnd).toHaveBeenCalledWith('memory-call', 'saveMemory', expect.any(Object))
  })

  it('validates the native schema, including JSON-encoded proxy args, before execution', async () => {
    const target = native(), run = executor(registry(target))
    run.addTool('invalid', 'mcp_call', { server: 'brian', tool: target.name, args: { summary: 42 } })
    expect(await drain(run)).toEqual([expect.objectContaining({ name: 'mcp_call', isError: true,
      content: expect.stringContaining('summary') })])
    expect(target.execute).not.toHaveBeenCalled()
    run.addTool('valid', 'mcp_call', { server: 'brian', tool: target.name, args: JSON.stringify({ summary: 'Fictional preference' }) })
    expect(await drain(run)).toEqual([expect.objectContaining({ name: 'mcp_call', content: 'Fictional success' })])
    expect(target.execute).toHaveBeenCalledOnce()
    expect(target.execute).toHaveBeenCalledWith({ summary: 'Fictional preference' }, expect.any(Object))
  })

  it('shares canonical approval and denial state with direct calls', async () => {
    const target = { ...native(), requiresConfirmation: true }
    const deniedTools = new Set<string>(), requests = vi.fn()
    const run = executor(registry(target), { deniedTools, onConfirmationRequired: requests,
      confirmationResolver: { resolve: () => {}, waitForDecision: async () => ({ decision: 'deny' }) } })
    run.addTool('proxy-denied', 'mcp_call', { server: 'brian', tool: target.name, args: { summary: 'Fictional preference' } })
    expect(await drain(run)).toEqual([expect.objectContaining({ name: 'mcp_call', isError: true })])
    expect(requests).toHaveBeenCalledWith(expect.objectContaining({ toolName: target.name, input: { summary: 'Fictional preference' } }))
    expect(deniedTools.has(target.name)).toBe(true)
    run.addTool('direct-denied', target.name, { summary: 'Other fictional preference' })
    expect(await drain(run)).toEqual([expect.objectContaining({ name: target.name, isError: true })])
    expect(target.execute).not.toHaveBeenCalled()
    expect(requests).toHaveBeenCalledOnce()
  })

  it.each(['capability', 'workflow', 'clearance'] as const)('preserves the target %s gate', async gate => {
    const target = { ...native(), inputSchema: z.object({ summary: z.string(), sensitivity: z.enum(['public', 'confidential']).optional() }),
      requiresConfirmation: gate === 'workflow', ...(gate === 'capability' ? { requiresCapability: 'restricted' } : {}) }
    const run = executor(registry(target), {
      ...(gate === 'workflow' ? { permissionGrantEvaluator: async () => ({ kind: 'block' as const, workflowRunId: 'fixture',
        grant: { action_kind: target.name, grant: 'block' as const } }) } : {}),
      context: { ...context, clearance: 'public' },
    })
    run.addTool('blocked', 'mcp_call', { server: 'brian', tool: target.name,
      args: { summary: 'Fictional preference', ...(gate === 'clearance' ? { sensitivity: 'confidential' } : {}) } })
    expect(await drain(run)).toEqual([expect.objectContaining({ name: 'mcp_call', isError: true })])
    expect(target.execute).not.toHaveBeenCalled()
  })

  it.each(['hidden', 'not-admitted', 'missing'] as const)('does not route a %s native target', async restriction => {
    const target = { ...native(), hiddenFromModel: restriction === 'hidden' }
    const tools = registry(target)
    if (restriction === 'missing') tools.delete(target.name)
    const run = executor(tools, restriction === 'not-admitted' ? { admittedToolNames: new Set(['mcp_search', 'mcp_call']) } : {})
    run.addTool('blocked', 'mcp_call', { server: 'brian', tool: target.name, args: { summary: 'Fictional preference' } })
    expect(await drain(run)).toEqual([expect.objectContaining({ name: 'mcp_call', isError: true,
      content: expect.stringContaining('NOT executed') })])
    expect(target.execute).not.toHaveBeenCalled()
  })

  it.each(['hidden', 'denied', 'capability'] as const)('does not route through a %s proxy', async restriction => {
    const target = native(), tools = registry(target), proxy = tools.get('mcp_call')!
    tools.set(proxy.name, { ...proxy, hiddenFromModel: restriction === 'hidden',
      ...(restriction === 'capability' ? { requiresCapability: 'restricted' } : {}) })
    const run = executor(tools, { deniedTools: new Set(restriction === 'denied' ? ['mcp_call'] : []) })
    run.addTool('blocked', 'mcp_call', { server: 'brian', tool: target.name, args: { summary: 'Fictional preference' } })
    expect(await drain(run)).toEqual([expect.objectContaining({ name: 'mcp_call', isError: true })])
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('withholds routed results after live authority loss without inviting a retry', async () => {
    const target = native(), refusal = Object.assign(new Error('Fictional authority revoked'), { reason: 'authority_changed' })
    const run = executor(registry(target), { context: { ...context, authority: {
      assertCurrent: async () => {}, execute: async operation => { await operation(); throw refusal },
    } } })
    run.addTool('authority', 'mcp_call', { server: 'brian', tool: target.name, args: { summary: 'Fictional preference' } })
    await expect(drain(run)).rejects.toBe(refusal)
    expect(target.execute).toHaveBeenCalledOnce()
  })

  it('uses canonical concurrency slots rather than executing nested tools inside a proxy slot', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const read = buildTool({ name: 'nativeRead', description: 'Fictional read', inputSchema: z.object({}),
      isReadOnly: true, isConcurrencySafe: true, execute: vi.fn(async () => { await gate; return { data: 'Read' } }) })
    const write = native(), tools = registry(read)
    tools.set(write.name, write)
    const run = executor(tools)
    run.addTool('read-1', 'mcp_call', { server: 'brian', tool: read.name })
    run.addTool('read-2', 'mcp_call', { server: 'brian', tool: read.name })
    run.addTool('write', 'mcp_call', { server: 'brian', tool: write.name, args: { summary: 'Fictional preference' } })
    await vi.waitFor(() => expect(read.execute).toHaveBeenCalledTimes(2))
    expect(write.execute).not.toHaveBeenCalled()
    release()
    expect(await drain(run)).toHaveLength(3)
    expect(write.execute).toHaveBeenCalledOnce()
  })

  it.each([true, false])('does not steal a real Brian source identity (matching tool=%s)', async matching => {
    const target = native(), indexed = { ...native(matching ? target.name : 'otherOperation'), requiresConfirmation: false }
    const run = executor(registry(target, [{ kind: 'local', serverName: 'Brian', tools: [indexed] }]))
    run.addTool('source', 'mcp_call', { server: 'Brian', tool: target.name, args: { summary: 'Fictional preference' } })
    const result = await drain(run)
    expect(target.execute).not.toHaveBeenCalled()
    expect(indexed.execute).toHaveBeenCalledTimes(matching ? 1 : 0)
    expect(result).toEqual([expect.objectContaining({ name: 'mcp_call', ...(matching ? {} : { isError: true }) })])
  })

  it.each(['eager', 'dynamic', 'native-deferred'] as const)('search-to-proxy execution works without a second discovery in %s mode', async mode => {
    const target = native('useSkill'), tools = registry(target)
    let turn = 0
    async function* send(messages: Message[]) {
      if (turn++ === 0) yield* call('mcp_search', { query: target.name, limit: 1 }, 'search')
      else if (turn === 2) {
        expect(JSON.stringify(messages)).toContain('server=\\"brian\\"')
        yield* call('mcp_call', { server: 'brian', tool: target.name, args: { summary: 'Fictional preference' } }, 'invoke')
      } else {
        expect(messages.flatMap(message => Array.isArray(message.content) ? message.content : []))
          .toContainEqual(expect.objectContaining({ type: 'tool_result', name: 'mcp_call', toolUseId: 'invoke', content: 'Fictional success' }))
        yield { type: 'text_delta', text: 'Done.' } as const
        yield { type: 'message_end', stopReason: 'end_turn', usage } as const
      }
    }
    const provider: LLMProvider = { name: 'fixture', models: ['fixture'], toolSchemaMode: () => mode,
      stream: request => send(request.messages), createSession: () => ({ send }) }
    const events: QueryEvent[] = []
    for await (const event of queryLoop({ provider, model: 'fixture', systemPrompt: 'Fictional test',
      messages: [{ role: 'user', content: 'Use a fictional skill' }], tools, context, ledger: NOOP_TURN_LEDGER, deferToolSchemas: true })) events.push(event)
    expect(target.execute).toHaveBeenCalledOnce()
    expect(events).toContainEqual({ type: 'tool_input', id: 'invoke', name: target.name, input: { summary: 'Fictional preference' } })
    expect(events.filter(event => event.type === 'tool_result').flatMap(event => event.results)).toContainEqual(
      expect.objectContaining({ name: target.name, toolUseId: 'invoke', content: 'Fictional success' }))
  })

  it.each([false, true])('keeps askQuestion terminal control-flow through the proxy (suspend=%s)', async suspend => {
    const tools = registry(askQuestionTool), createPendingQuestion = vi.fn(async () => 'fixture-approval')
    const provider: LLMProvider = { name: 'fixture', models: ['fixture'], async *stream() {}, createSession: () => ({
      async *send() { yield* call('mcp_call', { server: 'brian', tool: 'askQuestion', args: { question: 'Which fictional choice?', options: ['Alpha', 'Beta'] } }, 'question') },
    }) }
    const events: QueryEvent[] = []
    for await (const event of queryLoop({ provider, model: 'fixture', systemPrompt: 'Fictional test',
      messages: [{ role: 'user', content: 'Ask a fictional question' }], tools, context: { ...context,
        ...(suspend ? { createPendingQuestion } : {}) }, ledger: NOOP_TURN_LEDGER, questionResumeEnabled: suspend })) events.push(event)
    expect(events).toContainEqual({ type: 'text_delta', text: 'Which fictional choice?' })
    if (suspend) {
      expect(createPendingQuestion).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'question', question: 'Which fictional choice?' }))
      expect(events.some(event => event.type === 'awaiting_approval')).toBe(true)
    } else expect(events).toContainEqual({ type: 'question', question: 'Which fictional choice?', options: ['Alpha', 'Beta'] })
  })
})
