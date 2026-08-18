/**
 * `Block[]` / Markdown → PDF — the PDF spoke of the doc-conversion hub.
 * [COMP:doc/to-pdf]
 *
 * There is deliberately no PDF *writer* here. A PDF is a print rendering of
 * a document, so the spoke composes the two things Brian already owns:
 * `blocksToDocx` (the deterministic Block[] → Word writer) and the shared
 * headless-LibreOffice runner (`files/libreoffice.ts`, the same renderer
 * every Office PDF release uses). Markdown enters through `markdownToBlocks`
 * so a chat-authored body and a doc page take the identical path:
 *
 *   markdown ──markdownToBlocks──▶ Block[] ──blocksToDocx──▶ .docx ──LibreOffice──▶ .pdf
 *
 * Why not a JS PDF library (pdfkit / @react-pdf / puppeteer): a second
 * renderer would diverge from the Office release path (fonts, page breaks,
 * table layout, CJK shaping) and add a headless-browser or a hand-written
 * layout engine to the deploy; LibreOffice is already the locked renderer
 * (office.md D26, "never a browser screenshot") and its binary is one apt
 * package on the api image. If a deployment has no LibreOffice, every caller
 * fails honestly with `converter_unavailable` — never a blank or fake PDF.
 *
 * Consumers: `GET /api/views/:id/export?format=pdf` (human download) and the
 * `renderPdf` chat tool (`workspace-files/render-pdf.ts`), which persists the
 * bytes as a workspace file so `sendFile` can deliver them.
 *
 * Spec: docs/architecture/features/doc-conversion.md → "PDF spoke".
 */
import type { Block, Page } from '../page-types.js'
import { blocksToDocx, type BlocksToDocxOptions } from './to-docx.js'
import { markdownToBlocks } from '../markdown.js'
import {
  LIBREOFFICE_FAILURE_MESSAGES,
  LibreOfficeError,
  convertToPdfWithLibreOffice,
  libreOfficeFailureCode,
  renderedPdfPageCount,
  type LibreOfficeFailureCode,
  type LibreOfficeRun,
} from '../../files/libreoffice.js'

export type PdfRenderFailureCode = LibreOfficeFailureCode

/** Typed, user-safe render failure. `message` is ours; vendor text stays on `cause`. */
export class PdfRenderError extends Error {
  constructor(
    readonly code: PdfRenderFailureCode,
    options?: { cause?: unknown },
  ) {
    super(LIBREOFFICE_FAILURE_MESSAGES[code], options)
    this.name = 'PdfRenderError'
  }
}

export type PdfRenderResult = {
  bytes: Uint8Array
  pageCount: number
  mime: 'application/pdf'
}

export type RenderPdfOptions = BlocksToDocxOptions & {
  /** Spawn seam — tests inject a fake LibreOffice; production omits it. */
  run?: LibreOfficeRun
}

/** The seam callers depend on, so a route / tool can be tested without LibreOffice. */
export type PdfRenderer = {
  fromPage(page: Page | Block[], opts?: RenderPdfOptions): Promise<PdfRenderResult>
  fromMarkdown(markdown: string, opts?: RenderPdfOptions): Promise<PdfRenderResult>
}

/** Render a doc page (or bare blocks) to PDF bytes. */
export async function renderPageToPdf(page: Page | Block[], opts: RenderPdfOptions = {}): Promise<PdfRenderResult> {
  const { run, ...docxOpts } = opts
  const docx = await blocksToDocx(page, docxOpts)
  try {
    const bytes = await convertToPdfWithLibreOffice(new Uint8Array(docx), { inputName: 'document.docx', run, tempPrefix: 'brian-doc-pdf-' })
    const pageCount = await renderedPdfPageCount(bytes)
    return { bytes, pageCount, mime: 'application/pdf' }
  } catch (error) {
    if (error instanceof PdfRenderError) throw error
    throw new PdfRenderError(libreOfficeFailureCode(error), { cause: error instanceof LibreOfficeError ? error.cause ?? error : error })
  }
}

/**
 * Render Markdown to PDF bytes via the Block[] hub (`markdownToBlocks`).
 *
 * A model asked for "a PDF titled X" almost always opens the body with
 * `# X` as well; printing both the docx Title paragraph and that H1 puts the
 * title on the page twice. When the first block is an H1 whose text equals
 * `opts.title`, the H1 is dropped and the Title paragraph stands.
 */
export async function renderMarkdownToPdf(markdown: string, opts: RenderPdfOptions = {}): Promise<PdfRenderResult> {
  return renderPageToPdf(dropDuplicateLeadingTitle(markdownToBlocks(markdown), opts.title), opts)
}

const normalizeTitle = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()

/** Exported for the unit test; see `renderMarkdownToPdf`. */
export function dropDuplicateLeadingTitle(blocks: Block[], title: string | undefined): Block[] {
  if (!title?.trim()) return blocks
  const first = blocks[0]
  if (!first || first.kind !== 'heading' || first.level !== 1) return blocks
  return normalizeTitle(first.text) === normalizeTitle(title) ? blocks.slice(1) : blocks
}

/** Production renderer — the real LibreOffice runner. */
export const defaultPdfRenderer: PdfRenderer = {
  fromPage: (page, opts) => renderPageToPdf(page, opts),
  fromMarkdown: (markdown, opts) => renderMarkdownToPdf(markdown, opts),
}
