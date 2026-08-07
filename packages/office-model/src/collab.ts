import * as Y from 'yjs'
import { OfficeArtifactSnapshotSchema, type OfficeArtifactSnapshot } from './model.js'
import { OfficeCommandSchema, applyOfficeCommand, type OfficeCommand } from './commands.js'

const ROOT = 'office'
const BASE = 'baseSnapshot'
const COMMANDS = 'commands'

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
  doc.getMap<string>(ROOT).set(BASE, JSON.stringify(parsed))
  doc.getMap<string>(COMMANDS)
  return doc
}

export function appendOfficeCommand(doc: Y.Doc, input: OfficeCommand): void {
  const command = OfficeCommandSchema.parse(input)
  doc.transact(() => {
    doc.getMap<string>(COMMANDS).set(command.commandId, JSON.stringify(command))
  }, command.origin)
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
  }, 'ai')
}

export function yDocToSnapshot(doc: Y.Doc): OfficeArtifactSnapshot {
  const baseJson = doc.getMap<string>(ROOT).get(BASE)
  if (!baseJson) throw new Error('Office Y.Doc has no base snapshot')
  let snapshot = OfficeArtifactSnapshotSchema.parse(JSON.parse(baseJson))
  const commands = [...doc.getMap<string>(COMMANDS).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => OfficeCommandSchema.parse(JSON.parse(value)))
  for (const command of commands) snapshot = applyOfficeCommand(snapshot, command)
  return snapshot
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
