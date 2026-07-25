import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { createChatLinkStore } from '../chat-link-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createChatLinkStore()

describe('[COMP:api/chat-link-store] createChatLinkStore', () => {
  describe('create', () => {
    it('mints a 32-byte base64url token and inserts with defaults', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'l_1', assistantId: 'a_1', token: 'tok', label: 'Public chat' }],
        rowCount: 1,
      } as never)

      const link = await store.create({ assistantId: 'a_1', createdBy: 'u_1' })

      expect(link.id).toBe('l_1')
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('INSERT INTO assistant_chat_links')
      expect(params[0]).toBe('a_1')
      // token: 32 bytes base64url ≈ 43 chars, URL-safe alphabet
      expect(params[1]).toMatch(/^[A-Za-z0-9_-]{40,}$/)
      expect(params[2]).toBe('Public chat') // default label
      expect(params[3]).toBe(200) // default daily cap
      expect(params[4]).toBe('u_1')
    })

    it('passes custom label and cap through', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'l_2' }], rowCount: 1 } as never)

      await store.create({ assistantId: 'a_1', createdBy: 'u_1', label: 'Landing page', dailyMessageLimit: 50 })

      const params = mockQuery.mock.calls[0][1] as unknown[]
      expect(params[2]).toBe('Landing page')
      expect(params[3]).toBe(50)
    })
  })

  describe('listForAssistant', () => {
    it('lists newest first, scoped to the assistant', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'l_1' }, { id: 'l_2' }], rowCount: 2 } as never)

      const links = await store.listForAssistant('a_1')

      expect(links).toHaveLength(2)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('WHERE assistant_id = $1')
      expect(sql).toContain('ORDER BY created_at DESC')
    })
  })

  describe('revoke', () => {
    it('revokes only an active link belonging to the assistant', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)

      const ok = await store.revoke('l_1', 'a_1')

      expect(ok).toBe(true)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain("SET status = 'revoked'")
      expect(sql).toContain("assistant_id = $2 AND status = 'active'")
    })

    it('returns false when the link is not found / not owned / already revoked', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 } as never)
      expect(await store.revoke('l_missing', 'a_1')).toBe(false)
    })
  })

  describe('resolveToken', () => {
    it('resolves an active token and gates on workspace external sharing', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ linkId: 'l_1', assistantId: 'a_1', dailyMessageLimit: 200, workspaceId: 'ws_1', assistantName: 'Ops', assistantIconSeed: 3, assistantBio: null }],
        rowCount: 1,
      } as never)

      const resolved = await store.resolveToken('tok_raw')

      expect(resolved?.linkId).toBe('l_1')
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('l.token = $1')
      expect(sql).toContain("l.status = 'active'")
      // The same workspace-level kill switch page share links honor.
      expect(sql).toContain('external_sharing_enabled = true')
    })

    it('returns null for unknown/revoked tokens', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      expect(await store.resolveToken('nope')).toBeNull()
    })
  })

  describe('consumeDailyBudget', () => {
    it('allows under the cap and stamps last_used_at atomically', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ used: 5, limit: 200 }], rowCount: 1 } as never)

      const result = await store.consumeDailyBudget('l_1')

      expect(result).toEqual({ allowed: true, used: 5, limit: 200 })
      const sql = mockQuery.mock.calls[0][0] as string
      // Single-statement increment-or-reset — no read-then-write race.
      expect(sql).toContain('daily_window_date = CURRENT_DATE')
      expect(sql).toContain('WHEN daily_window_date = CURRENT_DATE THEN daily_used + 1')
      expect(sql).toContain('last_used_at = now()')
    })

    it('denies once used exceeds the limit', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ used: 201, limit: 200 }], rowCount: 1 } as never)
      expect((await store.consumeDailyBudget('l_1')).allowed).toBe(false)
    })

    it('treats limit 0 as unlimited', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ used: 99_999, limit: 0 }], rowCount: 1 } as never)
      expect((await store.consumeDailyBudget('l_1')).allowed).toBe(true)
    })

    it('denies when the link row vanished', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      expect((await store.consumeDailyBudget('l_gone')).allowed).toBe(false)
    })
  })
})
