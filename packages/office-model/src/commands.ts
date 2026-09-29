import { officeSnapshotPreconditionHash } from './snapshot-hash.js'
import { z } from 'zod'
import {
  DocumentFlowNodeSchema,
  OfficeArtifactSnapshotSchema,
  PdfFieldValueSchema,
  PdfOverlaySchema,
  PdfPlacementTargetSchema,
  PdfRectSchema,
  OfficeResourceRefSchema,
  OfficeRichTextRunSchema,
  OfficeUuidSchema,
  PresentationObjectSchema,
  PresentationSlideSchema,
  SpreadsheetCellValueSchema,
  SpreadsheetWorksheetSchema,
  type OfficeArtifactSnapshot,
  type PdfPage,
  type PdfRect,
  type PdfSnapshot,
} from './model.js'
import { appendSpreadsheetRecords, SpreadsheetRecordSchema } from './spreadsheet-tables.js'
import { normalizeCellAddress, recalculateSpreadsheet } from './spreadsheet.js'

const CommandBaseSchema = z.object({
  commandId: OfficeUuidSchema,
  artifactId: OfficeUuidSchema,
  baseVersion: z.number().int().min(0),
  actor: z.object({ type: z.enum(['user', 'assistant', 'import', 'system']), id: OfficeUuidSchema }).strict(),
  origin: z.enum(['manual', 'ai', 'import', 'offline', 'restore']),
})

const AtomicOfficeCommandSchema = z.discriminatedUnion('kind', [
  CommandBaseSchema.extend({ kind: z.literal('appendSpreadsheetRecords'), sheetId: OfficeUuidSchema, tableId: OfficeUuidSchema, prototypeRow: z.number().int().min(1).max(1048576).optional(), records: z.array(SpreadsheetRecordSchema).min(1).max(10000) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('updateText'), targetId: OfficeUuidSchema, runs: z.array(OfficeRichTextRunSchema) }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal('replaceTextRange'),
    targetId: OfficeUuidSchema,
    from: z.number().int().min(0),
    to: z.number().int().min(0),
    runs: z.array(OfficeRichTextRunSchema),
    preimageHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('insertDocumentNode'), sectionId: OfficeUuidSchema, index: z.number().int().min(0), node: DocumentFlowNodeSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('insertSlideObject'), slideId: OfficeUuidSchema, index: z.number().int().min(0), object: PresentationObjectSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('deleteObject'), targetId: OfficeUuidSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('setObjectProperty'), targetId: OfficeUuidSchema, path: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/)).min(1).max(8), value: z.unknown() }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('addSlide'), index: z.number().int().min(0), slide: PresentationSlideSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('reorderSlide'), slideId: OfficeUuidSchema, index: z.number().int().min(0) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('deleteSlide'), slideId: OfficeUuidSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('reorderSlideObject'), slideId: OfficeUuidSchema, objectId: OfficeUuidSchema, index: z.number().int().min(0) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('attachResource'), resource: OfficeResourceRefSchema }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal('updateSpreadsheetImage'),
    sheetId: OfficeUuidSchema,
    imageId: OfficeUuidSchema,
    from: z.object({ row: z.number().min(0).max(1_048_576), column: z.number().min(0).max(16_384) }).strict(),
    to: z.object({ row: z.number().min(0).max(1_048_576), column: z.number().min(0).max(16_384) }).strict(),
    altText: z.string().max(2_000),
    decorative: z.boolean(),
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal('setSpreadsheetCell'),
    sheetId: OfficeUuidSchema,
    cellId: OfficeUuidSchema,
    address: z.string().min(2).max(10),
    valueType: z.enum(['blank', 'string', 'number', 'boolean', 'date']),
    value: SpreadsheetCellValueSchema,
    formula: z.string().min(1).max(32_000).optional(),
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal('setSpreadsheetDimension'),
    sheetId: OfficeUuidSchema,
    axis: z.enum(['row', 'column']),
    index: z.number().int().min(1).max(1_048_576),
    size: z.number().positive().max(4_096),
  }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('addWorksheet'), index: z.number().int().min(0), worksheet: SpreadsheetWorksheetSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('renameWorksheet'), sheetId: OfficeUuidSchema, name: z.string().min(1).max(31) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('reorderWorksheet'), sheetId: OfficeUuidSchema, index: z.number().int().min(0) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('deleteWorksheet'), sheetId: OfficeUuidSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('setPdfFieldValue'), fieldId: OfficeUuidSchema, value: PdfFieldValueSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('addPdfOverlay'), pageId: OfficeUuidSchema, overlay: PdfOverlaySchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('transformPdfOverlay'), overlayId: OfficeUuidSchema, rect: PdfRectSchema, rotation: z.number().finite().min(0).lt(360) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('removePdfOverlay'), overlayId: OfficeUuidSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('createPdfPlacementTarget'), pageId: OfficeUuidSchema, target: PdfPlacementTargetSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('removePdfPlacementTarget'), targetId: OfficeUuidSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('placePdfSignature'), targetId: OfficeUuidSchema, signatureResourceId: OfficeUuidSchema, approvalReceiptId: OfficeUuidSchema.optional() }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('rotatePdfPage'), pageId: OfficeUuidSchema, rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('reorderPdfPage'), pageId: OfficeUuidSchema, toIndex: z.number().int().min(0).max(99) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('deletePdfPage'), pageId: OfficeUuidSchema }).strict(),
])
export const OfficeCommandSchema = z.union([
  AtomicOfficeCommandSchema,
  CommandBaseSchema.extend({ kind: z.literal('batch'), expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), commands: z.array(AtomicOfficeCommandSchema).min(1).max(1_000) }).strict(),
])
export type OfficeCommand = z.infer<typeof OfficeCommandSchema>
type AtomicOfficeCommand = z.infer<typeof AtomicOfficeCommandSchema>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function findObject(value: unknown, id: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  if (!Array.isArray(value) && (value as Record<string, unknown>).id === id) return value as Record<string, unknown>
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findObject(child, id)
    if (found) return found
  }
  return null
}

function assertSafePropertyPart(part: string): void {
  if (part === '__proto__' || part === 'constructor' || part === 'prototype') throw new Error('Unsafe property path')
}

function deleteObject(value: unknown, id: string): boolean {
  if (!value || typeof value !== 'object') return false
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (!Array.isArray(child)) continue
    const index = child.findIndex((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).id === id)
    if (index >= 0) {
      child.splice(index, 1)
      return true
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (deleteObject(child, id)) return true
  }
  return false
}

function requirePdf(next: OfficeArtifactSnapshot, commandKind: string): PdfSnapshot {
  if (next.family !== 'pdf') throw new Error(`${commandKind} requires a PDF session`)
  return next
}

function assertPdfActor(command: AtomicOfficeCommand): asserts command is AtomicOfficeCommand & { actor: { type: 'user' | 'assistant'; id: string } } {
  if (command.actor.type !== 'user' && command.actor.type !== 'assistant') throw new Error('PDF edits require a user or assistant actor')
}

function findPdfPage(snapshot: PdfSnapshot, pageId: string): PdfPage {
  const page = snapshot.pages.find((candidate) => candidate.id === pageId)
  if (!page) throw new Error(`PDF page ${pageId} was not found`)
  return page
}

function pdfRectWithin(rect: PdfRect, page: PdfPage): boolean {
  return rect.x >= 0 && rect.y >= 0
    && rect.x + rect.width <= page.cropBox.width
    && rect.y + rect.height <= page.cropBox.height
}

function assertPdfRect(rect: PdfRect, page: PdfPage): void {
  if (!pdfRectWithin(rect, page)) throw new Error('PDF geometry must fit the page CropBox')
}

function findPdfOverlay(snapshot: PdfSnapshot, overlayId: string): { page: PdfPage; index: number } {
  for (const page of snapshot.pages) {
    const index = page.overlays.findIndex((overlay) => overlay.id === overlayId)
    if (index >= 0) return { page, index }
  }
  throw new Error(`PDF overlay ${overlayId} was not found`)
}

function validatePdfFieldValue(field: PdfSnapshot['pages'][number]['fields'][number], value: PdfSnapshot['pages'][number]['fields'][number]['value']): void {
  if (field.readOnly) throw new Error(`PDF field ${field.id} is read-only`)
  if (field.kind === 'signature') throw new Error('Signature widgets are placement targets, not field values')
  if (field.kind === 'text' && value !== null && typeof value !== 'string') throw new Error('PDF text field requires text or null')
  if (field.kind === 'checkbox' && value !== null && typeof value !== 'boolean') throw new Error('PDF checkbox field requires boolean or null')
  if ((field.kind === 'radio' || field.kind === 'dropdown') && value !== null && typeof value !== 'string') throw new Error('PDF single-choice field requires text or null')
  if (field.kind === 'option-list' && value !== null && !Array.isArray(value)) throw new Error('PDF option-list field requires a list or null')
  const selected = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  if (field.allowedOptions && selected.some((candidate) => !field.allowedOptions!.includes(candidate))) throw new Error('PDF field value is not an allowed option')
  if (Array.isArray(value) && new Set(value).size !== value.length) throw new Error('PDF option-list values must be unique')
  if (field.required && (value === null || value === '' || Array.isArray(value) && value.length === 0)) throw new Error('Required PDF field cannot be empty')
}

function applySingleMutable(next: OfficeArtifactSnapshot, command: AtomicOfficeCommand): void {
  if (next.artifactId !== command.artifactId) throw new Error('Command artifact does not match snapshot')

  if (command.kind === 'updateText') {
    const target = findObject(next, command.targetId)
    if (!target || !('runs' in target)) throw new Error(`Text target ${command.targetId} was not found`)
    target.runs = command.runs
  } else if (command.kind === 'replaceTextRange') {
    throw new Error('replaceTextRange requires the Document fragment adapter')
  } else if (command.kind === 'insertDocumentNode') {
    if (next.family !== 'document') throw new Error('insertDocumentNode requires a document')
    const section = next.sections.find((candidate) => candidate.id === command.sectionId)
    if (!section) throw new Error(`Section ${command.sectionId} was not found`)
    section.nodes.splice(Math.min(command.index, section.nodes.length), 0, command.node)
  } else if (command.kind === 'insertSlideObject') {
    if (next.family !== 'presentation') throw new Error('insertSlideObject requires a presentation')
    const slide = next.slides.find((candidate) => candidate.id === command.slideId)
    if (!slide) throw new Error(`Slide ${command.slideId} was not found`)
    slide.objects.splice(Math.min(command.index, slide.objects.length), 0, command.object)
    slide.readingOrder.splice(Math.min(command.index, slide.readingOrder.length), 0, command.object.id)
  } else if (command.kind === 'deleteObject') {
    if (!deleteObject(next, command.targetId)) throw new Error(`Object ${command.targetId} was not found`)
    if (next.family === 'presentation') {
      for (const slide of next.slides) slide.readingOrder = slide.readingOrder.filter((id) => id !== command.targetId)
    }
  } else if (command.kind === 'setObjectProperty') {
    const target = command.targetId === next.rootId ? next as unknown as Record<string, unknown> : findObject(next, command.targetId)
    if (!target) throw new Error(`Object ${command.targetId} was not found`)
    let cursor = target
    for (const part of command.path.slice(0, -1)) {
      assertSafePropertyPart(part)
      const child = cursor[part]
      if (!child || typeof child !== 'object' || Array.isArray(child)) throw new Error(`Property path ${command.path.join('.')} was not found`)
      cursor = child as Record<string, unknown>
    }
    const finalPart = command.path.at(-1)!
    assertSafePropertyPart(finalPart)
    cursor[finalPart] = command.value
  } else if (command.kind === 'addSlide') {
    if (next.family !== 'presentation') throw new Error('addSlide requires a presentation')
    next.slides.splice(Math.min(command.index, next.slides.length), 0, command.slide)
  } else if (command.kind === 'reorderSlide') {
    if (next.family !== 'presentation') throw new Error('reorderSlide requires a presentation')
    const from = next.slides.findIndex((slide) => slide.id === command.slideId)
    if (from < 0) throw new Error(`Slide ${command.slideId} was not found`)
    const [slide] = next.slides.splice(from, 1)
    next.slides.splice(Math.min(command.index, next.slides.length), 0, slide)
  } else if (command.kind === 'deleteSlide') {
    if (next.family !== 'presentation') throw new Error('deleteSlide requires a presentation')
    if (next.slides.length === 1) throw new Error('A presentation must contain at least one slide')
    const index = next.slides.findIndex((slide) => slide.id === command.slideId)
    if (index < 0) throw new Error(`Slide ${command.slideId} was not found`)
    next.slides.splice(index, 1)
  } else if (command.kind === 'reorderSlideObject') {
    if (next.family !== 'presentation') throw new Error('reorderSlideObject requires a presentation')
    const slide = next.slides.find((candidate) => candidate.id === command.slideId)
    if (!slide) throw new Error(`Slide ${command.slideId} was not found`)
    const from = slide.objects.findIndex((object) => object.id === command.objectId)
    if (from < 0) throw new Error(`Object ${command.objectId} was not found`)
    const [object] = slide.objects.splice(from, 1)
    slide.objects.splice(Math.min(command.index, slide.objects.length), 0, object)
  } else if (command.kind === 'attachResource') {
    const byId = next.resources.find((resource) => resource.id === command.resource.id)
    const byHash = next.resources.find((resource) => resource.hash === command.resource.hash)
    if (byId || byHash) {
      const existing = byId ?? byHash!
      if (JSON.stringify(existing) !== JSON.stringify(command.resource)) throw new Error('Office resource identity or hash collision')
    } else next.resources.push(command.resource)
  } else if (command.kind === 'updateSpreadsheetImage') {
    if (next.family !== 'spreadsheet') throw new Error('updateSpreadsheetImage requires a spreadsheet')
    const sheet = next.worksheets.find((candidate) => candidate.id === command.sheetId)
    if (!sheet) throw new Error(`Worksheet ${command.sheetId} was not found`)
    const image = sheet.images.find((candidate) => candidate.id === command.imageId)
    if (!image) throw new Error(`Worksheet image ${command.imageId} was not found`)
    if (command.from.row >= command.to.row || command.from.column >= command.to.column) throw new Error('Worksheet image extent must have positive width and height')
    Object.assign(image, { from: command.from, to: command.to, altText: command.decorative ? '' : command.altText, decorative: command.decorative })
  } else if (command.kind === 'appendSpreadsheetRecords') {
    if (next.family !== 'spreadsheet') throw new Error('appendSpreadsheetRecords requires a spreadsheet')
    next.worksheets = appendSpreadsheetRecords(next, command).worksheets
  } else if (command.kind === 'setSpreadsheetCell') {
    if (next.family !== 'spreadsheet') throw new Error('setSpreadsheetCell requires a spreadsheet')
    const sheet = next.worksheets.find((candidate) => candidate.id === command.sheetId)
    if (!sheet) throw new Error(`Worksheet ${command.sheetId} was not found`)
    const address = normalizeCellAddress(command.address)
    if (!address) throw new Error(`Cell address ${command.address} is invalid`)
    let cell = sheet.cells.find((candidate) => candidate.address === address)
    // Both coordinates and identity must name the same cell; a selected ID must
    // never authorize overwriting a different address through the executor.
    if (cell && cell.id !== command.cellId || !cell && findObject(next, command.cellId)) throw new Error('Spreadsheet cell identity/address mismatch')
    if (!cell) {
      cell = { id: command.cellId, address, valueType: command.valueType, value: command.value, style: {}, locked: false }
      sheet.cells.push(cell)
    }
    if (cell.locked && command.origin !== 'import') throw new Error(`Cell ${address} is locked`)
    cell.valueType = command.valueType
    cell.value = command.formula ? null : command.value
    if (command.formula) cell.formula = command.formula.replace(/^=/, '')
    else delete cell.formula
    delete cell.calculatedValue
    delete cell.error
  } else if (command.kind === 'setSpreadsheetDimension') {
    if (next.family !== 'spreadsheet') throw new Error('setSpreadsheetDimension requires a spreadsheet')
    const sheet = next.worksheets.find((candidate) => candidate.id === command.sheetId)
    if (!sheet) throw new Error(`Worksheet ${command.sheetId} was not found`)
    if (command.axis === 'column' && command.index > 16_384) throw new Error('Spreadsheet column dimension index exceeds the XLSX limit')
    if (command.axis === 'column' && command.size > 255) throw new Error('Spreadsheet column width exceeds the XLSX limit')
    if (command.axis === 'row') {
      const dimension = sheet.rowDimensions.find((candidate) => candidate.index === command.index)
      if (dimension) Object.assign(dimension, { heightPt: command.size, hidden: false })
      else sheet.rowDimensions.push({ index: command.index, heightPt: command.size, hidden: false })
      sheet.rowDimensions.sort((left, right) => left.index - right.index)
    } else {
      const dimension = sheet.columnDimensions.find((candidate) => candidate.index === command.index)
      if (dimension) Object.assign(dimension, { widthChars: command.size, hidden: false })
      else sheet.columnDimensions.push({ index: command.index, widthChars: command.size, hidden: false })
      sheet.columnDimensions.sort((left, right) => left.index - right.index)
    }
  } else if (command.kind === 'addWorksheet') {
    if (next.family !== 'spreadsheet') throw new Error('addWorksheet requires a spreadsheet')
    next.worksheets.splice(Math.min(command.index, next.worksheets.length), 0, command.worksheet)
  } else if (command.kind === 'renameWorksheet') {
    if (next.family !== 'spreadsheet') throw new Error('renameWorksheet requires a spreadsheet')
    const sheet = next.worksheets.find((candidate) => candidate.id === command.sheetId)
    if (!sheet) throw new Error(`Worksheet ${command.sheetId} was not found`)
    sheet.name = command.name
  } else if (command.kind === 'reorderWorksheet') {
    if (next.family !== 'spreadsheet') throw new Error('reorderWorksheet requires a spreadsheet')
    const from = next.worksheets.findIndex((sheet) => sheet.id === command.sheetId)
    if (from < 0) throw new Error(`Worksheet ${command.sheetId} was not found`)
    const [sheet] = next.worksheets.splice(from, 1)
    next.worksheets.splice(Math.min(command.index, next.worksheets.length), 0, sheet)
  } else if (command.kind === 'deleteWorksheet') {
    if (next.family !== 'spreadsheet') throw new Error('deleteWorksheet requires a spreadsheet')
    if (next.worksheets.length === 1) throw new Error('A spreadsheet must contain at least one worksheet')
    const index = next.worksheets.findIndex((sheet) => sheet.id === command.sheetId)
    if (index < 0) throw new Error(`Worksheet ${command.sheetId} was not found`)
    next.worksheets.splice(index, 1)
    if (next.activeSheetId === command.sheetId) next.activeSheetId = next.worksheets[Math.min(index, next.worksheets.length - 1)].id
  } else if (command.kind === 'setPdfFieldValue') {
    const pdf = requirePdf(next, command.kind)
    assertPdfActor(command)
    const field = pdf.pages.flatMap((page) => page.fields).find((candidate) => candidate.id === command.fieldId)
    if (!field) throw new Error(`PDF field ${command.fieldId} was not found`)
    validatePdfFieldValue(field, command.value)
    field.value = command.value
  } else if (command.kind === 'addPdfOverlay') {
    const pdf = requirePdf(next, command.kind)
    assertPdfActor(command)
    const page = findPdfPage(pdf, command.pageId)
    if (command.overlay.kind === 'signature') throw new Error('Signature overlays require placePdfSignature')
    if (command.overlay.pageId !== page.id) throw new Error('PDF overlay page does not match the command target')
    if (command.overlay.creator.type !== command.actor.type || command.overlay.creator.id !== command.actor.id) throw new Error('PDF overlay creator must match the command actor')
    assertPdfRect(command.overlay.rect, page)
    if (command.overlay.kind === 'image') {
      const resourceId = command.overlay.resourceId
      const resource = pdf.resources.find((candidate) => candidate.id === resourceId)
      if (!resource || resource.kind !== 'image' || !/^image\/(?:png|jpeg)$/.test(resource.mime)) throw new Error('PDF image overlay requires an owned PNG/JPEG resource')
    }
    if (page.overlays.some((overlay) => overlay.zOrder === command.overlay.zOrder)) throw new Error('PDF overlay z-order must be unique within a page')
    page.overlays.push(command.overlay)
  } else if (command.kind === 'transformPdfOverlay') {
    const pdf = requirePdf(next, command.kind)
    assertPdfActor(command)
    const { page, index } = findPdfOverlay(pdf, command.overlayId)
    if (page.overlays[index].kind === 'signature' && command.actor.type === 'assistant') throw new Error('Assistant cannot transform a PDF signature overlay')
    assertPdfRect(command.rect, page)
    page.overlays[index].rect = command.rect
    page.overlays[index].rotation = command.rotation
  } else if (command.kind === 'removePdfOverlay') {
    const pdf = requirePdf(next, command.kind)
    assertPdfActor(command)
    const { page, index } = findPdfOverlay(pdf, command.overlayId)
    if (page.overlays[index].kind === 'signature' && command.actor.type === 'assistant') throw new Error('Assistant cannot remove a PDF signature overlay')
    page.overlays.splice(index, 1)
  } else if (command.kind === 'createPdfPlacementTarget') {
    const pdf = requirePdf(next, command.kind)
    assertPdfActor(command)
    if (command.actor.type !== 'user') throw new Error('Only a user can create a PDF signature placement target')
    const page = findPdfPage(pdf, command.pageId)
    if (command.target.pageId !== page.id || command.target.creatorUserId !== command.actor.id) throw new Error('PDF placement target authority does not match the command')
    if (command.target.creationVersion !== command.baseVersion) throw new Error('PDF placement target version does not match the command base')
    assertPdfRect(command.target.rect, page)
    page.placementTargets.push(command.target)
  } else if (command.kind === 'removePdfPlacementTarget') {
    const pdf = requirePdf(next, command.kind)
    assertPdfActor(command)
    if (command.actor.type !== 'user') throw new Error('Only a user can remove a PDF signature placement target')
    for (const page of pdf.pages) {
      const index = page.placementTargets.findIndex((target) => target.id === command.targetId)
      if (index >= 0) {
        if (page.placementTargets[index].creatorUserId !== command.actor.id) throw new Error('PDF placement target belongs to another user')
        page.placementTargets.splice(index, 1)
        return
      }
    }
    throw new Error(`PDF placement target ${command.targetId} was not found`)
  } else if (command.kind === 'placePdfSignature') {
    const pdf = requirePdf(next, command.kind)
    assertPdfActor(command)
    let targetPage: PdfPage | undefined
    let targetIndex = -1
    for (const page of pdf.pages) {
      const index = page.placementTargets.findIndex((target) => target.id === command.targetId)
      if (index >= 0) {
        targetPage = page
        targetIndex = index
        break
      }
    }
    if (!targetPage || targetIndex < 0) throw new Error(`PDF placement target ${command.targetId} was not found`)
    const target = targetPage.placementTargets[targetIndex]
    if (command.actor.type === 'user' && command.actor.id !== target.creatorUserId) throw new Error('PDF placement target belongs to another user')
    if (command.actor.type === 'assistant' && !command.approvalReceiptId) throw new Error('Assistant PDF signature placement requires an approval receipt')
    const resource = pdf.resources.find((candidate) => candidate.id === command.signatureResourceId)
    if (!resource || resource.kind !== 'image' || resource.mime !== 'image/png') throw new Error('PDF signature requires an owned normalized PNG resource')
    const zOrder = targetPage.overlays.reduce((maximum, overlay) => Math.max(maximum, overlay.zOrder), -1) + 1
    if (zOrder > 10_000) throw new Error('PDF overlay z-order limit reached')
    targetPage.placementTargets.splice(targetIndex, 1)
    targetPage.overlays.push({
      id: command.commandId,
      kind: 'signature',
      pageId: targetPage.id,
      rect: target.rect,
      rotation: 0,
      zOrder,
      creator: command.actor,
      resourceId: command.signatureResourceId,
      authorizingUserId: target.creatorUserId,
      ...(command.approvalReceiptId ? { approvalReceiptId: command.approvalReceiptId } : {}),
    })
  } else if (command.kind === 'rotatePdfPage') {
    const pdf = requirePdf(next, command.kind)
    assertPdfActor(command)
    findPdfPage(pdf, command.pageId).rotation = command.rotation
  } else if (command.kind === 'reorderPdfPage') {
    const pdf = requirePdf(next, command.kind)
    assertPdfActor(command)
    if (command.toIndex >= pdf.pages.length) throw new Error('PDF page destination is out of range')
    const from = pdf.pages.findIndex((page) => page.id === command.pageId)
    if (from < 0) throw new Error(`PDF page ${command.pageId} was not found`)
    const [page] = pdf.pages.splice(from, 1)
    pdf.pages.splice(command.toIndex, 0, page)
  } else if (command.kind === 'deletePdfPage') {
    const pdf = requirePdf(next, command.kind)
    assertPdfActor(command)
    if (pdf.pages.length === 1) throw new Error('A PDF session must contain at least one page')
    const index = pdf.pages.findIndex((page) => page.id === command.pageId)
    if (index < 0) throw new Error(`PDF page ${command.pageId} was not found`)
    for (const page of pdf.pages) {
      if (page.id === command.pageId) continue
      for (const field of page.fields) field.widgets = field.widgets.filter((widget) => widget.pageId !== command.pageId)
    }
    pdf.pages.splice(index, 1)
  }

}

export function applyOfficeCommand(snapshot: OfficeArtifactSnapshot, input: OfficeCommand): OfficeArtifactSnapshot {
  const command = OfficeCommandSchema.parse(input)
  if (command.kind === 'batch' && command.expectedSnapshotHash && officeSnapshotPreconditionHash(snapshot) !== command.expectedSnapshotHash) throw new Error('Office snapshot precondition changed')
  if (command.kind === 'replaceTextRange' && command.to < command.from) throw new Error('Range end must not precede range start')
  const next = clone(snapshot) as OfficeArtifactSnapshot
  if (command.kind !== 'batch') applySingleMutable(next, command)
  else {
    for (const child of command.commands) applySingleMutable(next, child)
  }
  const calculated = next.family === 'spreadsheet' ? recalculateSpreadsheet(next).snapshot : next
  return OfficeArtifactSnapshotSchema.parse(calculated)
}
