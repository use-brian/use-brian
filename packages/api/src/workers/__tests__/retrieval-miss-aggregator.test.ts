/**
 * Unit tests for the CL-9 weekly retrieval-miss aggregator worker.
 *
 * Spec: docs/architecture/context-engine/memory-consolidation.md → CL-9 lock → Weekly
 * REM aggregation. Covers the cluster threshold, the distinct-session
 * gate, the minOccurrences gate, the open-candidate suppression check,
 * and the pattern-summary picker.
 *
 * [COMP:workers/retrieval-miss-aggregator]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  startRetrievalMissAggregator,
  clusterByCosine,
  pickPatternSummary,
  type Cluster,
} from '../retrieval-miss-aggregator.js'
import type {
  RetrievalMissRow,
  RetrievalMissStore,
} from '../../db/retrieval-miss-store.js'
import type {
  KbGapCandidateRow,
  KbGapCandidateStore,
} from '../../db/kb-gap-candidate-store.js'

// ── Pure helpers ─────────────────────────────────────────────────

describe('[COMP:workers/retrieval-miss-aggregator] clusterByCosine', () => {
  it('groups rows whose embedding cosine exceeds the threshold', () => {
    const rows = [
      { miss: makeMiss('a', 'q1'), embedding: [1, 0, 0] },
      { miss: makeMiss('b', 'q2'), embedding: [0.99, 0.01, 0] },
      { miss: makeMiss('c', 'q3'), embedding: [0, 1, 0] },
    ]
    const clusters = clusterByCosine(rows, 0.75)
    expect(clusters).toHaveLength(2)
    // The first two rows should land in the same cluster; the third stays alone.
    expect(clusters[0].memberIndices.sort()).toEqual([0, 1])
    expect(clusters[1].memberIndices).toEqual([2])
  })

  it('returns one cluster per row when nothing meets the threshold', () => {
    const rows = [
      { miss: makeMiss('a', 'q1'), embedding: [1, 0, 0] },
      { miss: makeMiss('b', 'q2'), embedding: [0, 1, 0] },
      { miss: makeMiss('c', 'q3'), embedding: [0, 0, 1] },
    ]
    const clusters = clusterByCosine(rows, 0.75)
    expect(clusters).toHaveLength(3)
  })

  it('returns one cluster covering everything when all rows are near-identical', () => {
    const rows = [
      { miss: makeMiss('a', 'q1'), embedding: [1, 0, 0] },
      { miss: makeMiss('b', 'q2'), embedding: [0.99, 0.01, 0] },
      { miss: makeMiss('c', 'q3'), embedding: [0.98, 0.02, 0] },
    ]
    const clusters = clusterByCosine(rows, 0.9)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].memberIndices).toHaveLength(3)
  })

  it('handles an empty input', () => {
    const clusters: Cluster[] = clusterByCosine([], 0.75)
    expect(clusters).toEqual([])
  })
})

describe('[COMP:workers/retrieval-miss-aggregator] pickPatternSummary', () => {
  it('picks the highest-occurrence query text', () => {
    const misses = [
      makeMiss('a', 'how to deploy'),
      makeMiss('b', 'how to deploy'),
      makeMiss('c', 'deploying'),
    ]
    expect(pickPatternSummary(misses)).toBe('how to deploy')
  })

  it('breaks ties alphabetically for determinism', () => {
    const misses = [
      makeMiss('a', 'beta'),
      makeMiss('b', 'alpha'),
    ]
    expect(pickPatternSummary(misses)).toBe('alpha')
  })

  it('returns empty string for an empty input', () => {
    expect(pickPatternSummary([])).toBe('')
  })
})

// ── Worker behaviour ────────────────────────────────────────────

type MockStores = {
  missStore: RetrievalMissStore
  kbStore: KbGapCandidateStore
  emitted: Array<Parameters<KbGapCandidateStore['create']>[0]>
  openCandidates: KbGapCandidateRow[]
  missRows: RetrievalMissRow[]
}

function makeStores(opts: {
  missRows?: RetrievalMissRow[]
  openCandidates?: KbGapCandidateRow[]
} = {}): MockStores {
  const emitted: Array<Parameters<KbGapCandidateStore['create']>[0]> = []
  const missRows = opts.missRows ?? []
  const openCandidates = opts.openCandidates ?? []
  const missStore: RetrievalMissStore = {
    record: vi.fn(),
    countForSession: vi.fn(async () => 0),
    listForAggregation: vi.fn(async () => missRows),
  }
  const kbStore: KbGapCandidateStore = {
    create: vi.fn(async (input) => {
      emitted.push(input)
      return {
        id: `kb-${emitted.length}`,
        workspaceId: input.workspaceId,
        patternSummary: input.patternSummary,
        evidenceMissIds: input.evidenceMissIds,
        occurrences: input.occurrences,
        distinctSessions: input.distinctSessions,
        dismissedAt: null,
        dismissedByUserId: null,
        draftedAt: null,
        draftedByUserId: null,
        createdAt: new Date(),
      }
    }),
    listOpen: vi.fn(async () => openCandidates),
    dismiss: vi.fn(),
    markDrafted: vi.fn(),
  }
  return { missStore, kbStore, emitted, openCandidates, missRows }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:workers/retrieval-miss-aggregator] gating', () => {
  it('emits a candidate for a cluster crossing both gates', async () => {
    // Two near-identical queries across two distinct sessions.
    const missRows: RetrievalMissRow[] = [
      makeMiss('m1', 'how to deploy', { sessionId: 's1' }),
      makeMiss('m2', 'how to deploy', { sessionId: 's2' }),
    ]
    const mocks = makeStores({ missRows })
    const worker = startRetrievalMissAggregator({
      retrievalMissStore: mocks.missStore,
      kbGapStore: mocks.kbStore,
      getEmbedding: async (text) =>
        text === 'how to deploy' ? [1, 0, 0] : [0, 1, 0],
      listActiveWorkspaces: async () => ['ws-1'],
      firstTickDelayMs: 0,
      intervalMs: 1_000_000,
      minOccurrences: 2,
      clusterThreshold: 0.75,
    })

    await worker.tick()
    worker.stop()

    expect(mocks.emitted).toHaveLength(1)
    expect(mocks.emitted[0].workspaceId).toBe('ws-1')
    expect(mocks.emitted[0].patternSummary).toBe('how to deploy')
    expect(mocks.emitted[0].occurrences).toBe(2)
    expect(mocks.emitted[0].distinctSessions).toBe(2)
    expect(mocks.emitted[0].evidenceMissIds.sort()).toEqual(['m1', 'm2'])
  })

  it('does not emit when only one distinct session', async () => {
    const missRows: RetrievalMissRow[] = [
      makeMiss('m1', 'how to deploy', { sessionId: 's1' }),
      makeMiss('m2', 'how to deploy', { sessionId: 's1' }), // same session
    ]
    const mocks = makeStores({ missRows })
    const worker = startRetrievalMissAggregator({
      retrievalMissStore: mocks.missStore,
      kbGapStore: mocks.kbStore,
      getEmbedding: async () => [1, 0, 0],
      listActiveWorkspaces: async () => ['ws-1'],
      firstTickDelayMs: 0,
      intervalMs: 1_000_000,
      minOccurrences: 2,
      clusterThreshold: 0.75,
    })

    await worker.tick()
    worker.stop()

    expect(mocks.emitted).toHaveLength(0)
  })

  it('does not emit when below the minOccurrences threshold', async () => {
    const missRows: RetrievalMissRow[] = [
      makeMiss('m1', 'unique query A', { sessionId: 's1' }),
      makeMiss('m2', 'unique query B', { sessionId: 's2' }), // distinct cluster
    ]
    const mocks = makeStores({ missRows })
    const worker = startRetrievalMissAggregator({
      retrievalMissStore: mocks.missStore,
      kbGapStore: mocks.kbStore,
      // Each text maps to an orthogonal vector → two singleton clusters.
      getEmbedding: async (text) =>
        text === 'unique query A' ? [1, 0, 0] : [0, 1, 0],
      listActiveWorkspaces: async () => ['ws-1'],
      firstTickDelayMs: 0,
      intervalMs: 1_000_000,
      minOccurrences: 3,
      clusterThreshold: 0.75,
    })

    await worker.tick()
    worker.stop()

    expect(mocks.emitted).toHaveLength(0)
  })
})

describe('[COMP:workers/retrieval-miss-aggregator] suppression', () => {
  it('suppresses re-emission for a cluster whose centroid matches an open candidate', async () => {
    const missRows: RetrievalMissRow[] = [
      makeMiss('m1', 'how to deploy', { sessionId: 's1' }),
      makeMiss('m2', 'how to deploy', { sessionId: 's2' }),
    ]
    const openCandidates: KbGapCandidateRow[] = [
      {
        id: 'existing',
        workspaceId: 'ws-1',
        patternSummary: 'how to deploy',
        evidenceMissIds: ['old1', 'old2'],
        occurrences: 2,
        distinctSessions: 2,
        dismissedAt: null,
        dismissedByUserId: null,
        draftedAt: null,
        draftedByUserId: null,
        createdAt: new Date(),
      },
    ]
    const mocks = makeStores({ missRows, openCandidates })
    const worker = startRetrievalMissAggregator({
      retrievalMissStore: mocks.missStore,
      kbGapStore: mocks.kbStore,
      // Both the cluster centroid and the open candidate's pattern
      // text embed to the same vector — suppression should fire.
      getEmbedding: async () => [1, 0, 0],
      listActiveWorkspaces: async () => ['ws-1'],
      firstTickDelayMs: 0,
      intervalMs: 1_000_000,
      minOccurrences: 2,
      clusterThreshold: 0.75,
    })

    await worker.tick()
    worker.stop()

    expect(mocks.emitted).toHaveLength(0)
  })

  it('emits when no open candidate matches the cluster centroid', async () => {
    const missRows: RetrievalMissRow[] = [
      makeMiss('m1', 'how to deploy', { sessionId: 's1' }),
      makeMiss('m2', 'how to deploy', { sessionId: 's2' }),
    ]
    const openCandidates: KbGapCandidateRow[] = [
      {
        id: 'unrelated',
        workspaceId: 'ws-1',
        patternSummary: 'something totally different',
        evidenceMissIds: [],
        occurrences: 2,
        distinctSessions: 2,
        dismissedAt: null,
        dismissedByUserId: null,
        draftedAt: null,
        draftedByUserId: null,
        createdAt: new Date(),
      },
    ]
    const mocks = makeStores({ missRows, openCandidates })
    const worker = startRetrievalMissAggregator({
      retrievalMissStore: mocks.missStore,
      kbGapStore: mocks.kbStore,
      getEmbedding: async (text) =>
        text === 'how to deploy' ? [1, 0, 0] : [0, 1, 0],
      listActiveWorkspaces: async () => ['ws-1'],
      firstTickDelayMs: 0,
      intervalMs: 1_000_000,
      minOccurrences: 2,
      clusterThreshold: 0.75,
    })

    await worker.tick()
    worker.stop()

    expect(mocks.emitted).toHaveLength(1)
  })
})

describe('[COMP:workers/retrieval-miss-aggregator] cadence', () => {
  it('skips a workspace whose last-run timestamp is inside the window', async () => {
    const missRows: RetrievalMissRow[] = [
      makeMiss('m1', 'how to deploy', { sessionId: 's1' }),
      makeMiss('m2', 'how to deploy', { sessionId: 's2' }),
    ]
    const mocks = makeStores({ missRows })

    let now = new Date('2026-05-24T00:00:00Z').getTime()
    const worker = startRetrievalMissAggregator({
      retrievalMissStore: mocks.missStore,
      kbGapStore: mocks.kbStore,
      getEmbedding: async () => [1, 0, 0],
      listActiveWorkspaces: async () => ['ws-1'],
      firstTickDelayMs: 0,
      intervalMs: 1_000_000,
      minOccurrences: 2,
      clusterThreshold: 0.75,
      windowMs: 7 * 24 * 60 * 60 * 1000,
      now: () => new Date(now),
    })

    // First tick — emits one candidate.
    await worker.tick()
    expect(mocks.emitted).toHaveLength(1)

    // Second tick a day later — still inside the 7-day window. Should
    // be skipped, not double-emitted.
    now += 24 * 60 * 60 * 1000
    await worker.tick()
    expect(mocks.emitted).toHaveLength(1)

    // Third tick after the window — should run again.
    now += 7 * 24 * 60 * 60 * 1000
    // Open candidate from the first tick — clear it so the suppression
    // check doesn't block the re-emission.
    mocks.openCandidates.length = 0
    await worker.tick()
    expect(mocks.emitted).toHaveLength(2)

    worker.stop()
  })
})

describe('[COMP:workers/retrieval-miss-aggregator] no misses', () => {
  it('skips processing when there are no misses in the window', async () => {
    const mocks = makeStores({ missRows: [] })
    const worker = startRetrievalMissAggregator({
      retrievalMissStore: mocks.missStore,
      kbGapStore: mocks.kbStore,
      getEmbedding: async () => [1, 0, 0],
      listActiveWorkspaces: async () => ['ws-1'],
      firstTickDelayMs: 0,
      intervalMs: 1_000_000,
    })

    await worker.tick()
    worker.stop()

    expect(mocks.emitted).toHaveLength(0)
    expect(mocks.kbStore.create).not.toHaveBeenCalled()
  })
})

// ── Helpers ─────────────────────────────────────────────────────

function makeMiss(
  id: string,
  newQueryText: string,
  overrides: Partial<RetrievalMissRow> = {},
): RetrievalMissRow {
  return {
    id,
    sessionId: overrides.sessionId ?? `s-${id}`,
    workspaceId: overrides.workspaceId ?? 'ws-1',
    userId: overrides.userId ?? 'u-1',
    priorQueryHash: overrides.priorQueryHash ?? 'priorhash',
    newQueryHash: overrides.newQueryHash ?? 'newhash',
    priorQueryText: overrides.priorQueryText ?? 'prior',
    newQueryText,
    topKOverlap: overrides.topKOverlap ?? 0.1,
    cosineSimilarity: overrides.cosineSimilarity ?? 0.9,
    at: overrides.at ?? new Date(),
  }
}
