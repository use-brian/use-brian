import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorInstance } from '../../db/connector-instance-store.js'
import type { IngestExternalSink } from '../../db/ingest-sink-store.js'

const mocks = vi.hoisted(() => ({
  usable: vi.fn(),
  listRepos: vi.fn(),
  addRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
}))

vi.mock('../../connectors/usable-connectors.js', () => ({
  listUsableWorkspaceConnectors: mocks.usable,
}))
vi.mock('../../github/client.js', () => ({ listAffiliatedRepos: mocks.listRepos }))
vi.mock('../../db/ingest-rules-editor-store.js', () => ({
  createIngestRuleEditorStore: () => ({
    addRule: mocks.addRule,
    updateRule: mocks.updateRule,
    deleteRule: mocks.deleteRule,
  }),
}))

import { ingestRoutes } from '../ingest.js'

const USER_ID = '00000000-0000-0000-0000-000000000020'
const INSTANCE_ID = '00000000-0000-0000-0000-0000000000a2'
const GITHUB_ID = '00000000-0000-0000-0000-0000000000a4'
const WORKSPACE_ID = '00000000-0000-0000-0000-0000000000b1'
const RULE_ID = '00000000-0000-0000-0000-0000000000d1'
const SINK_ID = '00000000-0000-0000-0000-0000000000c1'

function instance(overrides: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: INSTANCE_ID,
    scope: 'user',
    userId: USER_ID,
    workspaceId: null,
    provider: 'gcal',
    label: 'Calendar',
    connectedEmail: 'owner@example.com',
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
    createdBy: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function sink(): IngestExternalSink {
  return {
    id: SINK_ID,
    connectorInstanceId: INSTANCE_ID,
    workspaceId: WORKSPACE_ID,
    endpointUrl: 'https://sink.example/append',
    authKind: 'hmac',
    mode: 'all',
    enabled: true,
    hasSecret: true,
    lastAckCursor: null,
    lastDeliveredAt: null,
    createdAt: new Date(),
  }
}

function setup() {
  const connectorInstanceStore = {
    get: vi.fn(),
    update: vi.fn(),
    setConfig: vi.fn(),
    getCredentials: vi.fn(),
  }
  const ingestRulesStore = {
    listByConnectorInstances: vi.fn().mockResolvedValue([]),
    listByConnectorInstance: vi.fn().mockResolvedValue([]),
    seedDefaults: vi.fn().mockResolvedValue(0),
  }
  const workspaceStore = {
    get: vi.fn().mockResolvedValue({
      id: WORKSPACE_ID,
      name: 'Personal',
      ownerUserId: USER_ID,
      isPersonal: true,
    }),
  }
  const ingestSinkStore = {
    create: vi.fn().mockResolvedValue(sink()),
    get: vi.fn(),
    listByInstance: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue(sink()),
    remove: vi.fn().mockResolvedValue(true),
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.userId = USER_ID
    next()
  })
  app.use('/api/ingest', ingestRoutes({
    connectorInstanceStore: connectorInstanceStore as never,
    ingestRulesStore: ingestRulesStore as never,
    workspaceStore: workspaceStore as never,
    connectorGrantStore: {} as never,
    ingestSinkStore: ingestSinkStore as never,
  }))
  return { app, connectorInstanceStore, ingestRulesStore, workspaceStore, ingestSinkStore }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.usable.mockResolvedValue([])
})

describe('[COMP:api/ingest-route] OSS ingestion control plane', () => {
  it('lists ingest-capable sources and batches their rules', async () => {
    const gcal = instance()
    mocks.usable.mockResolvedValue([
      { instance: gcal, source: 'personal' },
      { instance: instance({ id: GITHUB_ID, provider: 'gmail' }), source: 'personal' },
    ])
    const { app, ingestRulesStore } = setup()
    ingestRulesStore.listByConnectorInstances.mockResolvedValue([{
      id: RULE_ID,
      connectorInstanceId: INSTANCE_ID,
      source: 'calendar',
      ruleOrder: 0,
      filterType: 'always',
      filterParams: {},
      routingMode: 'realtime',
      routingSchedule: null,
      routingTimezone: 'UTC',
      alert: false,
      episodeSensitivity: null,
    }])

    const response = await request(app).get(`/api/ingest/sources?workspaceId=${WORKSPACE_ID}`)

    expect(response.status).toBe(200)
    expect(response.body.sources).toEqual([
      expect.objectContaining({ instanceId: INSTANCE_ID, source: 'calendar', rules: [expect.any(Object)] }),
    ])
    expect(ingestRulesStore.listByConnectorInstances).toHaveBeenCalledWith(USER_ID, [INSTANCE_ID])
    expect(response.body.available.map((item: { provider: string }) => item.provider)).not.toContain('slack')
  })

  it('enables and disables a source for the selected workspace', async () => {
    const current = instance()
    mocks.usable.mockResolvedValue([{ instance: current, source: 'personal' }])
    const { app, connectorInstanceStore, ingestRulesStore } = setup()
    connectorInstanceStore.get.mockResolvedValue(current)
    connectorInstanceStore.update
      .mockResolvedValueOnce(instance({ ingestionEnabled: true, ingestWorkspaceId: WORKSPACE_ID }))
      .mockResolvedValueOnce(instance({ ingestionEnabled: false, ingestWorkspaceId: null }))

    const enabled = await request(app)
      .post(`/api/ingest/sources/${INSTANCE_ID}/enable`)
      .send({ workspaceId: WORKSPACE_ID })
    const disabled = await request(app)
      .post(`/api/ingest/sources/${INSTANCE_ID}/disable`)
      .send({ workspaceId: WORKSPACE_ID })

    expect(enabled.status).toBe(200)
    expect(enabled.body.source.ingestionEnabled).toBe(true)
    expect(ingestRulesStore.seedDefaults).toHaveBeenCalledWith(USER_ID, INSTANCE_ID, 'calendar')
    expect(connectorInstanceStore.update).toHaveBeenNthCalledWith(1, USER_ID, INSTANCE_ID, {
      ingestionEnabled: true,
      ingestWorkspaceId: WORKSPACE_ID,
    })
    expect(disabled.status).toBe(200)
    expect(connectorInstanceStore.update).toHaveBeenNthCalledWith(2, USER_ID, INSTANCE_ID, {
      ingestionEnabled: false,
      ingestWorkspaceId: null,
    })
  })

  it('reads and writes GitHub repository selections', async () => {
    const github = instance({ id: GITHUB_ID, provider: 'github', config: { repos: ['acme/old'] } })
    const { app, connectorInstanceStore } = setup()
    connectorInstanceStore.get.mockResolvedValue(github)
    connectorInstanceStore.getCredentials.mockResolvedValue({ client_secret: 'pat' })
    mocks.listRepos.mockResolvedValue([{
      full_name: 'acme/repo',
      private: true,
      description: 'Repo',
      owner: { login: 'acme', type: 'Organization' },
    }])

    const listed = await request(app).get(`/api/ingest/sources/${GITHUB_ID}/github/repos`)
    const saved = await request(app)
      .put(`/api/ingest/sources/${GITHUB_ID}/github/repos`)
      .send({ repos: ['acme/repo'], orgs: ['acme'] })

    expect(listed.status).toBe(200)
    expect(listed.body.orgs).toEqual([{ login: 'acme', repoCount: 1 }])
    expect(saved.body).toEqual({ selected: ['acme/repo'], selectedOrgs: ['acme'] })
    expect(connectorInstanceStore.setConfig).toHaveBeenCalledWith(USER_ID, GITHUB_ID, {
      repos: ['acme/repo'],
      orgs: ['acme'],
    })
  })

  it('supports rule create, patch, and delete contracts', async () => {
    const { app } = setup()
    mocks.addRule.mockResolvedValue({ id: RULE_ID })
    mocks.updateRule.mockResolvedValue({ id: RULE_ID, alert: true })

    const created = await request(app)
      .post(`/api/ingest/sources/${INSTANCE_ID}/rules`)
      .send({ filterType: 'always', routingMode: 'realtime' })
    const updated = await request(app).patch(`/api/ingest/rules/${RULE_ID}`).send({ alert: true })
    const removed = await request(app).delete(`/api/ingest/rules/${RULE_ID}`)

    expect(created.status).toBe(201)
    expect(mocks.addRule).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      connectorInstanceId: INSTANCE_ID,
      filterType: 'always',
      routingMode: 'realtime',
    }))
    expect(updated.status).toBe(200)
    expect(mocks.updateRule).toHaveBeenCalledWith(USER_ID, { ruleId: RULE_ID, patch: { alert: true } })
    expect(removed.status).toBe(204)
    expect(mocks.deleteRule).toHaveBeenCalledWith(USER_ID, RULE_ID)
  })

  it('supports sink create, list, patch, and delete without returning secrets', async () => {
    const { app, connectorInstanceStore, ingestSinkStore } = setup()
    connectorInstanceStore.get.mockResolvedValue(instance())
    ingestSinkStore.listByInstance.mockResolvedValue([sink()])
    ingestSinkStore.get.mockResolvedValue(sink())

    const created = await request(app).post(`/api/ingest/sources/${INSTANCE_ID}/sinks`).send({
      workspaceId: WORKSPACE_ID,
      endpointUrl: 'https://sink.example/append',
      authKind: 'hmac',
      secret: 'a-long-enough-secret',
    })
    const listed = await request(app).get(`/api/ingest/sources/${INSTANCE_ID}/sinks`)
    const updated = await request(app).patch(`/api/ingest/sinks/${SINK_ID}`).send({ enabled: false })
    const removed = await request(app).delete(`/api/ingest/sinks/${SINK_ID}`)

    expect(created.status).toBe(201)
    expect(created.body.sink.secret).toBeUndefined()
    expect(listed.body.sinks).toHaveLength(1)
    expect(updated.status).toBe(200)
    expect(ingestSinkStore.update).toHaveBeenCalledWith(SINK_ID, { enabled: false })
    expect(removed.status).toBe(204)
    expect(ingestSinkStore.remove).toHaveBeenCalledWith(SINK_ID)
  })
})
