import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyOfficeCommand, OfficeCommandSchema, type OfficeCommand } from '../commands.js'
import { applyOfficeSuggestion, appendOfficeCommand, createOfficeUndoManager, documentSuggestionWasApplied, snapshotToYDoc, yDocToSnapshot } from '../collab.js'
import { officeSnapshotPreconditionHash, sha256 } from '../snapshot-hash.js'
import { documentFixture, spreadsheetFixture, id } from './fixtures.js'

function plan(snapshot = spreadsheetFixture()): Extract<OfficeCommand, { kind: 'batch' }> {
  const common = { artifactId: snapshot.artifactId, baseVersion: 1, actor: { type: 'assistant' as const, id: id(80) }, origin: 'ai' as const }
  return { ...common, commandId: id(81), kind: 'batch', expectedSnapshotHash: officeSnapshotPreconditionHash(snapshot), commands: [
    { ...common, commandId: id(82), kind: 'setSpreadsheetCell', sheetId: id(23), cellId: id(24), address: 'A1', valueType: 'number', value: 10 },
    { ...common, commandId: id(83), kind: 'setSpreadsheetCell', sheetId: id(23), cellId: id(25), address: 'B1', valueType: 'number', value: 3 },
  ] }
}

describe('[COMP:office/structured-fill] snapshot-fenced Office acceptance', () => {
  it.each(['suggestion', 'append'] as const)('keeps %s admission fences out of replay after undoing an earlier manual edit', (path) => {
    const snapshot = spreadsheetFixture()
    const doc = snapshotToYDoc(snapshot)
    const history = createOfficeUndoManager(doc)
    const manual = { ...plan(snapshot).commands[0], commandId: id(100), origin: 'manual' as const }
    appendOfficeCommand(doc, manual)
    history.stopCapturing()
    const current = yDocToSnapshot(doc)
    if (current.family !== 'spreadsheet') throw new Error('spreadsheet expected')
    const guarded = plan(current)
    if (path === 'suggestion') applyOfficeSuggestion(doc, guarded, id(90))
    else appendOfficeCommand(doc, guarded)
    expect(JSON.parse(doc.getMap<string>('commands').get(guarded.commandId)!)).not.toHaveProperty('expectedSnapshotHash')
    history.undo()
    expect(doc.getMap('commands').has(manual.commandId)).toBe(false)
    const materialized = yDocToSnapshot(doc)
    expect(materialized).toMatchObject({ worksheets: [{ cells: [{ value: 10 }, { value: 3 }, { calculatedValue: 30 }] }] })
    const restored = new Y.Doc()
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc))
    expect(yDocToSnapshot(restored)).toEqual(materialized)
    if (path === 'suggestion') expect(documentSuggestionWasApplied(restored, id(90))).toBe(true)
    history.destroy()
  })
  it('rejects stale guarded append before changing live state', () => {
    const snapshot = spreadsheetFixture()
    const command = plan(snapshot)
    snapshot.worksheets[0].cells[0].value = 100
    const doc = snapshotToYDoc(snapshot)
    const before = Y.encodeStateAsUpdate(doc)
    expect(() => appendOfficeCommand(doc, command)).toThrow(/precondition/)
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('uses portable SHA256 and canonical sorted keys while retaining array order', () => {
    for (const text of ['', 'abc', '😀 evidence\n', 'a'.repeat(1000)]) expect(sha256(text)).toBe(createHash('sha256').update(text).digest('hex'))
    const snapshot = spreadsheetFixture()
    const reversedKeys = Object.fromEntries(Object.entries(snapshot).reverse()) as typeof snapshot
    expect(officeSnapshotPreconditionHash(reversedKeys)).toBe(officeSnapshotPreconditionHash(snapshot))
    reversedKeys.worksheets = [{ ...snapshot.worksheets[0], cells: [...snapshot.worksheets[0].cells].reverse() }]
    expect(officeSnapshotPreconditionHash(reversedKeys)).not.toBe(officeSnapshotPreconditionHash(snapshot))
  })
  it('accepts one atomic batch and receipt, recalculates, broadcasts and persists duplicate no-op', () => {
    const snapshot = spreadsheetFixture()
    const doc = snapshotToYDoc(snapshot)
    let updates = 0
    doc.on('update', () => { updates++; expect(documentSuggestionWasApplied(doc, id(90))).toBe(true); expect(yDocToSnapshot(doc)).toMatchObject({ worksheets: [{ cells: [{ value: 10 }, { value: 3 }, { calculatedValue: 30 }] }] }) })
    applyOfficeSuggestion(doc, plan(snapshot), id(90))
    expect(updates).toBe(1)
    expect(doc.getMap('commands').size).toBe(1)
    const persisted = Y.encodeStateAsUpdate(doc)
    const restored = new Y.Doc()
    Y.applyUpdate(restored, persisted)
    expect(documentSuggestionWasApplied(restored, id(90))).toBe(true)
    expect(yDocToSnapshot(restored)).toEqual(yDocToSnapshot(doc))
    const before = Y.encodeStateAsUpdate(restored)
    applyOfficeSuggestion(restored, plan(snapshot), id(90))
    expect(Y.encodeStateAsUpdate(restored)).toEqual(before)
    expect(updates).toBe(1)
  })
  it.each(['value', 'formula', 'layout'] as const)('rejects intervening %s changes without touching live state', (change) => {
    const original = spreadsheetFixture()
    const changed = structuredClone(original)
    if (change === 'value') changed.worksheets[0].cells[0].value = 99
    if (change === 'formula') changed.worksheets[0].cells[2].formula = 'A1+B1'
    if (change === 'layout') changed.worksheets[0].columnDimensions.push({ index: 1, widthChars: 30, hidden: false })
    const doc = snapshotToYDoc(changed)
    const before = Y.encodeStateAsUpdate(doc)
    expect(() => applyOfficeSuggestion(doc, plan(original), id(90))).toThrow(/precondition changed/)
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    expect(documentSuggestionWasApplied(doc, id(90))).toBe(false)
    expect(() => applyOfficeCommand(changed, plan(original))).toThrow(/precondition changed/)
  })
  it('rejects an invalid second assignment or formula error atomically', () => {
    for (const failure of ['locked', 'formula', 'envelope', 'collision']) {
      const snapshot = spreadsheetFixture()
      if (failure === 'locked') snapshot.worksheets[0].cells[1].locked = true
      if (failure === 'formula') snapshot.worksheets[0].cells[2].formula = '1/(A1-10)'
      const doc = snapshotToYDoc(snapshot)
      const command = plan(snapshot)
      if (failure === 'envelope') command.commands[1].artifactId = id(99)
      if (failure === 'collision') command.commands[1].commandId = command.commands[0].commandId
      const before = Y.encodeStateAsUpdate(doc)
      expect(() => applyOfficeSuggestion(doc, command, id(90))).toThrow()
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    }
  })
  it('allows preconditions only on batch envelopes and keeps manual commands unchanged', () => {
    const command = plan()
    expect(OfficeCommandSchema.safeParse({ ...command.commands[0], expectedSnapshotHash: command.expectedSnapshotHash }).success).toBe(false)
    const doc = snapshotToYDoc(spreadsheetFixture())
    appendOfficeCommand(doc, { ...command.commands[0], origin: 'manual' })
    expect(yDocToSnapshot(doc)).toMatchObject({ worksheets: [{ cells: [{ value: 10 }, {}, {}] }] })
  })
  it('preserves document acceptance and prevents stale document batch writes', () => {
    const snapshot = documentFixture()
    const doc = snapshotToYDoc(snapshot)
    const common = { artifactId: snapshot.artifactId, baseVersion: 1, actor: { type: 'assistant' as const, id: id(80) }, origin: 'ai' as const }
    const command: OfficeCommand = { ...common, commandId: id(81), kind: 'batch', expectedSnapshotHash: officeSnapshotPreconditionHash(yDocToSnapshot(doc)), commands: [{ ...common, commandId: id(82), kind: 'setObjectProperty', targetId: id(6), path: ['alignment'], value: 'center' }] }
    applyOfficeSuggestion(doc, command, id(90))
    expect(yDocToSnapshot(doc)).toMatchObject({ sections: [{ nodes: [{ alignment: 'center' }] }] })
    const before = Y.encodeStateAsUpdate(doc)
    applyOfficeSuggestion(doc, command, id(90))
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    expect(() => applyOfficeSuggestion(doc, command, id(91))).toThrow(/precondition changed/)
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})
