/**
 * Reciprocal Rank Fusion (RRF) — Layer 3 reranker primitive.
 *
 * Combines multiple independent ranked lists (one per retrieval method) into a
 * single fused score. Pure function; method names are opaque to this module —
 * the caller decides what "fts" / "graph" / "recency" / "vector" mean. The
 * `RRF_METHOD` constant documents the canonical Layer 3 tags but does not
 * narrow the `RrfRankedList.method` type — experimental sources can still be
 * fused under any string tag.
 *
 * Formula:  score(d) = Σ_methods  1 / (k + rank_m(d))    (rank is 1-indexed)
 *
 * Docs absent from a method contribute 0 from that method, which is the
 * graceful-degradation hook for the NULL-embedding case — rows the async
 * embed worker (WU-8.3) hasn't reached participate in FTS / graph / recency
 * but not in vector ranking, and `rrfFuse` handles it without special-casing.
 *
 * Vector source: cosine distance over the HNSW indexes from WU-8.4
 * (`m=16, ef_construction=64`, `vector_cosine_ops`). Callers run the
 * `embedding <=> $queryEmbedding` query and feed the `{id, distance}[]` hit
 * list through `vectorRankedList(hits)` to produce the canonical
 * `RrfRankedList<TKey>` for `rrfFuse`.
 *
 * Spec: docs/architecture/brain/retrieval-layer.md §"Hybrid retrieval shape (RRF)"
 *       + docs/architecture/brain/embeddings.md §"Hybrid retrieval integration".
 */

export const DEFAULT_RRF_K = 60

/**
 * Canonical Layer 3 method tags. Use these constants when building lists for
 * `rrfFuse` so the analytics labels stay consistent across stores. The
 * `RrfRankedList.method` field is still typed as `string` — opaqueness is
 * load-bearing for ad-hoc / experimental fusion sources.
 */
export const RRF_METHOD = {
  fts: 'fts',
  graph: 'graph',
  recency: 'recency',
  vector: 'vector',
} as const

export type RrfMethod = (typeof RRF_METHOD)[keyof typeof RRF_METHOD]

export type RrfRankedList<TKey extends string = string> = {
  /** Method tag carried through for analytics (e.g. 'fts' | 'graph' | 'recency' | 'vector'). */
  method: string
  /** Candidate ids in descending rank order; index 0 is rank 1. */
  ranked: readonly TKey[]
}

export type RrfFused<TKey extends string = string> = {
  id: TKey
  score: number
  /** 1-indexed rank per method the doc appeared in. Missing methods omitted. */
  ranks: Record<string, number>
}

export type RrfOptions = {
  k?: number
}

export function rrfFuse<TKey extends string>(
  lists: readonly RrfRankedList<TKey>[],
  opts: RrfOptions = {},
): RrfFused<TKey>[] {
  const k = opts.k ?? DEFAULT_RRF_K

  const accum = new Map<TKey, RrfFused<TKey> & { firstSeenAt: number }>()
  let firstSeenCounter = 0

  for (const list of lists) {
    const seenInThisList = new Set<TKey>()
    for (let i = 0; i < list.ranked.length; i++) {
      const id = list.ranked[i]!
      if (seenInThisList.has(id)) continue
      seenInThisList.add(id)

      const rank = i + 1
      const contribution = 1 / (k + rank)

      let entry = accum.get(id)
      if (!entry) {
        entry = {
          id,
          score: 0,
          ranks: {},
          firstSeenAt: firstSeenCounter++,
        }
        accum.set(id, entry)
      }
      entry.score += contribution
      entry.ranks[list.method] = rank
    }
  }

  return [...accum.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.firstSeenAt - b.firstSeenAt
    })
    .map(({ firstSeenAt: _firstSeenAt, ...rest }) => rest)
}

/**
 * One vector hit from a pgvector `embedding <=> $queryEmbedding` query.
 * `distance` is cosine distance — pgvector's `<=>` operator returns values in
 * [0, 2] for normalized embeddings; smaller is closer is better.
 */
export type VectorHit<TKey extends string = string> = {
  id: TKey
  distance: number
}

/**
 * Convert a vector hit list into the canonical `RrfRankedList` for the
 * `'vector'` method. Sorts ASC by distance (closer = better = earlier rank),
 * dedupes by id keeping the first (best-distance) occurrence, and drops
 * non-finite distances defensively. The full list is preserved — top-N
 * truncation belongs in the SQL `LIMIT` upstream so `rrfFuse` sees every
 * candidate the store fetched.
 */
export function vectorRankedList<TKey extends string>(
  hits: readonly VectorHit<TKey>[],
): RrfRankedList<TKey> {
  const finite = hits.filter((h) => Number.isFinite(h.distance))
  const indexed = finite.map((h, i) => ({ h, i }))
  indexed.sort((a, b) => {
    if (a.h.distance !== b.h.distance) return a.h.distance - b.h.distance
    return a.i - b.i
  })

  const seen = new Set<TKey>()
  const ranked: TKey[] = []
  for (const { h } of indexed) {
    if (seen.has(h.id)) continue
    seen.add(h.id)
    ranked.push(h.id)
  }

  return { method: RRF_METHOD.vector, ranked }
}
