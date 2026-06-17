import { describe, it, expect } from 'vitest'
import { DEFAULT_MMR_LAMBDA, mmrRerank, type MmrCandidate } from '../mmr.js'

type Cand = MmrCandidate & { tags: readonly string[] }

const tagOverlap = (a: Cand, b: Cand): number => {
  const sa = new Set(a.tags)
  let shared = 0
  for (const t of b.tags) if (sa.has(t)) shared++
  const union = new Set([...a.tags, ...b.tags]).size
  return union === 0 ? 0 : shared / union
}

describe('[COMP:retrieval/mmr] Maximal Marginal Relevance', () => {
  it('exposes λ=0.6 as the spec default', () => {
    expect(DEFAULT_MMR_LAMBDA).toBe(0.6)
  })

  it('returns empty output for empty input', () => {
    const out = mmrRerank<string, Cand>([], { k: 5, sim: tagOverlap })
    expect(out).toEqual([])
  })

  it('returns empty output when k=0', () => {
    const cands: Cand[] = [
      { id: 'a', relevance: 1, tags: ['x'] },
    ]
    expect(mmrRerank(cands, { k: 0, sim: tagOverlap })).toEqual([])
  })

  it('returns all candidates in MMR order when k > candidates.length', () => {
    const cands: Cand[] = [
      { id: 'a', relevance: 0.9, tags: ['x'] },
      { id: 'b', relevance: 0.8, tags: ['y'] },
    ]
    const out = mmrRerank(cands, { k: 10, sim: tagOverlap })
    expect(out.map(c => c.id).sort()).toEqual(['a', 'b'])
    expect(out).toHaveLength(2)
  })

  it('λ=1 reproduces pure relevance-descending order', () => {
    const cands: Cand[] = [
      { id: 'a', relevance: 0.3, tags: ['x'] },
      { id: 'b', relevance: 0.9, tags: ['x'] },
      { id: 'c', relevance: 0.6, tags: ['x'] },
    ]
    const out = mmrRerank(cands, { k: 3, lambda: 1, sim: tagOverlap })
    expect(out.map(c => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('λ=0 picks the highest-relevance anchor, then maximally dissimilar candidates', () => {
    const cands: Cand[] = [
      { id: 'anchor', relevance: 0.9, tags: ['t1'] },
      { id: 'twin', relevance: 0.85, tags: ['t1'] },          // identical tags → max sim
      { id: 'diverse-1', relevance: 0.5, tags: ['unrelated'] }, // disjoint tags → 0 sim
      { id: 'diverse-2', relevance: 0.4, tags: ['other'] },     // disjoint tags → 0 sim
    ]
    const out = mmrRerank(cands, { k: 3, lambda: 0, sim: tagOverlap })
    expect(out[0]!.id).toBe('anchor')
    // After anchor, λ=0 means score = -maxSim, so any zero-sim doc beats 'twin'.
    expect(out.slice(1).map(c => c.id)).not.toContain('twin')
    expect(out).toHaveLength(3)
  })

  it('λ=0.6 (default) surfaces dissimilar candidates over near-duplicates inside top-K', () => {
    // 3 high-rel duplicates on the same topic, 3 slightly-lower-rel candidates on different topics.
    const cands: Cand[] = [
      { id: 'dup-1', relevance: 0.95, tags: ['programming'] },
      { id: 'dup-2', relevance: 0.93, tags: ['programming'] },
      { id: 'dup-3', relevance: 0.91, tags: ['programming'] },
      { id: 'div-marketing', relevance: 0.80, tags: ['marketing'] },
      { id: 'div-design', relevance: 0.78, tags: ['design'] },
      { id: 'div-finance', relevance: 0.76, tags: ['finance'] },
    ]
    const out = mmrRerank(cands, { k: 4, sim: tagOverlap })
    const ids = out.map(c => c.id)
    // Anchor is the top-rel programming dup.
    expect(ids[0]).toBe('dup-1')
    // Diversity should pull at least 2 of the 3 different-topic candidates into top-4,
    // ahead of the remaining near-duplicates.
    const diverseHits = ids.filter(id => id.startsWith('div-')).length
    expect(diverseHits).toBeGreaterThanOrEqual(2)
  })

  it('respects a caller-supplied custom similarity callback', () => {
    // sim always returns 1 → after anchor, every other pick is penalised equally,
    // so the second pick falls back to the next-highest-relevance candidate.
    const cands: Cand[] = [
      { id: 'a', relevance: 0.5, tags: ['x'] },
      { id: 'b', relevance: 0.9, tags: ['y'] },
      { id: 'c', relevance: 0.7, tags: ['z'] },
    ]
    const out = mmrRerank(cands, { k: 3, sim: () => 1 })
    expect(out.map(c => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('does not mutate the input candidate array', () => {
    const cands: Cand[] = [
      { id: 'a', relevance: 0.5, tags: ['x'] },
      { id: 'b', relevance: 0.9, tags: ['y'] },
    ]
    const snapshot = cands.slice()
    mmrRerank(cands, { k: 2, sim: tagOverlap })
    expect(cands).toEqual(snapshot)
  })

  it('caps output length at k', () => {
    const cands: Cand[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      relevance: 1 - i * 0.05,
      tags: [`t${i}`],
    }))
    const out = mmrRerank(cands, { k: 4, sim: tagOverlap })
    expect(out).toHaveLength(4)
  })
})
