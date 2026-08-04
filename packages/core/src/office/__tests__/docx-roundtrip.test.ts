import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { exportOfficeDocument, importOfficeDocument, reparseOfficeDocument } from '../docx/index.js'
import { documentSnapshot, id, resolveFixtureResource } from './fixtures.js'

describe('[COMP:office/docx-engine] DOCX engine', () => {
  it('exports, safely reparses, and preserves canonical semantics plus layout', async () => {
    const source = documentSnapshot()
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
})
