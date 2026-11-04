import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { layoutOfficeArtifact } from '@use-brian/office-renderer'
import { exportOfficeDocument, importOfficeDocument } from '../docx/index.js'
import { id } from './fixtures.js'

const context = { artifactId: id(60), workspaceId: id(2), templateVersionId: null, locale: 'en-US', defaultLanguage: 'en-US', title: 'Mixed sections' }

describe('[COMP:office/docx-engine] DOCX sections', () => {
  it('retains mixed pages, inherited and cleared footers, and an empty final section in native XML', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    const section = (width: number, height: number, refs = '') => `<w:sectPr>${refs}<w:pgSz w:w="${width * 20}" w:h="${height * 20}"/><w:pgMar w:top="1400" w:right="1200" w:bottom="900" w:left="1000" w:header="0" w:footer="700"/></w:sectPr>`
    const ref = (name: string) => `<w:footerReference w:type="default" r:id="${name}"/>`
    zip.file('word/document.xml', `<w:document xmlns:w="w" xmlns:r="r"><w:body>
      <w:p><w:r><w:t>Quotation</w:t></w:r></w:p><w:p><w:pPr>${section(700, 990.6, ref('one'))}</w:pPr></w:p>
      <w:p><w:r><w:t>Invoice</w:t></w:r><w:pPr>${section(595, 842)}</w:pPr></w:p>
      <w:p><w:pPr>${section(595, 842, ref('empty'))}</w:pPr></w:p>
      ${section(595, 842, ref('two'))}
    </w:body></w:document>`)
    zip.file('word/_rels/document.xml.rels', `<Relationships>${['one', 'empty', 'two'].map(name => `<Relationship Id="${name}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="${name}.xml"/>`).join('')}</Relationships>`)
    zip.file('word/one.xml', '<w:ftr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>1</w:t></w:r></w:p></w:ftr>')
    zip.file('word/empty.xml', '<w:ftr><w:p/></w:ftr>')
    zip.file('word/two.xml', '<w:ftr><w:p><w:r><w:t>2</w:t></w:r></w:p></w:ftr>')
    const imported = await importOfficeDocument(await zip.generateAsync({ type: 'nodebuffer' }), context)
    expect(imported.ok, JSON.stringify(imported.diagnostics)).toBe(true)
    if (imported.snapshot?.family !== 'document') throw new Error('document required')
    const snapshot = imported.snapshot
    expect(snapshot.sections.map(section => [section.page.widthPt, section.page.heightPt])).toEqual([[700, 990.6], [595, 842], [595, 842], [595, 842]])
    expect(snapshot.sections.map(section => section.nodes.length)).toEqual([1, 1, 0, 0])
    expect(snapshot.sections.map(section => section.footer.map(run => run.text).join(''))).toEqual(['1', '1', '', '2'])
    expect(snapshot.sections[0].page).toMatchObject({ headerDistancePt: 0, footerDistancePt: 35 })
    const layout = layoutOfficeArtifact(snapshot)
    expect(layout.pages).toHaveLength(4)
    expect(layout.pages[0].primitives.find(p => p.sourceKind === 'footer')?.yPt).toBeLessThan(990.6 - 35)
    const native = await JSZip.loadAsync((await exportOfficeDocument(snapshot)).bytes)
    const xml = await native.file('word/document.xml')!.async('string')
    expect(xml.match(/<w:sectPr\b/g)).toHaveLength(4)
    expect(xml).toContain('w:footer="700"')
    native.remove('customXml/brian-office.json')
    const reopened = await importOfficeDocument(await native.generateAsync({ type: 'nodebuffer' }), context)
    expect(reopened.ok, JSON.stringify(reopened.diagnostics)).toBe(true)
    if (reopened.snapshot?.family !== 'document') throw new Error('document required')
    expect(reopened.snapshot.sections.map(section => [section.page.widthPt, section.page.heightPt])).toEqual(snapshot.sections.map(section => [section.page.widthPt, section.page.heightPt]))
    expect(reopened.snapshot.sections.map(section => section.footer.map(run => run.text).join(''))).toEqual(['1', '1', '', '2'])
  })
})
