/** Browser WebRTC credentials are short-lived and never expose the server key.
 * This adapter is intentionally transcription-only; answering uses the normal
 * scoped server-side model runtime. [COMP:recordings/live-interaction]
 */
import type { InteractionSource } from '@use-brian/shared'

export function createInteractionTranscriptionToken(
  apiKey: string,
  fetcher: typeof fetch = fetch,
) {
  return async (source: InteractionSource): Promise<{ value: string; expiresAt: number }> => {
    const response = await fetcher('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 60 },
        session: {
          type: 'transcription',
          audio: { input: {
            transcription: { model: 'gpt-4o-transcribe' },
            noise_reduction: source === 'microphone' ? { type: 'near_field' } : null,
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
          } },
        },
      }),
    })
    if (!response.ok) throw new Error(`Streaming transcription unavailable (${response.status})`)
    const body = await response.json() as { value?: unknown; expires_at?: unknown }
    if (typeof body.value !== 'string' || !body.value.startsWith('ek_') || typeof body.expires_at !== 'number') {
      throw new Error('Invalid streaming transcription credential')
    }
    return { value: body.value, expiresAt: body.expires_at }
  }
}
