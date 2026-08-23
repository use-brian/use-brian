import { describe, it, expect, vi } from 'vitest'
import {
  CHUNK_OUTPUT_TOKENS_PER_PAGE,
  DASHSCOPE_CHUNK_PAGES,
  MAX_DISTILL_PAGES,
  chunkOutputCeiling,
  chunkPagesForVision,
  distillConfigKey,
  distillPdfViaPages,
  pdfPageCompletionMarker,
  type VisionCaller,
} from '../pdf-distill.js'
import type { RenderedPdfPage, RenderPdfPagesResult } from '../pdf-pages.js'

function pages(count: number, from = 1): RenderedPdfPage[] {
  return Array.from({ length: count }, (_, i) => ({
    pageNumber: from + i,
    buffer: Buffer.from(`page-${from + i}`),
    mime: 'image/jpeg' as const,
  }))
}

/** Stand in for `renderPdfPages` so the engine's logic is tested without pdf.js. */
function fakeRenderer(totalPages: number) {
  return async (_buffer: Buffer, options: { maxPages?: number; width?: number }) => {
    const max = options.maxPages ?? totalPages
    const count = Math.min(totalPages, max)
    return {
      pages: pages(count),
      totalPages,
      truncated: totalPages > count,
    } satisfies RenderPdfPagesResult as RenderPdfPagesResult
  }
}

/** Transcribes each page as `## Page N` so ordering is checkable. */
const echoCaller: VisionCaller = async (req) => ({
  text: req.images
    .map(
      (p) =>
        `## Page ${p.pageNumber}\n\ncontent ${p.pageNumber}\n\n${pdfPageCompletionMarker(p.pageNumber)}`,
    )
    .join('\n\n'),
  usage: { inputTokens: 100 * req.images.length, outputTokens: 20 * req.images.length },
  model: 'fake-vision',
})

describe('[COMP:files/pdf-distill] chunker', () => {
  it('groups consecutive pages, last chunk short', () => {
    const chunks = chunkPagesForVision(pages(14), 6)
    expect(chunks.map((c) => c.pages.map((p) => p.pageNumber))).toEqual([
      [1, 2, 3, 4, 5, 6],
      [7, 8, 9, 10, 11, 12],
      [13, 14],
    ])
  })

  it('never emits an empty chunk, even at chunkPages < 1', () => {
    expect(chunkPagesForVision(pages(3), 0).map((c) => c.pages.length)).toEqual([1, 1, 1])
    expect(chunkPagesForVision([], 6)).toEqual([])
  })

  it('scales the output ceiling by page count and clamps it to the model cap', () => {
    // The bound is OUTPUT, not input. A chunk asks for its page budget and
    // never more than the model can emit: 5 pages fit under qwen-vl-max's
    // 8192, a 6-page DashScope chunk clamps to it, and a 12-page
    // provider-backed chunk clamps hard.
    expect(chunkOutputCeiling(5, CHUNK_OUTPUT_TOKENS_PER_PAGE, 8192)).toBe(5 * 1400)
    expect(chunkOutputCeiling(6, CHUNK_OUTPUT_TOKENS_PER_PAGE, 8192)).toBe(8192)
    expect(chunkOutputCeiling(12, CHUNK_OUTPUT_TOKENS_PER_PAGE, 8192)).toBe(8192)
    expect(chunkOutputCeiling(3, CHUNK_OUTPUT_TOKENS_PER_PAGE, undefined)).toBe(3 * 1400)
  })
})

describe('[COMP:files/pdf-distill] distillPdfViaPages', () => {
  it('reads every page and stitches the sections in page order', async () => {
    // Chunks fan out concurrently and can complete out of order — the
    // stitcher, not arrival order, decides the document's sequence.
    const seen: number[][] = []
    const caller: VisionCaller = async (req) => {
      seen.push(req.images.map((p) => p.pageNumber))
      const delay = req.images[0]!.pageNumber === 1 ? 20 : 0
      await new Promise((r) => setTimeout(r, delay))
      return echoCaller(req)
    }

    const result = await distillPdfViaPages(Buffer.from('x'), {
      visionCaller: caller,
      chunkPages: 2,
      renderPages: fakeRenderer(5),
    })

    expect(seen).toHaveLength(3)
    expect(result.pagesRendered).toBe(5)
    expect(result.totalPages).toBe(5)
    expect(result.truncated).toBe(false)
    expect(result.failedPages).toEqual([])
    expect(result.text).not.toContain('PDF_PAGE_')
    const order = [...result.text.matchAll(/## Page (\d+)/g)].map((m) => Number(m[1]))
    expect(order).toEqual([1, 2, 3, 4, 5])
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 100 })
    expect(result.usageByModel).toEqual([
      { model: 'fake-vision', usage: { inputTokens: 500, outputTokens: 100 } },
    ])
  })

  it('honours the concurrency bound', async () => {
    let inFlight = 0
    let peak = 0
    const caller: VisionCaller = async (req) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return echoCaller(req)
    }

    await distillPdfViaPages(Buffer.from('x'), {
      visionCaller: caller,
      chunkPages: 1,
      concurrency: 3,
      renderPages: fakeRenderer(9),
    })
    expect(peak).toBe(3)
  })

  it('splits a truncated chunk in half and retries each half once', async () => {
    const calls: number[][] = []
    const caller: VisionCaller = vi.fn<VisionCaller>(async (req) => {
      const numbers = req.images.map((p) => p.pageNumber)
      calls.push(numbers)
      // The full 4-page chunk hits the ceiling; the halves fit.
      if (numbers.length === 4) return { text: 'cut off', usage: null, model: 'fake-vision', truncated: true }
      return echoCaller(req)
    })

    const result = await distillPdfViaPages(Buffer.from('x'), {
      visionCaller: caller,
      chunkPages: 4,
      renderPages: fakeRenderer(4),
    })

    expect(calls).toEqual([[1, 2, 3, 4], [1, 2], [3, 4]])
    // The truncated text is DISCARDED, not merged — keeping it would duplicate
    // the head of the chunk and hide that the tail was ever missing.
    expect(result.text).not.toContain('cut off')
    expect([...result.text.matchAll(/## Page (\d+)/g)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4])
    expect(result.failedPages).toEqual([])
  })

  it('recursively splits a nominal end-turn response whose page markers are missing', async () => {
    const calls: number[][] = []
    const caller: VisionCaller = async (req) => {
      const numbers = req.images.map((p) => p.pageNumber)
      calls.push(numbers)
      if (numbers.length > 1) {
        return {
          text: `partial ${numbers[0]}`,
          usage: null,
          model: 'fake-vision',
          truncated: false,
        }
      }
      return echoCaller(req)
    }

    const result = await distillPdfViaPages(Buffer.from('x'), {
      visionCaller: caller,
      chunkPages: 4,
      renderPages: fakeRenderer(4),
    })

    expect(calls[0]).toEqual([1, 2, 3, 4])
    expect(calls).toEqual(expect.arrayContaining([[1, 2], [3, 4], [1], [2], [3], [4]]))
    expect(calls).toHaveLength(7)
    expect(result.failedPages).toEqual([])
    expect(result.text).not.toContain('partial')
    expect([...result.text.matchAll(/## Page (\d+)/g)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4])
  })

  it('retries an incomplete single page once, then fails honestly', async () => {
    const caller = vi.fn<VisionCaller>(async () => ({
      text: '## Page 1\n\ncut off',
      usage: null,
      model: 'fake-vision',
      truncated: false,
    }))

    await expect(
      distillPdfViaPages(Buffer.from('x'), {
        visionCaller: caller,
        chunkPages: 1,
        renderPages: fakeRenderer(1),
      }),
    ).rejects.toThrow(/nominally complete turn without the page completion marker/)
    expect(caller).toHaveBeenCalledTimes(2)
  })

  it('notes failed pages in the output instead of dropping them silently', async () => {
    const caller: VisionCaller = async (req) => {
      if (req.images.some((p) => p.pageNumber === 3)) throw new Error('vision 500')
      return echoCaller(req)
    }

    const result = await distillPdfViaPages(Buffer.from('x'), {
      visionCaller: caller,
      chunkPages: 1,
      renderPages: fakeRenderer(4),
    })

    expect(result.failedPages).toEqual([3])
    expect(result.text).toContain('Page 3 could not be read')
    expect(result.text).toContain('vision 500')
    // The other three pages still made it.
    expect(result.text).toContain('content 4')
  })

  it('retries a failed multi-page chunk as halves before giving up on it', async () => {
    const caller: VisionCaller = async (req) => {
      if (req.images.length > 1) throw new Error('too big')
      return echoCaller(req)
    }

    const result = await distillPdfViaPages(Buffer.from('x'), {
      visionCaller: caller,
      chunkPages: 2,
      renderPages: fakeRenderer(2),
    })

    expect(result.failedPages).toEqual([])
    expect(result.text).toContain('content 1')
    expect(result.text).toContain('content 2')
  })

  it('throws only when no page at all could be read', async () => {
    const caller: VisionCaller = async () => { throw new Error('vision down') }
    await expect(
      distillPdfViaPages(Buffer.from('x'), {
        visionCaller: caller,
        chunkPages: 1,
        renderPages: fakeRenderer(2),
      }),
    ).rejects.toThrow(/vision down/)
  })

  it('caps at MAX_DISTILL_PAGES and says so in the output', async () => {
    const result = await distillPdfViaPages(Buffer.from('x'), {
      visionCaller: echoCaller,
      chunkPages: 50,
      renderPages: fakeRenderer(MAX_DISTILL_PAGES + 20),
    })

    expect(result.pagesRendered).toBe(MAX_DISTILL_PAGES)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain(`only the first ${MAX_DISTILL_PAGES}`)
  })

  it('requests all pages at the configured render width, never a sample', async () => {
    // Locked decision (plan §2.3): no page sampling, no length-based downgrade.
    const renderPages = vi.fn(fakeRenderer(40))
    await distillPdfViaPages(Buffer.from('x'), {
      visionCaller: echoCaller,
      renderWidth: 1120,
      renderPages,
    })
    expect(renderPages).toHaveBeenCalledWith(expect.any(Buffer), { maxPages: MAX_DISTILL_PAGES, width: 1120 })
  })

  it('returns empty rather than throwing for a zero-page document', async () => {
    const result = await distillPdfViaPages(Buffer.from('x'), {
      visionCaller: echoCaller,
      renderPages: fakeRenderer(0),
    })
    expect(result.text).toBe('')
    expect(result.pagesRendered).toBe(0)
  })
})

describe('[COMP:files/pdf-distill] cache-key fingerprint', () => {
  it('is stable for the same configuration', () => {
    const config = { renderWidth: 1120, chunkPages: DASHSCOPE_CHUNK_PAGES, model: 'qwen-vl-max' }
    expect(distillConfigKey(config)).toBe(distillConfigKey({ ...config }))
  })

  it('changes when anything that changes the output changes', () => {
    const base = { renderWidth: 1120, chunkPages: 6, model: 'qwen-vl-max' }
    const keys = new Set([
      distillConfigKey(base),
      distillConfigKey({ ...base, renderWidth: 1024 }),
      distillConfigKey({ ...base, chunkPages: 12 }),
      distillConfigKey({ ...base, model: 'gpt-5.6-luna' }),
    ])
    expect(keys.size).toBe(4)
  })

  it('carries the engine version so a prompt or stitching change misses the cache', () => {
    expect(distillConfigKey({ renderWidth: 1120, chunkPages: 6, model: 'm' })).toMatch(/^v\d+:/)
  })
})
