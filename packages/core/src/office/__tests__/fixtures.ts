import type { DocumentSnapshot, OfficeTemplateBundle, PresentationSnapshot } from '@use-brian/office-model'

export const id = (value: number): string => `10000000-0000-4000-8000-${value.toString().padStart(12, '0')}`
const style = (fontSizePt = 11) => ({ fontFamily: 'Arial', fontSizePt, bold: false, italic: false, underline: false, strike: false, color: '#111111' })

export function documentSnapshot(): DocumentSnapshot {
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
    title: 'Board update',
    resources: [],
    accessibility: { title: 'Board update', description: 'Accessible quarterly update' },
    sections: [{
      id: id(5),
      page: { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72, orientation: 'portrait' },
      header: [{ id: id(6), text: 'Acme', style: style(9) }],
      footer: [],
      showPageNumber: true,
      nodes: [
        { id: id(7), kind: 'heading', level: 1, styleName: 'Heading 1', runs: [{ id: id(8), text: 'Quarterly update', style: { ...style(28), bold: true } }] },
        { id: id(9), kind: 'paragraph', styleName: 'Body', alignment: 'start', runs: [{ id: id(10), text: 'Revenue grew with evidence.', style: style(), href: 'https://example.com/evidence' }] },
        { id: id(11), kind: 'table', headerRows: 1, rows: [
          { id: id(12), cells: [{ id: id(13), runs: [{ id: id(14), text: 'Metric', style: { ...style(), bold: true } }], rowSpan: 1, colSpan: 1 }, { id: id(15), runs: [{ id: id(16), text: 'Value', style: { ...style(), bold: true } }], rowSpan: 1, colSpan: 1 }] },
          { id: id(17), cells: [{ id: id(18), runs: [{ id: id(19), text: 'ARR', style: style() }], rowSpan: 1, colSpan: 1 }, { id: id(20), runs: [{ id: id(21), text: '$2m', style: style() }], rowSpan: 1, colSpan: 1 }] },
        ] },
      ],
    }],
  }
}

export function presentationSnapshot(): PresentationSnapshot {
  const masterId = id(30)
  const layoutId = id(31)
  return {
    schemaVersion: 1,
    capabilityVersion: 1,
    artifactId: id(22),
    workspaceId: id(2),
    family: 'presentation',
    locale: 'en-US',
    defaultLanguage: 'en-US',
    templateVersionId: id(3),
    rootId: id(23),
    title: 'Pitch',
    resources: [],
    accessibility: { title: 'Pitch' },
    slideSize: { widthPt: 960, heightPt: 540 },
    themeId: id(29),
    masters: [{ id: masterId, name: 'Master', lockedObjectIds: [] }],
    layouts: [{ id: layoutId, masterId, name: 'Title', placeholderIds: [] }],
    slides: [{
      id: id(32), title: 'Opening', masterId, layoutId, notes: [{ id: id(33), text: 'Introduce the company.', style: style() }],
      objects: [
        { id: id(34), kind: 'text', geometry: { xPt: 72, yPt: 60, widthPt: 816, heightPt: 90, rotationDeg: 0 }, locked: false, alignment: 'start', verticalAlignment: 'top', runs: [{ id: id(35), text: 'A dependable pitch', style: { ...style(36), bold: true } }] },
        { id: id(36), kind: 'shape', shape: 'roundedRectangle', geometry: { xPt: 72, yPt: 190, widthPt: 360, heightPt: 120, rotationDeg: 0 }, locked: false, fill: '#EAF2FF', stroke: '#3366CC', strokeWidthPt: 1, text: [{ id: id(37), text: 'Platform owned', style: style(20) }], altText: 'Platform ownership statement' },
        { id: id(38), kind: 'chart', chartType: 'bar', title: 'Growth', categories: ['Q1', 'Q2'], series: [{ name: 'ARR', values: [1, 2] }], altText: 'ARR doubled', geometry: { xPt: 480, yPt: 190, widthPt: 390, heightPt: 240, rotationDeg: 0 }, locked: false },
      ],
      readingOrder: [id(34), id(36), id(38)],
    }],
  }
}

export function templateBundle(family: 'document' | 'presentation' = 'document'): OfficeTemplateBundle {
  const snapshot = family === 'document' ? documentSnapshot() : presentationSnapshot()
  const targetId = family === 'document' ? id(9) : id(34)
  return {
    id: id(family === 'document' ? 40 : 41),
    workspaceId: id(2),
    family,
    version: 1,
    status: 'draft',
    name: family === 'document' ? 'Board update' : 'Pitch',
    description: 'A grounded company template',
    tags: ['company'],
    locales: ['en-US'],
    whenToUse: ['Use for company updates'],
    whenNotToUse: ['Do not use for legal agreements'],
    exampleRequests: ['Create a board update'],
    fields: [{ id: id(42), name: 'summary.text', label: 'Summary', type: 'richText', required: true, repeating: false, minItems: 0, maxItems: 1, maxLength: 1_000, targetIds: [targetId], aiInstruction: 'Ground every factual statement.', locked: false }],
    snapshot,
    resources: [],
    lockedObjectIds: [],
    allowedRepeatTargetIds: [],
    requiredEvidence: ['company facts'],
    sensitivity: 'internal',
    visibilityUserIds: [],
    capabilityVersion: 1,
    sourceHash: 'a'.repeat(64),
  }
}
