import { describe, expect, it } from 'vitest'
import type { PresentationObject } from '../model.js'
import {
  arrangePresentationObjects,
  clonePresentationObjects,
  clonePresentationSlide,
  createPresentationChartObject,
  createPresentationTableObject,
  commonPresentationTextFormatting,
  formatPresentationTextObject,
  presentationSelectionBounds,
  presentationZOrderIndex,
  snapPresentationGeometry,
} from '../presentation-editing.js'
import { id, presentationFixture } from './fixtures.js'

function ids(start = 100): () => string {
  let cursor = start
  return () => id(cursor++)
}

describe('[COMP:office/presentation-editing] Presentation editing semantics', () => {
  it('deep-remaps slides, objects, runs, table rows/cells, notes, and connector endpoints', () => {
    const slide = presentationFixture().slides[0]
    const table = createPresentationTableObject({ id: id(30), rows: 2, columns: 2, createId: ids(31), geometry: { xPt: 120, yPt: 120, widthPt: 480, heightPt: 240, rotationDeg: 0 } })
    table.rows[0].cells[0].runs[0].text = 'A'
    const connector: PresentationObject = {
      id: id(50), kind: 'connector', connector: 'straight', fromObjectId: id(17), toObjectId: id(30), stroke: '#111111',
      geometry: { xPt: 10, yPt: 10, widthPt: 100, heightPt: 100, rotationDeg: 0 }, locked: false,
    }
    slide.objects.push(table, connector)
    slide.readingOrder.push(table.id, connector.id)
    slide.notes = [{ id: id(51), text: 'Speaker note', style: { fontFamily: 'Arial', fontSizePt: 12, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }]

    const { slide: cloned } = clonePresentationSlide(slide, ids(100))
    const clonedTable = cloned.objects.find((object) => object.kind === 'table')
    const clonedConnector = cloned.objects.find((object) => object.kind === 'connector')
    expect(new Set(cloned.readingOrder)).toEqual(new Set(cloned.objects.map((object) => object.id)))
    expect(cloned.id).not.toBe(slide.id)
    expect(cloned.notes[0].id).not.toBe(slide.notes[0].id)
    expect(clonedTable?.id).not.toBe(table.id)
    if (!clonedTable || clonedTable.kind !== 'table' || !clonedConnector || clonedConnector.kind !== 'connector') throw new Error('clone drift')
    expect(clonedTable.rows[0].id).not.toBe(table.rows[0].id)
    expect(clonedTable.rows[0].cells[0].id).not.toBe(table.rows[0].cells[0].id)
    expect(clonedTable.rows[0].cells[0].runs[0].id).not.toBe(table.rows[0].cells[0].runs[0].id)
    expect(clonedConnector.fromObjectId).toBe(cloned.objects[0].id)
    expect(clonedConnector.toObjectId).toBe(clonedTable.id)
  })

  it('offsets selected-object clones and leaves external connector endpoints unchanged', () => {
    const slide = presentationFixture().slides[0]
    const connector: PresentationObject = {
      id: id(60), kind: 'connector', connector: 'elbow', fromObjectId: slide.objects[0].id, toObjectId: id(99), stroke: '#111111',
      geometry: { xPt: 20, yPt: 20, widthPt: 40, heightPt: 40, rotationDeg: 0 }, locked: false,
    }
    const result = clonePresentationObjects([slide.objects[0], connector], ids(110))
    const clonedConnector = result.objects[1]
    expect(result.objects[0].geometry.xPt).toBe(slide.objects[0].geometry.xPt + 12)
    if (clonedConnector.kind !== 'connector') throw new Error('connector clone drift')
    expect(clonedConnector.fromObjectId).toBe(result.objects[0].id)
    expect(clonedConnector.toObjectId).toBe(id(99))
  })

  it('calculates bounds and deterministic align, distribute, center, and z-order operations', () => {
    const base = presentationFixture().slides[0].objects[0]
    const objects: PresentationObject[] = [
      { ...structuredClone(base), id: id(61), geometry: { xPt: 10, yPt: 20, widthPt: 20, heightPt: 20, rotationDeg: 0 } },
      { ...structuredClone(base), id: id(62), geometry: { xPt: 50, yPt: 60, widthPt: 10, heightPt: 10, rotationDeg: 0 } },
      { ...structuredClone(base), id: id(63), geometry: { xPt: 100, yPt: 100, widthPt: 20, heightPt: 20, rotationDeg: 0 } },
    ]
    expect(presentationSelectionBounds(objects)).toMatchObject({ xPt: 10, yPt: 20, widthPt: 110, heightPt: 100 })
    expect(arrangePresentationObjects(objects, 'alignRight').find((object) => object.id === id(62))?.geometry.xPt).toBe(110)
    expect(arrangePresentationObjects(objects, 'distributeHorizontal').find((object) => object.id === id(62))?.geometry.xPt).toBe(60)
    const centered = arrangePresentationObjects(objects, 'centerOnSlide', { widthPt: 200, heightPt: 200 })
    expect(centered.find((object) => object.id === id(61))?.geometry.xPt).toBe(45)
    expect(centered.find((object) => object.id === id(61))?.geometry.yPt).toBe(50)
    expect(presentationZOrderIndex(objects.length, 1, 'bringToFront')).toBe(2)
    expect(presentationZOrderIndex(objects.length, 1, 'sendBackward')).toBe(0)
  })

  it('snaps at four points with stable class priority and emits guides', () => {
    const base = presentationFixture().slides[0].objects[0]
    const exactOther = { ...structuredClone(base), id: id(64), geometry: { xPt: 98, yPt: 20, widthPt: 20, heightPt: 20, rotationDeg: 0 } }
    const snapped = snapPresentationGeometry({ xPt: 46, yPt: 1, widthPt: 10, heightPt: 10, rotationDeg: 0 }, [exactOther], { widthPt: 100, heightPt: 100 })
    expect(snapped.geometry).toMatchObject({ xPt: 45, yPt: 0 })
    expect(snapped.guides).toEqual([
      { axis: 'x', positionPt: 50, source: 'slide-center' },
      { axis: 'y', positionPt: 0, source: 'slide-edge' },
    ])
    expect(snapPresentationGeometry({ xPt: 5, yPt: 5, widthPt: 10, heightPt: 10, rotationDeg: 0 }, [], { widthPt: 100, heightPt: 100 }).guides).toEqual([])
  })

  it('constructs bounded valid tables and charts and rejects invalid chart data', () => {
    const geometry = { xPt: 120, yPt: 120, widthPt: 480, heightPt: 240, rotationDeg: 0 }
    const table = createPresentationTableObject({ id: id(65), rows: 2, columns: 3, createId: ids(130), geometry })
    expect(table.rows).toHaveLength(2)
    expect(table.rows[0].cells).toHaveLength(3)
    expect(() => createPresentationTableObject({ id: id(66), rows: 21, columns: 1, createId: ids(150), geometry })).toThrow(/1 to 20/)

    const chart = createPresentationChartObject({ id: id(67), chartType: 'line', title: 'Growth', altText: 'Growth by quarter', categories: ['Q1', 'Q2'], series: [{ name: 'Revenue', values: [1, 2] }], geometry, createId: ids(160) })
    expect(chart.series[0].values).toEqual([1, 2])
    expect(() => createPresentationChartObject({ id: id(68), chartType: 'bar', title: 'Bad', altText: 'Bad data', categories: ['Q1'], series: [{ name: 'Revenue', values: [1, 2] }], geometry, createId: ids(170) })).toThrow(/finite value/)
    expect(() => createPresentationChartObject({ id: id(69), chartType: 'scatter', title: 'Bad', altText: 'Bad data', categories: ['Q1'], series: [{ name: 'Revenue', values: [1] }], geometry, createId: ids(180) })).toThrow(/numeric/)
  })

  it('formats complete rich runs while preserving IDs, text, language, and safe-link policy', () => {
    const source = presentationFixture().slides[0].objects[0]
    if (source.kind !== 'text') throw new Error('text fixture required')
    source.runs[0].style.language = 'en-US'
    const formatted = formatPresentationTextObject(source, { fontFamily: 'Aptos', fontSizePt: 24, bold: true, color: '#123456', href: 'https://example.com', alignment: 'center', verticalAlignment: 'middle' })
    if (formatted.kind !== 'text') throw new Error('formatted text required')
    expect(formatted.runs[0]).toMatchObject({ id: source.runs[0].id, text: source.runs[0].text, href: 'https://example.com', style: { fontFamily: 'Aptos', fontSizePt: 24, bold: true, color: '#123456', language: 'en-US' } })
    expect(formatted).toMatchObject({ alignment: 'center', verticalAlignment: 'middle' })
    expect(commonPresentationTextFormatting([formatted])).toMatchObject({ fontFamily: 'Aptos', bold: true, alignment: 'center' })
    expect(() => formatPresentationTextObject(source, { href: 'javascript:alert(1)' })).toThrow(/HTTPS or mailto/)
  })
})
