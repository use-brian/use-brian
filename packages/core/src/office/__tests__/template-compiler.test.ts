import { describe, expect, it } from 'vitest'
import { canEnableOfficeCreation, compileOfficeTemplate } from '../templates/compiler.js'
import { OfficeTemplateBundleSchema } from '@use-brian/office-model'
import { inferOfficeTemplateRouting } from '../templates/routing.js'
import { id, templateBundle } from './fixtures.js'

function configuredDocumentBundle() {
  const draft = templateBundle('document')
  if (draft.snapshot.family !== 'document') throw new Error('Expected document fixture')
  const paragraph = draft.snapshot.sections[0]!.nodes.find((node) => node.id === id(9))!
  if (paragraph.kind !== 'paragraph') throw new Error('Expected paragraph fixture')
  paragraph.runs[0]!.text = 'Summary: {{SUMMARY}}'
  draft.fields = inferOfficeTemplateRouting(draft.snapshot).fields
  return draft
}

describe('[COMP:office/template-compiler] Office template compiler', () => {
  it('admits all three authoring paths only after export/reopen validation', async () => {
    expect(canEnableOfficeCreation('document')).toBe(true)
    expect(canEnableOfficeCreation('presentation')).toBe(true)
    expect(canEnableOfficeCreation('pdf')).toBe(false)
    for (const authoringPath of ['upload', 'scratch', 'promote_version'] as const) {
      const compiled = await compileOfficeTemplate({ authoringPath, draft: authoringPath === 'upload' ? templateBundle('presentation') : configuredDocumentBundle(), resources: [] })
      expect(compiled.receipt).toMatchObject({ ok: true, authoringPath, capabilityVersion: 1 })
      expect(compiled.bundle?.status).toBe('admitted')
      expect(compiled.receipt.semanticHash).toMatch(/^[a-f0-9]{64}$/)
      expect(compiled.receipt.previewGolden).toContain('<svg')
    }
  })

  it('returns actionable diagnostics and leaves an invalid draft unadmitted', async () => {
    const draft = configuredDocumentBundle()
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
  it('requires a token contract for new admission while keeping legacy bundles readable', async () => {
    const draft = configuredDocumentBundle()
    draft.fields = []
    const compiled = await compileOfficeTemplate({ authoringPath: 'scratch', draft, resources: [] })
    expect(compiled.receipt.ok).toBe(false)
    expect(compiled.receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'template.routing_invalid', message: expect.stringContaining('Missing configuration') }))
    const legacy = { ...draft, status: 'admitted' }
    expect(OfficeTemplateBundleSchema.safeParse(legacy).success).toBe(true)
    expect(OfficeTemplateBundleSchema.safeParse({ ...legacy, fields: undefined }).success).toBe(true)
  })

  it('rejects explicit token locks without treating value limits as container limits', async () => {
    const draft = configuredDocumentBundle()
    draft.fields[0]!.maxLength = 3
    const valid = await compileOfficeTemplate({ authoringPath: 'scratch', draft, resources: [] })
    expect(valid.receipt.ok, JSON.stringify(valid.receipt.diagnostics)).toBe(true)
    draft.lockedObjectIds = draft.fields[0]!.targetIds
    const locked = await compileOfficeTemplate({ authoringPath: 'scratch', draft, resources: [] })
    expect(locked.receipt.ok).toBe(false)
    expect(locked.receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'template.locked_token' }))
  })

})
