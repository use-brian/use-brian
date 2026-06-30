import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import {
  buildChannelSessionKey,
  insertPendingRecordingConfirmation,
  getPendingRecordingConfirmation,
  listPendingRecordingConfirmationsForSession,
  deletePendingRecordingConfirmation,
  deleteExpiredPendingRecordingConfirmations,
} from '../pending-recording-confirmations-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:recordings/pending-recording-confirmations-store] pending recording confirmations', () => {
  it('buildChannelSessionKey joins channel:channelId:userId', () => {
    expect(buildChannelSessionKey({ channel: 'slack', channelId: 'C123', userId: 'u-1' })).toBe(
      'slack:C123:u-1',
    )
  })

  it('insert returns inserted:true when a row was written', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ recordingId: 'rec-1' }] } as never)
    const res = await insertPendingRecordingConfirmation({
      recordingId: 'rec-1',
      channelSessionKey: 'slack:C123:u-1',
      durationSeconds: 600,
      surchargeCredits: 1,
      defaultBlueprintSlug: 'tpl-1',
      fileLabel: 'call.m4a',
    })
    expect(res).toEqual({ inserted: true })
    // The TTL parameter is passed (default 24h).
    const args = mockQuery.mock.calls[0]![1] as unknown[]
    expect(args[0]).toBe('rec-1')
    expect(args[6]).toBe('24')
  })

  it('insert is idempotent — ON CONFLICT DO NOTHING yields inserted:false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    const res = await insertPendingRecordingConfirmation({
      recordingId: 'rec-1',
      channelSessionKey: 'slack:C123:u-1',
      durationSeconds: 600,
      surchargeCredits: 1,
    })
    expect(res).toEqual({ inserted: false })
  })

  it('getByRecordingId returns the mapped row or null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          recordingId: 'rec-1',
          channelSessionKey: 'slack:C123:u-1',
          durationSeconds: 600,
          surchargeCredits: 1,
          defaultBlueprintSlug: 'tpl-1',
          fileLabel: 'call.m4a',
          createdAt: new Date(),
          expiresAt: new Date(),
        },
      ],
    } as never)
    const row = await getPendingRecordingConfirmation('rec-1')
    expect(row?.recordingId).toBe('rec-1')
    expect(row?.channelSessionKey).toBe('slack:C123:u-1')

    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    expect(await getPendingRecordingConfirmation('missing')).toBeNull()
  })

  it('listForSession filters by key + un-expired (expires_at > now())', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          recordingId: 'rec-1',
          channelSessionKey: 'slack:C123:u-1',
          durationSeconds: 600,
          surchargeCredits: 1,
          defaultBlueprintSlug: null,
          fileLabel: null,
          createdAt: new Date(),
          expiresAt: new Date(),
        },
      ],
    } as never)
    const rows = await listPendingRecordingConfirmationsForSession('slack:C123:u-1')
    expect(rows).toHaveLength(1)
    const sql = mockQuery.mock.calls[0]![0] as string
    expect(sql).toContain('channel_session_key = $1')
    expect(sql).toContain('expires_at > now()')
  })

  it('delete removes the row by recording id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await deletePendingRecordingConfirmation('rec-1')
    const sql = mockQuery.mock.calls[0]![0] as string
    expect(sql).toContain('DELETE FROM pending_recording_confirmations WHERE recording_id = $1')
  })

  it('deleteExpired returns the swept count', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 3 } as never)
    expect(await deleteExpiredPendingRecordingConfirmations()).toBe(3)
    const sql = mockQuery.mock.calls[0]![0] as string
    expect(sql).toContain('expires_at <= now()')
  })
})
