import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({ query: vi.fn() }))

import { query } from '../client.js'
import { claimChannelEvent } from '../channel-event-dedup.js'

describe('[COMP:api/channel-event-dedup] claimChannelEvent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('claims a new event and prunes expired claims in the same statement', async () => {
    vi.mocked(query).mockResolvedValue({ rowCount: 1, rows: [{ event_id: 'evt-1' }] } as never)
    await expect(claimChannelEvent('channel-1', 'evt-1')).resolves.toBe(true)
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("received_at < now() - interval '14 days'"),
      ['channel-1', 'evt-1'],
    )
  })

  it('rejects a provider redelivery already claimed by this channel', async () => {
    vi.mocked(query).mockResolvedValue({ rowCount: 0, rows: [] } as never)
    await expect(claimChannelEvent('channel-1', 'evt-1')).resolves.toBe(false)
  })
})
