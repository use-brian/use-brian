import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { createDbDesktopAuthStore } from '../desktop-auth-store.js'
import { query } from '../client.js'
import { createHash } from 'node:crypto'

const mockQuery = vi.mocked(query)
const store = createDbDesktopAuthStore()

function hash(code: string) {
  return createHash('sha256').update(code).digest('hex')
}

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/desktop-auth-store] create', () => {
  it('inserts only the hash, never the raw code, and binds the challenge', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const { code } = await store.create({ userId: 'u1', challenge: 'chal-abc-1234567890' })

    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[0]).toBe(hash(code))
    expect(params).not.toContain(code) // raw code never sent to the DB
    expect(params[1]).toBe('u1')
    expect(params[2]).toBe('chal-abc-1234567890')
  })

  it('mints a base64url code and an expiry ~2 minutes out by default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const before = Date.now()
    const { code, expiresAt } = await store.create({ userId: 'u1', challenge: 'c'.repeat(43) })
    const after = Date.now()

    expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
    // Bracketed against the clock either side of the call — deterministic.
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000)
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 120_000)
  })

  it('honours a ttl override', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const before = Date.now()
    const { expiresAt } = await store.create({ userId: 'u1', challenge: 'c'.repeat(43), ttlMs: 5_000 })
    const after = Date.now()
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 5_000)
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 5_000)
  })
})

describe('[COMP:api/desktop-auth-store] consume', () => {
  it('looks up by hash and returns the bound user + challenge on success', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ userId: 'u1', challenge: 'chal-xyz' }],
      rowCount: 1,
    } as never)

    const result = await store.consume('raw-code')
    expect(result).toEqual({ userId: 'u1', challenge: 'chal-xyz' })

    const sql = mockQuery.mock.calls[0][0] as string
    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[0]).toBe(hash('raw-code'))
    // Atomic single-use guard.
    expect(sql).toContain('used_at IS NULL')
    expect(sql).toContain('expires_at > NOW()')
    expect(sql).toContain('SET used_at = NOW()')
  })

  it('returns null when the code is missing, expired, or already used', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.consume('nope')).toBeNull()
  })
})
