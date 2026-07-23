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
import type {
  ApplyMergeInput,
  ApplyUndoMergeInput,
  EntityMergeDeps,
  EntityMergeRecord,
  EntityMergeSnapshot,
} from '../../corrections/entity-merge.js'

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

  it('describeConfirmation scopes its preview reads to the caller (D.9 visibility guard)', async () => {
    const seen: Array<unknown> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub: any = {
      findDuplicateClustersSystem: async (_u: string, _w: string, _o: unknown, access: unknown) => {
        seen.push(access)
        return [{ kind: 'company', displayNameNormalized: 'acme', entityIds: ['e1', 'e2'] }]
      },
      findCrossKindDuplicateClustersSystem: async (_u: string, _w: string, _o: unknown, access: unknown) => {
        seen.push(access)
        return []
      },
      listLiveEntitiesSystem: async (_u: string, _w: string, _o: unknown, access: unknown) => {
        seen.push(access)
        return [entity('e1', 'Acme'), entity('e2', 'acme')]
      },
    }
    const tools = byName(makeDeps(stub as EntityStore))
    await tools.dedupeEntities.describeConfirmation!({}, ctxInteractive)
    // Every preview read got a concrete access context carrying the caller
    // — never undefined (which would be the unscoped system path).
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(
      seen.every(
        (a) => a != null && (a as { userId?: string }).userId === ctxInteractive.userId,
      ),
    ).toBe(true)
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

// ── Scoped merge + undo (corrections.md D.1/D.2) ──────────────────────

/** Entities store whose `getById` looks records up by id (visibility fake). */
function entitiesWithGetById(records: EntityRecord[]): EntityStore {
  const byId = new Map(records.map((r) => [r.id, r]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    findDuplicateClustersSystem: async () => [],
    findCrossKindDuplicateClustersSystem: async () => [],
    listLiveEntitiesSystem: async () => [],
    getById: async (_ctx: unknown, id: string) => byId.get(id) ?? null,
  }
  return stub as EntityStore
}

function withAttrs(id: string, name: string, attributes: Record<string, unknown>): EntityRecord {
  return { ...entity(id, name, 'person'), id, attributes }
}

function fakeEntityMergeDeps(opts: {
  /** Records whose attributes the merge snapshots should mirror (for reconcile). */
  records?: EntityRecord[]
  onApply?: (input: ApplyMergeInput) => void
  onUndo?: (input: ApplyUndoMergeInput) => void
  mergeById?: (id: string) => EntityMergeRecord | null
  active?: (id: string) => boolean
  now?: Date
} = {}): EntityMergeDeps {
  const now = opts.now ?? new Date('2026-01-10T00:00:00Z')
  const attrsById = new Map((opts.records ?? []).map((r) => [r.id, r.attributes]))
  const snap = (id: string): EntityMergeSnapshot => ({
    entityId: id,
    displayName: id,
    attributes: attrsById.get(id) ?? {},
    tags: [],
    validTo: null,
    supersededBy: null,
    workspaceId: 'ws-1',
  })
  return {
    clock: () => now,
    repo: {
      readEntityForMerge: async (_ws, id) => snap(id),
      applyMerge: async (input: ApplyMergeInput): Promise<EntityMergeRecord> => {
        opts.onApply?.(input)
        return {
          id: 'merge-xyz',
          workspaceId: input.workspaceId,
          survivingId: input.survivingId,
          mergedId: input.mergedId,
          mergedAt: now,
          mergedBy: input.mergedBy,
          reason: input.reason,
          mergedAttributesSnapshot: input.mergedAttributesSnapshot,
          survivingAttributesPreMerge: input.survivingAttributesPreMerge,
          mergedSpecializationPointer: input.mergedSpecializationPointer,
          cascadeApplied: input.cascadeApplied,
          reconciliationOverrides: input.reconciliationOverrides,
        }
      },
      applyUndoMerge: async (input: ApplyUndoMergeInput) => {
        opts.onUndo?.(input)
      },
      findMergeById: async (_ws, id) => opts.mergeById?.(id) ?? null,
      isEntityActive: async (_ws, id) => opts.active?.(id) ?? true,
    },
  }
}

function mergeDeps(store: EntityStore, entityMerge: EntityMergeDeps): HealingToolsDeps {
  return { ...makeDeps(store), entityMerge }
}

describe('[COMP:brain/healing-tools] mergeEntities scoped pairwise merge (D.1)', () => {
  it('is gated everywhere (requiresConfirmation: true)', () => {
    const tools = byName(makeDeps(fakeEntityStore({})))
    expect(tools.mergeEntities.requiresConfirmation).toBe(true)
    expect(tools.mergeEntities.allowPersistentApproval).toBe(false)
  })

  it('describeConfirmation names both records and the survivor', async () => {
    const store = entitiesWithGetById([entity('e1', 'Ashley Chan', 'person'), entity('e2', 'Ashley Li', 'person')])
    const tools = byName(mergeDeps(store, fakeEntityMergeDeps()))
    const lines = await tools.mergeEntities.describeConfirmation!(
      { survivor_id: 'e1', merged_id: 'e2' },
      ctxInteractive,
    )
    expect(lines).not.toBeNull()
    expect(lines![0]).toContain('Merge Ashley Li into Ashley Chan')
    expect(lines![0]).toContain('Reversible for 7 days')
  })

  it('merges two visible records and returns the mergeId for undo', async () => {
    const applied: ApplyMergeInput[] = []
    const store = entitiesWithGetById([
      withAttrs('e1', 'Ashley Chan', { email: 'ashley@acme.example' }),
      withAttrs('e2', 'Ashley Li', { phone: '+15550000000' }),
    ])
    const tools = byName(mergeDeps(store, fakeEntityMergeDeps({ onApply: (i) => applied.push(i) })))
    const res = await tools.mergeEntities.execute({ survivor_id: 'e1', merged_id: 'e2' }, ctxInteractive)
    expect(res.isError).toBeFalsy()
    expect((res.data as { merged: boolean }).merged).toBe(true)
    expect((res.data as { mergeId: string }).mergeId).toBe('merge-xyz')
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ survivingId: 'e1', mergedId: 'e2' })
  })

  it('refuses to merge a record the caller cannot see (visibility guard)', async () => {
    const applied: ApplyMergeInput[] = []
    // Only e1 is visible; e2 is invisible to the caller.
    const store = entitiesWithGetById([entity('e1', 'Ashley Chan', 'person')])
    const tools = byName(mergeDeps(store, fakeEntityMergeDeps({ onApply: (i) => applied.push(i) })))
    const res = await tools.mergeEntities.execute({ survivor_id: 'e1', merged_id: 'e2' }, ctxInteractive)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('not visible')
    expect(applied).toHaveLength(0) // never reached the merge
  })

  it('rejects a self-merge', async () => {
    const store = entitiesWithGetById([entity('e1', 'Ashley Chan', 'person')])
    const tools = byName(mergeDeps(store, fakeEntityMergeDeps()))
    const res = await tools.mergeEntities.execute({ survivor_id: 'e1', merged_id: 'e1' }, ctxInteractive)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('two different records')
  })

  it('surfaces conflicting fields in the default "ask" mode instead of losing data', async () => {
    const applied: ApplyMergeInput[] = []
    const store = entitiesWithGetById([
      withAttrs('e1', 'Ashley Chan', { email: 'a@acme.example' }),
      withAttrs('e2', 'Ashley Li', { email: 'b@acme.example' }),
    ])
    const tools = byName(mergeDeps(store, fakeEntityMergeDeps({ onApply: (i) => applied.push(i) })))
    const res = await tools.mergeEntities.execute({ survivor_id: 'e1', merged_id: 'e2' }, ctxInteractive)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('email')
    expect(String(res.data)).toContain('on_conflict')
    expect(applied).toHaveLength(0) // did not merge on an unresolved conflict
  })

  it('on_conflict="keep_survivor" resolves the conflict and merges (survivor-wins)', async () => {
    const applied: ApplyMergeInput[] = []
    const records = [
      withAttrs('e1', 'Ashley Chan', { email: 'a@acme.example' }),
      withAttrs('e2', 'Ashley Li', { email: 'b@acme.example' }),
    ]
    const store = entitiesWithGetById(records)
    const tools = byName(mergeDeps(store, fakeEntityMergeDeps({ records, onApply: (i) => applied.push(i) })))
    const res = await tools.mergeEntities.execute(
      { survivor_id: 'e1', merged_id: 'e2', on_conflict: 'keep_survivor' },
      ctxInteractive,
    )
    expect(res.isError).toBeFalsy()
    expect(applied).toHaveLength(1)
    // survivor-wins keeps the survivor's email.
    expect(applied[0]?.reconciledAttributes).toMatchObject({ email: 'a@acme.example' })
  })

  it('reports "unavailable" when the merge port is not wired', async () => {
    const tools = byName(makeDeps(entitiesWithGetById([entity('e1', 'A', 'person'), entity('e2', 'B', 'person')])))
    const res = await tools.mergeEntities.execute({ survivor_id: 'e1', merged_id: 'e2' }, ctxInteractive)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('unavailable')
  })
})

describe('[COMP:brain/healing-tools] undoEntityMerge (D.2)', () => {
  const now = new Date('2026-01-10T00:00:00Z')
  const mergeRecord = (mergedAt: Date): EntityMergeRecord => ({
    id: 'merge-xyz',
    workspaceId: 'ws-1',
    survivingId: 'e1',
    mergedId: 'e2',
    mergedAt,
    mergedBy: 'u1',
    reason: null,
    mergedAttributesSnapshot: {
      entityId: 'e2', displayName: 'e2', attributes: {}, tags: [], validTo: new Date(mergedAt), supersededBy: 'e1', workspaceId: 'ws-1',
    },
    survivingAttributesPreMerge: {
      entityId: 'e1', displayName: 'e1', attributes: {}, tags: [], validTo: null, supersededBy: null, workspaceId: 'ws-1',
    },
    mergedSpecializationPointer: null,
    cascadeApplied: false,
    reconciliationOverrides: null,
  })

  it('gates on the autonomous path and is silent interactive (Tier-C)', async () => {
    const tools = byName(makeDeps(fakeEntityStore({})))
    const tool = tools.undoEntityMerge
    expect(tool.requiresConfirmation).toBe(false)
    expect(await tool.resolveConfirmation!(ctxAutonomous)).toBe(true)
    expect(await tool.resolveConfirmation!(ctxInteractive)).toBe(false)
  })

  it('reverses a merge within the window', async () => {
    const undone: ApplyUndoMergeInput[] = []
    const deps = mergeDeps(
      fakeEntityStore({}),
      fakeEntityMergeDeps({
        now,
        mergeById: (id) => (id === 'merge-xyz' ? mergeRecord(now) : null),
        onUndo: (i) => undone.push(i),
      }),
    )
    const tools = byName(deps)
    const res = await tools.undoEntityMerge.execute({ merge_id: 'merge-xyz' }, ctxInteractive)
    expect(res.isError).toBeFalsy()
    expect((res.data as { undone: boolean }).undone).toBe(true)
    expect(undone).toHaveLength(1)
  })

  it('gives a plain-language error when the merge id is unknown', async () => {
    const deps = mergeDeps(fakeEntityStore({}), fakeEntityMergeDeps({ now, mergeById: () => null }))
    const tools = byName(deps)
    const res = await tools.undoEntityMerge.execute({ merge_id: '00000000-0000-0000-0000-000000000000' }, ctxInteractive)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('No merge with that id')
  })

  it('refuses a merge outside the 7-day window with a clear message', async () => {
    const old = new Date('2025-01-01T00:00:00Z') // > 7 days before `now`
    const deps = mergeDeps(
      fakeEntityStore({}),
      fakeEntityMergeDeps({ now, mergeById: (id) => (id === 'merge-xyz' ? mergeRecord(old) : null) }),
    )
    const tools = byName(deps)
    const res = await tools.undoEntityMerge.execute({ merge_id: 'merge-xyz' }, ctxInteractive)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('7-day undo window')
  })
})
