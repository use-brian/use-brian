import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { ConnectorInstance, ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../../db/connector-grant-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import type { WorkspaceAuditStore } from '../../db/workspace-audit-store.js'
import type { WorkspaceToolPolicyStore } from '../../db/workspace-tool-policy-store.js'
import {
  memberConnectorInstanceRoutes,
  workspaceConnectorInstanceRoutes,
} from '../connector-instances.js'

const WS = '11111111-1111-4111-8111-111111111111'
const IID = '22222222-2222-4222-8222-222222222222'
const GID = '33333333-3333-4333-8333-333333333333'

function instance(overrides: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: IID,
    scope: 'workspace',
    userId: null,
    workspaceId: WS,
    provider: 'github',
    label: 'Workspace GitHub',
    connectedEmail: null,
    url: null,
    custom: false,
    config: {},
    sensitivity: 'internal',
    connected: true,
    ingestionEnabled: false,
    ingestWorkspaceId: null,
    credentialsType: 'oauth',
    healthStatus: 'ok',
    lastError: null,
    lastCheckedAt: null,
    createdBy: 'u1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

function makeApp(options: { userId?: string; clearance?: 'public' | 'internal' | 'confidential' } = { userId: 'u1' }) {
  const mocks = {
    getRole: vi.fn().mockResolvedValue('member'),
    listByWorkspace: vi.fn().mockResolvedValue([instance()]),
    listForTargetSystem: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(instance()),
    update: vi.fn().mockResolvedValue(instance()),
    deleteInstance: vi.fn().mockResolvedValue(true),
    transferToWorkspace: vi.fn().mockResolvedValue(instance()),
    createGrant: vi.fn().mockResolvedValue({ id: GID, connectorInstanceId: IID, targetType: 'workspace', targetId: WS, grantedByUserId: 'u1', grantedAt: new Date(0) }),
    revoke: vi.fn().mockResolvedValue(true),
    listByGrantor: vi.fn().mockResolvedValue([]),
    append: vi.fn().mockResolvedValue(undefined),
    listForWorkspace: vi.fn().mockResolvedValue([]),
    setPolicy: vi.fn().mockResolvedValue({ id: 'p1', policy: 'allow' }),
    getMembership: vi.fn().mockResolvedValue({ role: 'member', clearance: options.clearance ?? 'internal' }),
  }
  const routeOptions = {
    connectorInstanceStore: {
      listByWorkspace: mocks.listByWorkspace,
      get: mocks.get,
      update: mocks.update,
      delete: mocks.deleteInstance,
      transferToWorkspace: mocks.transferToWorkspace,
    } as unknown as ConnectorInstanceStore,
    connectorGrantStore: {
      create: mocks.createGrant,
      revoke: mocks.revoke,
      listForTargetSystem: mocks.listForTargetSystem,
      listByGrantor: mocks.listByGrantor,
    } as unknown as ConnectorGrantStore,
    workspaceStore: { getRole: mocks.getRole } as unknown as WorkspaceStore,
    auditStore: { append: mocks.append } as unknown as WorkspaceAuditStore,
    workspaceToolPolicyStore: {
      listForWorkspace: mocks.listForWorkspace,
      setPolicy: mocks.setPolicy,
    } as unknown as WorkspaceToolPolicyStore,
    getMembershipWithClearance: mocks.getMembership,
  }
  const app = express()
  app.use(express.json())
  if (options.userId) app.use((req, _res, next) => { req.userId = options.userId; next() })
  app.use('/api/connector-instances', memberConnectorInstanceRoutes(routeOptions))
  app.use('/api/workspaces/:workspaceId/connectors', workspaceConnectorInstanceRoutes(routeOptions))
  return { app, ...mocks }
}

describe('[COMP:api/connector-instances-route] connector instance routes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists the caller grants for the Studio contract', async () => {
    const { app, listByGrantor } = makeApp()
    listByGrantor.mockResolvedValue([{ id: GID, connectorInstanceId: IID, targetType: 'workspace', targetId: WS }])
    const response = await request(app).get('/api/connector-instances/me/grants')
    expect(response.status).toBe(200)
    expect(response.body.grants[0]).toMatchObject({ id: GID, connectorInstanceId: IID, targetId: WS })
    expect(listByGrantor).toHaveBeenCalledWith('u1')
  })

  it('lists workspace-owned and granted instances for members', async () => {
    const { app, listForTargetSystem } = makeApp()
    listForTargetSystem.mockResolvedValue([{ id: GID, grantedByUserId: 'u2', grantedAt: new Date(0), instance: instance({ scope: 'user', workspaceId: null, userId: 'u2' }) }])
    const response = await request(app).get(`/api/workspaces/${WS}/connectors`)
    expect(response.status).toBe(200)
    expect(response.body.teamNative).toHaveLength(1)
    expect(response.body.granted[0]).toMatchObject({ grantId: GID, grantedByUserId: 'u2' })
  })

  it('rejects workspace connector listing for non-members', async () => {
    const { app, getRole, listByWorkspace } = makeApp()
    getRole.mockResolvedValue(null)
    const response = await request(app).get(`/api/workspaces/${WS}/connectors`)
    expect(response.status).toBe(403)
    expect(listByWorkspace).not.toHaveBeenCalled()
  })

  it('creates a grant and stamps the member clearance on the instance', async () => {
    const { app, createGrant, update } = makeApp({ userId: 'u1', clearance: 'internal' })
    const response = await request(app)
      .post(`/api/connector-instances/${IID}/grants`)
      .send({ targetType: 'workspace', targetId: WS })
    expect(response.status).toBe(201)
    expect(createGrant).toHaveBeenCalledWith(expect.objectContaining({ connectorInstanceId: IID, targetId: WS }))
    expect(update).toHaveBeenCalledWith('u1', IID, { sensitivity: 'internal' })
  })

  it('caps transfer sensitivity at the member clearance', async () => {
    const { app, transferToWorkspace } = makeApp({ userId: 'u1', clearance: 'public' })
    const response = await request(app)
      .post(`/api/connector-instances/${IID}/transfer`)
      .send({ workspaceId: WS, sensitivity: 'confidential' })
    expect(response.status).toBe(200)
    expect(transferToWorkspace).toHaveBeenCalledWith('u1', IID, WS, 'public')
  })

  it('hides workspace connectors above the member clearance', async () => {
    const { app, get } = makeApp({ userId: 'u1', clearance: 'public' })
    get.mockResolvedValue(instance({ sensitivity: 'confidential' }))
    const response = await request(app).patch(`/api/workspaces/${WS}/connectors/${IID}`).send({ label: 'Hidden' })
    expect(response.status).toBe(404)
  })

  it('filters and updates policies by the connector provider', async () => {
    const { app, listForWorkspace, setPolicy } = makeApp()
    listForWorkspace.mockResolvedValue([
      { serverName: 'github', toolName: 'issues', policy: 'ask' },
      { serverName: 'notion', toolName: 'search', policy: 'allow' },
    ])
    const listed = await request(app).get(`/api/workspaces/${WS}/connectors/${IID}/tool-policies`)
    expect(listed.status).toBe(200)
    expect(listed.body.policies).toEqual([expect.objectContaining({ serverName: 'github' })])

    const updated = await request(app)
      .put(`/api/workspaces/${WS}/connectors/${IID}/tools/issues/policy`)
      .send({ policy: 'allow', classification: 'write' })
    expect(updated.status).toBe(200)
    expect(setPolicy).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, serverName: 'github', toolName: 'issues', updatedBy: 'u1' }))
  })

  it('validates grant input and requires an authenticated caller', async () => {
    const invalid = await request(makeApp().app)
      .post(`/api/connector-instances/${IID}/grants`)
      .send({ targetType: 'workspace', targetId: 'bad' })
    expect(invalid.status).toBe(400)
    const anonymous = await request(makeApp({ userId: undefined }).app).get('/api/connector-instances/me/grants')
    expect(anonymous.status).toBe(401)
  })
})
