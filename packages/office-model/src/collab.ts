import { sha256, officeSnapshotPreconditionHash } from './snapshot-hash.js'
import { recalculateSpreadsheet } from './spreadsheet.js'
import * as Y from 'yjs'
import { DocumentSnapshotSchema, OfficeArtifactSnapshotSchema, OfficeResourceRefSchema, type DocumentSnapshot, type OfficeArtifactSnapshot, type OfficeResourceRef, type OfficeRichTextRun } from './model.js'
import { OfficeCommandSchema, applyOfficeCommand, type OfficeCommand } from './commands.js'
import {
  OFFICE_DOCUMENT_FRAGMENT,
  OFFICE_DOCUMENT_FRAGMENT_VERSION,
  OFFICE_DOCUMENT_FRAGMENT_VERSION_KEY,
  documentSnapshotFromFragment,
  writeDocumentSnapshotToFragment,
} from './document-editor-codec.js'

const ROOT = 'office'
const BASE = 'baseSnapshot'
const COMMANDS = 'commands'
const COMMAND_ORDER = 'commandOrder'
const APPLIED_SUGGESTION_IDS = 'appliedSuggestionIds'
const DOCUMENT_FRAGMENT_MIGRATION_ORIGIN = 'document-fragment-migration'
const LOCAL_UNDO_ORIGINS = new Set<OfficeCommand['origin']>(['manual', 'offline'])

/**
 * Office collaboration is an append-only command CRDT. The immutable admitted
 * snapshot is the base and commands are keyed by globally stable command IDs,
 * so Yjs merges non-overlapping edits without a whole-file last-write-wins
 * write. Checkpoints compact this log only after materializing an exact JSON
 * snapshot.
 */
export function snapshotToYDoc(snapshot: OfficeArtifactSnapshot): Y.Doc {
  const parsed = OfficeArtifactSnapshotSchema.parse(snapshot)
  const doc = new Y.Doc()
  doc.transact(() => {
    doc.getMap<string>(ROOT).set(BASE, JSON.stringify(parsed))
    doc.getMap<string>(COMMANDS)
    doc.getArray<string>(COMMAND_ORDER)
    doc.getMap<boolean>(APPLIED_SUGGESTION_IDS)
    if (parsed.family === 'document') seedDocumentFragment(doc, parsed)
  }, DOCUMENT_FRAGMENT_MIGRATION_ORIGIN)
  return doc
}

/** Whether provider/offline state has materialized the canonical Office base. */
export function hasOfficeBaseSnapshot(doc: Y.Doc): boolean {
  return typeof doc.getMap<string>(ROOT).get(BASE) === 'string'
}

export function appendOfficeCommand(doc: Y.Doc, input: OfficeCommand): void {
  const command = OfficeCommandSchema.parse(input)
  const base = baseSnapshot(doc)
  if (base.family === 'document') {
    applyDocumentCommand(doc, command, command.origin)
    return
  }
  if (doc.getMap<string>(COMMANDS).has(command.commandId)) return
  if (command.kind === 'batch' && command.expectedSnapshotHash) applyOfficeCommand(yDocToSnapshot(doc), command)
  const admitted = withoutSnapshotFence(command)
  doc.transact(() => {
    const commands = doc.getMap<string>(COMMANDS)
    if (commands.has(command.commandId)) return
    commands.set(command.commandId, JSON.stringify(admitted))
    doc.getArray<string>(COMMAND_ORDER).push([command.commandId])
  }, command.origin)
}

/** Snapshot fences protect admission, never replay after undo/CRDT merges. */
function withoutSnapshotFence(command: OfficeCommand): OfficeCommand {
  if (command.kind !== 'batch') return command
  const { expectedSnapshotHash: _fence, ...admitted } = command
  return admitted
}

/**
 * Create a client-local history controller for the append-only command log.
 * Remote provider transactions do not carry the local `manual` / `offline`
 * origins, so undo removes only commands authored by this client and never
 * rolls back an unrelated collaborator's update.
 */
export function createOfficeUndoManager(doc: Y.Doc): Y.UndoManager {
  const base = baseSnapshot(doc)
  const scope = base.family === 'document'
    ? [getDocumentFragment(doc)]
    : [doc.getMap<string>(COMMANDS), doc.getArray<string>(COMMAND_ORDER)]
  return new Y.UndoManager(scope, {
    trackedOrigins: new Set(LOCAL_UNDO_ORIGINS),
  })
}

export type OfficeHistoryState = { canUndo: boolean; canRedo: boolean }

/** Read stack state without exposing a second history representation. */
export function officeHistoryState(history: Y.UndoManager): OfficeHistoryState {
  return { canUndo: history.canUndo(), canRedo: history.canRedo() }
}

/** Subscribe to the manager's own stack events for toolbar disabled state. */
export function observeOfficeHistory(history: Y.UndoManager, listener: (state: OfficeHistoryState) => void): () => void {
  const refresh = () => listener(officeHistoryState(history))
  history.on('stack-item-added', refresh)
  history.on('stack-item-popped', refresh)
  history.on('stack-cleared', refresh)
  refresh()
  return () => {
    history.off('stack-item-added', refresh)
    history.off('stack-item-popped', refresh)
    history.off('stack-cleared', refresh)
  }
}

/** Stable command identities let the offline journal follow undo/redo. */
export function officeCommandIds(doc: Y.Doc): string[] {
  return orderedCommandIds(doc)
}

/** Replace the materialized base inside the existing shared Y.Doc.
 *
 * Brian revisions advance the immutable artifact head outside the WebSocket
 * process, but connected editors still hold this exact Y.Doc in memory. A
 * revision therefore has to replace the base and compact the old command log
 * in place so Hocuspocus broadcasts the new head instead of later persisting a
 * stale pre-revision document over it.
 */
export function replaceOfficeSnapshot(doc: Y.Doc, snapshot: OfficeArtifactSnapshot): void {
  const parsed = OfficeArtifactSnapshotSchema.parse(snapshot)
  doc.transact(() => {
    doc.getMap<string>(ROOT).set(BASE, JSON.stringify(parsed))
    doc.getMap<string>(COMMANDS).clear()
    const order = doc.getArray<string>(COMMAND_ORDER)
    order.delete(0, order.length)
    if (parsed.family === 'document') {
      writeDocumentSnapshotToFragment(getDocumentFragment(doc), parsed)
      doc.getMap<unknown>(ROOT).set(OFFICE_DOCUMENT_FRAGMENT_VERSION_KEY, OFFICE_DOCUMENT_FRAGMENT_VERSION)
    } else {
      const fragment = getDocumentFragment(doc)
      if (fragment.length > 0) fragment.delete(0, fragment.length)
      doc.getMap<unknown>(ROOT).delete(OFFICE_DOCUMENT_FRAGMENT_VERSION_KEY)
      doc.getMap<unknown>(ROOT).delete('documentMetadata')
    }
  }, 'ai')
}

function orderedCommandIds(doc: Y.Doc): string[] {
  const commands = doc.getMap<string>(COMMANDS)
  const explicitOrder = doc.getArray<string>(COMMAND_ORDER).toArray()
  const ordered = new Set(explicitOrder.filter((commandId) => commands.has(commandId)))
  const legacy = [...commands.keys()].filter((commandId) => !ordered.has(commandId)).sort((left, right) => left.localeCompare(right))
  return [...legacy, ...ordered]
}

export function yDocToSnapshot(doc: Y.Doc): OfficeArtifactSnapshot {
  let snapshot = baseSnapshot(doc)
  if (snapshot.family === 'document') {
    ensureDocumentFragment(doc)
    return documentSnapshotFromFragment(getDocumentFragment(doc))
  }
  const commandMap = doc.getMap<string>(COMMANDS)
  const commands = orderedCommandIds(doc)
    .map((commandId) => commandMap.get(commandId))
    .filter((value): value is string => typeof value === 'string')
    .map((value) => OfficeCommandSchema.parse(JSON.parse(value)))
  for (const command of commands) snapshot = applyOfficeCommand(snapshot, command)
  return snapshot
}

function baseSnapshot(doc: Y.Doc): OfficeArtifactSnapshot {
  const baseJson = doc.getMap<string>(ROOT).get(BASE)
  if (!baseJson) throw new Error('Office Y.Doc has no base snapshot')
  return OfficeArtifactSnapshotSchema.parse(JSON.parse(baseJson))
}

export function getDocumentFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(OFFICE_DOCUMENT_FRAGMENT)
}

export function ensureDocumentFragment(doc: Y.Doc): Y.XmlFragment {
  const base = baseSnapshot(doc)
  if (base.family !== 'document') throw new Error('Document fragment requires a Document snapshot')
  const fragment = getDocumentFragment(doc)
  const root = doc.getMap<unknown>(ROOT)
  const marked = root.get(OFFICE_DOCUMENT_FRAGMENT_VERSION_KEY)
  if (marked !== undefined) {
    if (marked !== OFFICE_DOCUMENT_FRAGMENT_VERSION) throw new Error(`Unsupported Office Document fragment version: ${String(marked)}`)
    if (fragment.length === 0) throw new Error('Versioned Office Document fragment is empty')
    return fragment
  }
  if (fragment.length > 0) throw new Error('Unversioned Office Document fragment is not safe to seed')

  let materialized: OfficeArtifactSnapshot = base
  const commandMap = doc.getMap<string>(COMMANDS)
  for (const commandId of orderedCommandIds(doc)) {
    const encoded = commandMap.get(commandId)
    if (typeof encoded === 'string') materialized = applyOfficeCommand(materialized, OfficeCommandSchema.parse(JSON.parse(encoded)))
  }
  const document = DocumentSnapshotSchema.parse(materialized)
  doc.transact(() => {
    seedDocumentFragment(doc, document)
    commandMap.clear()
    const order = doc.getArray<string>(COMMAND_ORDER)
    if (order.length > 0) order.delete(0, order.length)
  }, DOCUMENT_FRAGMENT_MIGRATION_ORIGIN)
  return fragment
}

function seedDocumentFragment(doc: Y.Doc, snapshot: DocumentSnapshot): void {
  const fragment = getDocumentFragment(doc)
  if (fragment.length > 0 || doc.getMap<unknown>(ROOT).has(OFFICE_DOCUMENT_FRAGMENT_VERSION_KEY)) throw new Error('Office Document fragment has already been seeded')
  writeDocumentSnapshotToFragment(fragment, snapshot)
  doc.getMap<unknown>(ROOT).set(OFFICE_DOCUMENT_FRAGMENT_VERSION_KEY, OFFICE_DOCUMENT_FRAGMENT_VERSION)
}

type AtomicOfficeCommand = Exclude<OfficeCommand, { kind: 'batch' }>

function textTarget(snapshot: DocumentSnapshot, targetId: string): { runs: OfficeRichTextRun[] } | null {
  const visit = (value: unknown): { runs: OfficeRichTextRun[] } | null => {
    if (!value || typeof value !== 'object') return null
    if (!Array.isArray(value) && (value as { id?: unknown }).id === targetId && Array.isArray((value as { runs?: unknown }).runs)) return value as { runs: OfficeRichTextRun[] }
    if (!Array.isArray(value) && Array.isArray((value as { runs?: unknown }).runs)) {
      const owner = value as { runs: OfficeRichTextRun[] }
      const start = owner.runs.findIndex((run) => run.paragraphStart?.id === targetId)
      if (start >= 0) {
        const following = owner.runs.findIndex((run, index) => index > start && run.paragraphStart)
        const end = following < 0 ? owner.runs.length : following
        return { get runs() { return owner.runs.slice(start, end) }, set runs(runs) { owner.runs.splice(start, end - start, ...runs) } }
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = visit(child)
      if (found) return found
    }
    return null
  }
  return visit(snapshot)
}

function replaceTextRange(snapshot: DocumentSnapshot, command: Extract<AtomicOfficeCommand, { kind: 'replaceTextRange' }>): DocumentSnapshot {
  const next = structuredClone(snapshot)
  const target = textTarget(next, command.targetId)
  if (!target) throw new Error(`Text target ${command.targetId} was not found`)
  const text = target.runs.map((run) => run.text).join('')
  if (command.to < command.from || command.to > text.length) throw new Error('Document text range is outside the target')
  const deterministicPreimage = documentRangePreimageHash(text.slice(command.from, command.to))
  if (deterministicPreimage !== command.preimageHash) throw new Error('Document text range preimage changed')
  // A cell's paragraph IDs are the unambiguous range targets. A raw cell
  // range cannot represent boundaries/empty paragraphs with character offsets.
  if (target.runs.some((run, index) => index > 0 && run.paragraphStart)) throw new Error('Target a cell paragraph ID for range edits, or use updateText with paragraphStart markers')
  const original = target.runs
  const slice = (from: number, to: number): OfficeRichTextRun[] => {
    let offset = 0
    return original.flatMap((run) => {
      const start = offset
      offset += run.text.length
      const text = run.text.slice(Math.max(0, from - start), Math.max(0, Math.min(run.text.length, to - start)))
      if (!text || offset <= from || start >= to) return []
      const { paragraphStart: _paragraph, ...rest } = run
      return [{ ...rest, ...(start < from ? { id: command.commandId } : {}), text }]
    })
  }
  const updated: OfficeRichTextRun[] = [...slice(0, command.from), ...command.runs.map(({ paragraphStart: _paragraph, ...run }) => run), ...slice(command.to, text.length)]
  const paragraphStart = original[0]?.paragraphStart
  if (paragraphStart) {
    if (!updated.length) updated.push({ ...original[0], text: '' })
    updated[0] = { ...updated[0], paragraphStart }
  }
  target.runs = updated
  return DocumentSnapshotSchema.parse(next)
}

/** Synchronous UTF-8 SHA-256, retained for existing text-range callers. */
export const documentRangePreimageHash = sha256

function applyDocumentAtomic(snapshot: DocumentSnapshot, command: AtomicOfficeCommand): DocumentSnapshot {
  if (command.kind === 'replaceTextRange') return replaceTextRange(snapshot, command)
  return DocumentSnapshotSchema.parse(applyOfficeCommand(snapshot, command))
}

export function applyDocumentCommand(doc: Y.Doc, input: OfficeCommand, origin: unknown = input.origin, suggestionId?: string): DocumentSnapshot {
  const command = OfficeCommandSchema.parse(input)
  const fragment = ensureDocumentFragment(doc)
  const applied = doc.getMap<boolean>(APPLIED_SUGGESTION_IDS)
  if (suggestionId && applied.get(suggestionId)) return documentSnapshotFromFragment(fragment)
  let next = documentSnapshotFromFragment(fragment)
  if (command.kind === 'batch' && command.expectedSnapshotHash && officeSnapshotPreconditionHash(next) !== command.expectedSnapshotHash) throw new Error('Office snapshot precondition changed')
  if (command.kind === 'batch') for (const child of command.commands) next = applyDocumentAtomic(next, child)
  else next = applyDocumentAtomic(next, command)
  doc.transact(() => {
    writeDocumentSnapshotToFragment(fragment, next)
    if (suggestionId) applied.set(suggestionId, true)
  }, origin)
  return next
}

/** Validate off-document first: Y.Doc transactions do not roll back on errors. */
export function applyOfficeSuggestion(doc: Y.Doc, input: OfficeCommand, suggestionId: string): OfficeArtifactSnapshot {
  if (!suggestionId) throw new Error('Suggestion ID is required')
  if (documentSuggestionWasApplied(doc, suggestionId)) return yDocToSnapshot(doc)
  const command = OfficeCommandSchema.parse(input)
  const staged = new Y.Doc()
  try {
    Y.applyUpdate(staged, Y.encodeStateAsUpdate(doc))
    const snapshot = yDocToSnapshot(staged)
    if (command.artifactId !== snapshot.artifactId) throw new Error('Suggestion artifact mismatch')
    if (command.kind === 'batch' && command.commands.some((child) => child.artifactId !== command.artifactId || child.baseVersion !== command.baseVersion || child.actor.id !== command.actor.id || child.actor.type !== command.actor.type || child.origin !== command.origin)) {
      throw new Error('Suggestion batch envelope mismatch')
    }
    if (snapshot.family === 'document') {
      const next = applyDocumentCommand(staged, command, 'suggestion', suggestionId)
      const update = Y.encodeStateAsUpdate(staged, Y.encodeStateVector(doc))
      doc.transact(() => Y.applyUpdate(doc, update), 'suggestion')
      return next
    }
    if (snapshot.family !== 'spreadsheet' || command.kind !== 'batch') throw new Error('Spreadsheet suggestion requires a batch')
    const ids = [command.commandId, ...command.commands.map((child) => child.commandId)]
    if (new Set(ids).size !== ids.length || ids.some((id) => staged.getMap<string>(COMMANDS).has(id))) throw new Error('Suggestion command ID collision')
    const next = applyOfficeCommand(snapshot, command)
    if (next.family !== 'spreadsheet' || recalculateSpreadsheet(next).issues.length || next.worksheets.some((sheet) => sheet.cells.some((cell) => cell.error))) throw new Error('Suggestion formula validation failed')
    // One append and the receipt share a transaction, so no peer sees half a plan.
    doc.transact(() => {
      doc.getMap<string>(COMMANDS).set(command.commandId, JSON.stringify(withoutSnapshotFence(command)))
      doc.getArray<string>(COMMAND_ORDER).push([command.commandId])
      doc.getMap<boolean>(APPLIED_SUGGESTION_IDS).set(suggestionId, true)
    }, 'suggestion')
    return next
  } finally {
    staged.destroy()
  }
}

export function documentSuggestionWasApplied(doc: Y.Doc, suggestionId: string): boolean {
  // Do not create shared types during a read-only receipt query.
  return doc.share.has(APPLIED_SUGGESTION_IDS) && doc.getMap<boolean>(APPLIED_SUGGESTION_IDS).get(suggestionId) === true
}

/** Add an admitted resource to Document metadata without replacing its live fragment. */
export function attachDocumentResource(doc: Y.Doc, input: OfficeResourceRef, origin: unknown = 'manual'): DocumentSnapshot {
  const resource = OfficeResourceRefSchema.parse(input)
  const fragment = ensureDocumentFragment(doc)
  const snapshot = documentSnapshotFromFragment(fragment)
  const existing = snapshot.resources.find((candidate) => candidate.id === resource.id)
  if (existing && JSON.stringify(existing) !== JSON.stringify(resource)) throw new Error(`Office resource collision: ${resource.id}`)
  if (existing) return snapshot
  const next = DocumentSnapshotSchema.parse({ ...snapshot, resources: [...snapshot.resources, resource] })
  const editorMetadata = doc.getMap<Record<string, unknown>>(ROOT)
  doc.transact(() => {
    const metadata = editorMetadata.get('documentMetadata') ?? {}
    editorMetadata.set('documentMetadata', { ...metadata, resources: next.resources })
  }, origin)
  return next
}

export function encodeOfficeState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc)
}

export function applyOfficeUpdate(doc: Y.Doc, update: Uint8Array): void {
  Y.applyUpdate(doc, update)
}

export function officeStateVector(doc: Y.Doc): Uint8Array {
  return Y.encodeStateVector(doc)
}
