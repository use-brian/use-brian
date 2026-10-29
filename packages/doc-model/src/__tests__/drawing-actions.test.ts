import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { applyOpsToYDoc } from '../apply-ops.js'
import { DrawingCollaboration, findDrawing, drawingNamespace, drawingRegisters } from '../drawing.js'
import { pageToYDocUpdate, yDocToSnapshot } from '../encode.js'
const base = { kind: 'drawing' as const, id: 'drawing', scene: { version: 1 as const, files: {}, appState: { viewBackgroundColor: '#fff' },
  elements: ['a', 'b'].map((id, i) => ({ id, type: 'rectangle' as const, x: i * 300, y: 0, width: 100, height: 80 })) } }
function doc() { const doc = new Y.Doc(); Y.applyUpdate(doc, pageToYDocUpdate({ blocks: [base] }, 'Test')); return doc }
describe('[COMP:doc/drawing-tools] authoritative live actions', () => {
  it('applies against live geometry without replacing the base or namespace; independent peer edits survive', () => {
    const server = doc(), peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(server))
    const human = new DrawingCollaboration(peer, findDrawing(peer, base.id)!, () => true)
    const namespace = drawingNamespace(server, findDrawing(server, base.id)!)
    const previous = human.read().scene
    human.write(previous, { ...previous, elements: previous.elements.map(e => e.id === 'b' ? { ...e, y: 99 } : e) })
    const result = applyOpsToYDoc(server, [{ op: 'drawing', blockId: base.id, namespace, actions: [{ type: 'move', elementIds: ['a'], dx: 40, dy: 20 }] }])
    expect(result.skipped).toEqual([])
    expect(result.drawings?.drawing.changedElementIds).toEqual(['a'])
    Y.applyUpdate(server, Y.encodeStateAsUpdate(peer)); Y.applyUpdate(peer, Y.encodeStateAsUpdate(server))
    expect(human.valid()).toBe(true)
    expect(human.read().scene.elements).toMatchObject([{ id: 'a', x: 40, y: 20 }, { id: 'b', y: 99 }])
    expect(findDrawing(server, base.id)).toEqual(base)
    expect(drawingNamespace(server, base)).toBe(namespace)
    expect(yDocToSnapshot(server)).toEqual(yDocToSnapshot(peer))
    human.undo.undo()
    expect(human.read().scene.elements.find(e => e.id === 'a')!.x).toBe(40)
    human.dispose()
  })
  it('reads before persistence, rejects stale namespaces/deleted shapes and leaves failed batches unwritten', () => {
    const server = doc()
    const read = applyOpsToYDoc(server, [{ op: 'drawing', blockId: base.id, actions: [] }]).drawings!.drawing
    const failed = applyOpsToYDoc(server, [{ op: 'drawing', blockId: base.id, namespace: read.namespace, actions: [
      { type: 'move', elementIds: ['a'], dx: 10, dy: 10 }, { type: 'resize', elementId: 'missing', width: 10, height: 10 },
    ] }])
    expect(failed.skipped[0].reason).toContain('Shape not found')
    expect(drawingRegisters(server, base).size).toBe(0)
    applyOpsToYDoc(server, [{ op: 'edit', blockId: base.id, patch: { scene: base.scene } }])
    expect(applyOpsToYDoc(server, [{ op: 'drawing', blockId: base.id, namespace: read.namespace, actions: [{ type: 'connect', fromId: 'a', toId: 'b' }] }]).skipped[0].reason).toContain('replaced')
    applyOpsToYDoc(server, [{ op: 'delete', blockId: base.id }])
    expect(applyOpsToYDoc(server, [{ op: 'drawing', blockId: base.id, actions: [] }]).skipped[0].reason).toContain('not found')
  })
})
