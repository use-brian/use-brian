/**
 * Unit tests for the home-dock routes.
 * Component tag: [COMP:api/home-dock-routes].
 *
 * The routes take their store + signal assembler + refresh runner as
 * injected deps, so no module mocks are needed — we pass `vi.fn()`
 * doubles and exercise the auth / workspaceId / membership guards plus
 * the GET-resolve and POST-refresh happy paths via supertest. The real
 * `mergeHomeDock` (imported by the route) runs against a fixture, so the
 * assertions double as a check that the route hands signals to the merge
 * unchanged (freshness contract: a live-counted dock, dead cards dropped).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { HomeSignals } from '@use-brian/core'
import { homeDockRoutes, type HomeDockRoutesDeps } from '../home-dock.js'

const SIGNALS: HomeSignals = {
  brainReviewCount: 2,
  approvalsCount: 0,
  autopilotCount: 0,
  taskTriageCount: 0,
  connectorAttentionCount: 0,
  workflowAttentionCount: 0,
  upcomingWorkflows: [{ id: 'wf1', name: 'Weekly digest', nextRunAt: '2026-07-08T09:00:00.000Z' }],
  recentDrafts: [{ id: 'd1', name: 'Untitled', updatedAt: '2026-07-07T08:00:00.000Z' }],
  brainEntryCount: 42,
  brainGrowth7d: 5,
  brainSparkline: [0, 0, 1, 0, 2, 0, 0, 1, 0, 0, 1, 0, 0, 0],
  onboarding: { hasConnector: true },
}

function makeDeps(over?: Partial<HomeDockRoutesDeps>): HomeDockRoutesDeps {
  return {
    homeDockStore: { get: vi.fn().mockResolvedValue(null), put: vi.fn() },
    isWorkspaceMember: vi.fn().mockResolvedValue(true),
    assembleSignals: vi.fn().mockResolvedValue(SIGNALS),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

function makeApp(deps: HomeDockRoutesDeps, userId?: string) {
  const app = express()
  app.use(express.json())
  if (userId) {
    app.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = userId
      next()
    })
  }
  app.use('/api/home-dock', homeDockRoutes(deps))
  return app
}

describe('[COMP:api/home-dock-routes] GET /api/home-dock', () => {
  let deps: HomeDockRoutesDeps
  beforeEach(() => {
    deps = makeDeps()
  })

  it('401 without auth', async () => {
    const res = await request(makeApp(deps)).get('/api/home-dock?workspaceId=w1')
    expect(res.status).toBe(401)
    expect(deps.assembleSignals).not.toHaveBeenCalled()
  })

  it('400 without workspaceId', async () => {
    const res = await request(makeApp(deps, 'u1')).get('/api/home-dock')
    expect(res.status).toBe(400)
  })

  it('404 when not a workspace member (no existence leak)', async () => {
    deps.isWorkspaceMember = vi.fn().mockResolvedValue(false)
    const res = await request(makeApp(deps, 'u1')).get('/api/home-dock?workspaceId=w1')
    expect(res.status).toBe(404)
    expect(deps.assembleSignals).not.toHaveBeenCalled()
  })

  it('200 resolves the deterministic dock (no artifact) from live signals', async () => {
    const res = await request(makeApp(deps, 'u1')).get('/api/home-dock?workspaceId=w1')
    expect(res.status).toBe(200)
    expect(deps.homeDockStore.get).toHaveBeenCalledWith('u1', 'w1')
    expect(deps.assembleSignals).toHaveBeenCalledWith('u1', 'w1')
    const dock = res.body.dock
    expect(dock.source).toBe('default')
    // Live-counted "needs you" — brainReviewCount=2 survives, dead cards dropped.
    expect(dock.needsYou).toContainEqual({ kind: 'brain_review', count: 2, caption: null })
    expect(dock.needsYou.every((c: { count: number }) => c.count > 0)).toBe(true)
    // Signals pass through to the resolved dock unchanged.
    expect(dock.pickUp).toEqual(SIGNALS.recentDrafts)
    expect(dock.comingUp).toEqual(SIGNALS.upcomingWorkflows)
    expect(dock.brain).toEqual({
      entryCount: 42,
      growth7d: 5,
      sparkline: SIGNALS.brainSparkline,
      hasConnector: true,
    })
  })

  it('500 when signal assembly throws', async () => {
    deps.assembleSignals = vi.fn().mockRejectedValue(new Error('boom'))
    const res = await request(makeApp(deps, 'u1')).get('/api/home-dock?workspaceId=w1')
    expect(res.status).toBe(500)
  })
})

describe('[COMP:api/home-dock-routes] POST /api/home-dock/refresh', () => {
  let deps: HomeDockRoutesDeps
  beforeEach(() => {
    deps = makeDeps()
  })

  it('401 without auth', async () => {
    const res = await request(makeApp(deps)).post('/api/home-dock/refresh?workspaceId=w1')
    expect(res.status).toBe(401)
    expect(deps.refresh).not.toHaveBeenCalled()
  })

  it('404 when not a workspace member', async () => {
    deps.isWorkspaceMember = vi.fn().mockResolvedValue(false)
    const res = await request(makeApp(deps, 'u1')).post('/api/home-dock/refresh?workspaceId=w1')
    expect(res.status).toBe(404)
    expect(deps.refresh).not.toHaveBeenCalled()
  })

  it('200 runs refresh then returns the resolved dock', async () => {
    const res = await request(makeApp(deps, 'u1')).post('/api/home-dock/refresh?workspaceId=w1')
    expect(res.status).toBe(200)
    expect(deps.refresh).toHaveBeenCalledWith('u1', 'w1')
    expect(res.body.dock.source).toBe('default')
  })

  it('200 falls through to the deterministic dock when refresh rejects (best-effort)', async () => {
    deps.refresh = vi.fn().mockRejectedValue(new Error('curation failed'))
    const res = await request(makeApp(deps, 'u1')).post('/api/home-dock/refresh?workspaceId=w1')
    expect(res.status).toBe(200)
    expect(deps.assembleSignals).toHaveBeenCalled()
    expect(res.body.dock.brain.entryCount).toBe(42)
  })
})
