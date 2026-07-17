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
}
