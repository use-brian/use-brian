import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { officeArtifactRoutes } from '../office-artifacts.js'
import { officeJobRoutes } from '../office-jobs.js'
import { officeTemplateRoutes } from '../office-templates.js'
import { internalOfficeCheckpointRoutes } from '../internal-office-checkpoint.js'
import { OfficeGenerationUnavailableError } from '../../office/service.js'
import { guidedTemplateSnapshot } from '../office-templates.js'
import { OfficeArtifactSnapshotSchema, preflightOfficeCandidate } from '@use-brian/office-model'

const USER = '20000000-0000-4000-8000-000000000001'
const WORKSPACE = '20000000-0000-4000-8000-000000000002'
const ASSISTANT = '20000000-0000-4000-8000-000000000003'
const ARTIFACT = '20000000-0000-4000-8000-000000000004'
const JOB = '20000000-0000-4000-8000-000000000005'

function app() {
  const server = express()
  server.use(express.json())
  server.use((req, _res, next) => { (req as { userId?: string }).userId = USER; next() })
  const projection = { artifactId: ARTIFACT, family: 'document' as const, title: 'Report', version: 0, lifecycleState: 'active' as const, role: 'edit' as const, job: { id: JOB, status: 'queued', stage: 'queued' } }
  const service = {
    create: vi.fn(async () => ({ artifactId: ARTIFACT, jobId: JOB })),
    get: vi.fn(async () => projection),
    revise: vi.fn(async () => ({ jobId: JOB, mode: 'direct' as const })),
  }
  const job = { id: JOB, workspaceId: WORKSPACE, artifactId: ARTIFACT, initiatedByUserId: USER, assistantId: ASSISTANT, jobKind: 'create' as const, status: 'running' as const, stage: 'grounding', brief: {}, authorityProjection: {}, templateVersionId: null, baseArtifactVersion: 0, checkpoint: {}, checkpointVersion: 2, leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() }
  const artifacts = { service, generationAvailable: vi.fn(() => true), list: vi.fn(async () => [projection]), restoreVersion: vi.fn(async () => ({ id: 'v2', version: 2 })), getArtifact: vi.fn(async () => ({ id: ARTIFACT } as never)), listVersions: vi.fn(async () => []), canRestore: vi.fn(async () => true) }
  const jobs = { get: vi.fn(async () => job), events: vi.fn(async () => [{ seq: 1, code: 'office.job.queued' } as never]), steer: vi.fn(async () => ({ id: 'steer-1' })), cancel: vi.fn(async () => true) }
  const templates = {
    list: vi.fn(async () => []),
    getTemplate: vi.fn(async () => ({ id: 'template-1', workspaceId: WORKSPACE, family: 'document' as const, name: 'Pitch', lifecycleState: 'draft' as const, draftArtifactId: ARTIFACT })),
    getArtifact: vi.fn(async () => ({ id: ARTIFACT, workspaceId: WORKSPACE, family: 'document', mode: 'template', title: 'Pitch', headVersion: 0, headVersionId: null, lifecycleState: 'active' } as never)),
    getSnapshot: vi.fn(async () => null),
    createDraft: vi.fn(async () => ({ id: 'template-1' })),
    createTemplateShell: vi.fn(async () => ({ id: ARTIFACT })),
    initializeDraft: vi.fn(async () => true),
    deleteEmptyDraft: vi.fn(async () => true),
    deleteEmptyShell: vi.fn(async () => true),
    createCompileJob: vi.fn(async () => ({ id: JOB })),
    transitionLifecycle: vi.fn(async () => ({ id: 'template-1', lifecycleState: 'deprecated' })),
  }
  server.use('/api/office', officeArtifactRoutes(artifacts))
  server.use('/api/office', officeJobRoutes(jobs))
  server.use('/api/office', officeTemplateRoutes(templates))
  return { server, artifacts, jobs, templates }
}

describe('[COMP:api/office-routes] Office API routes', () => {
  it('creates a shell/job and exposes permission-filtered artifact state', async () => {
    const test = app()
    await request(test.server).get('/api/office/capabilities').expect(200, { generationAvailable: true })
    await request(test.server).post('/api/office/artifacts').send({ workspaceId: WORKSPACE, assistantId: ASSISTANT, family: 'document', outcome: 'Create a board report', audience: 'Board', sourceHandles: [], canonicalWebsite: 'https://example.com', companyHasNoWebsite: false, idempotencyKey: 'request-12345678' }).expect(202, { artifactId: ARTIFACT, jobId: JOB })
    const read = await request(test.server).get(`/api/office/artifacts/${ARTIFACT}`).expect(200)
    expect(read.body.artifact).toMatchObject({ artifactId: ARTIFACT, role: 'edit', job: { id: JOB, stage: 'queued' } })
  })

  it('supports late-join events, attributed steering, cancellation, and template drafts', async () => {
    const test = app()
    const events = await request(test.server).get(`/api/office/jobs/${JOB}/events?afterSeq=0`).expect(200)
    expect(events.body.events[0]).toMatchObject({ code: 'office.job.queued' })
    await request(test.server).post(`/api/office/jobs/${JOB}/steering`).send({ instruction: 'Emphasize retention' }).expect(202)
    expect(test.jobs.steer).toHaveBeenCalledWith({ userId: USER, workspaceId: WORKSPACE, jobId: JOB, instruction: 'Emphasize retention' })
    await request(test.server).post(`/api/office/jobs/${JOB}/cancel`).send({}).expect(202)
    await request(test.server).post('/api/office/templates').send({ workspaceId: WORKSPACE, family: 'presentation', name: 'Pitch', description: 'Company pitch', creationMethod: 'guided', sensitivity: 'internal' }).expect(201)
    expect(test.templates.createDraft).toHaveBeenCalledWith(expect.objectContaining({ draftArtifactId: ARTIFACT }))
    expect(test.templates.initializeDraft).toHaveBeenCalledWith(expect.objectContaining({ artifactId: ARTIFACT, snapshot: expect.objectContaining({ artifactId: ARTIFACT, family: 'presentation', templateVersionId: null, slides: expect.arrayContaining([expect.objectContaining({ title: 'Title' }), expect.objectContaining({ title: 'Content' })]) }) }))
  })

  it('seeds guided template drafts with editable canonical structure', () => {
    const document = guidedTemplateSnapshot({ artifactId: ARTIFACT, workspaceId: WORKSPACE, family: 'document', title: 'Letterhead', guidance: 'Formal letters with company contact details.' })
    expect(() => OfficeArtifactSnapshotSchema.parse(document)).not.toThrow()
    expect(preflightOfficeCandidate(document).ok).toBe(true)
    expect(document.family).toBe('document')
    if (document.family === 'document') expect(document.sections[0].nodes).toMatchObject([{ kind: 'heading' }, { kind: 'paragraph' }, { kind: 'heading' }, { kind: 'paragraph' }])

    const presentation = guidedTemplateSnapshot({ artifactId: ARTIFACT, workspaceId: WORKSPACE, family: 'presentation', title: 'Company deck', guidance: 'Use for general introductions and updates.' })
    expect(() => OfficeArtifactSnapshotSchema.parse(presentation)).not.toThrow()
    expect(preflightOfficeCandidate(presentation).ok).toBe(true)
    expect(presentation.family).toBe('presentation')
    if (presentation.family === 'presentation') expect(presentation.slides.map((slide) => slide.title)).toEqual(['Title', 'Content'])
  })

  it('idempotently initializes a linked legacy template draft', async () => {
    const test = app()
    const live = { snapshot: { family: 'document' }, seq: 1, baseVersion: 0 }
    test.templates.getSnapshot.mockResolvedValueOnce(null).mockResolvedValueOnce(live as never)
    await request(test.server).post('/api/office/templates/template-1/draft/initialize').send({ workspaceId: WORKSPACE, draftArtifactId: ARTIFACT }).expect(201, live)
    expect(test.templates.initializeDraft).toHaveBeenCalledOnce()
  })

  it('rejects invalid boundaries before touching stores', async () => {
    const test = app()
    await request(test.server).post('/api/office/artifacts').send({ workspaceId: 'bad' }).expect(400)
    await request(test.server).post(`/api/office/jobs/${JOB}/steering`).send({ instruction: '' }).expect(400)
    expect(test.artifacts.service.create).not.toHaveBeenCalled()
  })

  it('returns a typed retryable error when no generation runner is configured', async () => {
    const test = app()
    test.artifacts.service.create.mockRejectedValueOnce(new OfficeGenerationUnavailableError())
    await request(test.server).post('/api/office/artifacts').send({ workspaceId: WORKSPACE, assistantId: ASSISTANT, family: 'presentation', outcome: 'Company introduction', audience: 'Public', sourceHandles: [], canonicalWebsite: 'https://example.com', companyHasNoWebsite: false, idempotencyKey: 'request-12345678' }).expect(503, { error: 'office_generation_unavailable' })
  })
})

describe('[COMP:api/office-routes] Office checkpoint route', () => {
  it('authenticates doc-sync and commits the exact canonical CAS tuple', async () => {
    const server = express()
    server.use(express.json())
    const checkpoint = vi.fn(async () => ({ version: 5 }))
    server.use(internalOfficeCheckpointRoutes({ sharedSecret: 'sync-secret', checkpoint }))

    await request(server).post('/internal/office-checkpoint').send({ artifactId: ARTIFACT, expectedVersion: 4, canonicalHash: 'a'.repeat(64) }).expect(403)
    const response = await request(server).post('/internal/office-checkpoint').set('x-doc-sync-secret', 'sync-secret').send({ artifactId: ARTIFACT, expectedVersion: 4, canonicalHash: 'a'.repeat(64) }).expect(201)

    expect(response.body).toEqual({ version: 5 })
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(checkpoint).toHaveBeenCalledWith(ARTIFACT, 4, 'a'.repeat(64))
  })

  it('rejects malformed hashes and exposes CAS conflicts', async () => {
    const server = express()
    server.use(express.json())
    const checkpoint = vi.fn(async () => 'conflict' as const)
    server.use(internalOfficeCheckpointRoutes({ sharedSecret: 'sync-secret', checkpoint }))

    await request(server).post('/internal/office-checkpoint').set('x-doc-sync-secret', 'sync-secret').send({ artifactId: ARTIFACT, expectedVersion: 4, canonicalHash: 'bad' }).expect(400)
    await request(server).post('/internal/office-checkpoint').set('x-doc-sync-secret', 'sync-secret').send({ artifactId: ARTIFACT, expectedVersion: 4, canonicalHash: 'b'.repeat(64) }).expect(409, { error: 'version_conflict' })
  })
})
