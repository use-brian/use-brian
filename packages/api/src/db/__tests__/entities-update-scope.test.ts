/**
 * [COMP:crm/update] — `updateEntity` write-path access scoping.
 *
 * Regression for the read/write scoping asymmetry (the surviving write
 * sibling of the 2026-07-05 dedupe incident): reads project rows through
 * `buildAccessPredicate`, but `updateEntity` used to write `WHERE id`
 * only — so within a workspace a member could patch another principal's
 * visibility-restricted entity while every read hid it.
 *
 * Mocks the db client and asserts the UPDATE's WHERE carries the viewer
 * projection (full predicate when `access` is passed; user-axis fallback
 * when not) and that a projection miss returns `null` without writing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccessContext } from '@use-brian/core'

const rlsQueries: { userId: string; text: string; values?: unknown[] }[] = []
let rlsRows: Record<string, unknown>[] = []

vi.mock('../client.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryGated: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryWithRLS: vi.fn(async (userId: string, text: string, values?: unknown[]) => {
    rlsQueries.push({ userId, text, values })
    return { rows: rlsRows, rowCount: rlsRows.length }
  }),
  getAppPool: vi.fn(() => {
    throw new Error('app pool unused in this suite')
  }),
  rollbackAndRelease: vi.fn(),
}))

import { updateEntity } from '../entities-store.js'

const CTX: AccessContext = {
  workspaceId: 'ws-1',
  userId: 'u-viewer',
  assistantId: 'a-1',
  assistantKind: 'standard',
}

function entityRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e-1',
    kind: 'person',
    displayName: 'Someone',
    canonicalId: null,
    aliases: [],
    attributes: {},
    sensitivity: 'internal',
    workspaceId: 'ws-1',
    userId: null,
    assistantId: null,
    ...over,
  }
}

beforeEach(() => {
  rlsQueries.length = 0
  rlsRows = []
})

describe('[COMP:crm/update] updateEntity write-path access scoping', () => {
  it('embeds the full access predicate in the UPDATE WHERE when access is passed', async () => {
    rlsRows = [entityRow()]
    const updated = await updateEntity('u-viewer', 'e-1', { displayName: 'New' }, CTX)
    expect(updated?.id).toBe('e-1')

    expect(rlsQueries).toHaveLength(1)
    const q = rlsQueries[0]!
    expect(q.text).toContain('UPDATE entities')
    // displayName is $1, id lands at $2, predicate params follow.
    expect(q.text).toContain('WHERE id = $2')
    expect(q.text).toContain('workspace_id IS NULL OR workspace_id = $3')
    expect(q.text).toContain('user_id IS NULL OR user_id = $4')
    expect(q.text).toContain('assistant_id IS NULL OR assistant_id = $5')
    expect(q.values).toEqual(['New', 'e-1', 'ws-1', 'u-viewer', 'a-1'])
  })

  it('falls back to the user-axis projection when access is absent', async () => {
    rlsRows = [entityRow()]
    await updateEntity('u-viewer', 'e-1', { displayName: 'New' })

    const q = rlsQueries[0]!
    expect(q.text).toContain('WHERE id = $2')
    expect(q.text).toContain('(user_id IS NULL OR user_id = $3)')
    // Fallback guard is user-axis only — no workspace/assistant clauses.
    expect(q.text).not.toContain('workspace_id IS NULL')
    expect(q.text).not.toContain('assistant_id IS NULL')
    expect(q.values).toEqual(['New', 'e-1', 'u-viewer'])
  })

  it('returns null (no write reported) when the projection excludes the row', async () => {
    rlsRows = []
    const updated = await updateEntity('u-viewer', 'e-hidden', { displayName: 'X' }, CTX)
    expect(updated).toBeNull()
  })
})
