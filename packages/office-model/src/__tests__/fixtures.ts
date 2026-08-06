import type { DocumentSnapshot, PresentationSnapshot, SpreadsheetSnapshot } from '../model.js'

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

export function spreadsheetFixture(): SpreadsheetSnapshot {
  return {
    schemaVersion: 1,
    capabilityVersion: 1,
    artifactId: id(21),
    workspaceId: id(2),
    family: 'spreadsheet',
    locale: 'en-US',
    defaultLanguage: 'en-US',
    templateVersionId: id(3),
    rootId: id(22),
    title: 'Invoice',
    resources: [],
    accessibility: { title: 'Invoice' },
    activeSheetId: id(23),
    calculationMode: 'automatic',
    worksheets: [{
      id: id(23), name: 'Invoice', visibility: 'visible',
      cells: [
        { id: id(24), address: 'A1', valueType: 'number', value: 2, style: {}, locked: false },
        { id: id(25), address: 'B1', valueType: 'number', value: 4, style: {}, locked: false },
        { id: id(26), address: 'C1', valueType: 'number', value: null, formula: 'ROUND(A1*B1,2)', calculatedValue: 8, style: {}, locked: false },
      ],
      merges: [], rowDimensions: [], columnDimensions: [], freeze: { rows: 0, columns: 0 }, images: [], validations: [], conditionalFormats: [],
      print: { printArea: 'A1:C20', paperSize: 'A4', orientation: 'portrait', fitToWidth: 1, fitToHeight: 1, margins: { leftIn: 0.35, rightIn: 0.35, topIn: 0.25, bottomIn: 0.25, headerIn: 0, footerIn: 0 }, horizontalCentered: true, verticalCentered: true, showGridLines: false, showHeadings: false },
    }],
  }
}

export { id }
