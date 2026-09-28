/** Primary participant transaction contract. [COMP:api/crm-record-http] */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const release = vi.fn()
const client = { query, release }
const connect = vi.fn(async () => client)

vi.mock('../client.js', () => ({
  applyRLSGucs: vi.fn(),
  getPool: vi.fn(() => ({ connect })),
  getAppPool: vi.fn(() => ({ connect })),
  query: vi.fn(),
  queryGated: vi.fn(),
  queryWithRLS: vi.fn(),
}))
vi.mock('../entities-store.js', () => ({
  getEntityById: vi.fn(),
  updateEntity: vi.fn(),
}))
vi.mock('../crm.js', () => ({ prepareCrmParticipantMutation: vi.fn(), updateDeal: vi.fn() }))

import { prepareCrmParticipantMutation, updateDeal } from '../crm.js'
import { setCrmDealPrimaryContact } from '../crm-r2.js'

const ctx = {
  userId: 'user-1', workspaceId: 'workspace-1',
  assistantId: 'assistant-1', assistantKind: 'standard' as const,
}

describe('[COMP:api/crm-record-http] primary participant transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.mockResolvedValue({ rows: [] })
    vi.mocked(prepareCrmParticipantMutation).mockResolvedValue({ id: 'deal-1', kind: 'deal', attributes: {} } as never)
    vi.mocked(updateDeal).mockResolvedValue({ id: 'deal-1' } as never)
  })

  it('sets the primary participant and canonical contact before one commit', async () => {
    await expect(setCrmDealPrimaryContact({
      ctx,
      dealId: 'deal-1',
      contactId: 'contact-1',
      role: 'Sponsor',
    })).resolves.toBe(true)

    const statements = query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim())
    expect(statements[0]).toBe('BEGIN')
    expect(statements[1]).toContain('UPDATE crm_deal_contacts')
    expect(statements[2]).toContain('INSERT INTO crm_deal_contacts')
    expect(statements[3]).toBe('COMMIT')
    expect(prepareCrmParticipantMutation).toHaveBeenCalledWith(ctx, 'deal-1', 'contact-1', client)
    expect(updateDeal).toHaveBeenCalledWith(ctx.userId, 'deal-1', { contactId: 'contact-1' }, undefined, ctx, client)
    expect(vi.mocked(prepareCrmParticipantMutation).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(updateDeal).mock.invocationCallOrder[0]!)
    expect(vi.mocked(updateDeal).mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[1]!)
    expect(release).toHaveBeenCalledOnce()
  })

  it('clears both representations in one transaction and rolls back a failed write', async () => {
    vi.mocked(updateDeal).mockRejectedValueOnce(new Error('write failed'))

    await expect(setCrmDealPrimaryContact({
      ctx,
      dealId: 'deal-1',
      contactId: null,
    })).rejects.toThrow('write failed')

    const statements = query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim())
    expect(statements).toEqual(['BEGIN', 'ROLLBACK'])
    expect(updateDeal).toHaveBeenCalledWith(ctx.userId, 'deal-1', { contactId: null }, undefined, ctx, client)
    expect(release).toHaveBeenCalledOnce()
  })

  it('refuses participant SQL before the canonical write when source admission fails',async()=>{
    vi.mocked(prepareCrmParticipantMutation).mockResolvedValueOnce(null)
    expect(await setCrmDealPrimaryContact({ctx,dealId:'deal-1',contactId:'contact-1'})).toBe(false)
    expect(updateDeal).not.toHaveBeenCalled()
    expect(query.mock.calls.map(([sql])=>sql)).toEqual(['BEGIN','ROLLBACK'])
    expect(release).toHaveBeenCalledOnce()
  })
})
