import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTool } from '../../tools/types.js'
import type { LLMProvider, SessionOptions, StreamChunk, ToolDefinition } from '../../providers/types.js'
import { queryLoop } from '../query-loop.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import { createToolDiscovery } from '../tool-discovery.js'

const context = { userId: 'u', assistantId: 'a', sessionId: 's', appId: 'test',
  channelType: 'web', channelId: 'test', abortSignal: new AbortController().signal }
const useTool = (name: string, input: unknown): StreamChunk[] => [
  { type: 'message_start', model: 'test' },
  { type: 'tool_use_start', id: name, name },
  { type: 'tool_use_delta', id: name, input: JSON.stringify(input) },
  { type: 'tool_use_end', id: name },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
]
const reply: StreamChunk[] = [{ type: 'text_delta', text: 'Done.' },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }]

describe('[COMP:engine/tool-discovery] on-demand schemas', () => {
  it.each([false, true])('loads an exact schema before canonical execution (stateless: %s)', async stateless => {
    const execute = vi.fn(async (_input: { id: string }) => ({ data: 'found' }))
    const read = buildTool({ name: 'findRecord', description: 'Find a record',
      inputSchema: z.object({ id: z.string() }), execute, isReadOnly: true, isConcurrencySafe: true })
    const denied = { ...read, name: 'restrictedRecord', requiresCapability: 'restricted' }
    const hidden = { ...read, name: 'internalRecord', hiddenFromModel: true }
    const tools = new Map([read, denied, hidden].map(tool => [tool.name, tool]))
    const seen: ToolDefinition[][] = []
    let next = 0
    const scripts = [useTool('discoverTools', { query: 'findRecord', limit: 1 }),
      useTool('findRecord', { id: 'fictional-record' }), reply]
    async function* send(options: Pick<SessionOptions, 'tools'>) {
      seen.push(structuredClone(options.tools ?? []))
      yield* scripts[next++] ?? reply
    }
    const provider: LLMProvider = { name: 'test', models: ['test'], stream: send,
      createSession: options => ({ send: () => send(options) }) }
    for await (const _ of queryLoop({ provider, model: 'test', systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Find a record' }], tools, context,
      ledger: NOOP_TURN_LEDGER, deferToolSchemas: true, stateless })) { /* drain */ }
    expect(seen[0].map(tool => tool.name)).toEqual(['discoverTools'])
    expect(JSON.stringify(seen[0])).not.toMatch(/restrictedRecord|internalRecord/)
    expect(seen[1].find(tool => tool.name === 'findRecord')?.parameters).toEqual({
      type: 'object', properties: { id: { type: 'string' } }, required: ['id'],
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0]).toEqual({ id: 'fictional-record' })
    expect(tools.has('discoverTools')).toBe(false)
  })

  it('keeps a large catalog off the first request and isolates bounded loads', async () => {
    const all: ToolDefinition[] = Array.from({ length: 350 }, (_, n) => ({
      name: `findRecord${n}`, description: 'Record search ' + 'schema documentation '.repeat(80),
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
    }))
    const first = createToolDiscovery(all), second = createToolDiscovery(all)
    expect(JSON.stringify({ tools: first.definitions, description: first.tool.description }).length)
      .toBeLessThan(JSON.stringify(all).length / 20)
    await first.tool.execute({ query: 'record', limit: 5 }, context)
    expect(first.definitions).toHaveLength(5)
    await first.tool.execute({ query: first.definitions[0].name, limit: 1 }, context)
    expect(first.definitions).toHaveLength(5)
    expect(second.definitions).toHaveLength(0)
    const missing = await second.tool.execute({ query: 'unavailable', limit: 5 }, context)
    expect(missing.data).toMatchObject({ tools: [] })
    expect(second.definitions).toHaveLength(0)
  })
})
