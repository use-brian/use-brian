import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceCustomLlmEndpointsRoutes } from '../workspace-custom-llm-endpoints.js'
import type { WorkspaceCustomLlmEndpointStore } from '../../db/workspace-custom-llm-endpoints.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import { CustomLlmProbeError, type CustomLlmNetworkPolicy } from '../../custom-llm-runtime.js'

const workspaceId = '00000000-0000-4000-8000-000000000010'
const endpointId = '00000000-0000-4000-8000-000000000001'
const profileId = '00000000-0000-4000-8000-000000000002'
const profile = {
  id: endpointId,
  endpointId,
  workspaceId,
  name: 'Balanced',
  modelId: 'terra-high',
  contextWindow: 32768,
  maxOutputTokens: 4096,
  supportsTools: true,
  verifiedAt: new Date('2026-08-10T00:00:00Z'),
  createdAt: new Date('2026-08-10T00:00:00Z'),
  updatedAt: new Date('2026-08-10T00:00:00Z'),
}
const endpoint = {
  id: endpointId,
  workspaceId,
  name: 'Local gateway',
  baseUrl: 'http://model.example/v1',
  hasApiKey: false,
  fallbackToDefaultOnFailure: false,
  createdAt: new Date('2026-08-10T00:00:00Z'),
  updatedAt: new Date('2026-08-10T00:00:00Z'),
  profiles: [profile],
}

function setup(networkPolicy: CustomLlmNetworkPolicy = 'private-network') {
  const endpointStore = {
    list: vi.fn().mockResolvedValue([endpoint]),
    listTierDefaults: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(endpoint),
    createProfile: vi.fn().mockResolvedValue({ ...profile, id: profileId, endpointId }),
    updateProfile: vi.fn().mockResolvedValue({ ...profile, id: profileId, endpointId }),
    delete: vi.fn().mockResolvedValue(true),
    deleteProfile: vi.fn().mockResolvedValue(true),
    setTierDefault: vi.fn().mockResolvedValue({ workspaceId, tier: 'max', profileId, updatedAt: new Date() }),
    clearTierDefault: vi.fn().mockResolvedValue(undefined),
    setFallbackPolicy: vi.fn().mockResolvedValue({ ...endpoint, fallbackToDefaultOnFailure: true }),
    getEndpointRuntimeSystem: vi.fn().mockResolvedValue({
      ...endpoint,
      profiles: undefined,
      apiKey: null,
    }),
    getRuntimeSystem: vi.fn().mockResolvedValue({
      ...profile,
      id: profileId,
      endpointId,
      endpointName: endpoint.name,
      baseUrl: endpoint.baseUrl,
      apiKey: null,
    }),
  } as unknown as WorkspaceCustomLlmEndpointStore
  const workspaceStore = { getRole: vi.fn().mockResolvedValue('owner') } as unknown as WorkspaceStore
  const probe = vi.fn().mockResolvedValue({ supportsTools: true as const, verifiedAt: profile.verifiedAt })
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
        name: 'Hosted gateway', baseUrl: 'http://models.example.com/v1',
        modelId: 'terra-high', contextWindow: 32768, maxOutputTokens: 4096,
      })
      .expect(400)
    expect(res.body.code).toBe('endpoint_public_https_required')
    expect(probe).not.toHaveBeenCalled()
  })

  it('lists masked connections, child profiles, stable selectors, and tier assignments', async () => {
    const { app, endpointStore } = setup()
    vi.mocked(endpointStore.listTierDefaults).mockResolvedValueOnce([
      { workspaceId, tier: 'max', profileId: profile.id, updatedAt: new Date() },
    ])
    const res = await request(app).get(`/api/workspaces/${workspaceId}/custom-llm-endpoints`).expect(200)
    expect(res.body.endpoints[0]).toMatchObject({ id: endpointId, hasApiKey: false })
    expect(res.body.endpoints[0].profiles[0]).toMatchObject({
      id: endpointId,
      selector: `custom:${endpointId}`,
      modelId: 'terra-high',
    })
    expect(res.body.endpoints[0]).not.toHaveProperty('apiKey')
    expect(res.body.tierDefaults[0]).toMatchObject({ tier: 'max', profileId: endpointId })
  })

  it('probes before saving a normalized connection and its first profile', async () => {
    const { app, endpointStore, probe } = setup()
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/custom-llm-endpoints`)
      .send({
        name: 'Local gateway', baseUrl: 'http://model.example/v1/', apiKey: null,
        modelId: 'terra-high', contextWindow: 32768, maxOutputTokens: 4096,
      })
      .expect(201)
    expect(probe).toHaveBeenCalledWith({
      baseUrl: 'http://model.example/v1', apiKey: null, modelId: 'terra-high',
    })
    expect(endpointStore.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      input: expect.objectContaining({ supportsTools: true, baseUrl: 'http://model.example/v1' }),
    }))
    expect(res.body.endpoint.profiles[0].selector).toBe(`custom:${endpointId}`)
  })

  it('creates another verified model profile without resending connection auth', async () => {
    const { app, endpointStore, probe } = setup()
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/profiles`)
      .send({ name: 'Max', modelId: 'sol-max', contextWindow: 200000, maxOutputTokens: 32768 })
      .expect(201)
    expect(endpointStore.getEndpointRuntimeSystem).toHaveBeenCalledWith({ workspaceId, endpointId })
    expect(probe).toHaveBeenCalledWith({
      baseUrl: endpoint.baseUrl, apiKey: null, modelId: 'sol-max',
    })
    expect(res.body.profile.selector).toBe(`custom:${profileId}`)
  })

  it('reverifies and updates a profile without changing its selector or tier identity', async () => {
    const { app, endpointStore, probe } = setup()
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/profiles/${profileId}`)
      .send({ name: 'High context', modelId: 'terra-high', contextWindow: 1048576, maxOutputTokens: 65536 })
      .expect(200)

    expect(endpointStore.getRuntimeSystem).toHaveBeenCalledWith({ workspaceId, profileId })
    expect(probe).toHaveBeenCalledWith({
      baseUrl: endpoint.baseUrl,
      apiKey: null,
      modelId: 'terra-high',
    })
    expect(endpointStore.updateProfile).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      workspaceId,
      endpointId,
      profileId,
      input: expect.objectContaining({
        name: 'High context',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        supportsTools: true,
      }),
    })
    expect(res.body.profile.selector).toBe(`custom:${profileId}`)
  })

  it('keeps the stored profile unchanged when edit verification fails', async () => {
    const { app, endpointStore, probe } = setup()
    vi.mocked(probe).mockRejectedValueOnce(
      new CustomLlmProbeError('endpoint_tools_unsupported', 'The endpoint did not return the required streamed tool call'),
    )

    await request(app)
      .patch(`/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/profiles/${profileId}`)
      .send({ name: 'Broken', modelId: 'chat-only', contextWindow: 32768, maxOutputTokens: 4096 })
      .expect(422)

    expect(endpointStore.updateProfile).not.toHaveBeenCalled()
  })

  it('assigns and clears a custom profile independently for one Brian tier', async () => {
    const { app, endpointStore } = setup()
    await request(app)
      .put(`/api/workspaces/${workspaceId}/custom-llm-endpoints/tiers/max`)
      .send({ profileId })
      .expect(200)
    expect(endpointStore.setTierDefault).toHaveBeenCalledWith({
      actingUserId: 'user-1', workspaceId, tier: 'max', profileId,
    })
    await request(app)
      .delete(`/api/workspaces/${workspaceId}/custom-llm-endpoints/tiers/max`)
      .expect(204)
    expect(endpointStore.clearTierDefault).toHaveBeenCalledWith({
      actingUserId: 'user-1', workspaceId, tier: 'max',
    })
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

// ── Endpoint failure fallback opt-in (migration 491) ───────────

describe('[COMP:api/custom-llm-endpoints] endpoint failure fallback opt-in', () => {
  beforeEach(() => vi.clearAllMocks())

  it('turns the fallback on for one connection and echoes the stored row', async () => {
    const { app, endpointStore } = setup()
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/fallback`)
      .send({ fallbackToDefaultOnFailure: true })
      .expect(200)
    expect(endpointStore.setFallbackPolicy).toHaveBeenCalledWith({
      actingUserId: 'user-1', workspaceId, endpointId, fallbackToDefaultOnFailure: true,
    })
    expect(res.body.endpoint.fallbackToDefaultOnFailure).toBe(true)
  })

  it('rejects a non-boolean, so a typo cannot silently enable platform serving', async () => {
    const { app, endpointStore } = setup()
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/fallback`)
      .send({ fallbackToDefaultOnFailure: 'yes' })
      .expect(400)
    expect(endpointStore.setFallbackPolicy).not.toHaveBeenCalled()
  })

  it('is admin-only, like every other write on this router', async () => {
    const { app, workspaceStore, endpointStore } = setup()
    vi.mocked(workspaceStore.getRole).mockResolvedValueOnce('member')
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/fallback`)
      .send({ fallbackToDefaultOnFailure: true })
      .expect(403)
    expect(endpointStore.setFallbackPolicy).not.toHaveBeenCalled()
  })

  it('404s for a connection outside the workspace', async () => {
    const { app, endpointStore } = setup()
    vi.mocked(endpointStore.setFallbackPolicy).mockResolvedValueOnce(null)
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/fallback`)
      .send({ fallbackToDefaultOnFailure: true })
      .expect(404)
  })
})
