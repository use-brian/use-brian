import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { applyDocumentCommand, documentRangePreimageHash, documentNumberedParagraphs, officeNumberingCounter, snapshotToYDoc, yDocToSnapshot, type DocumentSnapshot } from '@use-brian/office-model'
import { layoutOfficeArtifact, renderOfficePreviewSvg } from '@use-brian/office-renderer'
import { exportOfficeDocument, importOfficeDocument } from '../docx/index.js'
import { nineLevelNumberingFixture } from './docx-numbering-fixture.js'
import { id, documentSnapshot } from './fixtures.js'

const context = { artifactId: id(60), workspaceId: id(2), templateVersionId: null, locale: 'en-US', defaultLanguage: 'en-US', title: 'Synthetic inline fidelity' }
const run = (text: string) => `<w:r><w:rPr><w:rFonts w:ascii="Arial Narrow" w:eastAsia="Synthetic CJK"/><w:w w:val="80"/></w:rPr><w:t>${text}</w:t></w:r>`
const paragraph = (numId: number, text: string, red = false) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>${red ? '<w:rPr><w:color w:val="FF0000"/></w:rPr>' : ''}</w:pPr>${run(text)}</w:p>`
const definition = (id: number, format: string, indent: number) => `<w:abstractNum w:abstractNumId="${id}"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="%1)"/><w:pPr><w:ind w:left="${indent}" w:hanging="${indent}"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`
async function fixture(body: string, numbering = '') {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('word/document.xml', `<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`)
  if (numbering) zip.file('word/numbering.xml', `<w:numbering>${numbering}</w:numbering>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
async function imported(bytes: Uint8Array): Promise<DocumentSnapshot> {
  const result = await importOfficeDocument(bytes, context)
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
  if (result.snapshot?.family !== 'document') throw new Error('Document required')
  return result.snapshot
}
function labels(snapshot: DocumentSnapshot) {
  const counter = officeNumberingCounter()
  return documentNumberedParagraphs(snapshot).filter(p => p.format.numbering).map(p => counter(p.format.numbering!))
}

// Entire fixture is generated from generic labels; no uploaded document content.
describe('[COMP:office/docx-engine] Bounded inline fidelity', () => {
  it.each([['<w:noWrap/>', false], ['<w:noWrap w:val="false"/>', true], ['', true]] as const)('reads the explicit no-wrap switch (%s)', async (property, expected) => {
    const source = await imported(await fixture(`<w:tbl><w:tr><w:tc><w:tcPr>${property}</w:tcPr><w:p>${run('Cell text')}</w:p></w:tc></w:tr></w:tbl>`))
    const table = source.sections[0].nodes[0]
    expect(table.kind === 'table' && table.rows[0].cells[0].wrapText).toBe(expected)
  })

  it('preserves explicit cell no-wrap in native XML without the canonical part', async () => {
    const source = documentSnapshot()
    const table = source.sections[0].nodes.find(node => node.kind === 'table')!
    if (table.kind !== 'table') throw new Error('table required')
    table.rows[0].cells[0].wrapText = false
    table.rows[0].cells[0].runs[0].text = 'Long item name'
    table.rows[0].cells[1].wrapText = true
    const zip = await JSZip.loadAsync((await exportOfficeDocument(source)).bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml.match(/<w:noWrap\b/g)).toHaveLength(1)
    expect(xml).toContain('Long\u00a0item\u00a0name')
    const canonical = await imported((await exportOfficeDocument(source)).bytes)
    const canonicalTable = canonical.sections[0].nodes.find(node => node.kind === 'table')!
    expect(canonicalTable.kind === 'table' && canonicalTable.rows[0].cells[0].runs[0].text).toBe('Long item name')
    zip.remove('customXml/brian-office.json')
    const reopened = await imported(await zip.generateAsync({ type: 'uint8array' }))
    const result = reopened.sections[0].nodes.find(node => node.kind === 'table')!
    if (result.kind !== 'table') throw new Error('table required')
    expect(result.rows[0].cells.map(cell => cell.wrapText)).toEqual([false, true])
  })

  it('admits level zero from nine declared levels and keeps unused unsupported levels inert', async () => {
    const result = await importOfficeDocument(await nineLevelNumberingFixture(), context)
    expect(result.diagnostics.some(d => d.code === 'docx.formatting.numbering')).toBe(false)
    if (result.snapshot?.family !== 'document') throw new Error('document')
    expect(labels(result.snapshot)).toEqual(['I)', 'II)', 'A)', 'B)', 'C)', 'D)'])
    const zip = await JSZip.loadAsync((await exportOfficeDocument(result.snapshot)).bytes)
    zip.remove('customXml/brian-office.json')
    expect(labels(await imported(await zip.generateAsync({ type: 'uint8array' })))).toEqual(['I)', 'II)', 'A)', 'B)', 'C)', 'D)'])
    const unsupported = await importOfficeDocument(await nineLevelNumberingFixture(1), context)
    expect(unsupported.diagnostics.some(d => d.code === 'docx.formatting.numbering')).toBe(true)
  })

  it('normalizes 13 legacy boxes plus four allowlisted symbols without executing fields, and exports native text', async () => {
    const field = (index: number) => `<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:sizeAuto/><w:default w:val="0"/>${index === 0 ? '<w:checked/>' : ''}</w:checkBox></w:ffData></w:fldChar></w:r><w:r><w:instrText> FORMCHECKBOX </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>cached field result</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
    const symbols = '<w:r><w:sym w:font="Wingdings 2" w:char="F0A3"/></w:r>'.repeat(4)
    const source = await imported(await fixture(`<w:p>${Array.from({ length: 13 }, (_, i) => field(i)).join('')}${symbols}${run(' Editable choice')}</w:p>`))
    const p = source.sections[0].nodes[0]
    if (p.kind !== 'paragraph') throw new Error('paragraph')
    expect(p.runs.map(r => r.text).join('')).toBe(`☒${'☐'.repeat(16)} Editable choice`)
    const exported = await exportOfficeDocument(source)
    const zip = await JSZip.loadAsync(exported.bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).not.toMatch(/FORMCHECKBOX|cached field result|<w:fldChar/)
    expect(xml).toContain('☒')
    zip.remove('customXml/brian-office.json')
    const native = await imported(await zip.generateAsync({ type: 'nodebuffer' }))
    expect(native.sections[0].nodes[0].kind === 'paragraph' && native.sections[0].nodes[0].runs.map(r => r.text).join('')).toBe(p.runs.map(r => r.text).join(''))
  })

  it('carries Roman/letter counters, red paragraph-mark styling, indents and width scaling through native XML and Yjs', async () => {
    const body = paragraph(5, 'First') + '<w:p>' + run('Interruption') + '</w:p>' + paragraph(5, 'Second') + paragraph(7, 'Alpha') + '<w:tbl><w:tr><w:tc>' + paragraph(7, 'Beta') + '</w:tc></w:tr></w:tbl>' + paragraph(7, 'Gamma', true) + paragraph(7, 'Delta')
    let source = await imported(await fixture(body, definition(5, 'upperRoman', 720) + definition(7, 'upperLetter', 360)))
    expect(labels(source)).toEqual(['I)', 'II)', 'A)', 'B)', 'C)', 'D)'])
    const formats = documentNumberedParagraphs(source).filter(p => p.format.numbering).map(p => p.format)
    expect(formats[0]).toMatchObject({ indentLeftPt: 36, hangingPt: 36 })
    expect(formats[4]).toMatchObject({ indentLeftPt: 18, hangingPt: 18, numbering: { markerStyle: { color: '#FF0000' } } })
    const doc = snapshotToYDoc(source)
    expect(yDocToSnapshot(doc)).toEqual(source)
    const initial = source.sections[0].nodes[0]
    if (initial.kind !== 'paragraph') throw new Error('paragraph')
    applyDocumentCommand(doc, { artifactId: source.artifactId, baseVersion: 0, actor: { type: 'user', id: id(200) }, origin: 'manual', commandId: id(201), kind: 'replaceTextRange', targetId: initial.id, from: 0, to: 5, preimageHash: documentRangePreimageHash('First'), runs: [{ ...initial.runs[0], id: id(202), text: 'Edited' }] })
    const edited = yDocToSnapshot(doc)
    if (edited.family !== 'document') throw new Error('document')
    source = edited
    doc.destroy()
    const preview = layoutOfficeArtifact(source).pages.map(page => renderOfficePreviewSvg(page)).join('')
    expect(preview).toContain('C)')
    expect(preview).toContain('color:#FF0000')
    expect(preview).toContain('scaleX(0.8)')
    const zip = await JSZip.loadAsync((await exportOfficeDocument(source)).bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    const numXml = await zip.file('word/numbering.xml')!.async('string')
    expect(xml).toContain('<w:w w:val="80"')
    expect(xml).toContain('w:hanging="720"')
    expect(xml).toContain('<w:color w:val="FF0000"')
    expect(numXml).toContain('w:val="upperRoman"')
    expect(numXml).toContain('w:val="upperLetter"')
    expect(numXml).toContain('w:val="%1)"')
    zip.remove('customXml/brian-office.json')
    const native = await imported(await zip.generateAsync({ type: 'nodebuffer' }))
    expect(labels(native)).toEqual(labels(source))
    for (const [index, p] of documentNumberedParagraphs(native).filter(p => p.format.numbering).entries()) expect(p.format).toMatchObject({ indentLeftPt: formats[index].indentLeftPt, hangingPt: formats[index].hangingPt, numbering: { ...formats[index].numbering!, listId: expect.any(String) } })
    const first = native.sections[0].nodes[0]
    expect(first.kind === 'paragraph' && first.runs.map(r => r.text).join('')).toBe('Edited')
    expect(first.kind === 'paragraph' && first.runs[0].style).toMatchObject({ widthScalePercent: 80, fontFamily: 'Arial Narrow', eastAsianFontFamily: 'Synthetic CJK' })
  })

  it.each(['upperLetter', 'lowerLetter'])('preserves Word letter items 26–29 through native numbering (%s)', async format => {
    const body = Array.from({ length: 4 }, (_, index) => paragraph(5, `Item ${index + 26}`)).join('')
    const source = await imported(await fixture(body, definition(5, format, 360).replace('<w:start w:val="1"/>', '<w:start w:val="26"/>')))
    const expected = format === 'upperLetter' ? ['Z)', 'AA)', 'BB)', 'CC)'] : ['z)', 'aa)', 'bb)', 'cc)']
    expect(labels(source)).toEqual(expected)
    const zip = await JSZip.loadAsync((await exportOfficeDocument(source)).bytes)
    expect(await zip.file('word/numbering.xml')!.async('string')).toContain(`w:val="${format}"`)
    zip.remove('customXml/brian-office.json')
    expect(labels(await imported(await zip.generateAsync({ type: 'nodebuffer' })))).toEqual(expected)
  })

  it('rejects malformed checkbox nesting instead of dropping subsequent text', async () => {
    for (const body of [
      '<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:default w:val="0"/></w:checkBox></w:ffData></w:fldChar><w:t>Still present</w:t></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox/></w:ffData></w:fldChar><w:fldChar w:fldCharType="begin"/><w:fldChar w:fldCharType="end"/><w:fldChar w:fldCharType="end"/></w:r></w:p>',
    ]) {
      const result = await importOfficeDocument(await fixture(body), context)
      expect(result.ok).toBe(false)
      expect(result.diagnostics.some(d => d.code === 'docx.formatting.checkbox_structure' && d.severity === 'error')).toBe(true)
    }
  })

  it('preserves separate list restarts and bounded instance starts, but warns on unsupported formats', async () => {
    const numbering = definition(5, 'upperLetter', 360) + '<w:num w:numId="8"><w:abstractNumId w:val="5"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride></w:num>' + definition(9, 'bullet', 360)
    const result = await importOfficeDocument(await fixture(paragraph(5, 'Alpha') + paragraph(8, 'Restart') + paragraph(5, 'Beta') + paragraph(9, 'Unsupported'), numbering), context)
    expect(result.ok).toBe(true)
    if (result.snapshot?.family !== 'document') throw new Error('Document required')
    expect(labels(result.snapshot)).toEqual(['A)', 'C)', 'B)'])
    expect(result.diagnostics.some(d => d.code === 'docx.formatting.numbering')).toBe(true)
  })

  it('diagnoses unsupported symbols, scale bounds and multilevel references without exposing source text', async () => {
    const result = await importOfficeDocument(await fixture('<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:rPr><w:w w:val="0"/></w:rPr><w:sym w:font="Unknown" w:char="FFFF"/><w:t>Private-like synthetic value</w:t></w:r></w:p>', definition(5, 'upperRoman', 720)), context)
    expect(result.ok).toBe(true)
    expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['docx.formatting.symbol', 'docx.formatting.text_scale', 'docx.formatting.numbering']))
    expect(JSON.stringify(result.diagnostics)).not.toContain('Private-like')
  })
})
