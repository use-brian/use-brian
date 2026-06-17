/**
 * Regression test for the DELETE /:assistantId connection-scoping path.
 * Component tag: [COMP:api/assistants-delete-rls-scope].
 *
 * The delete transaction must scope the RLS acting user with `SET LOCAL`
 * (after BEGIN) so Postgres reverts it at COMMIT/ROLLBACK. The previous code
 * used a session-scoped `SET app.current_user_id = ...` and, in its finally,
 * `SET app.current_user_id = ''` before releasing the client — poisoning the
 * pooled connection so every later bare `query()` on an RLS-policied table
 * threw `invalid input syntax for type uuid: ""` (the prod incident).
 *
 * Spec: packages/api/CLAUDE.md -> "Bypass restore + pool contamination";
 * docs/architecture/platform/database-schema.md -> "RLS bypass + connection
 * state".
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
import { queryWithRLS, getPool } from '../../db/client.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockGetPool = vi.mocked(getPool)

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
  mockGetPool.mockReset()
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

describe('[COMP:api/assistants-delete-rls-scope] DELETE /:assistantId scopes RLS with SET LOCAL', () => {
  it('uses SET LOCAL after BEGIN and never leaves the connection at current_user_id = ""', async () => {
    // Pre-delete guards (all queryWithRLS): role=owner, kind=standard, no other members.
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ kind: 'standard' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    const issued: string[] = []
    const client = {
      query: vi.fn((text: string) => {
        issued.push(text)
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
      release: vi.fn(),
    }
    mockGetPool.mockReturnValue({ connect: () => Promise.resolve(client) } as never)

    const res = await request(makeApp({ userId: 'u-owner' })).delete('/api/assistants/a-std')

    expect(res.status).toBe(204)

    // BEGIN comes first, and the user scope is SET LOCAL (transaction-bound).
    expect(issued[0]).toBe('BEGIN')
    expect(issued).toContain("SET LOCAL app.current_user_id = 'u-owner'")

    // The poison must never be issued, and no bare (non-LOCAL) session SET.
    expect(issued).not.toContain("SET app.current_user_id = ''")
    expect(
      issued.some((q) => /^SET app\.current_user_id =/.test(q)),
    ).toBe(false)

    // SET LOCAL must run inside the transaction (after BEGIN, before COMMIT).
    const beginIdx = issued.indexOf('BEGIN')
    const setIdx = issued.indexOf("SET LOCAL app.current_user_id = 'u-owner'")
    const commitIdx = issued.indexOf('COMMIT')
    expect(beginIdx).toBeLessThan(setIdx)
    expect(setIdx).toBeLessThan(commitIdx)

    expect(client.release).toHaveBeenCalledTimes(1)
  })
})
