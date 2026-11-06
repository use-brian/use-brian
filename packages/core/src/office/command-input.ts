/** Shared typed Office edit vocabulary. [COMP:office/tools] */
import { z } from 'zod'
import { DocumentFlowNodeSchema, OfficeRichTextRunSchema, PdfFieldValueSchema, PdfRectSchema, PresentationObjectSchema, PresentationSlideSchema, SpreadsheetCellValueSchema, SpreadsheetRecordSchema, SpreadsheetWorksheetSchema } from '@use-brian/office-model'

const OperationBase = z.object({})
const AssistantPdfOverlaySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), rect: PdfRectSchema, rotation: z.number().finite().min(0).lt(360), text: z.string().max(100_000), appearance: z.object({ fontSizePt: z.number().finite().min(4).max(144), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/), backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), alignment: z.enum(['start', 'center', 'end']).default('start') }).strict() }).strict(),
  z.object({ kind: z.literal('date'), rect: PdfRectSchema, rotation: z.number().finite().min(0).lt(360), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), appearance: z.object({ fontSizePt: z.number().finite().min(4).max(144), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/), backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), alignment: z.enum(['start', 'center', 'end']).default('start') }).strict() }).strict(),
  z.object({ kind: z.literal('checkmark'), rect: PdfRectSchema, rotation: z.number().finite().min(0).lt(360), mark: z.enum(['check', 'x']).default('check'), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/), strokeWidthPt: z.number().finite().positive().max(20).default(2) }).strict(),
  z.object({ kind: z.literal('image'), rect: PdfRectSchema, rotation: z.number().finite().min(0).lt(360), resourceId: z.string().uuid() }).strict(),
])
export const AssistantOfficeOperationSchema = z.discriminatedUnion('kind', [
  OperationBase.extend({ kind: z.literal('appendSpreadsheetRecords'), sheetId: z.string().uuid(), tableId: z.string().uuid(), prototypeRow: z.number().int().min(1).max(1048576).optional(), records: z.array(SpreadsheetRecordSchema).min(1).max(10000) }).strict(),
  OperationBase.extend({ kind: z.literal('replaceTextRange'), targetId: z.string().uuid(), from: z.number().int().min(0), to: z.number().int().min(0), runs: z.array(OfficeRichTextRunSchema).max(10_000), preimageHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  OperationBase.extend({ kind: z.literal('updateText'), targetId: z.string().uuid(), runs: z.array(OfficeRichTextRunSchema).max(10_000) }).strict(),
  OperationBase.extend({ kind: z.literal('insertDocumentNode'), sectionId: z.string().uuid(), index: z.number().int().min(0).optional(), beforeNodeId: z.string().uuid().optional(), afterNodeId: z.string().uuid().optional(), node: DocumentFlowNodeSchema }).strict(),
  OperationBase.extend({ kind: z.literal('insertSlideObject'), slideId: z.string().uuid(), index: z.number().int().min(0), object: PresentationObjectSchema }).strict(),
  OperationBase.extend({ kind: z.literal('deleteObject'), targetId: z.string().uuid() }).strict(),
  OperationBase.extend({ kind: z.literal('setObjectProperty'), targetId: z.string().uuid(), path: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/)).min(1).max(8), value: z.unknown() }).strict(),
  OperationBase.extend({ kind: z.literal('addSlide'), index: z.number().int().min(0), slide: PresentationSlideSchema }).strict(),
  OperationBase.extend({ kind: z.literal('reorderSlide'), slideId: z.string().uuid(), index: z.number().int().min(0) }).strict(),
  OperationBase.extend({ kind: z.literal('deleteSlide'), slideId: z.string().uuid() }).strict(),
  OperationBase.extend({ kind: z.literal('reorderSlideObject'), slideId: z.string().uuid(), objectId: z.string().uuid(), index: z.number().int().min(0) }).strict(),
  OperationBase.extend({
    kind: z.literal('updateSpreadsheetImage'), sheetId: z.string().uuid(), imageId: z.string().uuid(),
    from: z.object({ row: z.number().min(0).max(1_048_576), column: z.number().min(0).max(16_384) }).strict(),
    to: z.object({ row: z.number().min(0).max(1_048_576), column: z.number().min(0).max(16_384) }).strict(),
    altText: z.string().max(2_000), decorative: z.boolean(),
  }).strict(),
  OperationBase.extend({
    kind: z.literal('setSpreadsheetCell'), sheetId: z.string().uuid(), cellId: z.string().uuid(), address: z.string().min(2).max(10),
    valueType: z.enum(['blank', 'string', 'number', 'boolean', 'date']), value: SpreadsheetCellValueSchema,
    formula: z.string().min(1).max(32_000).optional(),
  }).strict(),
  OperationBase.extend({ kind: z.literal('setSpreadsheetDimension'), sheetId: z.string().uuid(), axis: z.enum(['row', 'column']), index: z.number().int().min(1).max(1_048_576), size: z.number().positive().max(4_096) }).strict(),
  OperationBase.extend({ kind: z.literal('addWorksheet'), index: z.number().int().min(0), worksheet: SpreadsheetWorksheetSchema }).strict(),
  OperationBase.extend({ kind: z.literal('renameWorksheet'), sheetId: z.string().uuid(), name: z.string().min(1).max(31) }).strict(),
  OperationBase.extend({ kind: z.literal('reorderWorksheet'), sheetId: z.string().uuid(), index: z.number().int().min(0) }).strict(),
  OperationBase.extend({ kind: z.literal('deleteWorksheet'), sheetId: z.string().uuid() }).strict(),
  OperationBase.extend({ kind: z.literal('setPdfFieldValue'), fieldId: z.string().uuid(), value: PdfFieldValueSchema }).strict(),
  OperationBase.extend({ kind: z.literal('addPdfOverlay'), pageId: z.string().uuid(), overlay: AssistantPdfOverlaySchema }).strict(),
  OperationBase.extend({ kind: z.literal('transformPdfOverlay'), overlayId: z.string().uuid(), rect: PdfRectSchema, rotation: z.number().finite().min(0).lt(360) }).strict(),
  OperationBase.extend({ kind: z.literal('removePdfOverlay'), overlayId: z.string().uuid() }).strict(),
  OperationBase.extend({ kind: z.literal('rotatePdfPage'), pageId: z.string().uuid(), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]) }).strict(),
  OperationBase.extend({ kind: z.literal('reorderPdfPage'), pageId: z.string().uuid(), toIndex: z.number().int().min(0).max(99) }).strict(),
  OperationBase.extend({ kind: z.literal('deletePdfPage'), pageId: z.string().uuid() }).strict(),
])
export type AssistantOfficeOperation = z.infer<typeof AssistantOfficeOperationSchema>

export const AssistantOfficePlanSchema = z.object({ commands: z.array(AssistantOfficeOperationSchema).min(1).max(200) }).strict()
