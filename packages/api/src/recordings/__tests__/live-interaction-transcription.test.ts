import { describe, it, expect, vi } from 'vitest'
import { createInteractionTranscriptionToken } from '../live-interaction-transcription.js'

describe('[COMP:recordings/live-interaction] WebRTC credentials', () => {
  it('requests a short-lived transcription session with speech boundaries, never an answering session', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_test', expires_at: 123 })))
    const token = await createInteractionTranscriptionToken('server-secret', fetcher)('microphone')
    expect(token).toEqual({ value: 'ek_test', expiresAt: 123 })
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets')
    expect(request.headers).toMatchObject({ Authorization: 'Bearer server-secret' })
    expect(JSON.parse(request.body as string)).toEqual({
      expires_after: { anchor: 'created_at', seconds: 60 },
      session: { type: 'transcription', audio: { input: {
        transcription: { model: 'gpt-4o-transcribe' }, noise_reduction: { type: 'near_field' },
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
      } } },
    })
    expect(JSON.stringify(token)).not.toContain('server-secret')
  })
  it('does not denoise system playback as a near-field microphone', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_test', expires_at: 123 })))
    await createInteractionTranscriptionToken('secret', fetcher)('system')
    const request = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(request.body as string).session.audio.input.noise_reduction).toBeNull()
  })
  it('rejects provider errors and malformed credentials without leaking their body', async () => {
    await expect(createInteractionTranscriptionToken('secret', async () => new Response('private provider text', { status: 429 }))('microphone')).rejects.toThrow('Streaming transcription unavailable (429)')
    await expect(createInteractionTranscriptionToken('secret', async () => new Response('{}'))('microphone')).rejects.toThrow('Invalid streaming transcription credential')
  })
})
