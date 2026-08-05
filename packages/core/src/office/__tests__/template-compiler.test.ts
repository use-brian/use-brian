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
})
