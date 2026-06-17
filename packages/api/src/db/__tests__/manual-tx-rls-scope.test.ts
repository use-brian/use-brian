/**
 * Regression test for the manual-transaction RLS scoping in the user-scoped
 * CRM / task / file stores. Component tag: [COMP:api/manual-tx-rls-scope].
 *
 * Two-role model (migration 269): these stores check out a client from the
 * **app pool** (`getAppPool`, the non-owner `app_user` role that is SUBJECT to
 * RLS) and scope it with `SET LOCAL app.current_user_id` after `BEGIN`. There is
 * no `app.system_bypass` GUC anymore — RLS enforcement comes from the role, not
 * a session flag. `SET LOCAL` (not a session-scoped `SET`) keeps `current_user_id`
 * transaction-bound so it reverts to the seeded sentinel at COMMIT/ROLLBACK and
 * never leaks onto the pooled connection.
 *
 * `updateTask` stands in for the whole class (crm.ts ×7, tasks.ts, entities-store,
 * saved-views, doc-entity, workspace-files, compartment-store share the identical
 * head). Even with the poison trigger (an empty userId), it must issue `BEGIN`
 * first, `SET LOCAL app.current_user_id`, and NEVER any `system_bypass`.
 *
 * Spec: packages/api/CLAUDE.md -> "RLS bypass + connection state".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', async () => {
  const actual = await vi.importActual<typeof import('../client.js')>('../client.js')
  return {
    ...actual,
    getAppPool: vi.fn(),
    queryWithRLS: vi.fn(),
    query: vi.fn(),
  }
})

import { updateTask } from '../tasks.js'
import { getAppPool } from '../client.js'

const mockGetAppPool = vi.mocked(getAppPool)

beforeEach(() => {
  mockGetAppPool.mockReset()
})

describe('[COMP:api/manual-tx-rls-scope] updateTask scopes RLS with SET LOCAL after BEGIN (app pool)', () => {
  it('issues BEGIN first, SET LOCAL current_user_id, and never any system_bypass (even with empty userId)', async () => {
    const issued: string[] = []
    const client = {
      query: vi.fn((text: string) => {
        issued.push(text)
        // Empty old-row result → updateTask ROLLBACKs and returns null,
        // which is enough to exercise the BEGIN + SET LOCAL head.
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
      release: vi.fn(),
    }
    mockGetAppPool.mockReturnValue({ connect: () => Promise.resolve(client) } as never)

    // Empty userId is the poison trigger; non-empty `fields` forces the
    // manual-transaction path (empty fields short-circuit via queryWithRLS).
    const result = await updateTask('', 'task-1', { title: 'x' })
    expect(result).toBeNull()

    // BEGIN must come before any GUC scoping, and the scoping is SET LOCAL.
    expect(issued[0]).toBe('BEGIN')
    expect(issued).toContain("SET LOCAL app.current_user_id = ''")

    const beginIdx = issued.indexOf('BEGIN')
    const userIdx = issued.indexOf("SET LOCAL app.current_user_id = ''")
    expect(beginIdx).toBeLessThan(userIdx)

    // No bypass GUC of any kind, and no session-scoped (non-LOCAL) SET of
    // current_user_id (the 2026-06-09 poison shape).
    expect(issued.some((q) => q.includes('system_bypass'))).toBe(false)
    expect(issued.some((q) => /^SET app\.current_user_id =/.test(q))).toBe(false)

    expect(client.release).toHaveBeenCalledTimes(1)
  })
})
