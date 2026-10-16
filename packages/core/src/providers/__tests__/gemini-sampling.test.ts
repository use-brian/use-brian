import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGeminiProvider } from '../gemini.js'
import { transcribeAudio } from '../../media/transcribe.js'
import { transcribeRecording, transcribeRecordingChunks } from '../../media/transcribe-recording.js'

const PATHS = ['stateless', 'session', 'voice-note', 'recording', 'recording-chunk'] as const
type RequestPath = typeof PATHS[number]
const MODERN_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.8-flash',
  'gemini-4-argon',
  'publishers/google/models/gemini-3.8-flash',
]
const SAMPLING_KEYS = ['temperature', 'topP', 'topK', 'top_p', 'top_k']

async function dispatch(path: RequestPath, model: string, temperature?: number): Promise<void> {
  if (path === 'stateless' || path === 'session') {
    const provider = createGeminiProvider('test-key')
    const options = { model, systemPrompt: 'Reply briefly.', temperature }
    const messages = [{ role: 'user' as const, content: 'Hello.' }]
    const stream = path === 'stateless'
      ? provider.stream({ ...options, messages })
      : provider.createSession(options).send(messages)
    for await (const _ of stream) { /* drain the response */ }
    return
  }
  const audio = { buffer: Buffer.from('synthetic-audio'), mime: 'audio/aac' }
  if (path === 'voice-note') {
    await transcribeAudio(audio, { apiKey: 'test-key', model })
    return
  }
  const options = {
    ...audio, apiKey: 'test-key', model, durationMs: 60_000,
    uploadAudio: async () => ({ fileUri: 'gs://synthetic-bucket/audio.aac' }),
  }
  if (path === 'recording') await transcribeRecording(options)
  else await transcribeRecordingChunks(options, [{ ...audio, offsetMs: 0, durationMs: 60_000 }])
}

describe('[COMP:providers/gemini-sampling] Gemini request compatibility', () => {
  let configs: Array<Record<string, unknown>>
  let rejectSampling: boolean

  beforeEach(() => {
    configs = []
    rejectSampling = true
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (!/:(?:streamGenerateContent|generateContent)/.test(url)) throw new Error('Unexpected mock request')
      const { generationConfig } = JSON.parse(String(init?.body))
      configs.push(generationConfig)
      // Model the provider's stricter contract, so a leaked parameter fails
      // the actual public call instead of being silently accepted by a mock.
      if (rejectSampling && SAMPLING_KEYS.some(key => key in generationConfig)) {
        return new Response('Unsupported sampling parameter', { status: 400 })
      }
      const event = {
        candidates: [{ content: { role: 'model', parts: [{ text: '[0:00:59] Speaker 1: Done.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }
      return url.includes(':streamGenerateContent')
        ? new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
        : new Response(JSON.stringify(event), { headers: { 'Content-Type': 'application/json' } })
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  for (const path of PATHS) {
    it.each(MODERN_MODELS)(`${path} succeeds without sampling parameters on %s`, async model => {
      await dispatch(path, model, 0.7)
      expect(configs).toHaveLength(1)
      for (const key of SAMPLING_KEYS) expect(configs[0]).not.toHaveProperty(key)
      expect(configs[0]).not.toHaveProperty('thinkingConfig.thinkingBudget')
    })

    it(`${path} preserves supported Gemini 2.5 sampling and thinking settings`, async () => {
      rejectSampling = false
      await dispatch(path, 'gemini-2.5-flash', 0.7)
      expect(configs).toHaveLength(1)
      expect(configs[0].temperature).toBe(path === 'stateless' || path === 'session' ? 0.7 : 0)
      if (path === 'recording-chunk') expect(configs[0].thinkingConfig).toEqual({ thinkingBudget: 0 })
    })
  }

  it.each(['stateless', 'session'] as const)('%s leaves an unspecified older-model temperature absent', async path => {
    await dispatch(path, 'gemini-2.5-flash')
    expect(configs[0]).not.toHaveProperty('temperature')
  })
})
