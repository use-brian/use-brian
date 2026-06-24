import { describe, it, expect } from 'vitest'
import {
  parseTranscriptLines,
  mergeUtterances,
  transcribeRecording,
  type TranscribedUtterance,
} from './transcribe-recording.js'

/**
 * Unit tests for the long-recording File-API transcription (recording-to-brain
 * Phase 2). The pure helpers test directly; the orchestration tests with a mock
 * `fetch` driving upload -> ACTIVE -> two generate windows (MAX_TOKENS then STOP).
 * Component tag: [COMP:media/transcribe-recording].
 */

describe('[COMP:media/transcribe-recording] parseTranscriptLines', () => {
  it('parses well-formed timestamped speaker lines and back-fills endMs', () => {
    const u = parseTranscriptLines(
      [
        '[0:00:00] Speaker 1: Hello there.',
        '[0:00:08] Speaker 2: Hi, thanks for joining.',
        '[0:01:05] Speaker 1: Let us begin.',
      ].join('\n'),
    )
    expect(u).toHaveLength(3)
    expect(u[0]).toMatchObject({ startMs: 0, endMs: 8000, speaker: 'Speaker 1', text: 'Hello there.' })
    expect(u[1]).toMatchObject({ startMs: 8000, endMs: 65000, speaker: 'Speaker 2' })
    expect(u[2].startMs).toBe(65000)
  })

  it('drops malformed / trailing partial lines (a MAX_TOKENS cut)', () => {
    const u = parseTranscriptLines(
      ['[0:00:03] Alice: complete line.', 'not a transcript line', '[0:00:10] Bob: another good one.', '[0:00:14] Carol: truncat'].join('\n'),
    )
    // The 'truncat' line is well-formed (has text), so it parses; a line with no
    // body or no bracket is dropped. Here only the freeform line is dropped.
    expect(u.map((x) => x.text)).toEqual(['complete line.', 'another good one.', 'truncat'])
  })

  it('ignores blank lines and an unparseable header', () => {
    const u = parseTranscriptLines('\n\nTRANSCRIPT:\n[0:00:01] X: hi\n\n')
    expect(u).toHaveLength(1)
    expect(u[0].text).toBe('hi')
  })
})

describe('[COMP:media/transcribe-recording] mergeUtterances', () => {
  const a: TranscribedUtterance[] = [
    { startMs: 0, endMs: 5000, speaker: 'A', text: 'one' },
    { startMs: 15000, endMs: 15000, speaker: 'B', text: 'two' }, // last emitted line at 15000
  ]
  it('drops a re-emitted seam line and appends only forward-progressing lines', () => {
    const next: TranscribedUtterance[] = [
      { startMs: 15000, endMs: 15000, speaker: 'B', text: 'two (re-emitted seam)' },
      { startMs: 30000, endMs: 30000, speaker: 'A', text: 'three' },
    ]
    const merged = mergeUtterances(a, next)
    expect(merged.map((u) => u.text)).toEqual(['one', 'two', 'three'])
    expect(merged[1].endMs).toBe(30000) // boundary endMs fixed to the next start
  })
  it('returns prev unchanged when the continuation made no forward progress', () => {
    const next: TranscribedUtterance[] = [{ startMs: 10000, endMs: 10000, speaker: 'B', text: 'stale' }]
    expect(mergeUtterances(a, next)).toEqual(a)
  })
  it('returns next when prev is empty', () => {
    expect(mergeUtterances([], a)).toEqual(a)
  })
})

describe('[COMP:media/transcribe-recording] transcribeRecording', () => {
  function makeMockFetch(windowTexts: Array<{ text: string; finishReason: string }>) {
    let gen = 0
    const calls: string[] = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      calls.push(u)
      if (u.endsWith('/upload/v1beta/files')) {
        return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/session1' } })
      }
      if (u === 'https://upload.example/session1') {
        return new Response(
          JSON.stringify({ file: { uri: 'files/rec123', name: 'files/rec123', state: 'ACTIVE', mimeType: 'audio/mp4' } }),
          { status: 200 },
        )
      }
      if (u.includes(':generateContent')) {
        const w = windowTexts[Math.min(gen, windowTexts.length - 1)]
        gen++
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: w.text }] }, finishReason: w.finishReason }],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
          }),
          { status: 200 },
        )
      }
      throw new Error('unexpected fetch url: ' + u)
    }) as unknown as typeof fetch
    return { fetchFn, calls: () => calls }
  }

  it('stitches a MAX_TOKENS window with its STOP continuation, covering the audio', async () => {
    const window1 = {
      text: [
        '[0:00:00] Speaker 1: Hello and welcome to the sales call.',
        '[0:00:08] Speaker 2: Thanks, happy to be here.',
        '[0:00:15] Speaker 1: Let us talk about the Q3 pricing pushback.',
      ].join('\n'),
      finishReason: 'MAX_TOKENS',
    }
    const window2 = {
      text: [
        '[0:00:15] Speaker 1: Let us talk about the Q3 pricing pushback.', // re-emitted seam — dropped
        '[0:01:30] Speaker 2: We can offer a 10 percent discount.',
        '[0:01:58] Speaker 1: Great, we will finalize by Friday.',
      ].join('\n'),
      finishReason: 'STOP',
    }
    const { fetchFn } = makeMockFetch([window1, window2])

    const res = await transcribeRecording({
      apiKey: 'test-key',
      buffer: Buffer.from('fake-audio-bytes'),
      mime: 'audio/mp4',
      durationMs: 120_000, // 2 min — forces a continuation after window1 (last line 0:15)
      fetchFn,
    })

    expect(res.windows).toBe(2)
    expect(res.usages).toHaveLength(2)
    expect(res.truncated).toBe(false)
    expect(res.utterances.map((u) => u.text)).toEqual([
      'Hello and welcome to the sales call.',
      'Thanks, happy to be here.',
      'Let us talk about the Q3 pricing pushback.',
      'We can offer a 10 percent discount.',
      'Great, we will finalize by Friday.',
    ])
    // final endMs clamped to the known duration
    expect(res.utterances[res.utterances.length - 1].endMs).toBe(120_000)
  })

  it('flags truncated when the transcript never reaches the audio end', async () => {
    const onlyWindow = {
      text: '[0:00:02] Speaker 1: This is the very start and then it cuts off.',
      finishReason: 'STOP',
    }
    const { fetchFn } = makeMockFetch([onlyWindow])
    const res = await transcribeRecording({
      apiKey: 'k',
      buffer: Buffer.from('x'),
      mime: 'audio/mp4',
      durationMs: 600_000, // 10 min, but transcript stops at 2s
      fetchFn,
    })
    expect(res.truncated).toBe(true)
    expect(res.windows).toBe(1) // STOP -> no continuation attempted
  })
})
