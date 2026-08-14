import { createHash } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { completePresentationSnapshot, id } from '../../../../core/src/office/__tests__/fixtures.js'
import { officeOfflineRoutes, type OfficeOfflineRouteDeps } from '../office-offline.js'

const USER = id(801)
const HEAD = id(802)

describe('[COMP:api/office-resources] Office offline resource package', () => {
  it('packages the exact bytes named by the admitted snapshot hash', async () => {
    const snapshot = completePresentationSnapshot()
    const image = snapshot.resources.find((resource) => resource.kind === 'image')!
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const hash = createHash('sha256').update(bytes).digest('hex')
    image.hash = hash
    snapshot.resources = [image]
    snapshot.slides[0].objects = snapshot.slides[0].objects.filter((object) => object.kind !== 'video')
    snapshot.slides[0].readingOrder = snapshot.slides[0].readingOrder.filter((id) => snapshot.slides[0].objects.some((object) => object.id === id))
    const savePackage = vi.fn(async () => id(803))
    const upsert = vi.fn(async () => ({ id: id(804) }))
    const deps: OfficeOfflineRouteDeps = {
      signingSecret: 'fixture-signing-secret',
      load: vi.fn(async () => ({
        artifact: { id: snapshot.artifactId, workspaceId: snapshot.workspaceId, family: 'presentation', mode: 'artifact', title: snapshot.title, headVersion: 4, headVersionId: HEAD, lifecycleState: 'active' },
        access: { role: 'edit' }, snapshot, update: new Uint8Array([1, 2]), stateVector: new Uint8Array([3]), seq: 4, comments: [], history: [],
      } as never)),
      readResource: vi.fn(async (_userId, _workspaceId, resourceId) => resourceId === image.id ? { bytes, mime: image.mime, hash } : null),
      savePackage,
      upsert,
      resolveAccess: vi.fn(), appendCommand: vi.fn(),
    }
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { (req as { userId?: string }).userId = USER; next() })
    app.use('/api/office', officeOfflineRoutes(deps))

    const response = await request(app).post(`/api/office/artifacts/${snapshot.artifactId}/offline-packages`).send({ deviceId: 'fixture-device', pinned: true, expectedVersion: 4 }).expect(201)
    expect(response.body.manifest.resourceHashes).toContainEqual({ id: image.id, hash })
    expect(response.body.payload.snapshot.resources).toContainEqual(expect.objectContaining({ id: image.id, hash }))
    const packaged = response.body.payload.resources.find((entry: { id: string }) => entry.id === image.id)
    expect(packaged).toMatchObject({ id: image.id, mime: image.mime, hash })
    expect(createHash('sha256').update(Buffer.from(packaged.bytes, 'base64')).digest('hex')).toBe(hash)
    expect(savePackage).toHaveBeenCalledWith(expect.objectContaining({ artifactId: snapshot.artifactId, bytes: expect.any(Uint8Array) }))
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ resourceHashes: expect.arrayContaining([{ id: image.id, hash }]) }) }))
  })
})
