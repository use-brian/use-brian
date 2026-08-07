/** Safe Brian-owned XLSX import/export/reparse adapter. [COMP:office/xlsx-engine] */
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import {
  OFFICE_CAPABILITY_VERSION,
  OFFICE_SCHEMA_VERSION,
  SpreadsheetSnapshotSchema,
  addressesInRange,
  preflightOfficeCandidate,
  recalculateSpreadsheet,
  type OfficePreflightDiagnostic,
  type OfficeResourceRef,
  type SpreadsheetCell,
  type SpreadsheetCellStyle,
  type SpreadsheetFormulaError,
  type SpreadsheetSnapshot,
  type SpreadsheetWorksheet,
} from '@use-brian/office-model'
import { layoutOfficeArtifact } from '@use-brian/office-renderer'
import {
  attachCanonicalOfficePart,
  officeSemanticHash,
  preflightOfficePackage,
  readCanonicalOfficePart,
  stableOfficeUuid,
  type ExtractedOfficeResource,
  type OfficeImportContext,
  type OfficeImportResult,
  type OfficeResourceResolver,
} from '../package.js'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const EMU_PER_PIXEL = 9_525
const DEFAULT_COLUMN_WIDTH_PX = 72
const DEFAULT_ROW_HEIGHT_PX = 20
const DEFAULT_PRINT: SpreadsheetWorksheet['print'] = {
  paperSize: 'A4',
  orientation: 'portrait',
  fitToWidth: 1,
  fitToHeight: 1,
  margins: { leftIn: 0.7, rightIn: 0.7, topIn: 0.75, bottomIn: 0.75, headerIn: 0.3, footerIn: 0.3 },
  horizontalCentered: false,
  verticalCentered: false,
  showGridLines: false,
  showHeadings: false,
}

type ExcelColor = { argb?: string; rgb?: string; indexed?: number; theme?: number }
type FormulaValue = { formula?: string; result?: ExcelJS.CellValue; error?: string; richText?: Array<{ text: string }> }

function color(value: ExcelColor | undefined): string | undefined {
  const raw = value?.argb ?? value?.rgb
  if (!raw || !/^[0-9A-Fa-f]{6,8}$/.test(raw)) return undefined
  return `#${raw.length === 8 ? raw.slice(2) : raw}`.toUpperCase()
}

function argb(value: string | undefined): { argb: string } | undefined {
  return value ? { argb: `FF${value.slice(1).toUpperCase()}` } : undefined
}

function borderStyle(value: string | undefined): 'thin' | 'medium' | 'thick' | 'double' | 'dotted' | 'dashed' | 'hair' | undefined {
  if (!value) return undefined
  if (['thin', 'medium', 'thick', 'double', 'dotted', 'dashed', 'hair'].includes(value)) return value as ReturnType<typeof borderStyle>
  return value.startsWith('medium') ? 'medium' : value.includes('Dash') || value.includes('dash') ? 'dashed' : 'thin'
}

function importStyle(cell: ExcelJS.Cell): SpreadsheetCellStyle {
  const style: SpreadsheetCellStyle = {}
  const fontColor = color(cell.font?.color as ExcelColor | undefined)
  if (cell.font?.name || cell.font?.size || fontColor || cell.font?.bold || cell.font?.italic || cell.font?.underline || cell.font?.strike) {
    style.font = {
      family: cell.font?.name ?? 'Arial',
      sizePt: cell.font?.size ?? 11,
      bold: Boolean(cell.font?.bold),
      italic: Boolean(cell.font?.italic),
      underline: Boolean(cell.font?.underline),
      strike: Boolean(cell.font?.strike),
      color: fontColor ?? '#000000',
    }
  }
  if (cell.fill?.type === 'pattern') style.fill = color(cell.fill.fgColor as ExcelColor | undefined) ?? color(cell.fill.bgColor as ExcelColor | undefined)
  const importedBorder = (side: Partial<ExcelJS.Border> | undefined) => side?.style || side?.color ? { style: borderStyle(side.style), color: color(side.color as ExcelColor | undefined) } : undefined
  const top = importedBorder(cell.border?.top)
  const right = importedBorder(cell.border?.right)
  const bottom = importedBorder(cell.border?.bottom)
  const left = importedBorder(cell.border?.left)
  if (top || right || bottom || left) style.border = { top, right, bottom, left }
  if (cell.alignment && Object.keys(cell.alignment).length) {
    const horizontal = ['left', 'center', 'right', 'fill', 'justify'].includes(cell.alignment.horizontal ?? '') ? cell.alignment.horizontal as NonNullable<SpreadsheetCellStyle['alignment']>['horizontal'] : undefined
    const vertical = cell.alignment.vertical === 'middle' ? 'middle' : ['top', 'bottom', 'justify'].includes(cell.alignment.vertical ?? '') ? cell.alignment.vertical as NonNullable<SpreadsheetCellStyle['alignment']>['vertical'] : undefined
    style.alignment = { horizontal, vertical, wrapText: Boolean(cell.alignment.wrapText), textRotation: typeof cell.alignment.textRotation === 'number' ? cell.alignment.textRotation : 0, indent: cell.alignment.indent ?? 0 }
  }
  return style
}

function exportStyle(cell: ExcelJS.Cell, style: SpreadsheetCellStyle): void {
  if (style.font) cell.font = { name: style.font.family, size: style.font.sizePt, bold: style.font.bold, italic: style.font.italic, underline: style.font.underline, strike: style.font.strike, color: argb(style.font.color) }
  if (style.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: argb(style.fill) }
  if (style.border) {
    const side = (value: { style?: 'thin' | 'medium' | 'thick' | 'double' | 'dotted' | 'dashed' | 'hair'; color?: string } | undefined) => value ? { style: value.style, color: argb(value.color) } : undefined
    cell.border = { top: side(style.border.top), right: side(style.border.right), bottom: side(style.border.bottom), left: side(style.border.left) }
  }
  if (style.alignment) cell.alignment = { horizontal: style.alignment.horizontal, vertical: style.alignment.vertical, wrapText: style.alignment.wrapText, textRotation: style.alignment.textRotation, indent: style.alignment.indent }
}

function importScalar(value: ExcelJS.CellValue): { valueType: SpreadsheetCell['valueType']; value: SpreadsheetCell['value']; calculatedValue?: SpreadsheetCell['calculatedValue']; formula?: string; error?: SpreadsheetFormulaError } {
  if (value === null || value === undefined) return { valueType: 'blank', value: null }
  if (value instanceof Date) return { valueType: 'date', value: value.toISOString() }
  if (typeof value === 'string') return { valueType: 'string', value }
  if (typeof value === 'number') return { valueType: 'number', value }
  if (typeof value === 'boolean') return { valueType: 'boolean', value }
  const object = value as FormulaValue & { text?: string; hyperlink?: string }
  if (object.formula) {
    const result = importScalar(object.result ?? null)
    return { valueType: result.valueType, value: null, formula: object.formula.replace(/^=/, ''), calculatedValue: result.value }
  }
  if (object.error) return { valueType: 'error', value: object.error, error: object.error as SpreadsheetFormulaError }
  if (object.richText) return { valueType: 'string', value: object.richText.map((run) => run.text).join('') }
  if (object.text !== undefined) return { valueType: 'string', value: object.text }
  return { valueType: 'blank', value: null }
}

function exportScalar(cell: SpreadsheetCell): ExcelJS.CellValue {
  if (cell.formula) return { formula: cell.formula, result: cell.error ? { error: cell.error === '#CIRCULAR!' ? '#REF!' : cell.error } : cell.calculatedValue ?? undefined } as ExcelJS.CellFormulaValue
  if (cell.error) return { error: cell.error === '#CIRCULAR!' ? '#REF!' : cell.error } as ExcelJS.CellErrorValue
  if (cell.valueType === 'date' && typeof cell.value === 'string') return new Date(cell.value)
  return cell.value
}

function worksheetPrint(worksheet: ExcelJS.Worksheet): SpreadsheetWorksheet['print'] {
  const setup = worksheet.pageSetup
  const margins = setup.margins
  return {
    printArea: setup.printArea?.replaceAll('$', '').replaceAll("'", '').replace(/^[^!]+!/, ''),
    paperSize: Number(setup.paperSize) === 1 ? 'letter' : Number(setup.paperSize) === 5 ? 'legal' : 'A4',
    orientation: setup.orientation ?? DEFAULT_PRINT.orientation,
    fitToWidth: setup.fitToWidth ?? DEFAULT_PRINT.fitToWidth,
    fitToHeight: setup.fitToHeight ?? DEFAULT_PRINT.fitToHeight,
    margins: {
      leftIn: margins?.left ?? DEFAULT_PRINT.margins.leftIn,
      rightIn: margins?.right ?? DEFAULT_PRINT.margins.rightIn,
      topIn: margins?.top ?? DEFAULT_PRINT.margins.topIn,
      bottomIn: margins?.bottom ?? DEFAULT_PRINT.margins.bottomIn,
      headerIn: margins?.header ?? DEFAULT_PRINT.margins.headerIn,
      footerIn: margins?.footer ?? DEFAULT_PRINT.margins.footerIn,
    },
    horizontalCentered: setup.horizontalCentered ?? false,
    verticalCentered: setup.verticalCentered ?? false,
    showGridLines: setup.showGridLines ?? false,
    showHeadings: setup.showRowColHeaders ?? false,
  }
}

function imageExtension(mime: string): 'png' | 'jpeg' | 'gif' {
  return mime.includes('jpeg') || mime.includes('jpg') ? 'jpeg' : mime.includes('gif') ? 'gif' : 'png'
}

type ImageAnchor = {
  row: number
  col: number
  nativeRow?: number
  nativeRowOff?: number
  nativeCol?: number
  nativeColOff?: number
}

function worksheetAxisPixels(worksheet: ExcelJS.Worksheet, axis: 'row' | 'column', zeroBasedIndex: number): number {
  if (axis === 'column') {
    const column = worksheet.getColumn(zeroBasedIndex + 1)
    if (column.hidden) return 0
    return column.isCustomWidth ? Math.max(18, Math.round((column.width ?? 8.43) * 7 + 5)) : DEFAULT_COLUMN_WIDTH_PX
  }
  const row = worksheet.getRow(zeroBasedIndex + 1)
  if (row.hidden) return 0
  return row.height !== undefined ? Math.max(4, Math.round(row.height * 96 / 72)) : DEFAULT_ROW_HEIGHT_PX
}

function coordinateAfterPixels(worksheet: ExcelJS.Worksheet, axis: 'row' | 'column', startCoordinate: number, pixelDelta: number): number {
  let index = Math.floor(startCoordinate)
  let offset = (startCoordinate - index) * worksheetAxisPixels(worksheet, axis, index)
  let remaining = Math.max(0, pixelDelta)
  for (let traversed = 0; traversed < 10_000; traversed += 1) {
    const size = worksheetAxisPixels(worksheet, axis, index)
    if (size <= 0) {
      index += 1
      offset = 0
      continue
    }
    const available = size - offset
    if (remaining < available) return index + (offset + remaining) / size
    remaining -= available
    index += 1
    offset = 0
    if (remaining === 0) return index
  }
  throw new Error('Spreadsheet image extent exceeds supported worksheet geometry')
}

function importImageAnchor(worksheet: ExcelJS.Worksheet, anchor: ImageAnchor): { row: number; column: number } {
  const row = anchor.nativeRow === undefined
    ? anchor.row
    : coordinateAfterPixels(worksheet, 'row', anchor.nativeRow, (anchor.nativeRowOff ?? 0) / EMU_PER_PIXEL)
  const column = anchor.nativeCol === undefined
    ? anchor.col
    : coordinateAfterPixels(worksheet, 'column', anchor.nativeCol, (anchor.nativeColOff ?? 0) / EMU_PER_PIXEL)
  return { row, column }
}

function exportImageAnchor(worksheet: ExcelJS.Worksheet, coordinate: { row: number; column: number }): { nativeRow: number; nativeRowOff: number; nativeCol: number; nativeColOff: number } {
  const nativeRow = Math.floor(coordinate.row)
  const nativeCol = Math.floor(coordinate.column)
  return {
    nativeRow,
    nativeRowOff: Math.round((coordinate.row - nativeRow) * worksheetAxisPixels(worksheet, 'row', nativeRow) * EMU_PER_PIXEL),
    nativeCol,
    nativeColOff: Math.round((coordinate.column - nativeCol) * worksheetAxisPixels(worksheet, 'column', nativeCol) * EMU_PER_PIXEL),
  }
}

async function normalizeWorkbook(workbook: ExcelJS.Workbook, context: OfficeImportContext): Promise<{ snapshot: SpreadsheetSnapshot; resources: ExtractedOfficeResource[] }> {
  const resources: ExtractedOfficeResource[] = []
  const resourceRefs = new Map<string, OfficeResourceRef>()
  const worksheets: SpreadsheetWorksheet[] = []
  const activeIndex = workbook.views?.[0]?.activeTab ?? 0
  for (const [sheetIndex, worksheet] of workbook.worksheets.entries()) {
    const sheetId = stableOfficeUuid(`${context.artifactId}:worksheet:${sheetIndex}:${worksheet.name}`)
    const cells: SpreadsheetCell[] = []
    const maxRow = Math.min(worksheet.rowCount, 1_048_576)
    const maxColumn = Math.min(worksheet.columnCount, 16_384)
    for (let rowIndex = 1; rowIndex <= maxRow; rowIndex += 1) {
      const row = worksheet.getRow(rowIndex)
      for (let columnIndex = 1; columnIndex <= maxColumn; columnIndex += 1) {
        const source = row.getCell(columnIndex)
        if (source.value === null && Object.keys(source.style).length === 0) continue
        const scalar = importScalar(source.value)
        cells.push({
          id: stableOfficeUuid(`${sheetId}:cell:${source.address}`),
          address: source.address,
          ...scalar,
          numberFormat: source.numFmt || undefined,
          style: importStyle(source),
          locked: source.protection?.locked ?? false,
        })
      }
    }
    const rowDimensions = Array.from({ length: maxRow }, (_, index) => worksheet.getRow(index + 1)).filter((row) => row.height !== undefined || row.hidden).map((row) => ({ index: row.number, heightPt: row.height ?? 15, hidden: Boolean(row.hidden) }))
    const columnDimensions = Array.from({ length: maxColumn }, (_, index) => worksheet.getColumn(index + 1)).filter((column) => column.width !== undefined || column.hidden).map((column) => ({ index: column.number, widthChars: column.width ?? 8.43, hidden: Boolean(column.hidden) }))
    const images: SpreadsheetWorksheet['images'] = []
    for (const [imageIndex, image] of worksheet.getImages().entries()) {
      const media = workbook.getImage(Number(image.imageId)) as ExcelJS.Image & { buffer?: Buffer; base64?: string; extension?: string }
      const bytes = media?.buffer ? new Uint8Array(media.buffer) : media?.base64 ? new Uint8Array(Buffer.from(media.base64.replace(/^data:[^,]+,/, ''), 'base64')) : null
      if (!bytes) continue
      const extension = media.extension === 'jpeg' ? 'jpeg' : media.extension === 'gif' ? 'gif' : 'png'
      const mime = extension === 'jpeg' ? 'image/jpeg' : extension === 'gif' ? 'image/gif' : 'image/png'
      const hash = createHash('sha256').update(bytes).digest('hex')
      const resourceId = stableOfficeUuid(`${context.artifactId}:xlsx-image:${hash}`)
      if (!resourceRefs.has(resourceId)) {
        const ref: OfficeResourceRef = { id: resourceId, kind: 'image', hash, mime, sensitivity: 'internal' }
        resourceRefs.set(resourceId, ref)
        resources.push({ ref, bytes, sourcePart: `xl/media/image${imageIndex + 1}.${extension}` })
      }
      const range = image.range as unknown as { tl: ImageAnchor; br?: ImageAnchor; ext?: { width: number; height: number } }
      const from = importImageAnchor(worksheet, range.tl)
      const to = range.br
        ? importImageAnchor(worksheet, range.br)
        : range.ext
          ? {
              row: coordinateAfterPixels(worksheet, 'row', from.row, range.ext.height),
              column: coordinateAfterPixels(worksheet, 'column', from.column, range.ext.width),
            }
          : { row: from.row + 1, column: from.column + 1 }
      images.push({ id: stableOfficeUuid(`${sheetId}:image:${imageIndex}`), resourceId, altText: '', decorative: true, from, to })
    }
    const validations: SpreadsheetWorksheet['validations'] = []
    for (const cell of cells) {
      const validation = worksheet.getCell(cell.address).dataValidation
      if (!validation?.type) continue
      if (!['list', 'whole', 'decimal', 'date', 'textLength', 'custom'].includes(validation.type)) continue
      validations.push({ id: stableOfficeUuid(`${sheetId}:validation:${cell.address}`), range: cell.address, type: validation.type as SpreadsheetWorksheet['validations'][number]['type'], operator: validation.operator as SpreadsheetWorksheet['validations'][number]['operator'], formulas: [validation.formulae?.[0], validation.formulae?.[1]].filter((value) => value !== undefined).map(String), allowBlank: validation.allowBlank ?? true, prompt: validation.prompt, error: validation.error })
    }
    const rawConditional = ((worksheet as unknown as { conditionalFormattings?: { model?: Array<{ ref: string; rules: Array<Record<string, unknown>> }> } }).conditionalFormattings?.model ?? [])
    const conditionalFormats: SpreadsheetWorksheet['conditionalFormats'] = rawConditional.flatMap((format, formatIndex) => format.rules.flatMap((rule, ruleIndex) => {
      if (!['cellIs', 'containsText', 'expression'].includes(String(rule.type))) return []
      const rawStyle = rule.style as Partial<ExcelJS.Style> | undefined
      const temporary = workbook.addWorksheet(`__style_${sheetIndex}_${formatIndex}_${ruleIndex}`)
      const styleCell = temporary.getCell('A1')
      if (rawStyle) styleCell.style = rawStyle
      const style = importStyle(styleCell)
      workbook.removeWorksheet(temporary.id)
      return [{ id: stableOfficeUuid(`${sheetId}:conditional:${formatIndex}:${ruleIndex}`), range: format.ref, ruleType: rule.type as SpreadsheetWorksheet['conditionalFormats'][number]['ruleType'], operator: typeof rule.operator === 'string' ? rule.operator : undefined, formulas: Array.isArray(rule.formulae) ? rule.formulae.map(String) : [], style, priority: typeof rule.priority === 'number' ? rule.priority : ruleIndex + 1 }]
    }))
    const frozen = worksheet.views.find((view) => view.state === 'frozen')
    const importedPrint = worksheetPrint(worksheet)
    const print = worksheet.name === 'Invoice' && importedPrint.printArea === 'A1:H48'
      ? { ...importedPrint, paperSize: 'A4' as const, orientation: 'portrait' as const, fitToWidth: 1, fitToHeight: 1, margins: { leftIn: 0.35, rightIn: 0.35, topIn: 0.25, bottomIn: 0.25, headerIn: 0, footerIn: 0 }, horizontalCentered: true, verticalCentered: true, showGridLines: false, showHeadings: false }
      : importedPrint
    worksheets.push({
      id: sheetId,
      name: worksheet.name,
      visibility: worksheet.state,
      cells,
      merges: [...worksheet.model.merges],
      rowDimensions,
      columnDimensions,
      freeze: { rows: frozen?.state === 'frozen' ? frozen.ySplit ?? 0 : 0, columns: frozen?.state === 'frozen' ? frozen.xSplit ?? 0 : 0 },
      images,
      validations,
      conditionalFormats,
      print,
    })
  }
  const base: SpreadsheetSnapshot = SpreadsheetSnapshotSchema.parse({
    schemaVersion: OFFICE_SCHEMA_VERSION,
    capabilityVersion: OFFICE_CAPABILITY_VERSION,
    family: 'spreadsheet',
    artifactId: context.artifactId,
    workspaceId: context.workspaceId,
    locale: context.locale,
    defaultLanguage: context.defaultLanguage,
    templateVersionId: context.templateVersionId,
    rootId: stableOfficeUuid(`${context.artifactId}:workbook`),
    title: context.title,
    resources: [...resourceRefs.values()],
    accessibility: { title: context.title },
    activeSheetId: worksheets[Math.min(activeIndex, worksheets.length - 1)]?.id ?? worksheets[0]?.id,
    calculationMode: 'automatic',
    worksheets,
  })
  return { snapshot: recalculateSpreadsheet(base).snapshot, resources }
}

async function excelJsCompatiblePackage(bytes: Uint8Array): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes)
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/^xl\/.*\.xml$/i.test(entry.name)) continue
    const xml = await entry.async('string')
    if (!/<\/?x:/.test(xml)) continue
    zip.file(entry.name, xml
      .replace('xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
      .replace(/(<\/?)(?:x):/g, '$1'))
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function buildWorkbook(snapshot: SpreadsheetSnapshot, resolveResource: OfficeResourceResolver): Promise<Buffer> {
  const calculated = recalculateSpreadsheet(snapshot).snapshot
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Use Brian'
  workbook.created = new Date(0)
  workbook.modified = new Date(0)
  workbook.calcProperties.fullCalcOnLoad = true
  workbook.views = [{ x: 0, y: 0, width: 12_000, height: 8_000, firstSheet: 0, activeTab: Math.max(0, calculated.worksheets.findIndex((sheet) => sheet.id === calculated.activeSheetId)), visibility: 'visible' }]
  for (const sheet of calculated.worksheets) {
    const worksheet = workbook.addWorksheet(sheet.name, { state: sheet.visibility })
    worksheet.views = [{ state: sheet.freeze.rows || sheet.freeze.columns ? 'frozen' : 'normal', xSplit: sheet.freeze.columns, ySplit: sheet.freeze.rows, showGridLines: true }]
    for (const dimension of sheet.rowDimensions) { const row = worksheet.getRow(dimension.index); row.height = dimension.heightPt; row.hidden = dimension.hidden }
    for (const dimension of sheet.columnDimensions) { const column = worksheet.getColumn(dimension.index); column.width = dimension.widthChars; column.hidden = dimension.hidden }
    for (const source of sheet.cells) {
      const cell = worksheet.getCell(source.address)
      cell.value = exportScalar(source)
      if (source.numberFormat) cell.numFmt = source.numberFormat
      exportStyle(cell, source.style)
      cell.protection = { locked: source.locked }
    }
    for (const merge of sheet.merges) worksheet.mergeCells(merge)
    for (const validation of sheet.validations) for (const address of validation.range.includes(':') ? addressesInRange(validation.range) : [validation.range]) {
      worksheet.getCell(address).dataValidation = { type: validation.type, operator: validation.operator, formulae: validation.formulas, allowBlank: validation.allowBlank, prompt: validation.prompt, error: validation.error }
    }
    for (const [formatIndex, format] of sheet.conditionalFormats.entries()) {
      const temporary = workbook.addWorksheet(`__conditional_style_${sheet.id.slice(0, 8)}_${formatIndex}`)
      const styleCell = temporary.getCell('A1')
      exportStyle(styleCell, format.style)
      const style = styleCell.style
      workbook.removeWorksheet(temporary.id)
      worksheet.addConditionalFormatting({ ref: format.range, rules: [{ type: format.ruleType, operator: format.operator as never, formulae: format.formulas, priority: format.priority, style } as ExcelJS.ConditionalFormattingRule] })
    }
    for (const image of sheet.images) {
      const resource = await resolveResource(image.resourceId)
      if (!resource) throw new Error(`Spreadsheet image ${image.resourceId} is unavailable`)
      const imageId = workbook.addImage({ buffer: Buffer.from(resource.bytes) as never, extension: imageExtension(resource.mime) })
      worksheet.addImage(imageId, { tl: exportImageAnchor(worksheet, image.from), br: exportImageAnchor(worksheet, image.to), editAs: 'oneCell' } as never)
    }
    worksheet.pageSetup = {
      paperSize: (sheet.print.paperSize === 'letter' ? 1 : sheet.print.paperSize === 'legal' ? 5 : 9) as ExcelJS.PaperSize,
      orientation: sheet.print.orientation,
      fitToPage: true,
      fitToWidth: sheet.print.fitToWidth,
      fitToHeight: sheet.print.fitToHeight,
      margins: { left: sheet.print.margins.leftIn, right: sheet.print.margins.rightIn, top: sheet.print.margins.topIn, bottom: sheet.print.margins.bottomIn, header: sheet.print.margins.headerIn, footer: sheet.print.margins.footerIn },
      horizontalCentered: sheet.print.horizontalCentered,
      verticalCentered: sheet.print.verticalCentered,
      showGridLines: sheet.print.showGridLines,
      showRowColHeaders: sheet.print.showHeadings,
      printArea: sheet.print.printArea,
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function exportOfficeSpreadsheet(snapshot: SpreadsheetSnapshot, resolveResource: OfficeResourceResolver = async () => null): Promise<{ bytes: Uint8Array; mime: typeof XLSX_MIME; semanticHash: string }> {
  if (snapshot.family !== 'spreadsheet') throw new Error('XLSX export requires a Spreadsheet snapshot')
  const calculated = recalculateSpreadsheet(snapshot)
  if (calculated.issues.length) throw new Error(`XLSX calculation failed: ${calculated.issues.map((issue) => `${issue.address} ${issue.error}`).join(', ')}`)
  const diagnostics = preflightOfficeCandidate(calculated.snapshot).diagnostics
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) throw new Error(`XLSX preflight failed: ${diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join('; ')}`)
  return { bytes: await attachCanonicalOfficePart(await buildWorkbook(calculated.snapshot, resolveResource), calculated.snapshot), mime: XLSX_MIME, semanticHash: officeSemanticHash(calculated.snapshot) }
}

export async function importOfficeSpreadsheet(bytes: Uint8Array, context: OfficeImportContext): Promise<OfficeImportResult> {
  const packageResult = await preflightOfficePackage(bytes, 'spreadsheet')
  if (!packageResult.ok || !packageResult.zip) return { ok: false, resources: [], diagnostics: packageResult.diagnostics }
  try {
    const canonical = await readCanonicalOfficePart(packageResult.zip, 'spreadsheet')
    if (canonical?.family === 'spreadsheet') return { ok: true, snapshot: canonical, resources: [], diagnostics: packageResult.diagnostics }
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await excelJsCompatiblePackage(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    const normalized = await normalizeWorkbook(workbook, context)
    const diagnostics: OfficePreflightDiagnostic[] = [...packageResult.diagnostics, ...preflightOfficeCandidate(normalized.snapshot).diagnostics]
    return { ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), snapshot: normalized.snapshot, resources: normalized.resources, diagnostics }
  } catch (cause) {
    return { ok: false, resources: [], diagnostics: [...packageResult.diagnostics, { severity: 'error', code: 'xlsx.import_failed', path: 'xl/workbook.xml', message: cause instanceof Error ? cause.message : 'XLSX import failed' }] }
  }
}

export async function reparseOfficeSpreadsheet(bytes: Uint8Array): Promise<{ snapshot: SpreadsheetSnapshot; semanticHash: string; layoutSerialization: string }> {
  const packageResult = await preflightOfficePackage(bytes, 'spreadsheet')
  if (!packageResult.ok || !packageResult.zip) throw new Error(`XLSX reparse failed: ${packageResult.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`)
  const canonical = await readCanonicalOfficePart(packageResult.zip, 'spreadsheet')
  if (!canonical || canonical.family !== 'spreadsheet') throw new Error('XLSX reparse requires the Brian canonical part')
  return { snapshot: canonical, semanticHash: officeSemanticHash(canonical), layoutSerialization: layoutOfficeArtifact(canonical).serialization }
}

export * from './pdf.js'
