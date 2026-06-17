/**
 * [COMP:api/session-visibility] Session visibility dimension.
 *
 * Unit half — verifies the `visibility` column is threaded through the
 * sessions store: `findOrCreateSession` persists it (defaulting to 'owner',
 * 'workspace' when asked), and the by-id / by-channel reads project it. The
 * RLS *enforcement* (a workspace member reading a teammate's shared session,
 * a non-member being denied) is covered by the sibling
 * `session-visibility.integration.test.ts`, which needs a real Postgres and
 * skips without `DATABASE_URL`.
 *
 * Spec: docs/plans/doc-brain-distillation.md → "Session model — unify
 * doc threads as workspace-shared"; migration 223_session_visibility.sql.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { query } from '../client.js'
import { findOrCreateSession, findSessionById, findSessionByChannel } from '../sessions.js'

const mockQuery = vi.mocked(query)

const A = '00000000-0000-0000-0000-0000000000a1'
const U = '00000000-0000-0000-0000-0000000000a2'

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    assistantId: A,
    userId: U,
    channelType: 'web',
    channelId: 'c-1',
    appId: 'sidanclaw',
    appOrigin: null,
    status: 'idle',
    compactSummary: null,
    compactionCount: 0,
    compactBoundarySequence: null,
    title: null,
    downgradeNoticeSent: false,
    downgradeNoticePinMessageId: null,
    mode: null,
    visibility: 'owner',
    effectiveClearance: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastActiveAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/session-visibility] Session visibility dimension', () => {
  const WS = '00000000-0000-0000-0000-0000000000a3'

  it('findOrCreateSession persists visibility=workspace + workspace_id when asked', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ visibility: 'workspace' })] } as never)

    const session = await findOrCreateSession({
      assistantId: A,
      userId: U,
      channelType: 'doc_thread',
      channelId: 'c-1',
      visibility: 'workspace',
      workspaceId: WS,
      effectiveClearance: 'confidential',
    })

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    // visibility is the 7th INSERT param, workspace_id the 8th, and
    // effective_clearance the 9th (all RLS-support; migrations 223–224).
    expect(sql).toContain('visibility')
    expect(sql).toContain('workspace_id')
    expect(sql).toContain('effective_clearance')
    expect(sql).toContain('$9')
    expect(params[6]).toBe('workspace')
    expect(params[7]).toBe(WS)
    expect(params[8]).toBe('confidential')
    expect(session.visibility).toBe('workspace')
  })

  it('findOrCreateSession defaults visibility=owner + workspace_id/effective_clearance=null when omitted', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] } as never)

    await findOrCreateSession({
      assistantId: A,
      userId: U,
      channelType: 'web',
      channelId: 'c-1',
    })

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(params[6]).toBe('owner')
    expect(params[7]).toBe(null)
    expect(params[8]).toBe(null)
  })

  it('the ON CONFLICT branch does not overwrite visibility', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] } as never)
    await findOrCreateSession({
      assistantId: A,
      userId: U,
      channelType: 'web',
      channelId: 'c-1',
      visibility: 'workspace',
    })
    const [sql] = mockQuery.mock.calls[0] as [string]
    // Inspect only the DO UPDATE SET clause (between DO UPDATE and RETURNING):
    // it touches last_active_at only — never visibility. (RETURNING does
    // project visibility, which is why we don't slice the whole tail.)
    const setClause = sql.slice(sql.indexOf('DO UPDATE'), sql.indexOf('RETURNING'))
    expect(setClause).not.toContain('visibility')
  })

  it('findSessionById projects visibility', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ visibility: 'workspace' })] } as never)
    const session = await findSessionById('sess-1')
    const [sql] = mockQuery.mock.calls[0] as [string]
    expect(sql).toContain('visibility')
    expect(session?.visibility).toBe('workspace')
  })

  it('findSessionByChannel projects visibility', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] } as never)
    const session = await findSessionByChannel({
      assistantId: A,
      userId: U,
      channelType: 'web',
      channelId: 'c-1',
    })
    const [sql] = mockQuery.mock.calls[0] as [string]
    expect(sql).toContain('visibility')
    expect(session?.visibility).toBe('owner')
  })
})
