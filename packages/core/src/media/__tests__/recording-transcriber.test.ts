import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  coverageTruncated,
  withTranscriberFallback,
  geminiTranscriber,
  type RecordingTranscriber,
  type RecordingTranscribeRequest,
} from '../recording-transcriber.js'
import * as transcribeRecordingModule from '../transcribe-recording.js'
import type { RecordingTranscriptionResult } from '../transcribe-recording.js'

vi.mock('../transcribe-recording.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transcribe-recording.js')>()
  return { ...actual, transcribeRecording: vi.fn(), transcribeRecordingChunks: vi.fn() }
})

const REQ: RecordingTranscribeRequest = {
  buffer: Buffer.from('audio'),
  mime: 'audio/aac',
  durationMs: 600_000,
}

function result(overrides: Partial<RecordingTranscriptionResult> = {}): RecordingTranscriptionResult {
  return {
    utterances: [{ startMs: 0, endMs: 590_000, speaker: null, text: 'hi' }],
    usages: [{ usage: null, model: 'test', costUsd: 0.01 }],
    windows: 1,
    truncated: false,
    ...overrides,
  }
}

function provider(name: string, impl: () => Promise<RecordingTranscriptionResult>): RecordingTranscriber {
  return { name, transcribe: vi.fn(impl) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('[COMP:media/recording-transcriber] coverageTruncated', () => {
  it('empty transcript is always truncated', () => {
    expect(coverageTruncated([], 60_000)).toBe(true)
  })

  it('last utterance within the tolerance of the end counts as covered', () => {
    expect(coverageTruncated([{ endMs: 550_000 }], 600_000)).toBe(false)
  })

  it('last utterance short of the tolerance is truncated', () => {
    expect(coverageTruncated([{ endMs: 500_000 }], 600_000)).toBe(true)
  })

  it('honors a custom tolerance', () => {
    expect(coverageTruncated([{ endMs: 500_000 }], 600_000, 120_000)).toBe(false)
  })
})

describe('[COMP:media/recording-transcriber] withTranscriberFallback', () => {
  it('returns the primary result without touching the rest', async () => {
    const ok = result()
    const primary = provider('a', async () => ok)
    const backup = provider('b', async () => result({ windows: 9 }))

    const out = await withTranscriberFallback(primary, backup).transcribe(REQ)

    expect(out).toBe(ok)
    expect(backup.transcribe).not.toHaveBeenCalled()
  })

  it('falls through to the next provider when one throws, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const primary = provider('a', async () => {
      throw new Error('a down')
    })
    const ok = result()
    const backup = provider('b', async () => ok)

    const ladder = withTranscriberFallback(primary, backup)
    expect(ladder.name).toBe('a→b')
    const out = await ladder.transcribe(REQ)

    expect(out).toBe(ok)
    expect(backup.transcribe).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('rethrows the LAST error when every provider fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = provider('a', async () => {
      throw new Error('a down')
    })
    const b = provider('b', async () => {
      throw new Error('b down')
    })

    await expect(withTranscriberFallback(a, b).transcribe(REQ)).rejects.toThrow('b down')
  })
})

describe('[COMP:media/recording-transcriber] geminiTranscriber', () => {
  it('delegates to transcribeRecording with the bound key/model and request fields', async () => {
    const ok = result()
    const spy = vi.mocked(transcribeRecordingModule.transcribeRecording)
    spy.mockResolvedValue(ok)

    const t = geminiTranscriber({ apiKey: 'k', model: 'gemini-test' })
    expect(t.name).toBe('gemini-test')
    const out = await t.transcribe({ ...REQ, displayName: 'call.aac' })

    expect(out).toBe(ok)
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'k',
        model: 'gemini-test',
        buffer: REQ.buffer,
        mime: 'audio/aac',
        durationMs: 600_000,
        displayName: 'call.aac',
      }),
    )
  })

  it('uses chunked mode for long audio when getChunks is supplied', async () => {
    const ok = result()
    const chunked = vi.mocked(transcribeRecordingModule.transcribeRecordingChunks)
    const legacy = vi.mocked(transcribeRecordingModule.transcribeRecording)
    chunked.mockResolvedValue(ok)
    const chunks = [{ buffer: Buffer.from('c'), mime: 'audio/aac', offsetMs: 0, durationMs: 600_000 }]
    const getChunks = vi.fn(async () => chunks)

    const out = await geminiTranscriber({ apiKey: 'k' }).transcribe({
      ...REQ,
      durationMs: 90 * 60_000, // 1h30m — past the chunking threshold
      getChunks,
    })

    expect(out).toBe(ok)
    expect(getChunks).toHaveBeenCalledOnce()
    expect(chunked).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'k' }), chunks)
    expect(legacy).not.toHaveBeenCalled()
  })

  it('short audio stays on the whole-file path even with getChunks available', async () => {
    const ok = result()
    const legacy = vi.mocked(transcribeRecordingModule.transcribeRecording)
    legacy.mockResolvedValue(ok)
    const getChunks = vi.fn(async () => [])

    const out = await geminiTranscriber({ apiKey: 'k' }).transcribe({ ...REQ, getChunks })

    expect(out).toBe(ok)
    expect(getChunks).not.toHaveBeenCalled()
  })

  it('degrades to the whole-file path when the chunk split fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = result()
    const legacy = vi.mocked(transcribeRecordingModule.transcribeRecording)
    const chunked = vi.mocked(transcribeRecordingModule.transcribeRecordingChunks)
    legacy.mockResolvedValue(ok)

    const out = await geminiTranscriber({ apiKey: 'k' }).transcribe({
      ...REQ,
      durationMs: 90 * 60_000,
      getChunks: vi.fn(async () => {
        throw new Error('ffmpeg split boom')
      }),
    })

    expect(out).toBe(ok)
    expect(chunked).not.toHaveBeenCalled()
    expect(legacy).toHaveBeenCalledOnce()
  })
})
