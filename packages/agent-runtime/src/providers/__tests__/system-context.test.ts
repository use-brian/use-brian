import { afterEach, describe, expect, it, vi } from 'vitest'
import { systemContextParts, renderSystemContext, extractHistorySystemContext, COMPACTED_HISTORY_LEAD } from '../system-context.js'
import { createGeminiProvider } from '../gemini.js'
import { vertexTransport } from '../google-transport.js'
import { createOpenAICompatProvider, DASHSCOPE_INTL_BASE_URL } from '../openai-compat.js'
import { createAnthropicProvider } from '../anthropic.js'
import { wrapFallback } from '../wrap-fallback.js'
import { wrapEndpointFallback } from '../wrap-endpoint-fallback.js'
import { wrapProvider } from '../wrappers.js'
import { queryLoop } from '../../engine/query-loop.js'
import { NOOP_TURN_LEDGER } from '../../engine/turn-ledger.js'
import type { LLMProvider, Message, StreamChunk } from '../types.js'

const { anthropicCreate } = vi.hoisted(() => ({ anthropicCreate: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  messages = { create: anthropicCreate }
} }))

const systemPrompt = 'Stable instructions.\n'.repeat(250)
const runtimeSystemContext = '# Runtime context boundary\n<private_runtime_context>\nCurrent time: 12:00\n</private_runtime_context>'
const messages: Message[] = [{ role: 'user', content: 'Translate the visible quote.' }]
const context = { systemPrompt, runtimeSystemContext }
const runtimeBlock = systemContextParts(context)[1]
async function drain(stream: AsyncIterable<unknown>) { for await (const _ of stream) { /* consume */ } }
function sse(payload: unknown): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('[COMP:providers/system-context] Stable/runtime system transport', () => {
  it('preserves stable bytes, nests private context, and omits empty runtime', () => {
    expect(systemContextParts(context)).toEqual([systemPrompt, `<runtime_context>\n${runtimeSystemContext}\n</runtime_context>`])
    expect(renderSystemContext(context)).toBe(`${systemPrompt}\n\n${runtimeBlock}`)
    expect(systemContextParts({ systemPrompt, runtimeSystemContext: '  ' })).toEqual([systemPrompt])
    expect(renderSystemContext({ systemPrompt: '' })).toBe('')
    expect(systemContextParts({ systemPrompt: '', runtimeSystemContext })).toEqual([runtimeBlock])
  })

  it.each(['studio', 'vertex'] as const)('keeps both Gemini %s parts in systemInstruction on stream and session turns', async (transport) => {
    const bodies: Record<string, any>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }] })
    }))
    const provider = createGeminiProvider(transport === 'studio' ? 'test-key' : vertexTransport({
      project: 'fictional-project', location: 'global', tokenSource: async () => 'test-token',
    }))
    await drain(provider.stream({ model: 'gemini-flash', ...context, messages }))
    const session = provider.createSession({ model: 'gemini-flash', ...context })
    await drain(session.send(messages))
    await drain(session.send([{ role: 'user', content: 'Continue.' }]))
    for (const body of bodies) {
      expect(body.systemInstruction.parts).toEqual([{ text: systemPrompt }, { text: runtimeBlock }])
      expect(JSON.stringify(body.contents)).not.toContain('private_runtime_context')
      expect(body).not.toHaveProperty('cachedContent')
    }
    expect(bodies).toHaveLength(3)
  })

  it.each(['dashscope', 'custom'])('keeps %s runtime in a second system message on both paths', async (endpoint) => {
    const bodies: Record<string, any>[] = []
    const provider = createOpenAICompatProvider({
      apiKey: 'test-key',
      label: endpoint === 'dashscope' ? 'dashscope-intl' : 'custom',
      baseURL: endpoint === 'dashscope' ? DASHSCOPE_INTL_BASE_URL : 'https://llm.example/v1',
      fetchFn: async (_url, init) => {
        bodies.push(JSON.parse(init!.body as string))
        return sse({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] })
      },
    })
    await drain(provider.stream({ model: 'qwen-test', ...context, messages }))
    const session = provider.createSession({ model: 'qwen-test', ...context })
    await drain(session.send(messages))
    await drain(session.send([{ role: 'user', content: 'Continue.' }]))
    for (const body of bodies) {
      expect(body.messages.slice(0, 2)).toEqual([
        { role: 'system', content: systemPrompt }, { role: 'system', content: runtimeBlock },
      ])
      expect(JSON.stringify(body.messages.slice(2))).not.toContain('private_runtime_context')
      expect(body).not.toHaveProperty('cache_control')
    }
    expect(bodies).toHaveLength(3)
  })

  it('retries an explicit single-system requirement once without demoting runtime or changing history', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('Only one system message is allowed', { status: 400 }))
      .mockResolvedValueOnce(sse({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }))
    const provider = createOpenAICompatProvider({ label: 'custom', baseURL: 'https://llm.example/v1', fetchFn })
    await drain(provider.stream({ model: 'custom', ...context, messages }))
    const second = JSON.parse(fetchFn.mock.calls[1][1].body)
    expect(second.messages).toEqual([
      { role: 'system', content: renderSystemContext(context) }, ...messages,
    ])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    fetchFn.mockReset().mockImplementation(async () => new Response('Only one system message is allowed', { status: 400 }))
    await expect(drain(provider.stream({ model: 'custom', ...context, messages }))).rejects.toThrow('HTTP 400')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    fetchFn.mockReset().mockImplementation(async () => new Response('Invalid tool schema', { status: 400 }))
    await expect(drain(provider.stream({ model: 'custom', ...context, messages }))).rejects.toThrow('HTTP 400')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('marks only the stable Anthropic block, including across changing runtime and session turns', async () => {
    anthropicCreate.mockImplementation(async () => (async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } }
    })())
    const provider = createAnthropicProvider({ apiKey: 'test-key' })
    await drain(provider.stream({ model: 'claude-haiku-4-5', ...context, messages }))
    await drain(provider.stream({ model: 'claude-haiku-4-5', ...context, runtimeSystemContext: 'Time: 12:01', messages }))
    await drain(provider.createSession({ model: 'claude-haiku-4-5', ...context }).send(messages))
    const systems = anthropicCreate.mock.calls.map(([request]) => request.system)
    for (const system of systems) {
      expect(system[0]).toEqual({ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } })
      expect(system[1]).not.toHaveProperty('cache_control')
    }
    expect(systems[0][1].text).toBe(runtimeBlock)
    expect(systems[1][1].text).toContain('12:01')
    await drain(provider.stream({ model: 'claude-haiku-4-5', systemPrompt: 'short', runtimeSystemContext: 'x'.repeat(5000), messages }))
    expect(anthropicCreate.mock.calls.at(-1)![0].system.every((block: any) => !block.cache_control)).toBe(true)
    await drain(provider.stream({ model: 'claude-haiku-4-5', systemPrompt: 'short', messages }))
    expect(anthropicCreate.mock.calls.at(-1)![0].system).toBe('short')
  })

  it.each([
    [false, 'outage'], [true, 'outage'], [false, 'endpoint'], [true, 'endpoint'],
  ] as const)('preserves context through query loop and middleware (stateless=%s, fallback=%s)', async (stateless, kind) => {
    const captured: unknown[] = []
    async function* success(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: 'Done.' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    }
    async function* fail(): AsyncGenerator<StreamChunk> { throw Object.assign(new Error('unavailable'), { status: 503 }) }
    const primary: LLMProvider = { name: 'primary', models: ['mock-model'], stream: fail, createSession: () => ({ send: fail }) }
    const fallback: LLMProvider = {
      name: 'fallback', models: ['mock-model'],
      stream: (request) => { captured.push(request); return success() },
      createSession: (options) => { captured.push(options); return { send: success } },
    }
    const provider = wrapProvider(kind === 'outage'
      ? wrapFallback(primary, fallback) : wrapEndpointFallback(primary, fallback))
    const traceStart = vi.spyOn(NOOP_TURN_LEDGER, 'startTrace')
    await drain(queryLoop({
      ledger: NOOP_TURN_LEDGER, provider, model: 'mock-model', ...context, messages,
      tools: new Map(), stateless,
      context: {
        userId: 'user-demo', assistantId: 'assistant-demo', sessionId: 'session-demo',
        appId: 'test', channelType: 'web', channelId: 'channel-demo', abortSignal: new AbortController().signal,
      },
    }))
    expect(captured[0]).toMatchObject(context)
    expect(traceStart).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: renderSystemContext(context) }))
    traceStart.mockRestore()
  })
})

// ── Compacted-history delivery ──────────────────────────────────
// The compaction summary rides the messages array as `{ role: 'system' }`.
// No adapter renders a system-role row as a conversation content, so every
// adapter must hoist it into the system channel. These tests assert the WIRE
// (captured request body), not the array — the gap that let the summary go
// undelivered on Gemini and Anthropic from 2026-04-16 to 2026-09-17.
// See docs/architecture/context-engine/compaction.md → "Summary delivery".

const SUMMARY = '[Conversation compacted at 2026-09-17T00:00:00Z] MARKER_SUMMARY_7c1e: the user chose the Tokyo itinerary.'
const BREADCRUMB = '[3 earlier message(s) omitted to fit the context window.]'
const compactedHistory: Message[] = [
  { role: 'system', content: SUMMARY },
  { role: 'system', content: [{ type: 'text', text: BREADCRUMB }] },
  { role: 'user', content: 'what did we decide earlier?' },
]
const historyBlock = `<compacted_history>\n${COMPACTED_HISTORY_LEAD}\n\n${SUMMARY}\n\n${BREADCRUMB}\n</compacted_history>`

describe('[COMP:providers/system-context] Compacted-history delivery', () => {
  it('extracts every non-empty system-role row in order and renders it between stable and runtime', () => {
    expect(extractHistorySystemContext(compactedHistory)).toEqual([SUMMARY, BREADCRUMB])
    expect(extractHistorySystemContext([{ role: 'system', content: '   ' }, ...messages])).toEqual([])
    expect(systemContextParts({ ...context, historySystemContext: [SUMMARY, BREADCRUMB] }))
      .toEqual([systemPrompt, historyBlock, runtimeBlock])
    expect(systemContextParts({ systemPrompt, historySystemContext: [] })).toEqual([systemPrompt])
    expect(renderSystemContext({ systemPrompt: '', historySystemContext: [SUMMARY, BREADCRUMB] })).toBe(historyBlock)
  })

  it('delivers the summary to Gemini in systemInstruction, never in contents, on stream + session + second send', async () => {
    const bodies: Record<string, any>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Tokyo.' }] }, finishReason: 'STOP' }] })
    }))
    const provider = createGeminiProvider('test-key')
    await drain(provider.stream({ model: 'gemini-flash', ...context, messages: compactedHistory }))
    const session = provider.createSession({ model: 'gemini-flash', ...context })
    await drain(session.send(compactedHistory))
    await drain(session.send([{ role: 'user', content: 'and the hotel?' }]))   // tool-result-style follow-up: no system rows
    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      expect(body.systemInstruction.parts).toEqual([{ text: systemPrompt }, { text: historyBlock }, { text: runtimeBlock }])
      expect(JSON.stringify(body.contents)).not.toContain('MARKER_SUMMARY_7c1e')
      expect(body.contents[0].role).toBe('user')
    }
  })

  it('delivers the summary to Anthropic as a system block, never as a message', async () => {
    anthropicCreate.mockImplementation(async () => (async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Tokyo.' } }
    })())
    const provider = createAnthropicProvider({ apiKey: 'test-key' })
    await drain(provider.stream({ model: 'claude-haiku-4-5', ...context, messages: compactedHistory }))
    const session = provider.createSession({ model: 'claude-haiku-4-5', ...context })
    await drain(session.send(compactedHistory))
    await drain(session.send([{ role: 'user', content: 'and the hotel?' }]))
    expect(anthropicCreate).toHaveBeenCalledTimes(3)
    for (const call of anthropicCreate.mock.calls) {
      const req = call[0]
      expect(req.system.map((b: { text: string }) => b.text)).toEqual([systemPrompt, historyBlock, runtimeBlock])
      expect(JSON.stringify(req.messages)).not.toContain('MARKER_SUMMARY_7c1e')
    }
  })

  it('routes the summary through the ordered system messages on OpenAI-compat, including the single-system retry', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(sse({ choices: [{ delta: { content: 'Tokyo.' }, finish_reason: 'stop' }] }))
      .mockResolvedValueOnce(new Response('Only one system message is allowed', { status: 400 }))
      .mockResolvedValueOnce(sse({ choices: [{ delta: { content: 'Tokyo.' }, finish_reason: 'stop' }] }))
    const provider = createOpenAICompatProvider({ label: 'custom', baseURL: 'https://llm.example/v1', fetchFn })
    await drain(provider.stream({ model: 'custom', ...context, messages: compactedHistory }))
    const first = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(first.messages.slice(0, 3)).toEqual([
      { role: 'system', content: systemPrompt }, { role: 'system', content: historyBlock }, { role: 'system', content: runtimeBlock },
    ])
    expect(first.messages.slice(3).every((m: { role: string }) => m.role !== 'system')).toBe(true)
    await drain(provider.stream({ model: 'custom', ...context, messages: compactedHistory }))
    const retried = JSON.parse(fetchFn.mock.calls[2][1].body)
    expect(retried.messages.filter((m: { role: string }) => m.role === 'system')).toHaveLength(1)
    expect(retried.messages[0].content).toContain('MARKER_SUMMARY_7c1e')
  })
})
