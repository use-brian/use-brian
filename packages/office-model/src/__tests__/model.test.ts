import { describe, expect, it } from 'vitest'
import { OfficeArtifactSnapshotSchema } from '../model.js'
import { documentFixture, presentationFixture } from './fixtures.js'

describe('[COMP:office/model] Office canonical model', () => {
  it('accepts strict document and presentation snapshots', () => {
    expect(OfficeArtifactSnapshotSchema.parse(documentFixture()).family).toBe('document')
    expect(OfficeArtifactSnapshotSchema.parse(presentationFixture()).family).toBe('presentation')
  })

  it('rejects unknown fields and incomplete reading order', () => {
    expect(() => OfficeArtifactSnapshotSchema.parse({ ...documentFixture(), surprise: true })).toThrow()
    const presentation = presentationFixture()
    presentation.slides[0].readingOrder = []
    expect(() => OfficeArtifactSnapshotSchema.parse(presentation)).toThrow(/Reading order/)
  })

  it('requires safe inert hyperlink schemes', () => {
    const document = documentFixture()
    const paragraph = document.sections[0].nodes[0]
    if (paragraph.kind !== 'paragraph') throw new Error('fixture drift')
    paragraph.runs[0] = { ...paragraph.runs[0], href: 'javascript:alert(1)' }
    expect(() => OfficeArtifactSnapshotSchema.parse(document)).toThrow(/HTTPS and mailto/)
  })
})
