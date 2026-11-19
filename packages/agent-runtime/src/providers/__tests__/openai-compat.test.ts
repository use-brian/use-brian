import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createOpenAICompatProvider,
  extractCCStreamError,
  extractCCUsage,
  mapCCStopReason,
  DASHSCOPE_INTL_BASE_URL,
} from '../openai-compat.js'
import type { StreamChunk } from '../types.js'

/** Build a Response whose body streams the given SSE `data:` payloads. */
function sseResponse(payloads: Array<Record<string, unknown> | string>): Response {
  const body = payloads
    .map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`)
    .join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const provider = createOpenAICompatProvider({ apiKey: 'k', baseURL: DASHSCOPE_INTL_BASE_URL, label: 'dashscope-intl' })

function lastRequestBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1)!
  return JSON.parse((call[1] as RequestInit).body as string)
}

describe('[COMP:providers/openai-compat] streaming protocol mapping', () => {
  it('maps content deltas, finish_reason and usage (with cached_tokens decomposition)', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } } },
      '[DONE]',
    ]))

    const chunks = await collect(provider.stream({
      model: 'qwen-test-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    }))

    expect(chunks[0]).toEqual({ type: 'message_start', model: 'qwen-test-model' })
    expect(chunks.filter((c) => c.type === 'text_delta').map((c) => (c as { text: string }).text).join('')).toBe('Hello')
    const end = chunks.at(-1)!
    expect(end).toEqual({
      type: 'message_end',
      stopReason: 'end_turn',
      // 1000 prompt tokens of which 800 cached: input bills 200 full-rate,
      // 800 at the cache rate — the decomposition cost-tracker depends on.
      usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 800 },
    })
  })

  it('accumulates tool-call fragments per index and forces stopReason tool_use', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'searchBrain', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]))

    const chunks = await collect(provider.stream({
      model: 'qwen-test-model', systemPrompt: '', messages: [{ role: 'user', content: 'go' }],
    }))

    expect(chunks).toContainEqual({ type: 'tool_use_start', id: 'call_1', name: 'searchBrain' })
    const args = chunks.filter((c) => c.type === 'tool_use_delta').map((c) => (c as { input: string }).input).join('')
    expect(args).toBe('{"query":"x"}')
    expect(chunks).toContainEqual({ type: 'tool_use_end', id: 'call_1' })
    expect((chunks.at(-1) as { stopReason: string }).stopReason).toBe('tool_use')
  })

  it('surfaces reasoning_content as thinking_delta (display-only lane)', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([
      { choices: [{ delta: { reasoning_content: 'pondering…' } }] },
      { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]))
    const chunks = await collect(provider.stream({
      model: 'qwen-test-model', systemPrompt: '', messages: [{ role: 'user', content: 'think' }],
    }))
    expect(chunks).toContainEqual({ type: 'thinking_delta', text: 'pondering…' })
  })

  it('a stream that ends with no finish_reason maps to incomplete', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([
      { choices: [{ delta: { content: 'cut off' } }] },
      '[DONE]',
    ]))
    const chunks = await collect(provider.stream({
      model: 'qwen-test-model', systemPrompt: '', messages: [{ role: 'user', content: 'x' }],
    }))
    expect((chunks.at(-1) as { stopReason: string }).stopReason).toBe('incomplete')
  })

  it('throws a status-carrying error on a non-200 response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"quota"}', { status: 429 }))
    await expect(collect(provider.stream({
      model: 'qwen-test-model', systemPrompt: '', messages: [{ role: 'user', content: 'x' }],
    }))).rejects.toThrow(/HTTP 429/)
  })
})

describe('[COMP:providers/openai-compat] request construction', () => {
  it('supports a fixed custom model without auth or vendor extension fields', async () => {
    const customFetch = vi.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]))
    const custom = createOpenAICompatProvider({
      baseURL: 'http://local-model.example/v1/',
      label: 'workspace-test',
      wireModel: 'llama-local',
      recordedModel: 'custom:00000000-0000-4000-8000-000000000001',
      models: ['custom:00000000-0000-4000-8000-000000000001'],
      fetchFn: customFetch,
      includeStreamUsage: false,
      enableThinkingField: false,
      supportsJsonMode: false,
      includeErrorDetail: false,
    })

    const chunks = await collect(custom.stream({
      model: 'standard-policy-model',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hello' }],
      thinkingLevel: 'high',
      responseFormat: 'json',
    }))
    const [, init] = customFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(custom.models).toEqual(['custom:00000000-0000-4000-8000-000000000001'])
    expect(customFetch.mock.calls[0][0]).toBe('http://local-model.example/v1/chat/completions')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(body.model).toBe('llama-local')
    expect(body).not.toHaveProperty('stream_options')
    expect(body).not.toHaveProperty('enable_thinking')
    expect(body).not.toHaveProperty('response_format')
    expect(chunks[0]).toEqual({
      type: 'message_start',
      model: 'custom:00000000-0000-4000-8000-000000000001',
    })
  })

  it('converts tool_use / tool_result history into tool_calls and role:tool messages', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]',
    ]))

    await collect(provider.stream({
      model: 'qwen-test-model',
      systemPrompt: 'sys',
      tools: [{ name: 'searchBrain', description: 'search', parameters: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: 'find it' },
        { role: 'assistant', content: [
          { type: 'text', text: 'searching' },
          { type: 'tool_use', id: 'call_9', name: 'searchBrain', input: { query: 'x' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', toolUseId: 'call_9', name: 'searchBrain', content: 'found' },
        ] },
      ],
    }))

    const body = lastRequestBody()
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(messages[1]).toEqual({ role: 'user', content: 'find it' })
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'searching',
      tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'searchBrain', arguments: '{"query":"x"}' } }],
    })
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_9', content: 'found' })
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'searchBrain', description: 'search', parameters: { type: 'object', properties: {} } } },
    ])
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('maps thinkingLevel to enable_thinking and omits it by default', async () => {
    fetchMock.mockResolvedValue(sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']))
    await collect(provider.stream({ model: 'm', systemPrompt: '', messages: [{ role: 'user', content: 'x' }] }))
    expect('enable_thinking' in lastRequestBody()).toBe(false)
    await collect(provider.stream({ model: 'm', systemPrompt: '', messages: [{ role: 'user', content: 'x' }], thinkingLevel: 'high' }))
    expect(lastRequestBody().enable_thinking).toBe(true)
    await collect(provider.stream({ model: 'm', systemPrompt: '', messages: [{ role: 'user', content: 'x' }], thinkingLevel: 'low' }))
    expect(lastRequestBody().enable_thinking).toBe(false)
  })

  it('json responseFormat maps to response_format only when no tools are declared', async () => {
    fetchMock.mockResolvedValue(sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']))
    await collect(provider.stream({ model: 'm', systemPrompt: '', messages: [{ role: 'user', content: 'x' }], responseFormat: 'json' }))
    expect(lastRequestBody().response_format).toEqual({ type: 'json_object' })
    await collect(provider.stream({
      model: 'm', systemPrompt: '', messages: [{ role: 'user', content: 'x' }], responseFormat: 'json',
      tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
    }))
    expect('response_format' in lastRequestBody()).toBe(false)
  })
})

describe('[COMP:providers/openai-compat] session history', () => {
  it('replays accumulated history on the second send', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([
        { choices: [{ delta: { content: 'first answer' }, finish_reason: 'stop' }] }, '[DONE]',
      ]))
      .mockResolvedValueOnce(sseResponse([
        { choices: [{ delta: { content: 'second answer' }, finish_reason: 'stop' }] }, '[DONE]',
      ]))

    const session = provider.createSession({ model: 'qwen-test-model', systemPrompt: 'sys' })
    await collect(session.send([{ role: 'user', content: 'one' }]))
    await collect(session.send([{ role: 'user', content: 'two' }]))

    const second = lastRequestBody().messages as Array<Record<string, unknown>>
    expect(second).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'two' },
    ])
  })

  it('a failed send leaves history untouched (context-budget retry safe)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(sseResponse([
        { choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }] }, '[DONE]',
      ]))

    const session = provider.createSession({ model: 'qwen-test-model', systemPrompt: 'sys' })
    await expect(collect(session.send([{ role: 'user', content: 'one' }]))).rejects.toThrow(/HTTP 500/)
    await collect(session.send([{ role: 'user', content: 'one' }]))

    const replay = lastRequestBody().messages as Array<Record<string, unknown>>
    // No duplicated 'one' from the failed attempt.
    expect(replay).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'one' },
    ])
  })
})

describe('[COMP:providers/openai-compat] pure helpers', () => {
  it('mapCCStopReason covers the finish_reason vocabulary', () => {
    expect(mapCCStopReason('stop', false)).toBe('end_turn')
    expect(mapCCStopReason('tool_calls', false)).toBe('tool_use')
    expect(mapCCStopReason('length', false)).toBe('max_tokens')
    expect(mapCCStopReason('content_filter', false)).toBe('safety')
    expect(mapCCStopReason(undefined, false)).toBe('incomplete')
    expect(mapCCStopReason('stop', true)).toBe('tool_use')
  })

  it('extractCCUsage never goes negative on inconsistent vendor counts', () => {
    expect(extractCCUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 150 } }))
      .toEqual({ inputTokens: 0, outputTokens: 5, cacheReadTokens: 150 })
  })

  it('extractCCStreamError reads every shape an endpoint puts an error in', () => {
    expect(extractCCStreamError(undefined)).toBeNull()
    expect(extractCCStreamError(null)).toBeNull()
    expect(extractCCStreamError('')).toBeNull()
    expect(extractCCStreamError('upstream timed out')).toBe('upstream timed out')
    expect(extractCCStreamError({ message: 'rate limited', code: 'rate_limit_exceeded' }))
      .toBe('rate limited (rate_limit_exceeded)')
    expect(extractCCStreamError({ message: 'boom', type: 'server_error' })).toBe('boom (server_error)')
    // A gateway that forwarded an upstream body without unwrapping it.
    expect(extractCCStreamError({ error: { message: 'context length exceeded' } }))
      .toBe('context length exceeded')
    // Unrecognised shape: still an error. Returning null here would restore
    // the silence this helper exists to end.
    expect(extractCCStreamError({ detail: 'weird' })).toBe('{"detail":"weird"}')
  })
})

describe('[COMP:providers/openai-compat] in-stream error frames', () => {
  it('throws when a 200 stream carries an error frame and no content', async () => {
    // The 2026-08-25 shape: HTTP 200, an error frame, no choices, no usage.
    // Swallowed, this became `message_end` with 0/0 usage — an upstream
    // outage wearing the costume of a model that chose to say nothing.
    fetchMock.mockResolvedValueOnce(sseResponse([
      { error: { message: 'upstream provider unavailable', type: 'server_error' } },
      '[DONE]',
    ]))

    await expect(collect(provider.stream({
      model: 'qwen-test-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    }))).rejects.toThrow(/upstream returned an error mid-stream/)
  })

  it('keeps upstream wording out of the message when includeErrorDetail is false', async () => {
    // Custom workspace endpoints run with includeErrorDetail: false — the
    // same redaction contract the non-2xx throw already honours. The wording
    // still travels in `cause`, which never reaches the wire.
    const customFetch = vi.fn().mockResolvedValueOnce(sseResponse([
      { error: { message: 'secret-internal-hostname refused the request' } },
    ]))
    const custom = createOpenAICompatProvider({
      apiKey: 'k',
      baseURL: 'https://endpoint.example/v1',
      label: 'custom',
      fetchFn: customFetch,
      includeErrorDetail: false,
    })

    const err = await collect(custom.stream({
      model: 'sol-high',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })).then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err!.message).not.toContain('secret-internal-hostname')
    expect(err!.cause).toContain('secret-internal-hostname')
  })

  it('keeps partial output and ends truncated when the error arrives mid-answer', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([
      { choices: [{ delta: { content: 'partial ' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
      { error: { message: 'connection reset' } },
    ]))

    const chunks = await collect(provider.stream({
      model: 'qwen-test-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    }))

    expect(chunks.filter((c) => c.type === 'text_delta').map((c) => (c as { text: string }).text).join(''))
      .toBe('partial answer')
    expect(chunks.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'incomplete' })
  })

  it('names a content-free stream in the log instead of ending silently', async () => {
    // No error frame at all — the endpoint just hung up. Nothing here is
    // thrown (a model may legitimately stop with no content), but the frame
    // shape is the only evidence the next investigation gets.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(sseResponse(['[DONE]']))

    const chunks = await collect(provider.stream({
      model: 'qwen-test-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    }))

    expect(chunks).toHaveLength(2) // message_start + message_end, nothing between
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stream produced no content'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('closed the stream without completing it'))
    warn.mockRestore()
  })
})

describe('[COMP:providers/openai-compat] non-image inline documents', () => {
  it('degrades a PDF image block to a text note instead of a broken image_url', async () => {
    // Regression: the engine models an attached PDF as an `image` block (for
    // Gemini's native inlineData reader). Sending it here as an image_url made
    // Qwen-VL return HTTP 400 "The image format is illegal and cannot be
    // opened" — and, once persisted to history, wedged every later turn.
    fetchMock.mockResolvedValueOnce(sseResponse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]))

    await collect(provider.stream({
      model: 'qwen-test-model',
      systemPrompt: 'sys',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'read this' },
          { type: 'image', mimeType: 'application/pdf', data: 'JVBERi0xLjQ=' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
      }],
    }))

    const body = lastRequestBody()
    const userMsg = (body.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user')!
    const parts = userMsg.content as Array<Record<string, unknown>>

    // Only the real image survives as image_url; the PDF must NOT.
    const imageUrls = parts.filter((p) => p.type === 'image_url')
    expect(imageUrls).toHaveLength(1)
    expect((imageUrls[0] as { image_url: { url: string } }).image_url.url).toMatch(/^data:image\/png;base64,/)

    // The PDF is replaced by an inline text note the model can act on.
    const note = parts.find(
      (p) => p.type === 'text' && /application\/pdf.*cannot be read inline/i.test(String(p.text)),
    )
    expect(note).toBeTruthy()
  })

  it('degrades historical images for a text-only porter instead of wedging later turns', async () => {
    // Production regression, 2026-08-12: a custom porter verified text and
    // function calls, then rejected a later text turn because replayed history
    // still contained an older screenshot at messages.70.content.0.
    fetchMock.mockResolvedValueOnce(sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]))
    const textOnly = createOpenAICompatProvider({
      baseURL: 'https://porter.example/v1',
      label: 'workspace-test',
      supportsVision: false,
    })

    await collect(textOnly.stream({
      model: 'text-and-tools',
      systemPrompt: '',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { type: 'text', text: 'Continue with the next task.' },
        ],
      }],
    }))

    const body = lastRequestBody()
    expect(JSON.stringify(body.messages)).not.toContain('image_url')
    expect(JSON.stringify(body.messages)).toContain('text-only model cannot inspect it')
  })
})
