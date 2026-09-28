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
const patchMock = vi.fn(async (..._args: unknown[]) => undefined)
const supportFileMock = vi.fn(async (..._args: unknown[]) => undefined)
const createMock = vi.fn(async (..._args: unknown[]) => ({ rowId: 'new-row', slug: 'weekly-report' }))
const deprecateMock = vi.fn(async (..._args: unknown[]) => undefined)
vi.mock('../../db/client.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}))
vi.mock('../../db/skill-derived-store.js', () => ({
  applyDerivedSkillPatch: (...args: unknown[]) => patchMock(...args),
  applyDerivedSkillSupportFile: (...args: unknown[]) => supportFileMock(...args),
  createDerivedWorkspaceSkill: (...args: unknown[]) => createMock(...args),
  softDeprecateScopedSkill: (...args: unknown[]) => deprecateMock(...args),
}))

const source = {
  resourceKind: 'session_message',
  resourceId: 'message-1',
  version: '1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  assistantId: 'assistant-1',
  sensitivity: 'internal' as const,
  compartments: [],
  projectIds: [],
}

const derivation = { producer: 'skill:umbrella', sources: [source] }

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
  patchMock.mockClear()
  supportFileMock.mockClear()
  createMock.mockClear()
  createMock.mockResolvedValue({ rowId: 'new-row', slug: 'weekly-report' })
  deprecateMock.mockClear()
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

  it('patchUmbrella delegates the complete derivation to the scoped writer', async () => {
    const scope = buildWorkspaceCuratorScope(makeDeps().deps)
    await scope.umbrellaStore.patchUmbrella('s1', { content: 'NEW', diff: 'd', derivation })
    expect(patchMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      skillId: 's1',
      content: 'NEW',
      diff: 'd',
      evidence: derivation,
    })
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
      derivation,
    })
    expect(out).toEqual({ rowId: 'new-row' })
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      slug: 'weekly-report',
      source: 'auto-generated',
      writeOrigin: 'background_review',
      originatingAssistantId: 'a1',
      evidence: derivation,
    }))
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
      derivation,
    })
    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
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
      derivation,
    })
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('addSupportFile upserts on the (skill,kind,name) unique key', async () => {
    const scope = buildWorkspaceCuratorScope(makeDeps().deps)
    await scope.umbrellaStore.addSupportFile({
      umbrellaRowId: 's1',
      kind: 'template',
      name: 'weekly.md',
      content: 'body',
      derivation,
    })
    expect(supportFileMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      skillId: 's1',
      kind: 'template',
      name: 'weekly.md',
      content: 'body',
      description: undefined,
      evidence: derivation,
    })
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
    await scope.decayStore.softDeprecate('s1', 'inactive_30d' as never, source)
    expect(deprecateMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      skillId: 's1',
      source,
    })
  })
})
