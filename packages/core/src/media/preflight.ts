/**
 * Audio preflight — transcribe the first audio attachment, if any.
 *
 * Semantics:
 *   - Empty attachments → undefined.
 *   - Find first `!alreadyTranscribed` with `audio/*` mime. None → undefined.
 *   - `enabled === false` → report `TRANSCRIPTION_DISABLED_REASON` through
 *     `onFailure` and return undefined (kill switch). The check runs AFTER the
 *     audio lookup on purpose: "we had audio and did not transcribe it" is the
 *     reportable event, while a text-only turn must stay silent.
 *   - Call transcribeAudio; on success flip `alreadyTranscribed` and return.
 *   - On any throw → log, report via `onFailure`, return undefined. Never
 *     re-throw. (The silent-fail behavior is deliberate: a failed
 *     transcription should degrade to empty text, never block the whole
 *     message.)
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
 * The reason reported when the ops kill switch is off. One spelling, so the
 * web chat notice and every channel turn name the same env var.
 */
export const TRANSCRIPTION_DISABLED_REASON =
  'voice transcription is disabled on this deployment (VOICE_TRANSCRIPTION_ENABLED)'

/**
 * The text a turn carries in place of a transcript that never arrived.
 *
 * Every surface that receives audio must emit this when transcription yields
 * nothing, because the alternative is not "the model says less" — it is the
 * model confabulating. A turn whose voice note was dropped arrives with empty
 * text and no attachment, which reads to the model as *the user sent nothing*,
 * so it answers "I don't see a recording attachment" and asks for a re-upload
 * that will fail identically (2026-07-28, Telegram, OSS deployment booted with
 * the kill switch off). Naming the failure is what stops the loop.
 *
 * Wrap it as the surface requires (chat nests it in `<attached_file>`; a
 * channel route assigns it straight to `incoming.text`).
 */
export function voiceUnavailableNote(reason?: string): string {
  return (
    `[voice note received - transcription unavailable${reason ? `: ${reason}` : ''}. ` +
    'Tell the user this plainly and ask them to type it or resend. Do NOT claim ' +
    'the audio is still processing, that you will retry, or that they sent no attachment.]'
  )
}

/**
 * The text a channel turn carries for an inbound voice note: the transcript
 * when there is one, the unavailable note when there is not, with the caption
 * (if any) preserved after it.
 *
 * Shared so the "no transcript" branch cannot be forgotten at one call site —
 * forgetting it is the whole bug this exists to prevent, and it is invisible
 * locally because the route still returns 200 and the model still replies.
 */
export function composeVoiceTurnText(
  transcript: string | undefined,
  reason: string | undefined,
  caption?: string,
): string {
  const head = transcript?.trim() ? `[voice] ${transcript}` : voiceUnavailableNote(reason)
  return caption?.trim() ? `${head}\n\n${caption}` : head
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
  if (!attachments.length) return undefined

  const firstAudio = attachments.find(
    (att) => att.mime.startsWith('audio/') && !att.alreadyTranscribed,
  )
  if (!firstAudio) return undefined

  // Kill switch. Checked here, below the lookup, so the caller learns that
  // audio was dropped and why — silence is what makes the model confabulate.
  if (!options.enabled) {
    options.onFailure?.(TRANSCRIPTION_DISABLED_REASON)
    return undefined
  }

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
