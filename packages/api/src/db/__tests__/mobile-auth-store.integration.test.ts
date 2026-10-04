import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'

// Isolated schema only; never run application migrations against a shared DB.
const state = vi.hoisted(() => ({ query: null as null | ((sql: string, params?: unknown[]) => Promise<unknown>) }))
vi.mock('../client.js', () => ({ query: (sql: string, params?: unknown[]) => state.query!(sql, params) }))
import { createDbMobileAuthStore, MOBILE_REDIRECT_URI } from '../mobile-auth-store.js'

const url = process.env.MOBILE_AUTH_TEST_DATABASE_URL
const schema = `mobile_auth_test_${randomUUID().replaceAll('-', '')}`
const userId = randomUUID()
const verifier = 'v'.repeat(64)
const challenge = createHash('sha256').update(verifier).digest('base64url')
const binding = { clientId: 'brian-ios', redirectUri: MOBILE_REDIRECT_URI }
const store = createDbMobileAuthStore()
let pool: pg.Pool

describe.skipIf(!url)('[COMP:api/mobile-auth-store] PostgreSQL atomic redemption', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
    await pool.query(`CREATE SCHEMA ${schema}`)
    state.query = (sql, params) => pool.query(sql, params)
    await pool.query('CREATE TABLE users (id UUID PRIMARY KEY)')
    await pool.query('INSERT INTO users VALUES ($1)', [userId])
    await pool.query(await readFile(new URL('../../../migrations/654_mobile_auth.sql', import.meta.url), 'utf8'))
  })
  afterAll(async () => {
    if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end() }
  })
  it('stores only a hash with a two minute expiry', async () => {
    const before = Date.now()
    const { code, expiresAt } = await store.create({ ...binding, userId, challenge })
    const { rows } = await pool.query('SELECT * FROM mobile_auth_codes WHERE code_hash = $1', [createHash('sha256').update(code).digest('hex')])
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(code)
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(120_000)
    expect(expiresAt.getTime() - before).toBeLessThan(121_000)
  })
  it.each([
    { verifier: 'x'.repeat(64) },
    { clientId: 'brian-android' },
    { redirectUri: 'usebrian-mobile://other' },
  ])('does not consume when a binding mismatches: %j', async mismatch => {
    const { code } = await store.create({ ...binding, userId, challenge })
    expect(await store.consume({ ...binding, code, verifier, ...mismatch })).toBeNull()
    expect(await store.consume({ ...binding, code, verifier })).toEqual({ userId })
    expect(await store.consume({ ...binding, code, verifier })).toBeNull()
  })
  it('permits exactly one concurrent redemption', async () => {
    const { code } = await store.create({ ...binding, userId, challenge })
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consume({ ...binding, code, verifier })))
    expect(results.filter(Boolean)).toEqual([{ userId }])
  })
  it('rejects expired and missing codes', async () => {
    const { code } = await store.create({ ...binding, userId, challenge })
    await pool.query('UPDATE mobile_auth_codes SET expires_at = NOW() - INTERVAL \'1 second\'')
    expect(await store.consume({ ...binding, code, verifier })).toBeNull()
    expect(await store.consume({ ...binding, code: 'missing', verifier })).toBeNull()
  })
})
