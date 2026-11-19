/**
 * Local PDF text-layer extraction — the fallback for when a configured adapter
 * cannot distill a document natively (notably a DashScope endpoint whose Model
 * Studio catalog has no `qwen-long` file-extract model). Pure-JS via `unpdf`
 * (a serverless pdf.js build) — no system binary, no model call.
 *
 * Text-layer ONLY: a scanned or image-only PDF carries no extractable text and
 * yields an empty string. The caller treats empty as "no text" (same contract
 * as `distillFileToText`) rather than an error.
 *
 * [COMP:files/pdf-text]
 */

import { lazyImplementation } from '@use-brian/agent-runtime/tools/lazy-implementation.js'

// The pdf.js text extractor loads on the first PDF, not at import (M4 step 5, D13).
const loadUnpdf = lazyImplementation('The PDF text extractor (unpdf)', () => import('unpdf'))

/** Extract the concatenated text layer of a PDF as a single string ('' if none). */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { extractText } = await loadUnpdf()
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: true })
  return text.trim()
}
