import type { DocumentSnapshot, OfficeTemplateBundle, PresentationSnapshot, SpreadsheetSnapshot } from '@use-brian/office-model'
import type { OfficeResourceResolver } from '../package.js'

export const id = (value: number): string => `10000000-0000-4000-8000-${value.toString().padStart(12, '0')}`
const style = (fontSizePt = 11) => ({ fontFamily: 'Arial', fontSizePt, bold: false, italic: false, underline: false, strike: false, color: '#111111' })
const imageId = id(90)
const videoId = id(91)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

export const resolveFixtureResource: OfficeResourceResolver = async (resourceId) => {
  if (resourceId === imageId) return { bytes: png, mime: 'image/png' }
  if (resourceId === videoId) return { bytes: Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), mime: 'video/mp4' }
  return null
}

const resources = [
  { id: imageId, kind: 'image' as const, hash: 'a'.repeat(64), mime: 'image/png', sensitivity: 'internal' as const },
  { id: videoId, kind: 'video' as const, hash: 'b'.repeat(64), mime: 'video/mp4', sensitivity: 'internal' as const },
]

export function completeDocumentSnapshot(): DocumentSnapshot {
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
    resources,
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
        { id: id(24), kind: 'list', ordered: true, level: 1, items: [{ id: id(25), runs: [{ id: id(26), text: 'Nested action', style: style() }] }] },
        { id: id(11), kind: 'table', headerRows: 1, rows: [
          { id: id(12), cells: [{ id: id(13), runs: [{ id: id(14), text: 'Metric', style: { ...style(), bold: true } }], rowSpan: 1, colSpan: 1 }, { id: id(15), runs: [{ id: id(16), text: 'Value', style: { ...style(), bold: true } }], rowSpan: 1, colSpan: 1 }] },
          { id: id(17), cells: [{ id: id(18), runs: [{ id: id(19), text: 'ARR', style: style() }], rowSpan: 1, colSpan: 1 }, { id: id(20), runs: [{ id: id(21), text: '$2m', style: style() }], rowSpan: 1, colSpan: 1 }] },
        ] },
        { id: id(27), kind: 'image', resourceId: imageId, altText: 'Company mark', decorative: false, widthPt: 96, heightPt: 72 },
        { id: id(28), kind: 'chart', chartType: 'bar', title: 'Revenue', categories: ['Q1', 'Q2'], series: [{ name: 'ARR', values: [1, 2] }], altText: 'ARR doubled from Q1 to Q2' },
        { id: id(43), kind: 'video', resourceId: videoId, posterResourceId: imageId, altText: 'Product demo', transcript: 'A narrated product demo.', recipientAccessibleUrl: 'https://example.com/demo' },
        { id: id(44), kind: 'pageBreak' },
        { id: id(45), kind: 'sectionBreak' },
      ],
    }],
  }
}

export function documentSnapshot(): DocumentSnapshot {
  const complete = completeDocumentSnapshot()
  return {
    ...complete,
    resources: [],
    sections: complete.sections.map((section) => ({
      ...section,
      nodes: section.nodes.filter((node) => [id(7), id(9), id(11)].includes(node.id)),
    })),
  }
}

export function completePresentationSnapshot(): PresentationSnapshot {
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
    resources,
    accessibility: { title: 'Pitch' },
    slideSize: { widthPt: 960, heightPt: 540 },
    themeId: id(29),
    masters: [{ id: masterId, name: 'Master', lockedObjectIds: [] }],
    layouts: [{ id: layoutId, masterId, name: 'Title', placeholderIds: [id(34)] }],
    slides: [{
      id: id(32), title: 'Opening', masterId, layoutId, notes: [{ id: id(33), text: 'Introduce the company.', style: style() }],
      objects: [
        { id: id(34), kind: 'text', geometry: { xPt: 36, yPt: 24, widthPt: 888, heightPt: 54, rotationDeg: 0 }, locked: false, alignment: 'start', verticalAlignment: 'top', runs: [{ id: id(35), text: 'A dependable pitch', style: { ...style(28), bold: true }, href: 'https://example.com' }] },
        { id: id(36), kind: 'shape', shape: 'roundedRectangle', geometry: { xPt: 36, yPt: 100, widthPt: 180, heightPt: 90, rotationDeg: 0 }, locked: false, fill: '#EAF2FF', stroke: '#3366CC', strokeWidthPt: 1, text: [{ id: id(37), text: 'Platform owned', style: style(16) }], altText: 'Platform ownership statement' },
        { id: id(38), kind: 'connector', connector: 'straight', fromObjectId: id(36), toObjectId: id(39), stroke: '#3366CC', geometry: { xPt: 220, yPt: 145, widthPt: 80, heightPt: 1, rotationDeg: 0 }, locked: false },
        { id: id(39), kind: 'image', resourceId: imageId, altText: 'Company mark', decorative: false, geometry: { xPt: 305, yPt: 100, widthPt: 120, heightPt: 90, rotationDeg: 0 }, locked: false },
        { id: id(46), kind: 'chart', chartType: 'bar', title: 'Growth', categories: ['Q1', 'Q2'], series: [{ name: 'ARR', values: [1, 2] }], altText: 'ARR doubled', geometry: { xPt: 445, yPt: 100, widthPt: 220, heightPt: 150, rotationDeg: 0 }, locked: false },
        { id: id(47), kind: 'table', headerRows: 1, rows: [{ id: id(48), cells: [{ id: id(49), runs: [{ id: id(50), text: 'Metric', style: style() }], rowSpan: 1, colSpan: 1 }] }], geometry: { xPt: 680, yPt: 100, widthPt: 230, heightPt: 90, rotationDeg: 0 }, locked: false },
        { id: id(51), kind: 'video', resourceId: videoId, posterResourceId: imageId, altText: 'Product demo', transcript: 'A narrated product demo.', geometry: { xPt: 36, yPt: 280, widthPt: 320, heightPt: 180, rotationDeg: 0 }, locked: false },
      ],
      readingOrder: [id(34), id(36), id(38), id(39), id(46), id(47), id(51)],
    }, {
      id: id(52), title: 'Closing', masterId, layoutId, notes: [], objects: [{ id: id(53), kind: 'text', geometry: { xPt: 72, yPt: 72, widthPt: 816, heightPt: 72, rotationDeg: 0 }, locked: false, alignment: 'center', verticalAlignment: 'middle', runs: [{ id: id(54), text: 'Thank you', style: style(32) }] }], readingOrder: [id(53)],
    }],
  }
}

export function completeSpreadsheetSnapshot(): SpreadsheetSnapshot {
  const sheetId = id(70)
  return {
    schemaVersion: 1,
    capabilityVersion: 1,
    artifactId: id(71),
    workspaceId: id(2),
    family: 'spreadsheet',
    locale: 'en-US',
    defaultLanguage: 'en-US',
    templateVersionId: id(3),
    rootId: id(72),
    title: 'Invoice',
    resources: [resources[0]],
    accessibility: { title: 'Invoice' },
    activeSheetId: sheetId,
    calculationMode: 'automatic',
    worksheets: [{
      id: sheetId,
      name: 'Invoice',
      visibility: 'visible',
      cells: [
        { id: id(73), address: 'A1', valueType: 'string', value: 'Invoice', style: { font: { family: 'Arial', sizePt: 18, bold: true, italic: false, underline: false, strike: false, color: '#10202C' }, fill: '#EAF9FF', alignment: { horizontal: 'left', vertical: 'middle', wrapText: false, textRotation: 0, indent: 0 } }, locked: false },
        { id: id(74), address: 'A2', valueType: 'number', value: 2, numberFormat: '#,##0.00', style: {}, locked: false },
        { id: id(75), address: 'B2', valueType: 'number', value: 3, numberFormat: '#,##0.00', style: {}, locked: false },
        { id: id(76), address: 'C2', valueType: 'number', value: null, formula: 'ROUND(A2*B2,2)', calculatedValue: 6, numberFormat: '#,##0.00', style: { border: { bottom: { style: 'double', color: '#10202C' } } }, locked: false },
      ],
      merges: ['A1:C1'],
      rowDimensions: [{ index: 1, heightPt: 28, hidden: false }],
      columnDimensions: [{ index: 1, widthChars: 24, hidden: false }, { index: 2, widthChars: 12, hidden: false }, { index: 3, widthChars: 14, hidden: false }],
      freeze: { rows: 1, columns: 0 },
      images: [{ id: id(77), resourceId: imageId, altText: 'Company logo', decorative: false, from: { row: 0, column: 2 }, to: { row: 1, column: 3 } }],
      validations: [{ id: id(78), range: 'A2:A10', type: 'whole', operator: 'between', formulas: ['0', '1000'], allowBlank: true }],
      conditionalFormats: [{ id: id(79), range: 'C2:C10', ruleType: 'cellIs', operator: 'greaterThan', formulas: ['0'], style: { fill: '#D1FAE5' }, priority: 1 }],
      print: { printArea: 'A1:C20', paperSize: 'A4', orientation: 'portrait', fitToWidth: 1, fitToHeight: 1, margins: { leftIn: 0.35, rightIn: 0.35, topIn: 0.25, bottomIn: 0.25, headerIn: 0, footerIn: 0 }, horizontalCentered: true, verticalCentered: true, showGridLines: false, showHeadings: false },
    }],
  }
}

function presentationSnapshot(): PresentationSnapshot {
  const complete = completePresentationSnapshot()
  const first = complete.slides[0]
  const objects = first.objects.filter((object) => [id(34), id(36), id(46)].includes(object.id))
  return {
    ...complete,
    resources: [],
    layouts: complete.layouts.map((layout) => ({ ...layout, placeholderIds: [] })),
    slides: [{ ...first, objects, readingOrder: objects.map((object) => object.id) }],
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
    slideRecipes: family === 'presentation' && snapshot.family === 'presentation' ? [{ id: id(55), slideId: snapshot.slides[0].id, name: 'Opening', role: 'cover', whenToUse: 'Use to open the presentation.', whenNotToUse: 'Do not repeat this slide.', enabled: true, repeatable: false, minUses: 0, maxUses: 1, fieldIds: [id(42)], confidence: 1, inference: 'Fixture-authored routing.', reviewed: true }] : [],
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
