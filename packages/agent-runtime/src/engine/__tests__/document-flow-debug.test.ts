import { afterEach, describe, expect, it, vi } from 'vitest'
import { debugDocumentFlow, summarizeDocumentMessages, withDocumentFlowDebug } from '../document-flow-debug.js'
import { createOpenAICompatProvider } from '../../providers/openai-compat.js'
import { wrapIdleTimeout } from '../../providers/wrappers.js'
import { queryLoop } from '../query-loop.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import { buildTool } from '../../tools/types.js'
import { z } from 'zod'
import type { Message } from '../../providers/types.js'

const secret = 'PRIVATE-file.pdf https://private.example/ Bearer secret base64SECRET'
const messages: Message[] = [{ role: 'user', content: [
  { type: 'text', text: secret },
  { type: 'image', name: secret, mimeType: 'application/pdf', data: secret },
  { type: 'image', name: secret, mimeType: secret, data: secret },
  { type: 'tool_use', id: secret, name: secret, input: { secret } },
  { type: 'tool_result', toolUseId: secret, name: secret, content: secret, isError: true },
] }]
function capture() {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
  return { spy, events: () => spy.mock.calls.filter(([prefix]) => prefix === '[document-flow-debug]').map(([, json]) => JSON.parse(json as string)) }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('temporary document-flow diagnostics', () => {
  it.each([undefined, '', '0', 'true'])('does no work unless exactly 1 (%s)', (value) => {
    vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', value)
    const { spy } = capture()
    const hostile = { get messages(): Message[] { throw new Error('must not inspect') } }
    expect(() => debugDocumentFlow('request', hostile)).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('logs only bounded allowlisted metadata, never payloads or arbitrary labels', () => {
    vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
    const { spy, events } = capture()
    debugDocumentFlow('response', { sessionId: secret, model: secret, messages, stopReason: secret, toolName: secret,
      wire: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: secret } }] }],
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 }, error: true })
    const output = JSON.stringify(spy.mock.calls)
    for (const forbidden of ['PRIVATE', 'https:', 'Bearer', 'base64SECRET', 'file.pdf']) expect(output).not.toContain(forbidden)
    expect(events()[0]).toMatchObject({ model: 'other', toolName: 'other', stopReason: 'other', summary: { pdf: 1, otherMime: 1, toolUse: 1, toolResult: 1, resultErrors: 1, tools: { other: 1 } }, wire: { imageUrlParts: 1 }, usage: { inputTokens: 10 } })
    expect(events()[0].session).toMatch(/^[a-f0-9]{16}$/)
  })

  it('counts very large strings without serializing inputs and bounds output independent of block count', () => {
    vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
    const { spy } = capture()
    const huge = 'x'.repeat(20_000_000)
    const input = { toJSON() { throw new Error('must not serialize') } }
    const blocks = Array.from({ length: 10000 }, () => ({ type: 'tool_use' as const, id: secret, name: secret, input }))
    const large: Message[] = [{ role: 'user', content: [{ type: 'image', mimeType: 'application/pdf', data: huge }, ...blocks] }]
    expect(summarizeDocumentMessages(large)).toMatchObject({ dataChars: huge.length, toolUse: 10000 })
    debugDocumentFlow('request', { messages: large })
    expect(spy.mock.calls[0][1].length).toBeLessThan(1500)
  })

  it('isolates concurrent session scopes and tolerates logger failure', async () => {
    vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
    const { events, spy } = capture()
    async function* run() { await Promise.resolve(); debugDocumentFlow('request', {}); yield 1; debugDocumentFlow('response', {}) }
    await Promise.all(['a', 'b'].map(async (id) => { for await (const _ of withDocumentFlowDebug(id, run())) { /* drain */ } }))
    const rows = events()
    expect(new Set(rows.map(r => r.session)).size).toBe(2)
    for (const session of new Set(rows.map(r => r.session))) expect(rows.filter(r => r.session === session).map(r => r.event)).toEqual(['request', 'response'])
    spy.mockImplementation(() => { throw new Error(secret) })
    expect(() => debugDocumentFlow('request', { messages })).not.toThrow()
  })

  it('records tool presence on both sides of the real capability filter', async () => {
    vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
    const { events, spy } = capture()
    const names = ['listDocumentExtractionConnectors', 'prepareDocumentExtraction', 'startDocumentExtraction', 'readDocumentExtraction', 'proposeOfficeEvidenceFill', 'mcp_search', 'mcp_call', secret]
    const tools = names.map((name, index) => buildTool({ name, description: secret, inputSchema: z.object({}),
      ...(index === 1 ? { requiresCapability: 'private-capability' } : {}),
      ...(index === 2 ? { hiddenFromModel: true } : {}), execute: async () => ({ data: '' }) }))
    const provider = { name: 'test', models: [], createSession() { throw new Error('stateless test') }, async *stream() {
      yield { type: 'text_delta' as const, text: 'done' }
      yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 0, outputTokens: 1 } }
    } }
    for await (const _ of queryLoop({ ledger: NOOP_TURN_LEDGER, provider, model: 'gemini-3.8-flash', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }], tools: new Map(tools.map(t => [t.name, t])), maxTurns: 1, stateless: true,
      context: { userId: 'u', assistantId: 'a', sessionId: secret, appId: 'test', channelType: 'web', channelId: 'c', abortSignal: new AbortController().signal },
    })) { /* drain */ }
    const rows = events().filter(r => r.event === 'tool_availability')
    expect(rows.map(r => r.phase)).toEqual(['before_filter', 'after_filter'])
    expect(rows[0].declarations).toMatchObject({ total: 8, presence: { prepareDocumentExtraction: true, startDocumentExtraction: true, mcp_call: true } })
    expect(rows[1].declarations).toMatchObject({ total: 6, presence: { prepareDocumentExtraction: false, startDocumentExtraction: false, readDocumentExtraction: true, mcp_search: true } })
    expect(rows[0].session).toBe(events().find(r => r.event === 'request').session)
    expect(rows[1].session).toBe(rows[0].session)
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret)
  })

  it('records timeout without emitting the thrown error or request payload', async () => {
    vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
    const { events, spy } = capture()
    const stream = wrapIdleTimeout(1)(async function* () { await new Promise(() => {}); yield { type: 'text_delta', text: secret } })
    await expect(async () => {
      for await (const _ of stream({ model: 'gpt-5.6-sol', messages, systemPrompt: secret })) { /* drain */ }
    }).rejects.toThrow('Stream idle')
    expect(events()).toContainEqual(expect.objectContaining({ event: 'stream_error', timeout: true, error: true }))
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret)
  })

  it.each([false, true])('traces actual OpenAI serialization before and after tools (stateless=%s)', async (stateless) => {
    vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
    const { events, spy } = capture()
    const frames = [
      [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'readDocumentExtraction', arguments: '{}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
      [{ choices: [{ delta: { content: secret }, finish_reason: 'stop' }] }],
    ]
    const fetchFn = vi.fn(async () => new Response([...frames.shift()!, '[DONE]'].map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''), { status: 200 }))
    const provider = createOpenAICompatProvider({ apiKey: secret, baseURL: 'https://private.example', label: 'test', fetchFn, supportsVision: true })
    const tool = buildTool({ name: 'readDocumentExtraction', description: secret, inputSchema: z.object({}), maxResultSizeChars: 8, isConcurrencySafe: true, execute: async () => ({ data: secret }) })
    for await (const _ of queryLoop({ ledger: NOOP_TURN_LEDGER, provider, model: 'gpt-5.6-sol', systemPrompt: secret, messages: [messages[0]!], tools: new Map([[tool.name, tool]]), stateless,
      context: { userId: 'u', assistantId: 'a', sessionId: secret, appId: 'test', channelType: 'web', channelId: 'c', abortSignal: new AbortController().signal }, maxTurns: 3,
    })) { /* drain */ }
    const requests = events().filter(r => r.event === 'request')
    expect(requests).toHaveLength(2)
    expect(requests[1].mode).toBe(stateless ? 'stateless_full' : 'stateful_delta')
    expect(requests[1].summary.pdf).toBe(stateless ? 1 : 0)
    const wire = events().filter(r => r.event === 'openai_wire')
    expect(wire).toHaveLength(2)
    expect(wire[0].summary.pdf).toBe(1)
    expect(wire[1].summary.pdf).toBe(1) // stateful adapter has retained history
    expect(wire[1].wire.imageUrlParts).toBe(0) // PDF degraded to note by this adapter
    expect(wire[1].wire.toolMessages).toBeGreaterThan(0)
    expect(wire[1].session).toBe(requests[1].session)
    expect(events().find(r => r.event === 'response').summary.tools.readDocumentExtraction).toBe(1)
    expect(events().find(r => r.event === 'tool_completion')).toMatchObject({ truncated: true, inputChars: secret.length, toolName: 'readDocumentExtraction' })
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret)
  })
})
