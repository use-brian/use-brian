import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { normalizeGeminiContents, resolveGeminiThinkingLevel, resolveStopReason, stripLeadingRoleToken, stripNonInputParts } from '../gemini.js'

type GeminiContent = Parameters<typeof normalizeGeminiContents>[0][number]

const userText = (text: string): GeminiContent => ({
  role: 'user',
  parts: [{ text }],
})

const userToolResult = (name: string): GeminiContent => ({
  role: 'user',
  parts: [{ functionResponse: { name, response: { result: 'ok' } } }],
})

const modelText = (text: string): GeminiContent => ({
  role: 'model',
  parts: [{ text }],
})

const modelToolCall = (name: string): GeminiContent => ({
  role: 'model',
  parts: [{ functionCall: { name, args: {} } }],
})

describe('[COMP:providers/gemini-normalize] normalizeGeminiContents', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('returns empty array unchanged', () => {
    expect(normalizeGeminiContents([])).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('leaves a well-formed history (user first) untouched', () => {
    const contents = [userText('hi'), modelText('hello'), userText('how are you')]
    expect(normalizeGeminiContents(contents)).toEqual(contents)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('drops a leading model tool_use (the Hinson bug signature)', () => {
    const contents = [
      modelToolCall('weather'),
      userToolResult('weather'),
      modelText('It is 28°C'),
      userText('thanks'),
    ]
    const result = normalizeGeminiContents(contents)
    expect(result).toEqual([userText('thanks')])
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('drops a leading model text turn', () => {
    const contents = [modelText('assistant speaking first'), userText('user reply')]
    expect(normalizeGeminiContents(contents)).toEqual([userText('user reply')])
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('drops a leading orphan tool_result (user role with only functionResponse)', () => {
    const contents = [userToolResult('weather'), userText('next question')]
    expect(normalizeGeminiContents(contents)).toEqual([userText('next question')])
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('keeps a user turn that mixes text and tool_result', () => {
    const mixed: GeminiContent = {
      role: 'user',
      parts: [
        { functionResponse: { name: 'weather', response: { result: 'ok' } } },
        { text: 'and another question' },
      ],
    }
    expect(normalizeGeminiContents([mixed])).toEqual([mixed])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('drops multiple leading invalid contents until it finds a user text turn', () => {
    const contents = [
      modelToolCall('weather'),
      userToolResult('weather'),
      modelText('reply'),
      userText('real user message'),
      modelText('assistant reply'),
    ]
    const result = normalizeGeminiContents(contents)
    expect(result).toEqual([userText('real user message'), modelText('assistant reply')])
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('returns empty array when nothing is salvageable', () => {
    const contents = [modelToolCall('weather'), userToolResult('weather'), modelText('reply')]
    expect(normalizeGeminiContents(contents)).toEqual([])
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('keeps a user turn with inlineData (image) as a valid head', () => {
    const image: GeminiContent = {
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'base64==' } }],
    }
    expect(normalizeGeminiContents([image])).toEqual([image])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('[COMP:providers/gemini-stop-reason] resolveStopReason', () => {
  it('promotes end_turn to tool_use when tool calls are present', () => {
    expect(resolveStopReason('end_turn', true)).toBe('tool_use')
  })

  it('promotes max_tokens to tool_use when tool calls are present (the 09:00 cron incident)', () => {
    // Gemini can return MAX_TOKENS alongside complete tool calls when the
    // thinking budget consumes most of the output budget. Before the fix,
    // the query loop exited here without executing the tools.
    expect(resolveStopReason('max_tokens', true)).toBe('tool_use')
  })

  it('promotes safety to tool_use when tool calls are present', () => {
    expect(resolveStopReason('safety', true)).toBe('tool_use')
  })

  it('leaves end_turn alone when no tool calls', () => {
    expect(resolveStopReason('end_turn', false)).toBe('end_turn')
  })

  it('leaves max_tokens alone when no tool calls (web channel relies on this to auto-continue)', () => {
    expect(resolveStopReason('max_tokens', false)).toBe('max_tokens')
  })

  it('leaves safety alone when no tool calls', () => {
    expect(resolveStopReason('safety', false)).toBe('safety')
  })
})

describe('[COMP:providers/gemini-thinking] resolveGeminiThinkingLevel', () => {
  it('maps low / high to LOW / HIGH for Gemini 3 Pro', () => {
    expect(resolveGeminiThinkingLevel('gemini-3.1-pro-preview', 'low')).toBe('LOW')
    expect(resolveGeminiThinkingLevel('gemini-3.1-pro-preview', 'high')).toBe('HIGH')
  })

  it('maps low / high for Gemini 3 Flash too', () => {
    expect(resolveGeminiThinkingLevel('gemini-3-flash-preview', 'low')).toBe('LOW')
    expect(resolveGeminiThinkingLevel('gemini-3-flash-preview', 'high')).toBe('HIGH')
  })

  it('returns undefined when level is unset (omits thinkingConfig)', () => {
    expect(resolveGeminiThinkingLevel('gemini-3.1-pro-preview', undefined)).toBeUndefined()
  })

  it('returns undefined for models that do not support thinkingConfig', () => {
    // Gemini 2.5 Flash has its own (incompatible) thinking config — we omit.
    expect(resolveGeminiThinkingLevel('gemini-2.5-flash', 'low')).toBeUndefined()
    expect(resolveGeminiThinkingLevel('gemini-pro-1.5', 'high')).toBeUndefined()
  })
})

/**
 * The request-boundary guard. This is the class-level fix for the production
 * 400 "Unsupported input part type: go/debugproto \nthought: true": it asserts
 * the Gemini INPUT-part contract directly, with NO mocked `fetch` — which is
 * the exact gap that let the original bug ship (the session-stream test only
 * checked the payload we built, never that the API would accept it).
 */
describe('[COMP:providers/gemini-input-parts] stripNonInputParts', () => {
  // The guard `console.warn`s whatever it strips; silence it so the drop
  // cases don't spam test output (it fires by design here).
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  it('drops a bare { thought: true } part — the production 400 shape', () => {
    const out = stripNonInputParts([
      { role: 'model', parts: [{ thought: true }, { text: 'hello' }] },
    ])
    expect(out).toEqual([{ role: 'model', parts: [{ text: 'hello' }] }])
  })

  it('drops a thought part even when it carries a signature or body', () => {
    const out = stripNonInputParts([
      {
        role: 'model',
        parts: [
          { thought: true, thoughtSignature: 'sig', text: 'reasoning' },
          { text: 'visible' },
        ],
      },
    ])
    // Reasoning is never re-sent, signature or not. Visible text survives.
    expect(out[0].parts).toEqual([{ text: 'visible' }])
  })

  it('keeps a functionCall part WITH its thoughtSignature (Gemini 3.x needs it)', () => {
    const parts = [{ functionCall: { name: 'patchPage', args: {} }, thoughtSignature: 'sig-abc' }]
    const out = stripNonInputParts([{ role: 'model', parts }])
    expect(out[0].parts).toEqual(parts)
  })

  it('drops content-less parts and removes a turn left empty', () => {
    const out = stripNonInputParts([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ thought: true }] }, // pure reasoning → empty → dropped
      { role: 'model', parts: [{}] },                 // malformed → empty → dropped
    ])
    expect(out).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  it('passes a clean history through untouched (no spurious drops)', () => {
    const clean = [
      { role: 'user' as const, parts: [{ text: 'q' }] },
      { role: 'model' as const, parts: [{ text: 'a' }] },
    ]
    expect(stripNonInputParts(clean)).toEqual(clean)
  })
})

describe('[COMP:providers/gemini-role-leak] stripLeadingRoleToken', () => {
  it('strips a leaked `model\\n` role token glued ahead of the body (the prod shape)', () => {
    // Real captured leak: session_messages.content[0].text began with "model\n…".
    expect(stripLeadingRoleToken('model\n我目前嘅資料庫暫時未有佢嘅電郵。')).toBe(
      '我目前嘅資料庫暫時未有佢嘅電郵。',
    )
  })

  it('tolerates a CRLF after the token', () => {
    expect(stripLeadingRoleToken('model\r\nHello')).toBe('Hello')
  })

  it('reduces a bare role-token-only first part to empty (caller drops the empty delta)', () => {
    expect(stripLeadingRoleToken('model\n')).toBe('')
  })

  it('leaves a legitimate reply that merely discusses models untouched', () => {
    expect(stripLeadingRoleToken('The model you picked is gemini-3.5-flash.')).toBe(
      'The model you picked is gemini-3.5-flash.',
    )
    // Mid-text or non-leading occurrences are never matched.
    expect(stripLeadingRoleToken('Your model\nis ready.')).toBe('Your model\nis ready.')
  })

  it('does not strip the word when it is not on its own opening line', () => {
    expect(stripLeadingRoleToken('model is a noun')).toBe('model is a noun')
    expect(stripLeadingRoleToken('models\nare plural')).toBe('models\nare plural')
  })
})

describe('[COMP:providers/gemini-json-mode] responseFormat json → responseMimeType', () => {
  // The stateless stream() path is the caller shape (Pipeline B extraction).
  // buildRequest is the universal choke point, so asserting through stream()
  // covers the session path's mapping too.
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function sseOk(): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            })}\n\n`,
          ),
        )
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  async function drain(iter: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of iter) void _
  }

  it("reports stopReason 'incomplete' when the stream ends with no finishReason", async () => {
    // Gemini states the finish reason on the final chunk. A stream that ends
    // without one never said it finished, but the code defaulted to 'end_turn'
    // — asserting something the provider had not said and disguising a cut-off
    // turn as a complete one. Invisible to the truncation detector, which only
    // looks for 'max_tokens', and a standing way for "the model stopped early"
    // to be misread as "the model produced bad output".
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const encoder = new TextEncoder()
    const noFinish = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [{ content: { role: 'model', parts: [{ text: '{"summary":"cut off mid' }] } }],
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
              })}\n\n`,
            ),
          )
          c.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
    fetchMock.mockResolvedValueOnce(noFinish)
    const { createGeminiProvider } = await import('../gemini.js')
    const seen: string[] = []
    for await (const chunk of createGeminiProvider('test-key').stream({
      model: 'gemini-flash',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'extract' }],
    })) {
      const c = chunk as { type: string; stopReason?: string }
      if (c.type === 'message_end' && c.stopReason) seen.push(c.stopReason)
    }
    expect(seen).toEqual(['incomplete'])
    expect(err.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('NO finishReason')
    err.mockRestore()
  })

  it("still reports 'end_turn' when the provider does state a clean finish", async () => {
    fetchMock.mockResolvedValueOnce(sseOk())
    const { createGeminiProvider } = await import('../gemini.js')
    const seen: string[] = []
    for await (const chunk of createGeminiProvider('test-key').stream({
      model: 'gemini-flash',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      const c = chunk as { type: string; stopReason?: string }
      if (c.type === 'message_end' && c.stopReason) seen.push(c.stopReason)
    }
    expect(seen).toEqual(['end_turn'])
  })

  it('maps responseSchema into generationConfig — the mime type alone is only a hint', async () => {
    // responseMimeType asks for JSON; responseSchema is what actually engages
    // the constrained decoder. Documenting the mime type as decoder-constraining
    // is what let 56 malformed-JSON extraction failures go unexplained
    // (2026-07-20) — each one an episode that stored nothing.
    fetchMock.mockResolvedValueOnce(sseOk())
    const { createGeminiProvider } = await import('../gemini.js')
    const schema = { type: 'object', properties: { summary: { type: 'string' } } }
    await drain(
      createGeminiProvider('test-key').stream({
        model: 'gemini-flash',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'extract' }],
        responseFormat: 'json',
        responseSchema: schema,
      }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.generationConfig?.responseMimeType).toBe('application/json')
    expect(body.generationConfig?.responseSchema).toEqual(schema)
  })

  it('retries WITHOUT the schema when Gemini rejects it, rather than failing the call', async () => {
    // A schema is an output-quality optimisation, never a liveness dependency:
    // Gemini accepts only a subset of JSON Schema and 400s the whole request on
    // anything outside it, which would take every schema-using caller offline.
    // Fail-open degrades to the unconstrained call the caller had before.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":{"message":"Invalid JSON payload: responseSchema"}}', { status: 400 }))
      .mockResolvedValueOnce(sseOk())
    const { createGeminiProvider } = await import('../gemini.js')
    await drain(
      createGeminiProvider('test-key').stream({
        model: 'gemini-flash',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'extract' }],
        responseFormat: 'json',
        responseSchema: { type: 'object', properties: { nope: { $ref: '#/x' } } },
      }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const retry = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(retry.generationConfig?.responseSchema).toBeUndefined()
    // The mime-type hint survives the retry — only the schema is dropped.
    expect(retry.generationConfig?.responseMimeType).toBe('application/json')
    expect(err.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('responseSchema REJECTED')
    err.mockRestore()
  })

  it('does not swallow a 400 that has nothing to do with a schema', async () => {
    // Without a responseSchema on the request there is nothing to fail open to,
    // so a 400 must still surface as an error rather than being retried away.
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"quota"}}', { status: 400 }))
    const { createGeminiProvider } = await import('../gemini.js')
    await expect(
      drain(
        createGeminiProvider('test-key').stream({
          model: 'gemini-flash',
          systemPrompt: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    ).rejects.toThrow(/Gemini API error 400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps responseFormat json to generationConfig.responseMimeType when no tools are declared', async () => {
    fetchMock.mockResolvedValueOnce(sseOk())
    const { createGeminiProvider } = await import('../gemini.js')
    await drain(
      createGeminiProvider('test-key').stream({
        model: 'gemini-flash',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'extract' }],
        responseFormat: 'json',
      }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.generationConfig?.responseMimeType).toBe('application/json')
  })

  it('omits responseMimeType when tools are present (Gemini rejects the combination)', async () => {
    fetchMock.mockResolvedValueOnce(sseOk())
    const { createGeminiProvider } = await import('../gemini.js')
    await drain(
      createGeminiProvider('test-key').stream({
        model: 'gemini-flash',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        responseFormat: 'json',
        tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
      }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.generationConfig?.responseMimeType).toBeUndefined()
  })

  it('omits responseMimeType when the caller did not ask for JSON', async () => {
    fetchMock.mockResolvedValueOnce(sseOk())
    const { createGeminiProvider } = await import('../gemini.js')
    await drain(
      createGeminiProvider('test-key').stream({
        model: 'gemini-flash',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'chat' }],
      }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.generationConfig?.responseMimeType).toBeUndefined()
  })
})
