import { describe, it, expect } from 'vitest'
import {
  fuseAndDiversify,
  fuseAndDiversifyTraced,
  vectorScopesFor,
  type ScoredRow,
} from '../retrieval-store.js'

/**
 * Wired-path tests for WU-5.7 — RRF fusion + trust weighting + MMR
 * diversification as composed inside `retrieval-store.ts`'s `search()`.
 *
 * `rrf.test.ts` / `mmr.test.ts` exercise the pure `@use-brian/core`
 * primitives. This suite exercises `fuseAndDiversify` — the exact
 * Layer-3 pipeline `search()` runs over its fan-out candidate set
 * (`rrfFuse([fts, graph, recency])` → `rowTrustWeight` → `mmrRerank`).
 * No database — the fan-out SQL is tested separately in
 * `retrieval-store.integration.test.ts`.
 *
 * Spec: docs/architecture/brain/retrieval-layer.md §"Layer 3 — Diversification
 * + trust primitives" + §"Hybrid retrieval shape (RRF)".
 */

function makeRow(args: {
  id: string
  primitive?: string
  ftsRank?: number | null
  vectorDistance?: number | null
  validFrom?: string
  source?: string
  verified?: boolean
  retracted?: boolean
  tags?: readonly string[]
}): ScoredRow {
  return {
    row: {
      primitive: args.primitive ?? 'memory',
      row_id: args.id,
      summary: `row ${args.id}`,
    },
    validFrom: args.validFrom ?? '2026-05-01T00:00:00.000Z',
    ftsRank: args.ftsRank ?? null,
    vectorDistance: args.vectorDistance ?? null,
    trust: {
      source: args.source ?? 'user',
      verified_by_user_id: args.verified ? 'verifier-uuid' : null,
      retracted_at: args.retracted ? '2026-05-02T00:00:00.000Z' : null,
    },
    tags: args.tags ?? [],
  }
}

describe('[COMP:retrieval/rrf] retrieval-store RRF fusion (wired path)', () => {
  it('returns an empty result for an empty candidate set', () => {
    expect(fuseAndDiversify([], 20)).toEqual([])
  })

  it('preserves a single row through the pipeline', () => {
    const out = fuseAndDiversify([makeRow({ id: 'solo' })], 20)
    expect(out.map((r) => r.row_id)).toEqual(['solo'])
  })

  it('ranks an FTS-scored row above a recency-only row of equal recency', () => {
    // Both rows share valid_from, so the recency list ranks them by key.
    // Only `a` has an FTS rank — it picks up the FTS-list reciprocal on
    // top of recency, so it must out-rank `b`.
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'a', ftsRank: 0.9, validFrom: '2026-05-01T00:00:00.000Z' }),
        makeRow({ id: 'b', ftsRank: null, validFrom: '2026-05-01T00:00:00.000Z' }),
      ],
      20,
    )
    expect(out[0]!.row_id).toBe('a')
  })

  it('orders FTS-scored rows by descending ts_rank', () => {
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'low', ftsRank: 0.1 }),
        makeRow({ id: 'high', ftsRank: 0.9 }),
        makeRow({ id: 'mid', ftsRank: 0.5 }),
      ],
      20,
    )
    expect(out.map((r) => r.row_id)).toEqual(['high', 'mid', 'low'])
  })

  it('ranks a more-recent row above an older one when neither has an FTS rank', () => {
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'old', validFrom: '2026-01-01T00:00:00.000Z' }),
        makeRow({ id: 'new', validFrom: '2026-05-10T00:00:00.000Z' }),
      ],
      20,
    )
    expect(out.map((r) => r.row_id)).toEqual(['new', 'old'])
  })

  it('ILIKE-only rows (no FTS rank) degrade gracefully — they still rank on recency', () => {
    // Mirrors the NULL-embedding / ILIKE-fallback case: a row absent
    // from the FTS list contributes 0 from that method but still
    // participates via recency.
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'ilike-new', ftsRank: null, validFrom: '2026-05-10T00:00:00.000Z' }),
        makeRow({ id: 'ilike-old', ftsRank: null, validFrom: '2026-01-01T00:00:00.000Z' }),
      ],
      20,
    )
    expect(out.map((r) => r.row_id)).toEqual(['ilike-new', 'ilike-old'])
  })

  it('dedupes a primitive+id collision, keeping the first occurrence', () => {
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'dup', primitive: 'memory', ftsRank: 0.9 }),
        makeRow({ id: 'dup', primitive: 'memory', ftsRank: 0.1 }),
      ],
      20,
    )
    expect(out.map((r) => r.row_id)).toEqual(['dup'])
  })

  it('keeps same-id rows from different primitives distinct (namespaced key)', () => {
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'shared', primitive: 'memory' }),
        makeRow({ id: 'shared', primitive: 'task' }),
      ],
      20,
    )
    expect(out).toHaveLength(2)
    expect(new Set(out.map((r) => r.primitive))).toEqual(new Set(['memory', 'task']))
  })
})

describe('[COMP:retrieval/rrf] retrieval-store trust weighting (wired path)', () => {
  it('a verified row out-ranks an unverified row of identical retrieval rank', () => {
    // Identical FTS rank and recency → identical RRF score. The verified
    // boost (×1.1) is the only differentiator.
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'unverified', ftsRank: 0.5, verified: false }),
        makeRow({ id: 'verified', ftsRank: 0.5, verified: true }),
      ],
      20,
    )
    expect(out[0]!.row_id).toBe('verified')
  })

  it('a low-trust source (rem_connection) ranks below a high-trust source (user)', () => {
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'rem', ftsRank: 0.5, source: 'rem_connection' }),
        makeRow({ id: 'user', ftsRank: 0.5, source: 'user' }),
      ],
      20,
    )
    expect(out[0]!.row_id).toBe('user')
  })

  it('a retracted row collapses to weight 0 and sinks below every live row', () => {
    // Defense in depth — retracted rows are also filtered in SQL, but if
    // one reaches fusion its trust weight is 0, so its final score is 0.
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'retracted', ftsRank: 0.99, retracted: true }),
        makeRow({ id: 'live', ftsRank: 0.01, retracted: false }),
      ],
      20,
    )
    expect(out[out.length - 1]!.row_id).toBe('retracted')
    expect(out[0]!.row_id).toBe('live')
  })
})

describe('[COMP:retrieval/mmr] retrieval-store MMR diversification (wired path)', () => {
  it('caps the result at k', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({ id: `r${i}`, ftsRank: 1 - i * 0.05 }),
    )
    expect(fuseAndDiversify(rows, 3)).toHaveLength(3)
    expect(fuseAndDiversify(rows, 10)).toHaveLength(10)
  })

  it('returns at most the candidate count when k exceeds it', () => {
    const out = fuseAndDiversify(
      [makeRow({ id: 'a' }), makeRow({ id: 'b' })],
      50,
    )
    expect(out).toHaveLength(2)
  })

  it('the anchor pick is the highest-relevance candidate', () => {
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'weak', ftsRank: 0.1, primitive: 'memory' }),
        makeRow({ id: 'strong', ftsRank: 0.9, primitive: 'memory' }),
      ],
      5,
    )
    expect(out[0]!.row_id).toBe('strong')
  })

  it('diversifies away from a redundant cluster — a distinct-tag row is promoted', () => {
    // Three near-top memory rows all tagged `pricing`, plus one slightly
    // weaker `onboarding` row. λ=0.6: after the anchor, MMR penalises the
    // tag-identical cluster, so the distinct-tag row should appear before
    // the third near-duplicate.
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'pricing-1', ftsRank: 0.90, primitive: 'memory', tags: ['pricing'] }),
        makeRow({ id: 'pricing-2', ftsRank: 0.88, primitive: 'memory', tags: ['pricing'] }),
        makeRow({ id: 'pricing-3', ftsRank: 0.86, primitive: 'memory', tags: ['pricing'] }),
        makeRow({ id: 'onboarding', ftsRank: 0.50, primitive: 'memory', tags: ['onboarding'] }),
      ],
      4,
    )
    const onboardingPos = out.findIndex((r) => r.row_id === 'onboarding')
    const pricing3Pos = out.findIndex((r) => r.row_id === 'pricing-3')
    expect(onboardingPos).toBeLessThan(pricing3Pos)
  })

  it('is deterministic across repeated calls', () => {
    const rows = [
      makeRow({ id: 'a', ftsRank: 0.5, tags: ['x'] }),
      makeRow({ id: 'b', ftsRank: 0.5, tags: ['y'] }),
      makeRow({ id: 'c', ftsRank: 0.5, tags: ['x'] }),
    ]
    const first = fuseAndDiversify(rows, 3).map((r) => r.row_id)
    const second = fuseAndDiversify(rows, 3).map((r) => r.row_id)
    expect(first).toEqual(second)
  })
})

describe('[COMP:retrieval/rrf] retrieval-store vector fusion (wired path)', () => {
  it('a vector-scored row out-ranks a recency-only row of equal recency', () => {
    // Both share valid_from; only `near` has a vector distance, so it
    // picks up the vector-list reciprocal on top of recency.
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'near', vectorDistance: 0.05, validFrom: '2026-05-01T00:00:00.000Z' }),
        makeRow({ id: 'plain', validFrom: '2026-05-01T00:00:00.000Z' }),
      ],
      20,
    )
    expect(out[0]!.row_id).toBe('near')
  })

  it('surfaces vector-scored rows nearest-first by cosine distance', () => {
    // Ids are alphabetical in distance order, so the recency tiebreaker
    // (equal valid_from → ordered by key) agrees with the vector arm —
    // the fused order then unambiguously tracks ascending distance.
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'a-near', vectorDistance: 0.1 }),
        makeRow({ id: 'm-mid', vectorDistance: 0.5 }),
        makeRow({ id: 'z-far', vectorDistance: 0.9 }),
      ],
      20,
    )
    expect(out.map((r) => r.row_id)).toEqual(['a-near', 'm-mid', 'z-far'])
  })

  it('fuses a row scored by both FTS and vector above a single-method row', () => {
    // `both` collects reciprocals from fts + vector + recency; `ftsOnly`
    // only fts + recency. Equal recency → `both` wins on the extra arm.
    const out = fuseAndDiversify(
      [
        makeRow({ id: 'both', ftsRank: 0.5, vectorDistance: 0.2 }),
        makeRow({ id: 'ftsOnly', ftsRank: 0.5 }),
      ],
      20,
    )
    expect(out[0]!.row_id).toBe('both')
  })

  it('rows absent from the vector arm degrade gracefully (contribute 0 from vector)', () => {
    // No row carries a vector distance — the vector list is empty;
    // fusion still ranks on fts + recency without special-casing.
    const out = fuseAndDiversify(
      [makeRow({ id: 'a', ftsRank: 0.9 }), makeRow({ id: 'b', ftsRank: 0.1 })],
      20,
    )
    expect(out.map((r) => r.row_id)).toEqual(['a', 'b'])
  })
})

/**
 * Bug B regression — the vector arm of `search()` must honor the requested
 * scope. A single-primitive search (e.g. the Brain "Files" filter,
 * `scope='file'`) used to still scan the memory / entity / kb_chunk vector
 * tables, leaking every primitive into the result while a query was active.
 * `vectorScopesFor` is the gate `search()` applies to `VECTOR_SCOPES`.
 */
describe('[COMP:retrieval/vector-scope-gate] vector arm scope gating', () => {
  it('unscoped search scans every embedding-bearing vector scope', () => {
    const scopes = vectorScopesFor(undefined).map((c) => c.scope)
    // The four embedding-bearing primitives (mig 139).
    expect(scopes).toEqual(
      expect.arrayContaining(['memory', 'entity', 'file', 'kb_chunk']),
    )
  })

  it('scope=file restricts the vector arm to the file scope only (Bug B)', () => {
    const scopes = vectorScopesFor(new Set(['file'])).map((c) => c.scope)
    expect(scopes).toEqual(['file'])
    expect(scopes).not.toContain('memory')
    expect(scopes).not.toContain('entity')
    expect(scopes).not.toContain('kb_chunk')
  })

  it('scope=memory restricts the vector arm to the memory scope only', () => {
    const scopes = vectorScopesFor(new Set(['memory'])).map((c) => c.scope)
    expect(scopes).toEqual(['memory'])
  })

  it('a scope with no vector table (contact/company/deal/task) yields no vector hits', () => {
    // CRM + task primitives carry no embedding column, so a single-primitive
    // search for them must not pull ANY vector rows from other tables.
    expect(vectorScopesFor(new Set(['contact']))).toEqual([])
    expect(vectorScopesFor(new Set(['company']))).toEqual([])
    expect(vectorScopesFor(new Set(['deal']))).toEqual([])
    expect(vectorScopesFor(new Set(['task']))).toEqual([])
  })
})

describe('[COMP:retrieval/search-trace-capture] fuseAndDiversifyTraced audit trace', () => {
  it('returns empty rows and steps for an empty candidate set', () => {
    expect(fuseAndDiversifyTraced([], 20)).toEqual({ rows: [], steps: [] })
  })

  it('produces rows byte-identical to fuseAndDiversify', () => {
    const candidates = [
      makeRow({ id: 'a', ftsRank: 0.9, tags: ['x'] }),
      makeRow({ id: 'b', vectorDistance: 0.1, tags: ['y'] }),
      makeRow({ id: 'c', ftsRank: 0.4, validFrom: '2026-05-03T00:00:00.000Z' }),
      makeRow({ id: 'd', source: 'extracted' }),
    ]
    expect(fuseAndDiversifyTraced(candidates, 20).rows).toEqual(
      fuseAndDiversify(candidates, 20),
    )
  })

  it('emits the three Layer-3 steps in order with a coherent candidate funnel', () => {
    const candidates = [
      makeRow({ id: 'a', ftsRank: 0.9 }),
      makeRow({ id: 'b', vectorDistance: 0.2 }),
      makeRow({ id: 'c', ftsRank: 0.3 }),
    ]
    const { rows, steps } = fuseAndDiversifyTraced(candidates, 20)
    expect(steps.map((s) => s.name)).toEqual(['rrf_fusion', 'trust_rerank', 'mmr_diversify'])
    expect(steps.map((s) => s.stepNumber)).toEqual([1, 2, 3])
    // Fusion sees the deduped candidate set; every id reached the fused list.
    expect(steps[0]?.metrics).toEqual({ candidatesBefore: 3, candidatesAfter: 3 })
    // The fusion step records which arms contributed.
    expect(steps[0]?.touched).toEqual(expect.arrayContaining(['fts', 'recency', 'vector']))
    // Every step carries a model-attribution label.
    expect(steps.every((s) => typeof s.model === 'string' && s.model.length > 0)).toBe(true)
    // MMR's selected set matches the returned rows, in order, all flagged.
    const mmr = steps[2]
    expect(mmr?.metrics?.candidatesAfter).toBe(rows.length)
    expect(mmr?.candidates?.map((c) => c.rowId)).toEqual(rows.map((r) => r.row_id))
    expect(mmr?.candidates?.every((c) => c.selectedByMmr === true)).toBe(true)
  })

  it('caps the MMR candidate list at k', () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeRow({ id: `r${i}`, ftsRank: 1 - i * 0.1 }),
    )
    const { rows, steps } = fuseAndDiversifyTraced(candidates, 3)
    expect(rows).toHaveLength(3)
    expect(steps[2]?.candidates).toHaveLength(3)
    expect(steps[2]?.metrics?.candidatesAfter).toBe(3)
  })
})

// ── large-content-artifacts: per-source-artifact group cap ──────────
describe('[COMP:retrieval/group-cap] file_segment per-artifact fused-page cap', () => {
  function segRow(id: string, fileId: string, ftsRank: number): ScoredRow {
    return {
      ...makeRow({ id, primitive: 'file_segment', ftsRank }),
      groupKey: `file:${fileId}`,
    }
  }

  it('caps one artifact at 2 slots even when it dominates the candidate set', () => {
    const candidates: ScoredRow[] = [
      // 30 strong candidates, all from the same file.
      ...Array.from({ length: 30 }, (_, i) => segRow(`f1-s${i}`, 'f1', 0.9 - i * 0.01)),
      // Two unrelated rows with weaker FTS scores.
      makeRow({ id: 'mem-1', ftsRank: 0.3 }),
      makeRow({ id: 'mem-2', ftsRank: 0.2 }),
    ]
    const out = fuseAndDiversify(candidates, 20)
    const f1 = out.filter((r) => r.primitive === 'file_segment')
    expect(f1.length).toBeLessThanOrEqual(2)
    // The unrelated rows survive — the cap frees slots instead of truncating the page.
    expect(out.some((r) => r.row_id === 'mem-1')).toBe(true)
    expect(out.some((r) => r.row_id === 'mem-2')).toBe(true)
  })

  it('keeps each artifact independently capped (two files → up to 2 each)', () => {
    const candidates: ScoredRow[] = [
      ...Array.from({ length: 10 }, (_, i) => segRow(`a-s${i}`, 'file-a', 0.9 - i * 0.01)),
      ...Array.from({ length: 10 }, (_, i) => segRow(`b-s${i}`, 'file-b', 0.8 - i * 0.01)),
    ]
    const out = fuseAndDiversify(candidates, 20)
    expect(out.filter((r) => String(r.row_id).startsWith('a-')).length).toBeLessThanOrEqual(2)
    expect(out.filter((r) => String(r.row_id).startsWith('b-')).length).toBeLessThanOrEqual(2)
    expect(out.length).toBeGreaterThanOrEqual(3) // both artifacts represented
  })

  it('rows without a groupKey are never capped', () => {
    const candidates: ScoredRow[] = Array.from({ length: 10 }, (_, i) =>
      makeRow({ id: `m-${i}`, ftsRank: 0.9 - i * 0.05 }),
    )
    const out = fuseAndDiversify(candidates, 20)
    expect(out.length).toBe(10)
  })

  it('the best-weighted segments of a capped artifact are the survivors', () => {
    const candidates: ScoredRow[] = Array.from({ length: 8 }, (_, i) =>
      segRow(`s${i}`, 'f9', 0.9 - i * 0.1),
    )
    const out = fuseAndDiversify(candidates, 20)
    const kept = out.filter((r) => r.primitive === 'file_segment').map((r) => r.row_id)
    expect(kept).toHaveLength(2)
    expect(kept).toContain('s0')
    expect(kept).toContain('s1')
  })
})

describe('[COMP:retrieval/file-segments] vector scope gating includes file_segment', () => {
  it('unscoped keeps file_segment; scoping to memory excludes it; scoping to file_segment isolates it', () => {
    const all = vectorScopesFor(undefined).map((c) => c.scope)
    expect(all).toContain('file_segment')
    const memOnly = vectorScopesFor(new Set(['memory'] as never[]) as never).map((c) => c.scope)
    expect(memOnly).toEqual(['memory'])
    const segOnly = vectorScopesFor(new Set(['file_segment'] as never[]) as never).map((c) => c.scope)
    expect(segOnly).toEqual(['file_segment'])
  })
})
