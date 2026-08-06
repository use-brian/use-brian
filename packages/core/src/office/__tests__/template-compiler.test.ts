import { describe, expect, it } from 'vitest'
import { canEnableOfficeCreation, compileOfficeTemplate } from '../templates/compiler.js'
import { id, templateBundle } from './fixtures.js'

describe('[COMP:office/template-compiler] Office template compiler', () => {
  it('admits all three authoring paths only after export/reopen validation', async () => {
    expect(canEnableOfficeCreation('document')).toBe(true)
    expect(canEnableOfficeCreation('presentation')).toBe(true)
    for (const authoringPath of ['upload', 'scratch', 'promote_version'] as const) {
      const compiled = await compileOfficeTemplate({ authoringPath, draft: templateBundle(authoringPath === 'upload' ? 'presentation' : 'document'), resources: [] })
      expect(compiled.receipt).toMatchObject({ ok: true, authoringPath, capabilityVersion: 1 })
      expect(compiled.bundle?.status).toBe('admitted')
      expect(compiled.receipt.semanticHash).toMatch(/^[a-f0-9]{64}$/)
      expect(compiled.receipt.previewGolden).toContain('<svg')
    }
  })

  it('returns actionable diagnostics and leaves an invalid draft unadmitted', async () => {
    const draft = templateBundle()
    draft.fields[0].targetIds = [id(999)]
    const compiled = await compileOfficeTemplate({ authoringPath: 'scratch', draft, resources: [] })
    expect(compiled.bundle).toBeUndefined()
    expect(compiled.receipt.ok).toBe(false)
    expect(compiled.receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'template.field_target_missing', path: 'fields.0.targetIds' }))
    expect(draft.status).toBe('draft')
  })

  it('preserves intentional small type on upload without weakening the scratch readability floor', async () => {
    const uploadDraft = templateBundle('presentation')
    if (uploadDraft.snapshot.family !== 'presentation' || uploadDraft.snapshot.slides[0].objects[0].kind !== 'text') throw new Error('Expected presentation text fixture')
    uploadDraft.snapshot.slides[0].objects[0].runs[0].style.fontSizePt = 6
    const uploaded = await compileOfficeTemplate({ authoringPath: 'upload', draft: uploadDraft, resources: [] })
    expect(uploaded.receipt.ok, JSON.stringify(uploaded.receipt.diagnostics)).toBe(true)

    const scratchDraft = templateBundle('presentation')
    if (scratchDraft.snapshot.family !== 'presentation' || scratchDraft.snapshot.slides[0].objects[0].kind !== 'text') throw new Error('Expected presentation text fixture')
    scratchDraft.snapshot.slides[0].objects[0].runs[0].style.fontSizePt = 6
    const scratched = await compileOfficeTemplate({ authoringPath: 'scratch', draft: scratchDraft, resources: [] })
    expect(scratched.receipt.ok).toBe(false)
    expect(scratched.receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'layout.readability' }))
  })
})
