import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  appendOfficeCommand,
  applyOfficeUpdate,
  createOfficeUndoManager,
  encodeOfficeState,
  officeCommandIds,
  snapshotToYDoc,
  yDocToSnapshot,
} from '../collab.js'
import { id, presentationFixture } from './fixtures.js'

const actor = { type: 'user' as const, id: id(70) }

describe('[COMP:office/collab-codec] Presentation command collaboration', () => {
  it('converges across two clients for concurrent slide and object ordering', () => {
    const snapshot = presentationFixture()
    const secondSlide = { ...structuredClone(snapshot.slides[0]), id: id(71), title: 'Second', objects: [], readingOrder: [] }
    snapshot.slides.push(secondSlide)
    const secondObject = { ...structuredClone(snapshot.slides[0].objects[0]), id: id(72), runs: [] }
    snapshot.slides[0].objects.push(secondObject)
    snapshot.slides[0].readingOrder.push(secondObject.id)
    const first = snapshotToYDoc(snapshot)
    const second = new Y.Doc()
    applyOfficeUpdate(second, encodeOfficeState(first))
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor, origin: 'manual' as const }

    appendOfficeCommand(first, { ...common, commandId: id(73), kind: 'reorderSlide', slideId: id(71), index: 0 })
    appendOfficeCommand(second, { ...common, commandId: id(74), kind: 'reorderSlideObject', slideId: snapshot.slides[0].id, objectId: id(72), index: 0 })
    applyOfficeUpdate(first, encodeOfficeState(second))
    applyOfficeUpdate(second, encodeOfficeState(first))

    expect(officeCommandIds(first)).toEqual(officeCommandIds(second))
    expect(yDocToSnapshot(first)).toEqual(yDocToSnapshot(second))
  })

  it('undoes one multi-object batch as one local gesture', () => {
    const snapshot = presentationFixture()
    const secondObject = { ...structuredClone(snapshot.slides[0].objects[0]), id: id(75), runs: [] }
    snapshot.slides[0].objects.push(secondObject)
    snapshot.slides[0].readingOrder.push(secondObject.id)
    const doc = snapshotToYDoc(snapshot)
    const history = createOfficeUndoManager(doc)
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor, origin: 'manual' as const }

    appendOfficeCommand(doc, {
      ...common,
      commandId: id(76),
      kind: 'batch',
      commands: [
        { ...common, commandId: id(77), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'xPt'], value: 100 },
        { ...common, commandId: id(78), kind: 'setObjectProperty', targetId: id(75), path: ['geometry', 'xPt'], value: 200 },
      ],
    })
    const edited = yDocToSnapshot(doc)
    expect(edited.family === 'presentation' && edited.slides[0].objects.map((object) => object.geometry.xPt)).toEqual([100, 200])

    history.undo()
    expect(officeCommandIds(doc)).toEqual([])
    expect(yDocToSnapshot(doc)).toEqual(snapshot)
    history.redo()
    expect(officeCommandIds(doc)).toEqual([id(76)])
    history.destroy()
  })
})
