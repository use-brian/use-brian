/** Primary participant transaction contract. [COMP:api/crm-record-http] */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const release = vi.fn()
const connect = vi.fn(async () => ({ query, release }))

vi.mock('../client.js', () => ({
  getPool: vi.fn(() => ({ connect })),
  query: vi.fn(),
  queryGated: vi.fn(),
  queryWithRLS: vi.fn(),
}))
vi.mock('../entities-store.js', () => ({
  getEntityById: vi.fn(),
  updateEntity: vi.fn(),
}))

import { getEntityById } from '../entities-store.js'
import { setCrmDealPrimaryContact } from '../crm-r2.js'

const ctx = {
  userId: 'user-1', workspaceId: 'workspace-1',
  assistantId: 'assistant-1', assistantKind: 'standard' as const,
}

describe('[COMP:api/crm-record-http] primary participant transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.mockResolvedValue({ rows: [] })
    vi.mocked(getEntityById)
      .mockResolvedValueOnce({ id: 'deal-1', kind: 'deal', attributes: {} } as never)
      .mockResolvedValueOnce({ id: 'contact-1', kind: 'person', attributes: {} } as never)
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
    expect(statements[3]).toContain("jsonb_set")
    expect(statements[4]).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('clears both representations in one transaction and rolls back a failed write', async () => {
    vi.mocked(getEntityById).mockReset()
    vi.mocked(getEntityById).mockResolvedValueOnce({ id: 'deal-1', kind: 'deal', attributes: {} } as never)
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("attributes = COALESCE")) throw new Error('write failed')
      return { rows: [] }
    })

    await expect(setCrmDealPrimaryContact({
      ctx,
      dealId: 'deal-1',
      contactId: null,
    })).rejects.toThrow('write failed')

    const statements = query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim())
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })
})
