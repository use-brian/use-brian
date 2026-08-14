import { describe, expect, it } from 'vitest'
import { applyOfficeCommand } from '../commands.js'
import { documentFixture, id, presentationFixture } from './fixtures.js'

const actor = { type: 'user' as const, id: id(90) }

describe('[COMP:office/commands] Office command vocabulary', () => {
  it('applies a deterministic text update without mutating the base', () => {
    const base = documentFixture()
    const next = applyOfficeCommand(base, {
      commandId: id(91), artifactId: base.artifactId, baseVersion: 0, actor, origin: 'manual', kind: 'updateText', targetId: id(6),
      runs: [{ id: id(92), text: 'Updated', style: { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }],
    })
    expect(next.family === 'document' && next.sections[0].nodes[0].kind === 'paragraph' && next.sections[0].nodes[0].runs[0].text).toBe('Updated')
    expect(base.sections[0].nodes[0].kind === 'paragraph' && base.sections[0].nodes[0].runs[0].text).toBe('A grounded update.')
  })

  it('keeps presentation reading order aligned on insert/delete', () => {
    const base = presentationFixture()
    const inserted = applyOfficeCommand(base, {
      commandId: id(93), artifactId: base.artifactId, baseVersion: 0, actor, origin: 'manual', kind: 'insertSlideObject', slideId: id(16), index: 1,
      object: { id: id(94), kind: 'shape', shape: 'rectangle', geometry: { xPt: 10, yPt: 10, widthPt: 20, heightPt: 20, rotationDeg: 0 }, locked: false, strokeWidthPt: 1, text: [], fill: '#FFFFFF' },
    })
    expect(inserted.family === 'presentation' && inserted.slides[0].readingOrder).toEqual([id(17), id(94)])
    const removed = applyOfficeCommand(inserted, { commandId: id(95), artifactId: base.artifactId, baseVersion: 1, actor, origin: 'manual', kind: 'deleteObject', targetId: id(94) })
    expect(removed.family === 'presentation' && removed.slides[0].readingOrder).toEqual([id(17)])
  })

  it('deletes a slide but never the final slide', () => {
    const base = presentationFixture()
    const second = { ...structuredClone(base.slides[0]), id: id(31), objects: [], readingOrder: [] }
    base.slides.push(second)
    const next = applyOfficeCommand(base, { commandId: id(32), artifactId: base.artifactId, baseVersion: 0, actor, origin: 'manual', kind: 'deleteSlide', slideId: id(16) })
    expect(next.family === 'presentation' && next.slides.map((slide) => slide.id)).toEqual([id(31)])
    expect(() => applyOfficeCommand(next, { commandId: id(33), artifactId: base.artifactId, baseVersion: 0, actor, origin: 'manual', kind: 'deleteSlide', slideId: id(31) })).toThrow(/at least one slide/)
  })

  it('changes z-order without changing accessibility reading order', () => {
    const base = presentationFixture()
    const second = { ...structuredClone(base.slides[0].objects[0]), id: id(34), runs: [] }
    base.slides[0].objects.push(second)
    base.slides[0].readingOrder.push(second.id)
    const next = applyOfficeCommand(base, { commandId: id(35), artifactId: base.artifactId, baseVersion: 0, actor, origin: 'manual', kind: 'reorderSlideObject', slideId: id(16), objectId: id(17), index: 1 })
    expect(next.family === 'presentation' && next.slides[0].objects.map((object) => object.id)).toEqual([id(34), id(17)])
    expect(next.family === 'presentation' && next.slides[0].readingOrder).toEqual([id(17), id(34)])
  })

  it('attaches immutable resources idempotently and rejects collisions', () => {
    const base = presentationFixture()
    const resource = { id: id(36), kind: 'image' as const, hash: 'a'.repeat(64), mime: 'image/png', sensitivity: 'internal' as const }
    const attached = applyOfficeCommand(base, { commandId: id(37), artifactId: base.artifactId, baseVersion: 0, actor, origin: 'manual', kind: 'attachResource', resource })
    const repeated = applyOfficeCommand(attached, { commandId: id(38), artifactId: base.artifactId, baseVersion: 0, actor, origin: 'manual', kind: 'attachResource', resource })
    expect(repeated.resources).toEqual([resource])
    expect(() => applyOfficeCommand(repeated, { commandId: id(39), artifactId: base.artifactId, baseVersion: 0, actor, origin: 'manual', kind: 'attachResource', resource: { ...resource, hash: 'b'.repeat(64) } })).toThrow(/collision/)
    expect(() => applyOfficeCommand(repeated, { commandId: id(40), artifactId: base.artifactId, baseVersion: 0, actor, origin: 'manual', kind: 'attachResource', resource: { ...resource, id: id(40), mime: 'image/jpeg' } })).toThrow(/collision/)
  })

  it('validates a batch only after all children and exposes no partial result on failure', () => {
    const base = presentationFixture()
    const common = { artifactId: base.artifactId, baseVersion: 0, actor, origin: 'manual' as const }
    const repaired = applyOfficeCommand(base, {
      ...common,
      commandId: id(41),
      kind: 'batch',
      commands: [
        { ...common, commandId: id(42), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'widthPt'], value: -1 },
        { ...common, commandId: id(43), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'widthPt'], value: 500 },
      ],
    })
    expect(repaired.family === 'presentation' && repaired.slides[0].objects[0].geometry.widthPt).toBe(500)

    expect(() => applyOfficeCommand(base, {
      ...common,
      commandId: id(44),
      kind: 'batch',
      commands: [
        { ...common, commandId: id(45), kind: 'setObjectProperty', targetId: id(17), path: ['geometry', 'widthPt'], value: 500 },
        { ...common, commandId: id(46), kind: 'deleteObject', targetId: id(99) },
      ],
    })).toThrow(/was not found/)
    expect(base.slides[0].objects[0].geometry.widthPt).toBe(816)
  })
})
