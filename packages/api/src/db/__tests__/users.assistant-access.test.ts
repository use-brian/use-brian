/**
 * [COMP:api/assistant-access] resolveAssistantAccess — unit tests.
 *
 * Mocks the pg pool so we assert the SQL shape + params without a database.
 * This is THE assistant access predicate; every "can this user use / see /
 * edit this assistant" decision resolves through it, so these guard the two
 * defects that motivated collapsing seven per-route spellings into one:
 *
 *   1. Gating on `assistants.owner_user_id`, which is NULL for every
 *      workspace-owned assistant post-089 — unsatisfiable by any human for
 *      exactly the team assistants that matter most.
 *   2. Nondeterministic role resolution from `UNION … LIMIT 1` with no
 *      `ORDER BY`, on the path that gates every assistant write.
 *
 * See docs/architecture/platform/workspaces.md → "The access predicate".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  __esModule: true,
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { query } from '../client.js'
import { resolveAssistantAccess, getUserAssistant } from '../users.js'

const mockQuery = vi.mocked(query)

const USER = 'u-1'
const ASSISTANT = 'a-1'

function row(over: Record<string, unknown> = {}) {
  return {
    id: ASSISTANT,
    name: 'DD',
    telegramModelAlias: 'pro',
    workspaceId: 'w-1',
    systemPrompt: null,
    kind: 'primary',
    appType: null,
    blockedUserIds: [],
    clearance: 'confidential',
    compartments: null,
    defaultCompartments: [],
    role: 'owner',
    ...over,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/assistant-access] resolveAssistantAccess', () => {
  it('never gates on owner_user_id', async () => {
    // The regression that shipped: workspace-owned assistants carry
    // owner_user_id NULL, so this predicate must not reference the column.
    mockQuery.mockResolvedValueOnce({ rows: [row()], rowCount: 1 } as never)
    await resolveAssistantAccess(USER, ASSISTANT)

    const sql = String(mockQuery.mock.calls[0][0])
    expect(sql).not.toMatch(/owner_user_id/)
  })

  it('gates on direct OR workspace membership', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()], rowCount: 1 } as never)
    await resolveAssistantAccess(USER, ASSISTANT)

    const sql = String(mockQuery.mock.calls[0][0])
    expect(sql).toMatch(/LEFT JOIN assistant_members/)
    expect(sql).toMatch(/LEFT JOIN workspace_members/)
    expect(sql).toMatch(/am\.user_id IS NOT NULL/)
    expect(sql).toMatch(/wm\.user_id IS NOT NULL/)
    expect(mockQuery.mock.calls[0][1]).toEqual([USER, ASSISTANT])
  })

  it('resolves the role deterministically, not via UNION', async () => {
    // The old spelling was `UNION … LIMIT 1` with no ORDER BY, so a caller
    // whose two membership rows disagreed got whichever role the planner
    // emitted first. A single CASE cannot be ambiguous.
    mockQuery.mockResolvedValueOnce({ rows: [row()], rowCount: 1 } as never)
    await resolveAssistantAccess(USER, ASSISTANT)

    const sql = String(mockQuery.mock.calls[0][0])
    expect(sql).not.toMatch(/UNION/i)
    expect(sql).toMatch(/CASE/)
    // owner wins over admin, admin over member — the precedence is in the SQL.
    expect(sql.indexOf("THEN 'owner'")).toBeLessThan(sql.indexOf("THEN 'admin'"))
  })

  it('issues exactly one query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()], rowCount: 1 } as never)
    await resolveAssistantAccess(USER, ASSISTANT)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('splits the row into assistant + role', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ role: 'admin' })], rowCount: 1 } as never)
    const access = await resolveAssistantAccess(USER, ASSISTANT)

    expect(access?.role).toBe('admin')
    expect(access?.assistant.id).toBe(ASSISTANT)
    expect(access?.assistant.workspaceId).toBe('w-1')
    // `role` is lifted out of the assistant view, not left on it.
    expect(access?.assistant).not.toHaveProperty('role')
  })

  it('returns null when the caller has no access', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await resolveAssistantAccess(USER, ASSISTANT)).toBeNull()
  })

  it('returns null for a nonexistent assistant — indistinguishable from no access', async () => {
    // Callers must answer 403 for both; a 404 on "exists but no access" would
    // disclose assistant existence across workspace boundaries.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await resolveAssistantAccess(USER, 'ghost')).toBeNull()
  })

  it('binds a workspace-owned assistant whose owner_user_id is NULL', async () => {
    // The user's real case: assistant "DD" in a team workspace, reached via
    // workspace_members with owner_user_id NULL on the row.
    mockQuery.mockResolvedValueOnce({ rows: [row({ role: 'owner' })], rowCount: 1 } as never)
    const access = await resolveAssistantAccess(USER, ASSISTANT)
    expect(access).not.toBeNull()
    expect(access?.assistant.name).toBe('DD')
  })
})

describe('[COMP:api/assistant-access] getUserAssistant', () => {
  it('delegates to the predicate and drops the role', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ role: 'member' })], rowCount: 1 } as never)
    const assistant = await getUserAssistant(USER, ASSISTANT)

    expect(assistant?.id).toBe(ASSISTANT)
    expect(assistant).not.toHaveProperty('role')
    // One query — it is a wrapper, not a second lookup.
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('returns null when the predicate denies', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await getUserAssistant(USER, ASSISTANT)).toBeNull()
  })
})
