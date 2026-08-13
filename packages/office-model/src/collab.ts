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
  const deterministicPreimage = documentRangePreimageHash(text.slice(command.from, command.to))
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

/** Synchronous UTF-8 SHA-256 used in browser/server command construction. */
export function documentRangePreimageHash(value: string): string {
  const bytes = [...new TextEncoder().encode(value)]
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const high = Math.floor(bitLength / 0x100000000)
  const low = bitLength >>> 0
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff)
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff)
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]
  const rotate = (word: number, count: number) => (word >>> count) | (word << (32 - count))
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64)
    for (let index = 0; index < 16; index += 1) words[index] = ((bytes[offset + index * 4] << 24) | (bytes[offset + index * 4 + 1] << 16) | (bytes[offset + index * 4 + 2] << 8) | bytes[offset + index * 4 + 3]) >>> 0
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3)
      const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10)
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0
    }
    let [a,b,c,d,e,f,g,h] = state
    for (let index = 0; index < 64; index += 1) {
      const sum1 = (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) >>> 0
      const choice = ((e & f) ^ (~e & g)) >>> 0
      const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0
      const sum0 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) >>> 0
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const temp2 = (sum0 + majority) >>> 0
      h=g; g=f; f=e; e=(d+temp1)>>>0; d=c; c=b; b=a; a=(temp1+temp2)>>>0
    }
    for (const [index, word] of [a,b,c,d,e,f,g,h].entries()) state[index] = (state[index] + word) >>> 0
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('')
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
