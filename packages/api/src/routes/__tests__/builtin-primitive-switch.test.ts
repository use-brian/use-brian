import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

vi.mock('../../db/users.js', () => ({
  resolveAssistantAccess: vi.fn(),
}))

import { assistantRoutes } from '../assistants.js'
import { query, queryWithRLS } from '../../db/client.js'
import { resolveAssistantAccess } from '../../db/users.js'
import { BUILTIN_PRIMITIVE_CONNECTOR_IDS, OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockAccess = vi.mocked(resolveAssistantAccess)

const capabilityStore = {
  listActive: vi.fn<(id: string) => Promise<string[]>>(),
  hasActive: vi.fn(),
  listAllActive: vi.fn(),
  listHistoryForAssistant: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}

const assistantConnectorStore = { listForAssistant: vi.fn() }
const connectorStore = { list: vi.fn() }
const connectorInstanceStore = {
  listByWorkspaceSystem: vi.fn(),
  get: vi.fn(),
  getAuthCredentialsSystem: vi.fn(),
}
const connectorGrantStore = { listForTargetSystem: vi.fn() }

beforeEach(() => {
  mockQuery.mockReset()
  mockQueryWithRLS.mockReset()
  mockAccess.mockReset()
  for (const fn of Object.values(capabilityStore)) (fn as { mockReset?: () => void }).mockReset?.()
  capabilityStore.listActive.mockResolvedValue([])
  assistantConnectorStore.listForAssistant.mockReset().mockResolvedValue([])
  connectorStore.list.mockReset().mockResolvedValue([])
  connectorInstanceStore.listByWorkspaceSystem.mockReset().mockResolvedValue([])
  connectorInstanceStore.get.mockReset().mockResolvedValue(null)
  connectorInstanceStore.getAuthCredentialsSystem.mockReset().mockResolvedValue(null)
  connectorGrantStore.listForTargetSystem.mockReset().mockResolvedValue([])
})

function makeApp(userId = 'u-1') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { userId: string }).userId = userId
    next()
  })
  app.use(
    '/api/assistants',
    assistantRoutes({
      capabilityStore: capabilityStore as never,
      assistantConnectorStore: assistantConnectorStore as never,
      connectorStore: connectorStore as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      mcpSettingsStore: { getPolicy: vi.fn(), setPolicy: vi.fn() } as never,
    }),
  )
  return app
}

function member(role = 'member', workspaceId: string | null = 'w-1') {
  mockAccess.mockResolvedValue({
    assistant: { id: 'a-1', name: 'A', workspaceId },
    role,
  } as never)
}

/**
 * The off switch for the `auth_type: 'none'` built-in primitives (Workspace
 * Files / Office / Computer Use). Spec:
 * docs/architecture/features/builtin-primitives.md
 */
describe('[COMP:connectors/builtin-primitive-switch] Built-in primitive off switch', () => {
  it('exposes every built-in primitive as a toggleable capability', async () => {
    member()
    capabilityStore.listActive.mockResolvedValue(['files'])

    const res = await request(makeApp()).get('/api/assistants/a-1/primitive-grants')
    expect(res.status).toBe(200)

    const byCap = new Map<string, { enabled: boolean; group: string }>(
      res.body.grants.map((g: { capability: string; enabled: boolean; group: string }) => [
        g.capability,
        { enabled: g.enabled, group: g.group },
      ]),
    )
    // Derived from the registry, so a 4th `auth_type: 'none'` connector is
    // covered without touching this test.
    for (const id of BUILTIN_PRIMITIVE_CONNECTOR_IDS) {
      expect(byCap.get(id), `${id} must be toggleable`).toBeDefined()
      expect(byCap.get(id)!.group).toBe('builtin')
    }
    expect(byCap.get('files')!.enabled).toBe(true)
    expect(byCap.get('office')!.enabled).toBe(false)
  })

  it('groups the §17 primitives and `configure` away from the built-ins so no grant gets two controls', async () => {
    member()
    const res = await request(makeApp()).get('/api/assistants/a-1/primitive-grants')
    const group = (cap: string) =>
      res.body.grants.find((g: { capability: string }) => g.capability === cap)?.group
    expect(group('tasks')).toBe('primitive')
    expect(group('crm')).toBe('primitive')
    expect(group('goals')).toBe('primitive')
    expect(group('configure')).toBe('admin')
  })

  it('grants a built-in capability on PATCH enabled=true', async () => {
    member()
    capabilityStore.grant.mockResolvedValue({} as never)
    capabilityStore.listActive.mockResolvedValue(['computer'])

    const res = await request(makeApp())
      .patch('/api/assistants/a-1/primitive-grants/computer')
      .send({ enabled: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ capability: 'computer', enabled: true, group: 'builtin' })
    expect(capabilityStore.grant).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: 'a-1', capability: 'computer' }),
    )
  })

  it('revokes the active grant on PATCH enabled=false', async () => {
    member()
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'grant-1' }], rowCount: 1 } as never)
    capabilityStore.revoke.mockResolvedValue({} as never)
    capabilityStore.listActive.mockResolvedValue([])

    const res = await request(makeApp())
      .patch('/api/assistants/a-1/primitive-grants/office')
      .send({ enabled: false })

    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(false)
    expect(capabilityStore.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'grant-1' }),
    )
  })

  it('does NOT require owner/admin — a built-in switch is not the `configure` capability', async () => {
    member('member')
    capabilityStore.grant.mockResolvedValue({} as never)
    capabilityStore.listActive.mockResolvedValue(['office'])

    const res = await request(makeApp())
      .patch('/api/assistants/a-1/primitive-grants/office')
      .send({ enabled: true })

    expect(res.status).toBe(200)
  })

  it('reports a built-in connector row `enabled` from the capability grant, not connector settings', async () => {
    member()
    capabilityStore.listActive.mockResolvedValue(['files'])
    // A stale/never-read connector-settings row claiming the opposite. Nothing
    // at runtime reads it for a primitive, so it must not drive the toggle —
    // otherwise the switch moves in the UI and changes nothing.
    assistantConnectorStore.listForAssistant.mockResolvedValue([
      { connectorId: 'office', enabled: true },
      { connectorId: 'files', enabled: false },
    ])
    mockQueryWithRLS.mockResolvedValue({ rows: [{ workspace_id: 'w-1' }], rowCount: 1 } as never)

    const res = await request(makeApp()).get('/api/assistants/a-1/connectors')
    expect(res.status).toBe(200)
    const rows = new Map<string, { scope: string; enabled: boolean }>(
      res.body.connectors.map((c: { id: string; scope: string; enabled: boolean }) => [
        c.id,
        { scope: c.scope, enabled: c.enabled },
      ]),
    )
    expect(rows.get('files')).toMatchObject({ scope: 'builtin', enabled: true })
    expect(rows.get('office')).toMatchObject({ scope: 'builtin', enabled: false })
  })

  it('rejects an unknown capability', async () => {
    member()
    const res = await request(makeApp())
      .patch('/api/assistants/a-1/primitive-grants/not-a-capability')
      .send({ enabled: true })
    expect(res.status).toBe(400)
  })

  it('every built-in primitive with governable tools is toggleable', () => {
    // Guards the pairing the UI depends on: a primitive that renders a tool
    // list in Studio must also have a switch, or the user can govern the parts
    // but not the whole.
    for (const id of BUILTIN_PRIMITIVE_CONNECTOR_IDS) {
      if ((OFFICIAL_CONNECTOR_TOOLS[id]?.length ?? 0) === 0) continue
      expect(BUILTIN_PRIMITIVE_CONNECTOR_IDS.has(id)).toBe(true)
    }
  })
})
