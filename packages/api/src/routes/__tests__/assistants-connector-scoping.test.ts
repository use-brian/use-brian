import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

// The connector-list endpoint mirrors injectMcpTools's workspace-scoping
// gate (incident 2026-06-01 / 2026-06-02). Mock the helper so we can drive
// solo-personal vs shared/multi-member workspace from each test.
vi.mock('../../db/workspace-store.js', () => ({
  isSoloWorkspaceSystem: vi.fn<(id: string) => Promise<boolean>>(),
}))

import { assistantRoutes } from '../assistants.js'
import { queryWithRLS } from '../../db/client.js'
import { isSoloWorkspaceSystem } from '../../db/workspace-store.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockIsPersonal = vi.mocked(isSoloWorkspaceSystem)

const connectorStore = { list: vi.fn() }
const assistantConnectorStore = { listForAssistant: vi.fn() }
const connectorInstanceStore = { listByWorkspaceSystem: vi.fn() }
const connectorGrantStore = { listForTargetSystem: vi.fn() }

beforeEach(() => {
  mockQueryWithRLS.mockReset()
  mockIsPersonal.mockReset()
  connectorStore.list.mockReset().mockResolvedValue([])
  assistantConnectorStore.listForAssistant.mockReset().mockResolvedValue([])
  connectorInstanceStore.listByWorkspaceSystem.mockReset().mockResolvedValue([])
  connectorGrantStore.listForTargetSystem.mockReset().mockResolvedValue([])
})

function makeApp(userId: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { userId: string }).userId = userId
    next()
  })
  app.use(
    '/api/assistants',
    assistantRoutes({
      connectorStore: connectorStore as never,
      assistantConnectorStore: assistantConnectorStore as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      capabilityStore: {} as never,
    }),
  )
  return app
}

// verifyMembership runs one queryWithRLS (role), then the endpoint runs a
// second (the assistant's workspace_id). Queue both per request.
function queueMembershipAndTeam(role: string, workspaceId: string | null) {
  mockQueryWithRLS
    .mockResolvedValueOnce({ rows: [{ role }], rowCount: 1 } as never) // membership
    .mockResolvedValueOnce({ rows: [{ workspace_id: workspaceId }], rowCount: 1 } as never) // team
}

describe('[COMP:routes/assistants-connector-scoping] GET /:assistantId/connectors workspace gate', () => {
  it('suppresses the viewer\'s personal connectors for a SHARED / multi-member workspace', async () => {
    queueMembershipAndTeam('admin', 'ws-shared')
    mockIsPersonal.mockResolvedValueOnce(false) // shared OR is_personal-with-teammates
    connectorInstanceStore.listByWorkspaceSystem.mockResolvedValueOnce([
      { provider: 'github', label: 'Team Github', url: null, custom: false, connected: true },
    ])

    const res = await request(makeApp('u-admin')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    expect(mockIsPersonal).toHaveBeenCalledWith('ws-shared')
    // The fix: personal connectors are never even loaded for a shared workspace.
    expect(connectorStore.list).not.toHaveBeenCalled()
    const ids = (res.body.connectors as Array<{ id: string; scope: string }>).map((c) => c.id)
    expect(ids).toEqual(['github'])
    expect(res.body.connectors[0].scope).toBe('team-native')
  })

  it('loads the owner\'s personal connectors for a SOLO personal workspace', async () => {
    queueMembershipAndTeam('owner', 'ws-personal')
    mockIsPersonal.mockResolvedValueOnce(true) // solo personal — owner is sole member
    connectorStore.list.mockResolvedValueOnce([
      { connectorId: 'gmail', name: 'Gmail', url: null, custom: false, connected: true },
    ])

    const res = await request(makeApp('u-owner')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    expect(mockIsPersonal).toHaveBeenCalledWith('ws-personal')
    expect(connectorStore.list).toHaveBeenCalledWith('u-owner')
    const personal = (res.body.connectors as Array<{ id: string; scope: string }>).find(
      (c) => c.id === 'gmail',
    )
    expect(personal?.scope).toBe('personal')
  })

  it('loads personal connectors and never calls the gate for a workspace-less personal assistant', async () => {
    queueMembershipAndTeam('owner', null) // no workspace
    connectorStore.list.mockResolvedValueOnce([
      { connectorId: 'notion', name: 'Notion', url: null, custom: false, connected: true },
    ])

    const res = await request(makeApp('u-owner')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    expect(mockIsPersonal).not.toHaveBeenCalled() // gate only runs when there's a workspace
    expect(connectorStore.list).toHaveBeenCalledWith('u-owner')
    const ids = (res.body.connectors as Array<{ id: string }>).map((c) => c.id)
    expect(ids).toContain('notion')
  })
})
