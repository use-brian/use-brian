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

import { assistantRoutes } from '../assistants.js'
import { query, queryWithRLS } from '../../db/client.js'
import { resolveAssistantAccess } from '../../db/users.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockAccess = vi.mocked(resolveAssistantAccess)
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

// The row a charter-touching PATCH first reads to merge onto (charter is
// authoritative-if-present; legacy columns are the NULL-charter fallback).
const currentRow = {
  charter: { mission: 'Own support', instructions: 'Old persona' },
  system_prompt: 'stale legacy',
  bio: 'stale legacy bio',
}

// The row shape the PATCH UPDATE's RETURNING clause produces.
const updatedRow = {
  id: 'a-1',
  name: 'Bot',
  system_prompt: 'stale legacy',
  bio: 'stale legacy bio',
  charter: { mission: 'Own support', instructions: 'New persona' },
  default_model_alias: 'standard',
  api_model_alias: 'standard',
  clearance: 'internal',
}

describe('[COMP:routes/assistants-system-prompt-access] PATCH /:assistantId charter edit rights', () => {
  it('lets a non-owner member edit the instructions (200; merge SELECT + UPDATE write charter, not system_prompt)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'member' } as never)
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [currentRow], rowCount: 1 } as never) // merge SELECT
      .mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as never) // UPDATE

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ charter: { instructions: 'New persona' } })

    expect(res.status).toBe(200)
    // Response mirrors the charter into the legacy key for old clients.
    expect(res.body.systemPrompt).toBe('New persona')
    expect(res.body.charter).toEqual({ mission: 'Own support', instructions: 'New persona' })

    // Two RLS queries: the merge SELECT, then the UPDATE. The membership
    // check resolves through the access predicate and spends no queryWithRLS.
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)
    const updateSql = mockQueryWithRLS.mock.calls[1][1] as string
    const updateValues = mockQueryWithRLS.mock.calls[1][2] as unknown[]
    expect(updateSql).toContain('charter = $')
    expect(updateSql).not.toContain('system_prompt = $')
    // The merged charter keeps the untouched mission and swaps instructions.
    expect(updateValues[0]).toBe(JSON.stringify({ mission: 'Own support', instructions: 'New persona' }))

    // No clearance change → no system-pool denorm writes; no sharing check.
    expect(mockQuery).not.toHaveBeenCalled()
    expect(capabilityStore.hasActive).not.toHaveBeenCalled()
  })

  it('folds a legacy systemPrompt key onto charter.instructions (pre-418 client)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'member' } as never)
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [currentRow], rowCount: 1 } as never) // merge SELECT
      .mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as never) // UPDATE

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ systemPrompt: 'New persona' })

    expect(res.status).toBe(200)
    const updateSql = mockQueryWithRLS.mock.calls[1][1] as string
    const updateValues = mockQueryWithRLS.mock.calls[1][2] as unknown[]
    expect(updateSql).toContain('charter = $')
    expect(updateValues[0]).toBe(JSON.stringify({ mission: 'Own support', instructions: 'New persona' }))
  })

  it('lets a non-owner member clear the instructions with null (field dropped from the merged charter)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'member' } as never)
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [currentRow], rowCount: 1 } as never) // merge SELECT
      .mockResolvedValueOnce({
        rows: [{ ...updatedRow, charter: { mission: 'Own support' } }],
        rowCount: 1,
      } as never) // UPDATE

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ charter: { instructions: null } })

    expect(res.status).toBe(200)
    expect(res.body.systemPrompt).toBeNull()
    const updateValues = mockQueryWithRLS.mock.calls[1][2] as unknown[]
    expect(updateValues[0]).toBe(JSON.stringify({ mission: 'Own support' }))
  })

  it('blocks a non-owner member from the identity fields (mission is owner-only, 403, no queries)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'member' } as never)

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ charter: { mission: 'Sneaky new mission' } })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only the owner can update assistant settings')
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(0)
  })

  it('rejects a non-owner request that bundles instructions with an identity field (strictest field governs)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'member' } as never)

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ charter: { instructions: 'New persona', audience: 'Sneaky audience' } })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only the owner can update assistant settings')
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(0)
  })

  it('folds a legacy bio key onto charter.mission and keeps it owner-only', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'admin' } as never)

    const res = await request(makeApp({ userId: 'u-admin' }))
      .patch('/api/assistants/a-1')
      .send({ name: 'New name', bio: 'Admin cannot set this' })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only the owner can update assistant settings')
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(0) // no UPDATE (gate spends no RLS query)
  })

  it('blocks a plain member from renaming (rename is owner-or-admin, 403, no UPDATE)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'member' } as never)

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ name: 'Renamed by member' })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only the owner or a workspace admin can rename this assistant')
    // Only the membership check ran — no UPDATE.
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(0)
  })

  it('lets a workspace admin rename the assistant (200, UPDATE issued, no team requery, no merge SELECT)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'admin' } as never)
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [{ ...updatedRow, name: 'Renamed by admin' }], rowCount: 1 } as never) // UPDATE

    const res = await request(makeApp({ userId: 'u-admin' }))
      .patch('/api/assistants/a-1')
      .send({ name: 'Renamed by admin' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Renamed by admin')

    // membership check + UPDATE only — rename authorizes off member.role, so no
    // separate team-role requery (unlike clearance), and no charter field means
    // no merge SELECT.
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(1)
    const updateSql = mockQueryWithRLS.mock.calls[0][1] as string
    const updateValues = mockQueryWithRLS.mock.calls[0][2] as unknown[]
    expect(updateSql).toContain('name = $')
    expect(updateValues).toContain('Renamed by admin')
  })

  it('still gates clearance behind owner / team admin for a plain member', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'member' } as never)
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // team admin/owner check → not privileged

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ clearance: 'confidential' })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Only the assistant owner or a team admin can change clearance')
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(1) // team role only, no UPDATE
  })

  it('lets the owner edit the full charter, including identity fields', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'owner' } as never)
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [currentRow], rowCount: 1 } as never) // merge SELECT
      .mockResolvedValueOnce({
        rows: [{
          ...updatedRow,
          charter: {
            mission: 'New mission',
            audience: 'The founder',
            success: 'Numbers first',
            instructions: 'owner-set',
          },
        }],
        rowCount: 1,
      } as never) // UPDATE

    const res = await request(makeApp({ userId: 'u-owner' }))
      .patch('/api/assistants/a-1')
      .send({
        charter: {
          mission: 'New mission',
          audience: 'The founder',
          success: 'Numbers first',
          instructions: 'owner-set',
        },
      })

    expect(res.status).toBe(200)
    expect(res.body.systemPrompt).toBe('owner-set')
    expect(res.body.bio).toBe('New mission')
    expect(res.body.charter.audience).toBe('The founder')
  })

  it('rejects a charter field over its cap (mission > 300 chars, 400)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'owner' } as never)

    const res = await request(makeApp({ userId: 'u-owner' }))
      .patch('/api/assistants/a-1')
      .send({ charter: { mission: 'x'.repeat(301) } })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('charter.mission')
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(0)
  })
})
