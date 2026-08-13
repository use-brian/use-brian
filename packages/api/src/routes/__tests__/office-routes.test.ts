import { createHash } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { officeArtifactRoutes } from '../office-artifacts.js'
import { officeJobRoutes } from '../office-jobs.js'
import { officeTemplateRoutes } from '../office-templates.js'
import { internalOfficeCheckpointRoutes } from '../internal-office-checkpoint.js'
import { officeOfflineRoutes } from '../office-offline.js'
import { officeResourceRoutes } from '../office-resources.js'
import { OfficeGenerationUnavailableError } from '../../office/service.js'
import { guidedTemplateSnapshot } from '../office-templates.js'
import { OfficeArtifactSnapshotSchema, preflightOfficeCandidate } from '@use-brian/office-model'

const USER = '20000000-0000-4000-8000-000000000001'
const WORKSPACE = '20000000-0000-4000-8000-000000000002'
const ASSISTANT = '20000000-0000-4000-8000-000000000003'
const ARTIFACT = '20000000-0000-4000-8000-000000000004'
const JOB = '20000000-0000-4000-8000-000000000005'
const RESOURCE = '20000000-0000-4000-8000-000000000006'

function app() {
  const server = express()
  server.use(express.json())
  server.use((req, _res, next) => { (req as { userId?: string }).userId = USER; next() })
  const projection = { artifactId: ARTIFACT, family: 'document' as const, title: 'Report', version: 0, lifecycleState: 'active' as const, role: 'edit' as const, job: { id: JOB, status: 'queued', stage: 'queued', errorCode: null } }
  const service = {
    create: vi.fn(async () => ({ artifactId: ARTIFACT, jobId: JOB })),
    get: vi.fn(async () => projection),
    revise: vi.fn(async () => ({ jobId: JOB, mode: 'direct' as const })),
  }
  const job = { id: JOB, workspaceId: WORKSPACE, artifactId: ARTIFACT, initiatedByUserId: USER, assistantId: ASSISTANT, jobKind: 'create' as const, status: 'running' as const, stage: 'grounding', brief: {}, authorityProjection: {}, templateVersionId: null, baseArtifactVersion: 0, checkpoint: {}, checkpointVersion: 2, leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() }
  const artifacts = { service, generationAvailable: vi.fn(() => true), list: vi.fn(async () => [projection]), restoreVersion: vi.fn(async () => ({ id: 'v2', version: 2 })), getArtifact: vi.fn(async () => ({ id: ARTIFACT } as never)), listVersions: vi.fn(async () => []), canRestoreVersion: vi.fn(async () => true) }
  const jobs = { get: vi.fn(async () => job), events: vi.fn(async () => [{ seq: 1, code: 'office.job.queued' } as never]), steer: vi.fn(async () => ({ id: 'steer-1' })), cancel: vi.fn(async () => true) }
  const templates = {
    list: vi.fn(async () => []),
    getTemplate: vi.fn(async () => ({ id: 'template-1', workspaceId: WORKSPACE, family: 'document' as const, name: 'Pitch', lifecycleState: 'draft' as const, draftArtifactId: ARTIFACT })),
    getArtifact: vi.fn(async () => ({ id: ARTIFACT, workspaceId: WORKSPACE, family: 'document', mode: 'template', title: 'Pitch', headVersion: 0, headVersionId: null, lifecycleState: 'active' } as never)),
    getSnapshot: vi.fn(async () => null),
    createDraft: vi.fn(async () => ({ id: 'template-1' })),
    createTemplateShell: vi.fn(async () => ({ id: ARTIFACT })),
    initializeDraft: vi.fn(async () => true),
    getDraftRouting: vi.fn(async () => null),
    saveDraftRouting: vi.fn(async () => true),
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
    await request(test.server).get('/api/office/capabilities').expect(200, { generationAvailable: true, generationFamilies: ['document', 'presentation', 'spreadsheet'] })
    await request(test.server).post('/api/office/artifacts').send({ workspaceId: WORKSPACE, assistantId: ASSISTANT, family: 'document', outcome: 'Create a board report', audience: 'Board', additionalContext: 'Use the approved Q2 figures.', sourceHandles: [], idempotencyKey: 'request-12345678' }).expect(202, { artifactId: ARTIFACT, jobId: JOB })
    expect(test.artifacts.service.create).toHaveBeenCalledWith(expect.objectContaining({ additionalContext: 'Use the approved Q2 figures.' }))
    const read = await request(test.server).get(`/api/office/artifacts/${ARTIFACT}`).expect(200)
    expect(read.body.artifact).toMatchObject({ artifactId: ARTIFACT, role: 'edit', job: { id: JOB, stage: 'queued', errorCode: null } })
  })

  it('lets an active editor restore an earlier artifact version', async () => {
    const test = app()
    const response = await request(test.server).post(`/api/office/artifacts/${ARTIFACT}/restore`).send({ targetVersionId: RESOURCE, expectedVersion: 1, summary: 'Restore the previous revision' }).expect(200)
    expect(response.body).toEqual({ version: { id: 'v2', version: 2 } })
    expect(test.artifacts.canRestoreVersion).toHaveBeenCalledWith(USER, ARTIFACT)
    expect(test.artifacts.restoreVersion).toHaveBeenCalledWith({ userId: USER, artifactId: ARTIFACT, targetVersionId: RESOURCE, expectedVersion: 1, summary: 'Restore the previous revision' })
  })

  it('supports late-join events, attributed steering, cancellation, and template drafts', async () => {
    const test = app()
    const events = await request(test.server).get(`/api/office/jobs/${JOB}/events?afterSeq=0`).expect(200)
    expect(events.body.events[0]).toMatchObject({ code: 'office.job.queued' })
    await request(test.server).post(`/api/office/jobs/${JOB}/steering`).send({ instruction: 'Emphasize retention' }).expect(202)
    expect(test.jobs.steer).toHaveBeenCalledWith({ userId: USER, workspaceId: WORKSPACE, jobId: JOB, instruction: 'Emphasize retention' })
    await request(test.server).post(`/api/office/jobs/${JOB}/cancel`).send({}).expect(202)
    await request(test.server).post('/api/office/templates').send({ workspaceId: WORKSPACE, family: 'presentation', name: 'Pitch', description: 'Company pitch', creationMethod: 'guided', canonicalWebsite: 'https://example.com', sensitivity: 'internal' }).expect(201)
    expect(test.templates.createDraft).toHaveBeenCalledWith(expect.objectContaining({ draftArtifactId: ARTIFACT }))
    expect(test.templates.initializeDraft).toHaveBeenCalledWith(expect.objectContaining({ artifactId: ARTIFACT, snapshot: expect.objectContaining({ artifactId: ARTIFACT, family: 'presentation', templateVersionId: null, slides: expect.arrayContaining([expect.objectContaining({ title: 'Title' }), expect.objectContaining({ title: 'Content' })]) }) }))
    expect(test.templates.saveDraftRouting).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'template-1', routing: expect.objectContaining({ source: 'guided', slideRecipes: expect.arrayContaining([expect.objectContaining({ role: 'cover' })]) }) }))
  })

  it('lets a member inspect and adjust inferred slide routing before publish', async () => {
    const test = app()
    const snapshot = guidedTemplateSnapshot({ artifactId: ARTIFACT, workspaceId: WORKSPACE, family: 'presentation', title: 'Company deck', guidance: 'Use for company introductions.' })
    test.templates.getTemplate.mockResolvedValue({ id: 'template-1', workspaceId: WORKSPACE, family: 'presentation', name: 'Company deck', lifecycleState: 'draft', draftArtifactId: ARTIFACT } as never)
    test.templates.getSnapshot.mockResolvedValue({ snapshot, seq: 1, baseVersion: 0 } as never)
    const inferred = await request(test.server).get('/api/office/templates/template-1/routing').expect(200)
    expect(inferred.body.routing).toMatchObject({ source: 'scratch', slideRecipes: [{ role: 'cover' }, { role: 'section' }] })

    const adjusted = structuredClone(inferred.body.routing)
    adjusted.slideRecipes[1].role = 'comparison'
    adjusted.slideRecipes[1].whenToUse = 'Use when comparing two supported alternatives.'
    adjusted.slideRecipes[1].reviewed = true
    await request(test.server).put('/api/office/templates/template-1/routing').send({ routing: adjusted }).expect(200)
    expect(test.templates.saveDraftRouting).toHaveBeenLastCalledWith({ userId: USER, templateId: 'template-1', routing: adjusted })

    adjusted.fields[0].targetIds = ['20000000-0000-4000-8000-000000000099']
    await request(test.server).put('/api/office/templates/template-1/routing').send({ routing: adjusted }).expect(400)
  })

  it('seeds guided template drafts with editable canonical structure', () => {
    const document = guidedTemplateSnapshot({ artifactId: ARTIFACT, workspaceId: WORKSPACE, family: 'document', title: 'Letterhead', guidance: 'Formal letters with company contact details.', canonicalWebsite: 'https://example.com' })
    expect(() => OfficeArtifactSnapshotSchema.parse(document)).not.toThrow()
    expect(preflightOfficeCandidate(document).ok).toBe(true)
    expect(document.family).toBe('document')
    if (document.family === 'document') {
      expect(document.sections[0].nodes).toMatchObject([{ kind: 'heading' }, { kind: 'paragraph' }, { kind: 'heading' }, { kind: 'paragraph' }])
      expect(document.sections[0].footer[0]?.text).toBe('https://example.com')
    }

    const presentation = guidedTemplateSnapshot({ artifactId: ARTIFACT, workspaceId: WORKSPACE, family: 'presentation', title: 'Company deck', guidance: 'Use for general introductions and updates.' })
    expect(() => OfficeArtifactSnapshotSchema.parse(presentation)).not.toThrow()
    expect(preflightOfficeCandidate(presentation).ok).toBe(true)
    expect(presentation.family).toBe('presentation')
    if (presentation.family === 'presentation') expect(presentation.slides.map((slide) => slide.title)).toEqual(['Title', 'Content'])
  })

  it('accepts an explicit no-website choice during guided template setup', async () => {
    const test = app()
    await request(test.server).post('/api/office/templates').send({ workspaceId: WORKSPACE, family: 'document', name: 'Internal memo', description: 'Internal company updates', creationMethod: 'guided', companyHasNoWebsite: true, sensitivity: 'internal' }).expect(201)
    expect(test.templates.initializeDraft).toHaveBeenCalledWith(expect.objectContaining({ snapshot: expect.objectContaining({ family: 'document' }) }))
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
    await request(test.server).post('/api/office/templates').send({ workspaceId: WORKSPACE, family: 'document', name: 'Letterhead', description: 'Company letters', creationMethod: 'guided', sensitivity: 'internal' }).expect(400)
    await request(test.server).post(`/api/office/jobs/${JOB}/steering`).send({ instruction: '' }).expect(400)
    expect(test.artifacts.service.create).not.toHaveBeenCalled()
  })

  it('returns a typed retryable error when no generation runner is configured', async () => {
    const test = app()
    test.artifacts.service.create.mockRejectedValueOnce(new OfficeGenerationUnavailableError())
    await request(test.server).post('/api/office/artifacts').send({ workspaceId: WORKSPACE, assistantId: ASSISTANT, family: 'presentation', outcome: 'Company introduction', audience: 'Public', sourceHandles: [], idempotencyKey: 'request-12345678' }).expect(503, { error: 'office_generation_unavailable' })
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

describe('[COMP:api/office-routes] Office artifact resources', () => {
  it('serves only a live snapshot resource whose bytes match its immutable hash', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const hash = createHash('sha256').update(bytes).digest('hex')
    const load = vi.fn(async () => ({
      artifact: { id: ARTIFACT, workspaceId: WORKSPACE },
      snapshot: { resources: [{ id: RESOURCE, hash, mime: 'image/png' }] },
    } as never))
    const readResource = vi.fn(async () => ({ bytes, hash, mime: 'image/png' }))
    const server = express()
    server.use((req, _res, next) => { (req as { userId?: string }).userId = USER; next() })
    server.use('/api/office', officeResourceRoutes({
      load,
      readResource,
      readUpload: vi.fn(),
      persistImage: vi.fn(),
    } as never))

    const response = await request(server).get(`/api/office/artifacts/${ARTIFACT}/resources/${RESOURCE}`).expect(200)
    expect(response.headers['content-type']).toMatch(/^image\/png/)
    expect(response.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(Buffer.from(response.body)).toEqual(Buffer.from(bytes))
    expect(readResource).toHaveBeenCalledWith(USER, WORKSPACE, RESOURCE)

    await request(server).get(`/api/office/artifacts/${ARTIFACT}/resources/20000000-0000-4000-8000-000000000099`).expect(404)
    expect(readResource).toHaveBeenCalledOnce()
  })

  it('refuses corrupt resource bytes', async () => {
    const expectedHash = createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex')
    const server = express()
    server.use((req, _res, next) => { (req as { userId?: string }).userId = USER; next() })
    server.use('/api/office', officeResourceRoutes({
      load: vi.fn(async () => ({ artifact: { workspaceId: WORKSPACE }, snapshot: { resources: [{ id: RESOURCE, hash: expectedHash, mime: 'image/png' }] } } as never)),
      readResource: vi.fn(async () => ({ bytes: new Uint8Array([9]), hash: expectedHash, mime: 'image/png' })),
      readUpload: vi.fn(),
      persistImage: vi.fn(),
    } as never))

    await request(server).get(`/api/office/artifacts/${ARTIFACT}/resources/${RESOURCE}`).expect(409, { error: 'office_resource_incomplete', resourceId: RESOURCE })
  })
})
