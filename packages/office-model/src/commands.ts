import { z } from 'zod'
import {
  DocumentFlowNodeSchema,
  OfficeArtifactSnapshotSchema,
  OfficeResourceRefSchema,
  OfficeRichTextRunSchema,
  OfficeUuidSchema,
  PresentationObjectSchema,
  PresentationSlideSchema,
  SpreadsheetCellValueSchema,
  SpreadsheetWorksheetSchema,
  type OfficeArtifactSnapshot,
} from './model.js'
import { normalizeCellAddress, recalculateSpreadsheet } from './spreadsheet.js'

const CommandBaseSchema = z.object({
  commandId: OfficeUuidSchema,
  artifactId: OfficeUuidSchema,
  baseVersion: z.number().int().min(0),
  actor: z.object({ type: z.enum(['user', 'assistant', 'import', 'system']), id: OfficeUuidSchema }).strict(),
  origin: z.enum(['manual', 'ai', 'import', 'offline', 'restore']),
})

const AtomicOfficeCommandSchema = z.discriminatedUnion('kind', [
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
    kind: z.literal('setSpreadsheetCell'),
    sheetId: OfficeUuidSchema,
    cellId: OfficeUuidSchema,
    address: z.string().min(2).max(10),
    valueType: z.enum(['blank', 'string', 'number', 'boolean', 'date']),
    value: SpreadsheetCellValueSchema,
    formula: z.string().min(1).max(32_000).optional(),
  }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('addWorksheet'), index: z.number().int().min(0), worksheet: SpreadsheetWorksheetSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('renameWorksheet'), sheetId: OfficeUuidSchema, name: z.string().min(1).max(31) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('reorderWorksheet'), sheetId: OfficeUuidSchema, index: z.number().int().min(0) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('deleteWorksheet'), sheetId: OfficeUuidSchema }).strict(),
])
export const OfficeCommandSchema = z.union([
  AtomicOfficeCommandSchema,
  CommandBaseSchema.extend({ kind: z.literal('batch'), commands: z.array(AtomicOfficeCommandSchema).min(1).max(1_000) }).strict(),
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
  } else if (command.kind === 'setSpreadsheetCell') {
    if (next.family !== 'spreadsheet') throw new Error('setSpreadsheetCell requires a spreadsheet')
    const sheet = next.worksheets.find((candidate) => candidate.id === command.sheetId)
    if (!sheet) throw new Error(`Worksheet ${command.sheetId} was not found`)
    const address = normalizeCellAddress(command.address)
    if (!address) throw new Error(`Cell address ${command.address} is invalid`)
    let cell = sheet.cells.find((candidate) => candidate.address === address)
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
  }

}

export function applyOfficeCommand(snapshot: OfficeArtifactSnapshot, input: OfficeCommand): OfficeArtifactSnapshot {
  const command = OfficeCommandSchema.parse(input)
  if (command.kind === 'replaceTextRange' && command.to < command.from) throw new Error('Range end must not precede range start')
  const next = clone(snapshot) as OfficeArtifactSnapshot
  if (command.kind !== 'batch') applySingleMutable(next, command)
  else {
    for (const child of command.commands) applySingleMutable(next, child)
  }
  const calculated = next.family === 'spreadsheet' ? recalculateSpreadsheet(next).snapshot : next
  return OfficeArtifactSnapshotSchema.parse(calculated)
}
