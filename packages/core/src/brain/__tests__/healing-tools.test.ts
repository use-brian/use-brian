/**
 * [COMP:brain/healing-tools] tests — the Posture A write-gate wiring
 * (docs/architecture/engine/tool-executor.md §3).
 *
 *  • Tier D — `dedupeEntities` is gated everywhere (`requiresConfirmation`)
 *    and its `describeConfirmation` previews the lexical merge clusters
 *    ("survivor <- merged, …") from cheap READS, without merging or an LLM.
 *  • Tier C — `healMemories` / `undoReclassification` / `splitAlias` gate
 *    ONLY on the autonomous path via `resolveConfirmation`; interactive is
 *    silent.
 */

import { describe, expect, it } from 'vitest'
import { createBrainHealingTools, type HealingToolsDeps } from '../healing-tools.js'
import type { Tool, ToolContext } from '../../tools/types.js'
import type {
  CrossKindClusterRow,
  DuplicateClusterRow,
  EntityRecord,
  EntityStore,
} from '../../entities/types.js'

// ── Minimal fakes — only the reads describeConfirmation touches ────────

function entity(id: string, displayName: string, kind = 'company'): EntityRecord {
  return {
    id,
    kind,
    displayName,
    canonicalId: null,
    aliases: [],
    attributes: {},
    sensitivity: 'internal',
    workspaceId: 'ws-1',
    userId: 'u1',
    assistantId: null,
    createdByUserId: 'u1',
    createdByAssistantId: null,
    sourceEpisodeId: null,
    sourceSessionId: null,
    source: 'user',
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: new Date('2024-01-01T00:00:00Z'),
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    centrality: 0,
    centralityComputedAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  }
}

function fakeEntityStore(opts: {
  within?: DuplicateClusterRow[]
  cross?: CrossKindClusterRow[]
  live?: EntityRecord[]
}): EntityStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    findDuplicateClustersSystem: async () => opts.within ?? [],
    findCrossKindDuplicateClustersSystem: async () => opts.cross ?? [],
    listLiveEntitiesSystem: async () => opts.live ?? [],
  }
  return stub as EntityStore
}

function makeDeps(store: EntityStore): HealingToolsDeps {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candidates: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    memories: {} as any,
    entities: store,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entityLinks: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tasks: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: {} as any,
    reclassifierModel: 'flash',
  }
}

function byName(deps: HealingToolsDeps): Record<string, Tool> {
  const tools = createBrainHealingTools(deps)
  return Object.fromEntries(tools.map((t) => [t.name, t]))
}

const ctxAutonomous: ToolContext = {
  userId: 'u1',
  assistantId: 'a1',
  sessionId: 's1',
  appId: 'Use Brian',
  channelType: 'workflow',
  channelId: 'c1',
  workspaceId: 'ws-1',
  abortSignal: new AbortController().signal,
}
const ctxInteractive: ToolContext = { ...ctxAutonomous, channelType: 'web' }

describe('[COMP:brain/healing-tools] dedupeEntities Tier-D gate', () => {
  it('is gated everywhere (requiresConfirmation: true)', () => {
    const tools = byName(makeDeps(fakeEntityStore({})))
    expect(tools.dedupeEntities.requiresConfirmation).toBe(true)
  })

  it('describeConfirmation previews within-kind merge clusters as "survivor <- merged"', async () => {
    const store = fakeEntityStore({
      within: [
        { kind: 'company', displayNameNormalized: 'acme corp', entityIds: ['e1', 'e2', 'e3'] },
      ],
      live: [
        entity('e1', 'Acme Corp'),
        entity('e2', 'ACME corp'),
        entity('e3', 'Acme  Corp'),
      ],
    })
    const tools = byName(makeDeps(store))
    const lines = await tools.dedupeEntities.describeConfirmation!({}, ctxInteractive)
    expect(lines).not.toBeNull()
    expect(lines!.length).toBe(1)
    expect(lines![0]).toContain('Acme Corp')
    expect(lines![0]).toContain('(company)')
    expect(lines![0]).toContain('<-')
    expect(lines![0]).toContain('ACME corp')
    expect(lines![0]).toContain('Acme  Corp')
  })

  it('describeConfirmation previews cross-kind clusters with each member kind', async () => {
    const store = fakeEntityStore({
      cross: [
        {
          displayNameNormalized: 'meshjs',
          kinds: ['company', 'project'],
          entityIds: ['e1', 'e2'],
          createdAts: [new Date('2024-01-01'), new Date('2024-02-01')],
        },
      ],
      live: [entity('e1', 'MeshJS', 'company'), entity('e2', 'MeshJS', 'project')],
    })
    const tools = byName(makeDeps(store))
    const lines = await tools.dedupeEntities.describeConfirmation!({}, ctxInteractive)
    expect(lines!.some((l) => l.includes('cross-kind'))).toBe(true)
    expect(lines!.some((l) => l.includes('MeshJS (company)') && l.includes('MeshJS (project)'))).toBe(true)
  })

  it('describeConfirmation says nothing-would-merge when there are no clusters', async () => {
    const tools = byName(makeDeps(fakeEntityStore({})))
    const lines = await tools.dedupeEntities.describeConfirmation!({}, ctxInteractive)
    expect(lines).toEqual(['No duplicate clusters found — nothing would be merged.'])
  })

  it('describeConfirmation falls back to a short id when a clustered id is missing from the live map', async () => {
    const store = fakeEntityStore({
      within: [
        { kind: 'company', displayNameNormalized: 'acme', entityIds: ['aaaaaaaa-1111', 'bbbbbbbb-2222'] },
      ],
      live: [entity('aaaaaaaa-1111', 'Acme')], // bbbbbbbb missing
    })
    const tools = byName(makeDeps(store))
    const lines = await tools.dedupeEntities.describeConfirmation!({}, ctxInteractive)
    expect(lines![0]).toContain('Acme')
    expect(lines![0]).toContain('(id bbbbbbbb)')
  })

  it('describeConfirmation returns null (generic fallback) when the workspace is absent', async () => {
    const tools = byName(makeDeps(fakeEntityStore({})))
    const lines = await tools.dedupeEntities.describeConfirmation!(
      {},
      { ...ctxInteractive, workspaceId: null },
    )
    expect(lines).toBeNull()
  })

  it('describeConfirmation skips the cross-kind pass when a single kind is filtered (matches execute)', async () => {
    let crossCalled = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub: any = {
      findDuplicateClustersSystem: async () => [
        { kind: 'company', displayNameNormalized: 'acme', entityIds: ['e1', 'e2'] },
      ],
      findCrossKindDuplicateClustersSystem: async () => {
        crossCalled = true
        return []
      },
      listLiveEntitiesSystem: async () => [entity('e1', 'Acme'), entity('e2', 'acme')],
    }
    const tools = byName(makeDeps(stub as EntityStore))
    await tools.dedupeEntities.describeConfirmation!({ kind: 'company' }, ctxInteractive)
    expect(crossCalled).toBe(false)
  })
})

describe('[COMP:brain/healing-tools] Tier-C autonomous-only resolveConfirmation', () => {
  const tools = byName(makeDeps(fakeEntityStore({})))

  it.each(['healMemories', 'undoReclassification', 'splitAlias'])(
    '%s gates on the autonomous path and is silent interactive',
    async (name) => {
      const tool = tools[name]
      expect(tool.resolveConfirmation).toBeDefined()
      expect(await tool.resolveConfirmation!(ctxAutonomous)).toBe(true)
      expect(await tool.resolveConfirmation!(ctxInteractive)).toBe(false)
      // These are NOT statically flagged — the gate is purely path-aware.
      expect(tool.requiresConfirmation).toBe(false)
    },
  )

  it('read-only healing tools carry no confirmation gate', () => {
    expect(tools.listBrainCandidates.resolveConfirmation).toBeUndefined()
    expect(tools.listBrainCandidates.requiresConfirmation).toBe(false)
  })
})
