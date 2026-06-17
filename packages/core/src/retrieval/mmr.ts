/**
 * Maximal Marginal Relevance (MMR) — Layer 3 diversification primitive.
 *
 * Greedy rerank that balances relevance against redundancy. Anchor pick is the
 * highest-relevance candidate; subsequent picks maximise
 *
 *   λ · rel(d)  −  (1 − λ) · max_{s ∈ selected} sim(d, s)
 *
 * Pairwise similarity comes from a caller-supplied `sim` callback so the
 * algorithm stays decoupled from any specific notion of similarity (embedding
 * cosine today via WS-8, tag overlap or lexical similarity earlier).
 *
 * Spec: docs/architecture/brain/retrieval-layer.md §"Hybrid retrieval shape (RRF)"
 *       (MMR pseudocode) and §"Layer 3 — Diversification + trust primitives".
 *
 * λ is workspace-tunable upstream (`opts.diversity ?? workspace.mmr_lambda ?? 0.6`);
 * this module exposes only the constant default and a `lambda` parameter.
 */

export const DEFAULT_MMR_LAMBDA = 0.6

export type MmrCandidate<TKey extends string = string> = {
  id: TKey
  /** Pre-computed relevance to the query (typically upstream RRF score). */
  relevance: number
}

export type MmrOptions<TCand> = {
  k: number
  /** λ ∈ [0,1]. Caller is responsible for clamping; the function uses it as-is. */
  lambda?: number
  /** Pairwise similarity in [0,1]. */
  sim: (a: TCand, b: TCand) => number
}

export function mmrRerank<TKey extends string, TCand extends MmrCandidate<TKey>>(
  candidates: readonly TCand[],
  opts: MmrOptions<TCand>,
): TCand[] {
  const { k, sim } = opts
  const lambda = opts.lambda ?? DEFAULT_MMR_LAMBDA

  if (k <= 0 || candidates.length === 0) return []

  const remaining = [...candidates]
  const selected: TCand[] = []
  const target = Math.min(k, remaining.length)

  while (selected.length < target && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!
      let maxSimToSelected = 0
      for (const s of selected) {
        const v = sim(cand, s)
        if (v > maxSimToSelected) maxSimToSelected = v
      }
      const score = lambda * cand.relevance - (1 - lambda) * maxSimToSelected
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }

    selected.push(remaining[bestIdx]!)
    remaining.splice(bestIdx, 1)
  }

  return selected
}
