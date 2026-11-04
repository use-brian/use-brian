import { describe, expect, it, vi } from 'vitest'
import { layoutOfficeArtifact } from '@use-brian/office-renderer'
import { convertDocumentDocxToPdf, exportOfficeDocumentPdf } from '../docx/pdf.js'
import { LibreOfficeError } from '../../files/libreoffice.js'
import { documentSnapshot, resolveFixtureResource } from './fixtures.js'

describe('[COMP:office/document-pdf] Document PDF release', () => {
  it('retains the renderer cause for server diagnostics while keeping the receipt safe', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const vendor = new LibreOfficeError('converter_unavailable', { cause: 'renderer exit 77: private vendor detail' })
    try {
      const result = await exportOfficeDocumentPdf(documentSnapshot(), resolveFixtureResource, {
        convert: input => convertDocumentDocxToPdf(input, async () => { throw vendor }),
        pageCount: async () => { throw new Error('unreachable') },
      })
      expect(result.bytes).toBeUndefined()
      expect(result.receipt.issues).toEqual([{ severity: 'error', code: 'converter_unavailable', message: 'Document PDF conversion is unavailable.' }])
      expect(JSON.stringify(result)).not.toContain('private vendor detail')
      expect(log).toHaveBeenCalledWith('[office/document-pdf] conversion failed', { code: 'converter_unavailable', error: expect.objectContaining({ cause: vendor }) })
    } finally { log.mockRestore() }
  })

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
