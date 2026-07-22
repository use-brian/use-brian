/**
 * Media attachment shape for the voice-transcription preflight.
 *
 *   - `buffer` is always present (every channel produces one by preflight time)
 *   - no `path` / `url` — we don't read from disk or fetch remote in core
 *   - no provider registry fields — Use Brian has one provider
 *
 * See docs/architecture/media/transcription.md.
 */
export type MediaAttachment = {
  buffer: Buffer
  mime: string
  index: number
  alreadyTranscribed?: boolean
  /**
   * Audio duration in seconds when the channel's payload carried it (Telegram
   * voice notes do; a raw web upload does not). Threaded to
   * `TranscribeResult.audioSeconds` → `usage_tracking.audio_seconds`, which is
   * the denominator that makes this token-billed path comparable to a
   * flat-rate-per-audio-hour provider. Never inferred from the buffer —
   * unknown stays unknown and is recorded as NULL, never 0.
   */
  durationSeconds?: number
}
