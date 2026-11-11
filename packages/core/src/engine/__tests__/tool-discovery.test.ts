import { registeredToolDefinitions } from '../../providers/tool-registration.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTool } from '../../tools/types.js'
import type { LLMProvider, SessionOptions, StreamChunk, ToolDefinition } from '../../providers/types.js'
import { queryLoop } from '../query-loop.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import { createGeminiProvider } from '../../providers/gemini.js'
import { createRoutingProvider } from '../../providers/routing.js'
import { wrapFallback } from '../../providers/wrap-fallback.js'
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
    async function* send(options: Pick<SessionOptions, 'tools' | 'toolRegistration'>) {
      seen.push([...structuredClone(registeredToolDefinitions(options, 'dynamic'))])
      yield* scripts[next++] ?? reply
    }
    const provider: LLMProvider = { name: 'test', models: ['test'], toolSchemaMode: () => 'dynamic', stream: send,
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

  it.each(([undefined, 'eager'] as const).flatMap(mode => [false, true].map(stateless => ({ mode, stateless }))))('preserves legacy eager tools, including discovery-name collisions ($mode, stateless: $stateless)', async ({ mode, stateless }) => {
    const execute = vi.fn(async () => ({ data: 'original tool' }))
    const original = buildTool({ name: 'discoverTools', description: 'An existing caller-owned tool', inputSchema: z.object({}),
      execute, isReadOnly: true, isConcurrencySafe: true })
    let turn = 0
    async function* send(options: Pick<SessionOptions, 'tools' | 'toolRegistration'>) {
      expect(options.toolRegistration).toBeUndefined()
      expect(options.tools?.map(tool => tool.name)).toEqual(['discoverTools'])
      yield* turn++ === 0 ? useTool('discoverTools', {}) : reply
    }
    const provider: LLMProvider = { name: 'legacy', models: ['test'], toolSchemaMode: mode ? () => mode : undefined,
      stream: send, createSession: options => ({ send: () => send(options) }) }
    for await (const _ of queryLoop({ provider, model: 'test', systemPrompt: 'Test', messages: [{ role: 'user', content: 'Read' }],
      tools: new Map([[original.name, original]]), context, ledger: NOOP_TURN_LEDGER, deferToolSchemas: true, stateless })) { /* drain */ }
    expect(execute).toHaveBeenCalledOnce()
  })

  it.each([false, true])('keeps complete schemas for routed eager fallback drivers (%s)', async stateless => {
    const read = buildTool({ name: 'findRecord', description: 'Find a record', inputSchema: z.object({ id: z.string() }), execute: async () => ({ data: [] }) })
    const optional = { ...read, name: 'optionalRecord', deferredSchemaOnly: true }
    const seen: SessionOptions[] = []
    const eager: LLMProvider = { name: 'legacy', models: [],
      async *stream(options) { seen.push(options); yield* reply },
      createSession: options => ({ async *send() { seen.push(options); yield* reply } }),
    }
    const primary: LLMProvider = { name: 'dynamic', models: [], toolSchemaMode: () => 'dynamic',
      async *stream() { throw Object.assign(new Error('unavailable'), { status: 503 }) },
      createSession: () => ({ async *send() { throw Object.assign(new Error('unavailable'), { status: 503 }) } }),
    }
    const provider = createRoutingProvider({ gemini: wrapFallback(primary, eager) })
    for await (const _ of queryLoop({ provider, model: 'gemini-3.8-flash', systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Read' }], tools: new Map([read, optional].map(t => [t.name, t])), context,
      ledger: NOOP_TURN_LEDGER, deferToolSchemas: true, stateless })) { /* drain */ }
    expect(seen).toHaveLength(1)
    expect(seen[0].tools?.map(t => t.name)).toEqual(['findRecord'])
    expect(seen[0].tools?.[0].parameters.properties).toHaveProperty('id')
    expect(seen[0].toolRegistration?.catalog.map(t => t.name)).toEqual(['findRecord', 'optionalRecord'])
    expect(seen[0].toolRegistration?.active.map(t => t.name)).toEqual(['discoverTools'])
  })

  it('Gemini discovers then executes through the canonical registry while preserving signatures', async () => {
    const execute = vi.fn(async (_input: { id: string }) => ({ data: 'found' }))
    const read = buildTool({ name: 'findRecord', description: 'Find record', inputSchema: z.object({ id: z.string() }), execute, isReadOnly: true, isConcurrencySafe: true })
    const bodies: any[] = []
    const responses = [
      { functionCall: { name: 'discoverTools', args: { query: 'findRecord', limit: 1 } }, thoughtSignature: 'discovery-signature' },
      { functionCall: { name: 'findRecord', args: { id: 'synthetic' } }, thoughtSignature: 'execute-signature' },
      { text: 'Done.' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      bodies.push(JSON.parse(options.body))
      const data = { candidates: [{ content: { role: 'model', parts: [responses.shift()] }, finishReason: 'STOP' }] }
      return new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }))
    try {
      for await (const _ of queryLoop({ provider: createGeminiProvider('synthetic-key'), model: 'gemini-pro', systemPrompt: 'Test',
        messages: [{ role: 'user', content: 'Find record' }], tools: new Map([[read.name, read]]), context,
        ledger: NOOP_TURN_LEDGER, deferToolSchemas: true })) { /* drain */ }
      expect(bodies).toHaveLength(3)
      expect(bodies[0].tools[0].functionDeclarations.map((t: ToolDefinition) => t.name)).toEqual(['discoverTools'])
      expect(bodies[1].tools[0].functionDeclarations.map((t: ToolDefinition) => t.name)).toEqual(['discoverTools', 'findRecord'])
      expect(JSON.stringify(bodies[1].contents)).toContain('discovery-signature')
      expect(execute).toHaveBeenCalledOnce()
      expect(execute.mock.calls[0]?.[0]).toEqual({ id: 'synthetic' })
    } finally { vi.unstubAllGlobals() }
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
