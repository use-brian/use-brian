import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { appendOfficeCommand, applyOfficeUpdate, createOfficeUndoManager, encodeOfficeState, observeOfficeHistory, officeCommandIds, replaceOfficeSnapshot, snapshotToYDoc, yDocToSnapshot } from '../collab.js'
import { documentFixture, id, presentationFixture } from './fixtures.js'

describe('[COMP:office/collab-codec] Office Yjs codec', () => {
  it('round-trips a canonical snapshot exactly', () => {
    const snapshot = documentFixture()
    expect(yDocToSnapshot(snapshotToYDoc(snapshot))).toEqual(snapshot)
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
})
