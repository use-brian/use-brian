import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceCustomLlmEndpointsRoutes } from '../workspace-custom-llm-endpoints.js'
import type { WorkspaceCustomLlmEndpointStore } from '../../db/workspace-custom-llm-endpoints.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import type { CustomLlmNetworkPolicy } from '../../custom-llm-runtime.js'

const workspaceId = '00000000-0000-4000-8000-000000000010'
const endpointId = '00000000-0000-4000-8000-000000000001'
const row = {
  id: endpointId,
  workspaceId,
  name: 'Local Llama',
  baseUrl: 'http://model.example/v1',
  modelId: 'llama-local',
  contextWindow: 32768,
  maxOutputTokens: 4096,
  supportsTools: true,
  verifiedAt: new Date('2026-08-10T00:00:00Z'),
  isDefault: true,
  hasApiKey: false,
  createdAt: new Date('2026-08-10T00:00:00Z'),
  updatedAt: new Date('2026-08-10T00:00:00Z'),
}

function setup(networkPolicy: CustomLlmNetworkPolicy = 'private-network') {
  const endpointStore = {
    list: vi.fn().mockResolvedValue([row]),
    create: vi.fn().mockResolvedValue(row),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(true),
    setDefault: vi.fn().mockResolvedValue(row),
    clearDefault: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceCustomLlmEndpointStore
  const workspaceStore = { getRole: vi.fn().mockResolvedValue('owner') } as unknown as WorkspaceStore
  const probe = vi.fn().mockResolvedValue({ supportsTools: true as const, verifiedAt: row.verifiedAt })
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as typeof req & { userId?: string }).userId = 'user-1'
    next()
  })
  app.use(
    '/api/workspaces/:workspaceId/custom-llm-endpoints',
    workspaceCustomLlmEndpointsRoutes({ endpointStore, workspaceStore, networkPolicy, probe }),
  )
  return { app, endpointStore, workspaceStore, probe }
}

describe('[COMP:api/custom-llm-endpoints] custom endpoint route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is available under the hosted public-endpoint policy', async () => {
    const { app, workspaceStore } = setup('public-only')
    await request(app).get(`/api/workspaces/${workspaceId}/custom-llm-endpoints`).expect(200)
    expect(workspaceStore.getRole).toHaveBeenCalledWith('user-1', workspaceId)
  })

  it('requires HTTPS before probing a hosted endpoint', async () => {
    const { app, probe } = setup('public-only')
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/custom-llm-endpoints`)
      .send({
        name: 'Hosted Llama',
        baseUrl: 'http://models.example.com/v1',
        modelId: 'llama-hosted',
        contextWindow: 32768,
        maxOutputTokens: 4096,
      })
      .expect(400)
    expect(res.body.code).toBe('endpoint_public_https_required')
    expect(probe).not.toHaveBeenCalled()
  })

  it('lists masked endpoint metadata and stable selectors', async () => {
    const { app } = setup()
    const res = await request(app).get(`/api/workspaces/${workspaceId}/custom-llm-endpoints`).expect(200)
    expect(res.body.endpoints[0]).toMatchObject({
      id: endpointId,
      selector: `custom:${endpointId}`,
      hasApiKey: false,
    })
    expect(res.body.endpoints[0]).not.toHaveProperty('apiKey')
  })

  it('probes before saving a normalized endpoint', async () => {
    const { app, endpointStore, probe } = setup()
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/custom-llm-endpoints`)
      .send({
        name: 'Local Llama',
        baseUrl: 'http://model.example/v1/',
        apiKey: null,
        modelId: 'llama-local',
        contextWindow: 32768,
        maxOutputTokens: 4096,
        isDefault: true,
      })
      .expect(201)
    expect(probe).toHaveBeenCalledWith({
      baseUrl: 'http://model.example/v1',
      apiKey: null,
      modelId: 'llama-local',
    })
    expect(endpointStore.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      input: expect.objectContaining({ supportsTools: true, baseUrl: 'http://model.example/v1' }),
    }))
    expect(res.body.endpoint.selector).toBe(`custom:${endpointId}`)
  })

  it('gates writes to workspace admins', async () => {
    const { app, workspaceStore, probe } = setup()
    vi.mocked(workspaceStore.getRole).mockResolvedValueOnce('member')
    await request(app)
      .post(`/api/workspaces/${workspaceId}/custom-llm-endpoints`)
      .send({ name: 'x', baseUrl: 'http://model.example/v1', modelId: 'm', contextWindow: 4096, maxOutputTokens: 512 })
      .expect(403)
    expect(probe).not.toHaveBeenCalled()
  })
})
