/**
 * [COMP:api/custom-channel-store] — bridge state + outbox store and token
 * helpers. The DB boundary is mocked (same boundary as chat-link-store.test):
 * these tests pin the SQL shape (claim lease + skip-locked probe, ack
 * settles only unacked rows), the derived `online` window, and the token
 * mint / hash / constant-time compare contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { createCustomChannelStore, BRIDGE_ONLINE_WINDOW_MS, OUTBOX_LEASE_SECONDS } from '../custom-channel-store.js'
import { mintBridgeToken, hashBridgeToken, bridgeTokenMatches, BRIDGE_TOKEN_PREFIX } from '../custom-channel-token.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)
const store = createCustomChannelStore()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/custom-channel-store] bridge tokens', () => {
  it('mints a ubc_-prefixed 32-byte base64url token', () => {
    const token = mintBridgeToken()
    expect(token.startsWith(BRIDGE_TOKEN_PREFIX)).toBe(true)
    expect(token.slice(BRIDGE_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(mintBridgeToken()).not.toBe(token)
  })

  it('hashes to sha256 hex and compares constant-time against the hash', () => {
    const token = mintBridgeToken()
    const hash = hashBridgeToken(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(bridgeTokenMatches(token, hash)).toBe(true)
    expect(bridgeTokenMatches(token, hash.toUpperCase())).toBe(true)
    expect(bridgeTokenMatches(`${token}x`, hash)).toBe(false)
    expect(bridgeTokenMatches(mintBridgeToken(), hash)).toBe(false)
  })

  it('fails closed on missing / malformed inputs', () => {
    const hash = hashBridgeToken('ubc_abc')
    expect(bridgeTokenMatches(undefined, hash)).toBe(false)
    expect(bridgeTokenMatches('', hash)).toBe(false)
    expect(bridgeTokenMatches('ubc_abc', '')).toBe(false)
    expect(bridgeTokenMatches('ubc_abc', undefined)).toBe(false)
    expect(bridgeTokenMatches('ubc_abc', 'not-a-hash')).toBe(false)
  })
})

describe('[COMP:api/custom-channel-store] state', () => {
  it('putState upserts the published state and bumps last_seen_at', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.putState('chan-1', {
      status: 'needs_action',
      message: 'Scan the QR',
      action: { kind: 'qr', text: 'hello' },
      bridgeVersion: 'v1',
    })
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO custom_channel_bridge_state')
    expect(sql).toContain('ON CONFLICT (channel_id) DO UPDATE')
    expect(sql).toContain('last_seen_at = now()')
    expect(params[0]).toBe('chan-1')
    expect(params[1]).toBe('needs_action')
    expect(params[2]).toBe('Scan the QR')
    expect(JSON.parse(params[4] as string)).toEqual({ kind: 'qr', text: 'hello' })
    expect(params[5]).toBe('v1')
  })

  it('getState derives online from the 90 s window and carries the outbox depth', async () => {
    const now = new Date('2026-08-19T10:00:00Z')
    const fresh = new Date(now.getTime() - BRIDGE_ONLINE_WINDOW_MS + 1000)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        channel_id: 'chan-1', status: 'connected', message: null, account_label: 'Ken',
        action: null, bridge_version: null, last_seen_at: fresh, updated_at: fresh, outbox_depth: '3',
      }],
      rowCount: 1,
    } as never)
    const state = await store.getState('chan-1', now)
    expect(state).toMatchObject({ channelId: 'chan-1', status: 'connected', accountLabel: 'Ken', online: true, outboxDepth: 3 })
    expect(state?.lastSeenAt).toBe(fresh.toISOString())

    const stale = new Date(now.getTime() - BRIDGE_ONLINE_WINDOW_MS - 1000)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        channel_id: 'chan-1', status: 'connected', message: null, account_label: null,
        action: null, bridge_version: null, last_seen_at: stale, updated_at: stale, outbox_depth: 0,
      }],
      rowCount: 1,
    } as never)
    expect((await store.getState('chan-1', now))?.online).toBe(false)
  })

  it('getState returns null when nothing was ever published', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getState('chan-none')).toBeNull()
  })

  it('touchSeen upserts last_seen_at only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.touchSeen('chan-1')
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('ON CONFLICT (channel_id) DO UPDATE SET last_seen_at = now()')
    expect(params).toEqual(['chan-1'])
  })
})

describe('[COMP:api/custom-channel-store] outbox', () => {
  it('enqueue inserts the item and returns its id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'item-1' }], rowCount: 1 } as never)
    const id = await store.enqueue('chan-1', { type: 'message', peerId: 'peer-1', payload: { text: 'hi', format: 'markdown' } })
    expect(id).toBe('item-1')
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO custom_channel_outbox')
    expect(params[0]).toBe('chan-1')
    expect(params[1]).toBe('peer-1')
    expect(params[2]).toBe('message')
    expect(JSON.parse(params[3] as string)).toEqual({ text: 'hi', format: 'markdown' })
  })

  it('claim leases claimable rows with FOR UPDATE SKIP LOCKED and a 60 s lease', async () => {
    const created = new Date('2026-08-19T10:00:00Z')
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'item-1', item_type: 'message', peer_id: 'peer-1', payload: { text: 'hi' }, created_at: created }],
      rowCount: 1,
    } as never)
    const items = await store.claim('chan-1', 20)
    expect(items).toEqual([{ id: 'item-1', type: 'message', peerId: 'peer-1', payload: { text: 'hi' }, createdAt: created.toISOString() }])
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('UPDATE custom_channel_outbox')
    expect(sql).toContain('acked_at IS NULL')
    expect(sql).toContain('leased_until IS NULL OR leased_until < now()')
    expect(sql).toContain('expires_at > now()')
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain('ORDER BY created_at')
    expect(params).toEqual(['chan-1', 20, OUTBOX_LEASE_SECONDS])
  })

  it('ack settles only unacked rows of that channel and records failure + provider id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const settled = await store.ack('chan-1', [
      { id: 'item-1', ok: true, providerMessageId: 'wx-1' },
      { id: 'item-2', ok: false, error: 'peer blocked us' },
    ])
    expect(settled).toBe(1)
    const [sql1, p1] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql1).toContain('acked_at IS NULL')
    expect(p1).toEqual(['chan-1', 'item-1', true, null, 'wx-1'])
    const [, p2] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(p2).toEqual(['chan-1', 'item-2', false, 'peer blocked us', null])
  })

  it('expireStale deletes unacked rows past expires_at and reports the per-channel count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ channel_id: 'chan-1', count: '2' }], rowCount: 1 } as never)
    expect(await store.expireStale('chan-1')).toEqual([{ channelId: 'chan-1', count: 2 }])
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('DELETE FROM custom_channel_outbox')
    expect(sql).toContain('expires_at <= now()')
    expect(params).toEqual(['chan-1'])
  })
})
