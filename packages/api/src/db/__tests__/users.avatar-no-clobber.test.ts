/**
 * [COMP:api/account-avatar] No-clobber guard on the provider login paths.
 *
 * A Google (or any provider) sign-in updates `avatar_url` on every login via
 * `findOrCreateUser` / `promoteChannelUser`. Both must guard the write so an
 * uploaded photo (`avatar_source='uploaded'`) survives — the SQL is
 * `avatar_url = CASE WHEN avatar_source = 'uploaded' THEN avatar_url ELSE
 * COALESCE($n, avatar_url) END`, and neither path may touch `avatar_source`.
 *
 * We mock the pg layer and assert the UPDATE SQL carries the CASE guard. This
 * is the unit-level proof that the precedence rule holds without standing up a
 * database (the column-level behavior is exercised by the SQL itself).
 *
 * See docs/architecture/platform/user-profile.md → "Avatar precedence".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  __esModule: true,
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { query } from '../client.js'
import { clearUserAvatar, findOrCreateUser, promoteChannelUser, updateUserAvatar } from '../users.js'

const mockedQuery = vi.mocked(query)

beforeEach(() => {
  mockedQuery.mockReset()
})

const CASE_GUARD = /avatar_url\s*=\s*CASE WHEN avatar_source = 'uploaded' THEN avatar_url ELSE COALESCE\(\$\d, avatar_url\) END/

describe('[COMP:api/account-avatar] Provider login avatar no-clobber', () => {
  it('findOrCreateUser guards avatar_url with the uploaded CASE and never writes avatar_source', async () => {
    // 1st query: SELECT existing user → return a row so we take the UPDATE arm.
    // 2nd query: the UPDATE we want to inspect.
    mockedQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'u_1', timezone: 'UTC' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    await findOrCreateUser({
      authProvider: 'google',
      authProviderId: 'g_1',
      name: 'Ada',
      avatarUrl: 'https://lh3.googleusercontent.com/new.jpg',
    })

    const updateCall = mockedQuery.mock.calls.find((c) => /UPDATE users SET/.test(String(c[0])))
    expect(updateCall).toBeTruthy()
    const sql = String(updateCall![0])
    expect(sql).toMatch(CASE_GUARD)
    // Provider path must never assign avatar_source. Its ONLY mention in the
    // SQL is the read inside the CASE guard (`WHEN avatar_source = 'uploaded'`)
    // — there is no SET-target assignment to it.
    const sourceMentions = sql.match(/avatar_source/g) ?? []
    expect(sourceMentions).toHaveLength(1)
    expect(sql).toMatch(/WHEN avatar_source = 'uploaded'/)
  })

  it('promoteChannelUser guards avatar_url with the uploaded CASE and never writes avatar_source', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    await promoteChannelUser('u_1', {
      authProvider: 'google',
      authProviderId: 'g_1',
      name: 'Ada',
      avatarUrl: 'https://lh3.googleusercontent.com/new.jpg',
    })

    const sql = String(mockedQuery.mock.calls[0][0])
    expect(sql).toMatch(/UPDATE users SET/)
    expect(sql).toMatch(CASE_GUARD)
    // avatar_source's only mention is the CASE read — never a SET assignment.
    const sourceMentions = sql.match(/avatar_source/g) ?? []
    expect(sourceMentions).toHaveLength(1)
    expect(sql).toMatch(/WHEN avatar_source = 'uploaded'/)
  })
})

describe('[COMP:api/account-avatar] Uploaded avatar provenance persistence', () => {
  it('writes the object key, workspace, and immutable storage URI together', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    await updateUserAvatar('u_1', {
      url: 'https://api.example/api/account/avatar/u_1?v=1234',
      storageKey: 'ws_1/avatar_1',
      storageWorkspaceId: 'ws_1',
      storageUri: 's3://bucket/ws_1/avatar_1',
      previousStorageKey: null,
    })

    const [sql, values] = mockedQuery.mock.calls[0]
    expect(String(sql)).toMatch(/avatar_storage_workspace_id = \$3/)
    expect(String(sql)).toMatch(/avatar_storage_uri = \$4/)
    expect(values).toEqual([
      'https://api.example/api/account/avatar/u_1?v=1234',
      'ws_1/avatar_1',
      'ws_1',
      's3://bucket/ws_1/avatar_1',
      'u_1',
      null,
    ])
  })

  it('clears both provenance columns with the uploaded avatar', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    await clearUserAvatar('u_1', 'ws_1/avatar_1')

    const sql = String(mockedQuery.mock.calls[0][0])
    expect(sql).toMatch(/avatar_storage_workspace_id = NULL/)
    expect(sql).toMatch(/avatar_storage_uri = NULL/)
  })
})
