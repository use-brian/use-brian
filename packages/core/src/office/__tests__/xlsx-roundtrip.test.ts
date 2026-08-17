import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { exportOfficeSpreadsheet, importOfficeSpreadsheet, reparseOfficeSpreadsheet } from '../xlsx/index.js'
import { preflightSpreadsheetPdf } from '../xlsx/pdf.js'
import { completeSpreadsheetSnapshot, id, resolveFixtureResource } from './fixtures.js'

describe('[COMP:office/xlsx-engine] XLSX engine', () => {
  it('exports, safely reparses, and preserves canonical workbook semantics', async () => {
    const source = completeSpreadsheetSnapshot()
    const exported = await exportOfficeSpreadsheet(source, resolveFixtureResource)
    const imported = await importOfficeSpreadsheet(exported.bytes, { artifactId: source.artifactId, workspaceId: source.workspaceId, templateVersionId: source.templateVersionId, locale: source.locale, defaultLanguage: source.defaultLanguage, title: source.title })
    const reopened = await reparseOfficeSpreadsheet(exported.bytes)
    if (!imported.ok) throw new Error(JSON.stringify(imported.diagnostics))
    expect(imported.snapshot).toEqual(source)
    expect(reopened.snapshot).toEqual(source)
    expect(reopened.semanticHash).toBe(exported.semanticHash)
    const zip = await JSZip.loadAsync(exported.bytes)
    expect(zip.file('xl/workbook.xml')).not.toBeNull()
    expect(zip.file('customXml/brian-office.json')).not.toBeNull()
  })

  it('imports a conventional workbook with formulas, dimensions, merges, validation, and print settings', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Invoice')
    sheet.getCell('A1').value = 'Invoice'
    sheet.getCell('A1').font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FF10202C' } }
    sheet.mergeCells('A1:C1')
    sheet.getCell('A2').value = 2
    sheet.getCell('B2').value = 3
    sheet.getCell('C2').value = { formula: 'ROUND(A2*B2,2)', result: 6 }
    sheet.getColumn(1).width = 24
    sheet.getRow(1).height = 28
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.getCell('A2').dataValidation = { type: 'whole', operator: 'between', formulae: [0, 100] }
    sheet.pageSetup = { printArea: 'A1:C20', paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left: 0.35, right: 0.35, top: 0.25, bottom: 0.25, header: 0, footer: 0 } }
    const result = await importOfficeSpreadsheet(new Uint8Array(await workbook.xlsx.writeBuffer()), { artifactId: id(120), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Imported invoice' })
    expect(result.ok).toBe(true)
    expect(result.snapshot?.family).toBe('spreadsheet')
    if (result.snapshot?.family !== 'spreadsheet') throw new Error('Expected spreadsheet')
    expect(result.snapshot.worksheets[0].merges).toEqual(['A1:C1'])
    expect(result.snapshot.worksheets[0].cells.find((cell) => cell.address === 'C2')?.calculatedValue).toBe(6)
    expect(result.snapshot.worksheets[0].columnDimensions).toContainEqual(expect.objectContaining({ index: 1, widthChars: 24 }))
    expect(result.snapshot.worksheets[0].validations).toContainEqual(expect.objectContaining({ range: 'A2', type: 'whole' }))
  })

  it('preserves one-cell image offsets and pixel extents as fractional cell anchors', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Invoice')
    sheet.getCell('A1').value = 'Use Brian'
    sheet.getColumn(1).width = 3
    sheet.getRow(2).height = 15
    sheet.views = [{ state: 'normal' }]
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    const imageId = workbook.addImage({ buffer: png as never, extension: 'png' })
    sheet.addImage(imageId, {
      tl: { nativeCol: 0, nativeColOff: 2 * 9_525, nativeRow: 1, nativeRowOff: 4 * 9_525 },
      ext: { width: 16, height: 16 },
      editAs: 'oneCell',
    } as never)

    const imported = await importOfficeSpreadsheet(new Uint8Array(await workbook.xlsx.writeBuffer()), { artifactId: id(122), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Logo invoice' })
    if (!imported.ok) throw new Error(JSON.stringify(imported.diagnostics))
    if (imported.snapshot?.family !== 'spreadsheet') throw new Error('Expected spreadsheet')
    const image = imported.snapshot.worksheets[0].images[0]
    expect(image.from.column).toBeCloseTo(2 / 26)
    expect(image.from.row).toBeCloseTo(1.2)
    expect(image.to.column).toBeCloseTo(18 / 26)
    expect(image.to.row).toBe(2)

    const exported = await exportOfficeSpreadsheet(imported.snapshot, async (resourceId) => {
      const resource = imported.resources.find((candidate) => candidate.ref.id === resourceId)
      return resource ? { bytes: resource.bytes, mime: resource.ref.mime } : null
    })
    const reopened = new ExcelJS.Workbook()
    await reopened.xlsx.load(exported.bytes as unknown as Parameters<typeof reopened.xlsx.load>[0])
    const range = reopened.worksheets[0].getImages()[0].range as unknown as {
      tl: { nativeCol: number; nativeColOff: number; nativeRow: number; nativeRowOff: number }
      br: { nativeCol: number; nativeColOff: number; nativeRow: number; nativeRowOff: number }
    }
    expect(range.tl).toMatchObject({ nativeCol: 0, nativeColOff: 2 * 9_525, nativeRow: 1, nativeRowOff: 4 * 9_525 })
    expect(range.br).toMatchObject({ nativeCol: 0, nativeColOff: 18 * 9_525, nativeRow: 2, nativeRowOff: 0 })
  })

  it('rejects executable workbook content before parsing', async () => {
    const source = completeSpreadsheetSnapshot()
    const exported = await exportOfficeSpreadsheet(source, resolveFixtureResource)
    const zip = await JSZip.loadAsync(exported.bytes)
    zip.file('xl/vbaProject.bin', Buffer.from('macro'))
    const rejected = await importOfficeSpreadsheet(await zip.generateAsync({ type: 'uint8array' }), { artifactId: id(121), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Rejected' })
    expect(rejected.ok).toBe(false)
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ code: 'package.active_content' }))
  })

  it('fails closed for accepted-but-unpreserved spreadsheet constructs', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Operations')
    sheet.getCell('A1').value = 'Name'
    sheet.getCell('B1').value = 'Value'
    sheet.getCell('A2').value = { text: 'Use Brian', hyperlink: 'https://example.com' }
    sheet.getCell('B2').value = { richText: [{ text: 'Bold', font: { bold: true } }, { text: ' text' }] }
    sheet.autoFilter = 'A1:B2'
    await sheet.protect('fictional-password', {})
    const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
    zip.file('xl/charts/chart1.xml', '<chartSpace/>')
    zip.file('xl/tables/table1.xml', '<table/>')
    zip.file('xl/comments1.xml', '<comments/>')
    const rejected = await importOfficeSpreadsheet(await zip.generateAsync({ type: 'uint8array' }), { artifactId: id(123), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Rejected constructs' })

    expect(rejected.ok).toBe(false)
    for (const capabilityId of ['spreadsheetChart', 'spreadsheetTable', 'spreadsheetNote', 'spreadsheetHyperlink', 'spreadsheetRichText', 'spreadsheetFilter', 'spreadsheetProtection']) {
      expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ code: 'package.unsupported_construct', capabilityId }))
    }
  })
})

describe('[COMP:office/spreadsheet-pdf] Spreadsheet PDF preflight', () => {
  it('binds PDF release to an explicit worksheet and print area', () => {
    const source = completeSpreadsheetSnapshot()
    const result = preflightSpreadsheetPdf(source, { sheetId: source.activeSheetId, printArea: 'A1:C20', calculationMode: 'automatic', expectedPageCount: 1, preset: 'worksheet' })
    expect(result.receipt).toMatchObject({ sheetId: source.activeSheetId, sheetName: 'Invoice', printArea: 'A1:C20', expectedPageCount: 1, renderer: 'libreoffice' })
    expect(result.receipt.issues).toEqual([])
  })

  it('blocks an invoice PDF when required customer-facing fields are missing', () => {
    const source = completeSpreadsheetSnapshot()
    source.worksheets[0].print.printArea = 'A1:H48'
    const result = preflightSpreadsheetPdf(source, { sheetId: source.activeSheetId, printArea: 'A1:H48', calculationMode: 'automatic', expectedPageCount: 1, preset: 'invoice' })
    expect(result.receipt.issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'invoice_required_field', address: 'G6' }))
  })
})
