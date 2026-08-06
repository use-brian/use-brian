import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { exportOfficeDocument, importOfficeDocument, reparseOfficeDocument } from '../docx/index.js'
import { completeDocumentSnapshot, id, resolveFixtureResource } from './fixtures.js'

describe('[COMP:office/docx-engine] DOCX engine', () => {
  it('exports, safely reparses, and preserves canonical semantics plus layout', async () => {
    const source = completeDocumentSnapshot()
    const exported = await exportOfficeDocument(source, resolveFixtureResource)
    const imported = await importOfficeDocument(exported.bytes, { artifactId: source.artifactId, workspaceId: source.workspaceId, templateVersionId: source.templateVersionId, locale: source.locale, defaultLanguage: source.defaultLanguage, title: source.title })
    const reopened = await reparseOfficeDocument(exported.bytes)
    expect(imported.ok).toBe(true)
    expect(imported.snapshot).toEqual(source)
    expect(reopened.snapshot).toEqual(source)
    expect(reopened.semanticHash).toBe(exported.semanticHash)
    expect(reopened.layoutSerialization).toBe(exported.layoutSerialization)
    const zip = await JSZip.loadAsync(exported.bytes)
    expect(zip.file('word/document.xml')).not.toBeNull()
    expect(zip.file('customXml/brian-office.json')).not.toBeNull()
  })

  it('normalizes a conventional external DOCX and never partially admits active content', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('word/document.xml', '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello Office</w:t></w:r></w:p></w:body></w:document>')
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const result = await importOfficeDocument(bytes, { artifactId: id(60), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Imported' })
    expect(result.ok).toBe(true)
    expect(result.snapshot?.family).toBe('document')

    zip.file('word/vbaProject.bin', Buffer.from('macro'))
    const rejected = await importOfficeDocument(await zip.generateAsync({ type: 'nodebuffer' }), { artifactId: id(61), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Rejected' })
    expect(rejected.ok).toBe(false)
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ code: 'package.active_content' }))
  })

  it('preserves conventional Word table grids, merged cells, fills, borders, margins, and alignment', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('word/document.xml', `<w:document xmlns:w="w"><w:body><w:tbl>
      <w:tblPr><w:tblW w:w="6400" w:type="dxa"/><w:jc w:val="center"/><w:tblInd w:w="120" w:type="dxa"/><w:tblLayout w:type="fixed"/>
        <w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:start w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:end w:w="80" w:type="dxa"/></w:tblCellMar>
        <w:tblBorders><w:top w:val="single" w:sz="5" w:color="DCE9EE"/><w:start w:val="single" w:sz="5" w:color="DCE9EE"/><w:bottom w:val="single" w:sz="9" w:color="34D3FF"/><w:end w:val="single" w:sz="5" w:color="DCE9EE"/><w:insideH w:val="single" w:sz="5" w:color="DCE9EE"/><w:insideV w:val="single" w:sz="5" w:color="DCE9EE"/></w:tblBorders>
      </w:tblPr>
      <w:tblGrid><w:gridCol w:w="1600"/><w:gridCol w:w="3200"/><w:gridCol w:w="1600"/></w:tblGrid>
      <w:tr><w:trPr><w:tblHeader/><w:trHeight w:val="360" w:hRule="atLeast"/></w:trPr>
        <w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:fill="131A24"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New"/><w:b/><w:color w:val="34D3FF"/><w:sz w:val="15"/></w:rPr><w:t>INVOICE</w:t></w:r></w:p></w:tc>
        <w:tc><w:tcPr><w:shd w:fill="E8F8FC"/></w:tcPr><w:p><w:r><w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="17"/></w:rPr><w:t>INV-001</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/><w:shd w:fill="131A24"/></w:tcPr><w:p><w:r><w:t>TOTAL</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:fill="E8F8FC"/></w:tcPr><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>100.00</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:fill="34D3FF"/></w:tcPr><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:b/><w:t>BALANCE 100.00</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`)

    const result = await importOfficeDocument(await zip.generateAsync({ type: 'nodebuffer' }), { artifactId: id(80), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Styled invoice' })
    expect(result.ok).toBe(true)
    expect(result.snapshot?.family).toBe('document')
    if (result.snapshot?.family !== 'document') throw new Error('Expected document')
    const table = result.snapshot.sections[0].nodes[0]
    expect(table).toMatchObject({ kind: 'table', headerRows: 1, columnWidthsPt: [80, 160, 80], widthPt: 320, alignment: 'center', indentPt: 6, layout: 'fixed', margins: { topPt: 2, rightPt: 4, bottomPt: 2, leftPt: 4 }, borders: { bottom: { color: '#34D3FF', widthPt: 1.125, style: 'solid' } } })
    if (table.kind !== 'table') throw new Error('Expected table')
    expect(table.rows[0].minHeightPt).toBe(18)
    expect(table.rows[0].cells[0]).toMatchObject({ colSpan: 2, fill: '#131A24', alignment: 'center', verticalAlignment: 'middle', runs: [expect.objectContaining({ style: expect.objectContaining({ fontFamily: 'Courier New', fontSizePt: 7.5, bold: true, color: '#34D3FF' }) })] })
    expect(table.rows[1].cells[0]).toMatchObject({ rowSpan: 2, fill: '#131A24' })
    expect(table.rows[2].cells).toHaveLength(1)
    expect(table.rows[2].cells[0]).toMatchObject({ colSpan: 2, fill: '#34D3FF', alignment: 'end' })

    const exported = await exportOfficeDocument(result.snapshot)
    const exportedXml = await (await JSZip.loadAsync(exported.bytes)).file('word/document.xml')!.async('string')
    expect(exportedXml).toContain('w:w="1600"')
    expect(exportedXml).toContain('w:fill="131A24"')
    expect(exportedXml).toContain('w:gridSpan w:val="2"')
    expect(exportedXml).toContain('w:vMerge w:val="restart"')
    expect(exportedXml).toContain('w:tblHeader')
  })

  it('preserves conventional letterhead geometry, typography, logo, and rules through canonical export', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('word/document.xml', `<w:document xmlns:w="w" xmlns:r="r"><w:body>
      <w:p><w:pPr><w:pStyle w:val="LetterDate"/><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="19"/></w:rPr><w:t>{{LETTER_DATE}}</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="LetterSubject"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial"/><w:b/><w:color w:val="10202C"/><w:sz w:val="21"/></w:rPr><w:t>{{SUBJECT}}</w:t></w:r></w:p>
      <w:sectPr><w:titlePg/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2268" w:right="1247" w:bottom="1361" w:left="1247"/><w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="first" r:id="rFooterFirst"/><w:footerReference w:type="default" r:id="rFooterDefault"/></w:sectPr>
    </w:body></w:document>`)
    zip.file('word/styles.xml', `<w:styles xmlns:w="w">
      <w:style w:type="paragraph" w:styleId="LetterDate"><w:pPr><w:spacing w:before="0" w:after="320" w:line="240"/></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="LetterSubject"><w:pPr><w:spacing w:before="260" w:after="200" w:line="240"/></w:pPr></w:style>
    </w:styles>`)
    zip.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rHeader" Target="header1.xml"/><Relationship Id="rFooterFirst" Target="footer1.xml"/><Relationship Id="rFooterDefault" Target="footer2.xml"/></Relationships>')
    zip.file('word/header1.xml', '<w:hdr xmlns:w="w" xmlns:r="r" xmlns:a="a" xmlns:wp="wp"><w:tbl><w:tblPr><w:tblBorders><w:bottom w:val="single" w:sz="12" w:color="34D3FF"/></w:tblBorders></w:tblPr><w:tr><w:tc><w:p><w:r><w:drawing><wp:inline><wp:extent cx="270000" cy="270000"/><wp:docPr descr="Company logo"/><a:blip r:embed="rImage"/></wp:inline></w:drawing></w:r></w:p></w:tc><w:tc><w:p><w:r><w:rPr><w:rFonts w:ascii="Arial"/><w:b/><w:color w:val="10202C"/><w:sz w:val="25"/></w:rPr><w:t>Use Brian</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:hdr>')
    zip.file('word/_rels/header1.xml.rels', '<Relationships><Relationship Id="rImage" Target="media/logo.png"/></Relationships>')
    const logo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=', 'base64')
    zip.file('word/media/logo.png', logo)
    zip.file('word/footer1.xml', '<w:ftr xmlns:w="w"><w:p><w:pPr><w:jc w:val="left"/></w:pPr></w:p><w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="6" w:color="DCE9EE"/></w:tblBorders></w:tblPr><w:tr><w:tc><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New"/><w:b/><w:color w:val="0EA5E9"/><w:sz w:val="15"/></w:rPr><w:t>USEBRIAN.AI</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:ftr>')
    zip.file('word/footer2.xml', '<w:ftr xmlns:w="w"><w:p><w:r><w:t>PAGE 2</w:t></w:r></w:p></w:ftr>')
    const result = await importOfficeDocument(await zip.generateAsync({ type: 'nodebuffer' }), { artifactId: id(70), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Letterhead' })
    expect(result.ok).toBe(true)
    expect(result.resources).toHaveLength(1)
    expect(result.snapshot?.family).toBe('document')
    if (result.snapshot?.family !== 'document') throw new Error('Expected document')
    const section = result.snapshot.sections[0]
    expect(section.page).toMatchObject({ widthPt: 595.3, heightPt: 841.9, marginTopPt: 113.4, marginLeftPt: 62.35 })
    expect(section.header.map((run) => run.text).join('')).toBe('Use Brian')
    expect(section.headerImage).toMatchObject({ altText: 'Company logo' })
    expect(section.headerImage?.widthPt).toBeCloseTo(21.26, 1)
    expect(section.headerBorderBottom).toEqual({ color: '#34D3FF', widthPt: 1.5 })
    expect(section.footer.map((run) => run.text).join('')).toBe('USEBRIAN.AI')
    expect(section.footerAlignment).toBe('end')
    expect(section.footerBorderTop).toEqual({ color: '#DCE9EE', widthPt: 0.75 })
    expect(section.nodes[0]).toMatchObject({ kind: 'paragraph', alignment: 'end', styleName: 'LetterDate', spacingAfterPt: 16, lineSpacingPt: 12, runs: [expect.objectContaining({ style: expect.objectContaining({ fontFamily: 'Arial', fontSizePt: 9.5 }) })] })
    expect(section.nodes[1]).toMatchObject({ kind: 'paragraph', styleName: 'LetterSubject', spacingBeforePt: 13, spacingAfterPt: 10, lineSpacingPt: 12, runs: [expect.objectContaining({ style: expect.objectContaining({ bold: true, color: '#10202C', fontSizePt: 10.5 }) })] })
    const resource = result.resources[0]
    const exported = await exportOfficeDocument(result.snapshot, async (resourceId) => resourceId === resource.ref.id ? { bytes: resource.bytes, mime: resource.ref.mime } : null)
    const exportedZip = await JSZip.loadAsync(exported.bytes)
    const exportedXml = await exportedZip.file('word/document.xml')!.async('string')
    expect(exportedXml).toContain('w:after="320"')
    expect(exportedXml).not.toContain('w:pStyle w:val="LetterDate"')
    const reopened = await reparseOfficeDocument(exported.bytes)
    expect(reopened.snapshot).toEqual(result.snapshot)
  })
})
