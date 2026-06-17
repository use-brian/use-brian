/**
 * Audio preflight — transcribe the first audio attachment, if any.
 *
 * Semantics match OpenClaw `src/media-understanding/audio-preflight.ts:18-82`:
 *   - `enabled === false` → return undefined (kill switch).
 *   - Empty attachments → undefined.
 *   - Find first `!alreadyTranscribed` with `audio/*` mime. None → undefined.
 *   - Call transcribeAudio; on success flip `alreadyTranscribed` and return.
 *   - On any throw → log and return undefined. Never re-throw.
 *     (Matches audio-preflight.ts:75-81 — the silent-fail behavior is
 *     deliberate: a failed transcription should degrade to empty text,
 *     never block the whole message.)
 */
import { transcribeAudio, type TranscribeResult } from './transcribe.js'
import type { MediaAttachment } from './types.js'

export type PreflightOptions = {
  /** `env.VOICE_TRANSCRIPTION_ENABLED`. When false, preflight no-ops. */
  enabled: boolean
  apiKey: string
  model?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
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
        apiKey: options.apiKey,
        model: options.model,
        timeoutMs: options.timeoutMs,
        fetchFn: options.fetchFn,
      },
    )
    firstAudio.alreadyTranscribed = true
    return result
  } catch (err) {
    console.warn('[media/preflight] transcription failed:', err instanceof Error ? err.message : err)
    return undefined
  }
}
