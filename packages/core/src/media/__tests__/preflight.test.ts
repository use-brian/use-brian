import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MediaAttachment } from '../types.js'

vi.mock('../transcribe.js', () => ({
  transcribeAudio: vi.fn(),
}))

// Import after the mock so the preflight binds to the mocked export.
const { transcribeFirstAudio } = await import('../preflight.js')
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
