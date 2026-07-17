import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { connectorRoutes } from '../connectors.js'
import { createTestApp } from './helpers.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { ConnectorStore } from '../../db/connector-store.js'

const WS = '11111111-1111-1111-1111-111111111111'
const USER = 'user_1'
const goodKeys = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'super-secret' }

function makeApp(over: {
  isAdmin?: boolean
  validateOk?: boolean
  existing?: { id: string } | null
  instanceStore?: Partial<ConnectorInstanceStore>
} = {}) {
  const createWorkspaceInstance = vi.fn(async () => ({ id: 'inst_new' }))
  const update = vi.fn(async () => ({ id: 'inst_existing' }))
  const setConfigSystem = vi.fn(async () => {})
  const findByWorkspaceProviderSystem = vi.fn(async () => (over.existing ?? null))
  const instanceStore = {
    createWorkspaceInstance,
    update,
    setConfigSystem,
    findByWorkspaceProviderSystem,
    ...over.instanceStore,
  } as unknown as ConnectorInstanceStore
  const router = connectorRoutes({
    connectorStore: {} as ConnectorStore,
    connectorInstanceStore: instanceStore,
    s3Byo: {
      requireWorkspaceAdmin: async () => over.isAdmin ?? true,
      validate: async () =>
        over.validateOk === false
          ? { ok: false, code: 'permission_denied', message: 'nope' }
          : { ok: true },
    },
  })
  const app = createTestApp('/api/connectors', router, { userId: USER })
  return { app, createWorkspaceInstance, update, setConfigSystem, findByWorkspaceProviderSystem }
}

describe('[COMP:api/connectors-route] POST /s3/connect', () => {
  it('validates then creates a workspace-scoped instance', async () => {
    const { app, createWorkspaceInstance } = makeApp({ existing: null })
    const res = await request(app).post('/api/connectors/s3/connect').send({
      workspaceId: WS, ...goodKeys, bucket: 'cust-bucket', region: 'us-east-1',
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(createWorkspaceInstance).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, provider: 's3', connected: true }),
    )
  })

  it('passes region/endpoint/forcePathStyle through to the stored credentials', async () => {
    const { app, createWorkspaceInstance } = makeApp({ existing: null })
    const res = await request(app).post('/api/connectors/s3/connect').send({
      workspaceId: WS, ...goodKeys, bucket: 'cust-bucket', region: 'auto',
      endpoint: 'https://minio.local', forcePathStyle: true,
    })
    expect(res.status).toBe(200)
    const calls = createWorkspaceInstance.mock.calls as unknown as Array<[{ credentials: Record<string, unknown> }]>
    const arg = calls[0][0]
    expect(arg.credentials).toMatchObject({
      type: 's3', bucket: 'cust-bucket', region: 'auto', endpoint: 'https://minio.local', forcePathStyle: true,
    })
  })

  it('updates the existing instance instead of creating a second', async () => {
    const { app, createWorkspaceInstance, update, setConfigSystem } = makeApp({ existing: { id: 'inst_existing' } })
    const res = await request(app).post('/api/connectors/s3/connect').send({
      workspaceId: WS, ...goodKeys, bucket: 'cust-bucket',
    })
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith(USER, 'inst_existing', expect.objectContaining({ connected: true }))
    expect(setConfigSystem).toHaveBeenCalled()
    expect(createWorkspaceInstance).not.toHaveBeenCalled()
  })

  it('rejects a non-admin with 403', async () => {
    const { app, createWorkspaceInstance } = makeApp({ isAdmin: false })
    const res = await request(app).post('/api/connectors/s3/connect').send({
      workspaceId: WS, ...goodKeys, bucket: 'cust-bucket',
    })
    expect(res.status).toBe(403)
    expect(createWorkspaceInstance).not.toHaveBeenCalled()
  })

  it('returns 400 when validate-on-connect fails (no persistence)', async () => {
    const { app, createWorkspaceInstance } = makeApp({ validateOk: false })
    const res = await request(app).post('/api/connectors/s3/connect').send({
      workspaceId: WS, ...goodKeys, bucket: 'cust-bucket',
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('permission_denied')
    expect(createWorkspaceInstance).not.toHaveBeenCalled()
  })

  it('rejects a missing secret key', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/connectors/s3/connect').send({
      workspaceId: WS, accessKeyId: goodKeys.accessKeyId, bucket: 'cust-bucket',
    })
    expect(res.status).toBe(400)
  })

  it('rejects a missing bucket', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/connectors/s3/connect').send({
      workspaceId: WS, ...goodKeys,
    })
    expect(res.status).toBe(400)
  })
})

describe('[COMP:api/connectors-route] POST /s3/disconnect', () => {
  it('disconnect drops the keys (connected=false + credentials none) and stamps disconnectedAt', async () => {
    const update = vi.fn(async () => ({ id: 'inst_existing' }))
    const setConfigSystem = vi.fn(async () => {})
    const router = connectorRoutes({
      connectorStore: {} as ConnectorStore,
      connectorInstanceStore: {
        findByWorkspaceProviderSystem: async () => ({ id: 'inst_existing' }),
        update,
        setConfigSystem,
      } as unknown as ConnectorInstanceStore,
      s3Byo: { requireWorkspaceAdmin: async () => true },
    })
    const app = createTestApp('/api/connectors', router, { userId: USER })
    const res = await request(app).post('/api/connectors/s3/disconnect').send({ workspaceId: WS })
    expect(res.status).toBe(200)
    // Zero standing access: the keys are wiped on disconnect. Rows are kept (not
    // touched here) so a reconnect revives them; disconnectedAt arms the GC.
    expect(update).toHaveBeenCalledWith(USER, 'inst_existing', { connected: false, credentials: { type: 'none' } })
    expect(setConfigSystem).toHaveBeenCalledWith('inst_existing', expect.objectContaining({ disconnectedAt: expect.any(String) }))
  })

  it('404s when the s3Byo dep is not wired', async () => {
    const router = connectorRoutes({
      connectorStore: {} as ConnectorStore,
      connectorInstanceStore: {} as ConnectorInstanceStore,
    })
    const app = createTestApp('/api/connectors', router, { userId: USER })
    const res = await request(app).post('/api/connectors/s3/connect').send({ workspaceId: WS, bucket: 'b', ...goodKeys })
    expect(res.status).toBe(404)
  })
})
