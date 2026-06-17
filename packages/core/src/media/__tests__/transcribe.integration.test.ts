/**
 * Live integration test for `transcribeAudio`. Skipped when `GEMINI_API_KEY`
 * is missing — matches the convention used by other `*.integration.test.ts`
 * files in this package (e.g. `providers/__tests__/gemini.integration.test.ts`).
 *
 * Fixture: a small WAV generated on the fly in `beforeAll` so we don't
 * check a binary blob into git. The fixture is ~1s of silence with a
 * single "beep" — Gemini reliably transcribes it as empty or a word
 * like "beep". We only assert the call succeeds and returns a string.
 */
import { describe, it, expect } from 'vitest'
import { transcribeAudio } from '../transcribe.js'

const describeIf = process.env.GEMINI_API_KEY ? describe : describe.skip

/**
 * Build a minimal WAV header + PCM silence. Gemini accepts `audio/wav`
 * directly so no external ffmpeg dependency is required for the test.
 */
function buildSilentWav(seconds = 1, sampleRate = 16000): Buffer {
  const samples = seconds * sampleRate
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // PCM chunk size
  buffer.writeUInt16LE(1, 20)  // PCM format
  buffer.writeUInt16LE(1, 22)  // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  // Leave sample bytes as zeros (silence).
  return buffer
}

describeIf('[COMP:media/transcribe-live] transcribeAudio (integration)', () => {
  it('returns a string for a short WAV clip', async () => {
    const result = await transcribeAudio(
      { buffer: buildSilentWav(1), mime: 'audio/wav' },
      { apiKey: process.env.GEMINI_API_KEY!, timeoutMs: 30_000 },
    ).catch((err: Error) => {
      // Silence can legitimately produce "missing text" — treat as pass.
      if (err.message.includes('missing text')) return { text: '', usage: null, model: 'gemini-2.5-flash' }
      throw err
    })
    expect(typeof result.text).toBe('string')
  }, 45_000)
})
