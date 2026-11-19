/** PDF budget and completion protocol only, without parsers/rendering. [COMP:files/pdf-distill] */
// ── Tuning constants (engine constants, never env — plan §2 decision 6) ──

/**
 * Render width per transport. Qwen-VL bills (w x h)/784, so a portrait A4 at
 * 1120px is ~2.1k tokens against ~4.2k at the old 1600px — half the input cost
 * for text that still OCRs cleanly (1120px ≈ 135 DPI on A4, adequate for 10pt).
 * GPT downscales to a 768px shortest side before tiling, so anything above
 * 1024px is pure upload waste there. Floor is 896 if quality ever regresses.
 */
export const DASHSCOPE_RENDER_WIDTH = 1120
export const PROVIDER_RENDER_WIDTH = 1024

/** Consecutive pages per vision call. See the output-ceiling reasoning above. */
export const DASHSCOPE_CHUNK_PAGES = 6
export const PROVIDER_CHUNK_PAGES = 12

/** Output budget granted per page in a chunk, capped by the model's own limit. */
export const CHUNK_OUTPUT_TOKENS_PER_PAGE = 1400

/** Chunks are independent; three in flight keeps a 40-page document ~3 waves. */
export const DEFAULT_DISTILL_CONCURRENCY = 3

/**
 * Absolute page guard. Above this the distillate is truncated with a note.
 * Well above the preflight threshold at which the user already confirmed the
 * cost (docs/architecture/engine/preflight-confirmation.md).
 */
export const MAX_DISTILL_PAGES = 150

export const DEFAULT_TIMEOUT_MS = 180_000

/**
 * Above this page count the user is asked before the document is distilled.
 *
 * Distilling is credit-incurring and long-running, so the preflight-confirmation
 * invariant applies (`docs/architecture/engine/preflight-confirmation.md`).
 * Below the threshold the worst case is a few cents and a few seconds, which
 * is not worth a dialog; above it the user should know the page count and the
 * cost before it is spent. A free-rated backend (a ChatGPT subscription) skips
 * the confirm entirely — there is nothing to confirm.
 */
export const PDF_CONFIRM_PAGE_THRESHOLD = 30

/**
 * Rough input+output token estimate for distilling `pages` pages, used ONLY to
 * quote a cost in the confirm. Deliberately arithmetic, not a probe: the
 * estimate must be cheaper than the thing it is estimating.
 */
export function estimateDistillTokens(pages: number, renderWidth: number): {
  inputTokens: number
  outputTokens: number
} {
  const bounded = Math.max(0, Math.min(pages, MAX_DISTILL_PAGES))
  // A4 portrait at `renderWidth`; Qwen-VL bills (w x h)/784 and GPT tiles to a
  // similar order. Output is the transcription itself, ~1k tokens per page.
  const perPageInput = Math.round((renderWidth * renderWidth * 1.294) / 784)
  return { inputTokens: bounded * perPageInput, outputTokens: bounded * 1_000 }
}

export function pdfPageCompletionMarker(pageNumber: number): string {
  return `[[PDF_PAGE_${pageNumber}_COMPLETE]]`
}

const PDF_PAGE_COMPLETION_LINE = /^\[\[PDF_PAGE_\d+_COMPLETE\]\]$/

function findExactLine(lines: readonly string[], value: string, from: number): number {
  for (let index = from; index < lines.length; index++) {
    if (lines[index]!.trim() === value) return index
  }
  return -1
}

export function missingPdfPageCompletionMarkers(
  text: string,
  pageNumbers: readonly number[],
): number[] {
  const lines = text.split(/\r?\n/)
  const missing: number[] = []
  let searchFrom = 0

  for (let index = 0; index < pageNumbers.length; index++) {
    const pageNumber = pageNumbers[index]!
    const headingIndex = findExactLine(lines, `## Page ${pageNumber}`, searchFrom)
    if (headingIndex === -1) {
      missing.push(pageNumber)
      continue
    }

    const markerIndex = findExactLine(
      lines,
      pdfPageCompletionMarker(pageNumber),
      headingIndex + 1,
    )
    const nextPageNumber = pageNumbers[index + 1]
    const nextHeadingIndex = nextPageNumber === undefined
      ? -1
      : findExactLine(lines, `## Page ${nextPageNumber}`, headingIndex + 1)
    const markerIsInPage = markerIndex !== -1 && (
      nextPageNumber === undefined
        ? lines.slice(markerIndex + 1).every((line) => line.trim() === '')
        : nextHeadingIndex !== -1 &&
          markerIndex < nextHeadingIndex &&
          lines.slice(markerIndex + 1, nextHeadingIndex).every((line) => line.trim() === '')
    )

    if (!markerIsInPage) {
      missing.push(pageNumber)
      searchFrom = headingIndex + 1
      continue
    }
    searchFrom = markerIndex + 1
  }

  return missing
}

export function stripPdfPageCompletionMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !PDF_PAGE_COMPLETION_LINE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

