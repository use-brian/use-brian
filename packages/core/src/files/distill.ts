/**
 * File distillation: a PDF or image's bytes → clean Markdown text, so a
 * non-text file can feed Pipeline B (which ingests text only).
 *
 * Runs on whichever adapter is configured, via the shared `media/backend.ts`
 * seam: Gemini `inlineData` (`generateContent`) over AI Studio or Vertex,
 * Qwen-VL / `qwen-long` over DashScope, or the deployment's own chat model.
 * A PDF takes one of two validated paths — Gemini's native inlineData reader
 * with per-page completion markers, or full-page image distillation
 * (`files/pdf-distill.ts`). Images use Qwen-VL inline; non-PDF office
 * documents keep the `qwen-long` file-upload flow.
 *
 * PDFs additionally have a local text-layer fallback (`extractPdfText`, via
 * unpdf): when the configured adapter cannot distill the document — e.g. a
 * DashScope endpoint whose vision model 404s — the text layer is extracted
 * locally instead of failing. It is a last resort, not a cheaper first try:
 * a scan has no text layer at all, which is exactly the case full-page
 * distillation exists to read. It runs only when the adapter errored or
 * returned empty text for a PDF, and when it ALSO fails the original
 * distillation error is what surfaces (a pdf.js parse exception from the
 * fallback would name the wrong problem).
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
import { extractPdfText } from './pdf-text.js'

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
  usageByModel?: Array<{ model: string; usage: TokenUsage }>
  pageCount?: number
  truncated?: boolean
  failedPages?: number[]
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
  const isPdf = input.mime === 'application/pdf'
  let distillFailure: unknown

  try {
    const result = await runMediaUnderstanding(backend, {
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
    // Native distillation produced text, or this is a non-PDF (images have no
    // local fallback) — done. An empty PDF result falls through to the text
    // layer below in case the adapter silently declined it.
    if (result.text.trim() || !isPdf) {
      return {
        ...result,
        ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
        ...(result.documentTruncated !== undefined
          ? { truncated: result.documentTruncated }
          : {}),
        ...(result.failedPages !== undefined ? { failedPages: result.failedPages } : {}),
      }
    }
  } catch (err) {
    // The adapter couldn't distill this document. Only PDFs have a local
    // fallback; anything else is a real failure the caller must see.
    if (!isPdf) throw err
    distillFailure = err
  }

  // Local text-layer fallback for PDFs (unpdf) — no adapter, no model call.
  let text: string
  try {
    text = await extractPdfText(input.buffer)
  } catch (fallbackErr) {
    // Both paths are gone. Surface the DISTILLATION error, not the fallback's:
    // a corrupt-PDF exception out of pdf.js names the last thing tried, while
    // the adapter failure is what the operator has to act on. With no
    // distillation error to report (an empty native result), the parse
    // failure is the real answer.
    throw distillFailure ?? fallbackErr
  }
  // A scan normally has no text layer. If visual distillation failed, an
  // empty local extraction is not a successful fallback: preserve the visual
  // marker/timeout/provider error so the caller can explain the real failure
  // instead of collapsing it to "no readable text".
  if (!text.trim() && distillFailure) throw distillFailure
  return { text, usage: null, model: 'local-pdf-text' }
}
