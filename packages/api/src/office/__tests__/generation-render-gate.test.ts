import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { convertToPdfWithLibreOffice } from '@use-brian/core/files/libreoffice.js'
import type { OfficeGenerationFitPolicy } from '@use-brian/core/office/generation/pipeline.js'
import { generateAssistantOfficeCommands, officeRevisionFitRepairScope } from '../command-revision.js'
import { createOfficeGenerationWorker } from '../generation-worker.js'
import { generateDocumentFromTemplate } from '../document-generation.js'
import { generatePresentationFromTemplate, materializeOfficeTemplateBundleForGeneration } from '../presentation-generation.js'
import { validateOfficeCandidateRendering, validateOfficeInternalCandidateRendering } from '../render-validation.js'
import { documentSnapshot, completeSpreadsheetSnapshot, templateBundle, resolveFixtureResource, id } from '../../../../core/src/office/__tests__/fixtures.js'
import { minimalPdf } from '../../../../core/src/files/__tests__/pdf-fixture.js'

vi.mock('@use-brian/core/files/libreoffice.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@use-brian/core/files/libreoffice.js')>()),
  convertToPdfWithLibreOffice: vi.fn(),
}))
const converter = vi.mocked(convertToPdfWithLibreOffice)
const provider = (value: unknown) => ({ async *stream() {
  yield { type: 'message_start', model: 'test' }
  yield { type: 'text_delta', text: JSON.stringify(value) }
  yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
} })

describe('[COMP:api/office-generation] production create render gate', () => {
  it.each([true, false])('worker default uses real exporters and converter seam; readable=%s', async readable => {
    converter.mockReset().mockResolvedValue(readable ? minimalPdf(3) : new Uint8Array())
    const snapshot = documentSnapshot()
    const brief = { workspaceId: id(2), actingUserId: id(80), assistantId: id(81), family: 'document', outcome: 'Create a report', audience: 'Board', sourceHandles: [], requestedSensitivityFloor: 'internal', idempotencyKey: 'create-gate-test' }
    const job = { id: id(100), artifactId: snapshot.artifactId, workspaceId: id(2), initiatedByUserId: id(80), brief, checkpointVersion: 0 }
    const store = { claim: vi.fn(async () => job as never), checkpoint: vi.fn(async () => true), appendEvent: vi.fn(async () => ({})), drainSteering: vi.fn(async () => []), finish: vi.fn(async () => true) }
    const commit = vi.fn(async () => ({ artifactId: snapshot.artifactId, version: 1 }))
    const worker = createOfficeGenerationWorker({ store, workerUserId: id(80), buildPipelineDeps: () => ({
      resolveAuthority: async () => ({ sensitivity: 'internal', visibilityUserIds: [], compartments: [], sourceHandles: [] }),
      selectTemplate: async () => ({ template: { ...templateBundle(), status: 'admitted' } }),
      retrieveBrain: async () => [], inspectUrl: async () => [], planClaims: async () => [], construct: async () => snapshot,
      processMedia: async candidate => candidate, resolveResource: async () => null, cancelled: async () => false, commit,
      // Deliberately no renderValidation override: this exercises the production default.
    }) })
    expect(await worker.runOnce()).toBe(readable ? 'completed' : 'failed')
    expect(converter).toHaveBeenCalledOnce()
    expect(converter.mock.calls[0][1]).toMatchObject({ inputName: 'candidate.docx' })
    if (readable) {
      expect(commit).toHaveBeenCalledOnce()
      const checkpoint = store.checkpoint.mock.calls.at(-1) as unknown as [{ checkpoint: { renderValidation: { exportHash: string } } }]
      expect(checkpoint[0].checkpoint.renderValidation.exportHash).toBe(createHash('sha256').update(converter.mock.calls[0][0]).digest('hex'))
    } else {
      expect(commit).not.toHaveBeenCalled()
      expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'render_validation_failed' }))
    }
  })

  it('DOCX policy includes actual filled runs, not unrelated template copy', async () => {
    const template = templateBundle()
    if (template.snapshot.family !== 'document') throw new Error('fixture')
    const paragraph = template.snapshot.sections[0].nodes.find(node => node.kind === 'paragraph')!
    if (paragraph.kind !== 'paragraph') throw new Error('fixture')
    paragraph.runs[0].text = '{{VALUE}}'
    paragraph.runs.push({ ...structuredClone(paragraph.runs[0]), id: id(999), text: 'Unchanged source' })
    template.fields = []
    const onFitPolicy = vi.fn()
    await generateDocumentFromTemplate({ provider: provider({ title: 'Filled', values: { VALUE: 'Fact' } }) as never, model: 'test', artifactId: id(900), workspaceId: id(2), templateVersionId: template.id, outcome: 'Fill', audience: 'Board', template, onFitPolicy })
    expect(onFitPolicy).toHaveBeenCalledWith(expect.objectContaining({ eligibleTargetIds: [paragraph.runs[0].id], maxAttempts: 3 }))
  })

  it('PPTX policy follows remapped filled objects, without a nested fit-rewrite loop', async () => {
    const template = materializeOfficeTemplateBundleForGeneration(templateBundle('presentation'), { id: id(901), version: 1, status: 'admitted' })
    const recipe = template.slideRecipes[0]
    const field = template.fields.find(field => recipe.fieldIds.includes(field.id) && !field.locked)!
    const fields = recipe.fieldIds.map(fieldId => ({ fieldId, text: 'Facts' }))
    if (template.snapshot.family !== 'presentation') throw Error('fixture')
    const sourceSlide = template.snapshot.slides.find(slide => slide.id === recipe.slideId)!
    const sourceText = sourceSlide.objects.find(object => object.kind === 'text')!
    if (sourceText.kind !== 'text') throw Error('fixture')
    sourceSlide.objects.push({ ...structuredClone(sourceText), id: id(970), locked: false, runs: [{ ...structuredClone(sourceText.runs[0]), id: id(971), text: 'Locked source copy' }] })
    sourceSlide.readingOrder.push(id(970))
    template.lockedObjectIds.push(id(970))
    const onFitPolicy = vi.fn<(policy: OfficeGenerationFitPolicy) => void>()
    const generated = await generatePresentationFromTemplate({ provider: provider({ title: 'Deck', slides: [{ recipeId: recipe.id, title: 'Slide', fields }] }) as never, model: 'test', artifactId: id(902), workspaceId: id(2), templateVersionId: template.id, outcome: 'Create', audience: 'Board', evidence: { brain: [], website: [], conflicts: [] }, claims: [], template, onFitPolicy })
    const policy = onFitPolicy.mock.calls[0][0]
    expect(policy.eligibleTargetIds.length).toBeGreaterThan(0)
    expect(policy.eligibleTargetIds).not.toContain(field.targetIds[0])
    expect(policy.eligibleTargetIds.every(id => generated.slides.some(slide => slide.objects.some(object => object.id === id)))).toBe(true)
    expect(policy.maxAttempts).toBe(3)
    const lockedCopy = generated.slides[0].objects.find(object => object.kind === 'text' && object.runs[0].text === 'Locked source copy')!
    if (lockedCopy.kind !== 'text') throw Error('fixture')
    expect(generated.masters.flatMap(master => master.lockedObjectIds)).toContain(lockedCopy.id)
    expect(officeRevisionFitRepairScope(generated, [generated.slides[0].id]).eligibleTargetIds).not.toContain(lockedCopy.runs[0].id)
    let calls = 0
    const valid = { title: 'Deck', slides: [{ recipeId: recipe.id, title: 'Slide', fields }] }
    const retryProvider = { async *stream() {
      calls++
      yield* provider(calls === 1 ? { invalid: 'shape' } : valid).stream()
    } }
    onFitPolicy.mockClear()
    await generatePresentationFromTemplate({ provider: retryProvider as never, model: 'test', artifactId: id(902), workspaceId: id(2), templateVersionId: template.id, outcome: 'Create', audience: 'Board', evidence: { brain: [], website: [], conflicts: [] }, claims: [], template, onFitPolicy })
    expect(calls).toBe(2)
    expect(onFitPolicy.mock.calls[0][0].maxAttempts).toBe(2)
    template.lockedObjectIds.push(field.targetIds[0])
    await expect(generatePresentationFromTemplate({ provider: provider(valid) as never, model: 'test', artifactId: id(902), workspaceId: id(2), templateVersionId: template.id, outcome: 'Create', audience: 'Board', evidence: { brain: [], website: [], conflicts: [] }, claims: [], template, onFitPolicy })).rejects.toThrow('locked')
  })

  it('revision commands use the same internal all-visible-sheet render/reparse gate', async () => {
    const snapshot = completeSpreadsheetSnapshot()
    const second = structuredClone(snapshot.worksheets[0])
    second.id = id(940); second.name = 'Second'
    second.cells = [{ id: id(941), address: 'A1', valueType: 'string', value: 'Unselected content', style: {}, locked: false }]
    second.images = []; second.validations = []; second.conditionalFormats = []; second.tables = []
    delete second.print.printArea
    snapshot.worksheets.push(second)
    const cell = snapshot.worksheets[0].cells[0]
    converter.mockReset().mockResolvedValue(minimalPdf(2))
    const commands = await generateAssistantOfficeCommands({ provider: provider({ commands: [{ kind: 'setSpreadsheetCell', sheetId: snapshot.activeSheetId, cellId: cell.id, address: cell.address, valueType: 'string', value: 'Updated invoice' }] }) as never, model: 'test', snapshot, baseVersion: 1, assistantId: id(950), targetIds: [cell.id], instruction: 'Update the heading', validateCandidate: async candidate => {
      const rendered = await validateOfficeInternalCandidateRendering({ snapshot: candidate, resolveResource: resolveFixtureResource })
      expect(rendered.receipt, JSON.stringify(rendered.receipt)).toMatchObject({ ok: true, actualPageCount: 2 })
      if (!rendered.receipt.ok) throw Error('Render gate failed')
    } })
    expect(commands).toHaveLength(1)
    expect(converter).toHaveBeenCalledOnce()
    expect(snapshot.worksheets[1].cells[0].value).toBe('Unselected content')
  })

  it('retains the pre-revision readability baseline through native rendering', async () => {
    const snapshot = documentSnapshot()
    const paragraph = snapshot.sections[0].nodes.find(node => node.kind === 'paragraph')!
    if (paragraph.kind !== 'paragraph') throw Error('fixture')
    snapshot.sections[0].nodes.push({ ...structuredClone(paragraph), id: id(960), runs: [{ ...structuredClone(paragraph.runs[0]), id: id(961), text: 'Unchanged fine print', style: { ...paragraph.runs[0].style, fontSizePt: 7 } }] })
    converter.mockReset().mockResolvedValue(minimalPdf())
    const runs = paragraph.runs.map(run => ({ ...run, text: 'Revised content' }))
    const commands = await generateAssistantOfficeCommands({
      provider: provider({ commands: [{ kind: 'updateText', targetId: paragraph.id, runs }] }) as never,
      model: 'test', snapshot, baseVersion: 1, assistantId: id(950), targetIds: [paragraph.id], instruction: 'Revise content, retain the admitted typography',
      validateCandidate: async candidate => {
        const rendered = await validateOfficeInternalCandidateRendering({ snapshot: candidate, fitBudget: { readabilityReference: snapshot } })
        expect(rendered.receipt, JSON.stringify(rendered.receipt)).toMatchObject({ ok: true })
        if (!rendered.receipt.ok) throw Error('Render gate failed')
      },
    })
    expect(commands).toHaveLength(1)
    expect(converter).toHaveBeenCalledOnce()
  })

  it('internal XLSX validation supports multiple visible sheets without rewriting print scope', async () => {
    const snapshot = completeSpreadsheetSnapshot()
    const other = structuredClone(snapshot.worksheets[0])
    other.id = id(903); other.name = 'Second'
    other.cells = other.cells.map((cell, index) => ({ ...cell, id: id(910 + index) }))
    other.images = []; other.validations = []; other.conditionalFormats = []
    other.tables = other.tables?.map((table, index) => ({ ...table, id: id(950 + index), name: `SecondTable${index}` }))
    snapshot.worksheets.push(other)
    const before = structuredClone(snapshot)
    converter.mockReset().mockResolvedValue(minimalPdf(2))
    const result = await validateOfficeCandidateRendering({ snapshot, spreadsheetMode: 'all-visible', resolveResource: resolveFixtureResource })
    expect(result.receipt, JSON.stringify(result.receipt)).toMatchObject({ ok: true, expectedPageCount: 2, actualPageCount: 2 })
    expect(snapshot).toEqual(before)
    converter.mockResolvedValue(minimalPdf())
    expect((await validateOfficeCandidateRendering({ snapshot, spreadsheetMode: 'all-visible', resolveResource: resolveFixtureResource })).receipt.ok).toBe(false)
    for (const sheet of snapshot.worksheets) { sheet.print.fitToHeight = 0; delete sheet.print.printArea }
    converter.mockResolvedValue(minimalPdf(3))
    const automatic = await validateOfficeCandidateRendering({ snapshot, spreadsheetMode: 'all-visible', resolveResource: resolveFixtureResource })
    expect(automatic.receipt).toMatchObject({ ok: true, minimumPageCount: 2, actualPageCount: 3 })
    expect(automatic.receipt.expectedPageCount).toBeUndefined()
  })
})
