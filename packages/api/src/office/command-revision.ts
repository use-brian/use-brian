/** Command-native, target-bounded Brian revision planning for Office artifacts.
 * [COMP:api/office-generation] */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { collectStream, fitOfficeArtifact, repairOfficeArtifactFit, type LLMProvider, type Message } from '@use-brian/core'
import {
  DocumentFlowNodeSchema,
  OfficeArtifactSnapshotSchema,
  OfficeCommandSchema,
  OfficeRichTextRunSchema,
  PresentationObjectSchema,
  PresentationSlideSchema,
  SpreadsheetCellValueSchema,
  SpreadsheetRecordSchema,
  normalizeCellAddress,
  parseCellAddress,
  tableBounds,
  SpreadsheetWorksheetSchema,
  applyOfficeCommand,
  preflightOfficeCandidate,
  type OfficeArtifactSnapshot,
  type OfficeCommand,
} from '@use-brian/office-model'

const OperationBase = z.object({})
const AssistantOfficeOperationSchema = z.discriminatedUnion('kind', [
  OperationBase.extend({ kind: z.literal('appendSpreadsheetRecords'), sheetId: z.string().uuid(), tableId: z.string().uuid(), prototypeRow: z.number().int().min(1).max(1048576).optional(), records: z.array(SpreadsheetRecordSchema).min(1).max(10000) }).strict(),
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
])
type AssistantOfficeOperation = z.infer<typeof AssistantOfficeOperationSchema>

const AssistantOfficePlanSchema = z.object({ commands: z.array(AssistantOfficeOperationSchema).min(1).max(200) }).strict()

// Derive payload keys from the validator so new operations cannot silently
// become names-only capabilities in the model's contract.
const operationFieldCatalog = AssistantOfficeOperationSchema.options.map((operation) => ({
  kind: operation.shape.kind.value,
  required: Object.entries(operation.shape).filter(([key, field]) => key !== 'kind' && !field.isOptional()).map(([key]) => key),
  optional: Object.entries(operation.shape).filter(([key, field]) => key !== 'kind' && field.isOptional()).map(([key]) => key),
}))

const SYSTEM_PROMPT = `You are Brian's command planner for a canonical Office artifact. Return one JSON object and nothing else: {"commands":[...]}.

Use only these operation kinds: appendSpreadsheetRecords, updateText, insertDocumentNode, insertSlideObject, deleteObject, setObjectProperty, addSlide, reorderSlide, deleteSlide, reorderSlideObject, updateSpreadsheetImage, setSpreadsheetCell, setSpreadsheetDimension, addWorksheet, renameWorksheet, reorderWorksheet, deleteWorksheet. The server adds commandId, artifactId, baseVersion, actor, and origin; never include them. Do not return batch or attachResource.

Operation payload fields (in addition to kind; no extra keys):
${JSON.stringify(operationFieldCatalog)}

Source objects have id, but updateText, deleteObject and setObjectProperty identify their target with targetId, never id. updateText.runs is an array of canonical rich-text run objects, each with id, text, and style copied from the context; preserve the existing style and explicit line breaks unless the instruction changes them. Never put a bare text field on an operation. setObjectProperty.path is an array of property names, not a dotted string; value is the canonical property value. Inserted node/object/slide/worksheet payloads must use their complete canonical shapes from context. Use valid UUIDs for new run or object IDs; the server freshens new identities.

The supplied target IDs are the user's authority boundary. Change only selected content and the owning section, slide, or worksheet structure needed by the explicit instruction. Never change stable IDs, artifact/workspace identity, schema/capability versions, locks, resources, or unrelated content. Never invent a resource. Existing resource IDs may be retained by supported inserted objects. Use canonical JSON shapes copied from the context. Preserve every fact, name, amount, date, identifier, term, and commitment unless the instruction explicitly changes it. Use the smallest command set that completes the instruction. Do not return a no-op.
For appendSpreadsheetRecords select a table or its worksheet explicitly. Supply sheetId, tableId, optional prototypeRow (an existing data row; default last data row), and records keyed by stringified numeric table column IDs, each value {valueType,value}. Supply every input column; omit formula columns. Never use setObjectProperty to change tables or table headers. Totals rows, structured references, collisions and locks are unsupported. Context includes table refs, column IDs and prototype cells.`

function responseText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content.map((block) => block.type === 'text' ? block.text ?? '' : '').join('').trim()
}

function parseJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Office command plan did not contain JSON')
  return JSON.parse(match[0])
}

function visit(value: unknown, callback: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return
  if (!Array.isArray(value)) callback(value as Record<string, unknown>)
  for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, callback)
}

function idsIn(value: unknown): Set<string> {
  const ids = new Set<string>()
  visit(value, (record) => { if (typeof record.id === 'string') ids.add(record.id) })
  return ids
}

function containsId(value: unknown, targetIds: Set<string>): boolean {
  let found = false
  visit(value, (record) => { if (typeof record.id === 'string' && targetIds.has(record.id)) found = true })
  return found
}

function addSelectedRecords(value: unknown, targetIds: Set<string>, found: Set<string>, directIds: Set<string>): void {
  visit(value, (record) => {
    if (typeof record.id !== 'string' || !targetIds.has(record.id)) return
    found.add(record.id)
    for (const id of idsIn(record)) directIds.add(id)
  })
}

function freshenNewIds<T>(value: T, existingIds: Set<string>): T {
  const next = structuredClone(value)
  const replacements = new Map<string, string>()
  visit(next, (record) => {
    if (typeof record.id === 'string' && !existingIds.has(record.id)) replacements.set(record.id, randomUUID())
  })
  const referenceArrays = new Set(['readingOrder', 'placeholderIds', 'lockedObjectIds'])
  const referenceFields = new Set(['fromObjectId', 'toObjectId'])
  const remap = (candidate: unknown, key?: string): unknown => {
    if (typeof candidate === 'string' && (key === 'id' || referenceFields.has(key ?? ''))) return replacements.get(candidate) ?? candidate
    if (Array.isArray(candidate)) return candidate.map((item) => typeof item === 'string' && referenceArrays.has(key ?? '') ? replacements.get(item) ?? item : remap(item))
    if (!candidate || typeof candidate !== 'object') return candidate
    return Object.fromEntries(Object.entries(candidate).map(([childKey, child]) => [childKey, remap(child, childKey)]))
  }
  return remap(next) as T
}

type RevisionScope = {
  directIds: Set<string>
  existingIds: Set<string>
  lockedIds: Set<string>
  documentSections: Set<string>
  selectedDocumentSections: Set<string>
  documentContainers: Set<string>
  documentSectionIds: Set<string>
  presentationSlides: Set<string>
  selectedSlides: Set<string>
  presentationSlideIds: Set<string>
  presentationRootSelected: boolean
  spreadsheetSheets: Set<string>
  selectedSheets: Set<string>
  spreadsheetSheetIds: Set<string>
}

function revisionScope(snapshot: OfficeArtifactSnapshot, targetIds: string[], lockedTargetIds: readonly string[] = []): RevisionScope {
  const targets = new Set(targetIds)
  const found = new Set<string>()
  const scope: RevisionScope = {
    directIds: new Set(), existingIds: idsIn(snapshot), lockedIds: new Set(lockedTargetIds),
    documentSections: new Set(), selectedDocumentSections: new Set(), documentContainers: new Set(), documentSectionIds: new Set(),
    presentationSlides: new Set(), selectedSlides: new Set(), presentationSlideIds: new Set(), presentationRootSelected: false,
    spreadsheetSheets: new Set(), selectedSheets: new Set(), spreadsheetSheetIds: new Set(),
  }
  if (snapshot.family === 'document') {
    for (const section of snapshot.sections) {
      scope.documentSectionIds.add(section.id)
      if (targets.has(section.id)) {
        found.add(section.id); scope.documentSections.add(section.id); scope.selectedDocumentSections.add(section.id)
        for (const id of idsIn(section)) scope.directIds.add(id)
      }
      for (const node of section.nodes) {
        if (!containsId(node, targets)) continue
        addSelectedRecords(node, targets, found, scope.directIds)
        scope.documentContainers.add(node.id)
        scope.documentSections.add(section.id)
      }
    }
  } else if (snapshot.family === 'presentation') {
    for (const lockedId of snapshot.masters.flatMap((master) => master.lockedObjectIds)) scope.lockedIds.add(lockedId)
    if (targets.has(snapshot.rootId)) {
      found.add(snapshot.rootId)
      scope.presentationRootSelected = true
    }
    addSelectedRecords(snapshot.masters, targets, found, scope.directIds)
    addSelectedRecords(snapshot.layouts, targets, found, scope.directIds)
    for (const slide of snapshot.slides) {
      scope.presentationSlideIds.add(slide.id)
      const slideSelected = targets.has(slide.id)
      if (slideSelected) {
        found.add(slide.id); scope.selectedSlides.add(slide.id); scope.presentationSlides.add(slide.id)
        for (const id of idsIn(slide)) scope.directIds.add(id)
      }
      for (const object of slide.objects) {
        if (object.locked) for (const id of idsIn(object)) scope.lockedIds.add(id)
        if (!containsId(object, targets)) continue
        addSelectedRecords(object, targets, found, scope.directIds)
        scope.presentationSlides.add(slide.id)
      }
    }
  } else if (snapshot.family === 'spreadsheet') {
    for (const sheet of snapshot.worksheets) {
      scope.spreadsheetSheetIds.add(sheet.id)
      const sheetSelected = targets.has(sheet.id)
      if (sheetSelected) {
        found.add(sheet.id); scope.selectedSheets.add(sheet.id); scope.spreadsheetSheets.add(sheet.id)
        for (const id of idsIn(sheet)) scope.directIds.add(id)
      }
      for (const candidate of [...sheet.cells, ...sheet.images, ...(sheet.tables ?? [])]) {
        if ('locked' in candidate && candidate.locked) for (const id of idsIn(candidate)) scope.lockedIds.add(id)
        if (!containsId(candidate, targets)) continue
        for (const id of idsIn(candidate)) if (targets.has(id)) found.add(id)
        for (const id of idsIn(candidate)) scope.directIds.add(id)
        scope.spreadsheetSheets.add(sheet.id)
      }
    }
  } else throw new Error('PDF sessions require the PDF target planner')
  // Locks on an ancestor/master-owned object cover its runs too, even when
  // the user selected the whole slide and directIds includes all descendants.
  const collectLocks = (value: unknown, inherited = false): void => {
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    const locked = inherited || object.locked === true || typeof object.id === 'string' && scope.lockedIds.has(object.id)
    if (locked && typeof object.id === 'string') scope.lockedIds.add(object.id)
    for (const child of Object.values(object)) collectLocks(child, locked)
  }
  collectLocks(snapshot, scope.lockedIds.has(snapshot.rootId))
  if (found.size !== targets.size) throw new Error('One or more Office revision targets no longer exist')
  return scope
}

/** Resolve only text directly authorized by revisionScope. Selecting a section
 * or slide authorizes its unlocked text descendants, not sibling containers,
 * masters, or the artifact globally. The renderer itself never expands scope.
 */
function scopedFitTargets(candidate: OfficeArtifactSnapshot, scope: RevisionScope, requested?: readonly string[]): string[] {
  const eligible = new Set<string>()
  const directIds = new Set(scope.directIds)
  if (candidate.family === 'document') for (const section of candidate.sections) {
    if (scope.selectedDocumentSections.has(section.id)) for (const id of idsIn(section)) directIds.add(id)
  }
  if (candidate.family === 'presentation') for (const slide of candidate.slides) {
    if (scope.selectedSlides.has(slide.id)) for (const id of idsIn(slide)) directIds.add(id)
  }
  const allowed = requested ? new Set(requested) : undefined
  visit(candidate, object => {
    if (typeof object.id !== 'string' || scope.lockedIds.has(object.id) || object.locked === true) return
    for (const key of ['runs', 'header', 'footer', ...(object.kind === 'shape' ? ['text'] : [])]) {
      if (!Array.isArray(object[key])) continue
      const ownerAllowed = directIds.has(object.id) && (!allowed || allowed.has(object.id))
      for (const run of object[key] as Array<{ id: string }>) {
        if (scope.lockedIds.has(run.id)) continue
        if (ownerAllowed || directIds.has(run.id) && (!allowed || allowed.has(run.id))) eligible.add(run.id)
      }
    }
  })
  return [...eligible]
}

export function officeRevisionFitRepairScope(snapshot: OfficeArtifactSnapshot, targetIds: string[], lockedTargetIds: readonly string[] = []): { eligibleTargetIds: string[]; lockedTargetIds: string[] } {
  const scope = revisionScope(snapshot, targetIds, lockedTargetIds)
  return { eligibleTargetIds: scopedFitTargets(snapshot, scope), lockedTargetIds: [...scope.lockedIds] }
}

const forbiddenPropertyParts = new Set(['id', 'artifactId', 'workspaceId', 'schemaVersion', 'capabilityVersion', 'rootId', 'templateVersionId', 'family', 'resources', 'locked', 'lockedObjectIds', 'calculatedValue', 'error'])
const forbiddenCollectionReplacement = new Set(['nodes', 'objects', 'slides', 'worksheets', 'cells', 'tables', 'columns', 'masters', 'layouts'])
const spreadsheetCellValueParts = new Set(['address', 'formula', 'value', 'valueType'])

function assertOperationAuthority(command: OfficeCommand, snapshot: OfficeArtifactSnapshot, scope: RevisionScope): void {
  if (command.kind === 'batch' || command.kind === 'attachResource' || command.kind === 'replaceTextRange') throw new Error(`Brian cannot emit ${command.kind} in the command planner`)
  if (command.kind === 'appendSpreadsheetRecords') {
    const table = snapshot.family === 'spreadsheet' ? snapshot.worksheets.find(s => s.id === command.sheetId)?.tables?.find(t => t.id === command.tableId) : undefined
    if (!table || !scope.directIds.has(table.id)) throw new Error('Office append escaped the selected table or worksheet boundary')
    return
  }
  if (command.kind === 'updateText') {
    if (snapshot.family === 'spreadsheet') throw new Error('Spreadsheet text requires setSpreadsheetCell')
    if (!scope.directIds.has(command.targetId) || scope.lockedIds.has(command.targetId)) throw new Error('Office text command escaped the selected target boundary')
    return
  }
  if (command.kind === 'setObjectProperty') {
    if (command.path.some((part) => forbiddenPropertyParts.has(part)) || forbiddenCollectionReplacement.has(command.path[0]!)) throw new Error('Office property command targets protected canonical state')
    if (snapshot.family === 'spreadsheet') {
      if (snapshot.worksheets.some(s => s.tables?.some(t => t.id === command.targetId))) throw new Error('Table metadata requires a dedicated canonical command')
      const sheet = snapshot.worksheets.find(s => s.id === command.targetId)
      if (sheet && !['name', 'visibility', 'rowDimensions', 'columnDimensions', 'freeze', 'print'].includes(command.path[0]!)) throw new Error('Worksheet collection replacement is unsafe for table integrity and locks')
    }
    if (scope.lockedIds.has(command.targetId)) throw new Error('Office property command targets locked content')
    if (snapshot.family === 'spreadsheet' && snapshot.worksheets.some((sheet) => sheet.cells.some((cell) => cell.id === command.targetId)) && spreadsheetCellValueParts.has(command.path[0]!)) throw new Error('Office cell values and formulas require setSpreadsheetCell')
    if (command.targetId === snapshot.rootId) {
      if (snapshot.family === 'presentation' && scope.presentationRootSelected && command.path.join('.') === 'themeId') return
      throw new Error('Office property command escaped the selected target boundary')
    }
    if (scope.directIds.has(command.targetId)) {
      if (snapshot.family === 'presentation' && scope.presentationSlideIds.has(command.targetId) && command.path[0] === 'masterId' && !snapshot.masters.some((master) => master.id === command.value)) throw new Error('Office slide master must reference an existing master')
      if (snapshot.family === 'presentation' && scope.presentationSlideIds.has(command.targetId) && command.path[0] === 'layoutId' && !snapshot.layouts.some((layout) => layout.id === command.value)) throw new Error('Office slide layout must reference an existing layout')
      return
    }
    if (scope.documentContainers.has(command.targetId) && ['headerRows', 'columnWidthsPt', 'widthPt', 'alignment', 'indentPt', 'layout', 'margins', 'borders', 'ordered', 'level', 'styleName'].includes(command.path[0]!)) return
    if (scope.selectedDocumentSections.has(command.targetId) && ['page', 'header', 'footer', 'headerImage', 'headerAlignment', 'footerAlignment', 'headerBorderBottom', 'footerBorderTop', 'showPageNumber'].includes(command.path[0]!)) return
    if (scope.spreadsheetSheets.has(command.targetId) && ['name', 'visibility', 'merges', 'rowDimensions', 'columnDimensions', 'freeze', 'images', 'validations', 'conditionalFormats', 'print'].includes(command.path[0]!)) return
    throw new Error('Office property command escaped the selected target boundary')
  }
  if (command.kind === 'deleteObject') {
    if (snapshot.family === 'spreadsheet') throw new Error('Spreadsheet deletion requires a dedicated canonical command')
    if (!scope.directIds.has(command.targetId) || scope.lockedIds.has(command.targetId) || scope.documentSectionIds.has(command.targetId) || scope.presentationSlideIds.has(command.targetId) || scope.spreadsheetSheetIds.has(command.targetId)) throw new Error('Office delete command escaped the selected target boundary')
    return
  }
  if (command.kind === 'insertDocumentNode') {
    if (!scope.documentSections.has(command.sectionId)) throw new Error('Office insertion escaped the selected section')
    return
  }
  if (command.kind === 'insertSlideObject') {
    if (!scope.presentationSlides.has(command.slideId)) throw new Error('Office insertion escaped the selected slide')
    return
  }
  if (command.kind === 'addSlide') {
    if (scope.selectedSlides.size === 0) throw new Error('Adding a slide requires an explicitly selected slide')
    return
  }
  if (command.kind === 'reorderSlide' || command.kind === 'deleteSlide') {
    if (!scope.selectedSlides.has(command.slideId)) throw new Error('Office slide command escaped the selected slides')
    return
  }
  if (command.kind === 'reorderSlideObject') {
    if (!scope.presentationSlides.has(command.slideId) || !scope.directIds.has(command.objectId) || scope.lockedIds.has(command.objectId)) throw new Error('Office object reorder escaped the selected target boundary')
    return
  }
  if (command.kind === 'updateSpreadsheetImage') {
    if (!scope.spreadsheetSheets.has(command.sheetId) || !scope.directIds.has(command.imageId)) throw new Error('Office worksheet image command escaped the selected target boundary')
    return
  }
  if (command.kind === 'setSpreadsheetCell') {
    if (!command.formula) SpreadsheetRecordSchema.parse({ value: { valueType: command.valueType, value: command.value } })
    const sheet = snapshot.family === 'spreadsheet' ? snapshot.worksheets.find(s => s.id === command.sheetId) : undefined
    const address = normalizeCellAddress(command.address)
    const parsed = address ? parseCellAddress(address) : null
    const existingCell = sheet?.cells.find(c => c.id === command.cellId)
    const occupant = sheet?.cells.find(c => c.address === address)
    if (!sheet || !parsed || parsed.column > 16384 || parsed.row > 1048576 || existingCell && existingCell.address !== address || occupant && occupant.id !== command.cellId || !existingCell && scope.existingIds.has(command.cellId)) throw new Error('Office cell identity/address mismatch')
    if (sheet.tables?.some(t => { const b = tableBounds(t.ref); return parsed.row === b.top && parsed.column >= b.left && parsed.column <= b.right })) throw new Error('Table header edits require a dedicated canonical command')
    if (!scope.spreadsheetSheets.has(command.sheetId) || existingCell && !scope.directIds.has(existingCell.id) || !existingCell && !scope.selectedSheets.has(command.sheetId) || existingCell?.locked || occupant?.locked || scope.lockedIds.has(command.cellId)) throw new Error('Office cell command escaped the selected target boundary')
    return
  }
  if (command.kind === 'setSpreadsheetDimension') {
    if (!scope.spreadsheetSheets.has(command.sheetId)) throw new Error('Office dimension command escaped the selected worksheet')
    return
  }
  if (command.kind === 'addWorksheet') {
    if (scope.selectedSheets.size === 0) throw new Error('Adding a worksheet requires an explicitly selected worksheet')
    return
  }
  if (command.kind === 'renameWorksheet' || command.kind === 'reorderWorksheet' || command.kind === 'deleteWorksheet') {
    if (command.kind === 'deleteWorksheet' && snapshot.family === 'spreadsheet' && snapshot.worksheets.find(s => s.id === command.sheetId)?.cells.some(c => c.locked)) throw new Error('Cannot delete a worksheet containing locked cells')
    if (!scope.selectedSheets.has(command.sheetId)) throw new Error('Office worksheet command escaped the selected worksheets')
  }
}

function hydrateOperation(operation: AssistantOfficeOperation, envelope: Pick<OfficeCommand, 'artifactId' | 'baseVersion' | 'actor' | 'origin'>, existingIds: Set<string>, snapshot: OfficeArtifactSnapshot): OfficeCommand {
  let payload: Record<string, unknown> = structuredClone(operation) as Record<string, unknown>
  if (operation.kind === 'updateText') payload = { ...operation, runs: freshenNewIds(operation.runs, existingIds) }
  else if (operation.kind === 'setObjectProperty') payload = { ...operation, value: freshenNewIds(operation.value, existingIds) }
  else if (operation.kind === 'insertDocumentNode') {
    if ([operation.index, operation.beforeNodeId, operation.afterNodeId].filter((value) => value !== undefined).length !== 1) throw new Error('Office insertion requires exactly one of index, beforeNodeId or afterNodeId')
    const section = snapshot.family === 'document' ? snapshot.sections.find((item) => item.id === operation.sectionId) : undefined
    if (!section) throw new Error('Office insertion section was not found')
    let index = operation.index
    if (index === undefined) {
      const anchorIndex = section.nodes.findIndex((node) => node.id === (operation.beforeNodeId ?? operation.afterNodeId))
      if (anchorIndex < 0) throw new Error('Office insertion anchor is not a current flow node in the owning section')
      index = anchorIndex + (operation.afterNodeId ? 1 : 0)
    }
    if (index > section.nodes.length) throw new Error('Office insertion index exceeds the owning section length')
    payload = { kind: operation.kind, sectionId: operation.sectionId, index, node: freshenNewIds(operation.node, existingIds) }
  }
  else if (operation.kind === 'insertSlideObject') payload = { ...operation, object: freshenNewIds(operation.object, existingIds) }
  else if (operation.kind === 'addSlide') payload = { ...operation, slide: freshenNewIds(operation.slide, existingIds) }
  else if (operation.kind === 'addWorksheet') payload = { ...operation, worksheet: freshenNewIds(operation.worksheet, existingIds) }
  else if (operation.kind === 'setSpreadsheetCell' && !existingIds.has(operation.cellId)) payload = { ...operation, cellId: randomUUID() }
  return OfficeCommandSchema.parse({ ...envelope, commandId: randomUUID(), ...payload })
}

function promptContext(snapshot: OfficeArtifactSnapshot, targetIds: string[]): unknown {
  const targets = new Set(targetIds)
  const common = { family: snapshot.family, title: snapshot.title, locale: snapshot.locale, resources: snapshot.resources, selectedTargetIds: targetIds }
  if (snapshot.family === 'document') {
    return { ...common, sections: snapshot.sections.filter((section) => targets.has(section.id) || containsId(section, targets)).map((section) => {
      const selected = section.nodes.map((node, index) => ({ node, index })).filter(({ node, index }) => targets.has(section.id) ? index < 500 : containsId(node, targets))
      return { ...section, nodes: selected.map(({ node }) => node), nodePositions: selected.map(({ node, index }) => ({ id: node.id, index })), nodeCount: section.nodes.length }
    }), otherSections: snapshot.sections.map((section) => ({ id: section.id, nodeCount: section.nodes.length })) }
  }
  if (snapshot.family === 'presentation') {
    return { ...common, slideSize: snapshot.slideSize, themeId: snapshot.themeId, masters: snapshot.masters, layouts: snapshot.layouts, slides: snapshot.slides.filter((slide) => targets.has(slide.id) || containsId(slide, targets)), otherSlides: snapshot.slides.map((slide, index) => ({ id: slide.id, index, title: slide.title })) }
  }
  if (snapshot.family === 'pdf') throw new Error('PDF sessions require the PDF target planner')
  return { ...common, appendTables: snapshot.worksheets.flatMap(sheet => (sheet.tables ?? []).filter(t => targets.has(t.id) || targets.has(sheet.id)).map(table => { const b = tableBounds(table.ref); return { sheetId: sheet.id, ...table, prototypeRow: b.bottom, prototypeCells: sheet.cells.filter(c => { const a = parseCellAddress(c.address)!; return a.row === b.bottom && a.column >= b.left && a.column <= b.right }) } })), calculationMode: snapshot.calculationMode, worksheets: snapshot.worksheets.filter((sheet) => targets.has(sheet.id) || containsId(sheet, targets)).map((sheet) => ({ ...sheet, cells: targets.has(sheet.id) ? sheet.cells.slice(0, 2_000) : sheet.cells.filter((cell) => targets.has(cell.id)).concat(sheet.cells.filter((cell) => Boolean(cell.formula)).slice(0, 500)) })), otherWorksheets: snapshot.worksheets.map((sheet, index) => ({ id: sheet.id, index, name: sheet.name, cellCount: sheet.cells.length })) }
}

export async function generateAssistantOfficeCommands(params: {
  provider: LLMProvider
  model: string
  snapshot: OfficeArtifactSnapshot
  baseVersion: number
  assistantId: string
  targetIds: string[]
  /** Immutable template locks, including ancestor IDs absent from node.locked. */
  lockedTargetIds?: readonly string[]
  instruction: string
  brandVoice?: string | null
  /** Enabled by default for selected unlocked text; false explicitly disables repair. */
  fitRepair?: false | { eligibleTargetIds?: readonly string[]; minimumFontSizePt?: number; stepPt?: number }
  /** Production passes the real native-export/LibreOffice gate; tests may inject a fake. */
  validateCandidate?: (snapshot: OfficeArtifactSnapshot) => Promise<void>
}): Promise<OfficeCommand[]> {
  const scope = revisionScope(params.snapshot, params.targetIds, params.lockedTargetIds)
  // Replay schema-normalizes defaults and property ordering. Compare the same
  // normalized shapes semantically, retaining every locked property and ID.
  const lockedRecords = new Map<string, Record<string, unknown>>()
  visit(OfficeArtifactSnapshotSchema.parse(params.snapshot), record => {
    if (typeof record.id === 'string' && scope.lockedIds.has(record.id)) lockedRecords.set(record.id, record)
  })
  const editableTextTargetIds: string[] = []
  visit(params.snapshot, (record) => {
    if (typeof record.id === 'string' && Array.isArray(record.runs) && scope.directIds.has(record.id) && !scope.lockedIds.has(record.id)) editableTextTargetIds.push(record.id)
  })
  const brandVoice = params.brandVoice?.trim()
  const familyGuidance = params.snapshot.family === 'document'
    ? 'This is a document. Use only updateText, insertDocumentNode, deleteObject, and setObjectProperty. Delete a document table row with deleteObject targeting the row ID. For header/footer text, use setObjectProperty on the selected section ID with path ["header"] or ["footer"] and value equal to the complete preserved run array. Individual header/footer run IDs are not updateText or deleteObject targets. Preserve every untouched run ID and style. Never use slide or worksheet operations.'
    : params.snapshot.family === 'presentation'
      ? 'This is a presentation. Use only updateText, insertSlideObject, deleteObject, setObjectProperty, addSlide, reorderSlide, deleteSlide, and reorderSlideObject. Never use document or worksheet operations.'
      : 'This is a spreadsheet. Use only appendSpreadsheetRecords, setObjectProperty, updateSpreadsheetImage, setSpreadsheetCell, setSpreadsheetDimension, addWorksheet, renameWorksheet, reorderWorksheet, and deleteWorksheet. Never use document or slide operations.'
  const insertionGuidance = params.snapshot.family === 'document' ? '\nFor insertDocumentNode supply exactly one of beforeNodeId, afterNodeId, or index. Prefer beforeNodeId/afterNodeId for a request relative to an existing flow node. Anchors must name a top-level node in that section, not a run, table row or cell. The server resolves anchors after earlier commands. If using index, use the zero-based section nodes array position, adjusting for earlier commands, never a flattened text-target position. nodePositions contains original section indices even when context is filtered.' : ''
  const systemPrompt = `${SYSTEM_PROMPT}\n\n${familyGuidance}${insertionGuidance}`
  const messages: Message[] = [{ role: 'user', content: `Instruction:\n${params.instruction.replace(/(^|\s)@Brian\b/gi, '$1').trim()}\n\nExisting editable text-container IDs for updateText.targetId:\n${JSON.stringify(editableTextTargetIds)}\nTarget the owning paragraph, heading, list item, table cell or text object that contains runs, never a run ID or paragraphStart ID.\n\nCanonical editable context:\n${JSON.stringify(promptContext(params.snapshot, params.targetIds))}` }]
  const envelope = { artifactId: params.snapshot.artifactId, baseVersion: params.baseVersion, actor: { type: 'assistant' as const, id: params.assistantId }, origin: 'ai' as const }
  let consumed = 0
  let failure: unknown
  while (consumed < 3) {
    consumed++
    try {
      const response = await collectStream(params.provider.stream({ model: params.model, systemPrompt: brandVoice ? `${systemPrompt}\n\n${brandVoice}` : systemPrompt, messages, maxTokens: 12_000, responseFormat: 'json', temperature: 0.1 }))
      const plan = AssistantOfficePlanSchema.parse(parseJsonObject(responseText(response)))
      const commands: OfficeCommand[] = []
      let candidate = params.snapshot
      for (const operation of plan.commands) {
        const command = hydrateOperation(operation, envelope, scope.existingIds, candidate)
        assertOperationAuthority(command, candidate, scope)
        candidate = applyOfficeCommand(candidate, command)
        commands.push(command)
      }
      // Replacing an unlocked owner must not bypass a lock on a child run/cell.
      const remainingLocks = new Map<string, Record<string, unknown>>()
      visit(candidate, record => {
        if (typeof record.id === 'string' && lockedRecords.has(record.id)) remainingLocks.set(record.id, record)
      })
      if ([...lockedRecords].some(([id, value]) => !isDeepStrictEqual(remainingLocks.get(id), value))) throw new Error('Office command plan changed or removed locked content')
      let fit = fitOfficeArtifact(candidate, { readabilityReference: params.snapshot })
      if (!fit.ok && params.fitRepair !== false && consumed < 3) {
        const policy = params.fitRepair ?? {}
        const eligibleTargetIds = scopedFitTargets(candidate, scope, policy.eligibleTargetIds)
        const repair = repairOfficeArtifactFit(candidate, { ...policy, budget: { readabilityReference: params.snapshot }, eligibleTargetIds, lockedTargetIds: [...scope.lockedIds], maxAttempts: 1 + (3 - consumed) })
        consumed += repair.history.length - 1
        // Never promote the helper's raw clone: replay only authorized font changes.
        const finalSizes = new Map(repair.changes.map(change => [change.runId, change.toPt]))
        for (const [runId, fontSizePt] of finalSizes) {
          const command = OfficeCommandSchema.parse({ ...envelope, commandId: randomUUID(), kind: 'setObjectProperty', targetId: runId, path: ['style', 'fontSizePt'], value: fontSizePt })
          const repairScope = { ...scope, directIds: new Set([...scope.directIds, ...eligibleTargetIds]) }
          assertOperationAuthority(command, candidate, repairScope)
          candidate = applyOfficeCommand(candidate, command)
          commands.push(command)
        }
        fit = fitOfficeArtifact(candidate, { readabilityReference: params.snapshot })
      }
      const preflight = preflightOfficeCandidate(candidate)
      if (!preflight.ok) throw new Error(`Office command plan failed preflight: ${preflight.diagnostics.map(item => `${item.path}: ${item.message}`).join('; ')}`)
      if (!fit.ok) throw new Error(`Office command plan failed fit: ${fit.issues.map(item => `${item.objectId}: ${item.message}`).join('; ')}`)
      if (JSON.stringify(candidate) === JSON.stringify(params.snapshot)) throw new Error('Office command plan returned no changes')
      await params.validateCandidate?.(structuredClone(candidate))
      return commands
    } catch (cause) {
      failure = cause
      messages.push({ role: 'user', content: `Candidate rejected (${consumed}/3 attempts used): ${String(cause).slice(0, 4000)}. Return a corrected complete command plan against the ORIGINAL context. Do not change facts or escape selection to repair errors.` })
    }
  }
  throw failure instanceof Error ? failure : new Error(String(failure))
}
