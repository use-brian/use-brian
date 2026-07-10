import { describe, it, expect } from 'vitest'
import {
  parseTranscriptLines,
  mergeUtterances,
  stripDegenerateTail,
  stripDegenerateUtterances,
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

describe('[COMP:media/transcribe-recording] stripDegenerateTail', () => {
  it('leaves normal transcript text untouched', () => {
    const text = [
      '[0:00:00] Speaker 1: Hello and welcome, welcome back everyone.',
      '[0:00:08] Speaker 2: Thanks, thanks. Happy to be here today.',
    ].join('\n')
    expect(stripDegenerateTail(text)).toEqual({ text, degenerate: false })
  })

  it('cuts a CJK filler loop at its start, keeping the clean line head', () => {
    const clean = '[0:00:05] Speaker 1: 應該差多八年,我主要啦,就做,'
    const res = stripDegenerateTail(clean + '就,'.repeat(60))
    expect(res.degenerate).toBe(true)
    expect(res.text.startsWith('[0:00:05] Speaker 1: 應該差多八年')).toBe(true)
    expect(res.text).not.toContain('就,就,就,就,就')
  })

  it('cuts a multi-word English loop (longer period)', () => {
    const res = stripDegenerateTail('[0:00:01] A: he said ' + 'you know, '.repeat(30))
    expect(res.degenerate).toBe(true)
    expect(res.text.length).toBeLessThan(60)
  })

  it('tolerates natural short repetition below the threshold', () => {
    const text = '[0:00:01] A: no, no, no, no, no, that is not what I meant.'
    expect(stripDegenerateTail(text)).toEqual({ text, degenerate: false })
  })
})

describe('[COMP:media/transcribe-recording] stripDegenerateUtterances', () => {
  const utt = (startMs: number, speaker: string, text: string): TranscribedUtterance => ({
    startMs,
    endMs: startMs,
    speaker,
    text,
  })

  it('leaves varied real speech untouched', () => {
    const u = Array.from({ length: 30 }, (_, i) => utt(i * 1000, `Speaker ${(i % 2) + 1}`, `utterance number ${i}`))
    expect(stripDegenerateUtterances(u)).toEqual({ utterances: u, degenerate: false })
  })

  it('cuts a run of identical texts at the start of the run', () => {
    const clean = [utt(0, 'A', 'hello.'), utt(2000, 'B', 'hi there.')]
    const loop = Array.from({ length: 12 }, (_, i) => utt(3000 + i * 1000, 'A', '其實最辛苦的幾年。'))
    const res = stripDegenerateUtterances([...clean, ...loop])
    expect(res.degenerate).toBe(true)
    expect(res.utterances).toEqual(clean)
  })

  it('catches two phrases alternating with drifting timestamps and speakers (2026-07-10 shape)', () => {
    const clean = [utt(0, 'A', 'real opening line.')]
    const loop = Array.from({ length: 20 }, (_, i) =>
      utt(1000 + i * 997, `Speaker ${(i % 2) + 1}`, i % 2 === 0 ? '其實最辛苦的幾年。' : '我覺得最辛苦的幾年。'),
    )
    const res = stripDegenerateUtterances([...clean, ...loop])
    expect(res.degenerate).toBe(true)
    expect(res.utterances).toEqual(clean)
  })

  it('tolerates a genuinely repeated phrase below both thresholds', () => {
    const u = [
      utt(0, 'A', 'okay.'),
      utt(1000, 'B', 'okay.'),
      utt(2000, 'A', 'okay.'),
      utt(3000, 'B', 'so, moving on to pricing.'),
      utt(4000, 'A', 'sounds good.'),
    ]
    expect(stripDegenerateUtterances(u)).toEqual({ utterances: u, degenerate: false })
  })
})

describe('[COMP:media/transcribe-recording] transcribeRecording', () => {
  function makeMockFetch(windowTexts: Array<{ text: string; finishReason: string }>) {
    let gen = 0
    const calls: string[] = []
    const generateBodies: Array<{ prompt: string; temperature: number }> = []
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
      if (u.includes(':streamGenerateContent')) {
        const req = JSON.parse(String(init?.body ?? '{}')) as {
          contents?: Array<{ parts?: Array<{ text?: string }> }>
          generationConfig?: { temperature?: number }
        }
        generateBodies.push({
          prompt: req.contents?.[0]?.parts?.[0]?.text ?? '',
          temperature: req.generationConfig?.temperature ?? -1,
        })
        const w = windowTexts[Math.min(gen, windowTexts.length - 1)]
        gen++
        // SSE wire shape: the text arrives split across chunks (proving the
        // parser accumulates), finishReason + usageMetadata ride the LAST one.
        const mid = Math.ceil(w.text.length / 2)
        const sse = [
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: w.text.slice(0, mid) }] } }] })}`,
          '',
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: w.text.slice(mid) }] }, finishReason: w.finishReason }],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
          })}`,
          '',
          '',
        ].join('\n')
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error('unexpected fetch url: ' + u)
    }) as unknown as typeof fetch
    return { fetchFn, calls: () => calls, generateBodies: () => generateBodies }
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

  it('retries a degenerate window with the temperature nudge and recovers coverage', async () => {
    const degenerateWindow = {
      text: [
        '[0:00:00] Speaker 1: Hello and welcome to the call.',
        '[0:00:08] Speaker 2: Thanks, happy to be here.',
        '[0:00:15] Speaker 1: ' + '就,'.repeat(80), // the loop
      ].join('\n'),
      finishReason: 'STOP', // retry must trigger on degeneration even on STOP
    }
    const nudgedRetry = {
      text: [
        '[0:00:08] Speaker 2: Thanks, happy to be here.', // re-emitted seam — dropped
        '[0:01:30] Speaker 2: We can offer a 10 percent discount.',
        '[0:01:58] Speaker 1: Great, we will finalize by Friday.',
      ].join('\n'),
      finishReason: 'STOP',
    }
    const { fetchFn, generateBodies } = makeMockFetch([degenerateWindow, nudgedRetry])

    const res = await transcribeRecording({
      apiKey: 'k',
      buffer: Buffer.from('x'),
      mime: 'audio/mp4',
      durationMs: 120_000,
      fetchFn,
    })

    expect(res.degenerateWindows).toBe(1)
    expect(res.windows).toBe(2)
    expect(res.truncated).toBe(false)
    expect(res.utterances.map((u) => u.text)).toEqual([
      'Hello and welcome to the call.',
      'Thanks, happy to be here.',
      'We can offer a 10 percent discount.',
      'Great, we will finalize by Friday.',
    ])
    // First window is greedy; the retry carries the nudge.
    expect(generateBodies()[0].temperature).toBe(0)
    expect(generateBodies()[0].prompt).not.toContain('repeating a filler word')
    expect(generateBodies()[1].temperature).toBe(0.3)
    expect(generateBodies()[1].prompt).toContain('repeating a filler word')
    expect(generateBodies()[1].prompt).toContain('AFTER 0:00:08') // resumes from last clean line
  })

  it('retries a line-level loop with hallucinated timestamps instead of treating it as coverage', async () => {
    // The 2026-07-10 live shape: one real line, then the same sentence re-emitted
    // for hundreds of lines with timestamps drifting far past the audio end. The
    // hallucinated timestamps must NOT satisfy the coverage check (that would
    // bill garbage); the loop must be cut and the window retried.
    const loopLines = Array.from({ length: 40 }, (_, i) => {
      const totalS = 10 + i * 30 // climbs to 0:20:10 — audio is only 10 min
      const m = Math.floor(totalS / 60)
      const s = totalS % 60
      return `[0:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}] Speaker ${(i % 2) + 1}: 其實最辛苦的幾年。`
    })
    const degenerateWindow = {
      text: ['[0:00:02] Speaker 1: real content here.', ...loopLines].join('\n'),
      finishReason: 'STOP',
    }
    const nudgedRetry = {
      text: ['[0:00:02] Speaker 1: real content here.', '[0:05:00] Speaker 2: middle of the call.', '[0:09:50] Speaker 1: wrapping up now.'].join('\n'),
      finishReason: 'STOP',
    }
    const { fetchFn, generateBodies } = makeMockFetch([degenerateWindow, nudgedRetry])

    const res = await transcribeRecording({
      apiKey: 'k',
      buffer: Buffer.from('x'),
      mime: 'audio/mp4',
      durationMs: 600_000,
      fetchFn,
    })

    expect(res.degenerateWindows).toBe(1)
    expect(res.windows).toBe(2)
    expect(res.truncated).toBe(false)
    expect(res.utterances.map((u) => u.text)).toEqual([
      'real content here.',
      'middle of the call.',
      'wrapping up now.',
    ])
    // The retry resumed from the last CLEAN utterance, not the hallucinated tail.
    expect(generateBodies()[1].prompt).toContain('AFTER 0:00:02')
    expect(generateBodies()[1].temperature).toBe(0.3)
  })

  it('gives up on an unrecoverable loop and marks the transcript truncated', async () => {
    const loop = '[0:00:05] Speaker 1: ' + '就,'.repeat(80)
    const first = { text: '[0:00:02] Speaker 1: hello there.\n' + loop, finishReason: 'STOP' }
    const stuckRetry = { text: '[0:00:02] Speaker 1: hello there.\n' + loop, finishReason: 'STOP' }
    const { fetchFn, calls } = makeMockFetch([first, stuckRetry])

    const res = await transcribeRecording({
      apiKey: 'k',
      buffer: Buffer.from('x'),
      mime: 'audio/mp4',
      durationMs: 600_000,
      fetchFn,
    })

    // Nudged retry made no forward progress at the same seam -> stop, do not spin.
    expect(res.windows).toBe(2)
    expect(res.degenerateWindows).toBe(2)
    expect(res.truncated).toBe(true) // -> caller bills 0
    expect(res.utterances.map((u) => u.text)).toEqual(['hello there.'])
    expect(calls().filter((u) => u.includes(':streamGenerateContent'))).toHaveLength(2)
  })
})
