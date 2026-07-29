/**
 * A hand-rolled, renderable PDF for tests.
 *
 * It has to be a REAL PDF, not `Buffer.from('%PDF-1.4 fake')`: the distillation
 * path renders every page through pdf.js + canvas, so a fake buffer fails at
 * `getDocumentProxy` long before any assertion about model calls is reached.
 * pdf.js reconstructs the xref table, so no offset table is needed.
 */

/** N pages, each carrying one line of text in its content stream. */
export function minimalPdf(pageCount = 1, text = 'Hello PDF World'): Buffer {
  const pageObj = (i: number) => 4 + i * 2
  const contentObj = (i: number) => 5 + i * 2
  const kids = Array.from({ length: pageCount }, (_, i) => `${pageObj(i)} 0 R`).join(' ')

  let body =
    `1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n` +
    `2 0 obj\n<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>\nendobj\n` +
    `3 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n`

  for (let i = 0; i < pageCount; i++) {
    const line = pageCount > 1 ? `${text} ${i + 1}` : text
    const content = `BT /F1 24 Tf 72 700 Td (${line}) Tj ET`
    body +=
      `${pageObj(i)} 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]` +
      `/Contents ${contentObj(i)} 0 R/Resources<</Font<</F1 3 0 R>>>>>>\nendobj\n` +
      `${contentObj(i)} 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`
  }

  const size = 4 + pageCount * 2
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<</Root 1 0 R/Size ${size}>>\n%%EOF`, 'latin1')
}
