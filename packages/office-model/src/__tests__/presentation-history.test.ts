import { describe, expect, it, vi } from 'vitest'
import { appendOfficeCommand, createOfficeUndoManager, observeOfficeHistory, officeHistoryState, snapshotToYDoc } from '../collab.js'
import { id, presentationFixture } from './fixtures.js'

describe('[COMP:office/collab-codec] Presentation local history state', () => {
  it('drives buttons from the sole Yjs manager stack', () => {
    const snapshot = presentationFixture()
    const doc = snapshotToYDoc(snapshot)
    const history = createOfficeUndoManager(doc)
    const listener = vi.fn()
    const stop = observeOfficeHistory(history, listener)
    expect(officeHistoryState(history)).toEqual({ canUndo: false, canRedo: false })
    appendOfficeCommand(doc, { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user', id: id(90) }, origin: 'manual', commandId: id(91), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'xPt'], value: 120 })
    expect(officeHistoryState(history)).toEqual({ canUndo: true, canRedo: false })
    history.undo()
    expect(officeHistoryState(history)).toEqual({ canUndo: false, canRedo: true })
    expect(listener).toHaveBeenCalled()
    stop()
    history.destroy()
  })
})
