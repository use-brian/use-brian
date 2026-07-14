import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { assistantRoutes } from '../assistants.js'
import { queryWithRLS } from '../../db/client.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)

const connectorStore = { list: vi.fn() }
const assistantConnectorStore = { listForAssistant: vi.fn() }
const connectorInstanceStore = { listByWorkspaceSystem: vi.fn() }
const connectorGrantStore = { listForTargetSystem: vi.fn() }

beforeEach(() => {
  mockQueryWithRLS.mockReset()
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
  // Mirrors injectMcpTools's scoping gate (incidents 2026-06-01 / 2026-06-02 /
  // 2026-07-14): a workspace assistant's editor lists only team-native +
  // granted connectors — the viewer's personal ones are never even loaded,
  // whatever the workspace's member count.
  it("suppresses the viewer's personal connectors for a multi-member workspace", async () => {
    queueMembershipAndTeam('admin', 'ws-shared')
    connectorInstanceStore.listByWorkspaceSystem.mockResolvedValueOnce([
      { provider: 'github', label: 'Team Github', url: null, custom: false, connected: true },
    ])

    const res = await request(makeApp('u-admin')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    // The fix: personal connectors are never even loaded for a workspace assistant.
    expect(connectorStore.list).not.toHaveBeenCalled()
    const connectors = res.body.connectors as Array<{ id: string; scope: string }>
    // Non-builtin rows: only the team-native one. Built-in primitives
    // (files) are synthesized in every response — asserted separately below.
    expect(connectors.filter((c) => c.scope !== 'builtin').map((c) => c.id)).toEqual(['github'])
    expect(connectors[0].scope).toBe('team-native')
  })

  it('suppresses personal connectors for a SOLO workspace too — exposure is the boundary (2026-07-14)', async () => {
    queueMembershipAndTeam('owner', 'ws-personal')
    connectorStore.list.mockResolvedValueOnce([
      { connectorId: 'gmail', name: 'Gmail', url: null, custom: false, connected: true },
    ])

    const res = await request(makeApp('u-owner')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    // The old solo default base-loaded the owner's full personal set here.
    expect(connectorStore.list).not.toHaveBeenCalled()
    const gmail = (res.body.connectors as Array<{ id: string }>).find((c) => c.id === 'gmail')
    expect(gmail).toBeUndefined()
  })

  it('lists a connector exposed to the workspace via a grant (any member count)', async () => {
    queueMembershipAndTeam('owner', 'ws-personal')
    connectorGrantStore.listForTargetSystem.mockResolvedValueOnce([
      {
        grantedByUserId: 'u-owner',
        instance: { provider: 'gmail', label: 'Gmail', url: null, custom: false, connected: true },
      },
    ])

    const res = await request(makeApp('u-owner')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    const gmail = (res.body.connectors as Array<{ id: string; scope: string }>).find(
      (c) => c.id === 'gmail',
    )
    expect(gmail?.scope).toBe('team-grant')
  })

  it('synthesizes an always-on built-in row (Workspace Files) with no backing connector row', async () => {
    queueMembershipAndTeam('admin', 'ws-shared')
    // No instances, no grants, no personal connectors — the built-in must
    // still appear (it has no row in ANY source; the route synthesizes it).
    const res = await request(makeApp('u-admin')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    const files = (
      res.body.connectors as Array<{ id: string; scope: string; connected: boolean; enabled: boolean; custom: boolean }>
    ).find((c) => c.id === 'files')
    expect(files).toBeDefined()
    expect(files?.scope).toBe('builtin')
    expect(files?.connected).toBe(true)
    expect(files?.enabled).toBe(true)
    expect(files?.custom).toBe(false)
  })

  it('applies a stored per-assistant enabled=false to the synthesized built-in row', async () => {
    queueMembershipAndTeam('admin', 'ws-shared')
    assistantConnectorStore.listForAssistant.mockResolvedValueOnce([
      { connectorId: 'files', enabled: false },
    ])

    const res = await request(makeApp('u-admin')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    const files = (res.body.connectors as Array<{ id: string; enabled: boolean }>).find(
      (c) => c.id === 'files',
    )
    expect(files?.enabled).toBe(false)
  })

  it('loads personal connectors for a workspace-less personal assistant', async () => {
    queueMembershipAndTeam('owner', null) // no workspace
    connectorStore.list.mockResolvedValueOnce([
      { connectorId: 'notion', name: 'Notion', url: null, custom: false, connected: true },
    ])

    const res = await request(makeApp('u-owner')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    expect(connectorStore.list).toHaveBeenCalledWith('u-owner')
    const ids = (res.body.connectors as Array<{ id: string }>).map((c) => c.id)
    expect(ids).toContain('notion')
  })
})
