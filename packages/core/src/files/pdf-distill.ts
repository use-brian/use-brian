/**
 * Full-page PDF distillation — every page rendered to an image and read by a
 * vision model, producing one faithful Markdown document.
 *
 * ## Why every page, and why images
 *
 * A PDF's meaning lives in its layout as often as its text: bank statements,
 * receipts, scanned contracts, slide exports, anything with a table. A text
 * layer misses all of it, and a scan has no text layer at all. So there is no
 * text-layer shortcut here, no page sampling, and no length-based downgrade —
 * ALL pages render, and the vision model transcribes text verbatim plus
 * describes figures inline. (`pdf-text.ts` stays the last-resort fallback for
 * when rendering or every vision call fails; it is not a cheaper first try.)
 *
 * ## Why chunks instead of one call per page
 *
 * The bound is the model's OUTPUT ceiling, not its input window. Dense text
 * transcribes at roughly 0.6-1.2k tokens per page, so six pages fit under an
 * 8,192-token cap with headroom while the input side (6 x ~2.1k) sits
 * comfortably inside a 32k window. Batching amortizes the prompt overhead
 * ~6x against the page-per-call loop this replaced, and lets a table spanning
 * a page break transcribe coherently.
 *
 * Every page must return an exact completion marker. A batch missing even one
 * marker is recursively split until each incomplete page is retried alone;
 * an incomplete single page gets one final retry. Provider stop reasons are
 * advisory because not every transport reports output truncation faithfully.
 *
 * ## Honesty
 *
 * Chunks are independent (no conversation carry), so they fan out with bounded
 * concurrency and the stitcher reassembles them in page order. A failed chunk,
 * a failed re-split half, or a page-count truncation each append an explicit
 * note to the output. Nothing is ever silently missing: a model reading the
 * distillate must be able to tell what it did not receive.
 *
 * Spec: docs/architecture/engine/file-handling.md
 * Plan: docs/plans/pdf-universal-read.md §3, §4.2
 *
 * [COMP:files/pdf-distill]
 */

import type { TokenUsage } from '../providers/types.js'
import { renderPdfPages, type RenderPdfPagesResult } from './pdf-pages.js'

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
const DEFAULT_DISTILL_CONCURRENCY = 3

/**
 * Absolute page guard. Above this the distillate is truncated with a note.
 * Well above the preflight threshold at which the user already confirmed the
 * cost (docs/architecture/engine/preflight-confirmation.md).
 */
export const MAX_DISTILL_PAGES = 150

const DEFAULT_TIMEOUT_MS = 180_000

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

const PDF_DISTILL_PROMPT =
  'Transcribe these rendered PDF pages into faithful Markdown.\n' +
  '- Transcribe all text verbatim. Do NOT summarize, paraphrase, or invent content.\n' +
  '- Preserve headings, lists, and tables (Markdown tables; keep every row).\n' +
  '- Describe figures, charts, diagrams, photos, stamps, signatures, and handwriting ' +
  'inline where they appear, as `[Figure: ...]`, including any numbers or labels they carry.\n' +
  '- Start each page with a `## Page N` heading using the page numbers given below.\n' +
  '- If a page is blank, write its heading followed by `(blank page)`.\n' +
  '- After each COMPLETE page, append its exact supplied `[[PDF_PAGE_N_COMPLETE]]` plain-text marker on its own line.\n' +
  '- Never emit a marker until that whole page has been transcribed.\n' +
  'Output only the Markdown transcription and completion markers.'

/**
 * The engine version participates in the distillate cache key: a change to the
 * prompt, the chunking, or the stitching produces different output from the
 * same bytes, so it must not read a cache entry written by the old engine.
 * Bump this whenever any of those change.
 */
const PDF_DISTILL_ENGINE_VERSION = 3

// ── Seams ──────────────────────────────────────────────────────

export type VisionPage = {
  pageNumber: number
  buffer: Buffer
  mime: string
}

type VisionCallerRequest = {
  images: VisionPage[]
  prompt: string
  maxOutputTokens: number
  timeoutMs: number
  signal?: AbortSignal
}

type VisionCallerResult = {
  text: string
  usage: TokenUsage | null
  model: string
  /**
   * The call stopped because it hit the output ceiling (`finish_reason:
   * length` or equivalent), so the transcription is cut mid-document. Drives
   * the adaptive re-split. A caller that cannot tell should leave it unset —
   * the engine then trusts the text as complete.
   */
  truncated?: boolean
}

/**
 * One vision call over a batch of page images. The transport is the seam's
 * whole point: DashScope (`image_url` data URIs), Google (`inlineData`), and
 * the deployment's own chat provider (any adapter that accepts `image` blocks)
 * all satisfy it, so a Codex-only box distills through GPT with no extra key.
 */
export type VisionCaller = (request: VisionCallerRequest) => Promise<VisionCallerResult>

export type DistillPdfOptions = {
  visionCaller: VisionCaller
  renderWidth?: number
  chunkPages?: number
  maxPages?: number
  concurrency?: number
  /** Per-page output allowance; the chunk ceiling is this times its page count. */
  outputTokensPerPage?: number
  /** Hard ceiling for one chunk's output, e.g. the model's `maxOutput`. */
  maxOutputTokensPerChunk?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Injected for tests; defaults to the real `renderPdfPages`. */
  renderPages?: (
    buffer: Buffer,
    options: { maxPages?: number; width?: number },
  ) => Promise<RenderPdfPagesResult>
}

export type DistillPdfResult = {
  text: string
  usage: TokenUsage | null
  usageByModel: Array<{ model: string; usage: TokenUsage }>
  model: string
  pagesRendered: number
  totalPages: number
  /** Pages existed beyond `maxPages` and were not read. */
  truncated: boolean
  /** Pages no vision call could transcribe. Reflected in the output notes too. */
  failedPages: number[]
}

// ── Chunking ───────────────────────────────────────────────────

export type PageChunk = { pages: VisionPage[] }

/** Group rendered pages into consecutive batches of at most `chunkPages`. */
export function chunkPagesForVision(pages: VisionPage[], chunkPages: number): PageChunk[] {
  const size = Math.max(1, Math.floor(chunkPages))
  const chunks: PageChunk[] = []
  for (let i = 0; i < pages.length; i += size) {
    chunks.push({ pages: pages.slice(i, i + size) })
  }
  return chunks
}

/** Output ceiling for one chunk: per-page budget, clamped to the model's cap. */
export function chunkOutputCeiling(
  pageCount: number,
  perPage: number,
  modelMax: number | undefined,
): number {
  const wanted = Math.max(1, pageCount) * Math.max(1, Math.floor(perPage))
  return modelMax && modelMax > 0 ? Math.min(wanted, modelMax) : wanted
}

function pageRangeLabel(pages: VisionPage[]): string {
  const first = pages[0]!.pageNumber
  const last = pages[pages.length - 1]!.pageNumber
  return first === last ? `page ${first}` : `pages ${first}-${last}`
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

function chunkPrompt(pages: VisionPage[], totalPages: number): string {
  const numbers = pages.map((p) => p.pageNumber).join(', ')
  return (
    `${PDF_DISTILL_PROMPT}\n\n` +
    `These images are ${pageRangeLabel(pages)} of a ${totalPages}-page document, in order. ` +
    `Use exactly these page numbers in the headings: ${numbers}.\n` +
    `Required completion markers: ${pages.map((page) => pdfPageCompletionMarker(page.pageNumber)).join(' ')}`
  )
}

// ── Usage arithmetic ───────────────────────────────────────────

function addUsage(left: TokenUsage | null, right: TokenUsage | null): TokenUsage | null {
  if (!left) return right
  if (!right) return left
  const cacheReadTokens = (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0)
  const cacheWriteTokens = (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0)
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  }
}

// ── Bounded fan-out ────────────────────────────────────────────

/**
 * Run `worker` over every item with at most `limit` in flight, preserving
 * input order in the result. Rejections are NOT swallowed here — the caller
 * decides what a failed chunk means (this engine turns it into a note).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
  return results
}

// ── The engine ─────────────────────────────────────────────────

type ChunkOutcome = {
  pages: VisionPage[]
  text: string
  usage: TokenUsage | null
  model: string | null
  /** Pages this chunk could not transcribe (whole chunk or a re-split half). */
  failedPages: number[]
  failureReason?: string
}

async function transcribeChunk(
  chunk: PageChunk,
  totalPages: number,
  options: DistillPdfOptions,
  singlePageRetriesRemaining: number,
): Promise<ChunkOutcome> {
  const perPage = options.outputTokensPerPage ?? CHUNK_OUTPUT_TOKENS_PER_PAGE
  const ceiling = chunkOutputCeiling(chunk.pages.length, perPage, options.maxOutputTokensPerChunk)

  let result: VisionCallerResult
  try {
    result = await options.visionCaller({
      images: chunk.pages,
      prompt: chunkPrompt(chunk.pages, totalPages),
      maxOutputTokens: ceiling,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (chunk.pages.length >= 2) {
      return splitAndRetry(chunk, totalPages, options, reason)
    }
    if (singlePageRetriesRemaining > 0) {
      return transcribeChunk(chunk, totalPages, options, singlePageRetriesRemaining - 1)
    }
    return {
      pages: chunk.pages,
      text: '',
      usage: null,
      model: null,
      failedPages: chunk.pages.map((p) => p.pageNumber),
      failureReason: reason,
    }
  }

  const missingPages = missingPdfPageCompletionMarkers(
    result.text,
    chunk.pages.map((page) => page.pageNumber),
  )
  if (missingPages.length > 0 && chunk.pages.length >= 2) {
    const reason = result.truncated
      ? 'output ceiling reached before every page completed'
      : `completion marker missing for page${missingPages.length === 1 ? '' : 's'} ${missingPages.join(', ')}`
    return splitAndRetry(chunk, totalPages, options, reason, result.usage, result.model)
  }
  if (missingPages.length > 0 && singlePageRetriesRemaining > 0) {
    const retried = await transcribeChunk(
      chunk,
      totalPages,
      options,
      singlePageRetriesRemaining - 1,
    )
    return {
      ...retried,
      usage: addUsage(result.usage, retried.usage),
      model: result.model ?? retried.model,
    }
  }
  if (missingPages.length > 0) {
    return {
      pages: chunk.pages,
      // The response is structurally incomplete. Discard it instead of
      // handing a cut-off page to the model beside a warning note.
      text: '',
      usage: result.usage,
      model: result.model,
      failedPages: missingPages,
      failureReason: result.truncated
        ? 'output ceiling reached before the page completion marker'
        : 'provider returned a nominally complete turn without the page completion marker',
    }
  }

  return {
    pages: chunk.pages,
    text: result.text.trim(),
    usage: result.usage,
    model: result.model,
    failedPages: [],
  }
}

async function splitAndRetry(
  chunk: PageChunk,
  totalPages: number,
  options: DistillPdfOptions,
  reason: string,
  priorUsage?: TokenUsage | null,
  priorModel?: string | null,
): Promise<ChunkOutcome> {
  const mid = Math.ceil(chunk.pages.length / 2)
  const halves: PageChunk[] = [
    { pages: chunk.pages.slice(0, mid) },
    { pages: chunk.pages.slice(mid) },
  ]
  // Recursion is bounded by page count: each multi-page batch is halved, and
  // each single page is attempted at most twice.
  const outcomes = await mapWithConcurrency(halves, 2, (half) =>
    transcribeChunk(half, totalPages, options, 1),
  )
  const merged: ChunkOutcome = {
    pages: chunk.pages,
    text: outcomes.map((o) => o.text).filter(Boolean).join('\n\n'),
    usage: outcomes.reduce<TokenUsage | null>(
      (acc, o) => addUsage(acc, o.usage),
      priorUsage ?? null,
    ),
    model: priorModel ?? outcomes.find((o) => o.model)?.model ?? null,
    failedPages: outcomes.flatMap((o) => o.failedPages),
  }
  if (merged.failedPages.length > 0) merged.failureReason = reason
  return merged
}

/** Reassemble chunk outputs in page order, with explicit notes for what is missing. */
function stitchChunks(
  outcomes: readonly ChunkOutcome[],
  render: { totalPages: number; pagesRendered: number; truncated: boolean },
): string {
  const ordered = [...outcomes].sort(
    (a, b) => (a.pages[0]?.pageNumber ?? 0) - (b.pages[0]?.pageNumber ?? 0),
  )
  const sections = ordered
    .map((o) => stripPdfPageCompletionMarkers(o.text))
    .filter((t) => t.length > 0)

  const failed = ordered.flatMap((o) => o.failedPages).sort((a, b) => a - b)
  if (failed.length > 0) {
    sections.push(
      `> Page${failed.length === 1 ? '' : 's'} ${failed.join(', ')} could not be read ` +
      `(${ordered.find((o) => o.failedPages.length > 0)?.failureReason ?? 'vision call failed'}). ` +
      `Their content is missing from this transcription.`,
    )
  }
  if (render.truncated) {
    sections.push(
      `> This document has ${render.totalPages} pages; only the first ${render.pagesRendered} ` +
      `were transcribed (the ${MAX_DISTILL_PAGES}-page limit). The remainder is missing.`,
    )
  }
  return sections.join('\n\n').trim()
}

/**
 * Render every page of a PDF and transcribe it through `visionCaller`.
 *
 * Throws only when NOTHING could be produced (rendering failed, or every
 * chunk failed) — a partial transcription is returned with notes instead, so
 * a single bad page never costs the caller the other thirty-nine.
 */
export async function distillPdfViaPages(
  buffer: Buffer,
  options: DistillPdfOptions,
): Promise<DistillPdfResult> {
  const render = await (options.renderPages ?? renderPdfPages)(buffer, {
    maxPages: Math.min(options.maxPages ?? MAX_DISTILL_PAGES, MAX_DISTILL_PAGES),
    width: options.renderWidth ?? DASHSCOPE_RENDER_WIDTH,
  })

  if (render.pages.length === 0) {
    return {
      text: '',
      usage: null,
      usageByModel: [],
      model: 'pdf-distill',
      pagesRendered: 0,
      totalPages: render.totalPages,
      truncated: render.truncated,
      failedPages: [],
    }
  }

  const chunks = chunkPagesForVision(render.pages, options.chunkPages ?? DASHSCOPE_CHUNK_PAGES)
  const outcomes = await mapWithConcurrency(
    chunks,
    options.concurrency ?? DEFAULT_DISTILL_CONCURRENCY,
    (chunk) => transcribeChunk(chunk, render.totalPages, options, 1),
  )

  const readPages = outcomes.reduce((n, o) => n + (o.pages.length - o.failedPages.length), 0)
  if (readPages === 0) {
    const reason = outcomes.find((o) => o.failureReason)?.failureReason ?? 'every vision call failed'
    throw new Error(`PDF distillation failed for all ${render.pages.length} rendered pages: ${reason}`)
  }

  const usage = outcomes.reduce<TokenUsage | null>((acc, o) => addUsage(acc, o.usage), null)
  const byModel = new Map<string, TokenUsage>()
  for (const outcome of outcomes) {
    if (!outcome.model || !outcome.usage) continue
    byModel.set(outcome.model, addUsage(byModel.get(outcome.model) ?? null, outcome.usage)!)
  }

  return {
    text: stitchChunks(outcomes, {
      totalPages: render.totalPages,
      pagesRendered: render.pages.length,
      truncated: render.truncated,
    }),
    usage,
    usageByModel: [...byModel].map(([model, u]) => ({ model, usage: u })),
    model: outcomes.find((o) => o.model)?.model ?? 'pdf-distill',
    pagesRendered: render.pages.length,
    totalPages: render.totalPages,
    truncated: render.truncated,
    failedPages: outcomes.flatMap((o) => o.failedPages).sort((a, b) => a - b),
  }
}

/**
 * Fingerprint of everything that changes a distillate for the same bytes.
 * The distillate cache is keyed by `(content_sha256, config_key)`, so a width,
 * chunk-size, model, or engine change reads as a miss rather than serving
 * output the current configuration would not have produced.
 */
export function distillConfigKey(input: {
  renderWidth: number
  chunkPages: number
  model: string
}): string {
  return `v${PDF_DISTILL_ENGINE_VERSION}:w${input.renderWidth}:c${input.chunkPages}:${input.model}`
}
