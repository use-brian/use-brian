import * as Y from 'yjs'
import { DocumentSnapshotSchema, OfficeArtifactSnapshotSchema, type DocumentSnapshot, type OfficeArtifactSnapshot, type OfficeRichTextRun } from './model.js'
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

export function appendOfficeCommand(doc: Y.Doc, input: OfficeCommand): void {
  const command = OfficeCommandSchema.parse(input)
  const base = baseSnapshot(doc)
  if (base.family === 'document') {
    applyDocumentCommand(doc, command, command.origin)
    return
  }
  doc.transact(() => {
    const commands = doc.getMap<string>(COMMANDS)
    if (commands.has(command.commandId)) return
    commands.set(command.commandId, JSON.stringify(command))
    doc.getArray<string>(COMMAND_ORDER).push([command.commandId])
  }, command.origin)
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
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text.slice(command.from, command.to))
  let hash = 2166136261
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619)
  const deterministicPreimage = (hash >>> 0).toString(16).padStart(8, '0').repeat(8)
  if (deterministicPreimage !== command.preimageHash) throw new Error('Document text range preimage changed')
  const beforeText = text.slice(0, command.from)
  const afterText = text.slice(command.to)
  const fallback = target.runs[0] ?? command.runs[0]
  if (!fallback && (beforeText || afterText)) throw new Error('Document text range has no formatting source')
  target.runs = [
    ...(beforeText ? [{ ...fallback!, text: beforeText }] : []),
    ...command.runs,
    ...(afterText ? [{ ...fallback!, id: afterText === beforeText ? fallback!.id : command.commandId, text: afterText }] : []),
  ]
  return DocumentSnapshotSchema.parse(next)
}

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
  if (command.kind === 'batch') for (const child of command.commands) next = applyDocumentAtomic(next, child)
  else next = applyDocumentAtomic(next, command)
  doc.transact(() => {
    writeDocumentSnapshotToFragment(fragment, next)
    if (suggestionId) applied.set(suggestionId, true)
  }, origin)
  return next
}

export function documentSuggestionWasApplied(doc: Y.Doc, suggestionId: string): boolean {
  return doc.getMap<boolean>(APPLIED_SUGGESTION_IDS).get(suggestionId) === true
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
