import { z } from 'zod'

/** Canonical Office model. See docs/architecture/features/office.md. */
export const OFFICE_SCHEMA_VERSION = 1 as const
export const OFFICE_CAPABILITY_VERSION = 1 as const

export const OfficeUuidSchema = z.string().uuid()
export const OfficeFamilySchema = z.enum(['document', 'presentation', 'spreadsheet', 'pdf'])
export type OfficeFamily = z.infer<typeof OfficeFamilySchema>

export const OfficeSensitivitySchema = z.enum(['public', 'internal', 'confidential'])
export type OfficeSensitivity = z.infer<typeof OfficeSensitivitySchema>

export const OfficeResourceRefSchema = z
  .object({
    id: OfficeUuidSchema,
    kind: z.enum(['font', 'theme', 'image', 'video', 'template-fragment']),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.string().min(1).max(255),
    sensitivity: OfficeSensitivitySchema,
  })
  .strict()
export type OfficeResourceRef = z.infer<typeof OfficeResourceRefSchema>

export const OfficeColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/)

export const OfficeTextStyleSchema = z
  .object({
    fontFamily: z.string().min(1).max(128),
    eastAsianFontFamily: z.string().min(1).max(128).optional(),
    fontSizePt: z.number().min(1).max(144),
    widthScalePercent: z.number().int().min(10).max(600).optional(),
    bold: z.boolean().default(false),
    italic: z.boolean().default(false),
    underline: z.boolean().default(false),
    strike: z.boolean().default(false),
    color: OfficeColorSchema,
    highlight: OfficeColorSchema.optional(),
    language: z.string().min(2).max(35).optional(),
  })
  .strict()

/** Single-level native numbering; marker text is derived, never user text. */
export const OfficeNumberingSchema = z.object({
  listId: OfficeUuidSchema,
  format: z.enum(['decimal', 'upperRoman', 'lowerRoman', 'upperLetter', 'lowerLetter']),
  start: z.number().int().min(1).max(3999),
  pattern: z.string().max(32).regex(/^[^%<>\x00-\x1f]*%1[^%<>\x00-\x1f]*$/),
  markerStyle: OfficeTextStyleSchema.omit({ highlight: true, language: true }).partial().optional(),
}).strict()
export type OfficeNumbering = z.infer<typeof OfficeNumberingSchema>

export const OfficeParagraphFormatSchema = z.object({
  alignment: z.enum(['start', 'center', 'end', 'justify']).optional(),
  spacingBeforePt: z.number().min(0).max(1_000).optional(),
  spacingAfterPt: z.number().min(0).max(1_000).optional(),
  lineSpacingPt: z.number().positive().max(1_000).optional(),
  lineSpacingRule: z.enum(['exact', 'atLeast']).optional(),
  lineSpacingMultiple: z.number().positive().max(100).optional(),
  indentLeftPt: z.number().min(0).max(1000).optional(),
  hangingPt: z.number().min(0).max(1000).optional(),
  numbering: OfficeNumberingSchema.optional(),
}).strict()
export type OfficeParagraphFormat = z.infer<typeof OfficeParagraphFormatSchema>

export const OfficeRichTextRunSchema = z
  .object({
    id: OfficeUuidSchema,
    text: z.string().max(100_000),
    style: OfficeTextStyleSchema,
    // Cell paragraphs store text once, with a format marker on their first run.
    paragraphStart: OfficeParagraphFormatSchema.extend({ id: OfficeUuidSchema }).optional(),
    href: z.string().url().refine((url) => /^(https?:|mailto:)/.test(url), {
      message: 'Only inert HTTP, HTTPS and mailto links are supported',
    }).optional(),
  })
  .strict()
export type OfficeRichTextRun = z.infer<typeof OfficeRichTextRunSchema>

const NodeBaseSchema = z.object({ id: OfficeUuidSchema })

export const OfficeParagraphSchema = NodeBaseSchema.extend({
  kind: z.literal('paragraph'),
  runs: z.array(OfficeRichTextRunSchema).max(10_000),
  styleName: z.string().min(1).max(128).default('Body'),
  alignment: z.enum(['start', 'center', 'end', 'justify']).default('start'),
  spacingBeforePt: z.number().min(0).max(1_000).optional(),
  spacingAfterPt: z.number().min(0).max(1_000).optional(),
  lineSpacingPt: z.number().positive().max(1_000).optional(),
  lineSpacingRule: z.enum(['exact', 'atLeast']).optional(),
  lineSpacingMultiple: z.number().positive().max(100).optional(),
  indentLeftPt: z.number().min(0).max(1000).optional(),
  hangingPt: z.number().min(0).max(1000).optional(),
  numbering: OfficeNumberingSchema.optional(),
}).strict()

export const OfficeHeadingSchema = NodeBaseSchema.extend({
  kind: z.literal('heading'),
  level: z.number().int().min(1).max(6),
  runs: z.array(OfficeRichTextRunSchema).max(1_000),
  styleName: z.string().min(1).max(128),
  alignment: z.enum(['start', 'center', 'end', 'justify']).optional(),
  spacingBeforePt: z.number().min(0).max(1_000).optional(),
  spacingAfterPt: z.number().min(0).max(1_000).optional(),
  lineSpacingPt: z.number().positive().max(1_000).optional(),
  lineSpacingRule: z.enum(['exact', 'atLeast']).optional(),
  lineSpacingMultiple: z.number().positive().max(100).optional(),
  indentLeftPt: z.number().min(0).max(1000).optional(),
  hangingPt: z.number().min(0).max(1000).optional(),
  numbering: OfficeNumberingSchema.optional(),
}).strict()

export const OfficeListSchema = NodeBaseSchema.extend({
  kind: z.literal('list'),
  ordered: z.boolean(),
  level: z.number().int().min(0).max(8),
  items: z.array(z.object({ id: OfficeUuidSchema, runs: z.array(OfficeRichTextRunSchema) }).strict()).max(1_000),
}).strict()

export const OfficeTableBorderSchema = z.object({
  color: OfficeColorSchema,
  widthPt: z.number().min(0).max(20),
  style: z.enum(['none', 'solid', 'dotted', 'dashed', 'double']),
}).strict()
export type OfficeTableBorder = z.infer<typeof OfficeTableBorderSchema>

export const OfficeTableBordersSchema = z.object({
  top: OfficeTableBorderSchema.optional(),
  right: OfficeTableBorderSchema.optional(),
  bottom: OfficeTableBorderSchema.optional(),
  left: OfficeTableBorderSchema.optional(),
  insideHorizontal: OfficeTableBorderSchema.optional(),
  insideVertical: OfficeTableBorderSchema.optional(),
}).strict()
export type OfficeTableBorders = z.infer<typeof OfficeTableBordersSchema>

export const OfficeTableCellMarginsSchema = z.object({
  topPt: z.number().min(0).max(100),
  rightPt: z.number().min(0).max(100),
  bottomPt: z.number().min(0).max(100),
  leftPt: z.number().min(0).max(100),
}).strict()
export type OfficeTableCellMargins = z.infer<typeof OfficeTableCellMarginsSchema>

export const OfficeTableCellSchema = z.object({
  id: OfficeUuidSchema,
  runs: z.array(OfficeRichTextRunSchema),
  rowSpan: z.number().int().min(1).max(100).default(1),
  colSpan: z.number().int().min(1).max(100).default(1),
  fill: OfficeColorSchema.optional(),
  alignment: z.enum(['start', 'center', 'end', 'justify']).optional(),
  verticalAlignment: z.enum(['top', 'middle', 'bottom']).optional(),
  margins: OfficeTableCellMarginsSchema.optional(),
  borders: OfficeTableBordersSchema.optional(),
  wrapText: z.boolean().optional(),
}).strict()
export type OfficeTableCell = z.infer<typeof OfficeTableCellSchema>

/** Legacy cells are one paragraph; markers preserve empty and differently styled paragraphs. */
export function officeCellParagraphs(cell: Pick<OfficeTableCell, 'runs' | 'alignment'>): Array<{ format: OfficeParagraphFormat; runs: OfficeRichTextRun[] }> {
  const paragraphs: Array<{ format: OfficeParagraphFormat; runs: OfficeRichTextRun[] }> = []
  for (const run of cell.runs) {
    if (!paragraphs.length || run.paragraphStart) paragraphs.push({ format: run.paragraphStart ?? { alignment: cell.alignment }, runs: [] })
    paragraphs[paragraphs.length - 1].runs.push(run)
  }
  return paragraphs.length ? paragraphs : [{ format: { alignment: cell.alignment }, runs: [] }]
}

export const OfficeTableSchema = NodeBaseSchema.extend({
  kind: z.literal('table'),
  headerRows: z.number().int().min(0).max(10),
  columnWidthsPt: z.array(z.number().positive().max(2_000)).min(1).max(100).optional(),
  widthPt: z.number().positive().max(10_000).optional(),
  alignment: z.enum(['start', 'center', 'end']).optional(),
  indentPt: z.number().min(-500).max(500).optional(),
  layout: z.enum(['fixed', 'autofit']).optional(),
  margins: OfficeTableCellMarginsSchema.optional(),
  borders: OfficeTableBordersSchema.optional(),
  rows: z.array(
    z.object({
      id: OfficeUuidSchema,
      minHeightPt: z.number().min(0).max(2_000).optional(),
      cells: z.array(OfficeTableCellSchema).max(100),
    }).strict(),
  ).min(1).max(5_000),
}).strict()
export type OfficeTable = z.infer<typeof OfficeTableSchema>
export type OfficeTableRow = OfficeTable['rows'][number]

export type OfficeTableCellPlacement = {
  cell: OfficeTableCell
  rowIndex: number
  startColumn: number
  endColumn: number
}

export function officeTableCellPlacements(table: OfficeTable): OfficeTableCellPlacement[] {
  const placements: OfficeTableCellPlacement[] = []
  const occupiedThroughRow: number[] = []
  for (const [rowIndex, row] of table.rows.entries()) {
    let column = 0
    for (const cell of row.cells) {
      while ((occupiedThroughRow[column] ?? -1) >= rowIndex) column += 1
      const startColumn = column
      const endColumn = startColumn + cell.colSpan
      placements.push({ cell, rowIndex, startColumn, endColumn })
      if (cell.rowSpan > 1) for (let index = startColumn; index < endColumn; index += 1) occupiedThroughRow[index] = rowIndex + cell.rowSpan - 1
      column = endColumn
    }
  }
  return placements
}

export function officeTableColumnCount(table: OfficeTable): number {
  return Math.max(table.columnWidthsPt?.length ?? 0, ...officeTableCellPlacements(table).map((placement) => placement.endColumn), 1)
}

export function officeTableResolvedColumnWidthsPt(table: OfficeTable, availableWidthPt: number): number[] {
  const count = officeTableColumnCount(table)
  const declared = table.columnWidthsPt ?? []
  if (declared.length === count) return [...declared]
  const declaredTotal = declared.reduce((sum, width) => sum + width, 0)
  const remaining = Math.max(1, (table.widthPt ?? availableWidthPt) - declaredTotal)
  const fallback = remaining / Math.max(1, count - declared.length)
  return Array.from({ length: count }, (_, index) => declared[index] ?? fallback)
}

export const OfficeImageSchema = NodeBaseSchema.extend({
  kind: z.literal('image'),
  resourceId: OfficeUuidSchema,
  altText: z.string().max(2_000),
  decorative: z.boolean(),
  widthPt: z.number().positive().max(10_000),
  heightPt: z.number().positive().max(10_000),
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict().optional(),
}).strict()

export const OfficeChartSchema = NodeBaseSchema.extend({
  kind: z.literal('chart'),
  chartType: z.enum(['bar', 'line', 'pie', 'doughnut', 'scatter']),
  title: z.string().min(1).max(500),
  categories: z.array(z.string().max(500)).min(1).max(500),
  series: z.array(z.object({ name: z.string().min(1).max(200), values: z.array(z.number()).max(500) }).strict()).min(1).max(50),
  altText: z.string().min(1).max(2_000),
}).strict()

const OfficeVideoBaseSchema = NodeBaseSchema.extend({
  kind: z.literal('video'),
  resourceId: OfficeUuidSchema,
  posterResourceId: OfficeUuidSchema,
  altText: z.string().min(1).max(2_000),
  captionsResourceId: OfficeUuidSchema.optional(),
  transcript: z.string().min(1).max(200_000).optional(),
  recipientAccessibleUrl: z.string().url().refine((url) => url.startsWith('https:'), {
    message: 'DOCX video links must use HTTPS',
  }).optional(),
}).strict()

export const OfficeVideoSchema = OfficeVideoBaseSchema.refine((value) => Boolean(value.captionsResourceId || value.transcript), {
  message: 'Video requires captions or a transcript',
})

export const OfficePageBreakSchema = NodeBaseSchema.extend({ kind: z.literal('pageBreak') }).strict()
export const OfficeSectionBreakSchema = NodeBaseSchema.extend({ kind: z.literal('sectionBreak') }).strict()

export const DocumentFlowNodeSchema = z.union([
  OfficeParagraphSchema,
  OfficeHeadingSchema,
  OfficeListSchema,
  OfficeTableSchema,
  OfficeImageSchema,
  OfficeChartSchema,
  OfficeVideoSchema,
  OfficePageBreakSchema,
  OfficeSectionBreakSchema,
])
export type DocumentFlowNode = z.infer<typeof DocumentFlowNodeSchema>

export const DocumentSectionSchema = z
  .object({
    id: OfficeUuidSchema,
    page: z.object({ widthPt: z.number().min(144).max(2_000), heightPt: z.number().min(144).max(2_000), marginTopPt: z.number().min(0).max(500), marginRightPt: z.number().min(0).max(500), marginBottomPt: z.number().min(0).max(500), marginLeftPt: z.number().min(0).max(500), orientation: z.enum(['portrait', 'landscape']) }).strict(),
    header: z.array(OfficeRichTextRunSchema).max(1_000),
    footer: z.array(OfficeRichTextRunSchema).max(1_000),
    headerImage: z.object({
      resourceId: OfficeUuidSchema,
      altText: z.string().max(2_000),
      decorative: z.boolean(),
      widthPt: z.number().positive().max(1_000),
      heightPt: z.number().positive().max(1_000),
    }).strict().optional(),
    headerAlignment: z.enum(['start', 'center', 'end']).optional(),
    footerAlignment: z.enum(['start', 'center', 'end']).optional(),
    headerBorderBottom: z.object({ color: OfficeColorSchema, widthPt: z.number().positive().max(20) }).strict().optional(),
    footerBorderTop: z.object({ color: OfficeColorSchema, widthPt: z.number().positive().max(20) }).strict().optional(),
    showPageNumber: z.boolean(),
    nodes: z.array(DocumentFlowNodeSchema).max(50_000),
  })
  .strict()

export const OfficeGeometrySchema = z
  .object({
    xPt: z.number().min(-10_000).max(10_000),
    yPt: z.number().min(-10_000).max(10_000),
    widthPt: z.number().positive().max(10_000),
    heightPt: z.number().positive().max(10_000),
    rotationDeg: z.number().min(-360).max(360).default(0),
  })
  .strict()

const SlideObjectBaseSchema = NodeBaseSchema.extend({
  geometry: OfficeGeometrySchema,
  locked: z.boolean().default(false),
})

export const PresentationTextSchema = SlideObjectBaseSchema.extend({
  kind: z.literal('text'),
  runs: z.array(OfficeRichTextRunSchema).max(10_000),
  alignment: z.enum(['start', 'center', 'end', 'justify']).default('start'),
  verticalAlignment: z.enum(['top', 'middle', 'bottom']).default('top'),
}).strict()

export const PresentationImageSchema = SlideObjectBaseSchema.extend({
  kind: z.literal('image'),
  resourceId: OfficeUuidSchema,
  altText: z.string().max(2_000),
  decorative: z.boolean(),
}).strict()

export const PresentationShapeSchema = SlideObjectBaseSchema.extend({
  kind: z.literal('shape'),
  shape: z.enum(['rectangle', 'roundedRectangle', 'ellipse', 'triangle', 'line']),
  fill: OfficeColorSchema.optional(),
  stroke: OfficeColorSchema.optional(),
  strokeWidthPt: z.number().min(0).max(100).default(1),
  text: z.array(OfficeRichTextRunSchema).max(1_000).default([]),
  alignment: z.enum(['start', 'center', 'end', 'justify']).optional(),
  verticalAlignment: z.enum(['top', 'middle', 'bottom']).optional(),
  altText: z.string().max(2_000).optional(),
}).strict()

export const PresentationConnectorSchema = SlideObjectBaseSchema.extend({
  kind: z.literal('connector'),
  connector: z.enum(['straight', 'elbow']),
  fromObjectId: OfficeUuidSchema.optional(),
  toObjectId: OfficeUuidSchema.optional(),
  stroke: OfficeColorSchema,
}).strict()

export const PresentationTableSchema = OfficeTableSchema.omit({ kind: true }).extend({
  kind: z.literal('table'),
  geometry: OfficeGeometrySchema,
  locked: z.boolean().default(false),
}).strict()

export const PresentationChartSchema = OfficeChartSchema.omit({ kind: true }).extend({
  kind: z.literal('chart'),
  geometry: OfficeGeometrySchema,
  locked: z.boolean().default(false),
}).strict()

export const PresentationVideoSchema = OfficeVideoBaseSchema.extend({
  geometry: OfficeGeometrySchema,
  locked: z.boolean().default(false),
}).strict().refine((value) => Boolean(value.captionsResourceId || value.transcript), {
  message: 'Video requires captions or a transcript',
})

export const PresentationObjectSchema = z.union([
  PresentationTextSchema,
  PresentationImageSchema,
  PresentationShapeSchema,
  PresentationConnectorSchema,
  PresentationTableSchema,
  PresentationChartSchema,
  PresentationVideoSchema,
])
export type PresentationObject = z.infer<typeof PresentationObjectSchema>

export const PresentationSlideSchema = z
  .object({
    id: OfficeUuidSchema,
    title: z.string().min(1).max(500),
    masterId: OfficeUuidSchema,
    layoutId: OfficeUuidSchema,
    objects: z.array(PresentationObjectSchema).max(10_000),
    readingOrder: z.array(OfficeUuidSchema).max(10_000),
    notes: z.array(OfficeRichTextRunSchema).max(10_000),
  })
  .strict()
  .superRefine((slide, ctx) => {
    const ids = new Set(slide.objects.map((object) => object.id))
    if (slide.readingOrder.length !== ids.size || slide.readingOrder.some((id) => !ids.has(id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['readingOrder'], message: 'Reading order must contain every slide object exactly once' })
    }
  })
export type PresentationSlide = z.infer<typeof PresentationSlideSchema>

const ArtifactCommonSchema = z.object({
  schemaVersion: z.literal(OFFICE_SCHEMA_VERSION),
  capabilityVersion: z.literal(OFFICE_CAPABILITY_VERSION),
  artifactId: OfficeUuidSchema,
  workspaceId: OfficeUuidSchema,
  locale: z.string().min(2).max(35),
  defaultLanguage: z.string().min(2).max(35),
  templateVersionId: OfficeUuidSchema.nullable(),
  rootId: OfficeUuidSchema,
  title: z.string().min(1).max(1_000),
  resources: z.array(OfficeResourceRefSchema).max(20_000),
  accessibility: z.object({ title: z.string().min(1).max(1_000), description: z.string().max(4_000).optional() }).strict(),
})

export const PdfRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive().max(20_000),
  height: z.number().finite().positive().max(20_000),
}).strict()
export type PdfRect = z.infer<typeof PdfRectSchema>

export const PdfWidgetSchema = z.object({
  id: OfficeUuidSchema,
  pageId: OfficeUuidSchema,
  rect: PdfRectSchema,
  exportValue: z.string().max(10_000).optional(),
}).strict()
export type PdfWidget = z.infer<typeof PdfWidgetSchema>

export const PdfFieldValueSchema = z.union([
  z.string().max(100_000),
  z.boolean(),
  z.array(z.string().max(10_000)).max(1_000),
  z.null(),
])
export type PdfFieldValue = z.infer<typeof PdfFieldValueSchema>

export const PdfFieldSchema = z.object({
  id: OfficeUuidSchema,
  originalName: z.string().min(1).max(1_000),
  label: z.string().min(1).max(1_000),
  kind: z.enum(['text', 'checkbox', 'radio', 'dropdown', 'option-list', 'signature']),
  readOnly: z.boolean(),
  required: z.boolean(),
  value: PdfFieldValueSchema,
  allowedOptions: z.array(z.string().max(10_000)).max(10_000).optional(),
  widgets: z.array(PdfWidgetSchema).min(1).max(10_000),
}).strict().superRefine((field, ctx) => {
  const issue = (message: string, path: Array<string | number> = ['value']) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message })
  const options = field.allowedOptions
  if ((field.kind === 'radio' || field.kind === 'dropdown' || field.kind === 'option-list') && (!options || options.length === 0)) {
    issue('Choice fields require allowed options', ['allowedOptions'])
  }
  if (options && new Set(options).size !== options.length) issue('Field options must be unique', ['allowedOptions'])
  if (field.kind === 'text' && field.value !== null && typeof field.value !== 'string') issue('Text field value must be text or null')
  if (field.kind === 'checkbox' && field.value !== null && typeof field.value !== 'boolean') issue('Checkbox field value must be boolean or null')
  if ((field.kind === 'radio' || field.kind === 'dropdown') && field.value !== null && typeof field.value !== 'string') issue('Single-choice field value must be text or null')
  if (field.kind === 'option-list' && field.value !== null && !Array.isArray(field.value)) issue('Option-list field value must be a list or null')
  if (field.kind === 'signature' && field.value !== null) issue('Signature widget values remain null; placement is an overlay')
  const selected = Array.isArray(field.value) ? field.value : typeof field.value === 'string' ? [field.value] : []
  if (options && selected.some((value) => !options.includes(value))) issue('Field value must use an allowed option')
  if (Array.isArray(field.value) && new Set(field.value).size !== field.value.length) issue('Option-list values must be unique')
  if (field.required && (field.value === null || field.value === '' || Array.isArray(field.value) && field.value.length === 0)) issue('Required field cannot be empty')
})
export type PdfField = z.infer<typeof PdfFieldSchema>

const PdfOverlayCreatorSchema = z.object({
  type: z.enum(['user', 'assistant']),
  id: OfficeUuidSchema,
}).strict()

export const PdfTextAppearanceSchema = z.object({
  fontSizePt: z.number().finite().min(4).max(144),
  color: OfficeColorSchema,
  backgroundColor: OfficeColorSchema.optional(),
  alignment: z.enum(['start', 'center', 'end']).default('start'),
}).strict()
export type PdfTextAppearance = z.infer<typeof PdfTextAppearanceSchema>

const PdfOverlayBaseSchema = z.object({
  id: OfficeUuidSchema,
  pageId: OfficeUuidSchema,
  rect: PdfRectSchema,
  rotation: z.number().finite().min(0).lt(360),
  zOrder: z.number().int().min(-10_000).max(10_000),
  creator: PdfOverlayCreatorSchema,
})

export const PdfTextOverlaySchema = PdfOverlayBaseSchema.extend({
  kind: z.literal('text'),
  text: z.string().max(100_000),
  appearance: PdfTextAppearanceSchema,
}).strict()
export const PdfDateOverlaySchema = PdfOverlayBaseSchema.extend({
  kind: z.literal('date'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  appearance: PdfTextAppearanceSchema,
}).strict()
export const PdfCheckmarkOverlaySchema = PdfOverlayBaseSchema.extend({
  kind: z.literal('checkmark'),
  mark: z.enum(['check', 'x']).default('check'),
  color: OfficeColorSchema,
  strokeWidthPt: z.number().finite().positive().max(20).default(2),
}).strict()
export const PdfImageOverlaySchema = PdfOverlayBaseSchema.extend({
  kind: z.literal('image'),
  resourceId: OfficeUuidSchema,
}).strict()
export const PdfSignatureOverlaySchema = PdfOverlayBaseSchema.extend({
  kind: z.literal('signature'),
  resourceId: OfficeUuidSchema,
  authorizingUserId: OfficeUuidSchema,
  approvalReceiptId: OfficeUuidSchema.optional(),
}).strict()
export const PdfOverlaySchema = z.discriminatedUnion('kind', [
  PdfTextOverlaySchema,
  PdfDateOverlaySchema,
  PdfCheckmarkOverlaySchema,
  PdfImageOverlaySchema,
  PdfSignatureOverlaySchema,
])
export type PdfOverlay = z.infer<typeof PdfOverlaySchema>

export const PdfPlacementTargetSchema = z.object({
  id: OfficeUuidSchema,
  purpose: z.literal('signature'),
  pageId: OfficeUuidSchema,
  rect: PdfRectSchema,
  creatorUserId: OfficeUuidSchema,
  creationVersion: z.number().int().min(0),
}).strict()
export type PdfPlacementTarget = z.infer<typeof PdfPlacementTargetSchema>

export const PdfPageSchema = z.object({
  id: OfficeUuidSchema,
  sourcePageIndex: z.number().int().min(0).max(99),
  mediaBox: PdfRectSchema,
  cropBox: PdfRectSchema,
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  fields: z.array(PdfFieldSchema).max(10_000),
  overlays: z.array(PdfOverlaySchema).max(10_000),
  placementTargets: z.array(PdfPlacementTargetSchema).max(10_000),
}).strict()
export type PdfPage = z.infer<typeof PdfPageSchema>

function pdfRectWithin(rect: PdfRect, bounds: PdfRect): boolean {
  return rect.x >= 0 && rect.y >= 0
    && rect.x + rect.width <= bounds.width
    && rect.y + rect.height <= bounds.height
}

export const PdfSnapshotSchema = ArtifactCommonSchema.extend({
  family: z.literal('pdf'),
  source: z.object({
    fileId: OfficeUuidSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().positive().max(15 * 1024 * 1024),
    originalFileName: z.string().min(1).max(1_000),
    pageCount: z.number().int().min(1).max(100),
  }).strict(),
  pages: z.array(PdfPageSchema).min(1).max(100),
}).strict().superRefine((snapshot, ctx) => {
  const pageIds = new Set<string>()
  const sourceIndexes = new Set<number>()
  const objectIds = new Set<string>()
  const resourceById = new Map(snapshot.resources.map((resource) => [resource.id, resource]))
  const pagesById = new Map(snapshot.pages.map((page) => [page.id, page]))
  const issue = (path: Array<string | number>, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message })
  const admitId = (id: string, path: Array<string | number>) => {
    if (objectIds.has(id)) issue(path, 'PDF object IDs must be unique')
    objectIds.add(id)
  }
  for (const [pageIndex, page] of snapshot.pages.entries()) {
    if (pageIds.has(page.id)) issue(['pages', pageIndex, 'id'], 'PDF page IDs must be unique')
    pageIds.add(page.id)
    admitId(page.id, ['pages', pageIndex, 'id'])
    if (sourceIndexes.has(page.sourcePageIndex) || page.sourcePageIndex >= snapshot.source.pageCount) {
      issue(['pages', pageIndex, 'sourcePageIndex'], 'PDF source-page indexes must be unique and within the source')
    }
    sourceIndexes.add(page.sourcePageIndex)
    if (page.cropBox.x < page.mediaBox.x || page.cropBox.y < page.mediaBox.y
      || page.cropBox.x + page.cropBox.width > page.mediaBox.x + page.mediaBox.width
      || page.cropBox.y + page.cropBox.height > page.mediaBox.y + page.mediaBox.height) {
      issue(['pages', pageIndex, 'cropBox'], 'PDF CropBox must be contained by MediaBox')
    }
    const zOrders = new Set<number>()
    for (const [fieldIndex, field] of page.fields.entries()) {
      admitId(field.id, ['pages', pageIndex, 'fields', fieldIndex, 'id'])
      for (const [widgetIndex, widget] of field.widgets.entries()) {
        admitId(widget.id, ['pages', pageIndex, 'fields', fieldIndex, 'widgets', widgetIndex, 'id'])
        const widgetPage = pagesById.get(widget.pageId)
        if (!widgetPage || !pdfRectWithin(widget.rect, widgetPage.cropBox)) {
          issue(['pages', pageIndex, 'fields', fieldIndex, 'widgets', widgetIndex], 'PDF widget must fit a page CropBox')
        }
      }
    }
    for (const [overlayIndex, overlay] of page.overlays.entries()) {
      admitId(overlay.id, ['pages', pageIndex, 'overlays', overlayIndex, 'id'])
      if (overlay.pageId !== page.id || !pdfRectWithin(overlay.rect, page.cropBox)) {
        issue(['pages', pageIndex, 'overlays', overlayIndex], 'PDF overlay must fit its owning page CropBox')
      }
      if (zOrders.has(overlay.zOrder)) issue(['pages', pageIndex, 'overlays', overlayIndex, 'zOrder'], 'PDF overlay z-order must be unique within a page')
      zOrders.add(overlay.zOrder)
      if (overlay.kind === 'image' || overlay.kind === 'signature') {
        const resource = resourceById.get(overlay.resourceId)
        if (!resource || resource.kind !== 'image' || !/^image\/(?:png|jpeg)$/.test(resource.mime)) {
          issue(['pages', pageIndex, 'overlays', overlayIndex, 'resourceId'], 'PDF image overlay requires a declared PNG/JPEG image resource')
        }
      }
      if (overlay.kind === 'signature' && overlay.creator.type === 'assistant' && !overlay.approvalReceiptId) {
        issue(['pages', pageIndex, 'overlays', overlayIndex, 'approvalReceiptId'], 'Assistant signature overlay requires an approval receipt')
      }
    }
    for (const [targetIndex, target] of page.placementTargets.entries()) {
      admitId(target.id, ['pages', pageIndex, 'placementTargets', targetIndex, 'id'])
      if (target.pageId !== page.id || !pdfRectWithin(target.rect, page.cropBox)) {
        issue(['pages', pageIndex, 'placementTargets', targetIndex], 'PDF placement target must fit its owning page CropBox')
      }
    }
  }
})
export type PdfSnapshot = z.infer<typeof PdfSnapshotSchema>

export const DocumentSnapshotSchema = ArtifactCommonSchema.extend({
  family: z.literal('document'),
  sections: z.array(DocumentSectionSchema).min(1).max(10_000),
}).strict().superRefine((snapshot, ctx) => {
  const definitions = new Map<string, string>()
  for (const section of snapshot.sections) for (const node of section.nodes) {
    const formats: OfficeParagraphFormat[] = node.kind === 'paragraph' || node.kind === 'heading' ? [node] : node.kind === 'table' ? node.rows.flatMap(row => row.cells.flatMap(cell => officeCellParagraphs(cell).map(p => p.format))) : []
    for (const format of formats) {
      const numbering = format.numbering
      if (!numbering) continue
      const signature = JSON.stringify([numbering.format, numbering.start, numbering.pattern])
      const previous = definitions.get(numbering.listId)
      if (previous && previous !== signature) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sections'], message: 'A list identity must use one numbering format, start and pattern' })
      definitions.set(numbering.listId, signature)
    }
  }
})
export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>

export const PresentationSnapshotSchema = ArtifactCommonSchema.extend({
  family: z.literal('presentation'),
  slideSize: z.object({ widthPt: z.number().min(144).max(2_000), heightPt: z.number().min(144).max(2_000) }).strict(),
  themeId: OfficeUuidSchema,
  masters: z.array(z.object({ id: OfficeUuidSchema, name: z.string().min(1), lockedObjectIds: z.array(OfficeUuidSchema) }).strict()).min(1),
  layouts: z.array(z.object({ id: OfficeUuidSchema, masterId: OfficeUuidSchema, name: z.string().min(1), placeholderIds: z.array(OfficeUuidSchema) }).strict()).min(1),
  slides: z.array(PresentationSlideSchema).min(1).max(1_000),
}).strict()
export type PresentationSnapshot = z.infer<typeof PresentationSnapshotSchema>

export const SpreadsheetCellValueSchema = z.union([z.string().max(100_000), z.number().finite(), z.boolean(), z.null()])
export const SpreadsheetBorderSideSchema = z.object({
  style: z.enum(['thin', 'medium', 'thick', 'double', 'dotted', 'dashed', 'hair']).optional(),
  color: OfficeColorSchema.optional(),
}).strict()
export const SpreadsheetCellStyleSchema = z.object({
  font: z.object({
    family: z.string().min(1).max(128),
    sizePt: z.number().min(1).max(144),
    bold: z.boolean().default(false),
    italic: z.boolean().default(false),
    underline: z.boolean().default(false),
    strike: z.boolean().default(false),
    color: OfficeColorSchema,
  }).strict().optional(),
  fill: OfficeColorSchema.optional(),
  border: z.object({
    top: SpreadsheetBorderSideSchema.optional(),
    right: SpreadsheetBorderSideSchema.optional(),
    bottom: SpreadsheetBorderSideSchema.optional(),
    left: SpreadsheetBorderSideSchema.optional(),
  }).strict().optional(),
  alignment: z.object({
    horizontal: z.enum(['left', 'center', 'right', 'fill', 'justify']).optional(),
    vertical: z.enum(['top', 'middle', 'bottom', 'justify']).optional(),
    wrapText: z.boolean().default(false),
    textRotation: z.number().int().min(-90).max(90).default(0),
    indent: z.number().int().min(0).max(250).default(0),
  }).strict().optional(),
}).strict()
export type SpreadsheetCellStyle = z.infer<typeof SpreadsheetCellStyleSchema>

export const SpreadsheetCellSchema = z.object({
  id: OfficeUuidSchema,
  address: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
  valueType: z.enum(['blank', 'string', 'number', 'boolean', 'date', 'error']),
  value: SpreadsheetCellValueSchema,
  formula: z.string().min(1).max(32_000).optional(),
  calculatedValue: SpreadsheetCellValueSchema.optional(),
  error: z.enum(['#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!', '#CIRCULAR!']).optional(),
  numberFormat: z.string().max(255).optional(),
  style: SpreadsheetCellStyleSchema,
  locked: z.boolean().default(false),
}).strict()
export type SpreadsheetCell = z.infer<typeof SpreadsheetCellSchema>

export const SpreadsheetPrintSettingsSchema = z.object({
  printArea: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}:[A-Z]{1,3}[1-9][0-9]{0,6}$/).optional(),
  paperSize: z.enum(['A4', 'letter', 'legal']).default('A4'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  fitToWidth: z.number().int().min(0).max(100).default(1),
  fitToHeight: z.number().int().min(0).max(100).default(1),
  margins: z.object({
    leftIn: z.number().min(0).max(10),
    rightIn: z.number().min(0).max(10),
    topIn: z.number().min(0).max(10),
    bottomIn: z.number().min(0).max(10),
    headerIn: z.number().min(0).max(10),
    footerIn: z.number().min(0).max(10),
  }).strict(),
  horizontalCentered: z.boolean().default(false),
  verticalCentered: z.boolean().default(false),
  showGridLines: z.boolean().default(false),
  showHeadings: z.boolean().default(false),
}).strict()
export type SpreadsheetPrintSettings = z.infer<typeof SpreadsheetPrintSettingsSchema>

/** Supported simple Excel tables: one header, no totals, ordinary A1 formulas. */
export const SpreadsheetTableSchema = z.object({
  id: OfficeUuidSchema,
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,254}$/).refine(name => !/^(?:[RC]|R[0-9]+C[0-9]+|[A-Z]{1,3}[1-9][0-9]*)$/i.test(name), 'Table name must not be a cell reference'),
  ref: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}:[A-Z]{1,3}[1-9][0-9]{0,6}$/),
  autoFilter: z.boolean(),
  totalsRowShown: z.boolean().optional(),
  columns: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1).max(255), filterHidden: z.boolean().optional(), totalsRowLabel: z.string().max(255).optional(), totalsRowFunction: z.literal('none').optional() }).strict()).min(1).max(16384),
  style: z.object({ name: z.string().max(0, 'Named Excel table styles are not projected in the editor; use an explicitly unstyled table'), showFirstColumn: z.boolean(), showLastColumn: z.boolean(), showRowStripes: z.boolean(), showColumnStripes: z.boolean() }).strict(),
}).strict()
export type SpreadsheetTable = z.infer<typeof SpreadsheetTableSchema>

export const SpreadsheetWorksheetSchema = z.object({
  id: OfficeUuidSchema,
  name: z.string().min(1).max(31),
  visibility: z.enum(['visible', 'hidden', 'veryHidden']).default('visible'),
  tables: z.array(SpreadsheetTableSchema).max(1000).optional(),
  cells: z.array(SpreadsheetCellSchema).max(250_000),
  merges: z.array(z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}:[A-Z]{1,3}[1-9][0-9]{0,6}$/)).max(50_000),
  rowDimensions: z.array(z.object({ index: z.number().int().min(1).max(1_048_576), heightPt: z.number().positive().max(4_096), hidden: z.boolean().default(false) }).strict()).max(100_000),
  columnDimensions: z.array(z.object({ index: z.number().int().min(1).max(16_384), widthChars: z.number().positive().max(255), hidden: z.boolean().default(false) }).strict()).max(16_384),
  freeze: z.object({ rows: z.number().int().min(0).max(1_048_576), columns: z.number().int().min(0).max(16_384) }).strict(),
  images: z.array(z.object({
    id: OfficeUuidSchema,
    resourceId: OfficeUuidSchema,
    altText: z.string().max(2_000),
    decorative: z.boolean().default(false),
    from: z.object({ row: z.number().min(0), column: z.number().min(0) }).strict(),
    to: z.object({ row: z.number().min(0), column: z.number().min(0) }).strict(),
  }).strict()).max(1_000),
  validations: z.array(z.object({
    id: OfficeUuidSchema,
    range: z.string().min(1).max(255),
    type: z.enum(['list', 'whole', 'decimal', 'date', 'textLength', 'custom']),
    operator: z.enum(['between', 'notBetween', 'equal', 'notEqual', 'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual']).optional(),
    formulas: z.array(z.string().max(32_000)).max(2),
    allowBlank: z.boolean().default(true),
    prompt: z.string().max(1_000).optional(),
    error: z.string().max(1_000).optional(),
  }).strict()).max(10_000),
  conditionalFormats: z.array(z.object({
    id: OfficeUuidSchema,
    range: z.string().min(1).max(255),
    ruleType: z.enum(['cellIs', 'containsText', 'expression']),
    operator: z.string().max(64).optional(),
    formulas: z.array(z.string().max(32_000)).max(3),
    style: SpreadsheetCellStyleSchema,
    priority: z.number().int().min(1).max(100_000),
  }).strict()).max(10_000),
  print: SpreadsheetPrintSettingsSchema,
}).strict()
export type SpreadsheetWorksheet = z.infer<typeof SpreadsheetWorksheetSchema>

export const SpreadsheetSnapshotSchema = ArtifactCommonSchema.extend({
  family: z.literal('spreadsheet'),
  activeSheetId: OfficeUuidSchema,
  calculationMode: z.enum(['automatic', 'manual']).default('automatic'),
  worksheets: z.array(SpreadsheetWorksheetSchema).min(1).max(1_000),
}).strict().superRefine((snapshot, ctx) => {
  const sheetIds = new Set(snapshot.worksheets.map((sheet) => sheet.id))
  if (!sheetIds.has(snapshot.activeSheetId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activeSheetId'], message: 'Active sheet must belong to the workbook' })
  const names = new Set<string>()
  const tableNames = new Set<string>(), tableIds = new Set<string>()
  for (const [index, sheet] of snapshot.worksheets.entries()) {
    for (const table of sheet.tables ?? []) {
      const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['worksheets', index, 'tables'], message })
      if (tableNames.has(table.name.toLowerCase()) || tableIds.has(table.id)) issue('Duplicate table identity or name')
      tableNames.add(table.name.toLowerCase()); tableIds.add(table.id)
      if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}:[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(table.ref)) continue
      const bounds = table.ref.split(':').map(a => { const m = /^([A-Z]+)([0-9]+)$/.exec(a)!; return { row: Number(m[2]), col: [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) } })
      if (bounds[0].row > bounds[1].row || bounds[1].row > 1048576 || bounds[0].col > bounds[1].col || bounds[1].col > 16384 || bounds[1].col - bounds[0].col + 1 !== table.columns.length) issue('Unsafe table reference or column count')
      const intersects = (ref: string) => {
        const other = ref.split(':').map(a => { const m = /^([A-Z]+)([0-9]+)$/.exec(a)!; return { row: Number(m[2]), col: [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) } })
        return bounds[0].col <= other[1].col && bounds[1].col >= other[0].col && bounds[0].row <= other[1].row && bounds[1].row >= other[0].row
      }
      if (sheet.merges.some(intersects) || sheet.tables?.some(other => other !== table && intersects(other.ref))) issue('Overlapping table or merged table region')
      if (new Set(table.columns.map(c => c.id)).size !== table.columns.length || new Set(table.columns.map(c => c.name.toLowerCase())).size !== table.columns.length) issue('Duplicate table column identity or name')
    }

    const normalized = sheet.name.toLocaleLowerCase()
    if (names.has(normalized)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['worksheets', index, 'name'], message: 'Worksheet names must be unique' })
    names.add(normalized)
    const addresses = new Set<string>()
    for (const [cellIndex, cell] of sheet.cells.entries()) {
      if (addresses.has(cell.address)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['worksheets', index, 'cells', cellIndex, 'address'], message: 'Cell addresses must be unique within a worksheet' })
      addresses.add(cell.address)
    }
  }
})
export type SpreadsheetSnapshot = z.infer<typeof SpreadsheetSnapshotSchema>

export const OfficeArtifactSnapshotSchema = z.union([
  DocumentSnapshotSchema,
  PresentationSnapshotSchema,
  SpreadsheetSnapshotSchema,
  PdfSnapshotSchema,
])
export type OfficeArtifactSnapshot = z.infer<typeof OfficeArtifactSnapshotSchema>

export function assertOfficeArtifactSnapshot(value: unknown): OfficeArtifactSnapshot {
  return OfficeArtifactSnapshotSchema.parse(value)
}
