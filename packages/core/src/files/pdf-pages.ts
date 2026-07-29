/**
 * Server-side PDF page rendering for visual document analysis.
 *
 * `unpdf` supplies the PDF.js bridge, `pdfjs-dist` supplies the render-capable
 * Node build, and `@napi-rs/canvas` supplies the native canvas. Pages are
 * normalized to bounded JPEGs so they fit the DashScope inline-image request.
 *
 * [COMP:files/pdf-pages]
 */

import sharp from 'sharp'
import { definePDFJSModule, getDocumentProxy, renderPageAsImage } from 'unpdf'

export type RenderedPdfPage = {
  pageNumber: number
  buffer: Buffer
  mime: 'image/jpeg'
}

export type RenderPdfPagesResult = {
  pages: RenderedPdfPage[]
  totalPages: number
  truncated: boolean
}

const DEFAULT_MAX_PAGES = 10
const DEFAULT_WIDTH = 1600
const DEFAULT_JPEG_QUALITY = 82

let pdfJsReady: Promise<void> | undefined

function ensureRenderPdfJs(): Promise<void> {
  pdfJsReady ??= definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'))
  return pdfJsReady
}

/**
 * Page count only — the CHEAP pre-flight probe.
 *
 * Parses the document structure and nothing else: no render, no canvas, no
 * model call. That is the whole point (see
 * `docs/architecture/engine/preflight-confirmation.md`): the probe that
 * decides whether to ask the user about an expensive operation must never
 * BE the expensive operation.
 *
 * Returns null when the bytes are not a readable PDF — the caller decides
 * whether that is a failure or simply "no estimate available".
 */
export async function probePdfPageCount(buffer: Buffer): Promise<number | null> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    try {
      return pdf.numPages
    } finally {
      await pdf.destroy()
    }
  } catch {
    return null
  }
}

/** Render the first bounded set of PDF pages as compressed JPEG images. */
export async function renderPdfPages(
  buffer: Buffer,
  options: { maxPages?: number; width?: number; jpegQuality?: number } = {},
): Promise<RenderPdfPagesResult> {
  await ensureRenderPdfJs()

  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES))
  const width = Math.max(1, Math.floor(options.width ?? DEFAULT_WIDTH))
  const jpegQuality = Math.min(100, Math.max(1, Math.floor(options.jpegQuality ?? DEFAULT_JPEG_QUALITY)))
  const pdf = await getDocumentProxy(new Uint8Array(buffer))

  try {
    const count = Math.min(pdf.numPages, maxPages)
    const pages: RenderedPdfPage[] = []
    for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
      const png = await renderPageAsImage(pdf, pageNumber, {
        canvasImport: () => import('@napi-rs/canvas'),
        width,
      })
      const jpeg = await sharp(Buffer.from(png))
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: jpegQuality, mozjpeg: true })
        .toBuffer()
      pages.push({ pageNumber, buffer: jpeg, mime: 'image/jpeg' })
    }
    return { pages, totalPages: pdf.numPages, truncated: pdf.numPages > count }
  } finally {
    await pdf.destroy()
  }
}
