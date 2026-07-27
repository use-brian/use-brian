import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveUser: vi.fn(),
  getWorkspaceRoleSystem: vi.fn(),
}))

vi.mock('../../routes/route-helpers.js', () => ({
  resolveUser: mocks.resolveUser,
}))
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceRoleSystem: mocks.getWorkspaceRoleSystem,
}))

import { supportDiagnosticRoutes } from '../routes.js'
import type {
  SupportDiagnosticCapture,
  SupportDiagnosticsStore,
} from '../types.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'
const CAPTURE_ID = '00000000-0000-4000-8000-000000000003'

function makeCapture(): SupportDiagnosticCapture {
  return {
    id: CAPTURE_ID,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    includeContent: false,
    pseudonymSalt: Buffer.alloc(32),
    startedAt: new Date('2026-07-27T00:00:00.000Z'),
    expiresAt: new Date('2026-07-28T00:00:00.000Z'),
    eventCount: 3,
  }
}

function makeHarness() {
  const capture = makeCapture()
  const store: SupportDiagnosticsStore = {
    start: vi.fn(async () => capture),
    getAnyActive: vi.fn(async () => capture),
    getOwnedActive: vi.fn(async () => capture),
    appendEvents: vi.fn(),
    listEvents: vi.fn(async () => []),
    deleteCapture: vi.fn(),
    deleteOwnedCapture: vi.fn(async () => CAPTURE_ID),
    deleteExpired: vi.fn(async () => []),
  }
  const captureManager = {
    activate: vi.fn(),
    deactivate: vi.fn(),
    flush: vi.fn(),
  }
  const capsuleBuilder = {
    preview: vi.fn(async () => ({
      captureId: CAPTURE_ID,
      expiresAt: capture.expiresAt.toISOString(),
      includeContent: false,
      selectedSessionId: null,
      categories: [],
      warnings: [],
    })),
    build: vi.fn(async () => ({
      capture,
      capsule: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        manifest: {
          captureId: '[capture:test]',
          startedAt: capture.startedAt.toISOString(),
          expiresAt: capture.expiresAt.toISOString(),
          includeContent: false,
          selectedSessionId: null,
          categories: [],
          exclusions: [],
        },
        system: {},
        database: { migrations: [], health: {} },
        captureEvents: [],
        analyticsEvents: [],
        session: null,
        sessionMessages: [],
        workflowRuns: [],
        scheduledJobs: [],
      },
    })),
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { userId?: string }).userId = USER_ID
    next()
  })
  app.use('/api/support-diagnostics', supportDiagnosticRoutes({
    store,
    captureManager: captureManager as never,
    capsuleBuilder: capsuleBuilder as never,
  }))
  return { app, store, captureManager, capsuleBuilder }
}

describe('[COMP:api/support-diagnostics] support diagnostics routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveUser.mockResolvedValue({ id: USER_ID })
    mocks.getWorkspaceRoleSystem.mockResolvedValue('owner')
  })

  it('starts a bounded capture for a workspace owner', async () => {
    const { app, store, captureManager } = makeHarness()
    const response = await request(app)
      .post('/api/support-diagnostics/start')
      .send({ workspaceId: WORKSPACE_ID, durationHours: 24, includeContent: false })

    expect(response.status).toBe(201)
    expect(response.body.active).toBe(true)
    expect(store.start).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      includeContent: false,
    }))
    expect(captureManager.activate).toHaveBeenCalled()
  })

  it('rejects ordinary workspace members', async () => {
    mocks.getWorkspaceRoleSystem.mockResolvedValue('member')
    const { app, store } = makeHarness()
    const response = await request(app)
      .post('/api/support-diagnostics/start')
      .send({ workspaceId: WORKSPACE_ID, durationHours: 24, includeContent: false })

    expect(response.status).toBe(403)
    expect(store.start).not.toHaveBeenCalled()
  })

  it('constructs the attachment before deleting the local capture', async () => {
    const { app, store, captureManager } = makeHarness()
    const response = await request(app)
      .post('/api/support-diagnostics/capsule')
      .send({ workspaceId: WORKSPACE_ID })

    expect(response.status).toBe(200)
    expect(response.headers['content-disposition']).toContain('brian-support-capsule-')
    expect(response.body.schemaVersion).toBe(1)
    expect(captureManager.deactivate).toHaveBeenCalledWith(CAPTURE_ID)
    expect(store.deleteCapture).toHaveBeenCalledWith(CAPTURE_ID)
  })
})
