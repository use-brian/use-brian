/**
 * Unit tests for the per-assistant connector grants store.
 * Component tag: [COMP:brain/assistant-connector-grants-store].
 *
 * Mocks `query` and `queryWithRLS`. Verifies the three call paths the
 * runtime + REST surface depend on: system-level lookup for the gate,
 * RLS-scoped list for the Studio panel, and the idempotent upsert that
 * always bumps `updated_at` + records `granted_by_user_id`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbAssistantConnectorGrantsStore } from '../assistant-connector-grants-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockQueryRls = vi.mocked(queryWithRLS)
const store = createDbAssistantConnectorGrantsStore()

beforeEach(() => {
  mockQuery.mockReset()
  mockQueryRls.mockReset()
})

describe('[COMP:brain/assistant-connector-grants-store] getForAssistantSystem', () => {
  it('returns the row when present', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'g-1',
        assistantId: 'a-1',
        connectorId: 'gmail',
        readAllowed: true,
        allowedActions: ['gmailSendMessage'],
        grantedByUserId: 'u-1',
        grantedAt: new Date(),
        updatedAt: new Date(),
      }],
      rowCount: 1,
    } as never)
    const out = await store.getForAssistantSystem('a-1', 'gmail')
    expect(out?.allowedActions).toEqual(['gmailSendMessage'])
  })

  it('returns null when no row exists (the secure default)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getForAssistantSystem('a-1', 'gmail')).toBeNull()
  })
})

describe('[COMP:brain/assistant-connector-grants-store] upsert', () => {
  it('upserts on (assistant_id, connector_id) and records the actor', async () => {
    mockQueryRls.mockResolvedValueOnce({
      rows: [{
        id: 'g-1', assistantId: 'a-1', connectorId: 'gmail',
        readAllowed: true, allowedActions: ['gmailSendMessage'],
        grantedByUserId: 'u-1', grantedAt: new Date(), updatedAt: new Date(),
      }],
      rowCount: 1,
    } as never)
    await store.upsert('u-1', {
      assistantId: 'a-1',
      connectorId: 'gmail',
      readAllowed: true,
      allowedActions: ['gmailSendMessage'],
    })
    const [userId, sql, params] = mockQueryRls.mock.calls[0]
    expect(userId).toBe('u-1')
    expect(sql).toContain('ON CONFLICT (assistant_id, connector_id) DO UPDATE')
    expect(sql).toContain('updated_at = now()')
    // params: [assistantId, connectorId, readAllowed, allowedActions, grantedByUserId]
    expect(params).toEqual(['a-1', 'gmail', true, ['gmailSendMessage'], 'u-1'])
  })
})

describe('[COMP:brain/assistant-connector-grants-store] listForAssistant', () => {
  it('uses queryWithRLS for workspace-scoped reads', async () => {
    mockQueryRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.listForAssistant('u-1', 'a-1')
    const [userId, sql, params] = mockQueryRls.mock.calls[0]
    expect(userId).toBe('u-1')
    expect(sql).toContain('ORDER BY connector_id')
    expect(params).toEqual(['a-1'])
  })
})

describe('[COMP:brain/assistant-connector-grants-store] delete', () => {
  it('returns true when a row was removed', async () => {
    mockQueryRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await store.delete('u-1', 'a-1', 'gmail')).toBe(true)
  })
  it('returns false when no row matched', async () => {
    mockQueryRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.delete('u-1', 'a-1', 'gmail')).toBe(false)
  })
})
