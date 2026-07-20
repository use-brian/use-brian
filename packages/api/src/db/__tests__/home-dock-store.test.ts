/**
 * Unit tests for the home-dock store.
 * Component tag: [COMP:api/home-dock-store].
 *
 * `get` validates the stored JSONB against the core `homeDockLayoutSchema`
 * and returns null on a legacy / malformed artifact (so the caller falls
 * back to the deterministic dock instead of throwing). `put` upserts on the
 * `workspace_id` primary key. Both run under `queryWithRLS`, so we mock the
 * client and assert the SQL shape + validation branch without a database.
 *
 * Spec: docs/architecture/features/home-dock.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({ queryWithRLS: vi.fn() }))

import { createDbHomeDockStore } from '../home-dock-store.js'
import { queryWithRLS } from '../client.js'
import type { HomeDockLayout } from '@use-brian/core'

const mockQuery = vi.mocked(queryWithRLS)

const VALID_LAYOUT: HomeDockLayout = {
  version: 1,
  note: 'Two things need you this morning.',
  needsYou: [{ kind: 'brain_review', caption: 'Review new facts' }, { kind: 'approvals' }],
  generatedAt: '2026-07-07T08:00:00.000Z',
  generatedByAssistantId: 'a1',
}

const store = createDbHomeDockStore()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/home-dock-store] get', () => {
  it('returns the parsed layout when the stored JSONB is valid', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ layout: VALID_LAYOUT }] } as never)
    const got = await store.get('u1', 'w1')
    expect(got).toEqual(VALID_LAYOUT)
    const [userId, sql, params] = mockQuery.mock.calls[0] as [string, string, unknown[]]
    expect(userId).toBe('u1')
    expect(sql).toContain('FROM home_dock_layouts')
    expect(params).toEqual(['w1'])
  })

  it('returns null when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    expect(await store.get('u1', 'w1')).toBeNull()
  })

  it('returns null when the row is present but the layout is null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ layout: null }] } as never)
    expect(await store.get('u1', 'w1')).toBeNull()
  })

  it('returns null (degrades) when the stored JSONB fails the schema', async () => {
    // A legacy artifact missing `version` / with an unknown card kind.
    mockQuery.mockResolvedValueOnce({
      rows: [{ layout: { note: 'legacy', needsYou: [{ kind: 'nope' }] } }],
    } as never)
    expect(await store.get('u1', 'w1')).toBeNull()
  })
})

describe('[COMP:api/home-dock-store] put', () => {
  it('upserts on workspace_id, threading the assistant + generatedAt', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await store.put('u1', 'w1', VALID_LAYOUT)
    const [userId, sql, params] = mockQuery.mock.calls[0] as [string, string, unknown[]]
    expect(userId).toBe('u1')
    expect(sql).toContain('INSERT INTO home_dock_layouts')
    expect(sql).toContain('ON CONFLICT (workspace_id) DO UPDATE')
    expect(params[0]).toBe('w1')
    // layout is serialized as JSON.
    expect(JSON.parse(params[1] as string)).toEqual(VALID_LAYOUT)
    expect(params[2]).toBe('a1')
    expect(params[3]).toBe('2026-07-07T08:00:00.000Z')
  })
})
