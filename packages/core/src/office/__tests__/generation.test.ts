import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { OfficeGenerationFailure, OfficeMaterialFactMissing } from '../generation/contracts.js'
import { runOfficeGenerationPipeline, type OfficeGenerationPipelineDeps } from '../generation/pipeline.js'
import { runOfficeEdit } from '../generation/edit-runner.js'
import { documentSnapshot, id, templateBundle } from './fixtures.js'

function brief(overrides: Record<string, unknown> = {}) {
  return { workspaceId: id(2), actingUserId: id(80), assistantId: id(81), family: 'document', outcome: 'Create a board update', audience: 'Board', additionalContext: 'Prioritize retention. Reference https://reports.example.com/q2.', sourceHandles: ['page:plan'], requestedSensitivityFloor: 'internal', idempotencyKey: 'request-12345678', ...overrides }
}

function deps() {
  const events: string[] = []
  const checkpoints: string[] = []
  const value: OfficeGenerationPipelineDeps = {
    resolveAuthority: vi.fn(async () => ({ sensitivity: 'internal' as const, visibilityUserIds: [], compartments: [], sourceHandles: ['page:plan'] })),
    selectTemplate: vi.fn(async () => ({ template: { ...templateBundle(), status: 'admitted' as const } })),
    retrieveBrain: vi.fn(async () => [{ handle: 'page:plan', excerpt: 'ARR grew.', sensitivity: 'internal' as const }]),
    inspectUrl: vi.fn(async (url) => [{ url, excerpt: 'Example Labs publishes its Q2 report.' }]),
    planClaims: vi.fn(async () => [{ objectHint: 'summary', text: 'ARR grew.', classification: 'evidence_supported' as const, confidence: 0.95, sourceHandles: ['page:plan'] }]),
    construct: vi.fn(async () => documentSnapshot()),
    processMedia: vi.fn(async (snapshot) => snapshot),
    resolveResource: async () => null,
    renderValidation: vi.fn(async (snapshot, { exportBytes }) => ({ ok: true, candidateHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), exportHash: createHash('sha256').update(exportBytes).digest('hex'), issues: [] })),
    checkpoint: vi.fn(async (checkpoint) => { checkpoints.push(checkpoint.stage) }),
    emit: vi.fn(async (event) => { events.push(event.code) }),
    cancelled: vi.fn(async () => false),
    drainSteering: vi.fn(async () => []),
    commit: vi.fn(async (snapshot) => ({ artifactId: snapshot.artifactId, version: 1 })),
  }
  return { value, events, checkpoints }
}

describe('[COMP:office/generation] Office generation pipeline', () => {
  it('persists the template question before pausing and does not construct content',async()=>{
    const test=deps();test.value.selectTemplate=vi.fn(async()=>({ambiguous:['Private worksheet']}))
    expect(await runOfficeGenerationPipeline(brief(),test.value)).toMatchObject({status:'needs_input',code:'template_ambiguous'})
    expect(test.value.emit).toHaveBeenCalledWith(expect.objectContaining({code:'office.job.needs_input',params:{reason:'template_ambiguous',question:'Which published template should I use?'}}))
    expect(test.value.construct).not.toHaveBeenCalled()
  })
  it('inherits template department/project restrictions without broadening caller grants', async () => {
    const test = deps()
    test.value.resolveAuthority = vi.fn(async () => ({ sensitivity: 'internal' as const, clearance: 'confidential' as const, visibilityUserIds: [], compartments: ['request'], projectIds: [], compartmentGrant: ['finance'], projectGrant: ['project-a'], sourceHandles: [] }))
    test.value.selectTemplate = vi.fn(async () => ({ template: { ...templateBundle(), status: 'admitted' as const }, sourceScope: { sensitivity: 'confidential' as const, compartments: ['finance'], projectIds: ['project-a'] } }))
    expect((await runOfficeGenerationPipeline(brief(),test.value)).status).toBe('completed')
    expect(vi.mocked(test.value.commit).mock.calls[0][1].authority).toMatchObject({ sensitivity: 'confidential', compartments: ['finance','request'], projectIds: ['project-a'], compartmentGrant: ['finance'], projectGrant: ['project-a'] })
  })

  it.each(['clearance','department','project'])('rejects template requirements outside the %s grant before construction', async kind => {
    const test=deps()
    test.value.resolveAuthority=vi.fn(async()=>({sensitivity:'internal' as const,clearance:'internal' as const,visibilityUserIds:[],compartments:[],compartmentGrant:[],projectGrant:[],sourceHandles:[]}))
    test.value.selectTemplate=vi.fn(async()=>({template:{...templateBundle(),status:'admitted' as const},sourceScope:{sensitivity:kind==='clearance'?'confidential' as const:'internal' as const,compartments:kind==='department'?['finance']:[],projectIds:kind==='project'?['project-a']:[]}}))
    expect(await runOfficeGenerationPipeline(brief(),test.value)).toMatchObject({status:'failed',code:'template_scope_denied'})
    expect(test.value.construct).not.toHaveBeenCalled()
  })

  it('asks for missing required facts without committing an invoice or inventing terms', async () => {
    const test = deps()
    test.value.construct = vi.fn(async () => { throw new OfficeMaterialFactMissing(['PAYMENT_TERMS','SELLER_ADDRESS']) })
    const result = await runOfficeGenerationPipeline(brief(),test.value)
    expect(result).toMatchObject({ status: 'needs_input', code: 'material_fact_missing', question: expect.stringContaining('PAYMENT_TERMS') })
    expect(test.value.commit).not.toHaveBeenCalled()
    expect(test.events).toContain('office.job.needs_input')
  })

  it('runs the ten durable stages and completes only after export/reopen', async () => {
    const test = deps()
    const result = await runOfficeGenerationPipeline(brief(), test.value)
    expect(result).toMatchObject({ status: 'completed', version: 1 })
    expect(test.events).toContain('office.job.reference_url_inspected')
    expect(test.events).toContain('office.job.context_grounded')
    expect(test.events.at(-1)).toBe('office.job.completed')
    expect(test.checkpoints).toEqual(['queued', 'template', 'grounding', 'claim_plan', 'construct', 'media', 'fit_render', 'validate', 'export_reparse', 'completed'])
  })

  it.each(['absent', 'failed', 'stale', 'throws'] as const)('never commits when rendered validation is %s', async mode => {
    const test = deps()
    if (mode === 'absent') delete test.value.renderValidation
    else test.value.renderValidation = vi.fn(async () => {
      if (mode === 'throws') throw new Error('converter_unavailable')
      return { ok: mode === 'stale', candidateHash: 'stale', exportHash: 'stale', issues: mode === 'stale' ? [] : [{ code: 'invalid_pdf', message: 'Unreadable PDF' }] }
    })
    const result = await runOfficeGenerationPipeline(brief(), test.value)
    expect(result.status).toBe('failed')
    expect(test.value.commit).not.toHaveBeenCalled()
    expect(test.checkpoints).not.toContain('completed')
  })

  it('passes exactly the rendered/reparsed bytes and receipt to commit', async () => {
    const test = deps()
    const result = await runOfficeGenerationPipeline(brief(), test.value)
    expect(result.status).toBe('completed')
    const rendered = vi.mocked(test.value.renderValidation!).mock.calls[0][1].exportBytes
    const committed = vi.mocked(test.value.commit).mock.calls[0][1]
    expect(new Uint8Array(committed.exportBytes)).toEqual(rendered)
    expect(committed.renderValidation.exportHash).toBe(createHash('sha256').update(rendered).digest('hex'))
    expect(test.value.checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ renderValidation: expect.objectContaining({ ok: true }), fitRepair: expect.objectContaining({ attempts: 1 }) }))
  })

  it('repairs only the explicit changed PPTX target before the render gate', async () => {
    const test = deps()
    const template = templateBundle('presentation')
    if (template.snapshot.family !== 'presentation') throw new Error('fixture')
    const snapshot = structuredClone(template.snapshot)
    const object = snapshot.slides[0].objects.find(object => object.kind === 'text')!
    if (object.kind !== 'text') throw new Error('fixture')
    object.runs.forEach(run => { run.style.fontSizePt = 12; run.text = 'Facts' })
    object.geometry.heightPt = 13
    snapshot.slides[0].objects = [object]
    snapshot.slides[0].readingOrder = [object.id]
    test.value.selectTemplate = vi.fn(async () => ({ template: { ...template, status: 'admitted' as const } }))
    test.value.construct = vi.fn(async () => snapshot)
    test.value.fitRepairPolicy = () => ({ eligibleTargetIds: [object.id], maxAttempts: 3 })
    const result = await runOfficeGenerationPipeline(brief({ family: 'presentation' }), test.value)
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed' })
    const rendered = vi.mocked(test.value.renderValidation!).mock.calls[0][0]
    expect(JSON.stringify(rendered)).toContain('"fontSizePt":11')
    expect(object.runs[0].style.fontSizePt).toBe(12)
    expect(test.value.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ fitRepair: expect.objectContaining({ attempts: 2, changes: [expect.objectContaining({ targetId: object.id, fromPt: 12, toPt: 11 })] }) }))
    test.value.fitRepairPolicy = () => ({ eligibleTargetIds: [object.id], lockedTargetIds: [object.id] })
    vi.mocked(test.value.commit).mockClear()
    expect(await runOfficeGenerationPipeline(brief({ family: 'presentation' }), test.value)).toMatchObject({ status: 'failed', code: 'fit_failed' })
    expect(test.value.commit).not.toHaveBeenCalled()
  })

  it('continues without additional context after the template has been selected', async () => {
    const test = deps()
    const result = await runOfficeGenerationPipeline(brief({ additionalContext: undefined }), test.value)
    expect(result).toMatchObject({ status: 'completed' })
    expect(test.value.inspectUrl).not.toHaveBeenCalled()
    expect(test.value.construct).toHaveBeenCalled()
  })

  it('treats an unavailable reference URL as best-effort context', async () => {
    const test = deps()
    test.value.inspectUrl = vi.fn(async () => { throw new Error('Reference unavailable') })
    const result = await runOfficeGenerationPipeline(brief(), test.value)
    expect(result).toMatchObject({ status: 'completed' })
    expect(test.events).not.toContain('office.job.reference_url_inspected')
    expect(test.events).toContain('office.job.context_grounded')
    expect(test.value.construct).toHaveBeenCalled()
  })

  it('keeps sub-floor typography only when the same object was admitted by the template', async () => {
    const test = deps()
    const template = templateBundle()
    if (template.snapshot.family !== 'document') throw new Error('Expected document template')
    const admittedSnapshot = structuredClone(template.snapshot)
    const admittedRun = admittedSnapshot.sections[0].nodes[0]
    if (!('runs' in admittedRun)) throw new Error('Expected template text node')
    admittedRun.runs[0].style.fontSizePt = 7.5
    template.snapshot = admittedSnapshot
    test.value.selectTemplate = vi.fn(async () => ({ template: { ...template, status: 'admitted' as const } }))
    test.value.construct = vi.fn(async () => structuredClone(admittedSnapshot))

    const admittedResult = await runOfficeGenerationPipeline(brief(), test.value)
    expect(admittedResult, JSON.stringify(admittedResult)).toMatchObject({ status: 'completed' })

    const refilled = structuredClone(admittedSnapshot)
    const refilledNode = refilled.sections[0].nodes[0]
    if (!('runs' in refilledNode)) throw new Error('fixture')
    refilledNode.runs[0].text = 'New generated facts at the same ID'
    test.value.construct = vi.fn(async () => refilled)
    await expect(runOfficeGenerationPipeline(brief(), test.value)).resolves.toMatchObject({ status: 'failed', code: 'fit_failed' })

    const changed = structuredClone(admittedSnapshot)
    const changedRun = changed.sections[0].nodes[0]
    if (!('runs' in changedRun)) throw new Error('Expected generated text node')
    changedRun.runs[0].id = id(999)
    test.value.construct = vi.fn(async () => changed)
    await expect(runOfficeGenerationPipeline(brief(), test.value)).resolves.toMatchObject({ status: 'failed', code: 'fit_failed' })
  })

  it('preserves a typed safe failure code from a generation constructor', async () => {
    const test = deps()
    test.value.construct = vi.fn(async () => {
      throw new OfficeGenerationFailure('presentation_fit_failed', 'Internal presentation fit diagnostics')
    })

    await expect(runOfficeGenerationPipeline(brief(), test.value)).resolves.toMatchObject({
      status: 'failed',
      code: 'presentation_fit_failed',
    })
  })
})

describe('[COMP:office/generation] Explicit Office revision lane', () => {
  it('turns comment access and overlapping targets into proposals', async () => {
    const snapshot = documentSnapshot()
    const targetId = snapshot.sections[0].nodes[0].id
    const command = { commandId: id(90), artifactId: snapshot.artifactId, baseVersion: 1, actor: { type: 'assistant' as const, id: id(91) }, origin: 'ai' as const, kind: 'deleteObject' as const, targetId }
    const base = { artifactId: snapshot.artifactId, assistantId: id(91), baseVersion: 1, currentVersion: 2, instruction: 'Remove it', targetIds: [targetId], threadExcerpt: [], templateConstraints: [], evidencePacket: [], snapshot }
    await expect(runOfficeEdit({ ...base, role: 'comment', changedObjectIdsSinceBase: [] }, async () => [command])).resolves.toMatchObject({ mode: 'proposal', reason: 'comment_role' })
    await expect(runOfficeEdit({ ...base, role: 'edit', changedObjectIdsSinceBase: [targetId] }, async () => [command])).resolves.toMatchObject({ mode: 'proposal', reason: 'overlap_conflict' })
  })

  it('applies only commands attributed to the authorized Brian assistant', async () => {
    const snapshot = documentSnapshot()
    snapshot.sections[0].footer = [{ id: id(999), text: 'BRAND', style: { fontFamily: 'Arial', fontSizePt: 7.5, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }]
    const targetId = snapshot.sections[0].nodes[0].id
    const base = { artifactId: snapshot.artifactId, assistantId: id(91), baseVersion: 1, currentVersion: 1, role: 'edit' as const, instruction: 'Remove it', targetIds: [targetId], changedObjectIdsSinceBase: [], threadExcerpt: [], templateConstraints: [], evidencePacket: [], snapshot }
    const valid = { commandId: id(90), artifactId: snapshot.artifactId, baseVersion: 1, actor: { type: 'assistant' as const, id: id(91) }, origin: 'ai' as const, kind: 'deleteObject' as const, targetId }
    await expect(runOfficeEdit(base, async () => [valid])).resolves.toMatchObject({ mode: 'direct', reason: 'applied', affectedObjectIds: [targetId] })
    await expect(runOfficeEdit(base, async () => [{ ...valid, actor: { type: 'assistant' as const, id: id(92) } }])).rejects.toThrow('actor does not match')
  })
})
