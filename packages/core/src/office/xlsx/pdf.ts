/** Selected-sheet spreadsheet PDF release through isolated LibreOffice. [COMP:office/spreadsheet-pdf] */
import { convertToPdfWithLibreOffice, renderedPdfPageCount } from '../../files/libreoffice.js'
import { addressesInRange, parseCellAddress, recalculateSpreadsheet, spreadsheetCellDisplayValue, type SpreadsheetSnapshot } from '@use-brian/office-model'
import { exportOfficeSpreadsheet } from './index.js'
import type { OfficeResourceResolver } from '../package.js'

export type SpreadsheetPdfPreset = 'invoice' | 'worksheet'
export type SpreadsheetPdfRequest = {
  sheetId: string
  printArea: string
  calculationMode: 'automatic' | 'stored'
  expectedPageCount: number
  preset: SpreadsheetPdfPreset
}
export type SpreadsheetPdfIssue = { severity: 'error' | 'warning'; code: string; message: string; address?: string }
export type SpreadsheetPdfReceipt = {
  sheetId: string
  sheetName: string
  printArea: string
  expectedPageCount: number
  actualPageCount?: number
  renderer: 'libreoffice'
  issues: SpreadsheetPdfIssue[]
}

const PLACEHOLDER = /\[[^\]]*(?:ENTER|CLIENT|CONTACT|ADDRESS|OPTIONAL|PROJECT|SERVICE|INVOICE)[^\]]*\]|\{\{[^}]+\}\}|\b(?:TODO|TBD)\b/i

function cellValue(snapshot: SpreadsheetSnapshot, sheetId: string, address: string): string {
  const sheet = snapshot.worksheets.find((candidate) => candidate.id === sheetId)
  const cell = sheet?.cells.find((candidate) => candidate.address === address)
  return cell ? spreadsheetCellDisplayValue(cell).trim() : ''
}

function insidePrintArea(address: string, range: string): boolean {
  const parsed = parseCellAddress(address)
  const [first, last] = range.split(':').map(parseCellAddress)
  return Boolean(parsed && first && last && parsed.row >= Math.min(first.row, last.row) && parsed.row <= Math.max(first.row, last.row) && parsed.column >= Math.min(first.column, last.column) && parsed.column <= Math.max(first.column, last.column))
}

export function preflightSpreadsheetPdf(snapshot: SpreadsheetSnapshot, request: SpreadsheetPdfRequest): { snapshot: SpreadsheetSnapshot; receipt: SpreadsheetPdfReceipt } {
  const calculated = recalculateSpreadsheet(snapshot)
  const sheet = calculated.snapshot.worksheets.find((candidate) => candidate.id === request.sheetId)
  const issues: SpreadsheetPdfIssue[] = calculated.issues.map((issue) => ({ severity: 'error', code: 'formula_error', message: `${issue.address} contains ${issue.error}`, address: issue.address }))
  if (!sheet) {
    return { snapshot: calculated.snapshot, receipt: { sheetId: request.sheetId, sheetName: '', printArea: request.printArea, expectedPageCount: request.expectedPageCount, renderer: 'libreoffice', issues: [{ severity: 'error', code: 'sheet_missing', message: 'The selected worksheet does not exist.' }] } }
  }
  if (!addressesInRange(request.printArea).length) issues.push({ severity: 'error', code: 'print_area_invalid', message: 'The selected print area is invalid.' })
  if (request.preset === 'invoice') {
    if (sheet.name !== 'Invoice') issues.push({ severity: 'error', code: 'invoice_sheet_required', message: 'Invoice PDF export requires the Invoice worksheet.' })
    if (request.printArea !== 'A1:H48') issues.push({ severity: 'error', code: 'invoice_print_area', message: 'Invoice PDF export requires print area A1:H48.' })
    const required = [
      ['G6', 'Invoice number'], ['G7', 'Issue date'], ['A14', 'Customer or company'], ['E14', 'Project or service'],
      ['B21', 'At least one line item'], ['A35', 'Payment provider'], ['A39', 'Payment instructions'],
    ] as const
    for (const [address, label] of required) if (!cellValue(calculated.snapshot, sheet.id, address)) issues.push({ severity: 'error', code: 'invoice_required_field', message: `${label} is required.`, address })
    if (!sheet.images.length) issues.push({ severity: 'error', code: 'invoice_logo_missing', message: 'The invoice logo is missing.' })
    if (sheet.print.paperSize !== 'A4' || sheet.print.orientation !== 'portrait' || sheet.print.fitToWidth !== 1 || sheet.print.fitToHeight !== 1) issues.push({ severity: 'error', code: 'invoice_page_setup', message: 'Invoice page setup must be A4 portrait and fit to one page.' })
    const margins = sheet.print.margins
    if (Math.abs(margins.leftIn - 0.35) > 0.01 || Math.abs(margins.rightIn - 0.35) > 0.01 || Math.abs(margins.topIn - 0.25) > 0.01 || Math.abs(margins.bottomIn - 0.25) > 0.01) issues.push({ severity: 'error', code: 'invoice_margins', message: 'Invoice margins do not match the admitted preset.' })
    for (const cell of sheet.cells) {
      const display = spreadsheetCellDisplayValue(cell).trim()
      if (display && PLACEHOLDER.test(display)) issues.push({ severity: 'error', code: 'invoice_placeholder', message: 'Replace or clear the placeholder before PDF export.', address: cell.address })
      const parsedAddress = parseCellAddress(cell.address)
      const admittedFooter = parsedAddress?.row === 50 && display.startsWith('USEBRIAN.AI')
      if (display && !insidePrintArea(cell.address, request.printArea) && !admittedFooter) issues.push({ severity: 'error', code: 'outside_print_area', message: 'Nonblank content exists outside the invoice print area.', address: cell.address })
    }
    const total = Number(cellValue(calculated.snapshot, sheet.id, 'H37'))
    const balance = Number(cellValue(calculated.snapshot, sheet.id, 'H39'))
    if (Number.isFinite(total) && total < 0 || Number.isFinite(balance) && balance < 0) issues.push({ severity: 'warning', code: 'negative_total', message: 'The invoice contains a negative total or balance.' })
    const paid = Number(cellValue(calculated.snapshot, sheet.id, 'H38'))
    if (Number.isFinite(total) && Number.isFinite(paid) && paid > total) issues.push({ severity: 'warning', code: 'overpayment', message: 'Amount paid is greater than the invoice total.' })
  }
  return { snapshot: calculated.snapshot, receipt: { sheetId: sheet.id, sheetName: sheet.name, printArea: request.printArea, expectedPageCount: request.expectedPageCount, renderer: 'libreoffice', issues } }
}

/** XLSX bytes → PDF bytes through the shared isolated LibreOffice runner
 *  (`files/libreoffice.ts`); failures are typed `LibreOfficeError`s. */
async function convertToPdf(input: Uint8Array): Promise<Uint8Array> {
  return convertToPdfWithLibreOffice(input, { inputName: 'workbook.xlsx', tempPrefix: 'brian-spreadsheet-pdf-' })
}

async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  return renderedPdfPageCount(bytes)
}

export async function exportOfficeSpreadsheetPdf(snapshot: SpreadsheetSnapshot, request: SpreadsheetPdfRequest, resolveResource: OfficeResourceResolver = async () => null): Promise<{ bytes?: Uint8Array; mime: 'application/pdf'; receipt: SpreadsheetPdfReceipt }> {
  const preflight = preflightSpreadsheetPdf(snapshot, request)
  if (preflight.receipt.issues.some((issue) => issue.severity === 'error')) return { mime: 'application/pdf', receipt: preflight.receipt }
  const selected = preflight.snapshot.worksheets.find((sheet) => sheet.id === request.sheetId)!
  const exportSnapshot: SpreadsheetSnapshot = {
    ...preflight.snapshot,
    activeSheetId: selected.id,
    worksheets: preflight.snapshot.worksheets.map((sheet) => sheet.id === selected.id ? { ...sheet, visibility: 'visible', print: { ...sheet.print, printArea: request.printArea } } : { ...sheet, visibility: 'veryHidden' }),
  }
  const xlsx = await exportOfficeSpreadsheet(exportSnapshot, resolveResource)
  const bytes = await convertToPdf(xlsx.bytes)
  const actualPageCount = await pdfPageCount(bytes)
  const receipt = { ...preflight.receipt, actualPageCount, issues: actualPageCount === request.expectedPageCount ? preflight.receipt.issues : [...preflight.receipt.issues, { severity: 'error' as const, code: 'page_count_mismatch', message: `Expected ${request.expectedPageCount} PDF page(s), but the renderer produced ${actualPageCount}.` }] }
  return receipt.issues.some((issue) => issue.severity === 'error') ? { mime: 'application/pdf', receipt } : { bytes, mime: 'application/pdf', receipt }
}
