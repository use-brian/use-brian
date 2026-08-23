import { describe, it, expect, vi } from 'vitest'
import {
  wrapDocumentAdaptation,
  type DistillateCachePort,
  type DocumentDistillPort,
} from '../document-adaptation.js'
import { createRoutingProvider } from '../routing.js'
import type { LLMProvider, Message, ProviderRequest, StreamChunk } from '../types.js'

const PDF_BYTES = Buffer.from('%PDF-1.4 quarterly report').toString('base64')
const OTHER_PDF = Buffer.from('%PDF-1.4 invoice').toString('base64')
const IMAGE_BYTES = Buffer.from('inline image').toString('base64')

function pdfBlock(data = PDF_BYTES, name?: string) {
  return { type: 'image' as const, mimeType: 'application/pdf', data, ...(name ? { name } : {}) }
}

function imageBlock(mimeType = 'image/png', data = IMAGE_BYTES, name?: string) {
  return { type: 'image' as const, mimeType, data, ...(name ? { name } : {}) }
}

/** Records every request it is handed and emits a trivial turn. */
function recordingProvider(name = 'inner') {
  const requests: ProviderRequest[] = []
  const sessionSends: Message[][] = []
  const provider: LLMProvider = {
    name,
    models: [name],
    stream(request) {
      requests.push(request)
      return (async function* () {
        yield { type: 'message_start', model: request.model } as StreamChunk
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as StreamChunk
      })()
    },
    createSession() {
      return {
        send(messages) {
          sessionSends.push(messages)
          return (async function* () {
            yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as StreamChunk
          })()
        },
      }
    },
  }
  return { provider, requests, sessionSends }
}

function fakeDistill(text = '## Page 1\n\nQuarterly revenue up 12%.') {
  const distill = vi.fn(async () => ({ text, model: 'fake-vision' }))
  const port: DocumentDistillPort = { configKey: 'v1:w1120:c6:dashscope', distill }
  return { port, distill }
}

function memoryCache() {
  const store = new Map<string, string>()
  const state = { gets: 0, sets: 0 }
  const port: DistillateCachePort = {
    async get(hash, config) {
      state.gets++
      const text = store.get(`${hash}::${config}`)
      return text ? { text } : null
    },
    async set(row) {
      state.sets++
      store.set(`${row.contentHash}::${row.configKey}`, row.text)
    },
  }
  return { port, state }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _ of stream) { /* consume */ }
}

const REQUEST = (messages: Message[]): ProviderRequest => ({
  model: 'm',
  systemPrompt: 'sys',
  messages,
})

describe('[COMP:providers/document-adaptation] native PDF validation', () => {
  it('distills PDFs through the validated boundary even when the model reads them natively', async () => {
    const { provider, requests } = recordingProvider()
    const { port, distill } = fakeDistill()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: true, vision: true, distill: port })

    expect(wrapped).not.toBe(provider)

    await drain(wrapped.stream(REQUEST([{ role: 'user', content: [pdfBlock()] }])))
    expect(distill).toHaveBeenCalledOnce()
    const content = requests[0]!.messages[0]!.content as Array<{ type: string; text?: string }>
    expect(content[0]!.type).toBe('text')
    expect(content[0]!.text).toContain('Quarterly revenue up 12%.')
  })

  it('keeps native pass-through as an emergency path when no distillation port exists', async () => {
    const { provider, requests } = recordingProvider()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: true, vision: true })

    expect(wrapped).toBe(provider)
    await drain(wrapped.stream(REQUEST([{ role: 'user', content: [pdfBlock()] }])))
    expect(requests[0]!.messages[0]!.content).toEqual([pdfBlock()])
  })
})

describe('[COMP:providers/document-adaptation] non-native swap', () => {
  it('replaces the PDF block with its distillate, carrying the filename', async () => {
    const { provider, requests } = recordingProvider()
    const { port, distill } = fakeDistill()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port })

    await drain(wrapped.stream(REQUEST([{
      role: 'user',
      content: [{ type: 'text', text: 'What is the revenue?' }, pdfBlock(PDF_BYTES, 'q3.pdf')],
    }])))

    const content = requests[0]!.messages[0]!.content as Array<{ type: string; text?: string }>
    expect(content.map((b) => b.type)).toEqual(['text', 'text'])
    expect(content[1]!.text).toContain('name="q3.pdf"')
    expect(content[1]!.text).toContain('distilled="true"')
    expect(content[1]!.text).toContain('type="application/pdf"')
    expect(content[1]!.text).toContain('Quarterly revenue up 12%.')
    expect(distill).toHaveBeenCalledWith({
      buffer: Buffer.from(PDF_BYTES, 'base64'),
      mime: 'application/pdf',
    })
    // No `image` block survives — the adapter must never see the PDF.
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('application/pdf;base64')
  })

  it('swaps PDFs in replayed history, not just the current turn', async () => {
    const { provider, requests } = recordingProvider()
    const { port } = fakeDistill()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port })

    await drain(wrapped.stream(REQUEST([
      { role: 'user', content: [pdfBlock()] },
      { role: 'assistant', content: [{ type: 'text', text: 'Read it.' }] },
      { role: 'user', content: 'And the margin?' },
    ])))

    const first = requests[0]!.messages[0]!.content as Array<{ type: string }>
    expect(first[0]!.type).toBe('text')
    // String-content messages pass through untouched.
    expect(requests[0]!.messages[2]!.content).toBe('And the margin?')
  })

  it('leaves images and every other block alone', async () => {
    const { provider, requests } = recordingProvider()
    const { port } = fakeDistill()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port })

    const image = { type: 'image' as const, mimeType: 'image/png', data: 'aGk=' }
    await drain(wrapped.stream(REQUEST([{ role: 'user', content: [image, pdfBlock()] }])))

    const content = requests[0]!.messages[0]!.content as Array<{ type: string; mimeType?: string }>
    expect(content[0]).toEqual(image)
    expect(content[1]!.type).toBe('text')
  })

  it('replaces an image for a non-vision model using its original MIME', async () => {
    const { provider, requests } = recordingProvider()
    const { port, distill } = fakeDistill('A chart showing rising revenue.')
    const wrapped = wrapDocumentAdaptation(provider, {
      nativePdf: true,
      vision: false,
      distill: port,
    })

    await drain(wrapped.stream(REQUEST([{
      role: 'user',
      content: [imageBlock('image/jpeg', IMAGE_BYTES, 'chart.jpg'), pdfBlock()],
    }])))

    expect(distill).toHaveBeenCalledTimes(2)
    expect(distill).toHaveBeenCalledWith({
      buffer: Buffer.from(IMAGE_BYTES, 'base64'),
      mime: 'image/jpeg',
    })
    const content = requests[0]!.messages[0]!.content as Array<{
      type: string
      mimeType?: string
      text?: string
    }>
    expect(content[0]!.type).toBe('text')
    expect(content[0]!.text).toContain('name="chart.jpg"')
    expect(content[0]!.text).toContain('type="image/jpeg"')
    expect(content[0]!.text).toContain('A chart showing rising revenue.')
    expect(content[1]!.type).toBe('text')
    expect(content[1]!.text).toContain('type="application/pdf"')
  })

  it('does not mutate the caller\'s messages (session history is shared state)', async () => {
    const { provider } = recordingProvider()
    const { port } = fakeDistill()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port })

    const messages: Message[] = [{ role: 'user', content: [pdfBlock()] }]
    await drain(wrapped.stream(REQUEST(messages)))
    expect(messages[0]!.content).toEqual([pdfBlock()])
  })

  it('adapts session sends too, not only stateless streams', async () => {
    const { provider, sessionSends } = recordingProvider()
    const { port } = fakeDistill()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port })

    const session = wrapped.createSession({ model: 'm', systemPrompt: 'sys' })
    await drain(session.send([{ role: 'user', content: [pdfBlock()] }]))

    const content = sessionSends[0]![0]!.content as Array<{ type: string }>
    expect(content[0]!.type).toBe('text')
  })

  it('never dispatches until the swap has happened', async () => {
    // The swap is async and `stream()` is sync by signature. If the generator
    // dispatched before awaiting, the adapter would receive the raw PDF.
    const { provider, requests } = recordingProvider()
    const { port } = fakeDistill()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port })

    const stream = wrapped.stream(REQUEST([{ role: 'user', content: [pdfBlock()] }]))
    expect(requests).toHaveLength(0) // nothing happens before the first next()
    await drain(stream)
    expect(requests).toHaveLength(1)
  })
})

describe('[COMP:providers/document-adaptation] cache', () => {
  it('short-circuits the second adaptation of the same bytes: ZERO distill calls', async () => {
    const { provider } = recordingProvider()
    const { port, distill } = fakeDistill()
    const cache = memoryCache()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port, cache: cache.port })

    await drain(wrapped.stream(REQUEST([{ role: 'user', content: [pdfBlock()] }])))
    expect(distill).toHaveBeenCalledTimes(1)
    expect(cache.state.sets).toBe(1)

    // Re-attach / re-ask / second surface — the whole reason the cache exists.
    await drain(wrapped.stream(REQUEST([{ role: 'user', content: [pdfBlock()] }])))
    expect(distill).toHaveBeenCalledTimes(1)
  })

  it('distills a given document once per request even when it appears twice', async () => {
    // The same attachment normally rides both the current turn and history.
    const { provider } = recordingProvider()
    const { port, distill } = fakeDistill()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port })

    await drain(wrapped.stream(REQUEST([
      { role: 'user', content: [pdfBlock()] },
      { role: 'user', content: [pdfBlock(), pdfBlock(OTHER_PDF)] },
    ])))

    expect(distill).toHaveBeenCalledTimes(2) // two DISTINCT documents, not three blocks
  })

  it('deduplicates by MIME and data rather than data alone', async () => {
    const { provider } = recordingProvider()
    const { port, distill } = fakeDistill()
    const wrapped = wrapDocumentAdaptation(provider, {
      nativePdf: true,
      vision: false,
      distill: port,
    })

    await drain(wrapped.stream(REQUEST([{
      role: 'user',
      content: [
        imageBlock('image/png'),
        imageBlock('image/png'),
        imageBlock('image/jpeg'),
      ],
    }])))

    expect(distill).toHaveBeenCalledTimes(2)
    expect(distill).toHaveBeenNthCalledWith(1, expect.objectContaining({ mime: 'image/png' }))
    expect(distill).toHaveBeenNthCalledWith(2, expect.objectContaining({ mime: 'image/jpeg' }))
  })

  it('degrades to re-distilling when the cache is down, never failing the turn', async () => {
    const { provider } = recordingProvider()
    const { port, distill } = fakeDistill()
    const brokenCache: DistillateCachePort = {
      get: async () => { throw new Error('cache down') },
      set: async () => { throw new Error('cache down') },
    }
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port, cache: brokenCache })

    await drain(wrapped.stream(REQUEST([{ role: 'user', content: [pdfBlock()] }])))
    expect(distill).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:providers/document-adaptation] honest failure', () => {
  it('swaps a failed distill for an instruction not to invent the contents', async () => {
    const { provider, requests } = recordingProvider()
    const port: DocumentDistillPort = {
      configKey: 'k',
      distill: async () => { throw new Error('vision backend 503') },
    }
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port })

    await drain(wrapped.stream(REQUEST([{ role: 'user', content: [pdfBlock()] }])))
    const text = (requests[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('could not be read')
    expect(text).toContain('vision backend 503')
    expect(text).toContain('do NOT guess')
    expect(text).not.toContain('distilled="true"')
  })

  it('says so plainly when no distillation backend is wired at all', async () => {
    const { provider, requests } = recordingProvider()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true })

    await drain(wrapped.stream(REQUEST([{ role: 'user', content: [pdfBlock()] }])))
    const text = (requests[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('no attachment-distillation backend')
    // Even with nothing configured, the PDF block never reaches the adapter.
    expect(JSON.stringify(requests[0]!.messages)).not.toContain(PDF_BYTES)
  })

  it('treats an empty distillate as a failure, not as an empty document', async () => {
    const { provider, requests } = recordingProvider()
    const port: DocumentDistillPort = { configKey: 'k', distill: async () => ({ text: '   ', model: 'm' }) }
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: false, vision: true, distill: port })

    await drain(wrapped.stream(REQUEST([{ role: 'user', content: [pdfBlock()] }])))
    const text = (requests[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('no readable text')
  })

  it('uses attachment wording when an image cannot be distilled', async () => {
    const { provider, requests } = recordingProvider()
    const wrapped = wrapDocumentAdaptation(provider, { nativePdf: true, vision: false })

    await drain(wrapped.stream(REQUEST([{ role: 'user', content: [imageBlock()] }])))
    const text = (requests[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('This attachment could not be read')
    expect(text).not.toContain('This PDF could not be read')
    expect(text).toContain('type="image/png"')
  })
})

describe('[COMP:providers/document-adaptation] applied per concrete model in routing', () => {
  it('uses one cached validated distillate for a Gemini primary and its Anthropic fallback', async () => {
    // The registry pairs `gemini-flash-3` (nativePdf) with the `claude-haiku-4-5`
    // outage fallback (not native). An outage mid-PDF-turn used to hand the
    // fallback a block its adapter drops silently.
    const gemini = recordingProvider('gemini')
    const anthropic = recordingProvider('anthropic')
    const failing: LLMProvider = {
      ...gemini.provider,
      stream(request) {
        gemini.requests.push(request)
        return (async function* (): AsyncIterable<StreamChunk> {
          throw Object.assign(new Error('Gemini API error 503'), { status: 503 })
        })()
      },
    }
    const { port, distill } = fakeDistill()
    const cache = memoryCache()

    const routing = createRoutingProvider(
      { gemini: failing, anthropic: anthropic.provider },
      {
        availability: new Set(['gemini', 'anthropic']),
        documentAdaptation: { distill: port, cache: cache.port },
      },
    )

    await drain(routing.stream({
      ...REQUEST([{ role: 'user', content: [pdfBlock()] }]),
      model: 'gemini-flash-3',
    }))

    const primaryContent = gemini.requests[0]!.messages[0]!.content as Array<{ type: string; text?: string }>
    expect(primaryContent[0]!.type).toBe('text')
    expect(primaryContent[0]!.text).toContain('Quarterly revenue up 12%.')
    expect(distill).toHaveBeenCalledTimes(1)
    const fallbackContent = anthropic.requests[0]!.messages[0]!.content as Array<{ type: string; text?: string }>
    expect(fallbackContent[0]!.type).toBe('text')
    expect(fallbackContent[0]!.text).toContain('Quarterly revenue up 12%.')
  })

  it('distills for a non-native primary (Qwen) with no per-route wiring', async () => {
    const qwen = recordingProvider('openai-compat:dashscope-intl')
    const { port, distill } = fakeDistill()
    const routing = createRoutingProvider(
      { 'openai-compat:dashscope-intl': qwen.provider },
      { availability: new Set(['openai-compat:dashscope-intl']), documentAdaptation: { distill: port } },
    )

    await drain(routing.stream({ ...REQUEST([{ role: 'user', content: [pdfBlock()] }]), model: 'qwen3.7-plus' }))

    expect(distill).toHaveBeenCalledTimes(1)
    expect((qwen.requests[0]!.messages[0]!.content as Array<{ type: string }>)[0]!.type).toBe('text')
  })

  it('passes Codex images through unchanged because its registry row supports vision', async () => {
    const codex = recordingProvider('openai-codex')
    const { port, distill } = fakeDistill()
    const routing = createRoutingProvider(
      { 'openai-codex': codex.provider },
      { availability: new Set(['openai-codex']), documentAdaptation: { distill: port } },
    )
    const image = imageBlock('image/png', IMAGE_BYTES, 'chart.png')

    await drain(routing.stream({
      ...REQUEST([{ role: 'user', content: [image] }]),
      model: 'gpt-5.6-sol',
    }))

    expect(distill).not.toHaveBeenCalled()
    expect(codex.requests[0]!.messages[0]!.content).toEqual([image])
  })

  it('distills images before dispatching to text-only Qwen', async () => {
    const qwen = recordingProvider('openai-compat:dashscope-intl')
    const { port, distill } = fakeDistill('The image contains a blue invoice.')
    const routing = createRoutingProvider(
      { 'openai-compat:dashscope-intl': qwen.provider },
      {
        availability: new Set(['openai-compat:dashscope-intl']),
        documentAdaptation: { distill: port },
      },
    )

    await drain(routing.stream({
      ...REQUEST([{ role: 'user', content: [imageBlock('image/webp')] }]),
      model: 'qwen3.7-plus',
    }))

    expect(distill).toHaveBeenCalledWith({
      buffer: Buffer.from(IMAGE_BYTES, 'base64'),
      mime: 'image/webp',
    })
    const content = qwen.requests[0]!.messages[0]!.content as Array<{ type: string; text?: string }>
    expect(content[0]!.type).toBe('text')
    expect(content[0]!.text).toContain('The image contains a blue invoice.')
  })
})
