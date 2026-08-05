import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { fitOfficeArtifact } from '@use-brian/office-renderer'
import { exportOfficePresentation, importOfficePresentation, reparseOfficePresentation } from '../pptx/index.js'
import { completePresentationSnapshot, id, resolveFixtureResource } from './fixtures.js'

describe('[COMP:office/pptx-engine] PPTX engine', () => {
  it('exports, safely reparses, and preserves canonical semantics plus layout', async () => {
    const source = completePresentationSnapshot()
    const exported = await exportOfficePresentation(source, resolveFixtureResource)
    const imported = await importOfficePresentation(exported.bytes, { artifactId: source.artifactId, workspaceId: source.workspaceId, templateVersionId: source.templateVersionId, locale: source.locale, defaultLanguage: source.defaultLanguage, title: source.title })
    const reopened = await reparseOfficePresentation(exported.bytes)
    expect(imported.ok).toBe(true)
    expect(imported.snapshot).toEqual(source)
    expect(reopened.snapshot).toEqual(source)
    expect(reopened.semanticHash).toBe(exported.semanticHash)
    expect(reopened.layoutSerialization).toBe(exported.layoutSerialization)
    const zip = await JSZip.loadAsync(exported.bytes)
    expect(zip.file('ppt/presentation.xml')).not.toBeNull()
    expect(zip.file('customXml/brian-office.json')).not.toBeNull()
  })

  it('normalizes a conventional external PPTX and rejects external media relationships', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"/>')
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="4572000" cy="685800"/></a:xfrm><a:prstGeom prst="rect"/><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:p><a:r><a:t>Hello deck</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>')
    const result = await importOfficePresentation(await zip.generateAsync({ type: 'nodebuffer' }), { artifactId: id(70), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Imported deck' })
    expect(result.ok).toBe(true)
    expect(result.snapshot?.family).toBe('presentation')

    zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="https://example.com/private.mp4" TargetMode="External"/></Relationships>')
    const rejected = await importOfficePresentation(await zip.generateAsync({ type: 'nodebuffer' }), { artifactId: id(71), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Rejected deck' })
    expect(rejected.ok).toBe(false)
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ code: 'package.external_relationship' }))
  })

  it('keeps paragraphs in their source text box and preserves positioned media, tables, and scatter charts', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>')
    zip.file('ppt/slides/slide1.xml', `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r" xmlns:c="c"><p:cSld><p:spTree>
      <p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="685800"/><a:ext cx="4572000" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"/><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr><a:normAutofit fontScale="90000"/></a:bodyPr><a:p><a:pPr><a:defRPr sz="3200"/></a:pPr><a:r><a:rPr sz="3200"/><a:t>Hello</a:t></a:r></a:p><a:p><a:pPr><a:defRPr sz="2400"/></a:pPr><a:r><a:rPr sz="2400"/><a:t>deck</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="Label"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="6096000" y="685800"/><a:ext cx="2286000" cy="457200"/></a:xfrm><a:prstGeom prst="rect"/><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1200"/><a:t>Separate label</a:t></a:r></a:p></p:txBody></p:sp>
      <p:pic><p:nvPicPr><p:cNvPr id="4" name="Logo" descr="Company logo"/></p:nvPicPr><p:blipFill><a:blip r:embed="rImage"/></p:blipFill><p:spPr><a:xfrm><a:off x="685800" y="2743200"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr></p:pic>
      <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/></p:nvGraphicFramePr><p:xfrm><a:off x="2286000" y="2743200"/><a:ext cx="2286000" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Metric</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
      <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Priorities"/></p:nvGraphicFramePr><p:xfrm><a:off x="5334000" y="2743200"/><a:ext cx="4572000" cy="2743200"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rChart"/></a:graphicData></a:graphic></p:graphicFrame>
    </p:spTree></p:cSld></p:sld>`)
    zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="rImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/><Relationship Id="rChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/></Relationships>')
    zip.file('ppt/media/logo.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    zip.file('ppt/slides/charts/chart1.xml', '<c:chartSpace xmlns:c="c"><c:chart><c:plotArea><c:scatterChart><c:ser><c:tx><c:v>Impact</c:v></c:tx><c:xVal><c:numLit><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numLit></c:xVal><c:yVal><c:numLit><c:pt idx="0"><c:v>4</c:v></c:pt><c:pt idx="1"><c:v>8</c:v></c:pt></c:numLit></c:yVal></c:ser></c:scatterChart></c:plotArea></c:chart></c:chartSpace>')

    const result = await importOfficePresentation(await zip.generateAsync({ type: 'nodebuffer' }), { artifactId: id(72), workspaceId: id(2), templateVersionId: null, locale: 'en-US', defaultLanguage: 'en-US', title: 'Imported layout' })
    expect(result.ok).toBe(true)
    expect(result.resources).toHaveLength(1)
    expect(result.snapshot?.family).toBe('presentation')
    if (result.snapshot?.family !== 'presentation') throw new Error('Expected presentation snapshot')
    expect(result.snapshot.slideSize).toEqual({ widthPt: 960, heightPt: 540 })
    const text = result.snapshot.slides[0].objects.filter((object) => object.kind === 'text')
    expect(text).toHaveLength(2)
    expect(text[0].kind === 'text' ? text[0].runs.map((run) => run.text).join('') : '').toBe('Hello\ndeck')
    expect(result.snapshot.slides[0].objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'image', altText: 'Company logo' }),
      expect.objectContaining({ kind: 'table' }),
      expect.objectContaining({ kind: 'chart', chartType: 'scatter', categories: ['1', '2'] }),
    ]))
    expect(fitOfficeArtifact(result.snapshot).issues).toEqual([])
  })
})
