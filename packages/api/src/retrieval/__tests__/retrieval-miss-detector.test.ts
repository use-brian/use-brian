/**
 * Unit tests for the CL-9 retrieval-miss inline detector.
 *
 * Spec: docs/architecture/context-engine/memory-consolidation.md → CL-9 lock →
 * Within-session reformulation detection. Covers the threshold logic,
 * the per-session cap, the hash determinism, and the fail-closed
 * exception swallowing.
 *
 * [COMP:retrieval/retrieval-miss-detector]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createRetrievalMissDetector,
  cosineSimilarity,
  topKOverlap,
  hashQueryText,
} from '../retrieval-miss-detector.js'
import type { RetrievalMissStore } from '../../db/retrieval-miss-store.js'

// ── Pure helpers ─────────────────────────────────────────────────────

describe('[COMP:retrieval/retrieval-miss-detector] cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6)
  })

  it('returns a value strictly between 0 and 1 for partially aligned vectors', () => {
    const v = cosineSimilarity([1, 1], [1, 0])
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(1)
  })

  it('returns 0 for zero-length or mismatched vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0)
  })

  it('is symmetric', () => {
    const a = [0.5, 0.3, 0.8]
    const b = [0.1, 0.9, 0.2]
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 6)
  })
})

describe('[COMP:retrieval/retrieval-miss-detector] topKOverlap', () => {
  it('returns 1 when both sets are empty', () => {
    expect(topKOverlap([], [])).toBe(1)
  })

  it('returns 0 when there is no overlap', () => {
    expect(topKOverlap(['a', 'b'], ['c', 'd'])).toBe(0)
  })

  it('returns 1 for identical sets', () => {
    expect(topKOverlap(['a', 'b'], ['a', 'b'])).toBe(1)
  })

  it('divides by the larger set size so partial K does not inflate the overlap', () => {
    // prior=[a,b,c,d] next=[a,b] — 2 hits over max(4,2)=4 → 0.5
    expect(topKOverlap(['a', 'b', 'c', 'd'], ['a', 'b'])).toBe(0.5)
    // Same overlap regardless of which side is larger.
    expect(topKOverlap(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(0.5)
  })

  it('ignores ordering', () => {
    expect(topKOverlap(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(1)
  })
})

describe('[COMP:retrieval/retrieval-miss-detector] hashQueryText', () => {
  it('is deterministic across calls', () => {
    expect(hashQueryText('hello world')).toBe(hashQueryText('hello world'))
  })

  it('differs for different inputs', () => {
    expect(hashQueryText('how to deploy')).not.toBe(hashQueryText('how do I deploy'))
  })

  it('returns a 16-character lowercase hex string', () => {
    const h = hashQueryText('some query')
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })
})

// ── Detector behaviour ──────────────────────────────────────────────

type MockStore = {
  records: Array<Parameters<RetrievalMissStore['record']>[0]>
  store: RetrievalMissStore
}

function makeMockStore(): MockStore {
  const records: Array<Parameters<RetrievalMissStore['record']>[0]> = []
  const store: RetrievalMissStore = {
    record: vi.fn(async (input) => {
      records.push(input)
      // Return a row-shaped value so callers that read the result work.
      return {
        id: `mock-${records.length}`,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        priorQueryHash: input.priorQueryHash,
        newQueryHash: input.newQueryHash,
        priorQueryText: input.priorQueryText,
        newQueryText: input.newQueryText,
        topKOverlap: input.topKOverlap,
        cosineSimilarity: input.cosineSimilarity,
        at: new Date(),
      }
    }),
    countForSession: vi.fn(async (sessionId: string) =>
      records.filter((r) => r.sessionId === sessionId).length,
    ),
    listForAggregation: vi.fn(async () => []),
  }
  return { records, store }
}

function vec(seed: number, len = 8): number[] {
  // Deterministic pseudo-random vector tied to `seed`. Tests use
  // hand-picked seeds so cosine relationships are stable.
  const arr = new Array<number>(len)
  for (let i = 0; i < len; i++) {
    arr[i] = Math.sin(seed + i * 0.1)
  }
  return arr
}

// Manually-constructed near-duplicate vectors: same direction, small
// perturbation. Cosine ≥ 0.99.
const VEC_A = [1, 0, 0, 0, 0, 0, 0, 0]
const VEC_A_NEAR = [0.99, 0.01, 0.01, 0, 0, 0, 0, 0]
// Orthogonal vector — cosine ≈ 0.
const VEC_B = [0, 1, 0, 0, 0, 0, 0, 0]

const COMMON_INPUT = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  userId: 'user-1',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:retrieval/retrieval-miss-detector] first call in session', () => {
  it('does not write a miss row when there is no prior to compare against', async () => {
    const mock = makeMockStore()
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => VEC_A,
    })

    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'first query',
      resultIds: ['r1', 'r2', 'r3'],
    })

    expect(mock.records).toHaveLength(0)
    expect(detector._stateSize('session-1')).toBe(1)
  })
})

describe('[COMP:retrieval/retrieval-miss-detector] threshold logic', () => {
  it('logs a miss when cosine ≥ 0.85 AND overlap < 0.5', async () => {
    const mock = makeMockStore()
    // Two embeddings: prior=VEC_A, new=VEC_A_NEAR (cosine ≈ 0.99).
    const embeddings = [VEC_A, VEC_A_NEAR]
    let i = 0
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => embeddings[i++],
    })

    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'how do I deploy',
      resultIds: ['r1', 'r2', 'r3', 'r4'],
    })
    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'how to deploy',
      resultIds: ['r5', 'r6', 'r7', 'r8'], // 0% overlap with prior
    })

    expect(mock.records).toHaveLength(1)
    expect(mock.records[0].priorQueryText).toBe('how do I deploy')
    expect(mock.records[0].newQueryText).toBe('how to deploy')
    expect(mock.records[0].cosineSimilarity).toBeGreaterThanOrEqual(0.85)
    expect(mock.records[0].topKOverlap).toBeLessThan(0.5)
  })

  it('does not log when cosine < 0.85 (queries are semantically different)', async () => {
    const mock = makeMockStore()
    const embeddings = [VEC_A, VEC_B] // orthogonal
    let i = 0
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => embeddings[i++],
    })

    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'how do I deploy',
      resultIds: ['r1'],
    })
    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'what is the weather',
      resultIds: ['r99'],
    })

    expect(mock.records).toHaveLength(0)
  })

  it('does not log when overlap ≥ 0.5 (queries returned similar results)', async () => {
    const mock = makeMockStore()
    const embeddings = [VEC_A, VEC_A_NEAR] // high cosine
    let i = 0
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => embeddings[i++],
    })

    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'how do I deploy',
      resultIds: ['r1', 'r2', 'r3', 'r4'],
    })
    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'how to deploy',
      resultIds: ['r1', 'r2', 'r3', 'r5'], // 3/4 = 0.75 overlap
    })

    expect(mock.records).toHaveLength(0)
  })

  it('logs against the strongest cosine match when multiple priors qualify', async () => {
    const mock = makeMockStore()
    // Three priors then a new query that's closest to the *third* prior.
    // Per spec: each observe that qualifies (cosine ≥ threshold AND
    // overlap < threshold) logs a row — capped at maxMissesPerSession.
    // The "strongest" guarantee is *per observation*: each log picks the
    // prior with the highest cosine. So obs2, obs3, obs4 each emit a log;
    // the last one (obs4) must point at "third" (the highest-cosine prior).
    const embeddings = [VEC_A, [0.9, 0.1, 0, 0, 0, 0, 0, 0], VEC_A_NEAR, VEC_A_NEAR]
    let i = 0
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => embeddings[i++],
    })

    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'first',
      resultIds: ['a'],
    })
    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'second',
      resultIds: ['b'],
    })
    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'third',
      resultIds: ['c'],
    })
    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'fourth',
      resultIds: ['d'],
    })

    // obs2/3/4 all qualify; cap default is 5 so all three log.
    expect(mock.records).toHaveLength(3)
    // The fourth call (last log) should match the *third* prior — highest
    // cosine match among priors[0..2].
    expect(mock.records[mock.records.length - 1].priorQueryText).toBe('third')
  })
})

describe('[COMP:retrieval/retrieval-miss-detector] per-session cap', () => {
  it('stops writing after the cap is reached but keeps tracking in-memory state', async () => {
    const mock = makeMockStore()
    // Every call after the first will trigger a miss (high cosine, no overlap).
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => VEC_A_NEAR,
      maxMissesPerSession: 2,
    })

    // Seed the first prior so cosine compares can fire on subsequent calls.
    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'seed',
      resultIds: ['s1'],
    })

    // 4 follow-up calls; only first 2 should hit the DB.
    for (let i = 0; i < 4; i++) {
      await detector.observe({
        ...COMMON_INPUT,
        queryText: `follow-${i}`,
        resultIds: [`f${i}`], // disjoint from prior
      })
    }

    expect(mock.records).toHaveLength(2)
    // In-memory state should still contain every observation so future
    // novel reformulations can be compared against the full session.
    expect(detector._stateSize('session-1')).toBe(5)
  })

  it('enforces the cap per session, not globally', async () => {
    const mock = makeMockStore()
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => VEC_A_NEAR,
      maxMissesPerSession: 1,
    })

    // Seed both sessions then trigger one miss each.
    for (const sessionId of ['session-A', 'session-B']) {
      await detector.observe({
        ...COMMON_INPUT,
        sessionId,
        queryText: 'seed',
        resultIds: ['s1'],
      })
      await detector.observe({
        ...COMMON_INPUT,
        sessionId,
        queryText: 'next',
        resultIds: ['n1'],
      })
    }

    expect(mock.records).toHaveLength(2)
    expect(mock.records.map((r) => r.sessionId).sort()).toEqual([
      'session-A',
      'session-B',
    ])
  })
})

describe('[COMP:retrieval/retrieval-miss-detector] hash on stored row', () => {
  it('stamps deterministic hashes derived from the query text', async () => {
    const mock = makeMockStore()
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => VEC_A_NEAR,
    })

    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'how do I deploy',
      resultIds: ['x'],
    })
    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'how to deploy',
      resultIds: ['y'],
    })

    expect(mock.records[0].priorQueryHash).toBe(hashQueryText('how do I deploy'))
    expect(mock.records[0].newQueryHash).toBe(hashQueryText('how to deploy'))
  })
})

describe('[COMP:retrieval/retrieval-miss-detector] forgetSession', () => {
  it('drops per-session state so subsequent calls treat the session as fresh', async () => {
    const mock = makeMockStore()
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => VEC_A_NEAR,
    })

    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'seed',
      resultIds: ['x'],
    })
    expect(detector._stateSize('session-1')).toBe(1)

    detector.forgetSession('session-1')
    expect(detector._stateSize('session-1')).toBe(0)

    // The next call should not log because the session was reset.
    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'next',
      resultIds: ['y'],
    })
    expect(mock.records).toHaveLength(0)
  })
})

describe('[COMP:retrieval/retrieval-miss-detector] fail-closed', () => {
  it('swallows exceptions from getEmbedding and forwards to onError', async () => {
    const mock = makeMockStore()
    const onError = vi.fn()
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => {
        throw new Error('embed boom')
      },
      onError,
    })

    await expect(
      detector.observe({
        ...COMMON_INPUT,
        queryText: 'whatever',
        resultIds: ['r'],
      }),
    ).resolves.toBeUndefined()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(mock.records).toHaveLength(0)
  })

  it('swallows exceptions from the store record call', async () => {
    const mock = makeMockStore()
    ;(mock.store.record as any).mockImplementation(async () => {
      throw new Error('db boom')
    })
    const onError = vi.fn()
    const detector = createRetrievalMissDetector({
      retrievalMissStore: mock.store,
      getEmbedding: async () => VEC_A_NEAR,
      onError,
    })

    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'seed',
      resultIds: ['s'],
    })
    await detector.observe({
      ...COMMON_INPUT,
      queryText: 'next',
      resultIds: ['n'],
    })

    expect(onError).toHaveBeenCalledTimes(1)
  })
})

// Suppress noisy `vec()` helper unused-warning if no test ends up using it.
void vec
