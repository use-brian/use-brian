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
 * A chunk that hits its ceiling anyway (`truncated`) is split in half and each
 * half retried once — pathologically dense pages are handled by adaptation
 * rather than by lowering the default for everyone.
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

const PDF_DISTILL_PROMPT =
  'Transcribe these rendered PDF pages into faithful Markdown.\n' +
  '- Transcribe all text verbatim. Do NOT summarize, paraphrase, or invent content.\n' +
  '- Preserve headings, lists, and tables (Markdown tables; keep every row).\n' +
  '- Describe figures, charts, diagrams, photos, stamps, signatures, and handwriting ' +
  'inline where they appear, as `[Figure: ...]`, including any numbers or labels they carry.\n' +
  '- Start each page with a `## Page N` heading using the page numbers given below.\n' +
  '- If a page is blank, write its heading followed by `(blank page)`.\n' +
  'Output only the Markdown transcription.'

/**
 * The engine version participates in the distillate cache key: a change to the
 * prompt, the chunking, or the stitching produces different output from the
 * same bytes, so it must not read a cache entry written by the old engine.
 * Bump this whenever any of those change.
 */
const PDF_DISTILL_ENGINE_VERSION = 1

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

function chunkPrompt(pages: VisionPage[], totalPages: number): string {
  const numbers = pages.map((p) => p.pageNumber).join(', ')
  return (
    `${PDF_DISTILL_PROMPT}\n\n` +
    `These images are ${pageRangeLabel(pages)} of a ${totalPages}-page document, in order. ` +
    `Use exactly these page numbers in the headings: ${numbers}.`
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
  allowResplit: boolean,
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
    // A single-page chunk has nothing left to split; report it as failed.
    if (!allowResplit || chunk.pages.length < 2) {
      return {
        pages: chunk.pages,
        text: '',
        usage: null,
        model: null,
        failedPages: chunk.pages.map((p) => p.pageNumber),
        failureReason: reason,
      }
    }
    return splitAndRetry(chunk, totalPages, options, reason)
  }

  // Truncated at the ceiling: the transcription is cut mid-document, so half
  // the pages per call and try each half once. Keeping the partial text would
  // silently drop the tail of the chunk.
  if (result.truncated && allowResplit && chunk.pages.length >= 2) {
    return splitAndRetry(chunk, totalPages, options, 'output ceiling reached')
  }

  return {
    pages: chunk.pages,
    text: result.text.trim(),
    usage: result.usage,
    model: result.model,
    failedPages: [],
    ...(result.truncated ? { failureReason: 'output ceiling reached' } : {}),
  }
}

async function splitAndRetry(
  chunk: PageChunk,
  totalPages: number,
  options: DistillPdfOptions,
  reason: string,
): Promise<ChunkOutcome> {
  const mid = Math.ceil(chunk.pages.length / 2)
  const halves: PageChunk[] = [
    { pages: chunk.pages.slice(0, mid) },
    { pages: chunk.pages.slice(mid) },
  ]
  // One retry per half only (`allowResplit: false`) — an unbounded split
  // recursion on a genuinely broken page would fan out to a call per page and
  // then keep failing, paying N times for the same answer.
  const outcomes = await mapWithConcurrency(halves, 2, (half) =>
    transcribeChunk(half, totalPages, options, false),
  )
  const merged: ChunkOutcome = {
    pages: chunk.pages,
    text: outcomes.map((o) => o.text).filter(Boolean).join('\n\n'),
    usage: outcomes.reduce<TokenUsage | null>((acc, o) => addUsage(acc, o.usage), null),
    model: outcomes.find((o) => o.model)?.model ?? null,
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
  const sections = ordered.map((o) => o.text).filter((t) => t.length > 0)

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
    (chunk) => transcribeChunk(chunk, render.totalPages, options, true),
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
