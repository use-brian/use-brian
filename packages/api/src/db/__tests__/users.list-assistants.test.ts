/**
 * [COMP:api/assistants-list] listAccessibleAssistants — unit tests.
 *
 * Mocks the pg pool so we assert the SQL shape + params without a database.
 * These guard the regression that motivated the function: the query must
 * return ONE row per assistant (no UNION) carrying a single effective role,
 * so a user whose direct (`assistant_members`) and workspace
 * (`workspace_members`) roles disagree never sees a duplicate. The
 * behavioural proof against real Postgres lives in
 * users.list-assistants.integration.test.ts.
 *
 * See docs/architecture/platform/workspaces.md → "Assistant access & the
 * assistant list".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  __esModule: true,
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { query } from '../client.js'
import { listAccessibleAssistants } from '../users.js'

const mockedQuery = vi.mocked(query)

beforeEach(() => {
  mockedQuery.mockReset()
  mockedQuery.mockResolvedValue({ rows: [] } as never)
})

function lastSql(): string {
  const call = mockedQuery.mock.calls.at(-1)
  return (call?.[0] as string) ?? ''
}
function lastParams(): unknown[] {
  const call = mockedQuery.mock.calls.at(-1)
  return (call?.[1] as unknown[]) ?? []
}

describe('[COMP:api/assistants-list] listAccessibleAssistants', () => {
  it('returns one row per assistant — never UNIONs the two access paths', async () => {
    await listAccessibleAssistants('user-1')
    const sql = lastSql()
    // The bug was a UNION whose per-arm `role` column defeated whole-row
    // dedup. The fix must not reintroduce it.
    expect(sql).not.toMatch(/\bUNION\b/i)
    expect(sql).toMatch(/LEFT JOIN assistant_members/i)
    expect(sql).toMatch(/LEFT JOIN workspace_members/i)
  })

  it('collapses both memberships to one effective role, owner > admin > member', async () => {
    await listAccessibleAssistants('user-1')
    const sql = lastSql()
    // owner wins over admin wins over member, regardless of which table each
    // role came from.
    expect(sql).toMatch(/WHEN am\.role = 'owner' OR wm\.role = 'owner' THEN 'owner'/)
    expect(sql).toMatch(/WHEN am\.role = 'admin' OR wm\.role = 'admin' THEN 'admin'/)
    expect(sql).toMatch(/ELSE 'member'/)
  })

  it('gates access by direct OR workspace membership (mirrors getUserAssistant)', async () => {
    await listAccessibleAssistants('user-1')
    const sql = lastSql()
    expect(sql).toMatch(/am\.user_id IS NOT NULL/)
    expect(sql).toMatch(/a\.workspace_id IS NOT NULL AND wm\.user_id IS NOT NULL/)
  })

  it('without a workspaceId, lists across all workspaces with a single param', async () => {
    await listAccessibleAssistants('user-1')
    expect(lastParams()).toEqual(['user-1'])
    expect(lastSql()).not.toMatch(/a\.workspace_id = \$2/)
  })

  it('with a workspaceId, narrows to that workspace via a second param', async () => {
    await listAccessibleAssistants('user-1', 'ws-9')
    expect(lastParams()).toEqual(['user-1', 'ws-9'])
    expect(lastSql()).toMatch(/AND a\.workspace_id = \$2/)
  })

  it('returns the store rows verbatim', async () => {
    const row = {
      id: 'a1',
      name: 'Primary',
      role: 'admin',
      systemPrompt: null,
      memoryCount: 3,
      iconSeed: 7,
      workspaceId: 'ws-9',
      telegramModelAlias: 'standard',
      slackModelAlias: 'standard',
      clearance: 'confidential',
      kind: 'primary',
      appType: null,
    }
    mockedQuery.mockResolvedValueOnce({ rows: [row] } as never)
    const out = await listAccessibleAssistants('user-1', 'ws-9')
    expect(out).toEqual([row])
  })
})
