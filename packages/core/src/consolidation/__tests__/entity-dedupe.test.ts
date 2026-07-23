/**
 * [COMP:brain/entity-dedupe] tests — covers `runEntityDedupe` orchestration.
 * Verifies cluster traversal, survivor selection (survivor is `entityIds[0]`,
 * which the store orders curated-first then oldest), merge invocation, and
 * error/conflict accounting. Also covers the corrections.md §D.9 dedupe
 * guard: the caller access context is forwarded to every read (visibility
 * scoping) and the LLM alias pass is suggest-only (never auto-merges).
 */

import { describe, expect, it } from 'vitest'

import {
  runEntityDedupe,
  type EntityDedupeDeps,
} from '../entity-dedupe.js'
import type {
  EntityMergeDeps,
  EntityMergeRecord,
  EntityMergeRepository,
  EntityMergeSnapshot,
  ApplyMergeInput,
} from '../../corrections/entity-merge.js'
import { EntityMergeError } from '../../corrections/entity-merge.js'
import type {
  CrossKindClusterRow,
  DuplicateClusterRow,
  EntityKind,
  EntityStore,
} from '../../entities/types.js'

// ── Fake EntityStore — only the dedupe-read methods are exercised ──

function fakeEntityStore(
  clusters: DuplicateClusterRow[],
  crossKindClusters: CrossKindClusterRow[] = [],
  liveEntities: import('../../entities/types.js').EntityRecord[] = [],
  addAliasCalls?: Array<{ entityId: string; alias: string }>,
): EntityStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    findDuplicateClustersSystem: async () => clusters,
    findCrossKindDuplicateClustersSystem: async () => crossKindClusters,
    listLiveEntitiesSystem: async () => liveEntities,
    addAlias: async (_actorUserId: string, entityId: string, alias: string) => {
      addAliasCalls?.push({ entityId, alias: alias.trim().toLowerCase() })
      return { kind: 'ok' as const, entity: { id: entityId } as never }
    },
  }
  return stub as EntityStore
}

// ── Fake EntityMergeRepository ───────────────────────────────────────

interface FakeMergeRepo extends EntityMergeRepository {
  calls: Array<{ survivingId: string; mergedId: string }>
  /** Force a specific merge pair to throw the named error. */
  failOn?: Map<string, EntityMergeError | Error>
  /** Force a specific entity id to look inactive. */
  inactiveIds?: Set<string>
}

function fakeMergeRepo(
  opts: {
    failOn?: Map<string, EntityMergeError | Error>
    inactiveIds?: Set<string>
  } = {},
): FakeMergeRepo {
  const calls: FakeMergeRepo['calls'] = []
  const snap = (id: string, validTo: Date | null = null): EntityMergeSnapshot => ({
    entityId: id,
    displayName: id,
    attributes: { from: id },
    tags: [],
    validTo,
    supersededBy: null,
    workspaceId: 'ws-1',
  })
  const repo: FakeMergeRepo = {
    calls,
    failOn: opts.failOn,
    inactiveIds: opts.inactiveIds,
    async readEntityForMerge(_workspaceId, entityId) {
      const isInactive = opts.inactiveIds?.has(entityId)
      return snap(entityId, isInactive ? new Date('2020-01-01T00:00:00Z') : null)
    },
    async applyMerge(input: ApplyMergeInput): Promise<EntityMergeRecord> {
      const key = `${input.survivingId}->${input.mergedId}`
      const failure = opts.failOn?.get(key)
      if (failure) throw failure
      calls.push({ survivingId: input.survivingId, mergedId: input.mergedId })
      return {
        id: `merge-${calls.length}`,
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
    },
    async applyUndoMerge() { /* unused */ },
    async findMergeById() { return null },
    async isEntityActive(_workspaceId, entityId) {
      return !opts.inactiveIds?.has(entityId)
    },
  }
  return repo
}

function deps(
  clusters: DuplicateClusterRow[],
  repo: EntityMergeRepository,
  crossKindClusters: CrossKindClusterRow[] = [],
): EntityDedupeDeps {
  const merge: EntityMergeDeps = { repo }
  return {
    entities: fakeEntityStore(clusters, crossKindClusters),
    merge,
    workspaceId: 'ws-1',
    actorUserId: 'user-1',
  }
}

const cluster = (
  kind: EntityKind,
  name: string,
  ids: string[],
): DuplicateClusterRow => ({
  kind,
  displayNameNormalized: name,
  entityIds: ids,
})

// ── Tests ────────────────────────────────────────────────────────────

describe('[COMP:brain/entity-dedupe] runEntityDedupe', () => {
  it('merges every non-survivor into the oldest id per cluster', async () => {
    const repo = fakeMergeRepo()
    const result = await runEntityDedupe(
      deps(
        [
          cluster('project', 'meshjs', ['a-old', 'b', 'c']),
          cluster('repository', 'belvedere', ['d-old', 'e']),
        ],
        repo,
      ),
    )

    expect(result.clustersScanned).toBe(2)
    expect(result.pairsMerged).toBe(3)
    expect(result.pairsConflicted).toBe(0)
    expect(result.pairsErrored).toBe(0)
    expect(repo.calls).toEqual([
      { survivingId: 'a-old', mergedId: 'b' },
      { survivingId: 'a-old', mergedId: 'c' },
      { survivingId: 'd-old', mergedId: 'e' },
    ])
  })

  it('skips singleton clusters defensively without calling merge', async () => {
    const repo = fakeMergeRepo()
    const result = await runEntityDedupe(
      deps([cluster('project', 'only-one', ['solo'])], repo),
    )
    expect(result.clustersScanned).toBe(1)
    expect(result.pairsMerged).toBe(0)
    expect(repo.calls).toEqual([])
  })

  it('returns clustersScanned=0 when the workspace has no duplicates', async () => {
    const repo = fakeMergeRepo()
    const result = await runEntityDedupe(deps([], repo))
    expect(result.clustersScanned).toBe(0)
    expect(result.pairsMerged).toBe(0)
    expect(repo.calls).toEqual([])
  })

  it('counts thrown errors against pairsErrored and keeps the loop going', async () => {
    const failOn = new Map<string, Error>()
    failOn.set('a-old->b', new Error('boom'))
    const repo = fakeMergeRepo({ failOn })
    const result = await runEntityDedupe(
      deps([cluster('project', 'meshjs', ['a-old', 'b', 'c'])], repo),
    )
    expect(result.pairsMerged).toBe(1) // c still went through
    expect(result.pairsErrored).toBe(1)
    expect(result.details[0]?.mergedIds).toEqual(['c'])
    expect(result.details[0]?.erroredIds).toEqual(['b'])
  })

  it('records the per-cluster survivor + merged + errored breakdown', async () => {
    const repo = fakeMergeRepo()
    const result = await runEntityDedupe(
      deps([cluster('repository', 'belvedere', ['d-old', 'e', 'f'])], repo),
    )
    expect(result.details).toEqual([
      {
        kind: 'repository',
        displayNameNormalized: 'belvedere',
        survivorId: 'd-old',
        mergedIds: ['e', 'f'],
        conflictedIds: [],
        erroredIds: [],
      },
    ])
  })

  // ── Cross-kind pass ────────────────────────────────────────────────

  const xCluster = (
    name: string,
    kinds: EntityKind[],
    ids: string[],
    ages: Date[],
  ): CrossKindClusterRow => ({
    displayNameNormalized: name,
    kinds,
    entityIds: ids,
    createdAts: ages,
  })

  it('cross-kind pass picks the CRM (company) survivor over a project of the same name', async () => {
    const repo = fakeMergeRepo()
    const result = await runEntityDedupe(
      deps(
        [],
        repo,
        [
          xCluster(
            'meshjs',
            ['project', 'company'],
            ['ent-project', 'ent-company'],
            [new Date('2024-01-01'), new Date('2024-06-01')],
          ),
        ],
      ),
    )
    expect(result.crossKind.clustersScanned).toBe(1)
    expect(result.crossKind.pairsMerged).toBe(1)
    expect(result.crossKind.details[0]).toMatchObject({
      survivorId: 'ent-company',
      survivorKind: 'company',
      mergedIds: ['ent-project'],
      mergedKinds: ['project'],
    })
    expect(repo.calls).toEqual([
      { survivingId: 'ent-company', mergedId: 'ent-project' },
    ])
  })

  it('cross-kind pass prefers repository over project when no CRM kind is present', async () => {
    const repo = fakeMergeRepo()
    const result = await runEntityDedupe(
      deps(
        [],
        repo,
        [
          xCluster(
            'belvedere',
            ['product', 'project', 'repository'],
            ['p1', 'p2', 'r1'],
            [new Date('2024-01-01'), new Date('2024-02-01'), new Date('2024-03-01')],
          ),
        ],
      ),
    )
    expect(result.crossKind.details[0]?.survivorKind).toBe('repository')
    expect(result.crossKind.details[0]?.mergedKinds.sort()).toEqual(['product', 'project'])
  })

  it('skips cross-kind pass when kind is set or skipCrossKind is true', async () => {
    const repo = fakeMergeRepo()
    const xClusters = [xCluster('meshjs', ['company', 'project'], ['a', 'b'], [new Date(), new Date()])]

    const r1 = await runEntityDedupe({
      ...deps([], repo, xClusters),
      kind: 'project',
    })
    expect(r1.crossKind.clustersScanned).toBe(0)

    const r2 = await runEntityDedupe({
      ...deps([], repo, xClusters),
      skipCrossKind: true,
    })
    expect(r2.crossKind.clustersScanned).toBe(0)
  })

  it('skips cross-kind clusters that span >1 CRM kind (avoids orphaning specialization rows)', async () => {
    const repo = fakeMergeRepo()
    const result = await runEntityDedupe(
      deps(
        [],
        repo,
        [
          xCluster(
            'meshjs',
            ['company', 'deal'],
            ['ent-company', 'ent-deal'],
            [new Date('2024-01-01'), new Date('2024-02-01')],
          ),
        ],
      ),
    )
    // No merges run.
    expect(repo.calls).toEqual([])
    expect(result.crossKind.pairsMerged).toBe(0)
    expect(result.crossKind.pairsErrored).toBe(1)
    expect(result.crossKind.details[0]?.mergedIds).toEqual([])
    expect(result.crossKind.details[0]?.erroredIds).toEqual(['ent-deal'])
  })

  // ── LLM alias-clustering pass ─────────────────────────────────────

  const fakeEntity = (
    id: string,
    kind: EntityKind,
    displayName: string,
    aliases: string[] = [],
  ): import('../../entities/types.js').EntityRecord => ({
    id,
    kind,
    displayName,
    canonicalId: null,
    aliases,
    attributes: {},
    sensitivity: 'internal',
    workspaceId: 'ws-1',
    userId: 'u-1',
    assistantId: null,
    createdByUserId: 'u-1',
    createdByAssistantId: null,
    sourceEpisodeId: null,
    sourceSessionId: null,
    source: 'user',
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: new Date('2024-01-01'),
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    centrality: 0,
    centralityComputedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  })

  function fakeLlmProvider(jsonOutput: string): import('../../providers/types.js').LLMProvider {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider: any = {
      name: 'mock',
      models: ['mock'],
      createSession() {
        return { thoughtSignature: undefined } as never
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        yield { type: 'text_delta', text: jsonOutput }
        yield {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
        }
      },
    }
    return provider
  }

  it('LLM pass is suggest-only — even high-confidence clusters are NOT auto-merged (D.9 guard)', async () => {
    const repo = fakeMergeRepo()
    const addAliasCalls: Array<{ entityId: string; alias: string }> = []
    const liveEntities = [
      fakeEntity('ent-canonical', 'company', 'DeltaDeFi'),
      fakeEntity('ent-alias-1', 'project', 'DD'),
      fakeEntity('ent-alias-2', 'project', 'deltadefi-protocol'),
    ]
    const llmOutput = JSON.stringify({
      clusters: [{
        canonical_id: 'ent-canonical',
        alias_ids: ['ent-alias-1', 'ent-alias-2'],
        reasoning: 'DD and deltadefi-protocol both refer to DeltaDeFi',
        confidence: 0.95,
      }],
    })
    const entities = fakeEntityStore([], [], liveEntities, addAliasCalls)
    const result = await runEntityDedupe({
      entities,
      merge: { repo },
      workspaceId: 'ws-1',
      actorUserId: 'user-1',
      clusterByLlm: true,
      llmClusterer: { provider: fakeLlmProvider(llmOutput), model: 'gemini-flash' },
    })

    expect(result.llmCluster.ran).toBe(true)
    expect(result.llmCluster.clustersFound).toBe(1)
    // Nothing auto-applied, no matter how confident — surfaced as a suggestion.
    expect(result.llmCluster.applied).toEqual([])
    expect(result.llmCluster.suggestions).toHaveLength(1)
    expect(result.llmCluster.suggestions[0]?.confidence).toBe(0.95)
    expect(result.llmCluster.suggestions[0]?.aliasEntityIds.sort()).toEqual(['ent-alias-1', 'ent-alias-2'])
    // No merge and no alias write happened.
    expect(repo.calls).toEqual([])
    expect(addAliasCalls).toEqual([])
  })

  it('LLM pass surfaces low-confidence clusters as suggestions too', async () => {
    const repo = fakeMergeRepo()
    const addAliasCalls: Array<{ entityId: string; alias: string }> = []
    const liveEntities = [
      fakeEntity('ent-1', 'project', 'Hydra'),
      fakeEntity('ent-2', 'project', 'Hydra Side-Chain'),
    ]
    const llmOutput = JSON.stringify({
      clusters: [{
        canonical_id: 'ent-1',
        alias_ids: ['ent-2'],
        reasoning: 'might be the same; not sure',
        confidence: 0.6,
      }],
    })
    const entities = fakeEntityStore([], [], liveEntities, addAliasCalls)
    const result = await runEntityDedupe({
      entities,
      merge: { repo },
      workspaceId: 'ws-1',
      actorUserId: 'user-1',
      clusterByLlm: true,
      llmClusterer: { provider: fakeLlmProvider(llmOutput), model: 'gemini-flash' },
    })

    expect(result.llmCluster.applied).toEqual([])
    expect(result.llmCluster.suggestions).toHaveLength(1)
    expect(result.llmCluster.suggestions[0]?.confidence).toBe(0.6)
    expect(repo.calls).toEqual([])
    expect(addAliasCalls).toEqual([])
  })

  it('threads the caller access context into every visibility-scoped read (D.9 guard)', async () => {
    const seen: Array<unknown> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recordingStore: any = {
      findDuplicateClustersSystem: async (_u: string, _w: string, _o: unknown, access: unknown) => {
        seen.push(access)
        return []
      },
      findCrossKindDuplicateClustersSystem: async (_u: string, _w: string, _o: unknown, access: unknown) => {
        seen.push(access)
        return []
      },
      listLiveEntitiesSystem: async (_u: string, _w: string, _o: unknown, access: unknown) => {
        seen.push(access)
        return []
      },
    }
    const access = {
      workspaceId: 'ws-1',
      userId: 'user-1',
      assistantId: 'a1',
      assistantKind: 'standard' as const,
    }
    await runEntityDedupe({
      entities: recordingStore as EntityStore,
      merge: { repo: fakeMergeRepo() },
      workspaceId: 'ws-1',
      actorUserId: 'user-1',
      access,
      clusterByLlm: true,
      llmClusterer: {
        provider: fakeLlmProvider(JSON.stringify({ clusters: [] })),
        model: 'gemini-flash',
      },
    })
    // within-kind + cross-kind + llm-list reads all ran and each got the
    // caller's access context — never the unscoped system path.
    expect(seen.length).toBe(3)
    expect(seen.every((a) => a === access)).toBe(true)
  })

  it('LLM pass is a no-op when clusterByLlm is false', async () => {
    const result = await runEntityDedupe({
      entities: fakeEntityStore([], [], [], []),
      merge: { repo: fakeMergeRepo() },
      workspaceId: 'ws-1',
      actorUserId: 'user-1',
      clusterByLlm: false,
    })
    expect(result.llmCluster.ran).toBe(false)
    expect(result.llmCluster.clustersFound).toBe(0)
  })

  it('cross-kind errors are counted and surfaced per cluster without halting the loop', async () => {
    const failOn = new Map<string, Error>()
    failOn.set('ent-company->ent-project', new Error('cascade missing'))
    const repo = fakeMergeRepo({ failOn })
    const result = await runEntityDedupe(
      deps(
        [],
        repo,
        [
          xCluster(
            'meshjs',
            ['project', 'company'],
            ['ent-project', 'ent-company'],
            [new Date('2024-01-01'), new Date('2024-06-01')],
          ),
          xCluster(
            'multisig',
            ['product', 'project'],
            ['ent-prod', 'ent-proj'],
            [new Date('2024-02-01'), new Date('2024-03-01')],
          ),
        ],
      ),
    )
    expect(result.crossKind.pairsMerged).toBe(1) // multisig succeeded
    expect(result.crossKind.pairsErrored).toBe(1) // meshjs failed
  })
})
