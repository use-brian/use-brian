import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseTranscriptLines,
  transcribeRecordingChunks,
  type RecordingAudioChunk,
} from '../transcribe-recording.js'

/**
 * [COMP:media/transcribe-recording] — chunked mode. Chunks transcribe
 * INDEPENDENTLY (no continuation conditioning), timestamps are chunk-local and
 * offset by the chunk's known start, thinking is disabled on 2.5-family
 * models, and coverage derives from chunks completed — not model stamps.
 */

const CHUNKS: RecordingAudioChunk[] = [
  { buffer: Buffer.from('c0'), mime: 'audio/aac', offsetMs: 0, durationMs: 600_000 },
  { buffer: Buffer.from('c1'), mime: 'audio/aac', offsetMs: 600_000, durationMs: 300_000 },
]

/**
 * Scripted Gemini File-API mock. Upload-start carries the chunk index in
 * display_name ('...-chunk-N'), so per-chunk generate responses stay
 * deterministic under parallel transcription.
 */
function chunkFetch(perChunk: Record<number, string | number>) {
  const generateBodies: Array<Record<string, unknown>> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/upload/v1beta/files')) {
      const body = JSON.parse(init!.body as string) as { file: { display_name: string } }
      const idx = Number(/chunk-(\d+)$/.exec(body.file.display_name)![1])
      return new Response('{}', {
        status: 200,
        headers: { 'x-goog-upload-url': `https://upload.example/chunk${idx}` },
      })
    }
    if (u.startsWith('https://upload.example/')) {
      const uri = `files/${u.slice('https://upload.example/'.length)}`
      return new Response(
        JSON.stringify({ file: { uri, name: uri, state: 'ACTIVE' } }),
        { status: 200 },
      )
    }
    if (u.includes(':generateContent')) {
      const body = JSON.parse(init!.body as string) as {
        contents: Array<{ parts: Array<{ file_data?: { file_uri: string } }> }>
      }
      generateBodies.push(body as unknown as Record<string, unknown>)
      const idx = Number(/files\/chunk(\d+)$/.exec(body.contents[0].parts[1].file_data!.file_uri)![1])
      const val = perChunk[idx]
      if (typeof val === 'number') return new Response('boom', { status: val })
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: val ?? '' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected url: ${u}`)
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, generateBodies }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('[COMP:media/transcribe-recording] lenient line parsing', () => {
  it('accepts [MM:SS], [H:MM:SS], and a full-width colon after the speaker', () => {
    const out = parseTranscriptLines(
      ['[0:05] Speaker 1: hello', '[1:02:03] Speaker 2: later', '[2:00] Speaker 1： 好呀'].join('\n'),
    )
    expect(out.map((u) => u.startMs)).toEqual([5_000, 3_723_000, 120_000])
    expect(out[2].text).toBe('好呀')
  })
})

describe('[COMP:media/transcribe-recording] transcribeRecordingChunks', () => {
  it('transcribes chunks independently, offsets chunk-local stamps, and disables 2.5 thinking', async () => {
    const { fetchFn, generateBodies } = chunkFetch({
      0: '[0:05] Speaker 1: 今日開會\n[9:50] Speaker 2: ok',
      1: '[2:00] Speaker 1： wrap up',
    })

    const res = await transcribeRecordingChunks({ apiKey: 'k', buffer: Buffer.from(''), mime: 'audio/aac', durationMs: 900_000, fetchFn }, CHUNKS)

    expect(res.utterances).toEqual([
      { startMs: 5_000, endMs: 590_000, speaker: 'Speaker 1', text: '今日開會' },
      { startMs: 590_000, endMs: 590_000, speaker: 'Speaker 2', text: 'ok' },
      { startMs: 720_000, endMs: 720_000, speaker: 'Speaker 1', text: 'wrap up' },
    ])
    expect(res.windows).toBe(2)
    expect(res.truncated).toBe(false)
    expect(res.usages).toHaveLength(2)

    // Verbatim-Cantonese guidance + thinking disabled on the 2.5 default.
    for (const body of generateBodies) {
      const prompt = (body as { contents: Array<{ parts: Array<{ text?: string }> }> }).contents[0].parts[0].text!
      expect(prompt).toContain('粵文')
      expect(prompt).not.toMatch(/continue|already produced/i)
      const cfg = (body as { generationConfig: { thinkingConfig?: { thinkingBudget?: number } } }).generationConfig
      expect(cfg.thinkingConfig).toEqual({ thinkingBudget: 0 })
    }
  })

  it('omits thinkingConfig for non-2.5 models', async () => {
    const { fetchFn, generateBodies } = chunkFetch({ 0: '[0:01] Speaker 1: hi' })

    await transcribeRecordingChunks(
      { apiKey: 'k', buffer: Buffer.from(''), mime: 'audio/aac', durationMs: 600_000, model: 'gemini-3-flash', fetchFn },
      [CHUNKS[0]],
    )

    const cfg = (generateBodies[0] as { generationConfig: Record<string, unknown> }).generationConfig
    expect(cfg.thinkingConfig).toBeUndefined()
  })

  it('a chunk that fails twice marks truncated but keeps the other chunks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fetchFn } = chunkFetch({ 0: '[0:05] Speaker 1: kept', 1: 500 })

    const res = await transcribeRecordingChunks(
      { apiKey: 'k', buffer: Buffer.from(''), mime: 'audio/aac', durationMs: 900_000, fetchFn },
      CHUNKS,
    )

    expect(res.truncated).toBe(true)
    expect(res.utterances.map((u) => u.text)).toEqual(['kept'])
    expect(res.windows).toBe(2)
  })

  it('keeps format-ignoring plain text as one utterance spanning the chunk', async () => {
    const { fetchFn } = chunkFetch({ 0: 'the model just wrote prose with no stamps' })

    const res = await transcribeRecordingChunks(
      { apiKey: 'k', buffer: Buffer.from(''), mime: 'audio/aac', durationMs: 600_000, fetchFn },
      [CHUNKS[0]],
    )

    expect(res.utterances).toEqual([
      { startMs: 0, endMs: 600_000, speaker: null, text: 'the model just wrote prose with no stamps' },
    ])
    expect(res.truncated).toBe(false)
  })

  it('an all-silent transcription (no text anywhere) is truncated (nothing to bill)', async () => {
    const { fetchFn } = chunkFetch({ 0: '', 1: '' })

    const res = await transcribeRecordingChunks(
      { apiKey: 'k', buffer: Buffer.from(''), mime: 'audio/aac', durationMs: 900_000, fetchFn },
      CHUNKS,
    )

    expect(res.utterances).toEqual([])
    expect(res.truncated).toBe(true)
  })
})
