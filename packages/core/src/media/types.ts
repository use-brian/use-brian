/**
 * Media attachment shape for the voice-transcription preflight.
 *
 * Simplified from OpenClaw `src/media-understanding/types.ts:10-16`:
 *   - `buffer` is always present (every channel produces one by preflight time)
 *   - no `path` / `url` — we don't read from disk or fetch remote in core
 *   - no provider registry fields — sidanclaw has one provider
 *
 * See docs/architecture/media/transcription.md.
 */
export type MediaAttachment = {
  buffer: Buffer
  mime: string
  index: number
  alreadyTranscribed?: boolean
}
