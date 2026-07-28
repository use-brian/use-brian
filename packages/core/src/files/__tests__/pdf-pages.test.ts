import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { renderPdfPages } from '../pdf-pages.js'

function minimalPdf(text = 'Hello PDF World'): Buffer {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`
  const body =
    `1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n` +
    `2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n` +
    `3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>\nendobj\n` +
    `4 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n` +
    `5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n`
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<</Root 1 0 R/Size 6>>\n%%EOF`, 'latin1')
}

describe('[COMP:files/pdf-pages] renderPdfPages', () => {
  it('renders a PDF page as a bounded JPEG', async () => {
    const result = await renderPdfPages(minimalPdf(), { maxPages: 1, width: 306 })

    expect(result.totalPages).toBe(1)
    expect(result.truncated).toBe(false)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]).toMatchObject({ pageNumber: 1, mime: 'image/jpeg' })
    expect(result.pages[0].buffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))

    const metadata = await sharp(result.pages[0].buffer).metadata()
    expect(metadata).toMatchObject({ format: 'jpeg', width: 306, height: 396 })
  })
})
