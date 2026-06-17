import { describe, it, expect } from 'vitest'
import {
  EntityMergeError,
  UndoMergeError,
  isWithinUndoWindow,
  mergeEntities,
  reconcileAttributes,
  reconcileTags,
  undoMerge,
  type ApplyMergeInput,
  type ApplyUndoMergeInput,
  type EntityMergeDeps,
  type EntityMergeRecord,
  type EntityMergeRepository,
  type EntityMergeSnapshot,
  type SpecializationCascadeRepository,
} from '../entity-merge.js'

// ── Fakes ────────────────────────────────────────────────────────────

interface FakeRepo extends EntityMergeRepository {
  applyMergeCalls: ApplyMergeInput[]
  applyUndoMergeCalls: ApplyUndoMergeInput[]
}

interface FakeCascade extends SpecializationCascadeRepository {
  applyCalls: Array<{ sourceKind: string; mergedSourceId: string; survivorSourceId: string }>
  reverseCalls: Array<{ sourceKind: string; mergedSourceId: string }>
}

const WS = 'ws-1'

function snapshot(overrides: Partial<EntityMergeSnapshot> = {}): EntityMergeSnapshot {
  return {
    entityId: 'e-default',
    displayName: 'Default',
    attributes: {},
    tags: [],
    validTo: null,
    supersededBy: null,
    workspaceId: WS,
    ...overrides,
  }
}

function makeRepo(seed: {
  entities?: Record<string, EntityMergeSnapshot>
  merges?: Record<string, EntityMergeRecord>
  activeEntities?: Set<string>
} = {}): FakeRepo {
  const entities = new Map<string, EntityMergeSnapshot>(
    Object.entries(seed.entities ?? {}),
  )
  const merges = new Map<string, EntityMergeRecord>(
    Object.entries(seed.merges ?? {}),
  )
  const active = seed.activeEntities ?? new Set<string>([...entities.keys()])

  const applyMergeCalls: ApplyMergeInput[] = []
  const applyUndoMergeCalls: ApplyUndoMergeInput[] = []

  return {
    applyMergeCalls,
    applyUndoMergeCalls,
    async readEntityForMerge(workspaceId, entityId) {
      const e = entities.get(entityId)
      if (!e || e.workspaceId !== workspaceId) return null
      return e
    },
    async applyMerge(input) {
      applyMergeCalls.push(input)
      const rec: EntityMergeRecord = {
        id: `merge-${applyMergeCalls.length}`,
        workspaceId: input.workspaceId,
        survivingId: input.survivingId,
        mergedId: input.mergedId,
        mergedAt: input.now,
        mergedBy: input.mergedBy,
        reason: input.reason,
        mergedAttributesSnapshot: input.mergedAttributesSnapshot,
        survivingAttributesPreMerge: input.survivingAttributesPreMerge,
        mergedSpecializationPointer: input.mergedSpecializationPointer,
        cascadeApplied: input.cascadeApplied,
        reconciliationOverrides: input.reconciliationOverrides,
      }
      merges.set(rec.id, rec)
      return rec
    },
    async applyUndoMerge(input) {
      applyUndoMergeCalls.push(input)
    },
    async findMergeById(workspaceId, mergeId) {
      const m = merges.get(mergeId)
      if (!m || m.workspaceId !== workspaceId) return null
      return m
    },
    async isEntityActive(_workspaceId, entityId) {
      return active.has(entityId)
    },
  }
}

function makeCascade(reverseOutcome: 'reversed' | 'missing' = 'reversed'): FakeCascade {
  const applyCalls: FakeCascade['applyCalls'] = []
  const reverseCalls: FakeCascade['reverseCalls'] = []
  return {
    applyCalls,
    reverseCalls,
    async applyCascade(input) {
      applyCalls.push({
        sourceKind: input.sourceKind,
        mergedSourceId: input.mergedSourceId,
        survivorSourceId: input.survivorSourceId,
      })
    },
    async reverseCascade(input) {
      reverseCalls.push(input)
      return reverseOutcome
    },
  }
}

function depsWith(
  repo: EntityMergeRepository,
  opts: { cascade?: SpecializationCascadeRepository; now?: Date } = {},
): EntityMergeDeps {
  return {
    repo,
    cascade: opts.cascade,
    clock: opts.now ? () => opts.now! : undefined,
  }
}

// ── [COMP:corrections/entity-merge] ─────────────────────────────────

describe('[COMP:corrections/entity-merge] mergeEntities + reconciliation', () => {
  describe('reconcileAttributes (pure)', () => {
    it('survivor-wins keeps survivor values on conflict', () => {
      const { result, conflicts } = reconcileAttributes(
        { a: 1, b: 2 },
        { a: 9, c: 3 },
        'survivor-wins',
      )
      expect(result).toEqual({ a: 1, b: 2, c: 3 })
      expect(conflicts).toEqual([
        { field: 'a', severity: 'auto_resolved', survivorValue: 1, mergedValue: 9, resolvedValue: 1 },
      ])
    })

    it('merged-wins keeps merged values on conflict', () => {
      const { result, conflicts } = reconcileAttributes(
        { a: 1, b: 2 },
        { a: 9, c: 3 },
        'merged-wins',
      )
      expect(result).toEqual({ a: 9, b: 2, c: 3 })
      expect(conflicts.find(c => c.field === 'a')?.resolvedValue).toBe(9)
    })

    it('auto-merge unions non-conflicting keys', () => {
      const { result, conflicts } = reconcileAttributes(
        { a: 1, b: 2 },
        { c: 3, d: 4 },
        'auto-merge-with-prompt',
      )
      expect(result).toEqual({ a: 1, b: 2, c: 3, d: 4 })
      expect(conflicts).toHaveLength(0)
    })

    it('auto-merge surfaces requires_resolution on reserved field conflict with both populated', () => {
      const { conflicts } = reconcileAttributes(
        { email: 'a@x.com' },
        { email: 'b@x.com' },
        'auto-merge-with-prompt',
      )
      expect(conflicts).toEqual([
        {
          field: 'email',
          severity: 'requires_resolution',
          survivorValue: 'a@x.com',
          mergedValue: 'b@x.com',
        },
      ])
    })

    it('auto-merge accepts override for a reserved-field conflict', () => {
      const { result, conflicts } = reconcileAttributes(
        { email: 'a@x.com' },
        { email: 'b@x.com' },
        'auto-merge-with-prompt',
        [{ field: 'email', resolved: 'c@x.com' }],
      )
      expect(result.email).toBe('c@x.com')
      expect(conflicts).toEqual([
        {
          field: 'email',
          severity: 'auto_resolved',
          survivorValue: 'a@x.com',
          mergedValue: 'b@x.com',
          resolvedValue: 'c@x.com',
        },
      ])
    })

    it('auto-merge picks the populated side when the other is empty/null', () => {
      const { result, conflicts } = reconcileAttributes(
        { email: '' },
        { email: 'b@x.com' },
        'auto-merge-with-prompt',
      )
      expect(result.email).toBe('b@x.com')
      expect(conflicts[0]?.severity).toBe('auto_resolved')
    })

    it('manual-per-field requires an override for every conflict', () => {
      const { conflicts } = reconcileAttributes(
        { a: 1 },
        { a: 2 },
        'manual-per-field',
      )
      expect(conflicts[0]?.severity).toBe('requires_resolution')
    })

    it('manual-per-field with override resolves the conflict', () => {
      const { result, conflicts } = reconcileAttributes(
        { a: 1 },
        { a: 2 },
        'manual-per-field',
        [{ field: 'a', resolved: 42 }],
      )
      expect(result.a).toBe(42)
      expect(conflicts[0]?.severity).toBe('auto_resolved')
    })
  })

  describe('reconcileTags (pure)', () => {
    it('unions case-insensitively, preserves survivor order', () => {
      expect(reconcileTags(['Sales', 'EU'], ['eu', 'priority']))
        .toEqual(['Sales', 'EU', 'priority'])
    })

    it('deduplicates within each list', () => {
      expect(reconcileTags(['a', 'A'], ['B', 'b']))
        .toEqual(['a', 'B'])
    })
  })

  describe('isWithinUndoWindow (pure)', () => {
    it('true at 6d 23h after merge', () => {
      const merged = new Date('2026-05-01T00:00:00Z')
      const now = new Date(merged.getTime() + 6 * 24 * 3600 * 1000 + 23 * 3600 * 1000)
      expect(isWithinUndoWindow(merged, now)).toBe(true)
    })

    it('false 1s past 7d boundary', () => {
      const merged = new Date('2026-05-01T00:00:00Z')
      const now = new Date(merged.getTime() + 7 * 24 * 3600 * 1000 + 1000)
      expect(isWithinUndoWindow(merged, now)).toBe(false)
    })
  })

  describe('orchestration', () => {
    const survivor = snapshot({ entityId: 'e-s', displayName: 'Acme', attributes: { website: 'a.com' }, tags: ['EU'] })
    const mergedAway = snapshot({ entityId: 'e-m', displayName: 'acme', attributes: { phone: '555' }, tags: ['eu', 'priority'] })

    it('happy path with cascade ON invokes cascade port once', async () => {
      const repo = makeRepo({ entities: { 'e-s': survivor, 'e-m': mergedAway } })
      const cascade = makeCascade()
      const rec = await mergeEntities(
        {
          workspaceId: WS,
          survivingId: 'e-s',
          mergedId: 'e-m',
          actorUserId: 'u-1',
          specializationPointer: { sourceKind: 'contact', sourceId: 'c-m', survivorSourceId: 'c-s' },
        },
        depsWith(repo, { cascade }),
      )
      expect(rec.cascadeApplied).toBe(true)
      expect(cascade.applyCalls).toEqual([
        { sourceKind: 'contact', mergedSourceId: 'c-m', survivorSourceId: 'c-s' },
      ])
      expect(repo.applyMergeCalls).toHaveLength(1)
      expect(repo.applyMergeCalls[0]!.reconciledTags).toEqual(['EU', 'priority'])
      expect(repo.applyMergeCalls[0]!.reconciledAttributes).toEqual({ website: 'a.com', phone: '555' })
    })

    it('cascade opt-out does not invoke cascade port', async () => {
      const repo = makeRepo({ entities: { 'e-s': survivor, 'e-m': mergedAway } })
      const cascade = makeCascade()
      const rec = await mergeEntities(
        {
          workspaceId: WS,
          survivingId: 'e-s',
          mergedId: 'e-m',
          actorUserId: 'u-1',
          cascade: false,
          specializationPointer: { sourceKind: 'contact', sourceId: 'c-m', survivorSourceId: 'c-s' },
        },
        depsWith(repo, { cascade }),
      )
      expect(rec.cascadeApplied).toBe(false)
      expect(cascade.applyCalls).toHaveLength(0)
    })

    it('no specialization pointer → no cascade even with cascade=true', async () => {
      const repo = makeRepo({ entities: { 'e-s': survivor, 'e-m': mergedAway } })
      const cascade = makeCascade()
      const rec = await mergeEntities(
        { workspaceId: WS, survivingId: 'e-s', mergedId: 'e-m', actorUserId: 'u-1' },
        depsWith(repo, { cascade }),
      )
      expect(rec.cascadeApplied).toBe(false)
      expect(cascade.applyCalls).toHaveLength(0)
    })

    it('rejects self-merge', async () => {
      const repo = makeRepo({ entities: { 'e-s': survivor } })
      await expect(
        mergeEntities(
          { workspaceId: WS, survivingId: 'e-s', mergedId: 'e-s', actorUserId: 'u-1' },
          depsWith(repo),
        ),
      ).rejects.toMatchObject({ code: 'self_merge' } satisfies Partial<EntityMergeError>)
      expect(repo.applyMergeCalls).toHaveLength(0)
    })

    it('rejects cross-workspace merge', async () => {
      const repo = makeRepo({
        entities: {
          'e-s': survivor,
          'e-m': snapshot({ entityId: 'e-m', workspaceId: 'ws-other' }),
        },
      })
      await expect(
        mergeEntities(
          { workspaceId: WS, survivingId: 'e-s', mergedId: 'e-m', actorUserId: 'u-1' },
          depsWith(repo),
        ),
      ).rejects.toMatchObject({ code: 'entity_not_found' })
      // (the repo's `readEntityForMerge` returns null for a workspace mismatch — code path is entity_not_found)
    })

    it('rejects entity_not_found when one side is missing', async () => {
      const repo = makeRepo({ entities: { 'e-s': survivor } })
      await expect(
        mergeEntities(
          { workspaceId: WS, survivingId: 'e-s', mergedId: 'e-missing', actorUserId: 'u-1' },
          depsWith(repo),
        ),
      ).rejects.toMatchObject({ code: 'entity_not_found' })
    })

    it('rejects merging an already-superseded entity', async () => {
      const repo = makeRepo({
        entities: {
          'e-s': survivor,
          'e-m': snapshot({ entityId: 'e-m', validTo: new Date('2026-05-01T00:00:00Z') }),
        },
      })
      await expect(
        mergeEntities(
          { workspaceId: WS, survivingId: 'e-s', mergedId: 'e-m', actorUserId: 'u-1' },
          depsWith(repo),
        ),
      ).rejects.toMatchObject({ code: 'entity_inactive' })
      expect(repo.applyMergeCalls).toHaveLength(0)
    })

    it('rejects conflict_requires_resolution in default mode without override', async () => {
      const repo = makeRepo({
        entities: {
          'e-s': snapshot({ entityId: 'e-s', attributes: { email: 'a@x.com' } }),
          'e-m': snapshot({ entityId: 'e-m', attributes: { email: 'b@x.com' } }),
        },
      })
      await expect(
        mergeEntities(
          { workspaceId: WS, survivingId: 'e-s', mergedId: 'e-m', actorUserId: 'u-1' },
          depsWith(repo),
        ),
      ).rejects.toMatchObject({ code: 'conflict_requires_resolution' })
      expect(repo.applyMergeCalls).toHaveLength(0)
    })

    it('accepts conflict with matching override; applyMerge receives the resolved value', async () => {
      const repo = makeRepo({
        entities: {
          'e-s': snapshot({ entityId: 'e-s', attributes: { email: 'a@x.com' } }),
          'e-m': snapshot({ entityId: 'e-m', attributes: { email: 'b@x.com' } }),
        },
      })
      const rec = await mergeEntities(
        {
          workspaceId: WS,
          survivingId: 'e-s',
          mergedId: 'e-m',
          actorUserId: 'u-1',
          overrides: [{ field: 'email', resolved: 'final@x.com' }],
        },
        depsWith(repo),
      )
      expect(rec.id).toBeTruthy()
      expect(repo.applyMergeCalls[0]!.reconciledAttributes.email).toBe('final@x.com')
    })

    it('captures pre-merge snapshots verbatim', async () => {
      const repo = makeRepo({ entities: { 'e-s': survivor, 'e-m': mergedAway } })
      await mergeEntities(
        { workspaceId: WS, survivingId: 'e-s', mergedId: 'e-m', actorUserId: 'u-1' },
        depsWith(repo),
      )
      const call = repo.applyMergeCalls[0]!
      expect(call.survivingAttributesPreMerge).toBe(survivor)
      expect(call.mergedAttributesSnapshot).toBe(mergedAway)
    })
  })
})

// ── [COMP:corrections/undo-merge] ───────────────────────────────────

describe('[COMP:corrections/undo-merge] undoMerge', () => {
  const mergedAt = new Date('2026-05-01T00:00:00Z')

  function seedMerge(overrides: Partial<EntityMergeRecord> = {}): EntityMergeRecord {
    const survivorSnap = snapshot({ entityId: 'e-s', attributes: { v: 1 } })
    const mergedSnap = snapshot({ entityId: 'e-m', attributes: { v: 2 } })
    return {
      id: 'merge-1',
      workspaceId: WS,
      survivingId: 'e-s',
      mergedId: 'e-m',
      mergedAt,
      mergedBy: 'u-1',
      reason: null,
      mergedAttributesSnapshot: mergedSnap,
      survivingAttributesPreMerge: survivorSnap,
      mergedSpecializationPointer: null,
      cascadeApplied: false,
      reconciliationOverrides: null,
      ...overrides,
    }
  }

  it('happy path inside 7-day window with cascade reverses it', async () => {
    const repo = makeRepo({
      merges: {
        'merge-1': seedMerge({
          cascadeApplied: true,
          mergedSpecializationPointer: { sourceKind: 'contact', sourceId: 'c-m', survivorSourceId: 'c-s' },
        }),
      },
      activeEntities: new Set(['e-s']),
    })
    const cascade = makeCascade('reversed')
    const now = new Date(mergedAt.getTime() + 24 * 3600 * 1000)

    await undoMerge(
      { workspaceId: WS, mergeId: 'merge-1', actorUserId: 'u-9', now },
      depsWith(repo, { cascade }),
    )

    expect(cascade.reverseCalls).toEqual([{ sourceKind: 'contact', mergedSourceId: 'c-m' }])
    expect(repo.applyUndoMergeCalls).toHaveLength(1)
    expect(repo.applyUndoMergeCalls[0]!.cascadeReversed).toBe(true)
  })

  it('happy path without cascade does not invoke cascade port', async () => {
    const repo = makeRepo({
      merges: { 'merge-1': seedMerge() },
      activeEntities: new Set(['e-s']),
    })
    const cascade = makeCascade()
    const now = new Date(mergedAt.getTime() + 24 * 3600 * 1000)

    await undoMerge(
      { workspaceId: WS, mergeId: 'merge-1', actorUserId: 'u-9', now },
      depsWith(repo, { cascade }),
    )

    expect(cascade.reverseCalls).toHaveLength(0)
    expect(repo.applyUndoMergeCalls[0]!.cascadeReversed).toBe(false)
  })

  it('merge_not_found when findMergeById returns null', async () => {
    const repo = makeRepo()
    await expect(
      undoMerge(
        { workspaceId: WS, mergeId: 'nope', actorUserId: 'u-9' },
        depsWith(repo),
      ),
    ).rejects.toMatchObject({ code: 'merge_not_found' } satisfies Partial<UndoMergeError>)
    expect(repo.applyUndoMergeCalls).toHaveLength(0)
  })

  it('snapshot_unavailable when the merge record has null snapshots', async () => {
    const broken = {
      ...seedMerge(),
      mergedAttributesSnapshot: null as unknown as EntityMergeSnapshot,
      survivingAttributesPreMerge: null,
    }
    const repo = makeRepo({
      merges: { 'merge-1': broken },
      activeEntities: new Set(['e-s']),
    })
    await expect(
      undoMerge(
        { workspaceId: WS, mergeId: 'merge-1', actorUserId: 'u-9', now: new Date(mergedAt.getTime() + 1000) },
        depsWith(repo),
      ),
    ).rejects.toMatchObject({ code: 'snapshot_unavailable' })
  })

  it('merge_too_old past the 7-day boundary', async () => {
    const repo = makeRepo({
      merges: { 'merge-1': seedMerge() },
      activeEntities: new Set(['e-s']),
    })
    const tooLate = new Date(mergedAt.getTime() + 7 * 24 * 3600 * 1000 + 1000)
    await expect(
      undoMerge(
        { workspaceId: WS, mergeId: 'merge-1', actorUserId: 'u-9', now: tooLate },
        depsWith(repo),
      ),
    ).rejects.toMatchObject({ code: 'merge_too_old' })
    expect(repo.applyUndoMergeCalls).toHaveLength(0)
  })

  it('survivor_superseded when the survivor is no longer active', async () => {
    const repo = makeRepo({
      merges: { 'merge-1': seedMerge() },
      activeEntities: new Set<string>(), // survivor not active
    })
    await expect(
      undoMerge(
        { workspaceId: WS, mergeId: 'merge-1', actorUserId: 'u-9', now: new Date(mergedAt.getTime() + 1000) },
        depsWith(repo),
      ),
    ).rejects.toMatchObject({ code: 'survivor_superseded' })
    expect(repo.applyUndoMergeCalls).toHaveLength(0)
  })

  it('cascade_target_missing prevents partial undo when reverseCascade returns missing', async () => {
    const repo = makeRepo({
      merges: {
        'merge-1': seedMerge({
          cascadeApplied: true,
          mergedSpecializationPointer: { sourceKind: 'contact', sourceId: 'c-m', survivorSourceId: 'c-s' },
        }),
      },
      activeEntities: new Set(['e-s']),
    })
    const cascade = makeCascade('missing')
    await expect(
      undoMerge(
        { workspaceId: WS, mergeId: 'merge-1', actorUserId: 'u-9', now: new Date(mergedAt.getTime() + 1000) },
        depsWith(repo, { cascade }),
      ),
    ).rejects.toMatchObject({ code: 'cascade_target_missing' })
    expect(repo.applyUndoMergeCalls).toHaveLength(0)
    expect(cascade.reverseCalls).toHaveLength(1)
  })
})
