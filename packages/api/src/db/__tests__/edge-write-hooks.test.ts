/**
 * Edge-write hooks — fire-and-forget invariant (company-brain WU-1.7).
 * Component tag: [COMP:brain/edge-write-hooks].
 *
 * Pure unit tests, no DB. The `EntityLinksStore` is a hand-rolled fake
 * whose `create` either resolves an `EntityLinkRecord` or throws on a
 * chosen call index. Verifies the two invariants the WU-1.7 brief named:
 *   1. an edge is emitted per save type with the correct kinds/edgeType
 *      (memory/task → entity `mentioned`, entity → file `documented_by`,
 *      entity ↔ entity CRM `works_at` / `engagement_of`);
 *   2. an edge-insert failure resolves rather than rejecting, so the
 *      primitive save that triggered the hook is never blocked.
 *
 * Spec: docs/plans/company-brain/data-model.md §Entity Links (Edges).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  EntityLinkCreateParams,
  EntityLinkRecord,
  EntityLinksStore,
} from '@use-brian/core'

import {
  emitCrmRelationEdge,
  emitDocumentedByEdges,
  emitEdgeFireAndForget,
  emitMentionedEdges,
  type EdgeEmitParams,
} from '../edge-hooks.js'

const ACTOR = 'actor-user-1'

function makeLinkRecord(
  params: EntityLinkCreateParams,
  id: string,
): EntityLinkRecord {
  return {
    id,
    sourceKind: params.sourceKind,
    sourceId: params.sourceId,
    targetKind: params.targetKind,
    targetId: params.targetId,
    edgeType: params.edgeType,
    attributes: params.attributes ?? {},
    source: params.source,
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: new Date(),
    validTo: null,
    retractedAt: null,
    retractedReason: null,
    sourceEpisodeId: params.sourceEpisodeId ?? null,
    sensitivity: params.sensitivity ?? 'internal',
    workspaceId: params.workspaceId,
    userId: params.userId ?? null,
    assistantId: params.assistantId ?? null,
    createdAt: new Date(),
  }
}

type FakeLinks = {
  store: EntityLinksStore
  calls: EntityLinkCreateParams[]
}

/**
 * Minimal `EntityLinksStore` fake — only `create` is exercised by the
 * edge hooks. `failOn` fails a chosen `create` call by zero-based index.
 */
function fakeEntityLinks(failOn?: (index: number) => boolean): FakeLinks {
  const calls: EntityLinkCreateParams[] = []
  let n = 0
  const store = {
    async create(params: EntityLinkCreateParams): Promise<EntityLinkRecord> {
      const index = calls.length
      calls.push(params)
      if (failOn?.(index)) {
        throw new Error('simulated entity_links insert failure')
      }
      return makeLinkRecord(params, `edge-${++n}`)
    },
  } as unknown as EntityLinksStore
  return { store, calls }
}

const baseParams: EdgeEmitParams = {
  sourceKind: 'memory',
  sourceId: 'mem-1',
  targetKind: 'entity',
  targetId: 'ent-1',
  edgeType: 'mentioned',
  workspaceId: 'ws-1',
  source: 'user',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('[COMP:brain/edge-write-hooks] emitEdgeFireAndForget', () => {
  it('inserts an edge and returns the new id on success', async () => {
    const links = fakeEntityLinks()
    const id = await emitEdgeFireAndForget(links.store, ACTOR, baseParams)
    expect(id).toBe('edge-1')
    expect(links.calls).toHaveLength(1)
    expect(links.calls[0]).toMatchObject({
      sourceKind: 'memory',
      targetKind: 'entity',
      edgeType: 'mentioned',
      workspaceId: 'ws-1',
    })
  })

  it('defaults userId to the actor when params.userId is absent', async () => {
    const links = fakeEntityLinks()
    await emitEdgeFireAndForget(links.store, ACTOR, baseParams)
    expect(links.calls[0].userId).toBe(ACTOR)
  })

  it('keeps an explicit params.userId over the actor', async () => {
    const links = fakeEntityLinks()
    await emitEdgeFireAndForget(links.store, ACTOR, {
      ...baseParams,
      userId: 'u-explicit',
    })
    expect(links.calls[0].userId).toBe('u-explicit')
  })

  it('returns null and does not reject when the insert fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const links = fakeEntityLinks(() => true)
    const id = await emitEdgeFireAndForget(links.store, ACTOR, baseParams)
    expect(id).toBeNull()
    expect(errSpy).toHaveBeenCalledOnce()
  })
})

describe('[COMP:brain/edge-write-hooks] emitMentionedEdges', () => {
  it('emits one memory→entity `mentioned` edge per entityId', async () => {
    const links = fakeEntityLinks()
    await emitMentionedEdges(links.store, ACTOR, {
      sourceKind: 'memory',
      sourceId: 'mem-1',
      entityIds: ['ent-1', 'ent-2', 'ent-3'],
      workspaceId: 'ws-1',
      source: 'user',
    })
    expect(links.calls).toHaveLength(3)
    for (const call of links.calls) {
      expect(call.sourceKind).toBe('memory')
      expect(call.targetKind).toBe('entity')
      expect(call.edgeType).toBe('mentioned')
    }
    expect(links.calls.map((c) => c.targetId)).toEqual(['ent-1', 'ent-2', 'ent-3'])
  })

  it('supports `task` as the mention source kind', async () => {
    const links = fakeEntityLinks()
    await emitMentionedEdges(links.store, ACTOR, {
      sourceKind: 'task',
      sourceId: 'task-1',
      entityIds: ['ent-1'],
      workspaceId: 'ws-1',
      source: 'user',
    })
    expect(links.calls[0].sourceKind).toBe('task')
  })

  it('lands the remaining edges and does not reject when one insert fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const links = fakeEntityLinks((index) => index === 1)
    await expect(
      emitMentionedEdges(links.store, ACTOR, {
        sourceKind: 'memory',
        sourceId: 'mem-1',
        entityIds: ['ent-1', 'ent-2', 'ent-3'],
        workspaceId: 'ws-1',
        source: 'user',
      }),
    ).resolves.toBeUndefined()
    // all three were attempted — the middle failure didn't abort the rest
    expect(links.calls).toHaveLength(3)
  })

  it('no-ops cleanly on an empty entityIds list', async () => {
    const links = fakeEntityLinks()
    await emitMentionedEdges(links.store, ACTOR, {
      sourceKind: 'memory',
      sourceId: 'mem-1',
      entityIds: [],
      workspaceId: 'ws-1',
      source: 'user',
    })
    expect(links.calls).toHaveLength(0)
  })
})

describe('[COMP:brain/edge-write-hooks] emitDocumentedByEdges', () => {
  it('emits entity→file `documented_by` edges', async () => {
    const links = fakeEntityLinks()
    await emitDocumentedByEdges(links.store, ACTOR, {
      fileId: 'file-1',
      entityIds: ['ent-1', 'ent-2'],
      workspaceId: 'ws-1',
      source: 'extracted',
    })
    expect(links.calls).toHaveLength(2)
    for (const call of links.calls) {
      expect(call.sourceKind).toBe('entity')
      expect(call.targetKind).toBe('file')
      expect(call.targetId).toBe('file-1')
      expect(call.edgeType).toBe('documented_by')
    }
  })

  it('threads commitSha into the edge attributes', async () => {
    const links = fakeEntityLinks()
    await emitDocumentedByEdges(links.store, ACTOR, {
      fileId: 'file-1',
      entityIds: ['ent-1'],
      workspaceId: 'ws-1',
      source: 'extracted',
      commitSha: 'abc123',
    })
    expect(links.calls[0].attributes).toEqual({ commit_sha: 'abc123' })
  })

  it('does not reject when an insert fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const links = fakeEntityLinks(() => true)
    await expect(
      emitDocumentedByEdges(links.store, ACTOR, {
        fileId: 'file-1',
        entityIds: ['ent-1'],
        workspaceId: 'ws-1',
        source: 'extracted',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('[COMP:brain/edge-write-hooks] emitCrmRelationEdge', () => {
  it('emits a person→company `works_at` entity↔entity edge', async () => {
    const links = fakeEntityLinks()
    const id = await emitCrmRelationEdge(links.store, ACTOR, {
      sourceEntityId: 'ent-person',
      targetEntityId: 'ent-company',
      edgeType: 'works_at',
      workspaceId: 'ws-1',
      source: 'user',
    })
    expect(id).toBe('edge-1')
    expect(links.calls[0]).toMatchObject({
      sourceKind: 'entity',
      sourceId: 'ent-person',
      targetKind: 'entity',
      targetId: 'ent-company',
      edgeType: 'works_at',
    })
  })

  it('emits a deal→company `engagement_of` edge', async () => {
    const links = fakeEntityLinks()
    await emitCrmRelationEdge(links.store, ACTOR, {
      sourceEntityId: 'ent-deal',
      targetEntityId: 'ent-company',
      edgeType: 'engagement_of',
      workspaceId: 'ws-1',
      source: 'user',
    })
    expect(links.calls[0].edgeType).toBe('engagement_of')
  })

  it('returns null and does not reject on failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const links = fakeEntityLinks(() => true)
    const id = await emitCrmRelationEdge(links.store, ACTOR, {
      sourceEntityId: 'ent-person',
      targetEntityId: 'ent-company',
      edgeType: 'works_at',
      workspaceId: 'ws-1',
      source: 'user',
    })
    expect(id).toBeNull()
  })
})
