import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchHomeDock } from '../../../../../apps/app-web/src/lib/api/home-dock'
import { homeDockRoutes } from '../home-dock.js'
import { createInProcessRequester, createTestApp } from './helpers.js'

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock('@/lib/auth-fetch', () => ({ authFetch }))
vi.mock('@/lib/runtime-public-config', () => ({
  publicRuntimeConfig: () => ({ apiUrl: 'http://api.example.test' }),
}))

// Load the real implementations from source before workspace packages are built.
vi.mock('@use-brian/core/home/merge.js', () => import('../../../../core/src/home/merge.js'))
vi.mock('@use-brian/shared/home-dock', () => import('../../../../shared/src/home-dock.js'))

const signals = {
  brainReviewCount: 2,
  approvalsCount: 1,
  approvalGroups: {
    externalActions: 0,
    contentReview: 1,
    systemImprovements: 0,
    questionsAndAccess: 0,
  },
  autopilotCount: 0,
  taskTriageCount: 0,
  taskCleanupCount: 0,
  dealAttentionCount: 0,
  connectorAttentionCount: 0,
  workflowAttentionCount: 0,
  upcomingWorkflows: [{ id: 'wf1', name: 'Weekly digest', nextRunAt: '2026-07-08T09:00:00.000Z' }],
  recentDrafts: [{ id: 'd1', name: 'Untitled', updatedAt: '2026-07-07T08:00:00.000Z' }],
  brainEntryCount: 42,
  brainGrowth7d: 5,
  brainSparkline: [0, 2, 0, 3],
  onboarding: { hasConnector: true },
}

const workspaceId = 'w+1 & notes'
const query = `?workspaceId=${encodeURIComponent(workspaceId)}`
const mountPath = '/api/home-dock'
const endpoints = [
  ['GET', mountPath],
  ['POST', `${mountPath}/refresh`],
]

function fixture(userId) {
  const homeDockStore = { get: vi.fn().mockResolvedValue(null), put: vi.fn() }
  const assembleSignals = vi.fn().mockResolvedValue(signals)
  const refresh = vi.fn().mockResolvedValue(undefined)
  const router = homeDockRoutes({
    homeDockStore,
    isWorkspaceMember: async (user, workspace) => user === 'u1' && workspace === workspaceId,
    assembleSignals,
    refresh,
  })
  const api = createInProcessRequester(createTestApp(mountPath, router, { userId }))
  authFetch.mockImplementation(api)
  return { api, homeDockStore, assembleSignals, refresh }
}

beforeEach(() => { authFetch.mockReset() })

describe('[COMP:api/home-dock-routes] [COMP:app-web/home-dock] [COMP:shared/home-dock] Home Dock HTTP contract', () => {
  it.each(endpoints)('%s %s refuses anonymous requests before accessing workspace data', async (method, path) => {
    const { api, homeDockStore, assembleSignals, refresh } = fixture()
    expect((await api(path + query, { method })).status).toBe(401)
    expect(homeDockStore.get).not.toHaveBeenCalled()
    expect(assembleSignals).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it.each(endpoints)('%s %s conceals the workspace from nonmembers', async (method, path) => {
    const { api, homeDockStore, assembleSignals, refresh } = fixture('u2')
    const response = await api(path + query, { method })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Not found' })
    expect(homeDockStore.get).not.toHaveBeenCalled()
    expect(assembleSignals).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('requires a workspaceId query parameter', async () => {
    const { api } = fixture('u1')
    expect((await api(mountPath)).status).toBe(400)
  })

  it('reads the complete dock through the SDK and drops a handled item on the next read', async () => {
    const { homeDockStore, assembleSignals } = fixture('u1')
    await expect(fetchHomeDock(workspaceId)).resolves.toEqual({
      source: 'default',
      generatedAt: null,
      note: null,
      needsYou: [
        { kind: 'brain_review', count: 2, caption: null },
        { kind: 'approvals', count: 1, caption: null },
      ],
      approvalGroups: signals.approvalGroups,
      pickUp: signals.recentDrafts,
      comingUp: signals.upcomingWorkflows,
      brain: { entryCount: 42, growth7d: 5, sparkline: signals.brainSparkline, hasConnector: true },
    })
    await expect(authFetch.mock.results[0].value).resolves.toMatchObject({ status: 200 })
    expect(homeDockStore.get).toHaveBeenCalledWith('u1', workspaceId)
    expect(assembleSignals).toHaveBeenCalledWith('u1', workspaceId)

    assembleSignals.mockResolvedValueOnce({ ...signals, brainReviewCount: 0 })
    await expect(fetchHomeDock(workspaceId)).resolves.toMatchObject({
      needsYou: [{ kind: 'approvals', count: 1, caption: null }],
    })
  })

  it('returns the SDK fallback on a real 500 from signal assembly', async () => {
    const { assembleSignals } = fixture('u1')
    assembleSignals.mockRejectedValueOnce(new Error('signals unavailable'))
    await expect(fetchHomeDock(workspaceId)).resolves.toBeNull()
    await expect(authFetch.mock.results[0].value).resolves.toMatchObject({ status: 500 })
  })

  it('runs refresh before reading the dock', async () => {
    const { api, homeDockStore, refresh } = fixture('u1')
    refresh.mockImplementationOnce(async () => {
      homeDockStore.get.mockResolvedValueOnce({
        version: 1, needsYou: [], note: 'New layout',
        generatedAt: '2026-07-08T10:00:00.000Z', generatedByAssistantId: null,
      })
    })
    const response = await api(`${mountPath}/refresh${query}`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(refresh).toHaveBeenCalledExactlyOnceWith('u1', workspaceId)
    expect((await response.json()).dock).toMatchObject({ source: 'assistant', note: 'New layout' })
  })

  it('still serves the dock when refresh fails', async () => {
    const { api, refresh } = fixture('u1')
    refresh.mockRejectedValueOnce(new Error('curation failed'))
    const response = await api(`${mountPath}/refresh${query}`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect((await response.json()).dock).toMatchObject({ source: 'default', brain: { entryCount: 42 } })
  })
})
