import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbPageSendLogStore, SEND_CLAIM_STALE_MINUTES } from '../page-send-log-store.js'
import { queryWithRLS } from '../client.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const store = createDbPageSendLogStore()

const INPUT = {
  workspaceId: 'ws-1',
  pageId: 'page-1',
  workflowId: 'wf-1',
  runId: 'run-1',
  recipient: 'a@b.co',
  subject: 'Hi',
  bodyHash: 'hash',
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:api/page-send-ledger] page send log claim semantics', () => {
  it('claims when the insert wins the partial unique index', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: 'claim-1' }] } as never)
    const result = await store.claim('u-1', INPUT)
    expect(result).toEqual({ outcome: 'claimed', claimId: 'claim-1' })
    const sql = mockQueryWithRLS.mock.calls[0][1] as string
    expect(sql).toContain('ON CONFLICT (page_id) WHERE status IN')
    expect(sql).toContain('INSERT INTO page_send_log')
  })

  it('returns already_sent when the live row is sent (idempotent re-click)', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [] } as never) // insert lost
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'live-1',
            status: 'sent',
            recipient: 'a@b.co',
            sent_at: new Date('2026-07-11T00:00:00Z'),
            claimed_at: new Date('2026-07-10T23:59:00Z'),
          },
        ],
      } as never)
    const result = await store.claim('u-1', INPUT)
    expect(result).toEqual({
      outcome: 'already_sent',
      recipient: 'a@b.co',
      sentAt: '2026-07-11T00:00:00.000Z',
    })
  })

  it('reports in_flight when a fresh claim holds the index and takeover loses', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [] } as never) // insert lost
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'live-1',
            status: 'claimed',
            recipient: 'a@b.co',
            sent_at: null,
            claimed_at: new Date(),
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never) // guarded takeover UPDATE matched nothing
    const result = await store.claim('u-1', INPUT)
    expect(result).toEqual({ outcome: 'in_flight' })
    const takeoverSql = mockQueryWithRLS.mock.calls[2][1] as string
    expect(takeoverSql).toContain("status = 'claimed'")
    expect(takeoverSql).toContain('make_interval')
    expect(mockQueryWithRLS.mock.calls[2][2]).toContain(SEND_CLAIM_STALE_MINUTES)
  })

  it('takes over a stale claim when the guarded UPDATE wins', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'live-1',
            status: 'claimed',
            recipient: 'old@b.co',
            sent_at: null,
            claimed_at: new Date(Date.now() - 60 * 60 * 1000),
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'live-1' }] } as never)
    const result = await store.claim('u-1', INPUT)
    expect(result).toEqual({ outcome: 'claimed', claimId: 'live-1' })
  })

  it('markSent and markFailed only flip rows still in claimed', async () => {
    mockQueryWithRLS.mockResolvedValue({ rows: [] } as never)
    await store.markSent('u-1', 'claim-1', 'gm-1')
    expect(mockQueryWithRLS.mock.calls[0][1]).toContain("status = 'sent'")
    expect(mockQueryWithRLS.mock.calls[0][1]).toContain("AND status = 'claimed'")
    await store.markFailed('u-1', 'claim-1', 'boom')
    expect(mockQueryWithRLS.mock.calls[1][1]).toContain("status = 'failed'")
    expect(mockQueryWithRLS.mock.calls[1][1]).toContain("AND status = 'claimed'")
  })
})
