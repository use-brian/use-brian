import type { DocumentSnapshot, PresentationSnapshot } from '../model.js'

const id = (suffix: number): string => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`

export function documentFixture(): DocumentSnapshot {
  return {
    schemaVersion: 1,
    capabilityVersion: 1,
    artifactId: id(1),
    workspaceId: id(2),
    family: 'document',
    locale: 'en-US',
    defaultLanguage: 'en-US',
    templateVersionId: id(3),
    rootId: id(4),
    title: 'Quarterly update',
    resources: [],
    accessibility: { title: 'Quarterly update' },
    sections: [{
      id: id(5),
      page: { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72, orientation: 'portrait' },
      header: [],
      footer: [],
      showPageNumber: true,
      nodes: [{
        id: id(6),
        kind: 'paragraph',
        styleName: 'Body',
        alignment: 'start',
        runs: [{ id: id(7), text: 'A grounded update.', style: { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }],
      }],
    }],
  }
}

export function presentationFixture(): PresentationSnapshot {
  return {
    schemaVersion: 1,
    capabilityVersion: 1,
    artifactId: id(11),
    workspaceId: id(2),
    family: 'presentation',
    locale: 'en-US',
    defaultLanguage: 'en-US',
    templateVersionId: id(3),
    rootId: id(12),
    title: 'Pitch',
    resources: [],
    accessibility: { title: 'Pitch' },
    slideSize: { widthPt: 960, heightPt: 540 },
    themeId: id(13),
    masters: [{ id: id(14), name: 'Master', lockedObjectIds: [] }],
    layouts: [{ id: id(15), masterId: id(14), name: 'Title', placeholderIds: [] }],
    slides: [{
      id: id(16),
      title: 'Opening',
      masterId: id(14),
      layoutId: id(15),
      notes: [],
      objects: [{
        id: id(17),
        kind: 'text',
        geometry: { xPt: 72, yPt: 72, widthPt: 816, heightPt: 120, rotationDeg: 0 },
        locked: false,
        alignment: 'start',
        verticalAlignment: 'top',
        runs: [{ id: id(18), text: 'Company pitch', style: { fontFamily: 'Arial', fontSizePt: 44, bold: true, italic: false, underline: false, strike: false, color: '#111111' } }],
      }],
      readingOrder: [id(17)],
    }],
  }
}

export { id }
