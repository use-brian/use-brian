/**
 * [COMP:api/model-menu] Model selection routes — menus derive from the
 * registry gated by configured providers (L12), profiles CRUD is
 * membership-gated, estimates ride the injected closed seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { MutableProviderAvailability } from '@use-brian/shared/model-registry'
import { modelMenuRoutes, type ModelMenuRouteOptions } from '../model-menu.js'

const getRole = vi.fn()
const profiles = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}
const modelDefaults = {
  list: vi.fn(),
  setCurated: vi.fn(),
  setProfile: vi.fn(),
  clear: vi.fn(),
}
const endpointStore = {
  list: vi.fn(),
  listTierDefaults: vi.fn(),
  listModelRoutes: vi.fn(),
  setManagedTierRoute: vi.fn(),
  setTierDefault: vi.fn(),
  clearTierDefault: vi.fn(),
}
const decisionRoutingStore = {
  get: vi.fn(),
  getSystem: vi.fn(),
  set: vi.fn(),
}
const decisionEvaluationProfileStore = {
  listApproved: vi.fn(),
}

function makeApp(overrides?: Partial<ModelMenuRouteOptions>) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = 'u1'; next() })
  app.use('/api', modelMenuRoutes({
    workspaceStore: { getRole } as never,
    meteredProfileStore: profiles as never,
    modelDefaultsStore: modelDefaults as never,
    configuredProviders: new Set(['gemini', 'openai-compat:dashscope-intl']),
    estimateMeteredTurn: (alias, rounds) => ({ modelAlias: alias, toolRounds: rounds, minCredits: 9, maxCredits: 12 * rounds }),
    ...overrides,
  }))
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  getRole.mockResolvedValue('member')
  profiles.list.mockResolvedValue([])
  modelDefaults.list.mockResolvedValue([])
  endpointStore.list.mockResolvedValue([])
  endpointStore.listTierDefaults.mockResolvedValue([])
  endpointStore.listModelRoutes.mockResolvedValue([])
  decisionRoutingStore.get.mockResolvedValue(null)
  decisionEvaluationProfileStore.listApproved.mockResolvedValue([])
})

describe('[COMP:api/model-menu] GET /models/menu', () => {
  it('lists per-class menus with the wave-1 metered ports when the key is configured', async () => {
    const res = await request(makeApp()).get('/api/models/menu?workspaceId=00000000-0000-0000-0000-000000000001').expect(200)
    expect(res.body.classes['standard-pro'].map((m: { alias: string }) => m.alias))
      .toEqual(['gemini-3-flash-standard', 'gemini-flash-3'])
    // Both standard-pro aliases are billing labels of ONE wire model; the
    // serialized apiModelId is what lets pickers collapse them.
    expect(res.body.classes['standard-pro'].map((m: { apiModelId: string }) => m.apiModelId))
      .toEqual(['gemini-3-flash-preview', 'gemini-3-flash-preview'])
    // Labels come from the registry displayName; alias rows of one model
    // share one human name.
    expect(res.body.classes['standard-pro'].map((m: { displayName: string }) => m.displayName))
      .toEqual(['Gemini 3 Flash', 'Gemini 3 Flash'])
    expect(res.body.classes['metered'].map((m: { alias: string }) => m.alias).sort())
      .toEqual(['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen3.7-max', 'qwen3.7-plus'])
    expect(res.body.meteredBillingAvailable).toBe(true)
  })

  it('drops keyless-provider models from every menu without error (L12)', async () => {
    const res = await request(makeApp({ configuredProviders: new Set(['gemini']) }))
      .get('/api/models/menu?workspaceId=00000000-0000-0000-0000-000000000001').expect(200)
    expect(res.body.classes['metered']).toEqual([])
    expect(res.body.classes['standard-pro'].length).toBeGreaterThan(0)
  })

  it('shows only the account-scoped Codex catalog intersection', async () => {
    const availability = new MutableProviderAvailability()
    availability.setModelCatalog(
      'openai-codex',
      new Set(['gpt-5.6-terra', 'gpt-5.6-sol']),
    )
    const res = await request(makeApp({ configuredProviders: availability }))
      .get('/api/models/menu?workspaceId=00000000-0000-0000-0000-000000000001')
      .expect(200)
    expect(res.body.classes['standard-pro'].map((m: { alias: string }) => m.alias))
      .toEqual(['gpt-5.6-terra'])
    expect(res.body.classes['max'].map((m: { alias: string }) => m.alias))
      .toEqual(['gpt-5.6-sol'])
    expect(res.body.classes['research']).toEqual([])
  })

  it('hides profiles whose model lost its key, keeps them in the store', async () => {
    profiles.list.mockResolvedValue([
      { id: 'p1', workspaceId: 'w', name: 'deep', modelAlias: 'deepseek-v4-pro', toolRounds: 100, thinking: null },
    ])
    const res = await request(makeApp({ configuredProviders: new Set(['gemini']) }))
      .get('/api/models/menu?workspaceId=00000000-0000-0000-0000-000000000001').expect(200)
    expect(res.body.profiles).toEqual([])
  })

  it('403s non-members', async () => {
    getRole.mockResolvedValue(null)
    await request(makeApp()).get('/api/models/menu?workspaceId=00000000-0000-0000-0000-000000000001').expect(403)
  })
})

describe('[COMP:api/model-menu] metered estimate + profiles CRUD', () => {
  it('estimates at the requested budget through the injected seam', async () => {
    const res = await request(makeApp())
      .post('/api/models/metered-estimate')
      .send({ workspaceId: '00000000-0000-0000-0000-000000000001', modelAlias: 'qwen3.7-max', toolRounds: 100 })
      .expect(200)
    expect(res.body.estimate).toMatchObject({ modelAlias: 'qwen3.7-max', toolRounds: 100, maxCredits: 1200 })
  })

  it('creates a profile with clamped fields and returns it', async () => {
    profiles.create.mockResolvedValue({ id: 'p1', name: 'deep' })
    await request(makeApp())
      .post('/api/workspaces/00000000-0000-0000-0000-000000000001/metered-profiles')
      .send({ name: 'deep', modelAlias: 'deepseek-v4-pro', toolRounds: 100 })
      .expect(200)
    expect(profiles.create).toHaveBeenCalledWith(expect.objectContaining({ modelAlias: 'deepseek-v4-pro', toolRounds: 100 }))
  })

  it('maps a non-metered model to a 400', async () => {
    profiles.create.mockRejectedValue(new Error("metered-profile: 'gemini-3.8-flash' is not an active metered registry model"))
    const res = await request(makeApp())
      .post('/api/workspaces/00000000-0000-0000-0000-000000000001/metered-profiles')
      .send({ name: 'x', modelAlias: 'gemini-3.8-flash', toolRounds: 10 })
      .expect(400)
    expect(res.body.error).toBe('Not a metered model')
  })
})

describe('[COMP:api/model-menu] workspace model defaults', () => {
  const WID = '00000000-0000-0000-0000-000000000001'

  it('returns defaults in the menu, hiding keyless-profile and legacy curated pins', async () => {
    // 'not-a-model' stands in for an alias whose provider key is gone: it is
    // absent from the metered menu, so its profile — and any default pointing
    // at that profile — hides with it (L12). Flash 3.7 is a legacy Max row
    // after the 3.8 cutover and must also fall through to the registry default.
    profiles.list.mockResolvedValue([
      { id: 'p-visible', workspaceId: WID, name: 'deep', modelAlias: 'deepseek-v4-pro', toolRounds: 100, thinking: null },
      { id: 'p-hidden', workspaceId: WID, name: 'gone', modelAlias: 'not-a-model', toolRounds: 50, thinking: null },
    ])
    modelDefaults.list.mockResolvedValue([
      { workspaceId: WID, modelClass: 'max', modelAlias: null, meteredProfileId: 'p-visible', updatedAt: 'now' },
      { workspaceId: WID, modelClass: 'research', modelAlias: null, meteredProfileId: 'p-hidden', updatedAt: 'now' },
      { workspaceId: WID, modelClass: 'max', modelAlias: 'gemini-3.7-flash', meteredProfileId: null, updatedAt: 'now' },
    ])
    const res = await request(makeApp()).get(`/api/models/menu?workspaceId=${WID}`).expect(200)
    expect(res.body.defaults).toEqual([
      expect.objectContaining({ modelClass: 'max', meteredProfileId: 'p-visible' }),
    ])
  })

  it('403s a plain member on writes (owner/admin only)', async () => {
    getRole.mockResolvedValue('member')
    await request(makeApp())
      .put(`/api/workspaces/${WID}/model-defaults/max`)
      .send({ modelAlias: 'gemini-3.8-flash' })
      .expect(403)
    await request(makeApp()).delete(`/api/workspaces/${WID}/model-defaults/max`).expect(403)
    expect(modelDefaults.setCurated).not.toHaveBeenCalled()
  })

  it('sets a curated pin for an admin and maps cross-class rejection to 400', async () => {
    getRole.mockResolvedValue('admin')
    modelDefaults.setCurated.mockResolvedValue({ workspaceId: WID, modelClass: 'max', modelAlias: 'gemini-3.8-flash', meteredProfileId: null, updatedAt: 'now' })
    const ok = await request(makeApp())
      .put(`/api/workspaces/${WID}/model-defaults/max`)
      .send({ modelAlias: 'gemini-3.8-flash' })
      .expect(200)
    expect(ok.body.default.modelAlias).toBe('gemini-3.8-flash')

    modelDefaults.setCurated.mockRejectedValue(new Error("model-default: 'qwen3.7-max' is not an active curated menu model of class 'max'"))
    const bad = await request(makeApp())
      .put(`/api/workspaces/${WID}/model-defaults/max`)
      .send({ modelAlias: 'qwen3.7-max' })
      .expect(400)
    expect(bad.body.error).toBe('Not a curated model of this class')
  })

  it('rejects an unknown class before touching auth or the store', async () => {
    await request(makeApp()).put(`/api/workspaces/${WID}/model-defaults/metered`).send({ modelAlias: 'x' }).expect(400)
    expect(getRole).not.toHaveBeenCalled()
  })

  it('clears a default for an owner', async () => {
    getRole.mockResolvedValue('owner')
    modelDefaults.clear.mockResolvedValue(true)
    await request(makeApp()).delete(`/api/workspaces/${WID}/model-defaults/research`).expect(200)
    expect(modelDefaults.clear).toHaveBeenCalledWith(WID, 'research')
  })
})

describe('[COMP:api/model-menu] workspace tier routes', () => {
  const WID = '00000000-0000-0000-0000-000000000001'

  it('stores an exact available managed model for its matching tier', async () => {
    getRole.mockResolvedValue('admin')
    const availability = new MutableProviderAvailability()
    availability.setModelCatalog('openai-codex', new Set(['gpt-5.6-sol']))
    endpointStore.setManagedTierRoute.mockResolvedValue({
      workspaceId: WID,
      tier: 'max',
      profileId: null,
      modelAlias: 'gpt-5.6-sol',
      updatedAt: new Date(),
    })

    const res = await request(makeApp({
      configuredProviders: availability,
      customLlmEndpointStore: endpointStore as never,
    }))
      .put(`/api/workspaces/${WID}/model-routes/max`)
      .send({ modelAlias: 'gpt-5.6-sol' })
      .expect(200)

    expect(res.body.route.modelAlias).toBe('gpt-5.6-sol')
    expect(endpointStore.setManagedTierRoute).toHaveBeenCalledWith({
      actingUserId: 'u1',
      workspaceId: WID,
      tier: 'max',
      modelAlias: 'gpt-5.6-sol',
    })
  })

  it('rejects a cross-tier or unavailable managed alias', async () => {
    getRole.mockResolvedValue('admin')
    const availability = new MutableProviderAvailability()
    availability.setModelCatalog('openai-codex', new Set(['gpt-5.6-sol']))
    await request(makeApp({
      configuredProviders: availability,
      customLlmEndpointStore: endpointStore as never,
    }))
      .put(`/api/workspaces/${WID}/model-routes/pro`)
      .send({ modelAlias: 'gpt-5.6-sol' })
      .expect(400)
    expect(endpointStore.setManagedTierRoute).not.toHaveBeenCalled()
  })

  it('promotes the legacy Codex preference once when no workspace routes exist', async () => {
    getRole.mockResolvedValue('owner')
    const availability = new MutableProviderAvailability()
    availability.setPreferredProvider('openai-codex')
    endpointStore.listModelRoutes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { workspaceId: WID, tier: 'max', profileId: null, modelAlias: 'gpt-5.6-sol', updatedAt: new Date() },
      ])

    const res = await request(makeApp({
      configuredProviders: availability,
      customLlmEndpointStore: endpointStore as never,
    })).get(`/api/models/menu?workspaceId=${WID}`).expect(200)

    expect(endpointStore.setManagedTierRoute).toHaveBeenCalledTimes(4)
    expect(endpointStore.setManagedTierRoute).toHaveBeenCalledWith(expect.objectContaining({
      tier: 'max',
      modelAlias: 'gpt-5.6-sol',
    }))
    expect(res.body.modelRoutes).toHaveLength(1)
  })
})

describe('[COMP:decisions/workspace-routing] workspace decision classifier', () => {
  const WID = '00000000-0000-0000-0000-000000000001'

  it('lists configured decision adapters separately from chat models', async () => {
    decisionRoutingStore.get.mockResolvedValue({
      workspaceId: WID,
      mode: 'shadow',
      modelAlias: 'typesafe-jev-1.13',
      updatedAt: 'now',
    })
    const res = await request(makeApp({
      decisionRoutingStore: decisionRoutingStore as never,
      configuredDecisionAdapters: new Set(['typesafe']),
    })).get(`/api/models/menu?workspaceId=${WID}`).expect(200)

    expect(res.body.decisionRouting).toMatchObject({
      mode: 'shadow',
      modelAlias: 'typesafe-jev-1.13',
      shadowSampleRate: 0.1,
      models: [{ alias: 'typesafe-jev-1.13', displayName: 'Jev 1.13', adapterId: 'typesafe' }],
    })
    expect(Object.values(res.body.classes).flat()).not.toContainEqual(
      expect.objectContaining({ alias: 'typesafe-jev-1.13' }),
    )
  })

  it('shows the inherited deployment operator default when no workspace row exists', async () => {
    const res = await request(makeApp({
      decisionRoutingStore: decisionRoutingStore as never,
      configuredDecisionAdapters: new Set(['typesafe']),
      operatorDecisionDefault: {
        mode: 'operator_hybrid',
        modelAlias: 'typesafe-jev-1.13',
      },
    })).get(`/api/models/menu?workspaceId=${WID}`).expect(200)

    expect(res.body.decisionRouting).toMatchObject({
      mode: 'hybrid',
      modelAlias: 'typesafe-jev-1.13',
      updatedAt: null,
      operatorOverride: true,
    })
  })

  it('shows an explicit workspace setting instead of the deployment operator default', async () => {
    decisionRoutingStore.get.mockResolvedValue({
      workspaceId: WID,
      mode: 'llm_only',
      modelAlias: null,
      updatedAt: 'now',
    })
    const res = await request(makeApp({
      decisionRoutingStore: decisionRoutingStore as never,
      configuredDecisionAdapters: new Set(['typesafe']),
      operatorDecisionDefault: {
        mode: 'operator_hybrid',
        modelAlias: 'typesafe-jev-1.13',
      },
    })).get(`/api/models/menu?workspaceId=${WID}`).expect(200)

    expect(res.body.decisionRouting).toMatchObject({
      mode: 'llm_only',
      modelAlias: null,
      updatedAt: 'now',
      operatorOverride: false,
    })
  })

  it('lets an admin enable shadow but rejects an unconfigured adapter', async () => {
    getRole.mockResolvedValue('admin')
    decisionRoutingStore.set.mockResolvedValue({
      workspaceId: WID,
      mode: 'shadow',
      modelAlias: 'typesafe-jev-1.13',
      updatedAt: 'now',
    })
    await request(makeApp({
      decisionRoutingStore: decisionRoutingStore as never,
      configuredDecisionAdapters: new Set(['typesafe']),
    }))
      .put(`/api/workspaces/${WID}/decision-routing`)
      .send({ mode: 'shadow', modelAlias: 'typesafe-jev-1.13' })
      .expect(200)
    expect(decisionRoutingStore.set).toHaveBeenCalledWith({
      actingUserId: 'u1',
      workspaceId: WID,
      mode: 'shadow',
      modelAlias: 'typesafe-jev-1.13',
    })

    await request(makeApp({
      decisionRoutingStore: decisionRoutingStore as never,
      configuredDecisionAdapters: new Set(),
    }))
      .put(`/api/workspaces/${WID}/decision-routing`)
      .send({ mode: 'shadow', modelAlias: 'typesafe-jev-1.13' })
      .expect(400)
  })

  it('exposes exact hybrid capability and lets an admin opt in', async () => {
    getRole.mockResolvedValue('admin')
    decisionEvaluationProfileStore.listApproved.mockResolvedValue([{
      id: 'approved-research-intent',
      version: '1',
      operationId: 'research.intent',
      operationVersion: '1',
      stateVersion: '1',
      questionVersion: '1',
      modelCatalogId: 'typesafe-jev-1.13',
      modelWireId: 'jev-1.13.0',
      evaluationSegment: 'global',
      reportSha256: 'a'.repeat(64),
      approvedAt: '2026-09-29T00:00:00.000Z',
    }])
    decisionRoutingStore.set.mockResolvedValue({
      workspaceId: WID,
      mode: 'hybrid',
      modelAlias: 'typesafe-jev-1.13',
      updatedAt: 'now',
    })
    const options = {
      decisionRoutingStore: decisionRoutingStore as never,
      decisionEvaluationProfileStore: decisionEvaluationProfileStore as never,
      configuredDecisionAdapters: new Set(['typesafe']),
    }
    const menu = await request(makeApp(options))
      .get(`/api/models/menu?workspaceId=${WID}`)
      .expect(200)
    expect(menu.body.decisionRouting.models[0].hybridOperations).toEqual([{
      operationId: 'research.intent',
      operationVersion: '1',
      evaluationSegment: 'global',
      profileId: 'approved-research-intent',
      profileVersion: '1',
    }])

    await request(makeApp(options))
      .put(`/api/workspaces/${WID}/decision-routing`)
      .send({ mode: 'hybrid', modelAlias: 'typesafe-jev-1.13' })
      .expect(200)
    expect(decisionRoutingStore.set).toHaveBeenCalledWith({
      actingUserId: 'u1',
      workspaceId: WID,
      mode: 'hybrid',
      modelAlias: 'typesafe-jev-1.13',
    })
  })

  it('rejects hybrid without approved authority-bearing evidence', async () => {
    getRole.mockResolvedValue('admin')
    decisionEvaluationProfileStore.listApproved.mockResolvedValue([{
      id: 'observation-only',
      version: '1',
      operationId: 'ingest.sensitivity',
      operationVersion: '1',
      stateVersion: '1',
      questionVersion: '1',
      modelCatalogId: 'typesafe-jev-1.13',
      modelWireId: 'jev-1.13.0',
      evaluationSegment: 'global',
      reportSha256: 'a'.repeat(64),
      approvedAt: '2026-09-29T00:00:00.000Z',
    }])
    const res = await request(makeApp({
      decisionRoutingStore: decisionRoutingStore as never,
      decisionEvaluationProfileStore: decisionEvaluationProfileStore as never,
      configuredDecisionAdapters: new Set(['typesafe']),
    }))
      .put(`/api/workspaces/${WID}/decision-routing`)
      .send({ mode: 'hybrid', modelAlias: 'typesafe-jev-1.13' })
      .expect(400)
    expect(res.body.error).toMatch(/No approved hybrid operation/)
    expect(decisionRoutingStore.set).not.toHaveBeenCalled()
  })

  it('keeps decision-routing writes owner/admin only', async () => {
    getRole.mockResolvedValue('member')
    await request(makeApp({
      decisionRoutingStore: decisionRoutingStore as never,
      configuredDecisionAdapters: new Set(['typesafe']),
    }))
      .put(`/api/workspaces/${WID}/decision-routing`)
      .send({ mode: 'llm_only' })
      .expect(403)
    expect(decisionRoutingStore.set).not.toHaveBeenCalled()
  })
})
