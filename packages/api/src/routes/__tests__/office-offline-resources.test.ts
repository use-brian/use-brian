import { createHash } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { OfficeCommand } from '@use-brian/office-model'
import { completePresentationSnapshot, id } from '../../../../core/src/office/__tests__/fixtures.js'
import { officeOfflineRoutes, type OfficeOfflineContext, type OfficeOfflineRouteDeps } from '../office-offline.js'

const USER = id(801)
const OTHER_USER = id(899)
const HEAD = id(802)
const FILE = id(803)
const RECORD = id(804)

function fixture() {
  const snapshot = completePresentationSnapshot()
  const image = snapshot.resources.find((resource) => resource.kind === 'image')!
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const hash = createHash('sha256').update(bytes).digest('hex')
  image.hash = hash
  snapshot.resources = [image]
  snapshot.slides[0].objects = snapshot.slides[0].objects.filter((object) => object.kind !== 'video')
  snapshot.slides[0].readingOrder = snapshot.slides[0].readingOrder.filter((objectId) => snapshot.slides[0].objects.some((object) => object.id === objectId))
  const artifact = { id: snapshot.artifactId, workspaceId: snapshot.workspaceId, family: 'presentation', mode: 'artifact', title: snapshot.title, headVersion: 4, headVersionId: HEAD, lifecycleState: 'active' } as OfficeOfflineContext['artifact']
  const context: OfficeOfflineContext = { artifact, access: { role: 'edit', canEdit: true } as never, snapshot, update: new Uint8Array([1, 2]), stateVector: new Uint8Array([3]), seq: 4, comments: [], history: [], validForMs: 25_000 }
  let savedManifestHash = ''
  const binding = { fileId: image.id, workspaceId: snapshot.workspaceId, scopeVersion: 'scope-1', mime: image.mime, hash, sensitivity: 'confidential' as const, compartments: [id(850)], projectIds: [id(851)] }
  const scope = { sensitivity: 'confidential' as const, compartments: binding.compartments, projectIds: binding.projectIds }
  const deps: OfficeOfflineRouteDeps = {
    signingSecret: 'fixture-signing-secret',
    load: vi.fn(async () => context),
    getArtifact: vi.fn(async () => artifact),
    readResource: vi.fn(async (_userId, _workspaceId, resourceId) => resourceId === image.id ? { bytes, mime: image.mime, hash, validForMs: 20_000, binding } : null),
    revalidatePackage: vi.fn(async () => ({ scope, validForMs: 20_000 })),
    savePackage: vi.fn(async () => FILE),
    upsert: vi.fn(async (params) => { savedManifestHash = params.manifestHash; return { id: RECORD } }),
    getPackage: vi.fn(async () => ({ artifactVersionId: HEAD, packageFileId: FILE, manifestHash: savedManifestHash, complete: true, revokedAt: null })),
    resolveAccess: vi.fn(async () => ({ role: 'edit', canEdit: true } as never)),
    syncCommands: vi.fn(async () => ({ snapshot, seq: 5, baseVersion: 4 })),
    createRecovery: vi.fn(async () => ({ artifactId: id(805) })),
  }
  return { snapshot, image, bytes, hash, binding, scope, artifact, context, deps }
}

function app(deps: OfficeOfflineRouteDeps) {
  const instance = express()
  instance.use(express.json({ limit: '5mb' }))
  instance.use((req, _res, next) => { (req as { userId?: string }).userId = USER; next() })
  instance.use('/api/office', officeOfflineRoutes(deps))
  return instance
}

function command(artifactId: string): OfficeCommand {
  return {
    artifactId,
    baseVersion: 4,
    actor: { type: 'user', id: OTHER_USER },
    origin: 'manual',
    commandId: id(820),
    kind: 'batch',
    commands: [{ artifactId, baseVersion: 4, actor: { type: 'user', id: OTHER_USER }, origin: 'manual', commandId: id(821), kind: 'setObjectProperty', targetId: id(34), path: ['alignment'], value: 'center' }],
  }
}

describe('[COMP:api/office-resources] Office offline resource package', () => {
  it('publishes exact resource bytes at their high-water scope with a bounded response', async () => {
    const { snapshot, image, bytes, hash, scope, deps } = fixture()
    const response = await request(app(deps)).post(`/api/office/artifacts/${snapshot.artifactId}/offline-packages`).send({ deviceId: 'fixture-device', pinned: true, expectedVersion: 4 }).expect(201)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['x-brian-media-valid-for-ms']).toBe('20000')
    expect(response.body.manifest.resourceHashes).toContainEqual({ id: image.id, hash })
    const packaged = response.body.payload.resources.find((entry: { id: string }) => entry.id === image.id)
    expect(packaged).toMatchObject({ id: image.id, mime: image.mime, hash })
    expect(createHash('sha256').update(Buffer.from(packaged.bytes, 'base64')).digest('hex')).toBe(hash)
    expect(deps.savePackage).toHaveBeenCalledWith(expect.objectContaining({ artifactId: snapshot.artifactId, bytes: expect.any(Uint8Array), hash: expect.any(String), scope }))
    expect(deps.revalidatePackage).toHaveBeenCalledTimes(3)
    expect(deps.upsert).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ resourceHashes: [{ id: image.id, hash }] }) }))
  })

  it('refuses publication when the protected source changes before or after storage', async () => {
    const before = fixture()
    vi.mocked(before.deps.revalidatePackage).mockResolvedValueOnce(null)
    await request(app(before.deps)).post(`/api/office/artifacts/${before.snapshot.artifactId}/offline-packages`).send({ deviceId: 'fixture-device', pinned: true, expectedVersion: 4 }).expect(409)
    expect(before.deps.savePackage).not.toHaveBeenCalled()

    const after = fixture()
    vi.mocked(after.deps.revalidatePackage)
      .mockResolvedValueOnce({ scope: after.scope, validForMs: 20_000 })
      .mockResolvedValueOnce({ scope: after.scope, validForMs: 20_000 })
      .mockResolvedValueOnce(null)
    await request(app(after.deps)).post(`/api/office/artifacts/${after.snapshot.artifactId}/offline-packages`).send({ deviceId: 'fixture-device', pinned: true, expectedVersion: 4 }).expect(409)
    expect(after.deps.upsert).toHaveBeenCalledOnce()
  })
})

describe('[COMP:api/office-routes] Office offline reconnect', () => {
  it('attributes every command to the authenticated actor and admits one batch', async () => {
    const { snapshot, deps } = fixture()
    await request(app(deps)).post(`/api/office/artifacts/${snapshot.artifactId}/offline-sync`).send({ expectedSeq: 4, commands: [command(snapshot.artifactId)], deviceId: 'fixture-device', recoveryTitle: 'Recovered pitch', recoverySnapshot: snapshot }).expect(200, { status: 'synced', seq: 5 })
    const admitted = vi.mocked(deps.syncCommands).mock.calls[0]![0].commands[0]!
    expect(admitted).toMatchObject({ actor: { type: 'user', id: USER }, origin: 'offline' })
    expect(admitted.kind).toBe('batch')
    if (admitted.kind === 'batch') expect(admitted.commands[0]).toMatchObject({ actor: { type: 'user', id: USER }, origin: 'offline' })
    expect(deps.syncCommands).toHaveBeenCalledOnce()
  })

  it('publishes a classified recovery artifact on structural conflict', async () => {
    const { snapshot, deps } = fixture()
    vi.mocked(deps.syncCommands).mockResolvedValue('conflict')
    const response = await request(app(deps)).post(`/api/office/artifacts/${snapshot.artifactId}/offline-sync`).send({ expectedSeq: 4, commands: [command(snapshot.artifactId)], deviceId: 'fixture-device', recoveryTitle: 'Recovered pitch', recoverySnapshot: snapshot }).expect(409)
    expect(response.body).toEqual({ status: 'needs_attention', reason: 'structural_conflict', recoveryArtifactId: id(805) })
    expect(deps.createRecovery).toHaveBeenCalledWith({ userId: USER, artifactId: snapshot.artifactId, sourceVersionId: HEAD, title: 'Recovered pitch', snapshot })
  })

  it('fails honestly when recovery publication fails and quarantines after access loss', async () => {
    const failed = fixture()
    vi.mocked(failed.deps.syncCommands).mockResolvedValue('conflict')
    vi.mocked(failed.deps.createRecovery).mockResolvedValue(null)
    await request(app(failed.deps)).post(`/api/office/artifacts/${failed.snapshot.artifactId}/offline-sync`).send({ expectedSeq: 4, commands: [command(failed.snapshot.artifactId)], deviceId: 'fixture-device', recoveryTitle: 'Recovered pitch', recoverySnapshot: failed.snapshot }).expect(409, { status: 'sync_failed', reason: 'recovery_publication_failed' })

    const revoked = fixture()
    vi.mocked(revoked.deps.resolveAccess).mockResolvedValue(null)
    await request(app(revoked.deps)).post(`/api/office/artifacts/${revoked.snapshot.artifactId}/offline-sync`).send({ expectedSeq: 4, commands: [command(revoked.snapshot.artifactId)], deviceId: 'fixture-device', recoveryTitle: 'Recovered pitch', recoverySnapshot: revoked.snapshot }).expect(409, { status: 'needs_attention', reason: 'access_revoked', quarantine: true })
    expect(revoked.deps.syncCommands).not.toHaveBeenCalled()
  })
})
