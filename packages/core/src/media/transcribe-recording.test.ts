import { describe, it, expect } from 'vitest'
import {
  parseTranscriptLines,
  mergeUtterances,
  stripDegenerateTail,
  stripDegenerateUtterances,
  hasTranscriptHole,
  transcribeRecording,
  transcribeRecordingChunks,
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

  it('flags truncated when continuation makes no progress before the audio end', async () => {
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
    // A premature STOP gets a continuation try, then the stall-skip budget
    // (3 skips) — the mock re-emits the same line every time (no forward
    // progress), so the loop exhausts 1 + 1 + 3 windows and stops.
    expect(res.windows).toBe(5)
  })

  it('skips past a stall and recovers the rest of the audio', async () => {
    // 2026-07-13 shape: mid-conversation the model stops advancing — window
    // after window re-emits the seam. The loop must skip the resume point
    // forward past the stuck spot instead of ending the run.
    const w1 = {
      text: ['[0:00:01] Speaker 1: opening.', '[0:03:20] Speaker 2: before the stall.'].join('\n'),
      finishReason: 'STOP',
    }
    const stalled = { text: '[0:03:20] Speaker 2: before the stall.', finishReason: 'STOP' } // no progress
    const recovered = {
      text: ['[0:06:10] Speaker 1: after the gap.', '[0:09:50] Speaker 2: closing.'].join('\n'),
      finishReason: 'STOP',
    }
    const { fetchFn, generateBodies } = makeMockFetch([w1, stalled, recovered])
    const res = await transcribeRecording({
      apiKey: 'k',
      buffer: Buffer.from('x'),
      mime: 'audio/mp4',
      durationMs: 600_000,
      fetchFn,
    })
    expect(res.windows).toBe(3)
    expect(res.truncated).toBe(false)
    expect(res.utterances.map((u) => u.text)).toEqual([
      'opening.',
      'before the stall.',
      'after the gap.',
      'closing.',
    ])
    // The skip pushed the resume point 90s past the stall site (0:03:20 -> 0:04:50).
    expect(generateBodies()[2].prompt).toContain('AFTER 0:04:50')
  })

  it('continues past a premature STOP that leaves audio uncovered', async () => {
    // 2026-07-13 shape: the model emits a few minutes of transcript and stops
    // cold (finishReason STOP, nowhere near MAX_TOKENS) on a long recording.
    // The loop must continue from the last line rather than end the run.
    const prematureStop = {
      text: ['[0:00:01] Speaker 1: opening remarks.', '[0:03:20] Speaker 2: early discussion.'].join('\n'),
      finishReason: 'STOP',
    }
    const continuation = {
      text: ['[0:03:20] Speaker 2: early discussion.', '[0:07:00] Speaker 1: middle part.', '[0:09:45] Speaker 2: closing.'].join('\n'),
      finishReason: 'STOP',
    }
    const { fetchFn, generateBodies } = makeMockFetch([prematureStop, continuation])
    const res = await transcribeRecording({
      apiKey: 'k',
      buffer: Buffer.from('x'),
      mime: 'audio/mp4',
      durationMs: 600_000,
      fetchFn,
    })
    expect(res.windows).toBe(2)
    expect(res.truncated).toBe(false)
    expect(res.degenerateWindows).toBe(0)
    expect(res.utterances.map((u) => u.text)).toEqual([
      'opening remarks.',
      'early discussion.',
      'middle part.',
      'closing.',
    ])
    // The continuation resumed from the last emitted line at normal temperature.
    expect(generateBodies()[1].prompt).toContain('AFTER 0:03:20')
    expect(generateBodies()[1].temperature).toBe(0)
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

  it('retries a transient socket reset on a leg instead of failing the whole run', async () => {
    const inner = makeMockFetch([
      { text: '[0:00:02] Speaker 1: short and sweet.', finishReason: 'STOP' },
    ])
    // First TWO calls (upload start, then its retry target) reject like undici
    // does on a connection reset; everything after flows to the normal mock.
    let failures = 2
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (failures > 0) {
        failures--
        throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') })
      }
      return (inner.fetchFn as typeof fetch)(url as string, init)
    }) as unknown as typeof fetch

    const res = await transcribeRecording({
      apiKey: 'k',
      buffer: Buffer.from('x'),
      mime: 'audio/mp4',
      durationMs: 10_000,
      fetchFn: flaky,
      retryBackoffMs: 0,
    })
    expect(res.utterances.map((u) => u.text)).toEqual(['short and sweet.'])
    expect(res.truncated).toBe(false)
  }, 15_000)

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

describe('[COMP:media/transcribe-recording] transcribeRecordingChunks resilience', () => {
  /** A chunk mock whose upload leg fails `uploadFailures` times with a status,
   *  then succeeds; the generate leg returns `text`. */
  function chunkFetch(opts: { uploadStatus?: number; uploadFailures?: number; text: string }) {
    let uploadsLeft = opts.uploadFailures ?? 0
    return (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/upload/v1beta/files')) {
        if (uploadsLeft > 0) {
          uploadsLeft--
          return new Response('overloaded', { status: opts.uploadStatus ?? 503 })
        }
        return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://up.example/s' } })
      }
      if (u === 'https://up.example/s') {
        return new Response(
          JSON.stringify({ file: { uri: 'files/c', name: 'files/c', state: 'ACTIVE', mimeType: 'audio/aac' } }),
          { status: 200 },
        )
      }
      if (u.includes(':generateContent') || u.includes(':streamGenerateContent')) {
        const sse = `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: opts.text }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        })}\n\n`
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error('unexpected url ' + u)
    }) as unknown as typeof fetch
  }

  const chunk = (offsetMs: number) => ({ buffer: Buffer.from('a'), mime: 'audio/aac', offsetMs, durationMs: 60_000 })

  it('rides out a Gemini 503 on the upload leg instead of dropping the chunk', async () => {
    // 2026-07-14: chunk 3 of a 96-min recording died on a single 503, which
    // truncated the whole transcript (no page, no charge) even though a retry
    // would have succeeded.
    const res = await transcribeRecordingChunks(
      {
        apiKey: 'k',
        buffer: Buffer.from('x'),
        mime: 'audio/aac',
        durationMs: 60_000,
        fetchFn: chunkFetch({ uploadStatus: 503, uploadFailures: 2, text: '[0:00:50] Speaker 1: recovered.' }),
        retryBackoffMs: 0,
      },
      [chunk(0)],
    )
    expect(res.truncated).toBe(false)
    expect(res.utterances.map((u) => u.text)).toEqual(['recovered.'])
  }, 20_000)

  it('continues a chunk that stops short instead of leaving a hole', async () => {
    // 2026-07-14, the real failure: one generate call per chunk, and the model
    // stopped after the first minutes of a ~10-min chunk. Five such chunks left
    // 8-10 min HOLES in a 96-min transcript that was still billed as complete.
    let gen = 0
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/upload/v1beta/files'))
        return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://up.example/s' } })
      if (u === 'https://up.example/s')
        return new Response(
          JSON.stringify({ file: { uri: 'files/c', name: 'files/c', state: 'ACTIVE', mimeType: 'audio/aac' } }),
          { status: 200 },
        )
      if (u.includes(':generateContent') || u.includes(':streamGenerateContent')) {
        const prompt = JSON.parse(String(init?.body ?? '{}')).contents[0].parts[0].text as string
        gen++
        // Window 1 stops at 1:00 of a 10-min chunk; the continuation (which must
        // carry the resume instruction) runs to the end.
        const text = prompt.includes('Resume from the next utterance AFTER')
          ? '[2:00] Speaker 2: carried on.\n[3:30] Speaker 1: the middle.\n[5:00] Speaker 2: and on.\n[6:30] Speaker 1: nearly done.\n[8:00] Speaker 2: wrapping.\n[9:40] Speaker 1: the end.'
          : '[0:10] Speaker 1: the opening.\n[1:00] Speaker 2: stops short here.'
        const sse = `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        })}\n\n`
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error('unexpected url ' + u)
    }) as unknown as typeof fetch

    const res = await transcribeRecordingChunks(
      {
        apiKey: 'k',
        buffer: Buffer.from('x'),
        mime: 'audio/aac',
        durationMs: 600_000,
        fetchFn,
        retryBackoffMs: 0,
      },
      [{ buffer: Buffer.from('a'), mime: 'audio/aac', offsetMs: 0, durationMs: 600_000 }],
    )
    expect(res.truncated).toBe(false) // the chunk was carried to its end
    expect(res.utterances.map((u) => u.text)).toEqual([
      'the opening.',
      'stops short here.',
      'carried on.',
      'the middle.',
      'and on.',
      'nearly done.',
      'wrapping.',
      'the end.',
    ])
    expect(gen).toBe(2) // one continuation, not a silent hole
  }, 15_000)

  it('skips past a stall inside a chunk instead of abandoning the rest of it', async () => {
    // 2026-07-14: a chunk stalled mid-way and the loop gave up, leaving a
    // 4.4-min hole at ~47 min of a 96-min recording (correctly unbilled, but
    // the user got no brief). The chunk loop now skips the resume point ahead.
    const prompts: string[] = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/upload/v1beta/files'))
        return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://up.example/s' } })
      if (u === 'https://up.example/s')
        return new Response(
          JSON.stringify({ file: { uri: 'files/c', name: 'files/c', state: 'ACTIVE', mimeType: 'audio/aac' } }),
          { status: 200 },
        )
      if (u.includes('enerateContent')) {
        const prompt = JSON.parse(String(init?.body ?? '{}')).contents[0].parts[0].text as string
        prompts.push(prompt)
        // Resuming AFTER 2:00 stalls (re-emits the seam, no progress). Only a
        // resume point PAST the stall (3:00, after the 60s skip) moves on.
        let text: string
        if (prompt.includes('AFTER 3:00'))
          text = '[3:30] Speaker 1: past the stall.\n[5:30] Speaker 2: still going.\n[7:30] Speaker 1: nearly there.\n[9:40] Speaker 2: the end.'
        else if (prompt.includes('AFTER 2:00')) text = '[2:00] Speaker 2: stuck here.'
        else text = '[0:10] Speaker 1: opening.\n[2:00] Speaker 2: stuck here.'
        const sse = `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        })}\n\n`
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error('unexpected url ' + u)
    }) as unknown as typeof fetch

    const res = await transcribeRecordingChunks(
      { apiKey: 'k', buffer: Buffer.from('x'), mime: 'audio/aac', durationMs: 600_000, fetchFn, retryBackoffMs: 0 },
      [{ buffer: Buffer.from('a'), mime: 'audio/aac', offsetMs: 0, durationMs: 600_000 }],
    )
    expect(res.truncated).toBe(false)
    expect(res.utterances.map((u) => u.text)).toEqual([
      'opening.',
      'stuck here.',
      'past the stall.',
      'still going.',
      'nearly there.',
      'the end.',
    ])
    expect(prompts.some((p) => p.includes('AFTER 3:00'))).toBe(true) // the skip happened
  }, 15_000)

  it('fills the hole a stall-skip leaves with a targeted re-ask', async () => {
    // The skip itself creates a gap (we jump the resume point past the stall),
    // and an unfilled 3.7-min gap truncated a 96-min recording (2026-07-14).
    // A targeted "transcribe only MM:SS-MM:SS" pass recovers the skipped audio.
    const prompts: string[] = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/upload/v1beta/files'))
        return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://up.example/s' } })
      if (u === 'https://up.example/s')
        return new Response(
          JSON.stringify({ file: { uri: 'files/c', name: 'files/c', state: 'ACTIVE', mimeType: 'audio/aac' } }),
          { status: 200 },
        )
      if (u.includes('enerateContent')) {
        const prompt = JSON.parse(String(init?.body ?? '{}')).contents[0].parts[0].text as string
        prompts.push(prompt)
        let text: string
        if (prompt.includes('Transcribe ONLY the audio between')) {
          text = '[2:30] Speaker 1: the audio we skipped over.' // the gap-fill
        } else if (prompt.includes('AFTER')) {
          text = '[5:00] Speaker 2: after the hole.\n[7:00] Speaker 1: still talking.\n[9:40] Speaker 1: the end.'
        } else {
          text = '[0:10] Speaker 1: opening.\n[1:00] Speaker 2: then it stalls.'
        }
        const sse = `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        })}\n\n`
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error('unexpected url ' + u)
    }) as unknown as typeof fetch

    const res = await transcribeRecordingChunks(
      { apiKey: 'k', buffer: Buffer.from('x'), mime: 'audio/aac', durationMs: 600_000, fetchFn, retryBackoffMs: 0 },
      [{ buffer: Buffer.from('a'), mime: 'audio/aac', offsetMs: 0, durationMs: 600_000 }],
    )
    // The 1:00 -> 5:00 hole is filled, so the transcript has no 3-min void.
    expect(prompts.some((p) => p.includes('Transcribe ONLY the audio between'))).toBe(true)
    expect(res.utterances.map((u) => u.text)).toContain('the audio we skipped over.')
    expect(res.truncated).toBe(false)
  }, 15_000)

  it('marks the transcript truncated when a chunk yields nothing, so a holed transcript is never billed', async () => {
    const res = await transcribeRecordingChunks(
      {
        apiKey: 'k',
        buffer: Buffer.from('x'),
        mime: 'audio/aac',
        durationMs: 120_000,
        fetchFn: chunkFetch({ text: '' }), // every attempt comes back empty
        retryBackoffMs: 0,
      },
      [chunk(0)],
    )
    expect(res.truncated).toBe(true)
    expect(res.utterances).toHaveLength(0)
  }, 30_000)
})


describe('[COMP:media/transcribe-recording] hasTranscriptHole', () => {
  const u = (startMs: number, endMs: number): TranscribedUtterance => ({
    startMs,
    endMs,
    speaker: 'A',
    text: 'x',
  })

  it('accepts a transcript whose chunks end quiet (silence-split tails are not holes)', () => {
    // The 2026-07-14 false positive: chunks are split AT silence, so a chunk's
    // last line can sit a minute before its boundary. That is not a hole.
    const utts = [u(0, 60_000), u(70_000, 130_000), u(200_000, 280_000)]
    expect(hasTranscriptHole(utts, 300_000)).toBe(false)
  })

  it('flags a multi-minute stretch of audio with no transcript', () => {
    // The real bug: 8-10 min holes shipped as a complete transcript, and billed.
    const utts = [u(0, 60_000), u(600_000, 660_000)]
    expect(hasTranscriptHole(utts, 700_000)).toBe(true)
  })

  it('flags a transcript that never starts, or dies well before the end', () => {
    expect(hasTranscriptHole([u(400_000, 450_000)], 500_000)).toBe(true) // silent first 6.5 min
    expect(hasTranscriptHole([u(0, 60_000)], 600_000)).toBe(true) // stops at 1 of 10 min
    expect(hasTranscriptHole([], 60_000)).toBe(true)
  })
})
