import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider } from '../anthropic.js'
import { createGeminiProvider } from '../gemini.js'
import { createOpenAICompatProvider } from '../openai-compat.js'
import { wrapProvider } from '../wrappers.js'
import { wrapFallback } from '../wrap-fallback.js'
import { wrapEndpointFallback } from '../wrap-endpoint-fallback.js'
import { wrapCredentialPoolProvider } from '../credential-pool.js'
import { wrapDocumentAdaptation } from '../document-adaptation.js'
import type { LLMProvider, ProviderRequest, StreamChunk } from '../types.js'

const marker = 'PRIVATE_MODEL_CONTENT_MARKER'
const request: ProviderRequest = { nativeStrict: true, model: marker, systemPrompt: marker, messages: [{ role: 'user', content: marker }], httpRetryWindow: { deadline: 0, rateLimited: true } }
async function collect(provider: LLMProvider, req = request) {
  const chunks: StreamChunk[] = []
  for await (const chunk of provider.stream(req)) chunks.push(chunk)
  return chunks
}
function end(chunks: StreamChunk[]) {
  const last = chunks.at(-1)
  if (last?.type !== 'message_end') throw new Error('missing end')
  return last
}
type Vendor = 'anthropic' | 'gemini' | 'openai'
function provider(vendor: Vendor) {
  if (vendor === 'anthropic') return createAnthropicProvider({ apiKey: 'test', baseURL: 'https://mock.invalid' })
  if (vendor === 'gemini') return createGeminiProvider('test')
  return createOpenAICompatProvider({ apiKey: 'test', label: 'mock', baseURL: 'https://mock.invalid', recordedModel: 'recorded-fallback' })
}
function frames(vendor: Vendor, model: unknown = 'actual-v2', input: unknown = 3, output: unknown = 2): object[] {
  if (vendor === 'anthropic') return [
    { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model, usage: { input_tokens: input }, content: [] } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } },
    { type: 'message_stop' },
  ]
  if (vendor === 'gemini') return [{ modelVersion: model, candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: input, candidatesTokenCount: output } }]
  return [{ model, choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: input, completion_tokens: output } }]
}
function sse(events: object[]) {
  return new Response(events.map(e => `${'type' in e ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
function stack(base: LLMProvider) {
  const fallback = { ...base, stream: vi.fn(() => { throw new Error('fallback must not run') }) }
  const pooled = wrapCredentialPoolProvider({ providerId: marker, pool: { resolve: async () => ({ credentialId: null, provider: marker, secret: 'test', source: 'system', recordSpend: async () => { throw new Error(marker) } }) }, create: () => base })
  return { fallback, wrapped: wrapProvider(wrapEndpointFallback(wrapFallback(wrapDocumentAdaptation(pooled, { nativePdf: false, vision: true }), fallback), fallback), { verbose: true }) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe.each<Vendor>(['anthropic', 'gemini', 'openai'])('native %s real adapter', vendor => {
  it.each([[3, 2], [0, 0]])('uses upstream identity and explicit counters %s/%s through wrappers', async (input, output) => {
    const fetch = vi.fn(async () => sse(frames(vendor, 'actual-v2', input, output)))
    vi.stubGlobal('fetch', fetch)
    const { wrapped, fallback } = stack(provider(vendor))
    expect(end(await collect(wrapped)).nativeMetadata).toEqual({ actualModel: 'actual-v2', usage: { inputTokens: input, outputTokens: output } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fallback.stream).not.toHaveBeenCalled()
  })
  it.each([null, -1, '2', 1.5])('does not trust malformed counters %s', async bad => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(frames(vendor, 'actual', bad, 0))))
    expect(end(await collect(provider(vendor))).nativeMetadata?.usage).toBeNull()
  })
  it('does not fabricate missing model or counters', async () => {
    const events = frames(vendor, null, null, null)
    for (const event of events as any[]) {
      if (event.message) { delete event.message.model; delete event.message.usage }
      delete event.model; delete event.modelVersion; delete event.usage; delete event.usageMetadata
    }
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)))
    expect(end(await collect(provider(vendor))).nativeMetadata).toEqual({ actualModel: null, usage: null })
  })
  it('rejects conflicting upstream identities', async () => {
    const a = frames(vendor, 'one'), b = frames(vendor, 'two')
    vi.stubGlobal('fetch', vi.fn(async () => sse([...a, ...b])))
    expect(end(await collect(provider(vendor))).nativeMetadata?.actualModel).toBeNull()
  })
  it.each([429, 500, 400].flatMap(status => [true, false].map(restricted => [status, restricted] as const)))('makes one HTTP attempt on %s (restricted=%s) and never logs private data', async (status, restricted) => {
    const logs = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'info').mockImplementation(() => {}), vi.spyOn(console, 'debug').mockImplementation(() => {})]
    const fetch = vi.fn(async () => new Response(marker, { status }))
    vi.stubGlobal('fetch', fetch)
    const { wrapped } = stack(provider(vendor))
    await expect(collect(wrapped, { ...request, httpRetryWindow: restricted ? request.httpRetryWindow : undefined, responseFormat: 'json', responseSchema: { type: 'object' } })).rejects.toThrow('native_provider_failure')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(logs.flatMap(l => l.mock.calls))).not.toContain(marker)
  })
  it('does not replay an interrupted stream', async () => {
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(marker)) } }), { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(collect(stack(provider(vendor)).wrapped)).rejects.toThrow('native_provider_failure')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('fails closed before inference for unsupported transformations', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(collect(stack(provider(vendor)).wrapped, { ...request, tools: [{ name: 'test', description: '', parameters: { type: 'object', properties: {} } }] })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})

it('keeps OpenAI SSE errors and malformed payloads private', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const body of [`data: {"error":{"message":"${marker}"}}\n\n`, `data: ${marker}\n\n`]) {
    const fetch = vi.fn(async () => new Response(body))
    vi.stubGlobal('fetch', fetch)
    await expect(collect(stack(provider('openai')).wrapped)).rejects.toThrow('native_provider_failure')
    expect(fetch).toHaveBeenCalledTimes(1)
  }
  expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
})

it('routes native exactly, without invoking availability substitution or fallback', async () => {
  const { createRoutingProvider } = await import('../routing.js')
  const fetch = vi.fn(async () => sse(frames('gemini', 'resolved-google-version')))
  vi.stubGlobal('fetch', fetch)
  const resolveModel = vi.fn(() => 'claude-haiku-4-5')
  const routing = createRoutingProvider({ gemini: stack(provider('gemini')).wrapped }, { resolveModel })
  expect(end(await collect(routing, { ...request, model: 'gemini-3.8-flash' })).nativeMetadata?.actualModel).toBe('resolved-google-version')
  expect(resolveModel).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(1)
  await expect(collect(routing)).rejects.toThrow('native_provider_failure')
})

it('keeps the caller retry restriction intact through individually composed wrappers', async () => {
  const { composeWrappers, defaultWrappers } = await import('../wrappers.js')
  const stream = vi.fn(async function* (req: ProviderRequest): AsyncGenerator<StreamChunk> {
    expect(req.httpRetryWindow).toBe(request.httpRetryWindow)
    yield { type: 'message_end', stopReason: 'incomplete', usage: { inputTokens: 0, outputTokens: 0 }, nativeMetadata: { actualModel: null, usage: null } }
  })
  const wrapped = composeWrappers(stream, ...defaultWrappers({ verbose: true }))
  for await (const _chunk of wrapped(request)) { /* drain */ }
  expect(stream).toHaveBeenCalledTimes(1)
  expect(request.httpRetryWindow?.deadline).toBe(0)
})

it('does not retry the real Anthropic SDK with an expired nonnative caller window', async () => {
  const fetch = vi.fn(async () => new Response(marker, { status: 500 }))
  vi.stubGlobal('fetch', fetch)
  await expect(collect(wrapProvider(provider('anthropic')), { ...request, nativeStrict: undefined })).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('does not treat Anthropic startup output zero as final usage', async () => {
  const events = frames('anthropic') as any[]
  events[0].message.usage.output_tokens = 0
  delete events[2].usage
  vi.stubGlobal('fetch', vi.fn(async () => sse(events)))
  expect(end(await collect(provider('anthropic'))).nativeMetadata?.usage).toBeNull()
})

it('fails closed on malformed optional usage and cache underflow', async () => {
  for (const vendor of ['gemini', 'openai', 'anthropic'] as const) {
    for (const bad of [null, -1, '4']) {
      const events = frames(vendor) as any[]
      if (vendor === 'gemini') events[0].usageMetadata.thoughtsTokenCount = bad
      if (vendor === 'openai') events[0].usage.prompt_tokens_details = { cached_tokens: bad }
      if (vendor === 'anthropic') events[0].message.usage.cache_read_input_tokens = bad
      vi.stubGlobal('fetch', vi.fn(async () => sse(events)))
      expect(end(await collect(provider(vendor))).nativeMetadata?.usage).toBeNull()
    }
  }
  for (const vendor of ['gemini', 'openai'] as const) {
    const events = frames(vendor) as any[]
    if (vendor === 'gemini') events[0].usageMetadata.cachedContentTokenCount = 10
    else events[0].usage.prompt_tokens_details = { cached_tokens: 10 }
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)))
    expect(end(await collect(provider(vendor))).nativeMetadata?.usage).toBeNull()
  }
})

it('never invokes document distillation for native input', async () => {
  const base = provider('openai')
  const stream = vi.spyOn(base, 'stream')
  const wrapped = wrapDocumentAdaptation(base, { nativePdf: false, vision: true })
  const req = { ...request, messages: [{ role: 'user', content: [{ type: 'document', data: marker }] }] } as unknown as ProviderRequest
  await expect(collect(wrapped, req)).rejects.toThrow('native_unsupported_input')
  expect(stream).not.toHaveBeenCalled()
})

it('does not recover empty or looping native output', async () => {
  for (const content of ['', '\b\b\b', 'repeat '.repeat(200)]) {
    const fetch = vi.fn(async () => sse([{ model: 'actual', choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } }]))
    vi.stubGlobal('fetch', fetch)
    const chunks = await collect(stack(provider('openai')).wrapped)
    expect(end(chunks).nativeMetadata?.actualModel).toBe('actual')
    expect(fetch).toHaveBeenCalledTimes(1)
  }
})

it('preserves the legacy optional-metadata contract when nativeStrict is absent', async () => {
  for (const vendor of ['anthropic', 'gemini', 'openai'] as const) {
    vi.stubGlobal('fetch', vi.fn(async () => sse(frames(vendor))))
    expect(end(await collect(provider(vendor), { ...request, nativeStrict: undefined })).nativeMetadata).toBeUndefined()
  }
})

it('requires both counters independently, even when the other is explicit zero', async () => {
  for (const vendor of ['gemini', 'openai', 'anthropic'] as const) {
    for (const missing of ['input', 'output']) {
      const events = frames(vendor, 'actual', 0, 0) as any[]
      if (vendor === 'gemini') delete events[0].usageMetadata[missing === 'input' ? 'promptTokenCount' : 'candidatesTokenCount']
      if (vendor === 'openai') delete events[0].usage[missing === 'input' ? 'prompt_tokens' : 'completion_tokens']
      if (vendor === 'anthropic') {
        if (missing === 'input') delete events[0].message.usage.input_tokens
        else delete events[2].usage.output_tokens
      }
      vi.stubGlobal('fetch', vi.fn(async () => sse(events)))
      expect(end(await collect(provider(vendor))).nativeMetadata?.usage).toBeNull()
    }
  }
})

it('credential accounting logs only a fixed classification', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => sse(frames('openai', 'claude-haiku-4-5-20251001'))))
  await collect(stack(provider('openai')).wrapped)
  expect(error.mock.calls).toEqual([['native_credential_accounting_failure']])
})

it.each<Vendor>(['anthropic', 'gemini', 'openai'])('never replays %s after partial output and transport failure', async vendor => {
  const events = frames(vendor).slice(0, vendor === 'anthropic' ? 2 : 1)
  const prefix = await sse(events).text()
  let sent = false
  const fetch = vi.fn(async () => new Response(new ReadableStream({
    async pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(prefix)); return }
      await new Promise(resolve => setTimeout(resolve, 5))
      controller.error(new Error(marker))
    },
  }), { headers: { 'content-type': 'text/event-stream' } }))
  vi.stubGlobal('fetch', fetch)
  const chunks: StreamChunk[] = []
  await expect((async () => {
    for await (const chunk of stack(provider(vendor)).wrapped.stream(request)) chunks.push(chunk)
  })()).rejects.toThrow('native_provider_failure')
  expect(chunks.some(c => c.type === 'text_delta')).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
})

function imageChatRequest(): ProviderRequest {
  return { ...request, nativeImageChat: true, nativeImageUploadGuard: async () => {},
    tools: [{ name: 'computerAct', description: 'One locally approved action', parameters: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'Inspect the public fixture' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'capture', name: 'computerCapture', input: {}, providerSignature: 'original-signature' }] },
      { role: 'user', content: [{ type: 'tool_result', name: 'computerCapture', toolUseId: 'capture', content: '{"frameId":"frame"}' },
        { type: 'image', mimeType: 'image/png', data: 'cHVibGljLWZpeHR1cmU=' }] },
    ],
  }
}
function toolFrames(vendor: Vendor): object[] {
  if (vendor === 'anthropic') return [
    { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'actual-v2', usage: { input_tokens: 3 }, content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'action', name: 'computerAct', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":5}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
  ]
  if (vendor === 'gemini') return [{ modelVersion: 'actual-v2', candidates: [{ content: { parts: [{ functionCall: { id: 'action', name: 'computerAct', args: { x: 5 } }, thoughtSignature: 'signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }]
  return [{ model: 'actual-v2', choices: [{ delta: { tool_calls: [{ index: 0, id: 'action', function: { name: 'computerAct', arguments: '{"x":5}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }]
}
describe.each<Vendor>(['anthropic', 'gemini', 'openai'])('strict-image chat %s', vendor => {
  it('carries real images, tools, original tool history and upstream evidence through the strict wrapper stack', async () => {
    const fetch = vi.fn(async () => sse(toolFrames(vendor)))
    vi.stubGlobal('fetch', fetch)
    const { wrapped, fallback } = stack(provider(vendor))
    const chunks = await collect(wrapped, imageChatRequest())
    expect(chunks).toContainEqual({ type: 'tool_use_start', id: 'action', name: 'computerAct' })
    expect(chunks).toContainEqual({ type: 'tool_use_delta', id: 'action', input: '{"x":5}' })
    expect(chunks.find(c => c.type === 'tool_use_end')).toMatchObject({ id: 'action' })
    expect(end(chunks)).toMatchObject({ stopReason: 'tool_use', nativeMetadata: { actualModel: 'actual-v2', usage: { inputTokens: 3, outputTokens: 2 } } })
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    for (const value of ['cHVibGljLWZpeHR1cmU=', 'computerCapture', 'computerAct', 'frameId', 'capture']) expect(body).toContain(value)
    if (vendor === 'gemini') expect(body).toContain('original-signature')
    expect(fallback.stream).not.toHaveBeenCalled()
  })
  it('requires a live HTTP-boundary guard and withholds revoked uploads through credential/wrapper awaits', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { wrapped, fallback } = stack(provider(vendor))
    const guard = vi.fn(async () => { throw new Error('revoked') })
    await expect(collect(wrapped, { ...imageChatRequest(), nativeImageUploadGuard: guard })).rejects.toThrow('native_provider_failure')
    expect(guard).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(fallback.stream).not.toHaveBeenCalled()
    await expect(collect(wrapped, { ...imageChatRequest(), nativeImageUploadGuard: undefined })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rechecks after asynchronous credential resolution, not only at request construction', async () => {
    let live = true
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const base = provider(vendor)
    const pooled = wrapCredentialPoolProvider({ providerId: vendor, pool: { resolve: async () => {
      await Promise.resolve()
      live = false
      return { credentialId: null, provider: vendor, secret: 'synthetic-test-key', source: 'system', recordSpend: async () => {} }
    } }, create: () => base })
    const guard = vi.fn(async () => { if (!live) throw new Error('revoked during credential resolution') })
    const req = { ...imageChatRequest(), nativeImageUploadGuard: guard }
    expect(live).toBe(true)
    await expect(collect(pooled, req)).rejects.toThrow('native_provider_failure')
    expect(guard).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not relax legacy nativeStrict tool-history refusal', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(collect(provider(vendor), { ...imageChatRequest(), nativeImageChat: undefined, tools: undefined })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('never retries, falls back or adapts documents on the image-chat route', async () => {
    const fetch = vi.fn(async () => new Response(marker, { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const { wrapped, fallback } = stack(provider(vendor))
    await expect(collect(wrapped, imageChatRequest())).rejects.toThrow('native_provider_failure')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fallback.stream).not.toHaveBeenCalled()
    const req = imageChatRequest()
    req.messages.push({ role: 'user', content: [{ type: 'image', mimeType: 'application/pdf', data: marker }] })
    await expect(collect(wrapped, req)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
