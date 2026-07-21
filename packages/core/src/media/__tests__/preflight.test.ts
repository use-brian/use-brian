import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MediaAttachment } from '../types.js'

vi.mock('../transcribe.js', () => ({
  transcribeAudio: vi.fn(),
}))

// Import after the mock so the preflight binds to the mocked export.
const { transcribeFirstAudio, describeTranscriptionFailure } = await import('../preflight.js')
const { transcribeAudio } = await import('../transcribe.js')
const mockedTranscribe = vi.mocked(transcribeAudio)

const baseOptions = {
  enabled: true,
  apiKey: 'test-key',
}

describe('[COMP:media/preflight] transcribeFirstAudio', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockedTranscribe.mockReset()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('returns undefined and never calls transcribeAudio when disabled', async () => {
    const attachments: MediaAttachment[] = [{ buffer: Buffer.from('x'), mime: 'audio/ogg', index: 0 }]
    const result = await transcribeFirstAudio(attachments, { ...baseOptions, enabled: false })
    expect(result).toBeUndefined()
    expect(mockedTranscribe).not.toHaveBeenCalled()
  })

  it('returns undefined for empty attachments', async () => {
    const result = await transcribeFirstAudio([], baseOptions)
    expect(result).toBeUndefined()
    expect(mockedTranscribe).not.toHaveBeenCalled()
  })

  it('returns undefined when no attachment is audio/*', async () => {
    const attachments: MediaAttachment[] = [
      { buffer: Buffer.from('x'), mime: 'image/jpeg', index: 0 },
    ]
    const result = await transcribeFirstAudio(attachments, baseOptions)
    expect(result).toBeUndefined()
    expect(mockedTranscribe).not.toHaveBeenCalled()
  })

  it('skips attachments marked alreadyTranscribed', async () => {
    const attachments: MediaAttachment[] = [
      { buffer: Buffer.from('x'), mime: 'audio/ogg', index: 0, alreadyTranscribed: true },
    ]
    const result = await transcribeFirstAudio(attachments, baseOptions)
    expect(result).toBeUndefined()
    expect(mockedTranscribe).not.toHaveBeenCalled()
  })

  it('transcribes the first audio attachment and flips alreadyTranscribed', async () => {
    mockedTranscribe.mockResolvedValue({ text: 'hello world', usage: { inputTokens: 10, outputTokens: 2 }, model: 'gemini-2.5-flash' })
    const attachments: MediaAttachment[] = [
      { buffer: Buffer.from('a'), mime: 'audio/ogg', index: 0 },
      { buffer: Buffer.from('b'), mime: 'audio/webm', index: 1 },
    ]
    const result = await transcribeFirstAudio(attachments, baseOptions)
    expect(result?.text).toBe('hello world')
    expect(result?.model).toBe('gemini-2.5-flash')
    expect(result?.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
    expect(mockedTranscribe).toHaveBeenCalledTimes(1)
    expect(attachments[0].alreadyTranscribed).toBe(true)
    expect(attachments[1].alreadyTranscribed).toBeUndefined()
  })

  it('returns undefined and logs when transcribeAudio throws', async () => {
    mockedTranscribe.mockRejectedValue(new Error('boom'))
    const attachments: MediaAttachment[] = [{ buffer: Buffer.from('x'), mime: 'audio/ogg', index: 0 }]
    const result = await transcribeFirstAudio(attachments, baseOptions)
    expect(result).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    expect(attachments[0].alreadyTranscribed).toBeUndefined()
  })

  it('passes apiKey / model / timeoutMs / fetchFn through to transcribeAudio', async () => {
    mockedTranscribe.mockResolvedValue({ text: 'ok', usage: null, model: 'gemini-2.5-flash' })
    const customFetch = vi.fn() as unknown as typeof fetch
    await transcribeFirstAudio(
      [{ buffer: Buffer.from('x'), mime: 'audio/ogg', index: 0 }],
      { enabled: true, apiKey: 'k', model: 'm', timeoutMs: 1234, fetchFn: customFetch },
    )
    expect(mockedTranscribe).toHaveBeenCalledWith(
      { buffer: expect.any(Buffer), mime: 'audio/ogg' },
      { apiKey: 'k', model: 'm', timeoutMs: 1234, fetchFn: customFetch },
    )
  })
})

// A swallowed transcription failure used to reach the model as a bare
// "[voice note — transcription unavailable]", and it filled the gap by
// inventing status ("the transcription isn't available yet, let me check the
// recording status") and narrating tool calls at the user. The failure stays
// swallowed — a bad voice note must not fail the turn — but the reason now
// travels with it.
describe('[COMP:media/preflight] transcription failure reporting', () => {
  it('reports a reason through onFailure while still returning undefined', async () => {
    mockedTranscribe.mockRejectedValueOnce(new Error('DashScope transcription failed (HTTP 400): The audio is too long'))
    const seen: string[] = []
    const out = await transcribeFirstAudio(
      [{ buffer: Buffer.from('a'), mime: 'audio/mpeg', index: 0 } as MediaAttachment],
      { enabled: true, apiKey: 'k', onFailure: (r) => seen.push(r) },
    )
    expect(out).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/too long/i)
    expect(seen[0]).toMatch(/recording/i)
  })

  it('does not call onFailure on the success path', async () => {
    mockedTranscribe.mockResolvedValueOnce({ text: 'hello', usage: null, model: 'm' } as never)
    const seen: string[] = []
    await transcribeFirstAudio(
      [{ buffer: Buffer.from('a'), mime: 'audio/mpeg', index: 0 } as MediaAttachment],
      { enabled: true, apiKey: 'k', onFailure: (r) => seen.push(r) },
    )
    expect(seen).toEqual([])
  })
})

describe('[COMP:media/preflight] describeTranscriptionFailure', () => {
  it('turns the duration cap into routing guidance', () => {
    expect(describeTranscriptionFailure(new Error('<400> InvalidParameter: The audio is too long')))
      .toMatch(/too long .*recording/i)
  })

  it('classifies a rejected format', () => {
    expect(describeTranscriptionFailure(new Error("The dedicated task `asr` does not support this input")))
      .toMatch(/rejected by the transcription provider/i)
  })

  it('classifies a timeout', () => {
    expect(describeTranscriptionFailure(new Error('request aborted'))).toMatch(/timed out/i)
  })

  it('passes an unrecognised provider message through rather than inventing one', () => {
    // Never dress up a failure we do not understand as something friendlier.
    expect(describeTranscriptionFailure(new Error('quota exceeded for project'))).toBe('quota exceeded for project')
  })

  it('caps a runaway provider message', () => {
    expect(describeTranscriptionFailure(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(200)
  })
})
