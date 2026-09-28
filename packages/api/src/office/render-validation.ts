/** Candidate-only compatibility validation. Never writes/promotes an artifact head. */
import { createHash } from 'node:crypto'
import {
  convertToPdfWithLibreOffice, renderedPdfPageCount, fitOfficeArtifact, preflightSpreadsheetPdf,
  exportOfficeDocument, exportOfficePresentation, exportOfficeSpreadsheet,
  reparseOfficeDocument, reparseOfficePresentation, reparseOfficeSpreadsheet, officeSemanticHash,
  type OfficeResourceResolver, type SpreadsheetPdfRequest,
} from '@use-brian/core'
import type { OfficeArtifactSnapshot } from '@use-brian/office-model'

export type OfficeRenderValidationPort = {
  convert: (bytes: Uint8Array, options: { inputName: string; tempPrefix?: string }) => Promise<Uint8Array>
  pageCount: (pdf: Uint8Array) => Promise<number>
}
export type OfficeRenderValidationReceipt = {
  ok: boolean
  renderer: 'libreoffice'
  candidateHash: string
  exportHash?: string
  pdfHash?: string
  expectedPageCount?: number
  estimatedPageCount?: number
  maximumPageCount?: number
  actualPageCount?: number
  minimumPageCount?: number
  worksheets?: Array<{ id: string; printArea?: string; fitToWidth?: number; fitToHeight?: number }>
  issues: Array<{ code: string; message: string; objectId?: string }>
  warnings: string[]
  limitations: string[]
}
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const productionPort: OfficeRenderValidationPort = { convert: convertToPdfWithLibreOffice, pageCount: renderedPdfPageCount }

/** Exports the exact candidate using the native exporters, then converts those
 * bytes, not a regenerated PDF-adapter candidate. Retain returned exportBytes
 * for native reparse/promotion; any subsequent edit requires a fresh receipt.
 * Selected-sheet release requires an already print-scoped candidate; internal
 * all-visible mode validates the unchanged workbook. Neither hides sheets or
 * rewrites print areas to manufacture a successful validation.
 */
export async function validateOfficeCandidateRendering(params: {
  snapshot: OfficeArtifactSnapshot
  resolveResource?: OfficeResourceResolver
  spreadsheetPdf?: SpreadsheetPdfRequest
  /** Internal creation validates the unchanged workbook, not a release derivative. */
  spreadsheetMode?: 'all-visible'
  /** Pipeline-owned native bytes; must be reparsed against snapshot before commit. */
  exportBytes?: Uint8Array
  fitBudget?: Parameters<typeof fitOfficeArtifact>[1]
  /** Word pagination is heuristic: enforce exact/max counts only when configured. */
  documentPageConstraints?: { exact?: number; max?: number }
  port?: OfficeRenderValidationPort
}): Promise<{ receipt: OfficeRenderValidationReceipt; exportBytes?: Uint8Array }> {
  const snapshot = structuredClone(params.snapshot)
  const receipt: OfficeRenderValidationReceipt = {
    ok: false, renderer: 'libreoffice', candidateHash: hash(JSON.stringify(snapshot)), issues: [],
    warnings: ['LibreOffice may substitute unavailable fonts; the converter does not report font substitutions.'],
    limitations: ['PDF parsing and page counts do not detect every visual overflow or collision.', 'LibreOffice output is not a guarantee of native Microsoft Office pixel identity.'],
  }
  let exportBytes: Uint8Array | undefined
  let stage = 'layout'
  try {
    if (snapshot.family === 'pdf') throw new Error('PDF sessions require the independent PDF reopen validator')
    if (!Number.isFinite(params.fitBudget?.minimumFontSizePt ?? 8)) throw new Error('Font floor must be finite')
    const fit = fitOfficeArtifact(snapshot, { ...params.fitBudget, minimumFontSizePt: Math.max(8, params.fitBudget?.minimumFontSizePt ?? 8) })
    receipt.issues.push(...fit.issues)
    receipt.estimatedPageCount = fit.result.pages.length
    receipt.expectedPageCount = snapshot.family === 'document' ? params.documentPageConstraints?.exact : fit.result.pages.length
    if (snapshot.family === 'document') {
      const limits = [params.documentPageConstraints?.max, params.fitBudget?.maxPages].filter((value): value is number => value !== undefined)
      receipt.maximumPageCount = limits.length ? Math.min(...limits) : undefined
      receipt.minimumPageCount = 1
      receipt.limitations.push('Word deterministic pagination is an estimate; only explicitly configured page-count constraints are enforced against LibreOffice output.')
      for (const count of [params.documentPageConstraints?.exact, ...limits]) {
        if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) receipt.issues.push({ code: 'invalid_page_constraint', message: 'Configured Word page counts must be positive integers.' })
      }
    }
    if (snapshot.family === 'spreadsheet' && params.spreadsheetMode !== 'all-visible') {
      const request = params.spreadsheetPdf
      const visible = snapshot.worksheets.filter(sheet => sheet.visibility === 'visible')
      if (!request || visible.length !== 1 || visible[0].id !== request.sheetId || visible[0].print.printArea !== request.printArea) {
        receipt.issues.push({ code: 'print_scope_required', message: 'XLSX validation requires one visible selected sheet with the requested canonical print area.' })
      }
      if (request) receipt.issues.push(...preflightSpreadsheetPdf(snapshot, request).receipt.issues.filter(issue => issue.severity === 'error'))
      receipt.expectedPageCount = request?.expectedPageCount
    }
    if (snapshot.family === 'spreadsheet' && params.spreadsheetMode === 'all-visible') {
      const visible = snapshot.worksheets.filter(sheet => sheet.visibility === 'visible')
      receipt.worksheets = visible.map(sheet => ({ id: sheet.id, printArea: sheet.print.printArea, fitToWidth: sheet.print.fitToWidth, fitToHeight: sheet.print.fitToHeight }))
      const printable = visible.filter(sheet => sheet.images.length || sheet.cells.some(cell => cell.formula || cell.value !== null && cell.value !== ''))
      receipt.minimumPageCount = Math.max(1, printable.length)
      // Worksheet count is not a page count. Do not fabricate a precise count
      // for unbounded automatic pagination; validate all-visible conversion and
      // a nonempty-page lower bound, recording this explicit limitation.
      receipt.expectedPageCount = printable.length && printable.every(sheet => sheet.print.fitToWidth === 1 && sheet.print.fitToHeight === 1) ? printable.length : undefined
      receipt.limitations.push('All-visible workbook validation checks PDF readability and a page lower bound, not per-sheet pagination or cell clipping; no sheets or print areas were changed.')
      if (!visible.length || !printable.length) receipt.issues.push({ code: 'empty_workbook', message: 'The workbook has no visible printable content.' })
    } else if (snapshot.family !== 'document' && (!Number.isSafeInteger(receipt.expectedPageCount) || receipt.expectedPageCount! < 1)) receipt.issues.push({ code: 'invalid_page_constraint', message: 'A positive expected page count is required.' })
    if (receipt.issues.length) return { receipt }
    stage = 'export'
    const exported = params.exportBytes ? { bytes: new Uint8Array(params.exportBytes) } : snapshot.family === 'document' ? await exportOfficeDocument(snapshot, params.resolveResource)
      : snapshot.family === 'presentation' ? await exportOfficePresentation(snapshot, params.resolveResource)
        : await exportOfficeSpreadsheet(snapshot, params.resolveResource)
    exportBytes = exported.bytes
    if (!exportBytes?.byteLength) throw new Error('Native export is empty')
    receipt.exportHash = hash(exportBytes)
    stage = 'conversion'
    const extension = snapshot.family === 'document' ? 'docx' : snapshot.family === 'presentation' ? 'pptx' : 'xlsx'
    const port = params.port ?? productionPort
    const pdf = await port.convert(new Uint8Array(exportBytes), { inputName: `candidate.${extension}`, tempPrefix: 'brian-office-validation-' })
    stage = 'invalid_pdf'
    if (!pdf?.byteLength) throw new Error('Converted PDF is missing or empty')
    receipt.pdfHash = hash(pdf)
    const count = await port.pageCount(pdf)
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Converted PDF has no readable pages')
    receipt.actualPageCount = count
    if (receipt.maximumPageCount !== undefined && count > receipt.maximumPageCount) receipt.issues.push({ code: 'page_count_mismatch', message: `Maximum ${receipt.maximumPageCount} pages; rendered ${count}.` })
    if (snapshot.family === 'document' && count !== receipt.estimatedPageCount) receipt.warnings.push(`Word pagination estimate was ${receipt.estimatedPageCount} pages; LibreOffice rendered ${count}.`)
    if (receipt.minimumPageCount !== undefined && count < receipt.minimumPageCount) receipt.issues.push({ code: 'page_count_mismatch', message: `Expected at least ${receipt.minimumPageCount} pages; rendered ${count}.` })
    if (receipt.expectedPageCount !== undefined && count !== receipt.expectedPageCount) receipt.issues.push({ code: 'page_count_mismatch', message: `Expected ${receipt.expectedPageCount} pages; rendered ${count}.` })
    receipt.ok = receipt.issues.length === 0
  } catch (error) {
    receipt.issues.push({ code: stage, message: error instanceof Error ? error.message : 'Candidate rendering validation failed.' })
  }
  return { receipt, exportBytes }
}


/** Shared create/revision gate. Internal workbook checks always cover the
 * unchanged visible workbook; strict selected-sheet release is a different API.
 * Reparse exactly the native bytes that were converted, never regenerate them.
 */
export async function validateOfficeInternalCandidateRendering(
  params: Omit<Parameters<typeof validateOfficeCandidateRendering>[0], 'spreadsheetMode' | 'spreadsheetPdf'>,
): ReturnType<typeof validateOfficeCandidateRendering> {
  const snapshot = structuredClone(params.snapshot)
  const result = await validateOfficeCandidateRendering({ ...params, snapshot, spreadsheetMode: 'all-visible' })
  if (!result.receipt.ok || !result.exportBytes) return result
  try {
    const reopened = snapshot.family === 'document' ? await reparseOfficeDocument(result.exportBytes)
      : snapshot.family === 'presentation' ? await reparseOfficePresentation(result.exportBytes)
        : await reparseOfficeSpreadsheet(result.exportBytes)
    if (reopened.semanticHash !== officeSemanticHash(snapshot) || reopened.layoutSerialization !== fitOfficeArtifact(snapshot, params.fitBudget).result.serialization) throw new Error('Rendered Office bytes did not reopen to the candidate semantic/layout identity.')
  } catch (error) {
    result.receipt.ok = false
    result.receipt.issues.push({ code: 'export_reparse_mismatch', message: error instanceof Error ? error.message : 'Native round-trip validation failed.' })
  }
  return result
}
