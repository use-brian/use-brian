/** Canonical Document PDF release through isolated LibreOffice. [COMP:office/document-pdf]
 *
 * The spawn/temp-root/timeout/concurrency mechanics live in the shared
 * `files/libreoffice.ts` runner (one binary lookup, one policy for every PDF
 * Brian renders); this module owns only the Document-specific contract: the
 * canonical DOCX export in, the layout page-count gate out.
 */
import { PDFDocument } from '@cantoo/pdf-lib'
import { layoutOfficeArtifact } from '@use-brian/office-renderer'
import type { DocumentSnapshot } from '@use-brian/office-model'
import type { OfficeResourceResolver } from '../package.js'
import { exportOfficeDocument } from './index.js'
import {
  LibreOfficeError,
  convertToPdfWithLibreOffice,
  libreOfficeFailureCode,
  renderedPdfPageCount,
  type LibreOfficeRun,
} from '../../files/libreoffice.js'

export type DocumentPdfIssueCode = 'converter_unavailable' | 'timeout' | 'invalid_pdf' | 'page_count_mismatch'
export type DocumentPdfIssue = { severity: 'error'; code: DocumentPdfIssueCode; message: string }
export type DocumentPdfReceipt = {
  expectedPageCount: number
  actualPageCount?: number
  renderer: 'libreoffice'
  issues: DocumentPdfIssue[]
}
export type DocumentPdfPort = {
  convert(docx: Uint8Array): Promise<Uint8Array>
  pageCount(pdf: Uint8Array): Promise<number>
}

class DocumentPdfFailure extends Error {
  constructor(readonly code: DocumentPdfIssueCode, options?: ErrorOptions) { super(code, options) }
}

/** DOCX bytes → PDF bytes through the shared isolated LibreOffice runner.
 *  `run` is the spawn seam tests inject; failures surface as our own codes. */
export async function convertDocumentDocxToPdf(
  input: Uint8Array,
  run?: LibreOfficeRun,
): Promise<Uint8Array> {
  try {
    return await convertToPdfWithLibreOffice(input, { inputName: 'document.docx', run, tempPrefix: 'brian-document-pdf-' })
  } catch (error) {
    if (error instanceof LibreOfficeError) throw new DocumentPdfFailure(error.code, { cause: error })
    throw error
  }
}

async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  try {
    return await renderedPdfPageCount(bytes)
  } catch {
    throw new DocumentPdfFailure('invalid_pdf')
  }
}

export const defaultDocumentPdfPort: DocumentPdfPort = { convert: convertDocumentDocxToPdf, pageCount: pdfPageCount }

const MESSAGES: Record<DocumentPdfIssueCode, string> = {
  converter_unavailable: 'Document PDF conversion is unavailable.',
  timeout: 'Document PDF conversion timed out.',
  invalid_pdf: 'Document PDF conversion produced an invalid PDF.',
  page_count_mismatch: 'Document PDF page count does not match the canonical layout.',
}

/** LibreOffice snaps near-standard paper sizes and rounds custom dimensions.
 * Keep the authored canvas without moving text or link annotations relative to
 * its upper-left corner. This repairs sub-point rounding only, not reflow. */
async function restoreDocumentPdfPageSizes(bytes: Uint8Array, pages: Array<{ widthPt: number; heightPt: number }>): Promise<Uint8Array> {
  let pdf: PDFDocument
  try { pdf = await PDFDocument.load(bytes, { updateMetadata: false }) }
  catch (cause) { throw new DocumentPdfFailure('invalid_pdf', { cause }) }
  if (pdf.getPageCount() !== pages.length) throw new DocumentPdfFailure('invalid_pdf')
  let changed = false
  for (const [index, page] of pdf.getPages().entries()) {
    const expected = pages[index]
    const box = page.getMediaBox(), crop = page.getCropBox()
    if (page.getRotation().angle !== 0 || Object.keys(box).some(key => box[key as keyof typeof box] !== crop[key as keyof typeof crop])) continue
    if (Math.abs(box.width - expected.widthPt) > 0.5 || Math.abs(box.height - expected.heightPt) > 0.5) continue
    if (box.width === expected.widthPt && box.height === expected.heightPt) continue
    const bottom = box.y + box.height - expected.heightPt
    page.setMediaBox(box.x, bottom, expected.widthPt, expected.heightPt)
    page.setCropBox(box.x, bottom, expected.widthPt, expected.heightPt)
    changed = true
  }
  return changed ? pdf.save() : bytes
}

export async function exportOfficeDocumentPdf(
  snapshot: DocumentSnapshot,
  resolveResource: OfficeResourceResolver = async () => null,
  port: DocumentPdfPort = defaultDocumentPdfPort,
): Promise<{ bytes?: Uint8Array; mime: 'application/pdf'; receipt: DocumentPdfReceipt }> {
  const pages = layoutOfficeArtifact(snapshot).pages
  const expectedPageCount = pages.length
  const base = { expectedPageCount, renderer: 'libreoffice' as const, issues: [] as DocumentPdfIssue[] }
  const docx = await exportOfficeDocument(snapshot, resolveResource)
  try {
    const bytes = await port.convert(docx.bytes)
    let actualPageCount: number
    try { actualPageCount = await port.pageCount(bytes) } catch { throw new DocumentPdfFailure('invalid_pdf') }
    if (actualPageCount !== expectedPageCount) {
      return { mime: 'application/pdf', receipt: { ...base, actualPageCount, issues: [{ severity: 'error', code: 'page_count_mismatch', message: MESSAGES.page_count_mismatch }] } }
    }
    return { bytes: await restoreDocumentPdfPageSizes(bytes, pages), mime: 'application/pdf', receipt: { ...base, actualPageCount } }
  } catch (error) {
    const code: DocumentPdfIssueCode = error instanceof DocumentPdfFailure ? error.code : libreOfficeFailureCode(error)
    console.error('[office/document-pdf] conversion failed', { code, error })
    return { mime: 'application/pdf', receipt: { ...base, issues: [{ severity: 'error', code, message: MESSAGES[code] }] } }
  }
}
