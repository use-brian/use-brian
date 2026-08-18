/** Canonical Presentation PDF release through isolated LibreOffice. [COMP:office/presentation-pdf]
 *
 * Spawn/temp-root/timeout/concurrency mechanics live in the shared
 * `files/libreoffice.ts` runner; this module owns the Presentation contract:
 * canonical PPTX in, slide-count gate out.
 */
import type { PresentationSnapshot } from '@use-brian/office-model'
import type { OfficeResourceResolver } from '../package.js'
import { exportOfficePresentation } from './index.js'
import {
  LibreOfficeError,
  convertToPdfWithLibreOffice,
  libreOfficeFailureCode,
  renderedPdfPageCount,
  type LibreOfficeRun,
} from '../../files/libreoffice.js'

export type PresentationPdfIssueCode = 'converter_unavailable' | 'timeout' | 'invalid_pdf' | 'page_count_mismatch'
export type PresentationPdfIssue = { severity: 'error'; code: PresentationPdfIssueCode; message: string }
export type PresentationPdfReceipt = {
  expectedPageCount: number
  actualPageCount?: number
  renderer: 'libreoffice'
  issues: PresentationPdfIssue[]
}
export type PresentationPdfPort = {
  convert(pptx: Uint8Array): Promise<Uint8Array>
  pageCount(pdf: Uint8Array): Promise<number>
}

class PresentationPdfFailure extends Error {
  constructor(readonly code: PresentationPdfIssueCode) { super(code) }
}

/** PPTX bytes → PDF bytes through the shared isolated LibreOffice runner. */
export async function convertPresentationPptxToPdf(
  input: Uint8Array,
  run?: LibreOfficeRun,
): Promise<Uint8Array> {
  try {
    return await convertToPdfWithLibreOffice(input, { inputName: 'presentation.pptx', run, tempPrefix: 'brian-presentation-pdf-' })
  } catch (error) {
    if (error instanceof LibreOfficeError) throw new PresentationPdfFailure(error.code)
    throw error
  }
}

async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  try {
    return await renderedPdfPageCount(bytes)
  } catch {
    throw new PresentationPdfFailure('invalid_pdf')
  }
}

export const defaultPresentationPdfPort: PresentationPdfPort = { convert: convertPresentationPptxToPdf, pageCount: pdfPageCount }

const MESSAGES: Record<PresentationPdfIssueCode, string> = {
  converter_unavailable: 'Presentation PDF conversion is unavailable.',
  timeout: 'Presentation PDF conversion timed out.',
  invalid_pdf: 'Presentation PDF conversion produced an invalid PDF.',
  page_count_mismatch: 'Presentation PDF page count does not match the slide count.',
}

export async function exportOfficePresentationPdf(
  snapshot: PresentationSnapshot,
  resolveResource: OfficeResourceResolver = async () => null,
  port: PresentationPdfPort = defaultPresentationPdfPort,
): Promise<{ bytes?: Uint8Array; mime: 'application/pdf'; receipt: PresentationPdfReceipt }> {
  const expectedPageCount = snapshot.slides.length
  const base = { expectedPageCount, renderer: 'libreoffice' as const, issues: [] as PresentationPdfIssue[] }
  // PPTX export is its own canonical validation boundary. Do not mislabel a
  // missing resource or model failure as a converter outage.
  const pptx = await exportOfficePresentation(snapshot, resolveResource)
  try {
    const bytes = await port.convert(pptx.bytes)
    let actualPageCount: number
    try { actualPageCount = await port.pageCount(bytes) } catch { throw new PresentationPdfFailure('invalid_pdf') }
    if (actualPageCount !== expectedPageCount) {
      return { mime: 'application/pdf', receipt: { ...base, actualPageCount, issues: [{ severity: 'error', code: 'page_count_mismatch', message: MESSAGES.page_count_mismatch }] } }
    }
    return { bytes, mime: 'application/pdf', receipt: { ...base, actualPageCount } }
  } catch (error) {
    const code: PresentationPdfIssueCode = error instanceof PresentationPdfFailure ? error.code : libreOfficeFailureCode(error)
    return { mime: 'application/pdf', receipt: { ...base, issues: [{ severity: 'error', code, message: MESSAGES[code] }] } }
  }
}
