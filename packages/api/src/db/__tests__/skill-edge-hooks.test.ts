import { describe, it, expect, vi } from 'vitest'
import { recomputeSkillEdges } from '../skill-edge-hooks.js'

const E = '11111111-1111-4111-8111-111111111111'

function makeEntityLinks(existing: Array<Record<string, unknown>> = []) {
  return {
    create: vi.fn().mockResolvedValue({ id: 'new-edge' }),
    walkOutbound: vi.fn().mockResolvedValue(existing),
    closeAt: vi.fn().mockResolvedValue({ id: 'closed' }),
    // unused by recomputeSkillEdges
    getById: vi.fn(),
    walkInbound: vi.fn(),
    countForEntity: vi.fn(),
    listForWorkspace: vi.fn(),
    retract: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('[COMP:api/skill-edge-hooks] recomputeSkillEdges', () => {
  it('creates references_entity + requires_connector edges and inherits max sensitivity', async () => {
    const entityLinks = makeEntityLinks([])
    const res = await recomputeSkillEdges(
      {
        entityLinks,
        listConnectors: async () => [
          { id: 'conn-gmail', provider: 'gmail' },
          { id: 'conn-slack', provider: 'slack' },
        ],
        resolveReferenceTargets: async () => [{ kind: 'entity', id: E, sensitivity: 'confidential' }],
      },
      {
        skillRowId: 'skill-1',
        workspaceId: 'ws-1',
        content: `Email [[entity:${E}]] using gmail`,
        requiresConnectors: ['gmail'],
        actorUserId: 'user-1',
        source: 'user',
      },
    )
    expect(res.created).toBe(2)
    expect(res.closed).toBe(0)
    expect(res.inheritedSensitivity).toBe('confidential')
    const edgeTypes = entityLinks.create.mock.calls.map((c: unknown[]) => (c[0] as { edgeType: string }).edgeType).sort()
    expect(edgeTypes).toEqual(['references_entity', 'requires_connector'])
    // only the requested provider (gmail) is wired, not slack
    const connectorTargets = entityLinks.create.mock.calls
      .map((c: unknown[]) => c[0] as { edgeType: string; targetId: string })
      .filter((p: { edgeType: string; targetId: string }) => p.edgeType === 'requires_connector')
    expect(connectorTargets).toEqual([expect.objectContaining({ targetId: 'conn-gmail' })])
  })

  it('closes edges no longer desired (self-heal) and is idempotent for kept edges', async () => {
    const existing = [
      { id: 'e-keep', edgeType: 'references_entity', targetKind: 'entity', targetId: E },
      { id: 'e-stale', edgeType: 'requires_connector', targetKind: 'connector', targetId: 'old-conn' },
    ]
    const entityLinks = makeEntityLinks(existing)
    const res = await recomputeSkillEdges(
      {
        entityLinks,
        listConnectors: async () => [],
        resolveReferenceTargets: async () => [{ kind: 'entity', id: E, sensitivity: 'internal' }],
      },
      {
        skillRowId: 'skill-1',
        workspaceId: 'ws-1',
        content: `[[entity:${E}]]`,
        requiresConnectors: [],
        actorUserId: 'user-1',
        source: 'user',
      },
    )
    expect(res.created).toBe(0)
    expect(res.closed).toBe(1)
    expect(entityLinks.closeAt).toHaveBeenCalledWith('user-1', 'e-stale', expect.any(Date))
    expect(entityLinks.create).not.toHaveBeenCalled()
  })

  it('defaults inherited sensitivity to internal when there are no references', async () => {
    const entityLinks = makeEntityLinks([])
    const res = await recomputeSkillEdges(
      { entityLinks, listConnectors: async () => [], resolveReferenceTargets: async () => [] },
      {
        skillRowId: 's',
        workspaceId: 'w',
        content: 'no refs here',
        requiresConnectors: [],
        actorUserId: 'u',
        source: 'user',
      },
    )
    expect(res.inheritedSensitivity).toBe('internal')
    expect(res.created).toBe(0)
    expect(entityLinks.create).not.toHaveBeenCalled()
  })

  it('materializes bundle containment, cross-skill use, and resource references', async () => {
    const entityLinks = makeEntityLinks([])
    const res = await recomputeSkillEdges(
      {
        entityLinks,
        listConnectors: async () => [],
        resolveReferenceTargets: async (_workspaceId, refs) =>
          refs.entity.includes(E)
            ? [{ kind: 'entity', id: E, sensitivity: 'confidential' }]
            : [],
        resolveSkillTargets: async () => [{ id: 'skill-sales', slug: 'consult-sales' }],
      },
      {
        skillRowId: 'skill-finance',
        workspaceId: 'ws-1',
        content: 'Coordinate with [sales](../consult-sales/SKILL.md).',
        requiresConnectors: [],
        resources: [
          {
            id: 'file-statement',
            path: 'references/statement-analysis.md',
            content: `Use the account for [[entity:${E}]].`,
          },
        ],
        actorUserId: 'user-1',
        source: 'user',
      },
    )

    expect(res.created).toBe(3)
    expect(res.inheritedSensitivity).toBe('confidential')
    expect(entityLinks.create.mock.calls.map((call: unknown[]) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKind: 'skill', targetKind: 'skill_file', edgeType: 'contains' }),
        expect.objectContaining({ sourceKind: 'skill', targetId: 'skill-sales', edgeType: 'uses_skill' }),
        expect.objectContaining({ sourceKind: 'skill_file', sourceId: 'file-statement', edgeType: 'references_resource' }),
      ]),
    )
  })
})
