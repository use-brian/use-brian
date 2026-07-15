/**
 * Email domains store — pure unit tests over the query seam (no DB).
 * The RLS posture and SQL shapes are the contract: user paths go through
 * queryWithRLS, the webhook verify path is system-side, and domains are
 * normalized to lowercase at insert.
 *
 * Spec: docs/architecture/integrations/agentmail.md → "Data model".
 * Component tag: [COMP:api/email-domains-store]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { query, queryWithRLS } from '../client.js'
import { createEmailDomainStore } from '../email-domains-store.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/email-domains-store] Email domains store', () => {
  const store = createEmailDomainStore()

  it('create is RLS-gated, lowercases the domain, and stamps created_by from the actor', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: 'd1' }], rowCount: 1 } as never)

    await store.create({
      actingUserId: 'user-1',
      workspaceId: 'ws-1',
      domain: 'Mail.Acme.Com',
      providerDomainId: 'am-d1',
      providerStatus: 'PENDING',
      records: [{ type: 'MX', name: 'mail.acme.com', value: 'in.agentmail.to', status: null, priority: 10 }],
    })

    const [actingUserId, sql, params] = mockQueryWithRLS.mock.calls[0]
    expect(actingUserId).toBe('user-1')
    expect(sql).toContain('INSERT INTO email_domains')
    expect(sql).toContain('lower($2)')
    expect(params).toEqual([
      'ws-1',
      'Mail.Acme.Com',
      'am-d1',
      'PENDING',
      JSON.stringify([{ type: 'MX', name: 'mail.acme.com', value: 'in.agentmail.to', status: null, priority: 10 }]),
      'user-1',
    ])
  })

  it('markVerifiedByProviderIdSystem runs system-side (no RLS) keyed by provider domain id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const matched = await store.markVerifiedByProviderIdSystem('am-d1')

    expect(matched).toBe(true)
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain(`SET status = 'verified'`)
    expect(sql).toContain('WHERE provider_domain_id = $1')
    expect(params).toEqual(['am-d1'])
  })

  it('markVerifiedByProviderIdSystem reports no match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.markVerifiedByProviderIdSystem('unknown')).toBe(false)
  })

  it('list / get / update / delete all run through the RLS pool with the acting user', async () => {
    mockQueryWithRLS.mockResolvedValue({ rows: [], rowCount: 0 } as never)

    await store.listForWorkspace('user-1', 'ws-1')
    await store.getForUser('user-1', 'd1')
    await store.updateStatusForUser({
      actingUserId: 'user-1',
      id: 'd1',
      status: 'verified',
      providerStatus: 'VERIFIED',
      records: [],
    })
    await store.deleteForUser('user-1', 'd1')

    expect(mockQuery).not.toHaveBeenCalled()
    for (const call of mockQueryWithRLS.mock.calls) {
      expect(call[0]).toBe('user-1')
    }
  })

  it('getForUser returns null when RLS filters the row', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getForUser('user-1', 'missing')).toBeNull()
  })
})
