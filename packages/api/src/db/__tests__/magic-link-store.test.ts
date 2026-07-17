import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { createDbMagicLinkStore } from '../magic-link-store.js'
import { query } from '../client.js'
import { createHash } from 'node:crypto'

const mockQuery = vi.mocked(query)
const store = createDbMagicLinkStore()

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/magic-link-store] create', () => {
  it('inserts the hash, never the raw token or raw code', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const { token, code } = await store.create({ email: 'a@b.com' })

    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[0]).toBe(hash(token))
    // Neither the raw token nor the raw code may appear in any SQL parameter
    expect(params).not.toContain(token)
    expect(params).not.toContain(code)
    // code_hash ($8) is sha256("<email>:<code>") — salted per-email
    expect(params[7]).toBe(createHash('sha256').update(`a@b.com:${code}`).digest('hex'))
  })

  it('returns a zero-padded 6-digit numeric code', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const { code } = await store.create({ email: 'a@b.com' })
    expect(code).toMatch(/^\d{6}$/)
  })

  it('lowercases the email', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    await store.create({ email: 'Foo.Bar@Example.COM ' })

    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[1]).toBe('foo.bar@example.com')
  })

  it('defaults to a 15-minute TTL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const before = Date.now()

    await store.create({ email: 'a@b.com' })

    const params = mockQuery.mock.calls[0][1] as unknown[]
    const expiresAtMs = new Date(params[4] as string).getTime()
    const ttlMs = expiresAtMs - before
    expect(ttlMs).toBeGreaterThan(14 * 60 * 1000)
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 100)
  })

  it('honors a custom ttlMs override', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const before = Date.now()

    await store.create({ email: 'a@b.com', ttlMs: 60_000 })

    const params = mockQuery.mock.calls[0][1] as unknown[]
    const expiresAtMs = new Date(params[4] as string).getTime()
    expect(expiresAtMs - before).toBeLessThanOrEqual(60_000 + 100)
    expect(expiresAtMs - before).toBeGreaterThan(59_000)
  })

  it('persists locale and next_path when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    await store.create({
      email: 'a@b.com',
      locale: 'ja',
      nextPath: '/brain',
      ip: '1.2.3.4',
      userAgent: 'Mozilla',
    })

    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[2]).toBe('/brain')
    expect(params[3]).toBe('ja')
    expect(params[5]).toBe('1.2.3.4')
    expect(params[6]).toBe('Mozilla')
  })

  it('truncates an oversized user agent to 512 chars', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const huge = 'x'.repeat(2000)

    await store.create({ email: 'a@b.com', userAgent: huge })

    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect((params[6] as string).length).toBe(512)
  })

  it('returns a base64url token (no +, /, =)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const { token } = await store.create({ email: 'a@b.com' })
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThan(40)
  })
})

describe('[COMP:api/magic-link-store] consumeByToken', () => {
  it('runs an atomic UPDATE with NULL + future expiry guards', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ email: 'a@b.com', nextPath: null, locale: null }],
      rowCount: 1,
    } as never)

    await store.consumeByToken('some-token')

    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('UPDATE magic_link_tokens')
    expect(sql).toContain('SET used_at = NOW()')
    expect(sql).toContain('used_at IS NULL')
    expect(sql).toContain('expires_at > NOW()')
    expect(sql).toContain('RETURNING')
  })

  it('returns null when no row matched (expired / used / missing)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    const result = await store.consumeByToken('bad-token')

    expect(result).toBeNull()
  })

  it('passes the sha256 hash, not the raw token', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    await store.consumeByToken('my-secret-token')

    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[0]).toBe(hash('my-secret-token'))
    expect(params).not.toContain('my-secret-token')
  })

  it('returns the consumed row on success', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ email: 'a@b.com', nextPath: '/brain', locale: 'zh' }],
      rowCount: 1,
    } as never)

    const result = await store.consumeByToken('valid-token')

    expect(result).toEqual({ email: 'a@b.com', nextPath: '/brain', locale: 'zh' })
  })
})

describe('[COMP:api/magic-link-store] consumeByCode', () => {
  it('returns invalid (short-circuit, one query) when the email has no active code', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ maxAttempts: null, n: '0' }], rowCount: 1 } as never)

    const result = await store.consumeByCode('a@b.com', '123456')

    expect(result).toEqual({ status: 'invalid' })
    expect(mockQuery).toHaveBeenCalledTimes(1) // never reaches the consume/increment
  })

  it('returns locked once the attempt cap is hit, without checking the code', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ maxAttempts: 5, n: '1' }], rowCount: 1 } as never)

    const result = await store.consumeByCode('a@b.com', '123456')

    expect(result).toEqual({ status: 'locked' })
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('atomically consumes the matching code and returns ok', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ maxAttempts: 0, n: '1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{ email: 'a@b.com', nextPath: '/brain', locale: 'zh' }],
        rowCount: 1,
      } as never)

    const result = await store.consumeByCode('a@b.com', '123456')

    expect(result).toEqual({ status: 'ok', email: 'a@b.com', nextPath: '/brain', locale: 'zh' })
    // The consume UPDATE is atomic + scoped to the (email, code_hash) pair
    const sql = mockQuery.mock.calls[1][0] as string
    expect(sql).toContain('UPDATE magic_link_tokens')
    expect(sql).toContain('SET used_at = NOW()')
    expect(sql).toContain('used_at IS NULL')
    expect(sql).toContain('expires_at > NOW()')
  })

  it('passes the salted sha256 code hash, never the raw code', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ maxAttempts: 0, n: '1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    await store.consumeByCode('A@B.com', '123456')

    const consumeParams = mockQuery.mock.calls[1][1] as unknown[]
    expect(consumeParams[0]).toBe('a@b.com')
    expect(consumeParams[1]).toBe(createHash('sha256').update('a@b.com:123456').digest('hex'))
    expect(consumeParams).not.toContain('123456')
  })

  it('burns an attempt across the active codes on a wrong guess, then returns invalid', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ maxAttempts: 1, n: '2' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // no code matched
      .mockResolvedValueOnce({ rows: [], rowCount: 2 } as never) // increment

    const result = await store.consumeByCode('a@b.com', '000000')

    expect(result).toEqual({ status: 'invalid' })
    const incSql = mockQuery.mock.calls[2][0] as string
    expect(incSql).toContain('code_attempts = code_attempts + 1')
  })
})

describe('[COMP:api/magic-link-store] rate-limit counts', () => {
  it('counts recent tokens for an email since the given time', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }], rowCount: 1 } as never)
    const since = new Date('2026-05-26T00:00:00Z')

    const n = await store.countRecentForEmail('A@B.com', since)

    expect(n).toBe(7)
    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[0]).toBe('a@b.com')
    expect(params[1]).toBe(since.toISOString())
  })

  it('counts recent tokens for an IP using inet casting', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 1 } as never)
    const since = new Date('2026-05-26T00:00:00Z')

    const n = await store.countRecentForIp('1.2.3.4', since)

    expect(n).toBe(3)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('created_ip = $1::inet')
  })

  it('returns 0 when the count query yields no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.countRecentForEmail('a@b.com', new Date())).toBe(0)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.countRecentForIp('1.2.3.4', new Date())).toBe(0)
  })
})
