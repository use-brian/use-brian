/**
 * Unit tests for the assistant-connector settings store.
 * Component tag: [COMP:api/assistant-connector-store].
 *
 * Mocks `query`. Verifies createDbAssistantConnectorStore: the opt-out
 * default (no row → enabled), the enabled-state upsert, and the
 * explicit-rows-only listing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { createDbAssistantConnectorStore } from '../assistant-connector-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)
const store = createDbAssistantConnectorStore()

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/assistant-connector-store] isEnabled', () => {
  it('returns the stored enabled flag when a row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ enabled: false }], rowCount: 1 } as never)
    expect(await store.isEnabled('a-1', 'gmail')).toBe(false)
  })

  it('defaults to enabled when no row exists (opt-out model)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.isEnabled('a-1', 'gmail')).toBe(true)
  })
})

describe('[COMP:api/assistant-connector-store] setEnabled', () => {
  it('upserts the enabled state on (assistant_id, connector_id)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.setEnabled('a-1', 'gmail', false)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('ON CONFLICT (assistant_id, connector_id) DO UPDATE')
    expect(params).toEqual(['a-1', 'gmail', false])
  })
})

describe('[COMP:api/assistant-connector-store] listForAssistant', () => {
  it('returns only the explicitly-set connector rows', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ connectorId: 'gmail', enabled: false }],
      rowCount: 1,
    } as never)
    const out = await store.listForAssistant('a-1')
    expect(out).toEqual([{ connectorId: 'gmail', enabled: false }])
    expect(mockQuery.mock.calls[0][1]).toEqual(['a-1'])
  })
})
