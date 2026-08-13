import { createHash } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { NormalizedOfficeImage } from '@use-brian/core'
import { officeResourceRoutes, type OfficeResourceRouteDeps } from '../office-resources.js'

const USER = '20000000-0000-4000-8000-000000000001'
const WORKSPACE = '20000000-0000-4000-8000-000000000002'
const ARTIFACT = '20000000-0000-4000-8000-000000000003'
const FILE = '20000000-0000-4000-8000-000000000004'
const RESOURCE = '20000000-0000-4000-8000-000000000005'

function server(overrides: Partial<OfficeResourceRouteDeps> = {}, authenticated = true) {
  const bytes = new Uint8Array([1, 2, 3])
  const image: NormalizedOfficeImage = { bytes, hash: createHash('sha256').update(bytes).digest('hex'), mime: 'image/png', widthPx: 3, heightPx: 2 }
  const deps: OfficeResourceRouteDeps = {
    load: vi.fn(async () => ({ artifact: { id: ARTIFACT, workspaceId: WORKSPACE, lifecycleState: 'active', sensitivity: 'internal' }, access: { canEdit: true }, snapshot: { resources: [] } } as never)),
    readUpload: vi.fn(async () => ({ bytes, sensitivity: 'internal' as const })),
    normalizeImage: vi.fn(async () => image),
    persistImage: vi.fn(async () => ({ id: RESOURCE })),
    readResource: vi.fn(async () => ({ bytes, mime: image.mime, hash: image.hash })),
    ...overrides,
  }
  const app = express(); app.use(express.json()); if (authenticated) app.use((req, _res, next) => { (req as { userId?: string }).userId = USER; next() }); app.use('/api/office', officeResourceRoutes(deps))
  return { app, deps, image }
}

describe('[COMP:api/office-resources] Office image admission', () => {
  it('requires authentication for admission and reads', async () => {
    const test = server({}, false)
    await request(test.app).post(`/api/office/artifacts/${ARTIFACT}/resources`).send({ fileId: FILE, kind: 'image' }).expect(401, { error: 'Unauthorized' })
    await request(test.app).get(`/api/office/artifacts/${ARTIFACT}/resources/${RESOURCE}`).expect(401, { error: 'Unauthorized' })
  })

  it('admits normalized bytes and returns the canonical resource and dimensions', async () => {
    const test = server()
    const response = await request(test.app).post(`/api/office/artifacts/${ARTIFACT}/resources`).send({ fileId: FILE, kind: 'image' }).expect(201)
    expect(response.body).toEqual({ resource: { id: RESOURCE, kind: 'image', hash: test.image.hash, mime: 'image/png', sensitivity: 'internal' }, widthPx: 3, heightPx: 2 })
    expect(test.deps.persistImage).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, workspaceId: WORKSPACE, artifactId: ARTIFACT, image: test.image }))
    expect(test.image.hash).toBe(createHash('sha256').update(test.image.bytes).digest('hex'))
  })

  it.each([
    ['missing artifact', { load: vi.fn(async () => null) }, 404, 'Office artifact not found'],
    ['inactive artifact', { load: vi.fn(async () => ({ artifact: { workspaceId: WORKSPACE, lifecycleState: 'trash' }, access: { canEdit: true }, snapshot: { resources: [] } } as never)) }, 409, 'office_artifact_inactive'],
    ['view role', { load: vi.fn(async () => ({ artifact: { workspaceId: WORKSPACE, lifecycleState: 'active' }, access: { canEdit: false, role: 'view' }, snapshot: { resources: [] } } as never)) }, 403, 'office_edit_required'],
    ['comment role', { load: vi.fn(async () => ({ artifact: { workspaceId: WORKSPACE, lifecycleState: 'active' }, access: { canEdit: false, role: 'comment' }, snapshot: { resources: [] } } as never)) }, 403, 'office_edit_required'],
    ['wrong workspace upload', { readUpload: vi.fn(async () => null) }, 404, 'office_image_source_unavailable'],
  ] as const)('rejects %s', async (_label, overrides, status, error) => {
    await request(server(overrides).app).post(`/api/office/artifacts/${ARTIFACT}/resources`).send({ fileId: FILE, kind: 'image' }).expect(status, { error })
  })

  it('rejects oversize, spoofed, and unsupported image input with owned codes', async () => {
    await request(server({ readUpload: vi.fn(async () => ({ bytes: new Uint8Array(20 * 1024 * 1024 + 1), sensitivity: 'internal' as const })) }).app).post(`/api/office/artifacts/${ARTIFACT}/resources`).send({ fileId: FILE, kind: 'image' }).expect(413, { error: 'office_image_too_large' })
    await request(server({ normalizeImage: vi.fn(async () => { throw new Error('office_image_invalid') }) }).app).post(`/api/office/artifacts/${ARTIFACT}/resources`).send({ fileId: FILE, kind: 'image' }).expect(415, { error: 'office_image_invalid' })
    await request(server({ normalizeImage: vi.fn(async () => { throw new Error('office_image_unsupported') }) }).app).post(`/api/office/artifacts/${ARTIFACT}/resources`).send({ fileId: FILE, kind: 'image' }).expect(415, { error: 'office_image_unsupported' })
  })

  it('returns the same content-addressed reference when admission deduplicates', async () => {
    const test = server()
    const path = `/api/office/artifacts/${ARTIFACT}/resources`
    const first = await request(test.app).post(path).send({ fileId: FILE, kind: 'image' }).expect(201)
    const second = await request(test.app).post(path).send({ fileId: FILE, kind: 'image' }).expect(201)
    expect(second.body).toEqual(first.body)
    expect(test.deps.persistImage).toHaveBeenCalledTimes(2)
    expect(test.deps.persistImage).toHaveBeenNthCalledWith(2, expect.objectContaining({ image: expect.objectContaining({ hash: test.image.hash }) }))
  })

  it('retains the stricter source sensitivity on admission', async () => {
    const test = server({ readUpload: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), sensitivity: 'confidential' as const })) })
    vi.mocked(test.deps.persistImage).mockResolvedValue({ id: RESOURCE, sensitivity: 'confidential' })
    const response = await request(test.app).post(`/api/office/artifacts/${ARTIFACT}/resources`).send({ fileId: FILE, kind: 'image' }).expect(201)
    expect(test.deps.persistImage).toHaveBeenCalledWith(expect.objectContaining({ sensitivity: 'confidential' }))
    expect(response.body.resource.sensitivity).toBe('confidential')
  })

  it('serves only exact persisted bytes referenced by the live snapshot', async () => {
    const test = server()
    vi.mocked(test.deps.load).mockResolvedValue({ artifact: { workspaceId: WORKSPACE }, snapshot: { resources: [{ id: RESOURCE, hash: test.image.hash, mime: test.image.mime }] } } as never)
    const response = await request(test.app).get(`/api/office/artifacts/${ARTIFACT}/resources/${RESOURCE}`).expect(200)
    expect(Buffer.from(response.body)).toEqual(Buffer.from(test.image.bytes))
    await request(server({ readResource: vi.fn(async () => ({ bytes: new Uint8Array([9]), mime: test.image.mime, hash: test.image.hash })), load: vi.fn(async () => ({ artifact: { workspaceId: WORKSPACE }, snapshot: { resources: [{ id: RESOURCE, hash: test.image.hash, mime: test.image.mime }] } } as never)) }).app).get(`/api/office/artifacts/${ARTIFACT}/resources/${RESOURCE}`).expect(409, { error: 'office_resource_incomplete', resourceId: RESOURCE })
  })
})
