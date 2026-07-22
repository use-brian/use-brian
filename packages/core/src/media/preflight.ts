/**
 * Audio preflight — transcribe the first audio attachment, if any.
 *
 * Semantics:
 *   - `enabled === false` → return undefined (kill switch).
 *   - Empty attachments → undefined.
 *   - Find first `!alreadyTranscribed` with `audio/*` mime. None → undefined.
 *   - Call transcribeAudio; on success flip `alreadyTranscribed` and return.
 *   - On any throw → log and return undefined. Never re-throw.
 *     (The silent-fail behavior is deliberate: a failed transcription should
 *     degrade to empty text, never block the whole message.)
 */
import type { MediaBackend } from './backend.js'
import { transcribeAudio, type TranscribeResult } from './transcribe.js'
import type { MediaAttachment } from './types.js'

export type PreflightOptions = {
  /** `env.VOICE_TRANSCRIPTION_ENABLED`. When false, preflight no-ops. */
  enabled: boolean
  apiKey: string
  /** Adapter backend; when set, takes precedence over `apiKey`. */
  backend?: MediaBackend
  model?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
  /**
   * Called with a short, user-facing reason when transcription fails.
   *
   * The failure is still swallowed (a bad voice note must not fail the turn),
   * but silence alone is what made the model confabulate: given only
   * "[voice note — transcription unavailable]" it invented status claims
   * ("the transcription isn't available yet, let me check the recording
   * status") and narrated tool calls at the user. Handing the caller a reason
   * lets the turn state what actually happened.
   */
  onFailure?: (reason: string) => void
}

/**
 * Map a provider error to a short, actionable reason. Recognised cases get
 * guidance; anything else passes the provider's own message through rather
 * than inventing a friendlier lie about a failure we don't understand.
 */
export function describeTranscriptionFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // The inline ASR lane is duration-capped; long audio belongs to the
  // recordings pipeline (async file-transcription), not the voice-note path.
  if (/too long/i.test(raw)) {
    return 'the audio is too long for an inline voice note. Upload it as a recording for long-form transcription'
  }
  if (/unsupported|invalid.*(format|parameter)|does not support/i.test(raw)) {
    return 'this audio format was rejected by the transcription provider'
  }
  if (/timeout|abort/i.test(raw)) return 'transcription timed out'
  return raw.slice(0, 200)
}

/**
 * Returns the transcription result (`text` + `usage` + `model`) so the caller
 * can attribute the Gemini call as `overhead:transcription`. Returns
 * `undefined` when preflight is disabled, no audio is present, or the call
 * failed (which is swallowed to degrade gracefully — see audio-preflight.ts
 * reference).
 */
export async function transcribeFirstAudio(
  attachments: MediaAttachment[],
  options: PreflightOptions,
): Promise<TranscribeResult | undefined> {
  if (!options.enabled) return undefined
  if (!attachments.length) return undefined

  const firstAudio = attachments.find(
    (att) => att.mime.startsWith('audio/') && !att.alreadyTranscribed,
  )
  if (!firstAudio) return undefined

  try {
    const result = await transcribeAudio(
      { buffer: firstAudio.buffer, mime: firstAudio.mime },
      {
        ...(options.backend ? { backend: options.backend } : { apiKey: options.apiKey }),
        model: options.model,
        timeoutMs: options.timeoutMs,
        fetchFn: options.fetchFn,
      },
    )
    firstAudio.alreadyTranscribed = true
    // The transcriber posts bytes and never learns the duration, so the
    // caller's value is the only source. Spread conditionally: an absent
    // duration must stay absent so it records as NULL (unknown rate) rather
    // than 0 (free transcription of zero-length audio).
    return firstAudio.durationSeconds !== undefined
      ? { ...result, audioSeconds: firstAudio.durationSeconds }
      : result
  } catch (err) {
    console.warn('[media/preflight] transcription failed:', err instanceof Error ? err.message : err)
    options.onFailure?.(describeTranscriptionFailure(err))
    return undefined
  }
}
