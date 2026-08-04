import { describe, expect, it, vi } from 'vitest'
import { runOfficeGenerationPipeline, type OfficeGenerationPipelineDeps } from '../generation/pipeline.js'
import { documentSnapshot, id, templateBundle } from './fixtures.js'

function brief(overrides: Record<string, unknown> = {}) {
  return { workspaceId: id(2), actingUserId: id(80), assistantId: id(81), family: 'document', outcome: 'Create a board update', audience: 'Board', sourceHandles: ['page:plan'], requestedSensitivityFloor: 'internal', canonicalWebsite: 'https://example.com', companyHasNoWebsite: false, idempotencyKey: 'request-12345678', ...overrides }
}

function deps() {
  const events: string[] = []
  const checkpoints: string[] = []
  const value: OfficeGenerationPipelineDeps = {
    resolveAuthority: vi.fn(async () => ({ sensitivity: 'internal' as const, visibilityUserIds: [], compartments: [], sourceHandles: ['page:plan'] })),
    selectTemplate: vi.fn(async () => ({ template: { ...templateBundle(), status: 'admitted' as const } })),
    retrieveBrain: vi.fn(async () => [{ handle: 'page:plan', excerpt: 'ARR grew.', sensitivity: 'internal' as const }]),
    inspectWebsite: vi.fn(async (url) => [{ url, excerpt: 'Acme builds dependable software.' }]),
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
    expect(test.events).toContain('office.job.website_inspected')
    expect(test.events.at(-1)).toBe('office.job.completed')
    expect(test.checkpoints).toEqual(['queued', 'template', 'grounding', 'claim_plan', 'construct', 'media', 'fit_render', 'validate', 'export_reparse', 'completed'])
  })

  it('stops at the mandatory website gate without replaying later work', async () => {
    const test = deps()
    const result = await runOfficeGenerationPipeline(brief({ canonicalWebsite: undefined }), test.value)
    expect(result).toMatchObject({ status: 'needs_input', code: 'website_required' })
    expect(test.value.retrieveBrain).not.toHaveBeenCalled()
    expect(test.value.construct).not.toHaveBeenCalled()
  })
})
