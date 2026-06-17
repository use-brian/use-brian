/**
 * Unit tests for the workspace curator scope adapter.
 *
 * The adapter feeds the consolidation worker's weekly skill-hygiene passes
 * (S10 umbrella absorption + CL-8 decay). Reads delegate to the canonical
 * WorkspaceSkillStore; the mutations no shared store method exposes
 * (patchUmbrella / createUmbrella / addSupportFile / recordAbsorption /
 * softDeprecate) run as system-level `query()` writes. These tests mock
 * `query` and assert each mutation fires the expected statement, plus the
 * read delegation + workspace enumeration.
 *
 * Spec: `docs/architecture/engine/skill-system.md` → "Auto-generation (V2)"
 *   (umbrella absorption, decay, the workspace curator pass).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildWorkspaceCuratorScope } from '../workspace-curator-scope.js'

const queryMock = vi.fn(async (..._args: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 }))
vi.mock('../../db/client.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}))

function makeDeps() {
  const listCuratorEligible = vi.fn(async () => [{ rowId: 's1', id: 'slug-1' }] as never)
  return {
    listCuratorEligible,
    deps: {
      workspaceSkillStore: { listCuratorEligible } as never,
      digestStore: { append: vi.fn(), listForWorkspace: vi.fn(), getLatest: vi.fn() } as never,
      getEmbeddings: vi.fn(async () => [[0.1, 0.2]]),
    },
  }
}

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
})

describe('[COMP:workers/workspace-curator-scope] buildWorkspaceCuratorScope', () => {
  it('listWorkspaces maps id/created_at into the scope shape', async () => {
    const { deps } = makeDeps()
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'ws-1', created_at: new Date('2026-01-01') }],
      rowCount: 1,
    })
    const scope = buildWorkspaceCuratorScope(deps)
    const out = await scope.listWorkspaces()
    expect(out).toEqual([{ workspaceId: 'ws-1', createdAt: new Date('2026-01-01') }])
  })

  it('umbrella + decay listCuratorEligible delegate to the WorkspaceSkillStore', async () => {
    const { deps, listCuratorEligible } = makeDeps()
    const scope = buildWorkspaceCuratorScope(deps)
    await scope.umbrellaStore.listCuratorEligible('ws-1')
    await scope.decayStore.listCuratorEligible('ws-1')
    expect(listCuratorEligible).toHaveBeenCalledTimes(2)
    expect(listCuratorEligible).toHaveBeenCalledWith('ws-1')
  })

  it('patchUmbrella issues a content UPDATE gated on valid_to IS NULL', async () => {
    const scope = buildWorkspaceCuratorScope(makeDeps().deps)
    await scope.umbrellaStore.patchUmbrella('s1', { content: 'NEW', diff: 'd' })
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/UPDATE workspace_skills/)
    expect(sql).toMatch(/SET content = \$1/)
    expect(sql).toMatch(/valid_to IS NULL/)
    expect(params).toEqual(['NEW', 'd', 's1'])
  })

  it('createUmbrella inserts an auto-generated, background_review row and returns its id', async () => {
    const scope = buildWorkspaceCuratorScope(makeDeps().deps)
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'new-row' }], rowCount: 1 })
    const out = await scope.umbrellaStore.createUmbrella('ws-1', {
      slug: 'weekly-report',
      name: 'Weekly report',
      description: 'd',
      content: '# body',
      originatingAssistantId: 'a1',
    })
    expect(out).toEqual({ rowId: 'new-row' })
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO workspace_skills/)
    expect(sql).toMatch(/'auto-generated'/)
    expect(sql).toMatch(/'background_review'/)
    expect(params).toContain('weekly-report')
    expect(params).toContain('ws-1')
    expect(params).toContain('a1')
  })

  it('createUmbrella seeds the proposer enablement row (enabled_by NULL = system-seeded)', async () => {
    // The allowlist is the single source of truth for offering scope (mig
    // 264); without the seed a new suggested umbrella is offered to nobody.
    const scope = buildWorkspaceCuratorScope(makeDeps().deps)
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'new-row' }], rowCount: 1 })
    await scope.umbrellaStore.createUmbrella('ws-1', {
      slug: 'weekly-report',
      name: 'Weekly report',
      description: 'd',
      content: '# body',
      originatingAssistantId: 'a1',
    })
    expect(queryMock).toHaveBeenCalledTimes(2)
    const [sql, params] = queryMock.mock.calls[1] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO workspace_skill_enablement/)
    expect(sql).toMatch(/VALUES \(\$1, \$2, NULL\)/)
    expect(sql).toMatch(/ON CONFLICT \(workspace_skill_id, assistant_id\) DO NOTHING/)
    expect(params).toEqual(['new-row', 'a1'])
  })

  it('createUmbrella skips the enablement seed when no originating assistant is known', async () => {
    const scope = buildWorkspaceCuratorScope(makeDeps().deps)
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'new-row' }], rowCount: 1 })
    await scope.umbrellaStore.createUmbrella('ws-1', {
      slug: 'weekly-report',
      name: 'Weekly report',
      description: 'd',
      content: '# body',
    })
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('addSupportFile upserts on the (skill,kind,name) unique key', async () => {
    const scope = buildWorkspaceCuratorScope(makeDeps().deps)
    await scope.umbrellaStore.addSupportFile({
      umbrellaRowId: 's1',
      kind: 'template',
      name: 'weekly.md',
      content: 'body',
    })
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO workspace_skill_files/)
    expect(sql).toMatch(/ON CONFLICT \(workspace_skill_id, kind, name\) DO UPDATE/)
    expect(params).toEqual(['s1', 'template', 'weekly.md', 'body', null])
  })

  it('recordAbsorption archives the member with absorbed_into metadata', async () => {
    const scope = buildWorkspaceCuratorScope(makeDeps().deps)
    await scope.umbrellaStore.recordAbsorption('member-1', 'umbrella-1')
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/SET state = 'archived'/)
    expect(sql).toMatch(/absorbed_into = \$2/)
    expect(params).toEqual(['member-1', 'umbrella-1'])
  })

  it('softDeprecate bi-temporally closes the row (valid_to = now)', async () => {
    const scope = buildWorkspaceCuratorScope(makeDeps().deps)
    await scope.decayStore.softDeprecate('s1', 'inactive_30d' as never)
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/SET\s+valid_to = now\(\)/)
    expect(sql).toMatch(/valid_to IS NULL/)
    expect(params).toEqual(['s1'])
  })
})
