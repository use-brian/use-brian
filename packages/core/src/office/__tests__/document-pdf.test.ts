import { describe, expect, it } from 'vitest'
import { layoutOfficeArtifact } from '@use-brian/office-renderer'
import { exportOfficeDocumentPdf } from '../docx/pdf.js'
import { documentSnapshot, resolveFixtureResource } from './fixtures.js'

describe('[COMP:office/document-pdf] Document PDF release', () => {
  it('converts the canonical DOCX and validates its page count', async () => {
    const snapshot = documentSnapshot()
    const pdf = new Uint8Array([37, 80, 68, 70])
    const expectedPageCount = layoutOfficeArtifact(snapshot).pages.length
    const result = await exportOfficeDocumentPdf(snapshot, resolveFixtureResource, { convert: async () => pdf, pageCount: async () => expectedPageCount })
    expect(result).toMatchObject({ bytes: pdf, mime: 'application/pdf', receipt: { expectedPageCount, actualPageCount: expectedPageCount, renderer: 'libreoffice', issues: [] } })
  })

  it('blocks a PDF whose pages diverge from the canonical layout', async () => {
    const snapshot = documentSnapshot()
    const expectedPageCount = layoutOfficeArtifact(snapshot).pages.length
    const result = await exportOfficeDocumentPdf(snapshot, resolveFixtureResource, { convert: async () => new Uint8Array([37, 80, 68, 70]), pageCount: async () => expectedPageCount + 1 })
    expect(result.bytes).toBeUndefined()
    expect(result.receipt).toMatchObject({ expectedPageCount, actualPageCount: expectedPageCount + 1, issues: [{ code: 'page_count_mismatch' }] })
  })
})
