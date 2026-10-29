import { describe, expect, it } from 'vitest'
import { applyDrawingActions, defaultDrawingLibrary, parseLibrary, type DrawingScene, type DrawingAction } from '../drawing.js'
const scene = (): DrawingScene => ({ version: 1, elements: [
  { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 80 },
  { id: 'b', type: 'ellipse', x: 300, y: 0, width: 100, height: 80 },
  { id: 'label', type: 'text', x: 20, y: 20, width: 60, height: 40, text: 'Box', fontSize: 20, fontFamily: 1, containerId: 'a' },
], files: {}, appState: { viewBackgroundColor: '#fff' } })
describe('[COMP:doc/drawing-tools] drawing actions', () => {
  it('connects both binding lists and updates arrow endpoints/labels after move and resize', () => {
    const original = scene()
    original.elements[0].strokeColor = 'transparent'
    const before = structuredClone(original)
    const connected = applyDrawingActions(original, [{ type: 'connect', fromId: 'a', toId: 'b' }], () => 'arrow')
    const arrow = connected.elements.find(e => e.id === 'arrow')!
    expect(arrow).toMatchObject({ strokeColor: '#1b1b1f', x: 108, y: 40, points: [[0, 0], [184, 0]], startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } })
    expect(connected.elements[0].boundElements).toEqual([{ id: 'arrow', type: 'arrow' }])
    const moved = applyDrawingActions(connected, [{ type: 'move', elementIds: ['a'], dx: 30, dy: 50 }])
    expect(moved.elements.find(e => e.id === 'label')).toMatchObject({ x: 50, y: 70 })
    expect(moved.elements.find(e => e.id === 'arrow')!.x).not.toBe(arrow.x)
    const resized = applyDrawingActions(moved, [{ type: 'resize', elementId: 'a', width: 200, height: 100 }])
    expect(resized.elements.find(e => e.id === 'label')).toMatchObject({ x: 100, y: 80 })
    expect(original).toEqual(before)
  })
  it('scales freehand geometry and keeps raster assets intact', () => {
    const base = scene()
    base.elements.push({ id: 'free', type: 'freedraw', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, 10]], pressures: [], simulatePressure: true })
    base.files.asset = { id: 'asset', mimeType: 'image/png', dataURL: 'data:image/png;base64,YQ==', created: 1 }
    base.elements.push({ id: 'image', type: 'image', x: 0, y: 0, width: 30, height: 30, fileId: 'asset' })
    const edited = applyDrawingActions(base, [{ type: 'resize', elementId: 'free', width: 20, height: 30 }])
    expect(edited.elements.find(e => e.id === 'free')).toMatchObject({ points: [[0, 0], [20, 30]] })
    expect(edited.files).toEqual(base.files)
  })
  it('clones grouped library elements twice with fresh IDs and remaps internal bindings', () => {
    const connected = applyDrawingActions(scene(), [{ type: 'connect', fromId: 'a', toId: 'b' }], () => 'arrow')
    connected.elements.forEach(e => { e.groupIds = ['group'] })
    const item = { id: 'item', status: 'published' as const, created: 1, elements: connected.elements }
    let next = 0
    const result = applyDrawingActions(scene(), [
      { type: 'insertLibraryItem', item, x: 500, y: 200 }, { type: 'insertLibraryItem', item, x: 1000, y: 400 },
    ], () => `new-${next++}`)
    expect(new Set(result.elements.map(e => e.id)).size).toBe(result.elements.length)
    const inserted = result.elements.slice(3)
    const first = inserted.slice(0, 4), second = inserted.slice(4)
    expect(first[0]).toMatchObject({ x: 500, y: 200 })
    expect(second[0].groupIds).not.toEqual(first[0].groupIds)
    expect(first.find(e => e.type === 'arrow')).toMatchObject({ startBinding: { elementId: first[0].id }, endBinding: { elementId: first[1].id } })
    expect(first.find(e => e.type === 'text')!.containerId).toBe(first[0].id)
  })
  it('rejects a bad batch without changing the input', () => {
    const base = scene()
    expect(() => applyDrawingActions(base, [{ type: 'move', elementIds: ['a'], dx: 20, dy: 0 }, { type: 'resize', elementId: 'gone', width: 20, height: 20 }])).toThrow('Shape not found')
    expect(base).toEqual(scene())
    base.elements[0].locked = true
    expect(() => applyDrawingActions(base, [{ type: 'move', elementIds: ['a'], dx: 20, dy: 0 }])).toThrow('locked')
    expect(() => applyDrawingActions(scene(), [{ type: 'resize', elementId: 'a', width: NaN, height: -1 }])).toThrow()
    expect(() => applyDrawingActions(scene(), Array(65).fill({ type: 'connect', fromId: 'a', toId: 'b' }) as DrawingAction[])).toThrow()
  })
  it('moves the entire selected group and refuses locked members or unsupported elbow edits', () => {
    const base = scene()
    base.elements[0].groupIds = ['g']; base.elements[1].groupIds = ['g']
    const moved = applyDrawingActions(base, [{ type: 'move', elementIds: ['a'], dx: 10, dy: 0 }])
    expect(moved.elements[1].x).toBe(310)
    const connected = applyDrawingActions(scene(), [{ type: 'connect', fromId: 'a', toId: 'b' }])
    connected.elements.find(e => e.type === 'arrow')!.elbowed = true
    expect(() => applyDrawingActions(connected, [{ type: 'move', elementIds: ['a'], dx: 10, dy: 0 }])).toThrow('elbow')
  })
  it('uses the same built-in items and legacy import normalization as the browser', () => {
    const item = defaultDrawingLibrary()[0]
    expect(applyDrawingActions(scene(), [{ type: 'insertLibraryItem', item, x: 500, y: 200 }]).elements.length).toBe(3 + item.elements.length)
    const text = JSON.stringify({ type: 'excalidrawlib', version: 1, library: [[{ id: 'old', type: 'draw', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, 10]] }]] })
    expect(parseLibrary(text)[0].elements[0].type).toBe('line')
    expect(parseLibrary(text)[0].id).toBe(parseLibrary(text)[0].id)
  })
})
