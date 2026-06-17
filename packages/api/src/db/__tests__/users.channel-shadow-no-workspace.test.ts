/**
 * [COMP:api/channel-shadow-workspace] Channel shadows get NO personal workspace.
 *
 * `findOrCreateUser` provisions a Personal workspace + primary assistant for
 * every new *platform* user (Google/email/dev/web-guest). Channel shadows
 * (`auth_provider='channel'` — public-API `api:<keyId>:<externalUserId>`
 * visitors AND Telegram/Slack DM end-users) must be EXCLUDED: they never log
 * in and their turns run inside the bot/assistant's workspace, so a per-shadow
 * personal workspace is dead weight that pollutes the workspace table (one
 * orphan workspace per external end-user — the cgov regression).
 *
 * We mock the pg layer and assert the workspace-provisioning transaction
 * (`getPool().connect()` → `INSERT INTO workspaces`) runs for a Google signup
 * but is skipped entirely for a channel shadow.
 *
 * See docs/architecture/platform/workspaces.md → "Primary assistant" and
 * docs/architecture/features/public-api.md → "Identity & sessions".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  __esModule: true,
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { query, getPool } from '../client.js'
import { findOrCreateUser } from '../users.js'

const mockedQuery = vi.mocked(query)
const mockedGetPool = vi.mocked(getPool)

// A pooled client that satisfies the §9 provisioning transaction: BEGIN,
// INSERT workspaces RETURNING id, INSERT members, INSERT assistant RETURNING
// id, INSERT capabilities, COMMIT. Returns a fresh id for the RETURNING rows.
function makeMockClient() {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (/INSERT INTO workspaces/.test(sql)) return { rows: [{ id: 'ws_new' }], rowCount: 1 }
      if (/INSERT INTO assistants/.test(sql)) return { rows: [{ id: 'as_new' }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return client
}

// Drive the NEW-user path: SELECT finds nothing → INSERT users returns a row.
function primeNewUser(name: string) {
  mockedQuery.mockReset()
  mockedQuery.mockImplementation(async (sql: unknown) => {
    const s = String(sql)
    if (/SELECT .* FROM users WHERE auth_provider/.test(s)) {
      return { rows: [], rowCount: 0 } as never
    }
    if (/INSERT INTO users/.test(s)) {
      return { rows: [{ id: 'u_new', name, handle: 'shadow-1', timezone: 'UTC' }], rowCount: 1 } as never
    }
    return { rows: [], rowCount: 0 } as never
  })
}

describe('[COMP:api/channel-shadow-workspace] Channel shadows get no personal workspace', () => {
  beforeEach(() => {
    mockedGetPool.mockReset()
  })

  it('does NOT provision a personal workspace for a channel shadow (public-API / TG / Slack)', async () => {
    const connect = vi.fn(async () => makeMockClient())
    mockedGetPool.mockReturnValue({ connect } as never)
    primeNewUser('api:cgov:stake1u8sl62')

    const { user, isNew } = await findOrCreateUser({
      authProvider: 'channel',
      authProviderId: 'api:key-1:cgov:stake1u8sl62',
      name: 'api:cgov:stake1u8sl62',
    })

    expect(isNew).toBe(true)
    expect(user.id).toBe('u_new')
    // The provisioning transaction is never opened — no workspace, no primary.
    expect(connect).not.toHaveBeenCalled()
    const ranWorkspaceInsert = mockedQuery.mock.calls.some((c) => /INSERT INTO workspaces/.test(String(c[0])))
    expect(ranWorkspaceInsert).toBe(false)
  })

  it('DOES provision a personal workspace for a platform (Google) signup', async () => {
    const client = makeMockClient()
    const connect = vi.fn(async () => client)
    mockedGetPool.mockReturnValue({ connect } as never)
    primeNewUser('Ada Lovelace')

    const { isNew } = await findOrCreateUser({
      authProvider: 'google',
      authProviderId: 'g_42',
      name: 'Ada Lovelace',
    })

    expect(isNew).toBe(true)
    // The §9 transaction runs: a workspace + primary assistant are created.
    expect(connect).toHaveBeenCalledTimes(1)
    const insertedWorkspace = client.query.mock.calls.some((c) => /INSERT INTO workspaces/.test(String(c[0])))
    const insertedPrimary = client.query.mock.calls.some(
      (c) => /INSERT INTO assistants/.test(String(c[0])) && /'primary'/.test(String(c[0])),
    )
    expect(insertedWorkspace).toBe(true)
    expect(insertedPrimary).toBe(true)
  })
})
