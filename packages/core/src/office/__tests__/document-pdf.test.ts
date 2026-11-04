import { PDFDocument, PDFName, PDFArray, PDFRawStream, degrees } from '@cantoo/pdf-lib'
import { describe, expect, it, vi } from 'vitest'
import { layoutOfficeArtifact } from '@use-brian/office-renderer'
import { convertDocumentDocxToPdf, exportOfficeDocumentPdf } from '../docx/pdf.js'
import { LibreOfficeError } from '../../files/libreoffice.js'
import { documentSnapshot, resolveFixtureResource, officePdfFixture, id } from './fixtures.js'

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
    const pdf = await officePdfFixture()
    const expectedPageCount = layoutOfficeArtifact(snapshot).pages.length
    const result = await exportOfficeDocumentPdf(snapshot, resolveFixtureResource, { convert: async () => pdf, pageCount: async () => expectedPageCount })
    expect(result).toMatchObject({ bytes: pdf, mime: 'application/pdf', receipt: { expectedPageCount, actualPageCount: expectedPageCount, renderer: 'libreoffice', issues: [] } })
  })

  it('restores mixed custom canvases without rescaling their rendered content', async () => {
    const snapshot = documentSnapshot()
    snapshot.sections[0].page.widthPt = 700
    snapshot.sections[0].page.heightPt = 990.5882
    snapshot.sections.push({ ...structuredClone(snapshot.sections[0]), id: id(70), header: [], nodes: [], page: { ...snapshot.sections[0].page, widthPt: 595, heightPt: 842 } })
    const sizes = [{ widthPt: 699.9874, heightPt: 990.5953 }, { widthPt: 595.304, heightPt: 841.8898 }]
    const rendered = await officePdfFixture(sizes)
    const source = await PDFDocument.load(rendered)
    const result = await exportOfficeDocumentPdf(snapshot, resolveFixtureResource, { convert: async () => rendered, pageCount: async () => 2 })
    expect(result.receipt.issues).toEqual([])
    const pdf = await PDFDocument.load(result.bytes!)
    for (const [index, page] of pdf.getPages().entries()) {
      expect(page.getSize()).toEqual({ width: snapshot.sections[index].page.widthPt, height: snapshot.sections[index].page.heightPt })
      const box = page.getMediaBox()
      expect(box.y + box.height).toBeCloseTo(sizes[index].heightPt, 8)
      expect(page.getCropBox()).toEqual(box)
      const streams = (doc: PDFDocument, pageIndex: number) => (doc.getPage(pageIndex).node.get(PDFName.of('Contents')) as PDFArray).asArray()
        .map(ref => Array.from((doc.context.lookup(ref) as PDFRawStream).getContents()))
      expect(streams(pdf, index)).toEqual(streams(source, index))
    }
  })

  it.each(['rotated', 'cropped'] as const)('preserves a deliberately %s page', async mode => {
    const source = await PDFDocument.load(await officePdfFixture([{ widthPt: 612.3, heightPt: 791.9 }]))
    if (mode === 'rotated') source.getPage(0).setRotation(degrees(90))
    else source.getPage(0).setCropBox(10, 10, 590, 770)
    const rendered = await source.save()
    const result = await exportOfficeDocumentPdf(documentSnapshot(), resolveFixtureResource, { convert: async () => rendered, pageCount: async () => 1 })
    expect(result.bytes).toBe(rendered)
  })

  it('does not resize a converter page that differs by more than rounding', async () => {
    const rendered = await officePdfFixture([{ widthPt: 610, heightPt: 790 }])
    const result = await exportOfficeDocumentPdf(documentSnapshot(), resolveFixtureResource, { convert: async () => rendered, pageCount: async () => 1 })
    expect(result.bytes).toBe(rendered)
  })

  it('blocks a PDF whose pages diverge from the canonical layout', async () => {
    const snapshot = documentSnapshot()
    const expectedPageCount = layoutOfficeArtifact(snapshot).pages.length
    const result = await exportOfficeDocumentPdf(snapshot, resolveFixtureResource, { convert: async () => new Uint8Array([37, 80, 68, 70]), pageCount: async () => expectedPageCount + 1 })
    expect(result.bytes).toBeUndefined()
    expect(result.receipt).toMatchObject({ expectedPageCount, actualPageCount: expectedPageCount + 1, issues: [{ code: 'page_count_mismatch' }] })
  })
})
