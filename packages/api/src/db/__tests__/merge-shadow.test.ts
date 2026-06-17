import { describe, it, expect, vi, beforeEach } from 'vitest'

const txnQuery = vi.fn()
const txnRelease = vi.fn()

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(() => ({
    connect: vi.fn(async () => ({
      query: txnQuery,
      release: txnRelease,
    })),
  })),
}))

import { mergeShadowUser } from '../linked-accounts.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
  txnQuery.mockReset()
  txnRelease.mockReset()
})

/**
 * [COMP:api/merge-shadow] mergeShadowUser is the single primitive that
 * folds an orphan shadow user into a real user. After this PR it accepts
 * arbitrary provider strings (slack, etc.), writes a user_merges audit
 * row, and upserts a linked_identities row so the channel identity
 * survives the shadow's deletion.
 *
 * The tests below mock the pg layer and assert the SQL shape — the
 * actual DML behavior is covered by an integration test (when added).
 *
 * See docs/architecture/platform/identity-healing.md.
 */

describe('[COMP:api/merge-shadow] mergeShadowUser', () => {
  it('returns {merged:false} when no shadow exists for the provider id (idempotent no-op)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const result = await mergeShadowUser('real-user-id', 'U12345', 'slack')
    expect(result.merged).toBe(false)
    expect(txnQuery).not.toHaveBeenCalled()
  })

  it("accepts 'slack' as a provider (previously only telegram/whatsapp/api were allowed)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await mergeShadowUser('real-user-id', 'U12345', 'slack')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain("auth_provider_id = $3 || ':' || $2")
    expect(params).toEqual(['real-user-id', 'U12345', 'slack'])
  })

  it("throws when provider='api' is used without partnerKeyId", async () => {
    await expect(
      mergeShadowUser('real-user-id', 'ext-user-id', 'api'),
    ).rejects.toThrow(/requires partnerKeyId/)
  })

  it("uses the api-namespaced auth_provider_id when partnerKeyId is supplied", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await mergeShadowUser('real-user-id', 'ext-user-id', 'api', {
      partnerKeyId: 'key-uuid',
    })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain(`'api:' || $3 || ':' || $2`)
    expect(params).toEqual(['real-user-id', 'ext-user-id', 'key-uuid'])
  })

  it('on merge: reassigns sessions/memories/souls, writes user_merges + linked_identities, deletes the shadow', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'shadow-id',
          email: null,
          name: 'Test Shadow',
          authProvider: 'channel',
          authProviderId: 'slack:U12345',
          createdAt: new Date('2025-01-01'),
        },
      ],
      rowCount: 1,
    } as never)
    txnQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const result = await mergeShadowUser('real-user-id', 'U12345', 'slack', {
      reason: 'email-discovery',
      evidence: { email: 'me@x.com' },
    })

    expect(result.merged).toBe(true)
    expect(result.shadowUserId).toBe('shadow-id')

    const sqls = txnQuery.mock.calls.map((c) => c[0] as string)
    expect(sqls.some((s) => s === 'BEGIN')).toBe(true)
    expect(sqls.some((s) => s.includes('UPDATE sessions SET user_id'))).toBe(true)
    expect(sqls.some((s) => s.includes('UPDATE memories SET user_id'))).toBe(true)
    expect(sqls.some((s) => s.includes('UPDATE user_souls SET user_id'))).toBe(true)
    expect(sqls.some((s) => s.includes('INSERT INTO user_merges'))).toBe(true)
    expect(sqls.some((s) => s.includes('INSERT INTO linked_identities'))).toBe(true)
    expect(sqls.some((s) => s.includes('DELETE FROM users WHERE id'))).toBe(true)
    expect(sqls.some((s) => s === 'COMMIT')).toBe(true)
    expect(txnRelease).toHaveBeenCalled()
  })

  it('rolls back and releases on failure', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'shadow-id',
          email: null,
          name: null,
          authProvider: 'channel',
          authProviderId: 'slack:U12345',
          createdAt: new Date(),
        },
      ],
      rowCount: 1,
    } as never)
    txnQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE sessions')) {
        throw new Error('boom')
      }
      return { rows: [], rowCount: 0 }
    })

    await expect(
      mergeShadowUser('real-user-id', 'U12345', 'slack'),
    ).rejects.toThrow('boom')
    const sqls = txnQuery.mock.calls.map((c) => c[0] as string)
    expect(sqls.some((s) => s === 'ROLLBACK')).toBe(true)
    expect(txnRelease).toHaveBeenCalled()
  })
})
