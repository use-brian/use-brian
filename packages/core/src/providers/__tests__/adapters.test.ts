import { describe, it, expect, vi } from 'vitest'
import { aiStudioTransport, vertexTransport, AI_STUDIO_BASE_URL } from '../google-transport.js'
import { cachedTokenSource, metadataTokenSource, serviceAccountTokenSource } from '../google-auth.js'
import { createGeminiProvider } from '../gemini.js'
import { runMediaUnderstanding, DASHSCOPE_VISION_MODEL, DASHSCOPE_ASR_MODEL } from '../../media/backend.js'
import { createVertexEmbedder, createDashScopeEmbedder, VERTEX_EMBEDDING_MODEL_ID } from '../../embeddings/adapters.js'
import { GEMINI_EMBEDDING_MODEL_ID } from '../../embeddings/embedder.js'
import { stripUnsignedToolUses, modelRequiresToolSignatures } from '../../engine/tool-pairing.js'
import type { Message } from '../types.js'

describe('[COMP:providers/google-transport] Google transport', () => {
  it('builds AI Studio URLs against the developer host with the API-key header', async () => {
    const t = aiStudioTransport('key-123')
    expect(t.kind).toBe('ai-studio')
    expect(t.endpoint('gemini-3-flash-preview', 'streamGenerateContent', { alt: 'sse' }))
      .toBe(`${AI_STUDIO_BASE_URL}/models/gemini-3-flash-preview:streamGenerateContent?alt=sse`)
    expect(await t.headers()).toMatchObject({ 'x-goog-api-key': 'key-123' })
  })

  it('builds Vertex URLs against the REGIONAL host with a project-scoped path + bearer', async () => {
    const t = vertexTransport({ project: 'proj-1', location: 'asia-east2', tokenSource: async () => 'tok-abc' })
    expect(t.kind).toBe('vertex')
    expect(t.endpoint('gemini-3-flash-preview', 'streamGenerateContent', { alt: 'sse' })).toBe(
      'https://asia-east2-aiplatform.googleapis.com/v1/projects/proj-1/locations/asia-east2' +
      '/publishers/google/models/gemini-3-flash-preview:streamGenerateContent?alt=sse',
    )
    expect(await t.headers()).toMatchObject({ Authorization: 'Bearer tok-abc' })
  })

  it('uses the unprefixed host for the `global` location (a prefixed one does not resolve)', () => {
    const t = vertexTransport({ project: 'p', location: 'global', tokenSource: async () => 't' })
    expect(t.endpoint('m', 'generateContent')).toBe(
      'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/m:generateContent',
    )
  })

  it('createGeminiProvider stays constructible from a key, a transport, or undefined', async () => {
    // Registry names this provider `gemini` for BOTH transports; boot decides
    // which. Construction is total so eager boot never dies before wiring.
    expect(createGeminiProvider('k').name).toBe('gemini')
    expect(createGeminiProvider(vertexTransport({ project: 'p', location: 'us-central1', tokenSource: async () => 't' })).name).toBe('gemini')
    expect(() => createGeminiProvider(undefined)).not.toThrow()
    expect(await aiStudioTransport(undefined).headers()).toMatchObject({ 'x-goog-api-key': '' })
  })
})

describe('[COMP:providers/google-auth] Vertex token sources', () => {
  it('caches a token and collapses concurrent refreshes into one mint', async () => {
    const inner = vi.fn(async () => ({ token: 'a', expiresInMs: 3600_000 }))
    const source = cachedTokenSource(inner)
    const [x, y, z] = await Promise.all([source(), source(), source()])
    expect([x, y, z]).toEqual(['a', 'a', 'a'])
    expect(await source()).toBe('a')
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('re-mints once the token is inside the expiry skew', async () => {
    let n = 0
    const source = cachedTokenSource(async () => ({ token: `t${++n}`, expiresInMs: 30_000 }))
    expect(await source()).toBe('t1')
    expect(await source()).toBe('t2')
  })

  it('surfaces an actionable error when the metadata server is absent', async () => {
    const fetchMock = vi.fn(async () => new Response('no creds', { status: 404 }))
    await expect(metadataTokenSource(fetchMock as unknown as typeof fetch)()).rejects.toThrow(/VERTEX_SERVICE_ACCOUNT_JSON/)
  })

  it('rejects a malformed service-account key at construction, not at first turn', () => {
    expect(() => serviceAccountTokenSource('not json')).toThrow(/not valid JSON/)
    expect(() => serviceAccountTokenSource('{"client_email":"a@b.c"}')).toThrow(/private_key/)
  })
})

describe('[COMP:media/backend] Multimodal backend per adapter', () => {
  const png = { buffer: Buffer.from('fake-png'), mime: 'image/png' }
  const ogg = { buffer: Buffer.from('fake-audio'), mime: 'audio/ogg' }
  const req = (over: Record<string, unknown>) => ({
    prompt: 'p', model: 'gemini-2.5-flash', maxOutputTokens: 100,
    timeoutMs: 5000, errorLabel: 'test call', ...over,
  })

  it('routes Google requests through the transport (so Vertex works unchanged) with billing-accurate usage', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: unknown) => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'extracted' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, cachedContentTokenCount: 20, thoughtsTokenCount: 5 },
    }), { status: 200 }))
    const transport = vertexTransport({ project: 'p', location: 'asia-east2', tokenSource: async () => 'tok' })
    const res = await runMediaUnderstanding({ kind: 'google', transport }, req({ ...png, modality: 'document', fetchFn }) as never)

    expect(fetchFn.mock.calls[0][0]).toContain('asia-east2-aiplatform.googleapis.com')
    expect(res.text).toBe('extracted')
    // cached subtracted from input, thinking added to output
    expect(res.usage).toEqual({ inputTokens: 80, outputTokens: 15, cacheReadTokens: 20 })
  })

  it('maps a document to Qwen-VL image_url and audio to Qwen-ASR input_audio', async () => {
    const calls: Record<string, unknown>[] = []
    const fetchFn = vi.fn(async (_u: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200 })
    })
    const backend = { kind: 'dashscope' as const, apiKey: 'k', baseUrl: 'https://ds.test/v1' }
    await runMediaUnderstanding(backend, req({ ...png, modality: 'document', fetchFn }) as never)
    await runMediaUnderstanding(backend, req({ ...ogg, modality: 'audio', fetchFn }) as never)

    expect(calls[0].model).toBe(DASHSCOPE_VISION_MODEL)
    expect((calls[0] as never as { messages: [{ content: [unknown, { image_url: { url: string } }] }] })
      .messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/)
    expect(calls[1].model).toBe(DASHSCOPE_ASR_MODEL)
    // Audio is the ONLY part: qwen3-asr-flash is a dedicated ASR task model and
    // rejects the whole request when a text part rides along
    // (`InternalError.Algo.InvalidParameter: The dedicated task 'asr' ... does
    // not support this input`). Sending a prompt failed 100% of voice notes on
    // a Qwen deployment, silently — the preflight swallows the error and the
    // user just sees "I can't transcribe audio".
    const audioContent = (calls[1] as never as {
      messages: [{ content: Array<{ type: string; input_audio?: { format: string } }> }]
    }).messages[0].content
    expect(audioContent).toHaveLength(1)
    expect(audioContent[0].type).toBe('input_audio')
    expect(audioContent[0].input_audio?.format).toBe('ogg')
    expect(audioContent.some((p) => p.type === 'text')).toBe(false)
  })

  it('refuses a PDF on DashScope rather than sending something Qwen-VL misreads', async () => {
    await expect(
      runMediaUnderstanding({ kind: 'dashscope', apiKey: 'k', baseUrl: 'https://ds.test/v1' },
        req({ buffer: Buffer.from('%PDF'), mime: 'application/pdf', modality: 'document' }) as never),
    ).rejects.toThrow(/qwen-long|image\/\* only/i)
  })
})

describe('[COMP:embeddings/adapters] Per-adapter embedders', () => {
  it('Vertex embeds via :predict and reports the SAME model_id as AI Studio (shared vector space)', async () => {
    // Same id → no re-embed when switching AI Studio↔Vertex, and it prices via
    // the existing gemini-embedding-001 registry row.
    expect(VERTEX_EMBEDDING_MODEL_ID).toBe(GEMINI_EMBEDDING_MODEL_ID)
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toContain(':predict')
      return new Response(JSON.stringify({ predictions: [{ embeddings: { values: new Array(768).fill(0.1) } }] }), { status: 200 })
    })
    const transport = vertexTransport({ project: 'p', location: 'asia-east2', tokenSource: async () => 't' })
    const e = createVertexEmbedder(transport)
    const out = await withFetch(fetchFn as unknown as typeof fetch, () => e.embed(['hi']))
    expect(out[0]).toHaveLength(768)
    expect(e.model_id).toBe(GEMINI_EMBEDDING_MODEL_ID)
  })

  it('DashScope enforces the fixed 768-dim vector (a mismatch would corrupt retrieval)', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(512).fill(0.1) }] }), { status: 200 }))
    const e = createDashScopeEmbedder('k', 'https://ds.test/v1')
    await expect(withFetch(fetchFn, () => e.embed(['hi']))).rejects.toThrow(/768|fixed-width/)
  })
})

describe('[COMP:engine/tool-pairing] Signature strip is provider-gated', () => {
  const unsigned: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', name: 'f', content: 'r' }] },
  ]

  it('classifies gemini models as signature-requiring and qwen as not', () => {
    expect(modelRequiresToolSignatures('gemini-3-flash-standard')).toBe(true)
    expect(modelRequiresToolSignatures('qwen3.7-plus')).toBe(false)
    // unknown → fail safe (strip)
    expect(modelRequiresToolSignatures('some-unknown-model')).toBe(true)
  })

  it('strips unsigned tool calls for signature-requiring providers', () => {
    expect(stripUnsignedToolUses(unsigned, true)).toEqual([])
  })

  it('leaves history intact for signature-less providers (else Qwen loses every tool call)', () => {
    expect(stripUnsignedToolUses(unsigned, false)).toEqual(unsigned)
  })

  it('defaults to stripping so an un-updated caller fails safe', () => {
    expect(stripUnsignedToolUses(unsigned)).toEqual([])
  })
})

/** Run `fn` with `fetch` stubbed, restoring it after. */
async function withFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch
  globalThis.fetch = stub
  try { return await fn() } finally { globalThis.fetch = orig }
}
