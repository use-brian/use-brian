import { describe, expect, it } from 'vitest'
import type { DocumentSnapshot, PresentationSnapshot } from '@use-brian/office-model'
import { layoutOfficeArtifact } from '../layout.js'

const id = (suffix: number): string => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
const style = { fontFamily: 'Arial', fontSizePt: 12, bold: false, italic: false, underline: false, strike: false, color: '#111111' }

describe('[COMP:office/layout] Deterministic Office layout', () => {
  it('paginates document flow from one deterministic measurement path', () => {
    const snapshot: DocumentSnapshot = { schemaVersion: 1, capabilityVersion: 1, artifactId: id(1), workspaceId: id(2), family: 'document', locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: id(3), rootId: id(4), title: 'Doc', resources: [], accessibility: { title: 'Doc' }, sections: [{ id: id(5), page: { widthPt: 300, heightPt: 200, marginTopPt: 20, marginRightPt: 20, marginBottomPt: 20, marginLeftPt: 20, orientation: 'portrait' }, header: [], footer: [], showPageNumber: true, nodes: Array.from({ length: 10 }, (_, index) => ({ id: id(10 + index), kind: 'paragraph' as const, styleName: 'Body', alignment: 'start' as const, runs: [{ id: id(30 + index), text: 'A line of readable content', style }] })) }] }
    const first = layoutOfficeArtifact(snapshot)
    expect(first.pages.length).toBeGreaterThan(1)
    expect(layoutOfficeArtifact(snapshot).serialization).toBe(first.serialization)
  })

  it('names slide overflow instead of clipping it', () => {
    const snapshot: PresentationSnapshot = { schemaVersion: 1, capabilityVersion: 1, artifactId: id(51), workspaceId: id(2), family: 'presentation', locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: id(3), rootId: id(52), title: 'Deck', resources: [], accessibility: { title: 'Deck' }, slideSize: { widthPt: 300, heightPt: 200 }, themeId: id(53), masters: [{ id: id(54), name: 'Master', lockedObjectIds: [] }], layouts: [{ id: id(55), masterId: id(54), name: 'Title', placeholderIds: [] }], slides: [{ id: id(56), title: 'Slide', masterId: id(54), layoutId: id(55), notes: [], objects: [{ id: id(57), kind: 'text', geometry: { xPt: 250, yPt: 10, widthPt: 100, heightPt: 20, rotationDeg: 0 }, locked: false, alignment: 'start', verticalAlignment: 'top', runs: [{ id: id(58), text: 'Overflow', style }] }], readingOrder: [id(57)] }] }
    expect(layoutOfficeArtifact(snapshot).issues).toContainEqual(expect.objectContaining({ code: 'overflow', objectId: id(57) }))
  })
})
