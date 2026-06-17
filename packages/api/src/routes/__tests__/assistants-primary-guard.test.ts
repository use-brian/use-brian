/**
 * Unit tests for the DELETE /:assistantId primary-deletion guard.
 * Component tag: [COMP:api/primary-assistant-guard].
 *
 * Validates that the route refuses to delete a `kind='primary'`
 * assistant with 409 `primary_not_deletable`, and that the guard
 * fires before the member-fan-out check / the delete itself.
 *
 * Spec: docs/architecture/platform/workspaces.md → "Primary assistant".
 */

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

describe("[COMP:api/primary-assistant-guard] DELETE /:assistantId refuses kind='primary'", () => {
  it('returns 409 primary_not_deletable when the assistant is the workspace primary', async () => {
    mockQueryWithRLS
      // 1. verifyMembership: owner
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 } as never)
      // 2. kind lookup → primary
      .mockResolvedValueOnce({ rows: [{ kind: 'primary' }], rowCount: 1 } as never)

    const res = await request(makeApp({ userId: 'u-owner' })).delete('/api/assistants/a-primary')

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('primary_not_deletable')
    // Critically the member-fan-out check + the DELETE must never have run.
    // verifyMembership = 1 call, kind lookup = 1 call → 2 total.
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)
  })

  it("falls through to the regular delete flow when the assistant is kind='standard'", async () => {
    mockQueryWithRLS
      // 1. verifyMembership: owner
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 } as never)
      // 2. kind lookup → standard (not primary)
      .mockResolvedValueOnce({ rows: [{ kind: 'standard' }], rowCount: 1 } as never)
      // 3. assistant_members fan-out: no other owners
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    // The DELETE then opens a pg client; we don't need to assert the
    // delete query itself (`assistants-sharing-lock.test.ts` covers the
    // pg-client path with full mocks). Stubbing getPool to throw lets
    // us assert "the route progressed past the guard" without
    // duplicating that scaffolding.
    const { getPool } = await import('../../db/client.js')
    vi.mocked(getPool).mockReturnValueOnce({
      connect: () => Promise.reject(new Error('pool-not-mocked-on-purpose')),
    } as never)

    const res = await request(makeApp({ userId: 'u-owner' })).delete('/api/assistants/a-std')

    // 500 from the unmocked pool — proves we got past the primary guard
    // AND past the member-fan-out guard (which would have returned 409
    // `transfer_ownership_required` if it fired).
    expect(res.status).toBe(500)
    expect(res.body.error).not.toBe('primary_not_deletable')
    expect(res.body.error).not.toBe('transfer_ownership_required')
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(3)
  })
})
