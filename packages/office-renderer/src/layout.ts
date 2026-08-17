import {
  officeTableCellPlacements,
  officeTableResolvedColumnWidthsPt,
  parseCellAddress,
  spreadsheetCellDisplayValue,
  type OfficeTable,
  type OfficeTableBorder,
  type OfficeTableCell,
  type SpreadsheetCell,
  type SpreadsheetCellStyle,
  type SpreadsheetSnapshot,
  type SpreadsheetWorksheet,
} from '@use-brian/office-model'
import type {
  DocumentFlowNode,
  DocumentSnapshot,
  OfficeArtifactSnapshot,
  OfficeRichTextRun,
  PresentationObject,
  PresentationSnapshot,
} from '@use-brian/office-model'

export type OfficeDisplayPrimitive = {
  id: string
  kind: 'text' | 'image' | 'rect' | 'line' | 'table' | 'chart' | 'video'
  xPt: number
  yPt: number
  widthPt: number
  heightPt: number
  text?: string
  runs?: OfficeRichTextRun[]
  alignment?: 'start' | 'center' | 'end' | 'justify'
  verticalAlignment?: 'top' | 'middle' | 'bottom'
  lineSpacingPt?: number
  resourceId?: string
  tableRows?: Array<Array<{ runs: OfficeRichTextRun[]; rowSpan: number; colSpan: number; fill?: string }>>
  tableHeaderRows?: number
  documentTable?: OfficeTable
  fillColor?: string
  strokeColor?: string
  strokeWidthPt?: number
  shapeKind?: 'rectangle' | 'roundedRectangle' | 'ellipse' | 'triangle' | 'line'
  chartType?: string
  chartCategories?: string[]
  chartSeries?: Array<{ name: string; values: number[] }>
  spreadsheetStyle?: SpreadsheetCellStyle
  numberFormat?: string
  sourceKind?: string
  z: number
}

export type OfficeDisplayPage = {
  id: string
  widthPt: number
  heightPt: number
  primitives: OfficeDisplayPrimitive[]
}

export type OfficeLayoutIssue = {
  code: 'overflow' | 'collision' | 'readability' | 'missing-resource'
  objectId: string
  message: string
}

export type OfficeLayoutResult = {
  family: 'document' | 'presentation' | 'spreadsheet'
  pages: OfficeDisplayPage[]
  issues: OfficeLayoutIssue[]
  serialization: string
}

export type OfficeFitBudget = {
  maxPages?: number
  maxSlides?: number
  maxWorksheets?: number
  maxTextCharsByObject?: Record<string, number>
  minimumFontSizePt?: number
  /** IDs whose sub-floor typography was admitted from an immutable template. */
  readabilityExemptObjectIds?: readonly string[]
}

export type OfficeFitResult = {
  ok: boolean
  attempts: number
  result: OfficeLayoutResult
  issues: OfficeLayoutIssue[]
}

function textOf(runs: readonly OfficeRichTextRun[]): string {
  return runs.map((run) => run.text).join('')
}

function characterWidthFactor(character: string): number {
  if (/\s/.test(character)) return 0.28
  if (/[ilI1|.,'`:;]/.test(character)) return 0.28
  if (/[mwMW@%&]/.test(character)) return 0.82
  if (/[A-Z0-9]/.test(character)) return 0.6
  return 0.5
}

function lineWidth(runs: readonly OfficeRichTextRun[]): number {
  return runs.reduce((width, run) => width + [...run.text].reduce((sum, character) => sum + run.style.fontSizePt * characterWidthFactor(character), 0), 0)
}

function textLines(runs: readonly OfficeRichTextRun[]): OfficeRichTextRun[][] {
  const lines: OfficeRichTextRun[][] = [[]]
  for (const run of runs) {
    const parts = run.text.split('\n')
    for (const [index, text] of parts.entries()) {
      if (index > 0) lines.push([])
      if (text) lines[lines.length - 1].push({ ...run, text })
    }
  }
  return lines
}

function textMetrics(runs: readonly OfficeRichTextRun[], widthPt: number): { widthPt: number; heightPt: number } {
  const lines = textLines(runs)
  const widths = lines.map(lineWidth)
  const heightPt = lines.reduce((height, line, index) => {
    const font = Math.max(1, ...line.map((run) => run.style.fontSizePt))
    const wraps = Math.max(1, Math.ceil(widths[index] / Math.max(1, widthPt)))
    return height + wraps * font * 1.15
  }, 0)
  return { widthPt: Math.min(widthPt, Math.max(0, ...widths)), heightPt }
}

function textHeight(runs: readonly OfficeRichTextRun[], widthPt: number): number {
  return textMetrics(runs, widthPt).heightPt
}

function documentTableRowHeights(table: OfficeTable, availableWidthPt: number): number[] {
  const widths = officeTableResolvedColumnWidthsPt(table, availableWidthPt)
  const placements = officeTableCellPlacements(table)
  return table.rows.map((row, rowIndex) => {
    const contentHeight = placements.filter((placement) => placement.rowIndex === rowIndex).reduce((height, placement) => {
      const margins = placement.cell.margins ?? table.margins
      const horizontalMargins = (margins?.leftPt ?? 2) + (margins?.rightPt ?? 2)
      const verticalMargins = (margins?.topPt ?? 2) + (margins?.bottomPt ?? 2)
      const cellWidth = widths.slice(placement.startColumn, placement.endColumn).reduce((sum, width) => sum + width, 0)
      return Math.max(height, (textHeight(placement.cell.runs, Math.max(1, cellWidth - horizontalMargins)) + verticalMargins) / placement.cell.rowSpan)
    }, 0)
    return Math.max(row.minHeightPt ?? 0, contentHeight, 12)
  })
}

function textInkBounds(object: Extract<PresentationObject, { kind: 'text' }>): OfficeDisplayPrimitive {
  const metrics = textMetrics(object.runs, object.geometry.widthPt)
  const xPt = object.alignment === 'center'
    ? object.geometry.xPt + (object.geometry.widthPt - metrics.widthPt) / 2
    : object.alignment === 'end'
      ? object.geometry.xPt + object.geometry.widthPt - metrics.widthPt
      : object.geometry.xPt
  const yPt = object.verticalAlignment === 'middle'
    ? object.geometry.yPt + (object.geometry.heightPt - metrics.heightPt) / 2
    : object.verticalAlignment === 'bottom'
      ? object.geometry.yPt + object.geometry.heightPt - metrics.heightPt
      : object.geometry.yPt
  return { id: object.id, kind: 'text', xPt, yPt, widthPt: metrics.widthPt, heightPt: metrics.heightPt, z: 0 }
}

function documentNodeHeight(node: DocumentFlowNode, widthPt: number): number {
  if (node.kind === 'paragraph' || node.kind === 'heading') return (node.spacingBeforePt ?? 0) + textHeight(node.runs, widthPt) + (node.spacingAfterPt ?? 8)
  if (node.kind === 'list') return node.items.reduce((height, item) => height + textHeight(item.runs, widthPt - 24), 0) + 8
  if (node.kind === 'table') return Math.max(12, documentTableRowHeights(node, widthPt).reduce((sum, height) => sum + height, 0))
  if (node.kind === 'image') return node.heightPt
  if (node.kind === 'chart') return 240
  if (node.kind === 'video') return 270
  return 0
}

function nodePrimitive(node: DocumentFlowNode, xPt: number, yPt: number, widthPt: number, heightPt: number, z: number): OfficeDisplayPrimitive | null {
  if (node.kind === 'pageBreak' || node.kind === 'sectionBreak') return null
  if (node.kind === 'paragraph' || node.kind === 'heading') return { id: node.id, kind: 'text', xPt, yPt, widthPt, heightPt, text: textOf(node.runs), runs: node.runs, alignment: node.alignment, lineSpacingPt: node.lineSpacingPt, sourceKind: node.kind, z }
  if (node.kind === 'list') return { id: node.id, kind: 'text', xPt, yPt, widthPt, heightPt, text: node.items.map((item, index) => `${node.ordered ? `${index + 1}.` : '•'} ${textOf(item.runs)}`).join('\n'), sourceKind: node.kind, z }
  if (node.kind === 'image') return { id: node.id, kind: 'image', xPt, yPt, widthPt: Math.min(widthPt, node.widthPt), heightPt, resourceId: node.resourceId, sourceKind: node.kind, z }
  if (node.kind === 'table') {
    const declaredWidth = node.widthPt ?? node.columnWidthsPt?.reduce((sum, width) => sum + width, 0) ?? widthPt
    const tableWidth = Math.min(widthPt, declaredWidth)
    const alignmentOffset = node.alignment === 'center' ? (widthPt - tableWidth) / 2 : node.alignment === 'end' ? widthPt - tableWidth : Math.max(0, node.indentPt ?? 0)
    return { id: node.id, kind: 'table', xPt: xPt + Math.min(alignmentOffset, Math.max(0, widthPt - tableWidth)), yPt, widthPt: tableWidth, heightPt, tableRows: node.rows.map((row) => row.cells.map((cell) => ({ runs: cell.runs, rowSpan: cell.rowSpan, colSpan: cell.colSpan }))), tableHeaderRows: node.headerRows, documentTable: node, sourceKind: node.kind, z }
  }
  if (node.kind === 'chart') return { id: node.id, kind: 'chart', xPt, yPt, widthPt, heightPt, text: node.title, sourceKind: node.kind, z }
  return { id: node.id, kind: 'video', xPt, yPt, widthPt, heightPt, resourceId: node.resourceId, sourceKind: node.kind, z }
}

function layoutDocument(snapshot: DocumentSnapshot): OfficeLayoutResult {
  const pages: OfficeDisplayPage[] = []
  const issues: OfficeLayoutIssue[] = []
  for (const section of snapshot.sections) {
    const width = section.page.widthPt
    const height = section.page.heightPt
    const bodyWidth = width - section.page.marginLeftPt - section.page.marginRightPt
    const bottom = height - section.page.marginBottomPt
    let page: OfficeDisplayPage = { id: `${section.id}:${pages.length}`, widthPt: width, heightPt: height, primitives: [] }
    pages.push(page)
    if (section.headerImage) page.primitives.push({ id: `${section.id}:header-image`, kind: 'image', xPt: section.page.marginLeftPt, yPt: Math.max(0, section.page.marginTopPt - section.headerImage.heightPt - 12), widthPt: section.headerImage.widthPt, heightPt: section.headerImage.heightPt, resourceId: section.headerImage.resourceId, sourceKind: 'header', z: -3 })
    if (section.header.length) page.primitives.push({ id: `${section.id}:header`, kind: 'text', xPt: section.page.marginLeftPt + (section.headerImage?.widthPt ?? 0) + (section.headerImage ? 8 : 0), yPt: Math.max(0, section.page.marginTopPt - 28), widthPt: bodyWidth - (section.headerImage?.widthPt ?? 0), heightPt: textHeight(section.header, bodyWidth), text: textOf(section.header), runs: section.header, alignment: section.headerAlignment, sourceKind: 'header', z: -2 })
    if (section.headerBorderBottom) page.primitives.push({ id: `${section.id}:header-border`, kind: 'line', xPt: section.page.marginLeftPt, yPt: Math.max(0, section.page.marginTopPt - 8), widthPt: bodyWidth, heightPt: 0, strokeColor: section.headerBorderBottom.color, strokeWidthPt: section.headerBorderBottom.widthPt, sourceKind: 'header', z: -1 })
    if (section.footer.length) page.primitives.push({ id: `${section.id}:footer`, kind: 'text', xPt: section.page.marginLeftPt, yPt: height - section.page.marginBottomPt + 14, widthPt: bodyWidth, heightPt: textHeight(section.footer, bodyWidth), text: textOf(section.footer), runs: section.footer, alignment: section.footerAlignment, sourceKind: 'footer', z: -1 })
    if (section.footerBorderTop) page.primitives.push({ id: `${section.id}:footer-border`, kind: 'line', xPt: section.page.marginLeftPt, yPt: height - section.page.marginBottomPt + 6, widthPt: bodyWidth, heightPt: 0, strokeColor: section.footerBorderTop.color, strokeWidthPt: section.footerBorderTop.widthPt, sourceKind: 'footer', z: -2 })
    let y = section.page.marginTopPt
    for (const node of section.nodes) {
      if (node.kind === 'pageBreak' || (node.kind === 'sectionBreak' && page.primitives.length > 0)) {
        page = { id: `${section.id}:${pages.length}`, widthPt: width, heightPt: height, primitives: [] }
        pages.push(page)
        y = section.page.marginTopPt
        continue
      }
      const nodeHeight = documentNodeHeight(node, bodyWidth)
      if (y + nodeHeight > bottom && page.primitives.length > 0) {
        page = { id: `${section.id}:${pages.length}`, widthPt: width, heightPt: height, primitives: [] }
        pages.push(page)
        y = section.page.marginTopPt
      }
      if (nodeHeight > bottom - section.page.marginTopPt) issues.push({ code: 'overflow', objectId: node.id, message: 'Object is taller than the printable page body' })
      const spacingBefore = node.kind === 'paragraph' || node.kind === 'heading' ? node.spacingBeforePt ?? 0 : 0
      const spacingAfter = node.kind === 'paragraph' || node.kind === 'heading' ? node.spacingAfterPt ?? 8 : 0
      const primitive = nodePrimitive(node, section.page.marginLeftPt, y + spacingBefore, bodyWidth, Math.max(0, nodeHeight - spacingBefore - spacingAfter), page.primitives.length)
      if (primitive) page.primitives.push(primitive)
      y += nodeHeight
    }
  }
  const serialization = JSON.stringify(pages)
  return { family: 'document', pages, issues, serialization }
}

function slidePrimitive(object: PresentationObject, z: number): OfficeDisplayPrimitive {
  const geometry = object.geometry
  const common = { id: object.id, xPt: geometry.xPt, yPt: geometry.yPt, widthPt: geometry.widthPt, heightPt: geometry.heightPt, sourceKind: object.kind, z }
  if (object.kind === 'text') return { ...common, kind: 'text', text: textOf(object.runs), runs: object.runs, alignment: object.alignment, verticalAlignment: object.verticalAlignment }
  if (object.kind === 'image') return { ...common, kind: 'image', resourceId: object.resourceId }
  if (object.kind === 'shape') return { ...common, kind: object.shape === 'line' ? 'line' : 'rect', text: textOf(object.text), runs: object.text, alignment: object.alignment, verticalAlignment: object.verticalAlignment, fillColor: object.fill, strokeColor: object.stroke, strokeWidthPt: object.strokeWidthPt, shapeKind: object.shape }
  if (object.kind === 'connector') return { ...common, kind: 'line', strokeColor: object.stroke }
  if (object.kind === 'table') return { ...common, kind: 'table', tableHeaderRows: object.headerRows, tableRows: object.rows.map((row) => row.cells.map((cell) => ({ runs: cell.runs, rowSpan: cell.rowSpan, colSpan: cell.colSpan, fill: cell.fill }))) }
  if (object.kind === 'chart') return { ...common, kind: 'chart', text: object.title, chartType: object.chartType, chartCategories: object.categories, chartSeries: object.series.map((series) => ({ name: series.name, values: series.values })) }
  return { ...common, kind: 'video', resourceId: object.resourceId }
}

function overlaps(left: OfficeDisplayPrimitive, right: OfficeDisplayPrimitive): boolean {
  return left.xPt < right.xPt + right.widthPt && left.xPt + left.widthPt > right.xPt && left.yPt < right.yPt + right.heightPt && left.yPt + left.heightPt > right.yPt
}

function layoutPresentation(snapshot: PresentationSnapshot): OfficeLayoutResult {
  const issues: OfficeLayoutIssue[] = []
  const pages = snapshot.slides.map((slide) => {
    const primitives = slide.objects.map(slidePrimitive)
    for (const primitive of primitives) {
      if (primitive.xPt < 0 || primitive.yPt < 0 || primitive.xPt + primitive.widthPt > snapshot.slideSize.widthPt || primitive.yPt + primitive.heightPt > snapshot.slideSize.heightPt) {
        issues.push({ code: 'overflow', objectId: primitive.id, message: 'Object extends outside the slide boundary' })
      }
      if (primitive.kind === 'text') {
        const object = slide.objects.find((candidate) => candidate.id === primitive.id)
        if (object?.kind === 'text' && textHeight(object.runs, primitive.widthPt) > primitive.heightPt) issues.push({ code: 'overflow', objectId: primitive.id, message: 'Text does not fit its box at the readability floor' })
      }
    }
    for (let left = 0; left < primitives.length; left += 1) {
      for (let right = left + 1; right < primitives.length; right += 1) {
        if (primitives[left].kind === 'text' && primitives[right].kind === 'text') {
          const leftObject = slide.objects[left]
          const rightObject = slide.objects[right]
          if (leftObject?.kind === 'text' && rightObject?.kind === 'text' && overlaps(textInkBounds(leftObject), textInkBounds(rightObject))) issues.push({ code: 'collision', objectId: primitives[right].id, message: `Text overlaps ${primitives[left].id}` })
        }
      }
    }
    return { id: slide.id, widthPt: snapshot.slideSize.widthPt, heightPt: snapshot.slideSize.heightPt, primitives }
  })
  const serialization = JSON.stringify(pages)
  return { family: 'presentation', pages, issues, serialization }
}

function addressInRange(address: string, range: string): boolean {
  const cell = parseCellAddress(address)
  const [from, to = from] = range.split(':').map(parseCellAddress)
  return Boolean(cell && from && to && cell.row >= Math.min(from.row, to.row) && cell.row <= Math.max(from.row, to.row) && cell.column >= Math.min(from.column, to.column) && cell.column <= Math.max(from.column, to.column))
}

function mergeSpreadsheetCellStyles(base: SpreadsheetCellStyle | undefined, overlay: SpreadsheetCellStyle | undefined): SpreadsheetCellStyle | undefined {
  if (!overlay) return base
  return { ...base, ...overlay, font: overlay.font ?? base?.font, border: { ...base?.border, ...overlay.border }, alignment: overlay.alignment ?? base?.alignment }
}

function spreadsheetEffectiveCellStyle(sheet: SpreadsheetWorksheet, address: string, cell: SpreadsheetCell | undefined): SpreadsheetCellStyle | undefined {
  if (!cell) return undefined
  const display = spreadsheetCellDisplayValue(cell)
  const numeric = Number(cell.formula ? cell.calculatedValue : cell.value)
  const rules = sheet.conditionalFormats.filter((rule) => addressInRange(address, rule.range)).sort((left, right) => left.priority - right.priority)
  for (const rule of rules) {
    const formula = rule.formulas[0]?.replace(/^=/, '').replace(/^"|"$/g, '') ?? ''
    if (rule.ruleType === 'containsText' && display.includes(formula)) return mergeSpreadsheetCellStyles(cell.style, rule.style)
    if (rule.ruleType === 'expression') {
      const match = /^(?:[A-Z]{1,3}[1-9][0-9]{0,6})?\s*(=|<>)\s*"([^"]*)"$/.exec(formula)
      if (match && (match[1] === '=' ? display === match[2] : display !== match[2])) return mergeSpreadsheetCellStyles(cell.style, rule.style)
    }
    if (rule.ruleType === 'cellIs' && Number.isFinite(numeric)) {
      const expected = Number(formula)
      const second = Number(rule.formulas[1])
      const matches = rule.operator === 'greaterThan' ? numeric > expected : rule.operator === 'lessThan' ? numeric < expected : rule.operator === 'greaterThanOrEqual' ? numeric >= expected : rule.operator === 'lessThanOrEqual' ? numeric <= expected : rule.operator === 'notEqual' ? numeric !== expected : rule.operator === 'between' ? numeric >= expected && numeric <= second : rule.operator === 'notBetween' ? numeric < expected || numeric > second : numeric === expected
      if (matches) return mergeSpreadsheetCellStyles(cell.style, rule.style)
    }
  }
  return cell.style
}

type SpreadsheetMergeRegion = { from: { column: number; row: number }; to: { column: number; row: number } }

function spreadsheetMergeRegions(sheet: SpreadsheetWorksheet): SpreadsheetMergeRegion[] {
  return sheet.merges.flatMap((range) => {
    const [from, to = from] = range.split(':').map(parseCellAddress)
    if (!from || !to) return []
    return [{
      from: { column: Math.min(from.column, to.column), row: Math.min(from.row, to.row) },
      to: { column: Math.max(from.column, to.column), row: Math.max(from.row, to.row) },
    }]
  })
}

function mergeRegionFor(regions: readonly SpreadsheetMergeRegion[], column: number, row: number): SpreadsheetMergeRegion | undefined {
  return regions.find((region) => column >= region.from.column && column <= region.to.column && row >= region.from.row && row <= region.to.row)
}

function spreadsheetAxisPosition(positions: readonly number[], coordinate: number): number {
  const bounded = Math.max(0, coordinate)
  const whole = Math.min(Math.floor(bounded), positions.length - 1)
  const fraction = bounded - Math.floor(bounded)
  const start = positions[whole] ?? positions.at(-1) ?? 0
  const end = positions[whole + 1] ?? start
  return start + (end - start) * fraction
}

function layoutSpreadsheet(snapshot: SpreadsheetSnapshot): OfficeLayoutResult {
  const issues: OfficeLayoutIssue[] = []
  const pages = snapshot.worksheets.map((sheet) => {
    const columns = new Map(sheet.columnDimensions.map((dimension) => [dimension.index, dimension]))
    const rows = new Map(sheet.rowDimensions.map((dimension) => [dimension.index, dimension]))
    const positionsX = [0]
    const positionsY = [0]
    const mergeRegions = spreadsheetMergeRegions(sheet)
    const maxColumn = Math.max(1, ...sheet.cells.map((cell) => parseCellAddress(cell.address)?.column ?? 1), ...sheet.columnDimensions.map((dimension) => dimension.index), ...mergeRegions.map((region) => region.to.column), ...sheet.images.map((image) => Math.ceil(image.to.column)))
    const maxRow = Math.max(1, ...sheet.cells.map((cell) => parseCellAddress(cell.address)?.row ?? 1), ...sheet.rowDimensions.map((dimension) => dimension.index), ...mergeRegions.map((region) => region.to.row), ...sheet.images.map((image) => Math.ceil(image.to.row)))
    for (let column = 1; column <= maxColumn; column += 1) positionsX[column] = positionsX[column - 1] + (columns.get(column)?.hidden ? 0 : (columns.get(column)?.widthChars ?? 8.43) * 5.25 + 3.75)
    for (let row = 1; row <= maxRow; row += 1) positionsY[row] = positionsY[row - 1] + (rows.get(row)?.hidden ? 0 : rows.get(row)?.heightPt ?? 15)
    const primitives: OfficeDisplayPrimitive[] = sheet.cells.flatMap((cell, z) => {
      const address = parseCellAddress(cell.address)
      if (!address) {
        issues.push({ code: 'overflow', objectId: cell.id, message: `Cell address ${cell.address} is invalid` })
        return []
      }
      const merge = mergeRegionFor(mergeRegions, address.column, address.row)
      if (merge && (address.column !== merge.from.column || address.row !== merge.from.row)) return []
      const right = merge?.to.column ?? address.column
      const bottom = merge?.to.row ?? address.row
      return [{
        id: cell.id,
        kind: 'text' as const,
        xPt: positionsX[address.column - 1],
        yPt: positionsY[address.row - 1],
        widthPt: positionsX[right] - positionsX[address.column - 1],
        heightPt: positionsY[bottom] - positionsY[address.row - 1],
        text: spreadsheetCellDisplayValue(cell),
        spreadsheetStyle: spreadsheetEffectiveCellStyle(sheet, cell.address, cell),
        numberFormat: cell.numberFormat,
        sourceKind: 'cell',
        z,
      }]
    })
    primitives.push(...sheet.images.map((image, index) => ({
      id: image.id,
      kind: 'image' as const,
      xPt: spreadsheetAxisPosition(positionsX, image.from.column),
      yPt: spreadsheetAxisPosition(positionsY, image.from.row),
      widthPt: Math.max(0, spreadsheetAxisPosition(positionsX, image.to.column) - spreadsheetAxisPosition(positionsX, image.from.column)),
      heightPt: Math.max(0, spreadsheetAxisPosition(positionsY, image.to.row) - spreadsheetAxisPosition(positionsY, image.from.row)),
      resourceId: image.resourceId,
      sourceKind: 'worksheet-image',
      z: sheet.cells.length + index,
    })))
    return { id: sheet.id, widthPt: positionsX[maxColumn], heightPt: positionsY[maxRow], primitives }
  })
  return { family: 'spreadsheet', pages, issues, serialization: JSON.stringify(pages) }
}

export function layoutOfficeArtifact(snapshot: OfficeArtifactSnapshot): OfficeLayoutResult {
  return snapshot.family === 'document' ? layoutDocument(snapshot) : snapshot.family === 'presentation' ? layoutPresentation(snapshot) : layoutSpreadsheet(snapshot)
}

/** D16's deterministic fit gate. It validates; it never silently truncates,
 * shrinks, hides, or invents a layout. Generation may repair the named issues
 * and call again within its own bounded loop. */
export function fitOfficeArtifact(snapshot: OfficeArtifactSnapshot, budget: OfficeFitBudget = {}): OfficeFitResult {
  const result = layoutOfficeArtifact(snapshot)
  const issues = [...result.issues]
  const pageLimit = snapshot.family === 'document' ? budget.maxPages : snapshot.family === 'presentation' ? budget.maxSlides : budget.maxWorksheets
  if (pageLimit !== undefined && result.pages.length > pageLimit) {
    issues.push({ code: 'overflow', objectId: snapshot.rootId, message: `${snapshot.family === 'document' ? 'Page' : snapshot.family === 'presentation' ? 'Slide' : 'Worksheet'} count ${result.pages.length} exceeds the admitted limit ${pageLimit}` })
  }
  const floor = budget.minimumFontSizePt ?? 8
  const readabilityExemptObjectIds = new Set(budget.readabilityExemptObjectIds ?? [])
  const visitRuns = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (!Array.isArray(value)) {
      const object = value as Record<string, unknown>
      const style = object.style as Record<string, unknown> | undefined
      if (style && typeof style.fontSizePt === 'number' && style.fontSizePt < floor && !(typeof object.id === 'string' && readabilityExemptObjectIds.has(object.id))) {
        issues.push({ code: 'readability', objectId: typeof object.id === 'string' ? object.id : snapshot.rootId, message: `Font size ${style.fontSizePt}pt is below the ${floor}pt readability floor` })
      }
      const max = typeof object.id === 'string' ? budget.maxTextCharsByObject?.[object.id] : undefined
      if (max !== undefined && typeof object.text === 'string' && object.text.length > max) {
        issues.push({ code: 'overflow', objectId: object.id as string, message: `Text length ${object.text.length} exceeds the admitted field budget ${max}` })
      }
    }
    for (const child of Object.values(value)) visitRuns(child)
  }
  visitRuns(snapshot)
  return { ok: issues.length === 0, attempts: 1, result, issues }
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function cssAlignment(alignment: OfficeDisplayPrimitive['alignment']): string {
  return alignment === 'end' ? 'right' : alignment === 'center' ? 'center' : alignment === 'justify' ? 'justify' : 'left'
}

function richTextHtml(runs: readonly OfficeRichTextRun[] | undefined, fallback: string): string {
  if (!runs?.length) return escapeXml(fallback)
  return runs.map((run) => {
    const decorations = [run.style.underline ? 'underline' : '', run.style.strike ? 'line-through' : ''].filter(Boolean).join(' ')
    const style = [
      `color:${run.style.color}`,
      `font-family:${escapeXml(run.style.fontFamily)}`,
      `font-size:${run.style.fontSizePt}px`,
      `font-style:${run.style.italic ? 'italic' : 'normal'}`,
      `font-weight:${run.style.bold ? '700' : '400'}`,
      decorations ? `text-decoration:${decorations}` : '',
    ].filter(Boolean).join(';')
    return `<span style="${style}">${escapeXml(run.text)}</span>`
  }).join('')
}

function documentBorderCss(border: OfficeTableBorder | undefined, fallback: string): string {
  if (!border) return fallback
  if (border.style === 'none' || border.widthPt === 0) return 'none'
  const style = border.style === 'dotted' ? 'dotted' : border.style === 'dashed' ? 'dashed' : border.style === 'double' ? 'double' : 'solid'
  return `${Math.max(0.5, border.widthPt)}px ${style} ${border.color}`
}

function documentCellBorder(table: OfficeTable, cell: OfficeTableCell, placement: ReturnType<typeof officeTableCellPlacements>[number], edge: 'top' | 'right' | 'bottom' | 'left', columnCount: number): OfficeTableBorder | undefined {
  const direct = cell.borders?.[edge]
  if (direct) return direct
  if (edge === 'top') return placement.rowIndex === 0 ? table.borders?.top : table.borders?.insideHorizontal
  if (edge === 'bottom') return placement.rowIndex + cell.rowSpan >= table.rows.length ? table.borders?.bottom : table.borders?.insideHorizontal
  if (edge === 'left') return placement.startColumn === 0 ? table.borders?.left : table.borders?.insideVertical
  return placement.endColumn >= columnCount ? table.borders?.right : table.borders?.insideVertical
}

function renderTableHtml(primitive: OfficeDisplayPrimitive): string {
  const table = primitive.documentTable
  if (table) {
    const widths = officeTableResolvedColumnWidthsPt(table, primitive.widthPt)
    const totalWidth = widths.reduce((sum, width) => sum + width, 0)
    const placements = officeTableCellPlacements(table)
    const placementByCell = new Map(placements.map((placement) => [placement.cell.id, placement]))
    const canonicalBorders = Boolean(table.borders || table.rows.some((row) => row.cells.some((cell) => cell.borders)))
    const borderFallback = canonicalBorders ? 'none' : '1px solid #cbd5e1'
    const columns = widths.map((width) => `<col style="width:${totalWidth > 0 ? width / totalWidth * 100 : 100 / widths.length}%"/>`).join('')
    const body = table.rows.map((row, rowIndex) => `<tr style="${row.minHeightPt ? `height:${row.minHeightPt}px` : ''}">${row.cells.map((cell) => {
      const placement = placementByCell.get(cell.id)
      if (!placement) return ''
      const margins = cell.margins ?? table.margins
      const header = rowIndex < table.headerRows
      const style = [
        `border-top:${documentBorderCss(documentCellBorder(table, cell, placement, 'top', widths.length), borderFallback)}`,
        `border-right:${documentBorderCss(documentCellBorder(table, cell, placement, 'right', widths.length), borderFallback)}`,
        `border-bottom:${documentBorderCss(documentCellBorder(table, cell, placement, 'bottom', widths.length), borderFallback)}`,
        `border-left:${documentBorderCss(documentCellBorder(table, cell, placement, 'left', widths.length), borderFallback)}`,
        `padding:${margins?.topPt ?? 2}px ${margins?.rightPt ?? 2}px ${margins?.bottomPt ?? 2}px ${margins?.leftPt ?? 2}px`,
        `vertical-align:${cell.verticalAlignment === 'middle' ? 'middle' : cell.verticalAlignment === 'bottom' ? 'bottom' : 'top'}`,
        `text-align:${cssAlignment(cell.alignment)}`,
        `background:${cell.fill ?? (header ? '#f8fafc' : 'transparent')}`,
        `white-space:${cell.wrapText === false ? 'nowrap' : 'pre-wrap'}`,
        'overflow:hidden',
        'overflow-wrap:anywhere',
        'word-break:break-word',
      ].join(';')
      return `<td data-office-table-cell="${escapeXml(cell.id)}" rowspan="${cell.rowSpan}" colspan="${cell.colSpan}" style="${style}">${richTextHtml(cell.runs, '')}</td>`
    }).join('')}</tr>`).join('')
    return `<table xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:100%;height:100%;border-collapse:collapse;table-layout:${table.layout === 'autofit' && !table.columnWidthsPt ? 'auto' : 'fixed'};font-family:Arial,sans-serif;font-size:10px;line-height:1.15;color:#0f172a"><colgroup>${columns}</colgroup><tbody>${body}</tbody></table>`
  }
  const rows = primitive.tableRows ?? []
  const body = rows.map((row, rowIndex) => `<tr>${row.map((cell) => {
    const header = rowIndex < (primitive.tableHeaderRows ?? 0)
    return `<td rowspan="${cell.rowSpan}" colspan="${cell.colSpan}" style="border:1px solid #cbd5e1;padding:2px;vertical-align:top;overflow:hidden;${header ? 'font-weight:700;' : ''}background:${cell.fill ?? (header ? '#f8fafc' : 'transparent')}">${richTextHtml(cell.runs, '')}</td>`
  }).join('')}</tr>`).join('')
  return `<table xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:100%;height:100%;border-collapse:collapse;table-layout:fixed;font-family:Arial,sans-serif;font-size:10px;line-height:1.15;color:#0f172a"><tbody>${body}</tbody></table>`
}

function spreadsheetBorderCss(side: NonNullable<SpreadsheetCellStyle['border']>['top']): string | undefined {
  if (!side?.style) return undefined
  const width = side.style === 'double' ? 3 : side.style === 'thick' ? 2 : side.style === 'hair' ? 0.5 : 1
  const style = side.style === 'dotted' ? 'dotted' : side.style === 'dashed' ? 'dashed' : side.style === 'double' ? 'double' : 'solid'
  return `${width}px ${style} ${side.color ?? '#334155'}`
}

function spreadsheetCellHtml(primitive: OfficeDisplayPrimitive): string {
  const style = primitive.spreadsheetStyle
  const font = style?.font
  const alignment = style?.alignment
  const decorations = [font?.underline ? 'underline' : '', font?.strike ? 'line-through' : ''].filter(Boolean).join(' ')
  const horizontal = alignment?.horizontal === 'center' ? 'center' : alignment?.horizontal === 'right' ? 'right' : alignment?.horizontal === 'justify' ? 'justify' : 'left'
  const vertical = alignment?.vertical === 'middle' ? 'center' : alignment?.vertical === 'bottom' ? 'flex-end' : 'flex-start'
  const rotation = alignment?.textRotation ? `transform:rotate(${-alignment.textRotation}deg);transform-origin:center` : ''
  const css = [
    'box-sizing:border-box',
    'display:flex',
    'width:100%',
    'height:100%',
    'overflow:hidden',
    `align-items:${vertical}`,
    `background-color:${style?.fill ?? 'transparent'}`,
    `color:${font?.color ?? '#0f172a'}`,
    `font-family:${escapeXml(font?.family ?? 'Arial')},sans-serif`,
    `font-size:${font?.sizePt ?? 11}px`,
    `font-style:${font?.italic ? 'italic' : 'normal'}`,
    `font-weight:${font?.bold ? '700' : '400'}`,
    decorations ? `text-decoration:${decorations}` : '',
    `text-align:${horizontal}`,
    `white-space:${alignment?.wrapText ? 'pre-wrap' : 'nowrap'}`,
    `padding:1px 2px 1px ${2 + (alignment?.indent ?? 0) * 8}px`,
    primitive.numberFormat ? 'font-variant-numeric:tabular-nums' : '',
    spreadsheetBorderCss(style?.border?.top) ? `border-top:${spreadsheetBorderCss(style?.border?.top)}` : '',
    spreadsheetBorderCss(style?.border?.right) ? `border-right:${spreadsheetBorderCss(style?.border?.right)}` : '',
    spreadsheetBorderCss(style?.border?.bottom) ? `border-bottom:${spreadsheetBorderCss(style?.border?.bottom)}` : '',
    spreadsheetBorderCss(style?.border?.left) ? `border-left:${spreadsheetBorderCss(style?.border?.left)}` : '',
  ].filter(Boolean).join(';')
  return `<div xmlns="http://www.w3.org/1999/xhtml" style="${css}"><span style="box-sizing:border-box;display:block;width:100%;overflow:hidden;${rotation}">${escapeXml(primitive.text ?? '')}</span></div>`
}

export type OfficePreviewSvgOptions = {
  resourceUrls?: Readonly<Record<string, string>>
}

/** Browser/server preview input over the exact display-list coordinates used
 * by export validation. The UI may mount this SVG directly or translate the
 * same primitives to DOM nodes. */
export function renderOfficePreviewSvg(page: OfficeDisplayPage, options: OfficePreviewSvgOptions = {}): string {
  const primitives = [...page.primitives].sort((left, right) => left.z - right.z).map((primitive) => {
    const common = `data-office-object="${escapeXml(primitive.id)}" x="${primitive.xPt}" y="${primitive.yPt}" width="${primitive.widthPt}" height="${primitive.heightPt}"`
    if (primitive.kind === 'text') return `<foreignObject ${common}>${primitive.sourceKind === 'cell' ? spreadsheetCellHtml(primitive) : `<div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:100%;height:100%;overflow:hidden;white-space:pre-wrap;font-family:Arial,sans-serif;font-size:12px;line-height:${primitive.lineSpacingPt ? `${primitive.lineSpacingPt}px` : '1.15'};text-align:${cssAlignment(primitive.alignment)}">${richTextHtml(primitive.runs, primitive.text ?? '')}</div>`}</foreignObject>`
    if (primitive.kind === 'table') return `<foreignObject ${common}>${renderTableHtml(primitive)}</foreignObject>`
    if (primitive.kind === 'image') {
      const url = primitive.resourceId ? options.resourceUrls?.[primitive.resourceId] : undefined
      return url
        ? `<image ${common} href="${escapeXml(url)}" preserveAspectRatio="xMinYMin meet"/>`
        : `<rect ${common} fill="transparent" stroke="none"/>`
    }
    if (primitive.kind === 'line') return `<line data-office-object="${escapeXml(primitive.id)}" x1="${primitive.xPt}" y1="${primitive.yPt}" x2="${primitive.xPt + primitive.widthPt}" y2="${primitive.yPt + primitive.heightPt}" style="stroke:${primitive.strokeColor ?? '#64748b'};stroke-width:${primitive.strokeWidthPt ?? 1}"/>`
    if (primitive.kind === 'rect') return `<g data-office-object="${escapeXml(primitive.id)}"><rect x="${primitive.xPt}" y="${primitive.yPt}" width="${primitive.widthPt}" height="${primitive.heightPt}" fill="${primitive.fillColor ?? 'transparent'}" stroke="${primitive.strokeColor ?? 'transparent'}" stroke-width="${primitive.strokeWidthPt ?? 0}"/><foreignObject x="${primitive.xPt}" y="${primitive.yPt}" width="${primitive.widthPt}" height="${primitive.heightPt}"><div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:100%;height:100%;overflow:hidden;white-space:pre-wrap;text-align:${cssAlignment(primitive.alignment)}">${richTextHtml(primitive.runs, primitive.text ?? '')}</div></foreignObject></g>`
    const label = primitive.kind === 'chart' ? `Chart: ${primitive.text ?? ''}` : 'Video'
    return `<g data-office-object="${escapeXml(primitive.id)}"><rect x="${primitive.xPt}" y="${primitive.yPt}" width="${primitive.widthPt}" height="${primitive.heightPt}"/><text x="${primitive.xPt + 4}" y="${primitive.yPt + 16}">${escapeXml(label)}</text></g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.widthPt} ${page.heightPt}" role="img">${primitives}</svg>`
}

export function officeGoldenSerialization(snapshot: OfficeArtifactSnapshot): string {
  const layout = layoutOfficeArtifact(snapshot)
  return JSON.stringify({ family: layout.family, pages: layout.pages, previews: layout.pages.map((page) => renderOfficePreviewSvg(page)), issues: layout.issues })
}
