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

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockQuery = vi.mocked(query)

const capabilityStore = {
  listActive: vi.fn(),
  hasActive: vi.fn(),
  listAllActive: vi.fn(),
  listHistoryForAssistant: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}

beforeEach(() => {
  mockQueryWithRLS.mockReset()
  mockQuery.mockReset()
  capabilityStore.hasActive.mockReset()
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

// The row shape the PATCH UPDATE's RETURNING clause produces.
const updatedRow = {
  id: 'a-1',
  name: 'Bot',
  system_prompt: 'New persona',
  slack_model_alias: 'standard',
  telegram_model_alias: 'standard',
  whatsapp_model_alias: 'standard',
  clearance: 'internal',
}

describe('[COMP:routes/assistants-system-prompt-access] PATCH /:assistantId system prompt edit right', () => {
  it('lets a non-owner member edit the system prompt (200, UPDATE issued)', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never) // membership
      .mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as never) // UPDATE

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ systemPrompt: 'New persona' })

    expect(res.status).toBe(200)
    expect(res.body.systemPrompt).toBe('New persona')

    // Exactly two RLS queries: membership check + the UPDATE.
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)
    const updateSql = mockQueryWithRLS.mock.calls[1][1] as string
    const updateValues = mockQueryWithRLS.mock.calls[1][2] as unknown[]
    expect(updateSql).toContain('system_prompt = $')
    expect(updateValues).toContain('New persona')

    // No clearance change → no system-pool denorm writes; no sharing check.
    expect(mockQuery).not.toHaveBeenCalled()
    expect(capabilityStore.hasActive).not.toHaveBeenCalled()
  })

  it('lets a non-owner member clear the system prompt with null', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never) // membership
      .mockResolvedValueOnce({ rows: [{ ...updatedRow, system_prompt: null }], rowCount: 1 } as never) // UPDATE

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ systemPrompt: null })

    expect(res.status).toBe(200)
    const updateValues = mockQueryWithRLS.mock.calls[1][2] as unknown[]
    expect(updateValues).toContain(null)
  })

  it('blocks a plain member from renaming (rename is owner-or-admin, 403, no UPDATE)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never) // membership

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ name: 'Renamed by member' })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only the owner or a workspace admin can rename this assistant')
    // Only the membership check ran — no UPDATE.
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(1)
  })

  it('lets a workspace admin rename the assistant (200, UPDATE issued, no team requery)', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as never) // membership
      .mockResolvedValueOnce({ rows: [{ ...updatedRow, name: 'Renamed by admin' }], rowCount: 1 } as never) // UPDATE

    const res = await request(makeApp({ userId: 'u-admin' }))
      .patch('/api/assistants/a-1')
      .send({ name: 'Renamed by admin' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Renamed by admin')

    // membership check + UPDATE only — rename authorizes off member.role, so no
    // separate team-role requery (unlike clearance).
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)
    const updateSql = mockQueryWithRLS.mock.calls[1][1] as string
    const updateValues = mockQueryWithRLS.mock.calls[1][2] as unknown[]
    expect(updateSql).toContain('name = $')
    expect(updateValues).toContain('Renamed by admin')
  })

  it('still blocks an admin from owner-only fields, even bundled with a rename (bio stays owner-only)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as never) // membership

    const res = await request(makeApp({ userId: 'u-admin' }))
      .patch('/api/assistants/a-1')
      .send({ name: 'New name', bio: 'Admin cannot set this' })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only the owner can update assistant settings')
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(1) // membership only, no UPDATE
  })

  it('rejects a non-owner request that bundles the system prompt with an owner-only field (bio)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never) // membership

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ systemPrompt: 'New persona', bio: 'Sneaky bio' })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only the owner can update assistant settings')
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(1) // membership only, no UPDATE
  })

  it('still gates clearance behind owner / team admin for a plain member', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never) // membership
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // team admin/owner check → not privileged

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ clearance: 'confidential' })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only the assistant owner or a team admin can change clearance')
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(2) // membership + team role, no UPDATE
  })

  it('still lets the owner edit the system prompt (regression)', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 } as never) // membership
      .mockResolvedValueOnce({ rows: [{ ...updatedRow, system_prompt: 'owner-set' }], rowCount: 1 } as never) // UPDATE

    const res = await request(makeApp({ userId: 'u-owner' }))
      .patch('/api/assistants/a-1')
      .send({ systemPrompt: 'owner-set' })

    expect(res.status).toBe(200)
    expect(res.body.systemPrompt).toBe('owner-set')
  })
})
