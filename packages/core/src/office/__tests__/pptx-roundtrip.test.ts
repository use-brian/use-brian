import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
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
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Hello deck</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>')
    const result = await importOfficePresentation(await zip.generateAsync({ type: 'nodebuffer' }), { artifactId: id(70), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Imported deck' })
    expect(result.ok).toBe(true)
    expect(result.snapshot?.family).toBe('presentation')

    zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="https://example.com/private.mp4" TargetMode="External"/></Relationships>')
    const rejected = await importOfficePresentation(await zip.generateAsync({ type: 'nodebuffer' }), { artifactId: id(71), workspaceId: id(2), templateVersionId: id(3), locale: 'en-US', defaultLanguage: 'en-US', title: 'Rejected deck' })
    expect(rejected.ok).toBe(false)
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ code: 'package.external_relationship' }))
  })
})
