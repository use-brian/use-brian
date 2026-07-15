/**
 * Recording-transcriber seam (cantonese-transcription-refactor Phase 1).
 *
 * One contract in front of every long-recording transcription provider so the
 * ingest orchestration stays provider-blind. Providers are pure fetch modules
 * following the core rules (injectable `fetchFn`, no SDK, no env reads):
 * `scribe.ts` (ElevenLabs Scribe), `qwen-filetrans.ts` (DashScope file
 * transcription), and the legacy Gemini File-API path
 * (`transcribe-recording.ts`) wrapped by `geminiTranscriber`.
 *
 * The one invariant a provider may NOT weaken: `truncated` must derive from
 * real timestamps vs the ffprobe `durationMs` (the coverage contract), because
 * billing charges only on full coverage.
 *
 * Spec: docs/architecture/media/transcription.md §"Long recordings" (b).
 */

import {
  transcribeRecording,
  transcribeRecordingChunks,
  type RecordingAudioChunk,
  type RecordingTranscriptionResult,
  type TranscribeRecordingOptions,
} from './transcribe-recording.js'

export type RecordingTranscribeRequest = {
  /** The extracted small audio track (16 kHz mono AAC from the worker). */
  buffer: Buffer
  mime: string
  /** ffprobe truth — drives the coverage contract. */
  durationMs: number
  /** Signed READ url of the ORIGINAL stored object, for URL-submit providers. */
  sourceUrl?: string
  /** Workspace entity names to bias recognition toward (proper nouns). */
  keyterms?: string[]
  /**
   * Lazy silence-split chunks of the audio (the worker binds the ffmpeg
   * implementation — core never execs). Only the gemini provider consumes
   * this, and only past its chunking threshold; providers with server-side
   * VAD (scribe/qwen) ignore it, so the split runs at most once and only
   * when actually needed.
   */
  getChunks?: () => Promise<RecordingAudioChunk[]>
  displayName?: string
}

export type RecordingTranscriber = {
  /** Usage-row model string, e.g. 'elevenlabs:scribe_v2'. */
  name: string
  transcribe(req: RecordingTranscribeRequest): Promise<RecordingTranscriptionResult>
}

/**
 * Coverage check shared by providers: the transcript reaches the audio end
 * when the last utterance ends within `toleranceMs` of `durationMs`. An empty
 * transcript never counts as covered.
 */
export function coverageTruncated(
  utterances: Array<{ endMs: number }>,
  durationMs: number,
  toleranceMs = 60_000,
): boolean {
  if (utterances.length === 0) return true
  return utterances[utterances.length - 1].endMs < durationMs - toleranceMs
}

/**
 * Try providers in order. A throw logs and falls through to the next; when
 * every provider throws, the LAST error is rethrown (the recording job fails
 * with the existing semantics).
 */
export function withTranscriberFallback(
  primary: RecordingTranscriber,
  ...rest: RecordingTranscriber[]
): RecordingTranscriber {
  const chain = [primary, ...rest]
  return {
    name: chain.map((p) => p.name).join('→'),
    async transcribe(req) {
      let lastErr: unknown
      // Reported on the result so the CALLER (which holds recording/user
      // context) can surface the downgrade — a fall-through here is invisible
      // in analytics otherwise, and a config error (e.g. an under-scoped key
      // 401-ing) silently reroutes every recording to the fallback provider.
      const fallthroughs: Array<{ provider: string; message: string }> = []
      for (const provider of chain) {
        try {
          const result = await provider.transcribe(req)
          return fallthroughs.length > 0 ? { ...result, fallthroughs } : result
        } catch (err) {
          lastErr = err
          fallthroughs.push({
            provider: provider.name,
            message: err instanceof Error ? err.message : String(err),
          })
          console.warn(
            `[recording-transcriber] ${provider.name} failed, falling through:`,
            err instanceof Error ? err.message : err,
          )
        }
      }
      throw lastErr
    },
  }
}

/** Above this, gemini transcribes silence-split chunks independently instead
 *  of one whole-file pass — the drift/hallucination fix (transcription.md
 *  §Providers, gemini row). Short files single-shot in one window anyway. */
export const GEMINI_CHUNKED_MIN_DURATION_MS = 12 * 60_000

/** The Gemini File-API transcription behind the seam (OSS default). Long
 *  audio uses chunked mode when the caller supplied `getChunks`; a chunk-split
 *  failure degrades to the whole-file path rather than failing the job. */
export function geminiTranscriber(opts: {
  apiKey: string
  model?: string
  fetchFn?: typeof fetch
  /** Per-window progress hook, forwarded to the File-API path (observability —
   *  the worker logs it). Set at construction from boot infra, not per request. */
  onWindow?: TranscribeRecordingOptions['onWindow']
}): RecordingTranscriber {
  const common = (req: RecordingTranscribeRequest) => ({
    apiKey: opts.apiKey,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.onWindow ? { onWindow: opts.onWindow } : {}),
    ...(req.displayName ? { displayName: req.displayName } : {}),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  })
  return {
    name: opts.model ?? 'gemini-2.5-flash',
    async transcribe(req) {
      if (req.getChunks && req.durationMs > GEMINI_CHUNKED_MIN_DURATION_MS) {
        try {
          const chunks = await req.getChunks()
          if (chunks.length > 0) {
            return await transcribeRecordingChunks(
              { ...common(req), buffer: req.buffer, mime: req.mime, durationMs: req.durationMs },
              chunks,
            )
          }
        } catch (err) {
          console.warn(
            '[recording-transcriber] chunk split failed, degrading to whole-file gemini:',
            err instanceof Error ? err.message : err,
          )
        }
      }
      return transcribeRecording({
        ...common(req),
        buffer: req.buffer,
        mime: req.mime,
        durationMs: req.durationMs,
      })
    },
  }
}
