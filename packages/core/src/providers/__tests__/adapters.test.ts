import { describe, it, expect, vi } from 'vitest'
import { aiStudioTransport, vertexTransport, AI_STUDIO_BASE_URL } from '../google-transport.js'
import { cachedTokenSource, metadataTokenSource, serviceAccountTokenSource } from '../google-auth.js'
import { createGeminiProvider } from '../gemini.js'
import { runMediaUnderstanding, DASHSCOPE_VISION_MODEL, DASHSCOPE_ASR_MODEL, DASHSCOPE_LONG_MODEL } from '../../media/backend.js'
import { createVertexEmbedder, createDashScopeEmbedder, VERTEX_EMBEDDING_MODEL_ID } from '../../embeddings/adapters.js'
import { GEMINI_EMBEDDING_MODEL_ID } from '../../embeddings/embedder.js'
import { stripUnsignedToolUses, modelRequiresToolSignatures } from '../../engine/tool-pairing.js'
import { minimalPdf } from '../../files/__tests__/pdf-fixture.js'
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
  /** A document with no pages to render — still the qwen-long upload's job. */
  const OFFICE_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
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

  it('uploads a non-PDF office document via the Files API and distills it with qwen-long', async () => {
    // qwen-long survives for documents that have no pages to render. PDFs
    // deliberately no longer come here (pdf-universal-read §3, one track).
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, init })
      if (u.endsWith('/files')) {
        return new Response(JSON.stringify({ id: 'file-fe-abc123' }), { status: 200 })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '# Extracted\n\nbody text' } }],
        usage: { prompt_tokens: 30, completion_tokens: 12 },
      }), { status: 200 })
    })

    const backend = { kind: 'dashscope' as const, apiKey: 'k', baseUrl: 'https://ds.test/v1' }
    const res = await runMediaUnderstanding(backend, req({
      buffer: Buffer.from('PK office bytes'), mime: OFFICE_MIME, modality: 'document', fetchFn,
    }) as never)

    expect(calls[0].url).toBe('https://ds.test/v1/files')
    const uploadHeaders = calls[0].init?.headers as Record<string, string>
    expect(uploadHeaders.Authorization).toBe('Bearer k')

    expect(calls[1].url).toBe('https://ds.test/v1/chat/completions')
    const chatBody = JSON.parse(calls[1].init!.body as string)
    expect(chatBody.model).toBe(DASHSCOPE_LONG_MODEL)
    expect(chatBody.messages[0]).toEqual({ role: 'system', content: 'fileid://file-fe-abc123' })
    expect(chatBody.messages[1].role).toBe('user')

    expect(res.text).toBe('# Extracted\n\nbody text')
    expect(res.model).toBe(DASHSCOPE_LONG_MODEL)
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 12 })
  })

  it('reads a PDF through Qwen-VL page images only — never the qwen-long track', async () => {
    // The old shape ran BOTH: a qwen-long file extraction and a page-per-call
    // vision loop, whose outputs largely duplicated each other. One document,
    // two bills. Vision subsumes the text track, so `/files` must stay untouched.
    const chatBodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/files')) throw new Error('a PDF must not hit the Files API')
      chatBodies.push(JSON.parse(init!.body as string))
      return new Response(JSON.stringify({
        choices: [{ message: { content: '## Page 1\n\nQuarterly report\n\n[Figure: bar chart of revenue]' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }), { status: 200 })
    })

    const backend = { kind: 'dashscope' as const, apiKey: 'k', baseUrl: 'https://ds.test/v1' }
    const res = await runMediaUnderstanding(backend, req({
      buffer: minimalPdf(1, 'Quarterly report'), mime: 'application/pdf', modality: 'document', fetchFn,
    }) as never)

    expect(chatBodies).toHaveLength(1)
    const visionBody = chatBodies[0] as { model: string; messages: [{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }] }
    expect(visionBody.model).toBe(DASHSCOPE_VISION_MODEL)
    expect(visionBody.messages[0].content[0].text).toMatch(/transcribe/i)
    expect(visionBody.messages[0].content[1].image_url!.url).toMatch(/^data:image\/jpeg;base64,/)
    expect(res.text).toContain('Quarterly report')
    expect(res.text).toContain('[Figure: bar chart of revenue]')
    expect(res.model).toBe(DASHSCOPE_VISION_MODEL)
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 8 })
  })

  it('reads past the retired 10-page cap, batching pages into chunked calls', async () => {
    // The visual track used to stop at DASHSCOPE_MAX_PDF_VISUAL_PAGES = 10,
    // so page 11 of a report simply did not exist for the model.
    const seenPageCounts: number[] = []
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/files')) throw new Error('a PDF must not hit the Files API')
      const body = JSON.parse(init!.body as string) as { messages: [{ content: unknown[] }] }
      seenPageCounts.push(body.messages[0].content.length - 1) // minus the prompt part
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'transcribed' }, finish_reason: 'stop' }],
      }), { status: 200 })
    })

    await runMediaUnderstanding(
      { kind: 'dashscope', apiKey: 'k', baseUrl: 'https://ds.test/v1' },
      req({ buffer: minimalPdf(12), mime: 'application/pdf', modality: 'document', fetchFn }) as never,
    )

    // 12 pages / DASHSCOPE_CHUNK_PAGES(6) = two calls, all 12 pages sent.
    expect(seenPageCounts).toHaveLength(2)
    expect(seenPageCounts.reduce((a, b) => a + b, 0)).toBe(12)
    // Rasterizing 12 real pages sits right at vitest's 5s default on CI
    // runners (5016ms observed) — the count can't shrink below 11 without
    // gutting the past-the-cap claim, so the budget grows instead.
  }, 20_000)

  it('uses the longModel override for the qwen-long file-extract call', async () => {
    // A deployment whose Model Studio catalog lacks the default `qwen-long`
    // sets DASHSCOPE_LONG_MODEL; without honouring it the call 400s with
    // "model not found".
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, init })
      if (u.endsWith('/files')) return new Response(JSON.stringify({ id: 'file-x' }), { status: 200 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    })

    const backend = { kind: 'dashscope' as const, apiKey: 'k', baseUrl: 'https://ds.test/v1', longModel: 'qwen-long-custom' }
    const res = await runMediaUnderstanding(backend, req({
      buffer: Buffer.from('PK office bytes'), mime: OFFICE_MIME, modality: 'document', fetchFn,
    }) as never)

    const chatBody = JSON.parse(calls[1].init!.body as string)
    expect(chatBody.model).toBe('qwen-long-custom')
    expect(chatBody.model).not.toBe(DASHSCOPE_LONG_MODEL)
    expect(res.model).toBe('qwen-long-custom')
  })

  it('throws an actionable error when the DashScope file upload fails', async () => {
    const fetchFn = vi.fn(async () => new Response('quota exceeded', { status: 429 }))
    const backend = { kind: 'dashscope' as const, apiKey: 'k', baseUrl: 'https://ds.test/v1' }
    await expect(
      runMediaUnderstanding(backend, req({
        buffer: Buffer.from('PK office bytes'), mime: OFFICE_MIME, modality: 'document', fetchFn,
      }) as never),
    ).rejects.toThrow(/file upload failed.*429/s)
  })

  it('distills a PDF through the deployment\'s own chat provider when no media key exists', async () => {
    // The Codex-only unblock: a ChatGPT subscription is the sole model
    // credential, so pages ride ordinary `image` blocks through the chat
    // adapter. Before this the backend chain fell through to a DashScope
    // backend with an empty key and every distill attempt 401'd.
    const requests: Array<{ model: string; blocks: Array<{ type: string; mimeType?: string }> }> = []
    const provider = {
      name: 'fake',
      models: ['gpt-5.6-luna'],
      createSession: () => { throw new Error('unused') },
      stream: (request: { model: string; messages: Array<{ content: unknown }> }) => {
        requests.push({
          model: request.model,
          blocks: request.messages[0]!.content as Array<{ type: string; mimeType?: string }>,
        })
        return (async function* () {
          yield { type: 'text_delta' as const, text: '## Page 1\n\nInvoice total 42.00' }
          yield {
            type: 'message_end' as const,
            stopReason: 'end_turn' as const,
            usage: { inputTokens: 900, outputTokens: 120 },
          }
        })()
      },
    }

    const res = await runMediaUnderstanding(
      { kind: 'provider', provider: provider as never, model: 'gpt-5.6-luna' },
      req({ buffer: minimalPdf(1, 'Invoice'), mime: 'application/pdf', modality: 'document' }) as never,
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]!.model).toBe('gpt-5.6-luna')
    expect(requests[0]!.blocks.map((b) => b.type)).toEqual(['text', 'image'])
    expect(requests[0]!.blocks[1]!.mimeType).toBe('image/jpeg')
    expect(res.text).toContain('Invoice total 42.00')
    expect(res.usage).toEqual({ inputTokens: 900, outputTokens: 120 })
  })

  it('refuses audio on a chat-provider backend instead of returning an empty transcript', async () => {
    // A silent empty transcript reads to the caller as "this recording has no
    // speech" — the exact failure mode the transcription spec forbids.
    const provider = { name: 'fake', models: [], stream: () => { throw new Error('unused') }, createSession: () => { throw new Error('unused') } }
    await expect(
      runMediaUnderstanding(
        { kind: 'provider', provider: provider as never, model: 'gpt-5.6-luna' },
        req({ ...ogg, modality: 'audio' }) as never,
      ),
    ).rejects.toThrow(/cannot transcribe audio/i)
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
