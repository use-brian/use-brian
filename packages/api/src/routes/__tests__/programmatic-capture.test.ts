import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { ProgrammaticCaptureStore } from '../../db/programmatic-capture-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import { programmaticCaptureRoutes } from '../programmatic-capture.js'

const WID = '11111111-1111-4111-8111-111111111111'
const PID = '22222222-2222-4222-8222-222222222222'
const AID = '33333333-3333-4333-8333-333333333333'

function makeDeps() {
  const profile = {
    id: PID,
    workspaceId: WID,
    name: 'Writer capture',
    partitionBy: 'session' as const,
    enabled: true,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    assistantIds: [],
    rules: [],
  }
  const store = {
    listProfiles: vi.fn().mockResolvedValue([profile]),
    createProfile: vi.fn().mockResolvedValue(profile),
    updateProfile: vi.fn().mockResolvedValue(profile),
    deleteProfile: vi.fn().mockResolvedValue(true),
    addRule: vi.fn().mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      profileId: PID,
      ruleOrder: 0,
      filterType: 'always',
      filterParams: {},
      routingMode: 'scheduled',
      routingSchedule: '0 * * * *',
      routingTimezone: 'UTC',
      episodeSensitivity: null,
      compartments: [],
      projectIds: [],
    }),
    updateRule: vi.fn(),
    deleteRule: vi.fn().mockResolvedValue(true),
    setAssistantProfile: vi.fn().mockResolvedValue(true),
    resolveTargetSystem: vi.fn(),
    resolveBatchTargetSystem: vi.fn(),
  } as unknown as ProgrammaticCaptureStore
  const workspaceStore = { getRole: vi.fn().mockResolvedValue('owner') } as unknown as WorkspaceStore
  return { store, workspaceStore }
}

function app(deps: ReturnType<typeof makeDeps>) {
  const value = express()
  value.use(express.json())
  value.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = 'user-1'
    next()
  })
  value.use(
    '/api/workspaces/:workspaceId/programmatic-capture-profiles',
    programmaticCaptureRoutes(deps),
  )
  return value
}

describe('[COMP:api/programmatic-capture] management routes', () => {
  it('creates a workspace capture profile', async () => {
    const deps = makeDeps()
    const response = await request(app(deps))
      .post(`/api/workspaces/${WID}/programmatic-capture-profiles`)
      .send({ name: 'Writer capture', partitionBy: 'session', enabled: true })
    expect(response.status).toBe(201)
    expect(deps.store.createProfile).toHaveBeenCalledWith(expect.objectContaining({
      actingUserId: 'user-1', workspaceId: WID, name: 'Writer capture', partitionBy: 'session',
    }))
  })

  it('validates and adds a scheduled rule', async () => {
    const deps = makeDeps()
    const response = await request(app(deps))
      .post(`/api/workspaces/${WID}/programmatic-capture-profiles/${PID}/rules`)
      .send({
        filterType: 'keyword_match',
        filterParams: { keywords: ['outline', 'character'] },
        routingMode: 'scheduled',
        routingSchedule: '0 * * * *',
        routingTimezone: 'UTC',
        episodeSensitivity: null,
        compartments: [],
        projectIds: [],
      })
    expect(response.status).toBe(201)
    expect(deps.store.addRule).toHaveBeenCalledOnce()
  })

  it('sets an assistant default profile', async () => {
    const deps = makeDeps()
    const response = await request(app(deps))
      .put(`/api/workspaces/${WID}/programmatic-capture-profiles/assistants/${AID}/default`)
      .send({ profileId: PID })
    expect(response.status).toBe(204)
    expect(deps.store.setAssistantProfile).toHaveBeenCalledWith({
      actingUserId: 'user-1', workspaceId: WID, assistantId: AID, profileId: PID,
    })
  })

  it('rejects a scheduled rule without a schedule before touching the store', async () => {
    const deps = makeDeps()
    const response = await request(app(deps))
      .post(`/api/workspaces/${WID}/programmatic-capture-profiles/${PID}/rules`)
      .send({ filterType: 'always', filterParams: {}, routingMode: 'scheduled' })
    expect(response.status).toBe(400)
    expect(deps.store.addRule).not.toHaveBeenCalled()
  })
})
