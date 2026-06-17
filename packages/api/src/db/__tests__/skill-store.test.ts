/**
 * Unit tests for the workspace-skill store.
 * Component tag: [COMP:api/skill-store].
 *
 * Mocks `query` / `queryWithRLS`. Verifies:
 *   * The canonical `createDbWorkspaceSkillStore()` — workspace-scoped CRUD,
 *     V2 columns surface (`write_origin`, `state`, `pinned`, lease, CL-8
 *     counters), curator queries, absorption chain resolution.
 *   * The legacy `createDbSkillStore()` shim — userId-keyed methods resolve
 *     the user's primary workspace and forward.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbSkillStore, createDbWorkspaceSkillStore } from '../skill-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)

function skillRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sk-uuid-1',
    workspace_id: 'ws-1',
    slug: 'my-skill',
    name: 'My Skill',
    description: 'Does things',
    when_to_use: 'when needed',
    content: 'Step 1.',
    category: 'custom',
    requires_connectors: [],
    source: 'user',
    author_id: 'u-1',
    published: false,
    write_origin: 'foreground',
    state: 'active',
    state_transitioned_at: new Date('2026-01-01'),
    last_invoked_at: null,
    pinned: false,
    pinned_at: null,
    originating_assistant_id: null,
    auto_generated_at: null,
    acknowledged_at: null,
    absorbed_into: null,
    absorbed_at: null,
    last_patch_diff: null,
    last_patch_diff_at: null,
    review_lease_held_by: null,
    review_lease_until: null,
    invocations: 0,
    succeeded: 0,
    user_corrected_after: 0,
    valid_from: new Date('2026-01-01'),
    valid_to: null,
    superseded_by: null,
    ...over,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockRls.mockReset()
})

// ── Canonical WorkspaceSkillStore ──────────────────────────────────

describe('[COMP:api/skill-store] WorkspaceSkillStore — workspace CRUD', () => {
  const ws = createDbWorkspaceSkillStore()

  it('listForWorkspace uses system bypass without actingUserId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [skillRow()], rowCount: 1 } as never)
    const out = await ws.listForWorkspace('ws-1')
    expect(out[0].id).toBe('my-skill') // public id == slug
    expect(out[0].workspaceId).toBe('ws-1')
    expect(mockQuery.mock.calls[0][0]).toContain('WHERE workspace_id = $1')
    expect(mockQuery.mock.calls[0][0]).toContain('valid_to IS NULL')
  })

  it('listForWorkspace uses RLS when actingUserId is provided', async () => {
    mockRls.mockResolvedValueOnce({ rows: [skillRow()], rowCount: 1 } as never)
    await ws.listForWorkspace('ws-1', { actingUserId: 'u-1' })
    expect(mockRls.mock.calls[0][0]).toBe('u-1')
  })

  it('create defaults source to "user" and write_origin to "foreground"', async () => {
    mockRls.mockResolvedValueOnce({ rows: [skillRow()], rowCount: 1 } as never)
    await ws.create('u-1', 'ws-1', {
      slug: 'my-skill',
      name: 'My Skill',
      description: 'd',
      content: 'c',
    })
    const params = mockRls.mock.calls[0][2]
    expect(params?.[7]).toBe('user') // source
    expect(params?.[9]).toBe('ws-1') // workspace_id
    expect(params?.[10]).toBe('foreground') // write_origin
  })

  it('create with source=auto-generated flips write_origin and stamps auto_generated_at', async () => {
    mockRls.mockResolvedValueOnce({
      rows: [skillRow({ source: 'auto-generated', write_origin: 'background_review' })],
      rowCount: 1,
    } as never)
    await ws.create('u-1', 'ws-1', {
      slug: 'auto',
      name: 'Auto',
      description: 'd',
      content: 'c',
      source: 'auto-generated',
      originatingAssistantId: 'a-1',
    })
    const params = mockRls.mock.calls[0][2]
    expect(params?.[7]).toBe('auto-generated')
    expect(params?.[10]).toBe('background_review')
    expect(params?.[11]).toBe('a-1') // originating_assistant_id
    expect(params?.[12]).toBeInstanceOf(Date) // auto_generated_at
  })

  it('update returns null without querying when no fields supplied', async () => {
    expect(await ws.update('u-1', 'ws-1', 'sk-1', {})).toBeNull()
    expect(mockRls).not.toHaveBeenCalled()
  })

  it('update keys WHERE on id + workspace_id and forces write_origin=foreground', async () => {
    mockRls.mockResolvedValueOnce({
      rows: [skillRow({ name: 'Renamed' })],
      rowCount: 1,
    } as never)
    const out = await ws.update('u-1', 'ws-1', 'sk-uuid-1', { name: 'Renamed', content: 'new' })
    expect(out?.name).toBe('Renamed')
    const sql = mockRls.mock.calls[0][1] as string
    expect(sql).toContain('name = $1')
    expect(sql).toContain('content = $2')
    expect(sql).toContain('workspace_id = $')
    expect(sql).toContain("write_origin = 'foreground'")
  })

  it('delete is a bi-temporal close (UPDATE, not DELETE)', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await ws.delete('u-1', 'ws-1', 'sk-1')).toBe(true)
    const sql = mockRls.mock.calls[0][1] as string
    expect(sql).toContain('UPDATE workspace_skills')
    expect(sql).toContain('valid_to = now()')
    expect(sql).toContain("state = 'archived'")
  })

  it('getBySlug filters by workspace_id and slug', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [skillRow()], rowCount: 1 } as never)
    const out = await ws.getBySlug('ws-1', 'my-skill')
    expect(out?.id).toBe('my-skill')
    expect(mockQuery.mock.calls[0][1]).toEqual(['ws-1', 'my-skill'])
  })

  it('getByIdSystem returns the full WorkspaceSkill row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [skillRow({ invocations: 3, write_origin: 'background_review' })],
      rowCount: 1,
    } as never)
    const out = await ws.getByIdSystem('sk-uuid-1')
    expect(out?.invocations).toBe(3)
    expect(out?.writeOrigin).toBe('background_review')
  })
})

describe('[COMP:api/skill-store] WorkspaceSkillStore — onWritten hook', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockRls.mockReset()
  })

  it('fires onWritten with the written skill on create', async () => {
    const onWritten = vi.fn()
    const ws = createDbWorkspaceSkillStore({ onWritten })
    mockRls.mockResolvedValueOnce({ rows: [skillRow()], rowCount: 1 } as never)
    await ws.create('u-1', 'ws-1', { slug: 'my-skill', name: 'My Skill', description: 'd', content: 'c' })
    expect(onWritten).toHaveBeenCalledTimes(1)
    expect(onWritten.mock.calls[0][0]).toMatchObject({ rowId: 'sk-uuid-1', workspaceId: 'ws-1' })
  })

  it('fires onWritten on update', async () => {
    const onWritten = vi.fn()
    const ws = createDbWorkspaceSkillStore({ onWritten })
    mockRls.mockResolvedValueOnce({ rows: [skillRow({ name: 'Renamed' })], rowCount: 1 } as never)
    await ws.update('u-1', 'ws-1', 'sk-uuid-1', { name: 'Renamed' })
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('does not fire onWritten when update matched no row', async () => {
    const onWritten = vi.fn()
    const ws = createDbWorkspaceSkillStore({ onWritten })
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await ws.update('u-1', 'ws-1', 'sk-uuid-1', { name: 'X' })).toBeNull()
    expect(onWritten).not.toHaveBeenCalled()
  })

  it('a throwing onWritten never breaks the create', async () => {
    const onWritten = vi.fn(() => {
      throw new Error('hook boom')
    })
    const ws = createDbWorkspaceSkillStore({ onWritten })
    mockRls.mockResolvedValueOnce({ rows: [skillRow()], rowCount: 1 } as never)
    const out = await ws.create('u-1', 'ws-1', { slug: 's', name: 'n', description: 'd', content: 'c' })
    expect(out.rowId).toBe('sk-uuid-1')
    expect(onWritten).toHaveBeenCalled()
  })
})

describe('[COMP:api/skill-store] WorkspaceSkillStore — community catalog', () => {
  const ws = createDbWorkspaceSkillStore()

  it('listPublished surfaces published rows as SkillMeta', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [skillRow({ published: true, source: 'community' })],
      rowCount: 1,
    } as never)
    const out = await ws.listPublished()
    expect(out[0].id).toBe('my-skill')
    expect(mockQuery.mock.calls[0][0]).toContain('published = true')
  })

  it('publish keys UPDATE on id + workspace_id', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await ws.publish('u-1', 'ws-1', 'sk-1')).toBe(true)
    expect(mockRls.mock.calls[0][2]).toEqual(['sk-1', 'ws-1'])
  })

  it('unpublish flips source back to user', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await ws.unpublish('u-1', 'ws-1', 'sk-1')
    expect(mockRls.mock.calls[0][1]).toContain("source = 'user'")
  })
})

describe('[COMP:api/skill-store] WorkspaceSkillStore — V2 lifecycle (S12 / S13)', () => {
  const ws = createDbWorkspaceSkillStore()

  it('setState writes the state column system-level', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await ws.setState('sk-1', 'stale')
    expect(mockQuery.mock.calls[0][1]).toEqual(['stale', 'sk-1'])
  })

  it('recordInvocation reactivates stale → active synchronously', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await ws.recordInvocation('sk-1')
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('invocations = invocations + 1')
    expect(sql).toContain('last_invoked_at = now()')
    expect(sql).toContain("WHEN state = 'stale' THEN 'active'")
  })

  it('setPinned flips pinned + auto-restores archived rows (S13 invariant 3)', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await ws.setPinned('u-1', 'ws-1', 'sk-1', true)
    const sql = mockRls.mock.calls[0][1] as string
    expect(sql).toContain('pinned = $1')
    expect(sql).toContain("WHEN $1 AND state = 'archived' THEN 'active'")
  })

  it('markUserVerified flips write_origin to foreground', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await ws.markUserVerified('u-1', 'ws-1', 'sk-1')
    expect(mockRls.mock.calls[0][1]).toContain("write_origin = 'foreground'")
  })
})

describe('[COMP:api/skill-store] WorkspaceSkillStore — S10 review lease', () => {
  const ws = createDbWorkspaceSkillStore()

  it('acquireReviewLease succeeds when no live holder exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sk-1' }], rowCount: 1 } as never)
    expect(await ws.acquireReviewLease('sk-1', 'curator-A', 30)).toBe(true)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('review_lease_held_by IS NULL')
    expect(sql).toContain('review_lease_until <= now()')
  })

  it('acquireReviewLease returns false when contested', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await ws.acquireReviewLease('sk-1', 'curator-B', 30)).toBe(false)
  })

  it('releaseReviewLease keys on holder id (no-op for other holders)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await ws.releaseReviewLease('sk-1', 'curator-A')
    expect(mockQuery.mock.calls[0][1]).toEqual(['sk-1', 'curator-A'])
  })

  it('listCuratorEligible filters background_review + non-pinned + (active|stale)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await ws.listCuratorEligible('ws-1')
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain("write_origin = 'background_review'")
    expect(sql).toContain('pinned = false')
    expect(sql).toContain("state IN ('active', 'stale')")
  })
})

describe('[COMP:api/skill-store] WorkspaceSkillStore — S15 absorption', () => {
  const ws = createDbWorkspaceSkillStore()

  it('resolveAbsorption walks the chain to a non-archived row', async () => {
    // A archived → B; B archived → C; C active.
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ absorbed_into: 'sk-B', state: 'archived' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ absorbed_into: 'sk-C', state: 'archived' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ absorbed_into: null, state: 'active' }],
        rowCount: 1,
      } as never)
    const out = await ws.resolveAbsorption('sk-A')
    expect(out.resolvedId).toBe('sk-C')
    expect(out.hops).toBe(2)
    expect(out.chainTooLong).toBe(false)
  })

  it('resolveAbsorption stops on a non-archived row even with absorbed_into set', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ absorbed_into: 'sk-B', state: 'active' }],
      rowCount: 1,
    } as never)
    const out = await ws.resolveAbsorption('sk-A')
    expect(out.resolvedId).toBe('sk-A')
    expect(out.hops).toBe(0)
  })

  it('resolveAbsorption flags chainTooLong at the cap', async () => {
    // Every fetch points to the next archived row — synthetic infinite chain.
    mockQuery.mockImplementation(async () => ({
      rows: [{ absorbed_into: 'sk-next', state: 'archived' }],
      rowCount: 1,
    } as never))
    const out = await ws.resolveAbsorption('sk-A', 3)
    expect(out.chainTooLong).toBe(true)
    expect(out.hops).toBe(3)
  })
})

describe('[COMP:api/skill-store] WorkspaceSkillStore — CL-8 counters', () => {
  const ws = createDbWorkspaceSkillStore()

  it('incrementSucceeded bumps the column', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await ws.incrementSucceeded('sk-1')
    expect(mockQuery.mock.calls[0][0]).toContain('succeeded = succeeded + 1')
  })

  it('incrementUserCorrectedAfter bumps the column', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await ws.incrementUserCorrectedAfter('sk-1')
    expect(mockQuery.mock.calls[0][0]).toContain('user_corrected_after = user_corrected_after + 1')
  })
})

// ── Legacy back-compat shim ────────────────────────────────────────

describe('[COMP:api/skill-store] legacy SkillStore — userId resolution', () => {
  const store = createDbSkillStore()

  function mockWorkspaceLookup(workspaceId = 'ws-1') {
    mockRls.mockResolvedValueOnce({
      rows: [{ workspace_id: workspaceId }],
      rowCount: 1,
    } as never)
  }

  it('listOwned resolves the primary workspace then filters by author_id', async () => {
    mockWorkspaceLookup()
    mockRls.mockResolvedValueOnce({ rows: [skillRow()], rowCount: 1 } as never)
    const out = await store.listOwned('u-1')
    expect(out[0].id).toBe('my-skill')
    // First RLS call resolves workspace, second is the actual list query.
    expect(mockRls.mock.calls[0][1]).toContain('workspace_members')
    expect(mockRls.mock.calls[1][1]).toContain('author_id')
  })

  it('listForWorkspaceContent pins the GIVEN workspace, no author filter, no primary-workspace resolution (leak fix 2026-06-01)', async () => {
    mockRls.mockResolvedValueOnce({ rows: [skillRow()], rowCount: 1 } as never)
    const out = await store.listForWorkspaceContent('ws-shared', 'acting-member')
    expect(out[0].id).toBe('my-skill')
    // Exactly one query — it does NOT resolve the caller's primary workspace.
    expect(mockRls.mock.calls.length).toBe(1)
    // RLS principal is the passed acting member.
    expect(mockRls.mock.calls[0][0]).toBe('acting-member')
    // Pins the given workspace; must NOT filter by author_id (that was the leak:
    // listOwned scoped to the owner's personal workspace + author).
    expect(mockRls.mock.calls[0][1]).toContain('workspace_id = $1')
    expect(mockRls.mock.calls[0][1]).not.toContain('author_id')
    expect(mockRls.mock.calls[0][2]).toEqual(['ws-shared'])
  })

  it('create resolves the workspace then forwards', async () => {
    mockWorkspaceLookup('ws-99')
    mockRls.mockResolvedValueOnce({
      rows: [skillRow({ workspace_id: 'ws-99' })],
      rowCount: 1,
    } as never)
    await store.create('u-1', { slug: 'foo', name: 'Foo', description: 'd', content: 'c' })
    const insertParams = mockRls.mock.calls[1][2]
    expect(insertParams?.[9]).toBe('ws-99') // workspace_id
  })

  it('update returns null when no fields supplied (short-circuits before any query)', async () => {
    mockWorkspaceLookup()
    expect(await store.update('u-1', 'sk-1', {})).toBeNull()
    // Only the workspace lookup ran — no UPDATE attempted.
    expect(mockRls.mock.calls.length).toBe(1)
  })

  it('delete forwards to the bi-temporal close', async () => {
    mockWorkspaceLookup()
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await store.delete('u-1', 'sk-1')).toBe(true)
    expect(mockRls.mock.calls[1][1]).toContain("state = 'archived'")
  })

  it('publish forwards to the new workspace-scoped UPDATE', async () => {
    mockWorkspaceLookup()
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await store.publish('u-1', 'sk-1')).toBe(true)
    mockWorkspaceLookup()
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.unpublish('u-1', 'ghost')).toBe(false)
  })

  it('getBySlug scans across workspaces, surfacing published rows first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [skillRow()], rowCount: 1 } as never)
    const out = await store.getBySlug('my-skill')
    expect(out?.id).toBe('my-skill')
    expect(mockQuery.mock.calls[0][0]).toContain('ORDER BY published DESC')
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getBySlug('ghost')).toBeNull()
  })

  it('legacy per-assistant settings + stars still use the assistant_skill_settings + user_skill_stars tables', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ skillId: 'sk-1', enabled: false }],
      rowCount: 1,
    } as never)
    expect(await store.listForAssistant('a-1')).toEqual([{ skillId: 'sk-1', enabled: false }])

    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.setEnabled('a-1', 'sk-1', true)
    expect(mockQuery.mock.calls[1][0]).toContain(
      'ON CONFLICT (assistant_id, skill_id) DO UPDATE',
    )

    mockRls.mockResolvedValueOnce({
      rows: [{ skill_id: 'sk-1' }, { skill_id: 'sk-2' }],
      rowCount: 2,
    } as never)
    expect(await store.listStarred('u-1')).toEqual(['sk-1', 'sk-2'])

    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.star('u-1', 'sk-1')
    expect(mockRls.mock.calls[1][1]).toContain('ON CONFLICT (user_id, skill_id) DO NOTHING')
  })
})
