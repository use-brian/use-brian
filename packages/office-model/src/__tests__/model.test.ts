import { describe, expect, it } from 'vitest'
import { OfficeArtifactSnapshotSchema, officeTableCellPlacements, officeTableResolvedColumnWidthsPt, type OfficeTable } from '../model.js'
import { documentFixture, presentationFixture } from './fixtures.js'

describe('[COMP:office/model] Office canonical model', () => {
  it('accepts strict document and presentation snapshots', () => {
    expect(OfficeArtifactSnapshotSchema.parse(documentFixture()).family).toBe('document')
    expect(OfficeArtifactSnapshotSchema.parse(presentationFixture()).family).toBe('presentation')
  })

  it('allows a scratch template snapshot before it has a source template version', () => {
    expect(OfficeArtifactSnapshotSchema.parse({ ...documentFixture(), templateVersionId: null }).templateVersionId).toBeNull()
  })

  it('rejects unknown fields and incomplete reading order', () => {
    expect(() => OfficeArtifactSnapshotSchema.parse({ ...documentFixture(), surprise: true })).toThrow()
    const presentation = presentationFixture()
    presentation.slides[0].readingOrder = []
    expect(() => OfficeArtifactSnapshotSchema.parse(presentation)).toThrow(/Reading order/)
  })

  it('requires safe inert hyperlink schemes', () => {
    const document = documentFixture()
    const paragraph = document.sections[0].nodes[0]
    if (paragraph.kind !== 'paragraph') throw new Error('fixture drift')
    paragraph.runs[0] = { ...paragraph.runs[0], href: 'javascript:alert(1)' }
    expect(() => OfficeArtifactSnapshotSchema.parse(document)).toThrow(/HTTPS and mailto/)
  })

  it('keeps Word table geometry, styling, and merged-cell placement canonical', () => {
    const table: OfficeTable = {
      id: '00000000-0000-4000-8000-000000000080',
      kind: 'table',
      headerRows: 1,
      columnWidthsPt: [80, 160, 80],
      widthPt: 320,
      alignment: 'center',
      layout: 'fixed',
      margins: { topPt: 2, rightPt: 4, bottomPt: 2, leftPt: 4 },
      borders: { insideVertical: { color: '#DCE9EE', widthPt: 0.5, style: 'solid' } },
      rows: [
        { id: '00000000-0000-4000-8000-000000000081', cells: [{ id: '00000000-0000-4000-8000-000000000082', runs: [], rowSpan: 2, colSpan: 2, fill: '#131A24', alignment: 'center', verticalAlignment: 'middle' }, { id: '00000000-0000-4000-8000-000000000083', runs: [], rowSpan: 1, colSpan: 1 }] },
        { id: '00000000-0000-4000-8000-000000000084', cells: [{ id: '00000000-0000-4000-8000-000000000085', runs: [], rowSpan: 1, colSpan: 1 }] },
      ],
    }

    expect(officeTableCellPlacements(table).map(({ cell, rowIndex, startColumn, endColumn }) => ({ id: cell.id, rowIndex, startColumn, endColumn }))).toEqual([
      { id: table.rows[0].cells[0].id, rowIndex: 0, startColumn: 0, endColumn: 2 },
      { id: table.rows[0].cells[1].id, rowIndex: 0, startColumn: 2, endColumn: 3 },
      { id: table.rows[1].cells[0].id, rowIndex: 1, startColumn: 2, endColumn: 3 },
    ])
    expect(officeTableResolvedColumnWidthsPt(table, 400)).toEqual([80, 160, 80])
  })
})
