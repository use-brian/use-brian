/**
 * Audio transcription: buffer + mime → transcript + usage.
 *
 * Runs on whichever adapter is configured, via the shared `media/backend.ts`
 * seam: Gemini `generateContent` with an inline audio part over AI Studio or
 * Vertex, or Qwen-ASR (`input_audio`) over DashScope.
 *
 * The module never reads env directly (per packages/core/CLAUDE.md) — the
 * caller passes either an AI Studio `apiKey` (back-compat) or an explicit
 * adapter `backend`.
 *
 * Returns token usage so the caller can attribute it as an `overhead:*` row
 * in `usage_tracking`.
 */

import type { TokenUsage } from '../providers/types.js'
import type { MediaBackend } from './backend.js'
import { runMediaUnderstanding } from './backend.js'
import { aiStudioTransport } from '../providers/google-transport.js'

export type TranscribeOptions = {
  /** AI Studio key. Equivalent to a `google` backend over `aiStudioTransport`. */
  apiKey?: string
  /** Explicit adapter backend; takes precedence over `apiKey`. */
  backend?: MediaBackend
  /** Gemini model id. Default: `gemini-2.5-flash` (ignored by DashScope, which picks Qwen-ASR). */
  model?: string
  /** Instruction to the model. Default: a terse verbatim-transcript directive. */
  prompt?: string
  /** Abort after N ms. Default: 30_000. */
  timeoutMs?: number
  /** Injected for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch
}

export type TranscribeResult = {
  text: string
  usage: TokenUsage | null
  model: string
}

const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_PROMPT =
  'Transcribe the attached audio verbatim. Output ONLY the transcript text — no commentary, no timestamps, no speaker labels. If the audio is silent or unintelligible, output an empty string.'
const DEFAULT_TIMEOUT_MS = 30_000

export async function transcribeAudio(
  input: { buffer: Buffer; mime: string },
  options: TranscribeOptions,
): Promise<TranscribeResult> {
  const backend: MediaBackend =
    options.backend ?? { kind: 'google', transport: aiStudioTransport(options.apiKey) }

  const result = await runMediaUnderstanding(backend, {
    buffer: input.buffer,
    mime: input.mime,
    prompt: options.prompt ?? DEFAULT_PROMPT,
    modality: 'audio',
    model: options.model ?? DEFAULT_MODEL,
    maxOutputTokens: 2048,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    errorLabel: 'transcription',
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  })

  // Unlike distillation, an empty transcript IS an error here: the caller
  // stores `[voice] <transcript>` and a blank one is indistinguishable from a
  // silently broken pipeline.
  if (!result.text) {
    throw new Error('Transcription response missing text')
  }
  return { text: result.text, usage: result.usage, model: result.model }
}
