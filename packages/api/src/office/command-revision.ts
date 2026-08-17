/** Command-native, target-bounded Brian revision planning for Office artifacts.
 * [COMP:api/office-generation] */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { collectStream, fitOfficeArtifact, type LLMProvider, type Message } from '@use-brian/core'
import {
  DocumentFlowNodeSchema,
  OfficeCommandSchema,
  OfficeRichTextRunSchema,
  PresentationObjectSchema,
  PresentationSlideSchema,
  SpreadsheetCellValueSchema,
  SpreadsheetWorksheetSchema,
  applyOfficeCommand,
  preflightOfficeCandidate,
  type OfficeArtifactSnapshot,
  type OfficeCommand,
} from '@use-brian/office-model'

const OperationBase = z.object({})
const AssistantOfficeOperationSchema = z.discriminatedUnion('kind', [
  OperationBase.extend({ kind: z.literal('updateText'), targetId: z.string().uuid(), runs: z.array(OfficeRichTextRunSchema).max(10_000) }).strict(),
  OperationBase.extend({ kind: z.literal('insertDocumentNode'), sectionId: z.string().uuid(), index: z.number().int().min(0), node: DocumentFlowNodeSchema }).strict(),
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

const SYSTEM_PROMPT = `You are Brian's command planner for a canonical Office artifact. Return one JSON object and nothing else: {"commands":[...]}.

Use only these operation kinds: updateText, insertDocumentNode, insertSlideObject, deleteObject, setObjectProperty, addSlide, reorderSlide, deleteSlide, reorderSlideObject, updateSpreadsheetImage, setSpreadsheetCell, setSpreadsheetDimension, addWorksheet, renameWorksheet, reorderWorksheet, deleteWorksheet. The server adds commandId, artifactId, baseVersion, actor, and origin; never include them. Do not return batch or attachResource.

The supplied target IDs are the user's authority boundary. Change only selected content and the owning section, slide, or worksheet structure needed by the explicit instruction. Never change stable IDs, artifact/workspace identity, schema/capability versions, locks, resources, or unrelated content. Never invent a resource. Existing resource IDs may be retained by supported inserted objects. Use canonical JSON shapes copied from the context. Preserve every fact, name, amount, date, identifier, term, and commitment unless the instruction explicitly changes it. Use the smallest command set that completes the instruction. Do not return a no-op.`

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

function revisionScope(snapshot: OfficeArtifactSnapshot, targetIds: string[]): RevisionScope {
  const targets = new Set(targetIds)
  const found = new Set<string>()
  const scope: RevisionScope = {
    directIds: new Set(), existingIds: idsIn(snapshot), lockedIds: new Set(),
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
  } else {
    for (const sheet of snapshot.worksheets) {
      scope.spreadsheetSheetIds.add(sheet.id)
      const sheetSelected = targets.has(sheet.id)
      if (sheetSelected) {
        found.add(sheet.id); scope.selectedSheets.add(sheet.id); scope.spreadsheetSheets.add(sheet.id)
        for (const id of idsIn(sheet)) scope.directIds.add(id)
      }
      for (const candidate of [...sheet.cells, ...sheet.images]) {
        if ('locked' in candidate && candidate.locked) for (const id of idsIn(candidate)) scope.lockedIds.add(id)
        if (!containsId(candidate, targets)) continue
        for (const id of idsIn(candidate)) if (targets.has(id)) found.add(id)
        for (const id of idsIn(candidate)) scope.directIds.add(id)
        scope.spreadsheetSheets.add(sheet.id)
      }
    }
  }
  if (found.size !== targets.size) throw new Error('One or more Office revision targets no longer exist')
  return scope
}

const forbiddenPropertyParts = new Set(['id', 'artifactId', 'workspaceId', 'schemaVersion', 'capabilityVersion', 'rootId', 'templateVersionId', 'family', 'resources', 'locked', 'lockedObjectIds', 'calculatedValue', 'error'])
const forbiddenCollectionReplacement = new Set(['nodes', 'objects', 'slides', 'worksheets', 'cells', 'masters', 'layouts'])
const spreadsheetCellValueParts = new Set(['address', 'formula', 'value', 'valueType'])

function assertOperationAuthority(command: OfficeCommand, snapshot: OfficeArtifactSnapshot, scope: RevisionScope): void {
  if (command.kind === 'batch' || command.kind === 'attachResource' || command.kind === 'replaceTextRange') throw new Error(`Brian cannot emit ${command.kind} in the command planner`)
  if (command.kind === 'updateText') {
    if (!scope.directIds.has(command.targetId) || scope.lockedIds.has(command.targetId)) throw new Error('Office text command escaped the selected target boundary')
    return
  }
  if (command.kind === 'setObjectProperty') {
    if (command.path.some((part) => forbiddenPropertyParts.has(part)) || forbiddenCollectionReplacement.has(command.path[0]!)) throw new Error('Office property command targets protected canonical state')
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
    const existingCell = snapshot.family === 'spreadsheet' ? snapshot.worksheets.flatMap((sheet) => sheet.cells).find((cell) => cell.id === command.cellId) : undefined
    if (!scope.spreadsheetSheets.has(command.sheetId) || existingCell && !scope.directIds.has(existingCell.id) || !existingCell && !scope.selectedSheets.has(command.sheetId) || scope.lockedIds.has(command.cellId)) throw new Error('Office cell command escaped the selected target boundary')
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
    if (!scope.selectedSheets.has(command.sheetId)) throw new Error('Office worksheet command escaped the selected worksheets')
  }
}

function hydrateOperation(operation: AssistantOfficeOperation, envelope: Pick<OfficeCommand, 'artifactId' | 'baseVersion' | 'actor' | 'origin'>, existingIds: Set<string>): OfficeCommand {
  let payload: Record<string, unknown> = structuredClone(operation) as Record<string, unknown>
  if (operation.kind === 'updateText') payload = { ...operation, runs: freshenNewIds(operation.runs, existingIds) }
  else if (operation.kind === 'setObjectProperty') payload = { ...operation, value: freshenNewIds(operation.value, existingIds) }
  else if (operation.kind === 'insertDocumentNode') payload = { ...operation, node: freshenNewIds(operation.node, existingIds) }
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
    return { ...common, sections: snapshot.sections.filter((section) => targets.has(section.id) || containsId(section, targets)).map((section) => ({ ...section, nodes: targets.has(section.id) ? section.nodes.slice(0, 500) : section.nodes.filter((node) => containsId(node, targets)) })), otherSections: snapshot.sections.map((section) => ({ id: section.id, nodeCount: section.nodes.length })) }
  }
  if (snapshot.family === 'presentation') {
    return { ...common, slideSize: snapshot.slideSize, themeId: snapshot.themeId, masters: snapshot.masters, layouts: snapshot.layouts, slides: snapshot.slides.filter((slide) => targets.has(slide.id) || containsId(slide, targets)), otherSlides: snapshot.slides.map((slide, index) => ({ id: slide.id, index, title: slide.title })) }
  }
  return { ...common, calculationMode: snapshot.calculationMode, worksheets: snapshot.worksheets.filter((sheet) => targets.has(sheet.id) || containsId(sheet, targets)).map((sheet) => ({ ...sheet, cells: targets.has(sheet.id) ? sheet.cells.slice(0, 2_000) : sheet.cells.filter((cell) => targets.has(cell.id)).concat(sheet.cells.filter((cell) => Boolean(cell.formula)).slice(0, 500)) })), otherWorksheets: snapshot.worksheets.map((sheet, index) => ({ id: sheet.id, index, name: sheet.name, cellCount: sheet.cells.length })) }
}

export async function generateAssistantOfficeCommands(params: {
  provider: LLMProvider
  model: string
  snapshot: OfficeArtifactSnapshot
  baseVersion: number
  assistantId: string
  targetIds: string[]
  instruction: string
  brandVoice?: string | null
}): Promise<OfficeCommand[]> {
  const scope = revisionScope(params.snapshot, params.targetIds)
  const brandVoice = params.brandVoice?.trim()
  const response = await collectStream(params.provider.stream({
    model: params.model,
    systemPrompt: brandVoice ? `${SYSTEM_PROMPT}\n\n${brandVoice}` : SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Instruction:\n${params.instruction.replace(/(^|\s)@Brian\b/gi, '$1').trim()}\n\nCanonical editable context:\n${JSON.stringify(promptContext(params.snapshot, params.targetIds))}` }] as Message[],
    maxTokens: 12_000,
    temperature: 0.1,
  }))
  const plan = AssistantOfficePlanSchema.parse(parseJsonObject(responseText(response)))
  const envelope = { artifactId: params.snapshot.artifactId, baseVersion: params.baseVersion, actor: { type: 'assistant' as const, id: params.assistantId }, origin: 'ai' as const }
  const commands = plan.commands.map((operation) => hydrateOperation(operation, envelope, scope.existingIds))
  for (const command of commands) assertOperationAuthority(command, params.snapshot, scope)
  let candidate = params.snapshot
  for (const command of commands) candidate = applyOfficeCommand(candidate, command)
  const preflight = preflightOfficeCandidate(candidate)
  if (!preflight.ok) throw new Error(`Office command plan failed preflight: ${preflight.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ')}`)
  const fit = fitOfficeArtifact(candidate)
  if (!fit.ok) throw new Error(`Office command plan failed fit: ${fit.issues.map((item) => `${item.objectId}: ${item.message}`).join('; ')}`)
  if (JSON.stringify(candidate) === JSON.stringify(params.snapshot)) throw new Error('Office command plan returned no changes')
  return commands
}
