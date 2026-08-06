import { describe, expect, it } from 'vitest'
import type { DocumentSnapshot, PresentationSnapshot, SpreadsheetSnapshot } from '@use-brian/office-model'
import { fitOfficeArtifact, layoutOfficeArtifact, officeGoldenSerialization, renderOfficePreviewSvg, type OfficeDisplayPage } from '../layout.js'

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

  it('checks rendered text ink instead of rejecting adjacent overlapping boxes', () => {
    const snapshot: PresentationSnapshot = { schemaVersion: 1, capabilityVersion: 1, artifactId: id(71), workspaceId: id(2), family: 'presentation', locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: null, rootId: id(72), title: 'Deck', resources: [], accessibility: { title: 'Deck' }, slideSize: { widthPt: 300, heightPt: 200 }, themeId: id(73), masters: [{ id: id(74), name: 'Master', lockedObjectIds: [] }], layouts: [{ id: id(75), masterId: id(74), name: 'Layout', placeholderIds: [] }], slides: [{ id: id(76), title: 'Slide', masterId: id(74), layoutId: id(75), notes: [], objects: [
      { id: id(77), kind: 'text', geometry: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 30, rotationDeg: 0 }, locked: false, alignment: 'start', verticalAlignment: 'top', runs: [{ id: id(78), text: 'Left', style }] },
      { id: id(79), kind: 'text', geometry: { xPt: 90, yPt: 20, widthPt: 100, heightPt: 30, rotationDeg: 0 }, locked: false, alignment: 'end', verticalAlignment: 'top', runs: [{ id: id(80), text: 'Right', style }] },
    ], readingOrder: [id(77), id(79)] }] }
    expect(layoutOfficeArtifact(snapshot).issues).not.toContainEqual(expect.objectContaining({ code: 'collision' }))
  })

  it('uses the display list for browser preview/goldens and refuses degraded fit', () => {
    const snapshot: DocumentSnapshot = { schemaVersion: 1, capabilityVersion: 1, artifactId: id(61), workspaceId: id(2), family: 'document', locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: id(3), rootId: id(62), title: 'Fit', resources: [], accessibility: { title: 'Fit' }, sections: [{ id: id(63), page: { widthPt: 300, heightPt: 200, marginTopPt: 20, marginRightPt: 20, marginBottomPt: 20, marginLeftPt: 20, orientation: 'portrait' }, header: [], footer: [], showPageNumber: false, nodes: [{ id: id(64), kind: 'paragraph', styleName: 'Body', alignment: 'start', runs: [{ id: id(65), text: 'Long enough to violate a compiled field budget', style }] }] }] }
    const fit = fitOfficeArtifact(snapshot, { maxPages: 1, maxTextCharsByObject: { [id(65)]: 10 }, minimumFontSizePt: 10 })
    expect(fit.ok).toBe(false)
    expect(fit.issues).toContainEqual(expect.objectContaining({ objectId: id(65), code: 'overflow' }))
    expect(renderOfficePreviewSvg(fit.result.pages[0])).toContain(`data-office-object="${id(64)}"`)
    expect(officeGoldenSerialization(snapshot)).toContain('"family":"document"')
  })

  it('renders document typography, table cells, and resolved images without placeholder labels', () => {
    const page: OfficeDisplayPage = {
      id: id(90),
      widthPt: 300,
      heightPt: 200,
      primitives: [
        { id: id(91), kind: 'image', xPt: 10, yPt: 10, widthPt: 30, heightPt: 20, resourceId: id(92), z: 0 },
        { id: id(93), kind: 'text', xPt: 45, yPt: 10, widthPt: 100, heightPt: 20, text: 'Use Brian', runs: [{ id: id(94), text: 'Use Brian', style: { ...style, fontSizePt: 9, bold: true } }], z: 1 },
        { id: id(95), kind: 'table', xPt: 10, yPt: 40, widthPt: 200, heightPt: 40, tableHeaderRows: 1, tableRows: [[{ runs: [{ id: id(96), text: 'Description', style }], rowSpan: 1, colSpan: 1 }]], documentTable: { id: id(95), kind: 'table', headerRows: 1, columnWidthsPt: [70, 130], widthPt: 200, layout: 'fixed', margins: { topPt: 2, rightPt: 4, bottomPt: 2, leftPt: 4 }, borders: { bottom: { color: '#34D3FF', widthPt: 1.125, style: 'solid' }, insideVertical: { color: '#DCE9EE', widthPt: 0.625, style: 'solid' } }, rows: [{ id: id(98), minHeightPt: 18, cells: [{ id: id(96), runs: [{ id: id(99), text: 'Description', style: { ...style, fontFamily: 'Courier New', fontSizePt: 7.5, bold: true, color: '#34D3FF' } }], rowSpan: 1, colSpan: 2, fill: '#131A24', alignment: 'center', verticalAlignment: 'middle', wrapText: true }] }] }, z: 2 },
        { id: id(97), kind: 'line', xPt: 10, yPt: 90, widthPt: 200, heightPt: 0, strokeColor: '#34D3FF', strokeWidthPt: 1.5, z: 3 },
      ],
    }
    const svg = renderOfficePreviewSvg(page, { resourceUrls: { [id(92)]: 'blob:http://localhost/logo' } })

    expect(svg).toContain('<image ')
    expect(svg).toContain('href="blob:http://localhost/logo"')
    expect(svg).toContain('font-size:9px')
    expect(svg).toContain('Description')
    expect(svg).toContain('data-office-table-cell="00000000-0000-4000-8000-000000000096"')
    expect(svg).toContain('colspan="2"')
    expect(svg).toContain('width:35%')
    expect(svg).toContain('background:#131A24')
    expect(svg).toContain('border-bottom:1.125px solid #34D3FF')
    expect(svg).toContain('font-family:Courier New')
    expect(svg).toContain('font-size:7.5px')
    expect(svg).toContain('stroke:#34D3FF;stroke-width:1.5')
    expect(svg).not.toContain('>Image<')
    expect(svg).not.toContain('>Table<')
  })

  it('preserves spreadsheet styling, merged geometry, conditional formatting, and images in previews', () => {
    const sheetId = id(101)
    const imageResourceId = id(102)
    const snapshot: SpreadsheetSnapshot = {
      schemaVersion: 1,
      capabilityVersion: 1,
      artifactId: id(103),
      workspaceId: id(2),
      family: 'spreadsheet',
      locale: 'en-US',
      defaultLanguage: 'en-US',
      templateVersionId: id(3),
      rootId: id(104),
      title: 'Invoice',
      resources: [{ id: imageResourceId, kind: 'image', hash: 'a'.repeat(64), mime: 'image/png', sensitivity: 'internal' }],
      accessibility: { title: 'Invoice' },
      activeSheetId: sheetId,
      calculationMode: 'automatic',
      worksheets: [{
        id: sheetId,
        name: 'Invoice',
        visibility: 'visible',
        cells: [
          { id: id(105), address: 'A1', valueType: 'string', value: 'Use Brian', style: { font: { family: 'Courier New', sizePt: 9, bold: true, italic: false, underline: false, strike: false, color: '#FFFFFF' }, fill: '#10202C', border: { bottom: { style: 'thick', color: '#34D3FF' } }, alignment: { horizontal: 'center', vertical: 'middle', wrapText: false, textRotation: 0, indent: 0 } }, locked: false },
          { id: id(106), address: 'B1', valueType: 'string', value: 'Use Brian', style: {}, locked: false },
          { id: id(107), address: 'A2', valueType: 'number', value: -1, numberFormat: '0', style: {}, locked: false },
        ],
        merges: ['A1:B1'],
        rowDimensions: [{ index: 1, heightPt: 26, hidden: false }],
        columnDimensions: [{ index: 1, widthChars: 24, hidden: false }, { index: 2, widthChars: 14, hidden: false }],
        freeze: { rows: 0, columns: 0 },
        images: [{ id: id(108), resourceId: imageResourceId, altText: '', decorative: true, from: { row: 1.2, column: 0.1 }, to: { row: 2, column: 0.5 } }],
        validations: [],
        conditionalFormats: [{ id: id(109), range: 'A2', ruleType: 'cellIs', operator: 'lessThan', formulas: ['0'], style: { font: { family: 'Arial', sizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#DC2626' } }, priority: 1 }],
        print: { paperSize: 'A4', orientation: 'portrait', fitToWidth: 1, fitToHeight: 1, margins: { leftIn: 0.7, rightIn: 0.7, topIn: 0.75, bottomIn: 0.75, headerIn: 0.3, footerIn: 0.3 }, horizontalCentered: false, verticalCentered: false, showGridLines: false, showHeadings: false },
      }],
    }

    const page = layoutOfficeArtifact(snapshot).pages[0]
    expect(page.primitives.filter((primitive) => primitive.sourceKind === 'cell')).toHaveLength(2)
    expect(page.primitives.find((primitive) => primitive.id === id(105))).toMatchObject({ widthPt: 207, heightPt: 26, spreadsheetStyle: { fill: '#10202C' } })
    expect(page.primitives.find((primitive) => primitive.id === id(107))).toMatchObject({ spreadsheetStyle: { font: { color: '#DC2626' } } })

    const svg = renderOfficePreviewSvg(page, { resourceUrls: { [imageResourceId]: 'blob:http://localhost/logo' } })
    expect(svg).toContain('background-color:#10202C')
    expect(svg).toContain('font-family:Courier New,sans-serif')
    expect(svg).toContain('font-weight:700')
    expect(svg).toContain('border-bottom:2px solid #34D3FF')
    expect(svg).toContain('color:#DC2626')
    expect(svg).toContain('href="blob:http://localhost/logo"')
    expect(svg).not.toContain(`data-office-object="${id(106)}"`)
  })
})
