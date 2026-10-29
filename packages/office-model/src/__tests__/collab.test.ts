import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { appendOfficeCommand, applyOfficeUpdate, createOfficeUndoManager, encodeOfficeState, hasOfficeBaseSnapshot, observeOfficeHistory, officeCommandIds, officeCommandMatches, replaceOfficeSnapshot, snapshotToYDoc, yDocToSnapshot } from '../collab.js'
import { OfficeCommandSchema, type OfficeCommand } from '../commands.js'
import { officeSnapshotPreconditionHash } from '../snapshot-hash.js'
import { documentFixture, id, presentationFixture, spreadsheetFixture } from './fixtures.js'

describe('[COMP:office/collab-codec] Office Yjs codec', () => {
  it('distinguishes an allocated Y.Doc from a materialized Office artifact', () => {
    const connecting = new Y.Doc()
    expect(hasOfficeBaseSnapshot(connecting)).toBe(false)
    applyOfficeUpdate(connecting, encodeOfficeState(snapshotToYDoc(presentationFixture())))
    expect(hasOfficeBaseSnapshot(connecting)).toBe(true)
  })

  it('round-trips a canonical snapshot exactly', () => {
    const snapshot = documentFixture()
    expect(yDocToSnapshot(snapshotToYDoc(snapshot))).toEqual(snapshot)
  })

  it('retains document command identities for reconnect idempotency', () => {
    const snapshot = documentFixture()
    const doc = snapshotToYDoc(snapshot)
    const command = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'offline' as const, commandId: id(43), kind: 'setObjectProperty' as const, targetId: id(6), path: ['alignment'], value: 'center' }
    appendOfficeCommand(doc, command)
    appendOfficeCommand(doc, command)
    expect(officeCommandIds(doc)).toEqual([id(43)])
    const edited = yDocToSnapshot(doc)
    expect(edited.family === 'document' && edited.sections[0].nodes[0]).toMatchObject({ alignment: 'center' })
  })

  it('merges two independently authored command records idempotently', () => {
    const snapshot = presentationFixture()
    const first = snapshotToYDoc(snapshot)
    const second = new Y.Doc()
    applyOfficeUpdate(second, encodeOfficeState(first))
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'manual' as const }
    appendOfficeCommand(first, { ...common, commandId: id(41), kind: 'setObjectProperty', targetId: id(17), path: ['alignment'], value: 'center' })
    appendOfficeCommand(second, { ...common, commandId: id(42), kind: 'setObjectProperty', targetId: id(17), path: ['verticalAlignment'], value: 'middle' })
    applyOfficeUpdate(first, encodeOfficeState(second))
    applyOfficeUpdate(second, encodeOfficeState(first))
    const left = yDocToSnapshot(first)
    const right = yDocToSnapshot(second)
    expect(left).toEqual(right)
    expect(left.family === 'presentation' && left.slides[0].objects[0]).toMatchObject({ alignment: 'center', verticalAlignment: 'middle' })
    applyOfficeUpdate(first, encodeOfficeState(second))
    expect(yDocToSnapshot(first)).toEqual(left)
  })

  it('replays sequential commands in authored order instead of UUID order', () => {
    const snapshot = presentationFixture()
    const doc = snapshotToYDoc(snapshot)
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'manual' as const }
    appendOfficeCommand(doc, { ...common, commandId: id(42), kind: 'setObjectProperty', targetId: id(17), path: ['alignment'], value: 'center' })
    appendOfficeCommand(doc, { ...common, commandId: id(41), kind: 'setObjectProperty', targetId: id(17), path: ['alignment'], value: 'end' })

    const edited = yDocToSnapshot(doc)
    expect(officeCommandIds(doc)).toEqual([id(42), id(41)])
    expect(edited.family === 'presentation' && edited.slides[0].objects[0]).toMatchObject({ alignment: 'end' })
  })

  it('converges on a deterministic order for concurrent same-target commands', () => {
    const snapshot = presentationFixture()
    const first = snapshotToYDoc(snapshot)
    const second = new Y.Doc()
    applyOfficeUpdate(second, encodeOfficeState(first))
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'manual' as const }
    appendOfficeCommand(first, { ...common, commandId: id(41), kind: 'setObjectProperty', targetId: id(17), path: ['alignment'], value: 'center' })
    appendOfficeCommand(second, { ...common, commandId: id(42), kind: 'setObjectProperty', targetId: id(17), path: ['alignment'], value: 'end' })

    applyOfficeUpdate(first, encodeOfficeState(second))
    applyOfficeUpdate(second, encodeOfficeState(first))

    expect(officeCommandIds(first)).toEqual(officeCommandIds(second))
    expect(yDocToSnapshot(first)).toEqual(yDocToSnapshot(second))
  })

  it('replaces a connected document base and compacts pre-revision commands', () => {
    const original = documentFixture()
    const doc = snapshotToYDoc(original)
    appendOfficeCommand(doc, {
      artifactId: original.artifactId,
      baseVersion: 0,
      actor: { type: 'user', id: id(40) },
      origin: 'manual',
      commandId: id(41),
      kind: 'setObjectProperty',
      targetId: id(6),
      path: ['alignment'],
      value: 'center',
    })
    const revised = structuredClone(original)
    if (revised.family !== 'document') throw new Error('document fixture required')
    revised.title = 'Brian revision'

    replaceOfficeSnapshot(doc, revised)

    expect(yDocToSnapshot(doc)).toEqual(revised)
    expect(doc.getMap('commands').size).toBe(0)
    expect(doc.getArray('commandOrder').length).toBe(0)
  })

  it('undoes and redoes only this client\'s manual commands', () => {
    const snapshot = presentationFixture()
    const local = snapshotToYDoc(snapshot)
    const remote = new Y.Doc()
    applyOfficeUpdate(remote, encodeOfficeState(local))
    const history = createOfficeUndoManager(local)
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) } }

    appendOfficeCommand(local, { ...common, origin: 'manual', commandId: id(41), kind: 'setObjectProperty', targetId: id(17), path: ['alignment'], value: 'center' })
    appendOfficeCommand(remote, { ...common, origin: 'manual', commandId: id(42), kind: 'setObjectProperty', targetId: id(17), path: ['verticalAlignment'], value: 'middle' })
    applyOfficeUpdate(local, encodeOfficeState(remote))

    const edited = yDocToSnapshot(local)
    if (edited.family !== 'presentation') throw new Error('presentation fixture required')
    expect(edited.slides[0].objects[0]).toMatchObject({ alignment: 'center', verticalAlignment: 'middle' })
    expect(new Set(officeCommandIds(local))).toEqual(new Set([id(41), id(42)]))

    history.undo()
    const undone = yDocToSnapshot(local)
    if (undone.family !== 'presentation') throw new Error('presentation fixture required')
    expect(undone.slides[0].objects[0]).toMatchObject({ alignment: 'start', verticalAlignment: 'middle' })
    expect(officeCommandIds(local)).toEqual([id(42)])

    history.redo()
    const redone = yDocToSnapshot(local)
    if (redone.family !== 'presentation') throw new Error('presentation fixture required')
    expect(redone.slides[0].objects[0]).toMatchObject({ alignment: 'center', verticalAlignment: 'middle' })
    history.destroy()
  })

  it('tracks offline commands for local undo', () => {
    const snapshot = presentationFixture()
    const doc = snapshotToYDoc(snapshot)
    const history = createOfficeUndoManager(doc)
    appendOfficeCommand(doc, {
      artifactId: snapshot.artifactId,
      baseVersion: 0,
      actor: { type: 'user', id: id(40) },
      origin: 'offline',
      commandId: id(41),
      kind: 'setObjectProperty',
      targetId: id(17),
      path: ['alignment'],
      value: 'center',
    })

    history.undo()
    expect(officeCommandIds(doc)).toEqual([])
    history.destroy()
  })

  it('converges row and column resizing while undoing only the local dimension', () => {
    const snapshot = spreadsheetFixture()
    const local = snapshotToYDoc(snapshot)
    const remote = new Y.Doc()
    applyOfficeUpdate(remote, encodeOfficeState(local))
    const history = createOfficeUndoManager(local)
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'manual' as const, sheetId: snapshot.worksheets[0].id }
    appendOfficeCommand(local, { ...common, commandId: id(80), kind: 'setSpreadsheetDimension', axis: 'column', index: 2, size: 31 })
    appendOfficeCommand(remote, { ...common, commandId: id(81), kind: 'setSpreadsheetDimension', axis: 'row', index: 4, size: 27 })
    applyOfficeUpdate(local, encodeOfficeState(remote))
    applyOfficeUpdate(remote, encodeOfficeState(local))
    expect(yDocToSnapshot(local)).toEqual(yDocToSnapshot(remote))

    history.undo()
    let current = yDocToSnapshot(local)
    if (current.family !== 'spreadsheet') throw new Error('spreadsheet fixture required')
    expect(current.worksheets[0].columnDimensions).toEqual([])
    expect(current.worksheets[0].rowDimensions).toContainEqual({ index: 4, heightPt: 27, hidden: false })
    history.redo()
    current = yDocToSnapshot(local)
    if (current.family !== 'spreadsheet') throw new Error('spreadsheet fixture required')
    expect(current.worksheets[0].columnDimensions).toContainEqual({ index: 2, widthChars: 31, hidden: false })
    expect(current.worksheets[0].rowDimensions).toContainEqual({ index: 4, heightPt: 27, hidden: false })
    history.destroy()
  })

  it('converges a worksheet image edit and keeps it locally undoable', () => {
    const snapshot = spreadsheetFixture()
    snapshot.worksheets[0].images = [{ id: id(90), resourceId: id(91), altText: 'Logo', decorative: false, from: { row: 1, column: 1 }, to: { row: 2, column: 2 } }]
    const local = snapshotToYDoc(snapshot)
    const remote = new Y.Doc()
    applyOfficeUpdate(remote, encodeOfficeState(local))
    const history = createOfficeUndoManager(local)
    appendOfficeCommand(local, { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user', id: id(40) }, origin: 'manual', commandId: id(92), kind: 'updateSpreadsheetImage', sheetId: snapshot.worksheets[0].id, imageId: id(90), from: { row: 1, column: 1 }, to: { row: 2, column: 3 }, altText: '', decorative: true })
    applyOfficeUpdate(remote, encodeOfficeState(local))
    expect(yDocToSnapshot(remote)).toEqual(yDocToSnapshot(local))
    let current = yDocToSnapshot(local)
    if (current.family !== 'spreadsheet') throw new Error('spreadsheet fixture required')
    expect(current.worksheets[0].images[0]).toMatchObject({ to: { row: 2, column: 3 }, decorative: true })
    history.undo()
    current = yDocToSnapshot(local)
    if (current.family !== 'spreadsheet') throw new Error('spreadsheet fixture required')
    expect(current.worksheets[0].images[0]).toMatchObject({ to: { row: 2, column: 2 }, altText: 'Logo', decorative: false })
    history.destroy()
  })

  it('reports the sole manager stack state for adaptive history controls', () => {
    const snapshot = presentationFixture()
    const doc = snapshotToYDoc(snapshot)
    const history = createOfficeUndoManager(doc)
    const states: Array<{ canUndo: boolean; canRedo: boolean }> = []
    const stop = observeOfficeHistory(history, (state) => states.push(state))
    appendOfficeCommand(doc, {
      artifactId: snapshot.artifactId,
      baseVersion: 0,
      actor: { type: 'user', id: id(40) },
      origin: 'manual',
      commandId: id(41),
      kind: 'setObjectProperty',
      targetId: id(17),
      path: ['alignment'],
      value: 'center',
    })
    history.undo()
    history.redo()
    expect(states).toContainEqual({ canUndo: false, canRedo: false })
    expect(states).toContainEqual({ canUndo: true, canRedo: false })
    expect(states).toContainEqual({ canUndo: false, canRedo: true })
    stop()
    history.destroy()
  })

  it('converges new presentation commands and undoes a multi-object batch atomically', () => {
    const snapshot = presentationFixture()
    const first = snapshotToYDoc(snapshot)
    const second = new Y.Doc()
    applyOfficeUpdate(second, encodeOfficeState(first))
    const history = createOfficeUndoManager(first)
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'manual' as const }
    appendOfficeCommand(first, {
      ...common,
      commandId: id(60),
      kind: 'batch',
      commands: [
        { ...common, commandId: id(61), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'xPt'], value: 100 },
        { ...common, commandId: id(62), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'yPt'], value: 110 },
      ],
    })
    appendOfficeCommand(second, { ...common, commandId: id(63), kind: 'attachResource', resource: { id: id(64), kind: 'image', hash: 'a'.repeat(64), mime: 'image/png', sensitivity: 'internal' } })
    applyOfficeUpdate(first, encodeOfficeState(second))
    applyOfficeUpdate(second, encodeOfficeState(first))
    expect(yDocToSnapshot(first)).toEqual(yDocToSnapshot(second))

    history.undo()
    const undone = yDocToSnapshot(first)
    if (undone.family !== 'presentation') throw new Error('presentation fixture required')
    expect(undone.slides[0].objects[0].geometry).toMatchObject({ xPt: 72, yPt: 72 })
    expect(undone.resources).toHaveLength(1)
    history.redo()
    const redone = yDocToSnapshot(first)
    if (redone.family !== 'presentation') throw new Error('presentation fixture required')
    expect(redone.slides[0].objects[0].geometry).toMatchObject({ xPt: 100, yPt: 110 })
    history.destroy()
  })

  it('converges slide deletion, object reordering, and resource attachment authored by two clients', () => {
    const snapshot = presentationFixture()
    const clonedObject = { ...structuredClone(snapshot.slides[0].objects[0]), id: id(65), runs: [] }
    snapshot.slides[0].objects.push(clonedObject)
    snapshot.slides[0].readingOrder.push(clonedObject.id)
    snapshot.slides.push({ ...structuredClone(snapshot.slides[0]), id: id(66), title: 'Disposable' })
    const first = snapshotToYDoc(snapshot)
    const second = new Y.Doc()
    applyOfficeUpdate(second, encodeOfficeState(first))
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'manual' as const }

    appendOfficeCommand(first, { ...common, commandId: id(67), kind: 'reorderSlideObject', slideId: id(16), objectId: id(17), index: 1 })
    appendOfficeCommand(second, { ...common, commandId: id(68), kind: 'deleteSlide', slideId: id(66) })
    appendOfficeCommand(second, { ...common, commandId: id(69), kind: 'attachResource', resource: { id: id(70), kind: 'image', hash: 'c'.repeat(64), mime: 'image/png', sensitivity: 'internal' } })
    applyOfficeUpdate(first, encodeOfficeState(second))
    applyOfficeUpdate(second, encodeOfficeState(first))

    const converged = yDocToSnapshot(first)
    expect(converged).toEqual(yDocToSnapshot(second))
    if (converged.family !== 'presentation') throw new Error('presentation fixture required')
    expect(converged.slides).toHaveLength(1)
    expect(converged.slides[0].objects.map((object) => object.id)).toEqual([id(65), id(17)])
    expect(converged.slides[0].readingOrder).toEqual([id(17), id(65)])
    expect(converged.resources).toContainEqual(expect.objectContaining({ id: id(70), hash: 'c'.repeat(64) }))
  })

  it('undoes and redoes a slide deletion atomically without touching a remote resource', () => {
    const snapshot = presentationFixture()
    snapshot.slides.push({ ...structuredClone(snapshot.slides[0]), id: id(71), title: 'Second' })
    const local = snapshotToYDoc(snapshot)
    const remote = new Y.Doc()
    applyOfficeUpdate(remote, encodeOfficeState(local))
    const history = createOfficeUndoManager(local)
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'manual' as const }
    appendOfficeCommand(local, { ...common, commandId: id(72), kind: 'deleteSlide', slideId: id(16) })
    appendOfficeCommand(remote, { ...common, commandId: id(73), kind: 'attachResource', resource: { id: id(74), kind: 'image', hash: 'e'.repeat(64), mime: 'image/png', sensitivity: 'internal' } })
    applyOfficeUpdate(local, encodeOfficeState(remote))
    history.undo()
    let current = yDocToSnapshot(local)
    expect(current.family === 'presentation' && current.slides).toHaveLength(2)
    expect(current.resources).toContainEqual(expect.objectContaining({ id: id(74) }))
    history.redo()
    current = yDocToSnapshot(local)
    expect(current.family === 'presentation' && current.slides).toHaveLength(1)
    expect(current.resources).toContainEqual(expect.objectContaining({ id: id(74) }))
    history.destroy()
  })
})

describe('[COMP:office/collab-codec] rejected append admission', () => {
  it.each(['negative geometry', 'missing target', 'unfenced batch', 'final slide', 'locked cell'] as const)(
    'refuses %s before changing live bytes, events or history',
    (failure) => {
      const snapshot = failure === 'locked cell' ? spreadsheetFixture() : presentationFixture()
      if (snapshot.family === 'spreadsheet') snapshot.worksheets[0].cells[0].locked = true
      const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(900) }, origin: 'manual' as const }
      let command: OfficeCommand
      if (failure === 'negative geometry') {
        command = { ...common, commandId: id(901), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'widthPt'], value: -1 }
      } else if (failure === 'missing target') {
        command = { ...common, commandId: id(901), kind: 'deleteObject', targetId: id(999) }
      } else if (failure === 'unfenced batch') {
        command = { ...common, commandId: id(901), kind: 'batch', commands: [
          { ...common, commandId: id(902), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'xPt'], value: 100 },
          { ...common, commandId: id(903), kind: 'deleteObject', targetId: id(999) },
        ] }
      } else if (failure === 'final slide') {
        command = { ...common, commandId: id(901), kind: 'deleteSlide', slideId: id(16) }
      } else {
        command = { ...common, commandId: id(901), kind: 'setSpreadsheetCell', sheetId: id(23), cellId: id(24), address: 'A1', valueType: 'number', value: 99 }
      }
      // Every input is a real valid-shaped command; refusal must come from
      // canonical semantics before the shared document publishes anything.
      expect(() => OfficeCommandSchema.parse(command)).not.toThrow()
      const doc = snapshotToYDoc(snapshot)
      const history = createOfficeUndoManager(doc)
      const beforeBytes = encodeOfficeState(doc)
      const beforeVector = Y.encodeStateVector(doc)
      const beforeSnapshot = yDocToSnapshot(doc)
      const beforeCommands = doc.getMap<string>('commands').toJSON()
      const beforeOrder = doc.getArray<string>('commandOrder').toArray()
      let updates = 0
      doc.on('update', () => { updates += 1 })
      try {
        let rejection: unknown
        try { appendOfficeCommand(doc, command) } catch (error) { rejection = error }
        const afterBytes = encodeOfficeState(doc)
        const afterVector = Y.encodeStateVector(doc)
        // Report all real boundary outcomes together, so the original failure
        // shows publication as well as the absent semantic rejection.
        expect({
          rejected: rejection instanceof Error,
          encodedBytesUnchanged: beforeBytes.length === afterBytes.length && beforeBytes.every((byte, index) => byte === afterBytes[index]),
          stateVectorUnchanged: beforeVector.length === afterVector.length && beforeVector.every((byte, index) => byte === afterVector[index]),
          commands: doc.getMap<string>('commands').toJSON(),
          commandOrder: doc.getArray<string>('commandOrder').toArray(),
          updateEvents: updates,
          canUndo: history.canUndo(),
        }).toEqual({
          rejected: true,
          encodedBytesUnchanged: true,
          stateVectorUnchanged: true,
          commands: beforeCommands,
          commandOrder: beforeOrder,
          updateEvents: 0,
          canUndo: false,
        })
        expect(yDocToSnapshot(doc)).toEqual(beforeSnapshot)
        expect(officeCommandIds(doc)).toEqual([])
      } finally {
        history.destroy()
        doc.destroy()
      }
    },
  )

  it('keeps ordinary and fenced appends, exact retry, peer delivery and local Undo compatible', () => {
    const snapshot = presentationFixture()
    const doc = snapshotToYDoc(snapshot)
    const peer = new Y.Doc()
    applyOfficeUpdate(peer, encodeOfficeState(doc))
    const history = createOfficeUndoManager(doc)
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(910) }, origin: 'manual' as const }
    try {
      appendOfficeCommand(doc, { ...common, commandId: id(911), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'xPt'], value: 100 })
      history.stopCapturing()
      const fenced: OfficeCommand = {
        ...common, commandId: id(912), kind: 'batch',
        expectedSnapshotHash: officeSnapshotPreconditionHash(yDocToSnapshot(doc)),
        commands: [
          { ...common, commandId: id(913), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'widthPt'], value: -1 },
          { ...common, commandId: id(914), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'widthPt'], value: 500 },
        ],
      }
      let updates = 0
      doc.on('update', () => { updates += 1 })
      appendOfficeCommand(doc, fenced)
      expect(updates).toBe(1)
      expect(JSON.parse(doc.getMap<string>('commands').get(fenced.commandId)!)).not.toHaveProperty('expectedSnapshotHash')
      expect(officeCommandMatches(doc, fenced)).toBe(true)
      const once = encodeOfficeState(doc)
      const vector = Y.encodeStateVector(doc)
      appendOfficeCommand(doc, fenced)
      expect(encodeOfficeState(doc)).toEqual(once)
      expect(Y.encodeStateVector(doc)).toEqual(vector)
      expect(updates).toBe(1)

      applyOfficeUpdate(peer, encodeOfficeState(doc))
      expect(yDocToSnapshot(peer)).toEqual(yDocToSnapshot(doc))
      appendOfficeCommand(peer, { ...common, commandId: id(915), kind: 'setObjectProperty', targetId: id(17), path: ['verticalAlignment'], value: 'middle' })
      applyOfficeUpdate(doc, encodeOfficeState(peer))
      history.undo()
      expect(yDocToSnapshot(doc)).toMatchObject({
        slides: [{ objects: [{ geometry: { xPt: 100, widthPt: 816 }, verticalAlignment: 'middle' }] }],
      })
      expect(officeCommandIds(doc)).not.toContain(fenced.commandId)
      history.redo()
      expect(yDocToSnapshot(doc)).toMatchObject({
        slides: [{ objects: [{ geometry: { xPt: 100, widthPt: 500 }, verticalAlignment: 'middle' }] }],
      })
      applyOfficeUpdate(peer, encodeOfficeState(doc))
      expect(yDocToSnapshot(peer)).toEqual(yDocToSnapshot(doc))
    } finally {
      history.destroy()
      peer.destroy()
      doc.destroy()
    }
  })
})
