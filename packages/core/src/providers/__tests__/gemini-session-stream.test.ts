import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGeminiProvider } from '../gemini.js'
import type { Message, StreamChunk } from '../types.js'

/**
 * Guards the stateful Gemini session path AFTER it was converted from a
 * single non-streaming `generateContent` to true SSE streaming
 * (`streamGeminiSSE`). The invariants that must survive the rewrite:
 *
 *  1. Verbatim reasoning (`thought: true` parts) surfaces live as a
 *     `thinking_delta` chunk — the "watch it generate" feature.
 *  2. Visible reply text streams as `text_delta` (thought text is NOT text).
 *  3. A tool call's `thoughtSignature` round-trips as `providerSignature`
 *     AND is replayed on the model turn in the NEXT request's history —
 *     the Gemini 3.x multi-turn signature requirement.
 *  4. Reasoning is never replayed: thought parts are dropped entirely from
 *     the next request's history (not re-sent as a `{ thought: true }` stub,
 *     which Gemini 400s with "Unsupported input part type ... thought: true").
 *
 * See docs/architecture/engine/live-streaming.md.
 */

/** A Response whose body is an SSE stream of Gemini chunks. */
function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

// One model turn: a thought, then visible text, then a tool call carrying a
// thoughtSignature — exercising all three part kinds in arrival order.
const TURN_CHUNKS = [
  { candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'Let me plan the page.' }] } }] },
  { candidates: [{ content: { role: 'model', parts: [{ text: 'Drafting now. ' }] } }] },
  {
    candidates: [{
      content: {
        role: 'model',
        parts: [{ functionCall: { name: 'patchPage', args: { ops: [] } }, thoughtSignature: 'sig-abc' }],
      },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
  },
]

describe('[COMP:providers/gemini-session-stream] Gemini session streaming', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('streams verbatim reasoning, reply text, and tool chunks live', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(TURN_CHUNKS))
    const session = createGeminiProvider('test-key').createSession({
      model: 'gemini-pro',
      systemPrompt: 'sys',
    })
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'build a page' }] }]
    const chunks = await collect(session.send(msgs))

    // The request must opt into reasoning summaries, else Gemini emits no
    // `thought` parts and the whole feature is inert.
    const reqBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(reqBody.generationConfig?.thinkingConfig?.includeThoughts).toBe(true)

    const types = chunks.map((c) => c.type)
    expect(types[0]).toBe('message_start')
    expect(types[types.length - 1]).toBe('message_end')

    // The headline: verbatim reasoning is surfaced as a live chunk.
    expect(chunks.filter((c) => c.type === 'thinking_delta')).toEqual([
      { type: 'thinking_delta', text: 'Let me plan the page.' },
    ])
    // Visible reply streams as text_delta — thought text is NOT replayed as text.
    expect(chunks.filter((c) => c.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Drafting now. ' },
    ])
    // Tool call round-trips its thoughtSignature as providerSignature.
    expect(chunks.find((c) => c.type === 'tool_use_end')).toMatchObject({
      type: 'tool_use_end',
      providerSignature: 'sig-abc',
    })
  })

  it('replays thoughtSignature on the next request and drops thought parts entirely', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(TURN_CHUNKS))
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }], usageMetadata: {} },
      ]),
    )

    const session = createGeminiProvider('test-key').createSession({
      model: 'gemini-pro',
      systemPrompt: 'sys',
    })

    await collect(session.send([{ role: 'user', content: [{ type: 'text', text: 'build a page' }] }]))
    await collect(
      session.send([
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', name: 'patchPage', content: 'ok' }] },
      ]),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    const contents = secondBody.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>

    // The turn-1 model turn rides along in history, carrying the signature.
    const modelTurn = contents.find((c) => c.role === 'model')
    expect(modelTurn).toBeDefined()
    const fcPart = modelTurn!.parts.find((p) => p.functionCall)
    expect(fcPart?.thoughtSignature).toBe('sig-abc')

    // Reasoning is never replayed: no thought part survives into history.
    // The turn-1 thought carried NO signature, so a "signature-only stub"
    // would have been a bare `{ thought: true }` — exactly the part Gemini
    // rejects with 400 "Unsupported input part type ... thought: true".
    expect(modelTurn!.parts.some((p) => p.thought)).toBe(false)

    // Every replayed part across the whole request must have a content
    // carrier (text / functionCall / functionResponse / inlineData). A
    // content-less part is what triggers the production 400 — guard against
    // any reappearing.
    for (const content of contents) {
      for (const p of content.parts) {
        expect(p.thought ?? false).toBe(false)
        const hasCarrier =
          p.text !== undefined || !!p.functionCall || !!p.functionResponse || !!p.inlineData
        expect(hasCarrier).toBe(true)
      }
    }
  })
})
