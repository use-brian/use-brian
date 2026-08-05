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
})
