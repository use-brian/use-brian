import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

// verifyMembership now delegates to `resolveAssistantAccess` — the single access
// predicate (see [COMP:api/assistant-access]). It is one call, not a route-local
// membership join, so the gate is stubbed here instead of via queryWithRLS.
vi.mock('../../db/users.js', () => ({
  resolveAssistantAccess: vi.fn(),
}))

const mockDiscoverCli = vi.fn()
vi.mock('../../mcp/cli-transport.js', () => ({
  discoverCliServer: (...args: unknown[]) => mockDiscoverCli(...args),
}))

import { assistantRoutes } from '../assistants.js'
import { queryWithRLS } from '../../db/client.js'
import { resolveAssistantAccess } from '../../db/users.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockAccess = vi.mocked(resolveAssistantAccess)

const connectorStore = { list: vi.fn() }
const assistantConnectorStore = { listForAssistant: vi.fn() }
const connectorInstanceStore = {
  listByWorkspaceSystem: vi.fn(),
  get: vi.fn(),
  getAuthCredentialsSystem: vi.fn(),
}
const connectorGrantStore = { listForTargetSystem: vi.fn() }
const mcpSettingsStore = { getPolicy: vi.fn(), setPolicy: vi.fn() }

beforeEach(() => {
  mockQueryWithRLS.mockReset()
  connectorStore.list.mockReset().mockResolvedValue([])
  assistantConnectorStore.listForAssistant.mockReset().mockResolvedValue([])
  connectorInstanceStore.listByWorkspaceSystem.mockReset().mockResolvedValue([])
  connectorInstanceStore.get.mockReset().mockResolvedValue(null)
  connectorInstanceStore.getAuthCredentialsSystem.mockReset().mockResolvedValue(null)
  connectorGrantStore.listForTargetSystem.mockReset().mockResolvedValue([])
  mockDiscoverCli.mockReset().mockResolvedValue({ name: 'CLI', tools: [] })
  mcpSettingsStore.getPolicy.mockReset().mockResolvedValue(null)
  mcpSettingsStore.setPolicy.mockReset().mockResolvedValue(undefined)
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
      mcpSettingsStore: mcpSettingsStore as never,
      capabilityStore: {} as never,
    }),
  )
  return app
}

// verifyMembership resolves through the access predicate (one call, no
// queryWithRLS); the endpoint then runs a queryWithRLS for the assistant's
// workspace_id. Queue both per request.
function queueMembershipAndTeam(role: string, workspaceId: string | null) {
  mockAccess.mockResolvedValueOnce({
    assistant: { id: 'a-1', name: 'A', workspaceId },
    role,
  } as never)
  mockQueryWithRLS.mockResolvedValueOnce({
    rows: [{ workspace_id: workspaceId }],
    rowCount: 1,
  } as never) // team
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

  it('does not expose internal WhatsApp channel instances as tool connectors', async () => {
    queueMembershipAndTeam('admin', 'ws-shared')
    connectorInstanceStore.listByWorkspaceSystem.mockResolvedValueOnce([
      { provider: 'whatsapp', label: 'WhatsApp', url: null, custom: false, connected: true },
      { provider: 'github', label: 'Team Github', url: null, custom: false, connected: true },
    ])

    const res = await request(makeApp('u-admin')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    const ids = (res.body.connectors as Array<{ id: string }>).map((c) => c.id)
    expect(ids).toContain('github')
    expect(ids).not.toContain('whatsapp')
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

  it('projects every shared CLI instance as a separate connector card', async () => {
    queueMembershipAndTeam('owner', 'ws-personal')
    connectorGrantStore.listForTargetSystem.mockResolvedValueOnce([
      {
        grantedByUserId: 'u-owner',
        instance: {
          id: 'cli-newer', provider: 'cli', label: 'Project calendar',
          url: null, custom: false, connected: true, config: {},
          createdAt: new Date('2026-07-03T00:00:00Z'),
        },
      },
      {
        grantedByUserId: 'u-owner',
        instance: {
          id: 'cli-primary', provider: 'cli', label: 'Proton calendar',
          url: null, custom: false, connected: true, config: {},
          createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      },
    ])

    const res = await request(makeApp('u-owner')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    const cli = (res.body.connectors as Array<{
      id: string; providerId?: string; name: string; instanceId?: string
    }>).filter((connector) => connector.providerId === 'cli')
    expect(cli).toEqual([
      expect.objectContaining({
        id: 'cli:cli-primary', instanceId: 'cli-primary', name: 'Proton calendar',
      }),
      expect.objectContaining({
        id: 'cli:cli-newer', instanceId: 'cli-newer', name: 'Project calendar',
      }),
    ])
  })

  it('projects every winning-grantor IMAP mailbox as a separately governed top-level connector', async () => {
    queueMembershipAndTeam('owner', 'ws-personal')
    connectorGrantStore.listForTargetSystem.mockResolvedValueOnce([
      {
        grantedByUserId: 'u-owner',
        instance: {
          id: 'imap-newer', provider: 'imap', label: 'Newer label', connectedEmail: 'newer@example.com',
          url: null, custom: false, connected: true, healthStatus: 'ok',
          createdAt: new Date('2026-07-03T00:00:00Z'),
        },
      },
      {
        grantedByUserId: 'u-owner',
        instance: {
          id: 'imap-primary', provider: 'imap', label: 'Primary label', connectedEmail: 'primary@example.com',
          url: null, custom: false, connected: true, healthStatus: 'ok',
          createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      },
      {
        // A later member's same-provider grant stays shadowed, matching the
        // runtime's one-grantor-per-provider precedence.
        grantedByUserId: 'u-teammate',
        instance: {
          id: 'imap-teammate', provider: 'imap', label: 'Teammate', connectedEmail: 'teammate@example.com',
          url: null, custom: false, connected: true, healthStatus: 'ok',
          createdAt: new Date('2026-07-02T00:00:00Z'),
        },
      },
    ])

    const res = await request(makeApp('u-owner')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    const imap = (res.body.connectors as Array<{
      id: string
      providerId?: string
      name: string
      scope: string
      instanceId?: string
    }>).filter((connector) => connector.providerId === 'imap')
    expect(imap).toEqual([
      expect.objectContaining({
        id: 'imap:imap-primary', providerId: 'imap', instanceId: 'imap-primary',
        name: 'primary@example.com', scope: 'team-grant',
      }),
      expect.objectContaining({
        id: 'imap:imap-newer', providerId: 'imap', instanceId: 'imap-newer',
        name: 'newer@example.com', scope: 'team-grant',
      }),
    ])
  })

  it('does not advertise a later grantor when the winning IMAP grantor needs reconnect', async () => {
    queueMembershipAndTeam('owner', 'ws-personal')
    connectorGrantStore.listForTargetSystem.mockResolvedValueOnce([
      {
        grantedByUserId: 'u-owner',
        instance: {
          id: 'imap-dead', provider: 'imap', label: 'owner@example.com',
          url: null, custom: false, connected: true, healthStatus: 'auth_failed',
          createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      },
      {
        grantedByUserId: 'u-teammate',
        instance: {
          id: 'imap-shadowed', provider: 'imap', label: 'teammate@example.com',
          url: null, custom: false, connected: true, healthStatus: 'ok',
          createdAt: new Date('2026-07-02T00:00:00Z'),
        },
      },
    ])

    const res = await request(makeApp('u-owner')).get('/api/assistants/a-1/connectors')

    expect(res.status).toBe(200)
    expect((res.body.connectors as Array<{ providerId?: string }>).some((connector) => connector.providerId === 'imap')).toBe(false)
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

describe('[COMP:routes/assistants-connector-scoping] account-bound IMAP governance routes', () => {
  it('reads and writes L2 policy under the instance id while L1 stays canonical', async () => {
    mockAccess.mockResolvedValue({
      assistant: { id: 'a-1', name: 'A', workspaceId: 'ws-1' },
      role: 'owner',
    } as never)
    mcpSettingsStore.getPolicy.mockImplementation(async (params: {
      assistantId: string; serverName: string; toolName: string
    }) => (
      params.assistantId === 'a-1'
      && params.serverName === 'imap:mailbox-1'
      && params.toolName === 'imapSendMessage'
        ? { policy: 'block' }
        : null
    ))

    const listed = await request(makeApp('u-owner'))
      .get('/api/assistants/a-1/connectors/imap%3Amailbox-1/tools')
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({ serverName: 'imap:mailbox-1', providerId: 'imap' })
    expect(listed.body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'imapSendMessage', assistantPolicy: 'block', effectivePolicy: 'block' }),
    ]))
    expect(mcpSettingsStore.getPolicy).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: '00000000-0000-0000-0000-000000000000',
      serverName: 'imap',
      toolName: 'imapSendMessage',
    }))
    expect(mcpSettingsStore.getPolicy).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: 'a-1', serverName: 'imap:mailbox-1', toolName: 'imapSendMessage',
    }))

    const updated = await request(makeApp('u-owner'))
      .post('/api/assistants/a-1/connectors/imap%3Amailbox-1/tools/policy')
      .send({ serverName: 'imap', toolName: 'imapSendMessage', policy: 'allow' })
    expect(updated.status).toBe(200)
    expect(mcpSettingsStore.setPolicy).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: 'a-1',
      serverName: 'imap:mailbox-1',
      toolName: 'imapSendMessage',
      policy: 'allow',
    }))
  })
})

describe('[COMP:routes/assistants-connector-scoping] CLI instance governance routes', () => {
  it('discovers the selected authorized CLI instance and composes L1/L2 policy', async () => {
    mockAccess.mockResolvedValue({
      assistant: { id: 'a-1', name: 'A', workspaceId: 'ws-1' },
      role: 'owner',
    } as never)
    const instance = {
      id: 'cli-1', scope: 'user', userId: 'u-owner', workspaceId: null,
      provider: 'cli', label: 'Proton calendar', connected: true,
      config: { cwd: '/tmp' },
    }
    connectorGrantStore.listForTargetSystem.mockResolvedValue([{ grantedByUserId: 'u-owner', instance }])
    connectorInstanceStore.getAuthCredentialsSystem.mockResolvedValue({
      type: 'cli', binaryPath: '/usr/bin/node', args: ['/tmp/proton.js'],
    })
    mockDiscoverCli.mockResolvedValue({
      name: 'Proton calendar',
      tools: [{ name: 'listEvents', description: 'Read calendar events' }],
    })
    mcpSettingsStore.getPolicy.mockImplementation(async (params: { assistantId: string }) => (
      params.assistantId === 'a-1' ? { policy: 'block' } : { policy: 'allow' }
    ))

    const res = await request(makeApp('u-owner'))
      .get('/api/assistants/a-1/connectors/cli%3Acli-1/tools')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      serverName: 'Proton calendar', providerId: 'cli', instanceId: 'cli-1',
      tools: [{
        name: 'listEvents', classification: 'read', appPolicy: 'allow',
        assistantPolicy: 'block', effectivePolicy: 'block',
      }],
    })
    expect(mockDiscoverCli).toHaveBeenCalledWith(expect.objectContaining({
      binaryPath: '/usr/bin/node', args: ['/tmp/proton.js'], cwd: '/tmp',
    }), 'Proton calendar')

    const updated = await request(makeApp('u-owner'))
      .post('/api/assistants/a-1/connectors/cli%3Acli-1/tools/policy')
      .send({ serverName: 'Proton calendar', toolName: 'listEvents', policy: 'ask' })
    expect(updated.status).toBe(200)
    expect(mcpSettingsStore.setPolicy).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: 'a-1',
      userId: 'u-owner',
      serverName: 'Proton calendar',
      toolName: 'listEvents',
      policy: 'ask',
    }))
  })
})
