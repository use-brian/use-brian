import { describe, expect, it } from 'vitest'
import { OfficeArtifactSnapshotSchema, officeTableCellPlacements, officeTableResolvedColumnWidthsPt, type OfficeTable } from '../model.js'
import { preflightOfficeCandidate } from '../capabilities.js'
import { snapshotToYDoc, yDocToSnapshot } from '../collab.js'
import { documentFixture, id, presentationFixture } from './fixtures.js'

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
    for (const href of ['http://example.com', 'https://example.com', 'mailto:writer@example.com']) {
      paragraph.runs[0] = { ...paragraph.runs[0], href }
      expect(() => OfficeArtifactSnapshotSchema.parse(document)).not.toThrow()
    }
    for (const href of ['javascript:alert(1)', 'file:///tmp/reference', 'data:text/plain,reference']) {
      paragraph.runs[0] = { ...paragraph.runs[0], href }
      expect(() => OfficeArtifactSnapshotSchema.parse(document)).toThrow(/HTTP, HTTPS and mailto/)
    }
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

describe('[COMP:office/model] exact Presentation reading order', () => {
  it.each([
    ['duplicate', [id(17), id(17)]],
    ['missing', [id(17)]],
    ['unknown', [id(17), id(999)]],
    ['extra', [id(17), id(42), id(42)]],
  ] as const)('refuses a %s order through public snapshot and preflight admission', (_kind, order) => {
    const snapshot = presentationFixture()
    snapshot.slides[0].objects.push({ id: id(42), kind: 'shape', shape: 'rectangle', geometry: { ...snapshot.slides[0].objects[0].geometry }, locked: false, strokeWidthPt: 1, text: [] })
    snapshot.slides[0].readingOrder = [...order]
    const before = structuredClone(snapshot)
    const parsed = OfficeArtifactSnapshotSchema.safeParse(snapshot)
    const preflight = preflightOfficeCandidate(snapshot)
    let admittedDoc: ReturnType<typeof snapshotToYDoc> | undefined
    let rejection: unknown
    try { admittedDoc = snapshotToYDoc(snapshot) } catch (error) { rejection = error }
    const yDocAccepted = admittedDoc !== undefined
    admittedDoc?.destroy()
    expect({ schemaAccepted: parsed.success, preflightAccepted: preflight.ok, yDocAccepted }).toEqual({
      schemaAccepted: false, preflightAccepted: false, yDocAccepted: false,
    })
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toMatch(/Reading order/)
    expect(snapshot).toEqual(before)
  })

  it('preserves a valid reversed order independently of visual stacking through a real Y.Doc', () => {
    const snapshot = presentationFixture()
    snapshot.slides[0].objects.push({ id: id(42), kind: 'shape', shape: 'rectangle', geometry: { ...snapshot.slides[0].objects[0].geometry }, locked: false, strokeWidthPt: 1, text: [] })
    snapshot.slides[0].readingOrder = [id(42), id(17)]
    expect(OfficeArtifactSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(preflightOfficeCandidate(snapshot).ok).toBe(true)
    const doc = snapshotToYDoc(snapshot)
    try {
      const restored = yDocToSnapshot(doc)
      expect(restored).toEqual(snapshot)
      expect(restored.family === 'presentation' && restored.slides[0].objects.map(object => object.id)).toEqual([id(17), id(42)])
      expect(restored.family === 'presentation' && restored.slides[0].readingOrder).toEqual([id(42), id(17)])
    } finally { doc.destroy() }
  })
})
