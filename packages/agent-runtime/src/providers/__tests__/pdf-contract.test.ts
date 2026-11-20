/**
 * The regression net for the next adapter someone adds.
 *
 * A PDF reaches an adapter as an `image` ContentBlock with
 * `mimeType: 'application/pdf'` — a contract shaped for Gemini's native
 * `inlineData` reader. Every adapter must do ONE of two honest things with it:
 *
 *   (a) emit a native document part, or
 *   (b) degrade to a typed note the model can report.
 *
 * The two failure modes this file exists to catch are the two that actually
 * shipped: a **fake image part** (codex sent `data:application/pdf;base64,…`
 * under an `input_image`, which GPT cannot decode and the app-server does not
 * reject) and a **silent drop** (anthropic discarded every non-text block).
 * Both look like success to the user.
 *
 * [COMP:providers/pdf-contract]
 */

import { describe, it, expect, vi } from 'vitest'
import { createGeminiProvider } from '../gemini.js'
import { createOpenAICompatProvider } from '../openai-compat.js'
import { createAnthropicProvider } from '../anthropic.js'
import { registryRow, MODEL_REGISTRY } from '@use-brian/shared/model-registry'
import type { LLMProvider, Message, StreamChunk } from '../types.js'

const PDF_BASE64 = Buffer.from('%PDF-1.4 contract').toString('base64')
const MESSAGES: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Summarize this.' },
      { type: 'image', mimeType: 'application/pdf', data: PDF_BASE64 },
    ],
  },
]

/** Captures the wire body an adapter would send, then ends the stream. */
function capturingFetch(captured: { body?: string }): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    captured.body = typeof init?.body === 'string' ? init.body : ''
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
}

async function drainQuietly(stream: AsyncIterable<StreamChunk>): Promise<void> {
  try {
    for await (const _ of stream) { /* consume */ }
  } catch {
    // The fake response is not a real completion; only the REQUEST matters here.
  }
}

async function wireBodyFor(provider: LLMProvider, model: string, captured: { body?: string }) {
  await drainQuietly(provider.stream({ model, systemPrompt: 'sys', messages: MESSAGES }))
  return captured.body ?? ''
}

describe('[COMP:providers/pdf-contract] every registered provider handles a PDF block honestly', () => {
  it('the registry declares a PDF posture for every provider that can be dispatched to', () => {
    // The contract starts at the registry: an adapter cannot be checked against
    // a capability nobody declared.
    const providers = new Set(MODEL_REGISTRY.filter((r) => r.status === 'active').map((r) => r.provider))
    expect(providers.size).toBeGreaterThan(0)
    for (const provider of providers) {
      const rows = MODEL_REGISTRY.filter((r) => r.provider === provider)
      for (const row of rows) {
        expect(typeof row.capabilities.nativePdf, `${row.alias}`).toBe('boolean')
      }
    }
  })

  it('gemini (nativePdf: true) emits a real inlineData document part', async () => {
    expect(registryRow('gemini-flash-3')!.capabilities.nativePdf).toBe(true)
    const captured: { body?: string } = {}
    const provider = createGeminiProvider('key')
    vi.stubGlobal('fetch', capturingFetch(captured))
    try {
      const body = JSON.parse(await wireBodyFor(provider, 'gemini-3-flash-preview', captured))
      const parts = body.contents[0].parts as Array<Record<string, unknown>>
      const inline = parts.find((p) => 'inlineData' in p) as { inlineData: { mimeType: string; data: string } }
      expect(inline.inlineData.mimeType).toBe('application/pdf')
      expect(inline.inlineData.data).toBe(PDF_BASE64)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('openai-compat (nativePdf: false) degrades to a note — no fake image_url', async () => {
    expect(registryRow('qwen3.7-plus')!.capabilities.nativePdf).toBe(false)
    const captured: { body?: string } = {}
    const provider = createOpenAICompatProvider({
      apiKey: 'k',
      baseURL: 'https://ds.test/v1',
      label: 'dashscope-intl',
    })
    vi.stubGlobal('fetch', capturingFetch(captured))
    let body: string
    try {
      body = await wireBodyFor(provider, 'qwen3.7-plus', captured)
    } finally {
      vi.unstubAllGlobals()
    }

    expect(body).not.toContain('data:application/pdf')
    expect(body).toContain('cannot be read inline')
  })

  it('anthropic (nativePdf: false) does not silently drop the block', async () => {
    // `toAnthropicMessages` keeps text and discards everything else. The PDF
    // must therefore already be TEXT by the time it gets here — which is what
    // `wrapDocumentAdaptation` guarantees for every non-native row. This test
    // pins the consequence: an unadapted PDF must not vanish without trace.
    expect(registryRow('claude-haiku-4-5')!.capabilities.nativePdf).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const provider = createAnthropicProvider({ apiKey: 'k' })
      await drainQuietly(provider.stream({
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'sys',
        messages: MESSAGES,
      }))
      expect(warn.mock.calls.flat().join(' ')).toMatch(/dropped non-text blocks/)
    } finally {
      warn.mockRestore()
    }
  })

  it('anthropic forwards real images, so an outage no longer eats the photo', async () => {
    // The adapter dropped EVERY non-text block, so a photo sent during a
    // Gemini outage vanished and Claude answered as if nothing was attached.
    // Claude is multimodal; only PDFs ever needed converting.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const captured: { body?: string } = {}
    vi.stubGlobal('fetch', capturingFetch(captured))
    try {
      const provider = createAnthropicProvider({ apiKey: 'k', baseURL: 'https://anthropic.test' })
      await drainQuietly(provider.stream({
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'sys',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this photo?' },
            { type: 'image', mimeType: 'image/png', data: 'aGk=' },
          ],
        }],
      }))
    } finally {
      vi.unstubAllGlobals()
      warn.mockRestore()
    }

    const body = JSON.parse(captured.body ?? '{}') as {
      messages: Array<{ content: Array<{ type: string; source?: { media_type: string; data: string } }> }>
    }
    const parts = body.messages[0]!.content
    expect(parts.map((p) => p.type)).toEqual(['text', 'image'])
    expect(parts[1]!.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'aGk=' })
    // An unsupported image mime still degrades rather than being sent blind.
    expect(warn).not.toHaveBeenCalled()
  })

  it('a non-native provider never receives base64 PDF bytes once wrapped', async () => {
    // The end-to-end statement of the contract: whatever an adapter would do
    // with a PDF, the wrapper makes sure it never sees one.
    const { wrapDocumentAdaptation } = await import('../document-adaptation.js')
    const seen: Message[][] = []
    const inner: LLMProvider = {
      name: 'any',
      models: ['any'],
      stream(request) {
        seen.push(request.messages)
        return (async function* (): AsyncIterable<StreamChunk> {
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }
        })()
      },
      createSession() { throw new Error('unused') },
    }
    const wrapped = wrapDocumentAdaptation(inner, {
      nativePdf: false,
      vision: true,
      distill: { configKey: 'k', distill: async () => ({ text: 'transcribed', model: 'm' }) },
    })

    await drainQuietly(wrapped.stream({ model: 'any', systemPrompt: 'sys', messages: MESSAGES }))
    expect(JSON.stringify(seen)).not.toContain(PDF_BASE64)
    expect(JSON.stringify(seen)).toContain('transcribed')
  })
})
