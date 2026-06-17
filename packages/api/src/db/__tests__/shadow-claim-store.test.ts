/**
 * Unit tests for the shadow-claim token store.
 * Component tag: [COMP:auth/shadow-claim-store].
 *
 * Mocks `query`. Verifies createShadowClaimStore: the mint INSERT (token
 * generated, default vs custom TTL on expiresAt, displayLabel default to
 * null), and the atomic consume — success on a returned row, plus the
 * three disambiguated failures (not_found / already_used / expired)
 * resolved by the follow-up probe SELECT.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { createShadowClaimStore } from '../shadow-claim-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)
const store = createShadowClaimStore()

function tokenRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'tok-1',
    realUserId: 'real-1',
    shadowUserId: 'shadow-1',
    partnerKeyId: 'pk-1',
    externalUserId: 'ext-1',
    displayLabel: 'Acme partner',
    expiresAt: new Date('2026-05-16T01:00:00Z'),
    usedAt: null,
    createdAt: new Date('2026-05-16T00:00:00Z'),
    ...over,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:auth/shadow-claim-store] create', () => {
  it('inserts a generated token bound to the triple with a default 5-minute TTL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const before = Date.now()
    const created = await store.create({
      realUserId: 'real-1',
      shadowUserId: 'shadow-1',
      partnerKeyId: 'pk-1',
      externalUserId: 'ext-1',
    })
    const after = Date.now()
    expect(typeof created.token).toBe('string')
    expect(created.token.length).toBeGreaterThan(0)
    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 60 * 1000)
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(after + 5 * 60 * 1000)

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('INSERT INTO shadow_claim_tokens')
    expect(params?.[0]).toBe(created.token)
    expect(params?.[5]).toBeNull() // displayLabel defaults to null
  })

  it('honors a custom TTL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const before = Date.now()
    const created = await store.create({
      realUserId: 'real-1',
      shadowUserId: 'shadow-1',
      partnerKeyId: 'pk-1',
      externalUserId: 'ext-1',
      displayLabel: 'Acme',
      ttlSeconds: 60,
    })
    const after = Date.now()
    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000)
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(after + 60_000)
    expect(mockQuery.mock.calls[0][1]?.[5]).toBe('Acme')
  })
})

describe('[COMP:auth/shadow-claim-store] consume', () => {
  it('returns the bound row when the atomic UPDATE flips a live token', async () => {
    const row = tokenRow()
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never)
    const res = await store.consume('tok-1')
    expect(res).toEqual({ ok: true, row })
    expect(mockQuery).toHaveBeenCalledOnce() // success path issues no probe
  })

  it('reports not_found when neither the UPDATE nor the probe match', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.consume('ghost')).toEqual({ ok: false, reason: 'not_found' })
  })

  it('reports already_used when the probe row carries a used_at timestamp', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [{ used_at: new Date('2026-05-16T00:30:00Z'), expires_at: new Date('2026-05-16T01:00:00Z') }],
        rowCount: 1,
      } as never)
    expect(await store.consume('tok-1')).toEqual({ ok: false, reason: 'already_used' })
  })

  it('reports expired when the probe row is unused but past its expiry', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [{ used_at: null, expires_at: new Date('2020-01-01T00:00:00Z') }],
        rowCount: 1,
      } as never)
    expect(await store.consume('tok-1')).toEqual({ ok: false, reason: 'expired' })
  })
})
