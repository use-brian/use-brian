/**
 * Unit tests for the skill edge recompute service.
 * Component tag: [COMP:api/skill-edge-service].
 *
 * Mocks `query` (used for reference-target resolution + workspace-member
 * actor fallback) and passes fake stores. Verifies the `onWritten` adapter:
 *   * calls recomputeSkillEdges with mapped connectors + resolved references,
 *     then setInheritedSensitivity with the inherited value;
 *   * resolves the RLS actor from skill.authorId, falling back to a workspace
 *     member when the author is null (auto-induced skill);
 *   * skips edge recompute (no throw) when no workspace member is found.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { makeSkillEdgeRecomputer } from '../skill-edge-service.js'
import { query } from '../client.js'
import type { WorkspaceSkill } from '../skill-store.js'

const mockQuery = vi.mocked(query)

const ENTITY_ID = '11111111-1111-4111-8111-111111111111'

function skill(over: Partial<WorkspaceSkill> = {}): WorkspaceSkill {
  return {
    rowId: 'skill-1',
    id: 'my-skill',
    workspaceId: 'ws-1',
    slug: 'my-skill',
    name: 'My Skill',
    description: 'd',
    content: `Email [[entity:${ENTITY_ID}]] via gmail`,
    category: 'custom',
    requiresConnectors: ['gmail'],
    source: 'user',
    authorId: 'user-1',
    published: false,
    writeOrigin: 'foreground',
    state: 'active',
    stateTransitionedAt: new Date(),
    pinned: false,
    invocations: 0,
    succeeded: 0,
    userCorrectedAfter: 0,
    validFrom: new Date(),
    confidence: 1,
    rederivationCount: 0,
    inductionSource: 'authored',
    sensitivity: 'internal',
    sensitivityOverridden: false,
    ...over,
  }
}

function makeEntityLinks() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'edge-new' }),
    walkOutbound: vi.fn().mockResolvedValue([]),
    closeAt: vi.fn().mockResolvedValue({ id: 'closed' }),
    getById: vi.fn(),
    walkInbound: vi.fn(),
    countForEntity: vi.fn(),
    listForWorkspace: vi.fn(),
    retract: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function makeConnectorStore(instances: Array<{ id: string; provider: string }>) {
  return {
    listByWorkspaceSystem: vi.fn().mockResolvedValue(
      instances.map((i) => ({ id: i.id, provider: i.provider })),
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function makeSkillStore() {
  return {
    setInheritedSensitivity: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('[COMP:api/skill-edge-service] makeSkillEdgeRecomputer', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('recomputes edges and applies inherited sensitivity (author as RLS actor)', async () => {
    // resolveReferenceTargets: entities lookup returns the referenced entity as
    // confidential; memories + kb_chunks return empty.
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM entities')) {
        return { rows: [{ id: ENTITY_ID, sensitivity: 'confidential' }], rowCount: 1 } as never
      }
      return { rows: [], rowCount: 0 } as never
    })

    const entityLinks = makeEntityLinks()
    const connectorInstanceStore = makeConnectorStore([
      { id: 'conn-gmail', provider: 'gmail' },
      { id: 'conn-slack', provider: 'slack' },
    ])
    const workspaceSkillStore = makeSkillStore()

    const recompute = makeSkillEdgeRecomputer({
      entityLinks,
      connectorInstanceStore,
      workspaceSkillStore,
    })
    await recompute(skill())

    // Author was used as the RLS actor → no workspace_members fallback query.
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM workspace_members'),
      expect.anything(),
    )
    // Two edges created: references_entity + requires_connector(gmail only).
    expect(entityLinks.create).toHaveBeenCalledTimes(2)
    const edgeTypes = entityLinks.create.mock.calls
      .map((c: unknown[]) => (c[0] as { edgeType: string }).edgeType)
      .sort()
    expect(edgeTypes).toEqual(['references_entity', 'requires_connector'])
    // Inherited sensitivity (max of references) applied to the skill row.
    expect(workspaceSkillStore.setInheritedSensitivity).toHaveBeenCalledWith(
      'skill-1',
      'confidential',
    )
  })

  it('falls back to a workspace member when the skill has no author', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM workspace_members')) {
        return { rows: [{ user_id: 'member-9' }], rowCount: 1 } as never
      }
      return { rows: [], rowCount: 0 } as never
    })

    const entityLinks = makeEntityLinks()
    const connectorInstanceStore = makeConnectorStore([])
    const workspaceSkillStore = makeSkillStore()

    const recompute = makeSkillEdgeRecomputer({
      entityLinks,
      connectorInstanceStore,
      workspaceSkillStore,
    })
    await recompute(skill({ authorId: undefined, content: 'no refs', requiresConnectors: [] }))

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM workspace_members'),
      ['ws-1'],
    )
    // walkOutbound (the existing-edge read) runs under the resolved member actor.
    expect(entityLinks.walkOutbound).toHaveBeenCalled()
    const ctx = entityLinks.walkOutbound.mock.calls[0][0] as { userId: string }
    expect(ctx.userId).toBe('member-9')
    // No references / connectors → no edges, but sensitivity still refreshed.
    expect(workspaceSkillStore.setInheritedSensitivity).toHaveBeenCalledWith('skill-1', 'internal')
  })

  it('skips edge recompute (no throw) when no workspace member can be resolved', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)

    const entityLinks = makeEntityLinks()
    const connectorInstanceStore = makeConnectorStore([])
    const workspaceSkillStore = makeSkillStore()

    const recompute = makeSkillEdgeRecomputer({
      entityLinks,
      connectorInstanceStore,
      workspaceSkillStore,
    })
    await expect(recompute(skill({ authorId: undefined }))).resolves.toBeUndefined()
    expect(entityLinks.walkOutbound).not.toHaveBeenCalled()
    expect(entityLinks.create).not.toHaveBeenCalled()
    expect(workspaceSkillStore.setInheritedSensitivity).not.toHaveBeenCalled()
  })
})
