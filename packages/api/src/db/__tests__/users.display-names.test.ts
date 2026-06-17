/**
 * [COMP:api/sessions-route] getUserDisplayNamesByIds — unit tests.
 *
 * Mocks the pg pool so we assert the SQL shape + the name/email fallback
 * without a database. This backs the doc-comments fix where a thread row
 * authored by another workspace member rendered a "?" avatar: the route now
 * batch-resolves sender display names through this helper so the client can
 * attribute the comment instead of falling back to an empty name.
 *
 * See docs/architecture/context-engine/session-messages.md → "Message
 * authorship" and docs/architecture/features/doc-comments.md → "Author
 * identity".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  __esModule: true,
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { query } from '../client.js'
import { getUserDisplayNamesByIds } from '../users.js'

const mockedQuery = vi.mocked(query)

beforeEach(() => {
  mockedQuery.mockReset()
})

describe('[COMP:api/sessions-route] getUserDisplayNamesByIds', () => {
  it('maps each id to its name, falling back to email when name is null', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' },
        { id: 'u2', name: null, email: 'grace@example.com' },
      ],
      rowCount: 2,
    } as never)

    const map = await getUserDisplayNamesByIds(['u1', 'u2'])

    expect(map.get('u1')).toBe('Ada Lovelace')
    expect(map.get('u2')).toBe('grace@example.com') // null name → email fallback
    // Single batched lookup over the de-duplicated id set.
    expect(mockedQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockedQuery.mock.calls[0]
    expect(sql).toMatch(/WHERE id = ANY\(\$1\)/)
    expect(params).toEqual([['u1', 'u2']])
  })

  it('de-duplicates ids and drops falsy entries before querying', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ id: 'u1', name: 'Ada', email: 'ada@example.com' }],
      rowCount: 1,
    } as never)

    await getUserDisplayNamesByIds(['u1', 'u1', '' as string])

    const [, params] = mockedQuery.mock.calls[0]
    expect(params).toEqual([['u1']])
  })

  it('returns an empty map without issuing a query for empty input', async () => {
    const map = await getUserDisplayNamesByIds([])
    expect(map.size).toBe(0)
    expect(mockedQuery).not.toHaveBeenCalled()
  })
})
