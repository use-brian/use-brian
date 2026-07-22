import { describe, it, expect, vi } from 'vitest'
import {
  scribeTranscriber,
  groupScribeWords,
  SCRIBE_USD_PER_AUDIO_HOUR,
  SCRIBE_KEYTERMS_USD_PER_AUDIO_HOUR,
  type ScribeWord,
} from '../scribe.js'

function mockResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function word(
  text: string,
  start: number,
  end: number,
  speaker = 'speaker_0',
  type = 'word',
): ScribeWord {
  return { text, start, end, type, speaker_id: speaker }
}

const HOUR_MS = 3_600_000

describe('[COMP:media/transcriber-scribe] groupScribeWords', () => {
  it('appends spacing, skips audio events, and merges same-speaker runs', () => {
    const out = groupScribeWords([
      word('hello', 0.0, 0.4),
      { text: ' ', type: 'spacing' },
      { text: '(laughter)', type: 'audio_event' },
      word('there', 0.5, 0.9),
    ])
    expect(out).toEqual([
      { startMs: 0, endMs: 900, speaker: 'speaker_0', text: 'hello there' },
    ])
  })

  it('splits on speaker change', () => {
    const out = groupScribeWords([
      word('hi', 0, 0.3, 'speaker_0'),
      word('yo', 0.4, 0.6, 'speaker_1'),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].speaker).toBe('speaker_0')
    expect(out[1].speaker).toBe('speaker_1')
  })

  it('splits on a silence gap over 1.5s', () => {
    const out = groupScribeWords([word('one', 0, 0.5), word('two', 2.5, 3.0)])
    expect(out).toHaveLength(2)
    expect(out[1].startMs).toBe(2500)
  })

  it('splits after sentence-final punctuation, including CJK', () => {
    const out = groupScribeWords([
      word('好呀。', 0, 0.5),
      word('然後', 0.6, 1.0),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].text).toBe('好呀。')
  })

  it('drops whitespace-only utterances', () => {
    expect(groupScribeWords([{ text: '  ', type: 'spacing' }])).toEqual([])
  })
})

describe('[COMP:media/transcriber-scribe] scribeTranscriber', () => {
  it('posts the multipart request shape and maps words to utterances', async () => {
    const captured: { url?: string; init?: RequestInit } = {}
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url)
      captured.init = init
      return mockResponse({
        language_code: 'yue',
        text: '你好 world',
        words: [
          word('你好', 0.0, 0.6),
          { text: ' ', type: 'spacing' },
          word('world', 0.7, HOUR_MS / 1000 - 10),
        ],
      })
    })

    const t = scribeTranscriber({ apiKey: 'xi-key', fetchFn: fetchFn as unknown as typeof fetch })
    expect(t.name).toBe('elevenlabs:scribe_v2')
    const res = await t.transcribe({
      buffer: Buffer.from('aac-bytes'),
      mime: 'audio/aac',
      durationMs: HOUR_MS,
      keyterms: ['Sidan', '  ', 'x'.repeat(60), 'DeltaDeFi'],
      displayName: 'memo.aac',
    })

    expect(captured.url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    const headers = captured.init?.headers as Record<string, string>
    expect(headers['xi-api-key']).toBe('xi-key')

    const form = captured.init?.body as FormData
    expect(form.get('model_id')).toBe('scribe_v2')
    expect(form.get('diarize')).toBe('true')
    expect(form.get('timestamps_granularity')).toBe('word')
    expect(form.get('tag_audio_events')).toBe('false')
    // Trimmed, over-long dropped, order kept.
    expect(form.getAll('keyterms')).toEqual(['Sidan', 'DeltaDeFi'])
    // No workspace language preference → auto-detect (no language_code field).
    expect(form.get('language_code')).toBeNull()
    const file = form.get('file') as File
    expect(file.type).toBe('audio/aac')
    expect(file.name).toBe('memo.aac')

    expect(res.utterances).toEqual([
      {
        startMs: 0,
        endMs: HOUR_MS - 10_000,
        speaker: 'Speaker 1',
        text: '你好 world',
      },
    ])
    expect(res.windows).toBe(1)
    expect(res.truncated).toBe(false)
  })

  it('forwards the workspace language preference as language_code', async () => {
    const captured: { init?: RequestInit } = {}
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.init = init
      return mockResponse({ words: [word('喂', 0.0, 0.4)] })
    })

    const t = scribeTranscriber({ apiKey: 'xi-key', fetchFn: fetchFn as unknown as typeof fetch })
    await t.transcribe({
      buffer: Buffer.from('aac-bytes'),
      mime: 'audio/aac',
      durationMs: 1_000,
      language: 'yue',
    })

    const form = captured.init?.body as FormData
    expect(form.get('language_code')).toBe('yue')
  })

  it('reports flat-rate costUsd, adding the keyterms rate only when keyterms are sent', async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse({ words: [word('a', 0, HOUR_MS / 1000 - 5)] }),
    )
    const t = scribeTranscriber({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch })

    const plain = await t.transcribe({ buffer: Buffer.from('x'), mime: 'audio/aac', durationMs: HOUR_MS })
    // `audioSeconds` rides along with the flat-rate cost so the billing
    // ledger keeps the denominator this cost was derived from — without it
    // a per-audio-hour provider cannot be compared to a token-billed one.
    expect(plain.usages).toEqual([
      {
        usage: null,
        model: 'elevenlabs:scribe_v2',
        costUsd: SCRIBE_USD_PER_AUDIO_HOUR,
        audioSeconds: HOUR_MS / 1000,
      },
    ])

    const biased = await t.transcribe({
      buffer: Buffer.from('x'),
      mime: 'audio/aac',
      durationMs: HOUR_MS,
      keyterms: ['Sidan'],
    })
    expect(biased.usages[0].costUsd).toBeCloseTo(
      SCRIBE_USD_PER_AUDIO_HOUR + SCRIBE_KEYTERMS_USD_PER_AUDIO_HOUR,
    )
  })

  it('marks truncated when the words stop far short of the audio end', async () => {
    const fetchFn = vi.fn(async () => mockResponse({ words: [word('early', 0, 30)] }))
    const t = scribeTranscriber({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch })

    const res = await t.transcribe({ buffer: Buffer.from('x'), mime: 'audio/aac', durationMs: HOUR_MS })
    expect(res.truncated).toBe(true)
  })

  it('falls back to the flat text spanning the duration when no words come back', async () => {
    const fetchFn = vi.fn(async () => mockResponse({ text: 'only text', words: [] }))
    const t = scribeTranscriber({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch })

    const res = await t.transcribe({ buffer: Buffer.from('x'), mime: 'audio/aac', durationMs: 90_000 })
    expect(res.utterances).toEqual([
      { startMs: 0, endMs: 90_000, speaker: null, text: 'only text' },
    ])
    expect(res.truncated).toBe(false)
  })

  it('throws with the status and body snippet on a non-OK response', async () => {
    const fetchFn = vi.fn(async () => mockResponse({ detail: 'bad key' }, { status: 401 }))
    const t = scribeTranscriber({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch })

    await expect(
      t.transcribe({ buffer: Buffer.from('x'), mime: 'audio/aac', durationMs: 1000 }),
    ).rejects.toThrow(/HTTP 401.*bad key/s)
  })
})
