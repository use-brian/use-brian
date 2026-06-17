import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { assistantRoutes } from '../assistants.js'
import { query, queryWithRLS } from '../../db/client.js'
import { DuplicateGrantError } from '@sidanclaw/core'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)

const capabilityStore = {
  listActive: vi.fn<(id: string) => Promise<string[]>>(),
  hasActive: vi.fn(),
  listAllActive: vi.fn(),
  listHistoryForAssistant: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}

beforeEach(() => {
  mockQuery.mockReset()
  mockQueryWithRLS.mockReset()
  for (const fn of Object.values(capabilityStore)) (fn as { mockReset?: () => void }).mockReset?.()
})

function makeApp(opts: { userId: string }) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { userId: string }).userId = opts.userId
    next()
  })
  app.use('/api/assistants', assistantRoutes({ capabilityStore: capabilityStore as never }))
  return app
}

// §17 — Tasks/CRM toggles. Workspace-member auth, idempotent grant/revoke.
describe('[COMP:routes/assistants-primitive-grants] GET /:assistantId/primitive-grants', () => {
  it('returns enabled=true for capabilities the assistant carries', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)
    capabilityStore.listActive.mockResolvedValueOnce(['tasks', 'crm', 'bug_triage'])

    const res = await request(makeApp({ userId: 'u-1' }))
      .get('/api/assistants/a-1/primitive-grants')

    expect(res.status).toBe(200)
    expect(res.body.grants).toEqual([
      { capability: 'tasks', enabled: true },
      { capability: 'crm', enabled: true },
      { capability: 'configure', enabled: false },
    ])
  })

  it('returns enabled=false for missing capabilities (default-off kind=app)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)
    capabilityStore.listActive.mockResolvedValueOnce([])

    const res = await request(makeApp({ userId: 'u-1' }))
      .get('/api/assistants/a-1/primitive-grants')

    expect(res.status).toBe(200)
    expect(res.body.grants).toEqual([
      { capability: 'tasks', enabled: false },
      { capability: 'crm', enabled: false },
      { capability: 'configure', enabled: false },
    ])
  })

  it('403 when the user is not a member of the assistant', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    const res = await request(makeApp({ userId: 'u-stranger' }))
      .get('/api/assistants/a-1/primitive-grants')

    expect(res.status).toBe(403)
    expect(capabilityStore.listActive).not.toHaveBeenCalled()
  })
})

describe('[COMP:routes/assistants-primitive-grants] PATCH /:assistantId/primitive-grants/:capability', () => {
  it('grants when enabled=true and no active grant exists', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)
    capabilityStore.grant.mockResolvedValueOnce({ id: 'g-1' } as never)
    capabilityStore.listActive.mockResolvedValueOnce(['tasks'])

    const res = await request(makeApp({ userId: 'u-1' }))
      .patch('/api/assistants/a-1/primitive-grants/tasks')
      .send({ enabled: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ capability: 'tasks', enabled: true })
    expect(capabilityStore.grant).toHaveBeenCalledWith({
      assistantId: 'a-1',
      capability: 'tasks',
      grantedByUserId: 'u-1',
      reason: '§17 toggled on by workspace member',
    })
  })

  it('treats DuplicateGrantError as a no-op (idempotent on)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)
    capabilityStore.grant.mockRejectedValueOnce(new DuplicateGrantError('a-1', 'tasks'))
    capabilityStore.listActive.mockResolvedValueOnce(['tasks'])

    const res = await request(makeApp({ userId: 'u-1' }))
      .patch('/api/assistants/a-1/primitive-grants/tasks')
      .send({ enabled: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ capability: 'tasks', enabled: true })
  })

  it('revokes the active grant when enabled=false', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'g-existing' }], rowCount: 1 } as never)
    capabilityStore.revoke.mockResolvedValueOnce({ id: 'g-existing' } as never)
    capabilityStore.listActive.mockResolvedValueOnce([])

    const res = await request(makeApp({ userId: 'u-1' }))
      .patch('/api/assistants/a-1/primitive-grants/crm')
      .send({ enabled: false })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ capability: 'crm', enabled: false })
    expect(capabilityStore.revoke).toHaveBeenCalledWith({
      grantId: 'g-existing',
      revokedByUserId: 'u-1',
      reason: '§17 toggled off by workspace member',
    })
  })

  it('enabled=false is a no-op when no active grant exists', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    capabilityStore.listActive.mockResolvedValueOnce([])

    const res = await request(makeApp({ userId: 'u-1' }))
      .patch('/api/assistants/a-1/primitive-grants/tasks')
      .send({ enabled: false })

    expect(res.status).toBe(200)
    expect(capabilityStore.revoke).not.toHaveBeenCalled()
  })

  it('400 for an unknown capability name', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)

    const res = await request(makeApp({ userId: 'u-1' }))
      .patch('/api/assistants/a-1/primitive-grants/bug_triage')
      .send({ enabled: true })

    expect(res.status).toBe(400)
    expect(capabilityStore.grant).not.toHaveBeenCalled()
  })

  it('400 when enabled is not a boolean', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)

    const res = await request(makeApp({ userId: 'u-1' }))
      .patch('/api/assistants/a-1/primitive-grants/tasks')
      .send({ enabled: 'yes' })

    expect(res.status).toBe(400)
  })
})

// Agent-facing capability surface §5 — the `configure` named capability arms
// control-plane writes on the agent surfaces (brain MCP / assistant MCP).
// Off by default, owner/admin-gated, never self-grantable.
describe('[COMP:routes/assistants-primitive-grants] configure capability (admin-gated)', () => {
  it('403 when a plain member toggles configure on', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1/primitive-grants/configure')
      .send({ enabled: true })

    expect(res.status).toBe(403)
    expect(capabilityStore.grant).not.toHaveBeenCalled()
  })

  it('403 when a plain member toggles configure off', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1/primitive-grants/configure')
      .send({ enabled: false })

    expect(res.status).toBe(403)
    expect(capabilityStore.revoke).not.toHaveBeenCalled()
  })

  it('a workspace admin can grant configure (provenance-stamped reason)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as never)
    capabilityStore.grant.mockResolvedValueOnce({ id: 'g-conf' } as never)
    capabilityStore.listActive.mockResolvedValueOnce(['configure'])

    const res = await request(makeApp({ userId: 'u-admin' }))
      .patch('/api/assistants/a-1/primitive-grants/configure')
      .send({ enabled: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ capability: 'configure', enabled: true })
    expect(capabilityStore.grant).toHaveBeenCalledWith({
      assistantId: 'a-1',
      capability: 'configure',
      grantedByUserId: 'u-admin',
      reason: 'agent-surface configure capability toggled on by workspace admin',
    })
  })

  it('an owner can revoke configure', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 } as never)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'g-conf' }], rowCount: 1 } as never)
    capabilityStore.revoke.mockResolvedValueOnce({ id: 'g-conf' } as never)
    capabilityStore.listActive.mockResolvedValueOnce([])

    const res = await request(makeApp({ userId: 'u-owner' }))
      .patch('/api/assistants/a-1/primitive-grants/configure')
      .send({ enabled: false })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ capability: 'configure', enabled: false })
    expect(capabilityStore.revoke).toHaveBeenCalledWith({
      grantId: 'g-conf',
      revokedByUserId: 'u-owner',
      reason: 'agent-surface configure capability toggled off by workspace admin',
    })
  })

  it('configure appears in the GET listing for any member (visible, not toggleable)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)
    capabilityStore.listActive.mockResolvedValueOnce(['configure'])

    const res = await request(makeApp({ userId: 'u-member' }))
      .get('/api/assistants/a-1/primitive-grants')

    expect(res.status).toBe(200)
    expect(res.body.grants).toContainEqual({ capability: 'configure', enabled: true })
  })
})
