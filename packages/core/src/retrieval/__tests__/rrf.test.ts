import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RRF_K,
  RRF_METHOD,
  rrfFuse,
  vectorRankedList,
  type RrfRankedList,
  type VectorHit,
} from '../rrf.js'

describe('[COMP:retrieval/rrf] Reciprocal Rank Fusion', () => {
  it('exposes k=60 as the spec default', () => {
    expect(DEFAULT_RRF_K).toBe(60)
  })

  it('returns empty output for empty input', () => {
    expect(rrfFuse([])).toEqual([])
  })

  it('returns empty output when every list is empty', () => {
    expect(rrfFuse([
      { method: 'fts', ranked: [] },
      { method: 'graph', ranked: [] },
    ])).toEqual([])
  })

  it('with a single method, preserves the input rank order', () => {
    const fused = rrfFuse([
      { method: 'fts', ranked: ['a', 'b', 'c'] },
    ])
    expect(fused.map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('scores 1 / (k + rank) with k=60 by default', () => {
    const fused = rrfFuse([
      { method: 'fts', ranked: ['a', 'b'] },
    ])
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 12)
    expect(fused[1]!.score).toBeCloseTo(1 / 62, 12)
  })

  it('honours a custom k', () => {
    const fused = rrfFuse([
      { method: 'fts', ranked: ['a'] },
    ], { k: 10 })
    expect(fused[0]!.score).toBeCloseTo(1 / 11, 12)
  })

  it('ranks docs appearing in multiple methods above docs in only one', () => {
    const fused = rrfFuse([
      { method: 'fts', ranked: ['a', 'b', 'c'] },
      { method: 'graph', ranked: ['c', 'b'] },
    ])
    const byId = Object.fromEntries(fused.map(r => [r.id, r.score]))
    expect(byId['b']).toBeGreaterThan(byId['a']!)
    expect(byId['c']).toBeGreaterThan(byId['a']!)
  })

  it('sums reciprocals across three methods (FTS + graph + recency stand-in)', () => {
    const fused = rrfFuse([
      { method: 'fts', ranked: ['x', 'y'] },
      { method: 'graph', ranked: ['y', 'x'] },
      { method: 'recency', ranked: ['x'] },
    ])
    const byId = Object.fromEntries(fused.map(r => [r.id, r]))
    // x: rank 1 fts + rank 2 graph + rank 1 recency
    expect(byId['x']!.score).toBeCloseTo(1 / 61 + 1 / 62 + 1 / 61, 12)
    // y: rank 2 fts + rank 1 graph
    expect(byId['y']!.score).toBeCloseTo(1 / 62 + 1 / 61, 12)
  })

  it('contributes 0 from methods the doc is missing from (graceful degradation)', () => {
    const fused = rrfFuse([
      { method: 'fts', ranked: ['only-fts'] },
      { method: 'vector', ranked: [] }, // mimics the NULL-embedding window
    ])
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 12)
    expect(Number.isFinite(fused[0]!.score)).toBe(true)
    expect(fused[0]!.ranks).toEqual({ fts: 1 })
  })

  it('populates the per-method ranks map with 1-indexed positions', () => {
    const fused = rrfFuse([
      { method: 'fts', ranked: ['a', 'b'] },
      { method: 'graph', ranked: ['b', 'a'] },
    ])
    const byId = Object.fromEntries(fused.map(r => [r.id, r]))
    expect(byId['a']!.ranks).toEqual({ fts: 1, graph: 2 })
    expect(byId['b']!.ranks).toEqual({ fts: 2, graph: 1 })
  })

  it('collapses same-doc duplicate within a single list to the first (best) rank', () => {
    const fused = rrfFuse([
      { method: 'fts', ranked: ['dup', 'other', 'dup'] },
    ])
    const byId = Object.fromEntries(fused.map(r => [r.id, r]))
    expect(byId['dup']!.ranks).toEqual({ fts: 1 })
    expect(byId['dup']!.score).toBeCloseTo(1 / 61, 12)
  })

  it('tie-breaks deterministically by first appearance across input lists', () => {
    // Both 'a' and 'b' appear only at rank 1 in their own method → identical scores.
    const lists: RrfRankedList[] = [
      { method: 'fts', ranked: ['a'] },
      { method: 'graph', ranked: ['b'] },
    ]
    const first = rrfFuse(lists)
    const second = rrfFuse(lists)
    expect(first.map(r => r.id)).toEqual(second.map(r => r.id))
    expect(first[0]!.id).toBe('a')
    expect(first[1]!.id).toBe('b')
  })

  it('returns results sorted by score descending', () => {
    const fused = rrfFuse([
      { method: 'fts', ranked: ['c', 'a', 'b'] },
      { method: 'graph', ranked: ['a', 'b'] },
    ])
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1]!.score).toBeGreaterThanOrEqual(fused[i]!.score)
    }
  })
})

describe('[COMP:retrieval/rrf-vector] Vector source for RRF', () => {
  it('pins the vector method tag at "vector"', () => {
    expect(RRF_METHOD.vector).toBe('vector')
  })

  it('exposes the full canonical Layer 3 method-tag set', () => {
    expect(RRF_METHOD).toEqual({
      fts: 'fts',
      graph: 'graph',
      recency: 'recency',
      vector: 'vector',
    })
  })

  it('returns an empty vector list for empty input', () => {
    expect(vectorRankedList([])).toEqual({ method: 'vector', ranked: [] })
  })

  it('orders hits by ascending cosine distance (closer first)', () => {
    const hits: VectorHit[] = [
      { id: 'a', distance: 0.4 },
      { id: 'b', distance: 0.1 },
      { id: 'c', distance: 0.7 },
    ]
    expect(vectorRankedList(hits).ranked).toEqual(['b', 'a', 'c'])
  })

  it('breaks distance ties stably by input order', () => {
    const hits: VectorHit[] = [
      { id: 'first', distance: 0.5 },
      { id: 'second', distance: 0.5 },
      { id: 'third', distance: 0.5 },
    ]
    expect(vectorRankedList(hits).ranked).toEqual(['first', 'second', 'third'])
  })

  it('dedupes by id, keeping the first (best-distance) occurrence', () => {
    const hits: VectorHit[] = [
      { id: 'dup', distance: 0.2 },
      { id: 'other', distance: 0.3 },
      { id: 'dup', distance: 0.05 },
    ]
    const list = vectorRankedList(hits)
    // Sort runs first, so the 0.05 occurrence wins the rank-1 slot;
    // the 0.2 duplicate is dropped.
    expect(list.ranked).toEqual(['dup', 'other'])
  })

  it('drops non-finite distances silently (NaN, +Infinity, -Infinity)', () => {
    const hits: VectorHit[] = [
      { id: 'good', distance: 0.3 },
      { id: 'nan', distance: Number.NaN },
      { id: 'pinf', distance: Number.POSITIVE_INFINITY },
      { id: 'ninf', distance: Number.NEGATIVE_INFINITY },
      { id: 'closer', distance: 0.1 },
    ]
    const list = vectorRankedList(hits)
    expect(list.ranked).toEqual(['closer', 'good'])
  })

  it('round-trips through rrfFuse — co-occurring docs outrank single-source docs', () => {
    const fts: RrfRankedList = { method: 'fts', ranked: ['shared', 'fts-only'] }
    const vec = vectorRankedList([
      { id: 'shared', distance: 0.1 },
      { id: 'vec-only', distance: 0.2 },
    ])
    const fused = rrfFuse([fts, vec])
    const byId = Object.fromEntries(fused.map((r) => [r.id, r]))
    expect(byId['shared']!.score).toBeGreaterThan(byId['fts-only']!.score)
    expect(byId['shared']!.score).toBeGreaterThan(byId['vec-only']!.score)
    expect(byId['shared']!.ranks).toEqual({ fts: 1, vector: 1 })
    expect(byId['vec-only']!.ranks).toEqual({ vector: 2 })
  })
})
