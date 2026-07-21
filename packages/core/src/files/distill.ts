/**
 * File distillation: a PDF or image's bytes → clean Markdown text, so a
 * non-text file can feed Pipeline B (which ingests text only).
 *
 * Runs on whichever adapter is configured, via the shared `media/backend.ts`
 * seam: Gemini `inlineData` (`generateContent`) over AI Studio or Vertex, or
 * Qwen-VL (`image_url`) over DashScope. PDFs ride Gemini's native inlineData
 * reader; DashScope is image-only and refuses PDFs (Qwen-VL cannot ingest them
 * inline — see `media/backend.ts`). There is deliberately no local text
 * extraction (docs/architecture/engine/file-handling.md → "PDFs are passed
 * natively").
 *
 * The module never reads env (per packages/core/CLAUDE.md) — the caller passes
 * either an AI Studio `apiKey` (back-compat) or an explicit adapter `backend`.
 * Returns token usage so the caller can attribute it as an `overhead:*` row in
 * `usage_tracking`.
 *
 * [COMP:files/distill]
 */

import type { TokenUsage } from '../providers/types.js'
import type { MediaBackend } from '../media/backend.js'
import { runMediaUnderstanding } from '../media/backend.js'
import { aiStudioTransport } from '../providers/google-transport.js'

export type DistillOptions = {
  /** AI Studio key. Equivalent to a `google` backend over `aiStudioTransport`. */
  apiKey?: string
  /** Explicit adapter backend; takes precedence over `apiKey`. */
  backend?: MediaBackend
  /** Gemini model id. Default: `gemini-2.5-flash` (ignored by DashScope, which picks Qwen-VL). */
  model?: string
  /** Instruction to the model. Default: a faithful full-content extraction directive. */
  prompt?: string
  /** Abort after N ms. Default: 60_000 (documents are larger than voice notes). */
  timeoutMs?: number
  /** Output token ceiling. Default: 8192. */
  maxOutputTokens?: number
  /** Injected for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch
}

export type DistillResult = {
  text: string
  usage: TokenUsage | null
  model: string
}

const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_PROMPT =
  'Extract the full textual content of the attached document as clean, faithful Markdown. ' +
  'Preserve headings, lists, and tables. Transcribe the real content verbatim — do NOT ' +
  'summarize, add commentary, or invent text. If the document is empty or unreadable, ' +
  'output an empty string and nothing else.'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_TOKENS = 8192

/**
 * Distill a binary document (PDF / image) to Markdown.
 * Unlike `transcribeAudio`, an empty result is NOT an error — a blank or
 * undecodable document legitimately yields no text, and the caller stores the
 * raw bytes regardless and simply skips decomposition.
 */
export async function distillFileToText(
  input: { buffer: Buffer; mime: string },
  options: DistillOptions,
): Promise<DistillResult> {
  const backend: MediaBackend =
    options.backend ?? { kind: 'google', transport: aiStudioTransport(options.apiKey) }

  return runMediaUnderstanding(backend, {
    buffer: input.buffer,
    mime: input.mime,
    prompt: options.prompt ?? DEFAULT_PROMPT,
    modality: 'document',
    model: options.model ?? DEFAULT_MODEL,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    errorLabel: 'file distillation',
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  })
}
