import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { createDbCapabilityStore } from '../capability-store.js'
import { query } from '../client.js'
import { DuplicateGrantError } from '@sidanclaw/core'

const mockQuery = vi.mocked(query)
const store = createDbCapabilityStore()

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:authorization/capability-store] listActive', () => {
  it('returns only capabilities whose grants are not revoked', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ capability: 'bug_triage' }],
      rowCount: 1,
    } as never)
    const caps = await store.listActive('assistant-1')
    expect(caps).toEqual(['bug_triage'])
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('revoked_at IS NULL')
    expect(params).toEqual(['assistant-1'])
  })

  it('returns empty array when no active grants', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const caps = await store.listActive('assistant-2')
    expect(caps).toEqual([])
  })
})

describe('[COMP:authorization/capability-store] hasActive', () => {
  it('returns true when EXISTS returns true', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 } as never)
    expect(await store.hasActive('a-1')).toBe(true)
  })

  it('returns false when EXISTS returns false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 } as never)
    expect(await store.hasActive('a-1')).toBe(false)
  })
})

describe('[COMP:authorization/capability-store] grant', () => {
  it('inserts and returns the new grant', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'g-1',
        assistantId: 'a-1',
        capability: 'bug_triage',
        grantedByUserId: 'u-admin',
        grantedAt: new Date(),
        revokedAt: null,
        revokedByUserId: null,
        reason: 'initial seed',
      }],
      rowCount: 1,
    } as never)

    const grant = await store.grant({
      assistantId: 'a-1',
      capability: 'bug_triage',
      grantedByUserId: 'u-admin',
      reason: 'initial seed',
    })
    expect(grant.id).toBe('g-1')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('INSERT INTO assistant_capabilities')
    expect(params).toEqual(['a-1', 'bug_triage', 'u-admin', 'initial seed'])
  })

  it('throws DuplicateGrantError on 23505 unique violation', async () => {
    const uniqueErr = Object.assign(new Error('duplicate key'), { code: '23505' })
    mockQuery.mockRejectedValueOnce(uniqueErr)

    await expect(store.grant({
      assistantId: 'a-1',
      capability: 'bug_triage',
      grantedByUserId: 'u-admin',
    })).rejects.toBeInstanceOf(DuplicateGrantError)
  })

  it('rethrows non-unique errors unchanged', async () => {
    const randomErr = Object.assign(new Error('boom'), { code: '42P01' })
    mockQuery.mockRejectedValueOnce(randomErr)

    await expect(store.grant({
      assistantId: 'a-1',
      capability: 'bug_triage',
      grantedByUserId: 'u-admin',
    })).rejects.toBe(randomErr)
  })
})

describe('[COMP:authorization/capability-store] revoke', () => {
  it('updates revoked_at and returns the updated grant', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'g-1',
        assistantId: 'a-1',
        capability: 'bug_triage',
        grantedByUserId: 'u-admin',
        grantedAt: new Date('2026-01-01'),
        revokedAt: new Date(),
        revokedByUserId: 'u-admin',
        reason: 'misbehaviour',
      }],
      rowCount: 1,
    } as never)

    const out = await store.revoke({
      grantId: 'g-1',
      revokedByUserId: 'u-admin',
      reason: 'misbehaviour',
    })
    expect(out?.revokedAt).toBeInstanceOf(Date)
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toContain('SET revoked_at = now()')
    expect(sql).toContain('revoked_at IS NULL')
  })

  it('returns null when the grant is missing or already revoked', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const out = await store.revoke({ grantId: 'g-missing', revokedByUserId: 'u-admin' })
    expect(out).toBeNull()
  })
})

describe('[COMP:authorization/capability-store] listHistoryForAssistant', () => {
  it('returns rows ordered by granted_at DESC, including revoked ones', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.listHistoryForAssistant('a-1')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('ORDER BY granted_at DESC')
    expect(sql).not.toContain('revoked_at IS NULL')
    expect(params).toEqual(['a-1'])
  })
})

describe('[COMP:authorization/capability-store] listAllActive', () => {
  it('joins assistant name and owner email', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.listAllActive()
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toContain('JOIN assistants')
    expect(sql).toContain('LEFT JOIN users')
    expect(sql).toContain('revoked_at IS NULL')
  })
})
