import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { connectorRoutes } from '../connectors.js'
import { createTestApp } from './helpers.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { ConnectorStore } from '../../db/connector-store.js'

const WS = '11111111-1111-1111-1111-111111111111'
const USER = 'user_1'
// The validator is mocked in these tests, so only `client_email` (the field the
// route parser checks) matters; the signing secret is intentionally absent.
const goodKey = { client_email: 'sa@proj.iam.gserviceaccount.com', project_id: 'proj' }

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
    gcsByo: {
      requireWorkspaceAdmin: async () => over.isAdmin ?? true,
      validate: async () =>
        over.validateOk === false
          ? { ok: false, code: 'permission_denied', message: 'nope' }
          : { ok: true },
    },
  })
  const app = createTestApp('/api/connectors', router, { userId: USER })
  return { app, createWorkspaceInstance, update, setConfigSystem }
}

describe('[COMP:api/connectors-route] POST /gcs/connect', () => {
  it('validates then creates a workspace-scoped instance', async () => {
    const { app, createWorkspaceInstance } = makeApp({ existing: null })
    const res = await request(app).post('/api/connectors/gcs/connect').send({
      workspaceId: WS, serviceAccountKey: goodKey, bucket: 'cust-bucket',
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(createWorkspaceInstance).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, provider: 'gcs', connected: true }),
    )
  })

  it('accepts the SA key as a JSON string', async () => {
    const { app, createWorkspaceInstance } = makeApp({ existing: null })
    const res = await request(app).post('/api/connectors/gcs/connect').send({
      workspaceId: WS, serviceAccountKey: JSON.stringify(goodKey), bucket: 'cust-bucket',
    })
    expect(res.status).toBe(200)
    expect(createWorkspaceInstance).toHaveBeenCalled()
  })

  it('updates the existing instance instead of creating a second', async () => {
    const { app, createWorkspaceInstance, update, setConfigSystem } = makeApp({ existing: { id: 'inst_existing' } })
    const res = await request(app).post('/api/connectors/gcs/connect').send({
      workspaceId: WS, serviceAccountKey: goodKey, bucket: 'cust-bucket',
    })
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith(USER, 'inst_existing', expect.objectContaining({ connected: true }))
    expect(setConfigSystem).toHaveBeenCalled()
    expect(createWorkspaceInstance).not.toHaveBeenCalled()
  })

  it('rejects a non-admin with 403', async () => {
    const { app, createWorkspaceInstance } = makeApp({ isAdmin: false })
    const res = await request(app).post('/api/connectors/gcs/connect').send({
      workspaceId: WS, serviceAccountKey: goodKey, bucket: 'cust-bucket',
    })
    expect(res.status).toBe(403)
    expect(createWorkspaceInstance).not.toHaveBeenCalled()
  })

  it('returns 400 when validate-on-connect fails (no persistence)', async () => {
    const { app, createWorkspaceInstance } = makeApp({ validateOk: false })
    const res = await request(app).post('/api/connectors/gcs/connect').send({
      workspaceId: WS, serviceAccountKey: goodKey, bucket: 'cust-bucket',
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('permission_denied')
    expect(createWorkspaceInstance).not.toHaveBeenCalled()
  })

  it('rejects a malformed service account key', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/connectors/gcs/connect').send({
      workspaceId: WS, serviceAccountKey: { nope: true }, bucket: 'cust-bucket',
    })
    expect(res.status).toBe(400)
  })

  it('rejects a missing bucket', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/connectors/gcs/connect').send({
      workspaceId: WS, serviceAccountKey: goodKey,
    })
    expect(res.status).toBe(400)
  })
})

describe('[COMP:api/connectors-route] POST /gcs/disconnect', () => {
  it('disconnect drops the key (connected=false + credentials none) and stamps disconnectedAt', async () => {
    const update = vi.fn(async () => ({ id: 'inst_existing' }))
    const setConfigSystem = vi.fn(async () => {})
    const router = connectorRoutes({
      connectorStore: {} as ConnectorStore,
      connectorInstanceStore: {
        findByWorkspaceProviderSystem: async () => ({ id: 'inst_existing' }),
        update,
        setConfigSystem,
      } as unknown as ConnectorInstanceStore,
      gcsByo: { requireWorkspaceAdmin: async () => true },
    })
    const app = createTestApp('/api/connectors', router, { userId: USER })
    const res = await request(app).post('/api/connectors/gcs/disconnect').send({ workspaceId: WS })
    expect(res.status).toBe(200)
    // Zero standing access: the key is wiped on disconnect. Rows are kept (not
    // touched here) so a reconnect revives them; disconnectedAt arms the GC.
    expect(update).toHaveBeenCalledWith(USER, 'inst_existing', { connected: false, credentials: { type: 'none' } })
    expect(setConfigSystem).toHaveBeenCalledWith('inst_existing', expect.objectContaining({ disconnectedAt: expect.any(String) }))
  })

  it('404s when the gcsByo dep is not wired', async () => {
    const router = connectorRoutes({
      connectorStore: {} as ConnectorStore,
      connectorInstanceStore: {} as ConnectorInstanceStore,
    })
    const app = createTestApp('/api/connectors', router, { userId: USER })
    const res = await request(app).post('/api/connectors/gcs/connect').send({ workspaceId: WS, bucket: 'b', serviceAccountKey: goodKey })
    expect(res.status).toBe(404)
  })
})
