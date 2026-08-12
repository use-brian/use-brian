import { describe, expect, it, vi } from 'vitest'
import { OfficeGenerationFailure } from '../generation/contracts.js'
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
    checkpoint: vi.fn(async (checkpoint) => { checkpoints.push(checkpoint.stage) }),
    emit: vi.fn(async (event) => { events.push(event.code) }),
    cancelled: vi.fn(async () => false),
    drainSteering: vi.fn(async () => []),
    commit: vi.fn(async (snapshot) => ({ artifactId: snapshot.artifactId, version: 1 })),
  }
  return { value, events, checkpoints }
}

describe('[COMP:office/generation] Office generation pipeline', () => {
  it('runs the ten durable stages and completes only after export/reopen', async () => {
    const test = deps()
    const result = await runOfficeGenerationPipeline(brief(), test.value)
    expect(result).toMatchObject({ status: 'completed', version: 1 })
    expect(test.events).toContain('office.job.reference_url_inspected')
    expect(test.events).toContain('office.job.context_grounded')
    expect(test.events.at(-1)).toBe('office.job.completed')
    expect(test.checkpoints).toEqual(['queued', 'template', 'grounding', 'claim_plan', 'construct', 'media', 'fit_render', 'validate', 'export_reparse', 'completed'])
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
    const base = { artifactId: snapshot.artifactId, baseVersion: 1, currentVersion: 2, instruction: 'Remove it', targetIds: [targetId], threadExcerpt: [], templateConstraints: [], evidencePacket: [], snapshot }
    await expect(runOfficeEdit({ ...base, role: 'comment', changedObjectIdsSinceBase: [] }, async () => [command])).resolves.toMatchObject({ mode: 'proposal', reason: 'comment_role' })
    await expect(runOfficeEdit({ ...base, role: 'edit', changedObjectIdsSinceBase: [targetId] }, async () => [command])).resolves.toMatchObject({ mode: 'proposal', reason: 'overlap_conflict' })
  })
})
