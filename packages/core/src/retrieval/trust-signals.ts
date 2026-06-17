/**
 * Trust signals — Layer 3 ranking primitive (Approach W).
 *
 * Provenance-based trust. No per-row numeric confidence float — three
 * categorical/temporal signals (`source`, `verified_by_user_id`,
 * `retracted_at`) combine at retrieval time into a single multiplicative
 * weight applied after RRF fusion.
 *
 *   final_score = RRF × recency × graph_proximity × entity_centrality × rowTrustWeight(row)
 *
 * Weights are config in retrieval code, not per-row data — tuning is a
 * deploy, not a migration. They can grow into per-(source × type)
 * granularity without a schema change.
 *
 * Spec: docs/architecture/brain/trust-signals.md §"How retrieval ranks"
 *       (formerly docs/plans/company-brain/confidence.md, now graduated) +
 *       docs/architecture/brain/retrieval-layer.md §"Layer 3 — Diversification
 *       + trust primitives" (step 3).
 */

/**
 * Categorical source-provenance weights, per `docs/architecture/brain/trust-signals.md`
 * §"Source taxonomy" + §"How retrieval ranks". Unknown / un-enumerated sources fall
 * back to `SOURCE_WEIGHT_DEFAULT` rather than 1.0 — an unrecognised
 * provenance should not rank as high as a direct user entry.
 */
export const SOURCE_WEIGHTS: Readonly<Record<string, number>> = {
  user: 1.0,
  kb_sync: 0.95,
  extracted: 0.9,
  model: 0.9,
  community: 0.85,
  'auto-generated': 0.7,
  rem_connection: 0.7,
}

/** Fallback for any `source` value not in `SOURCE_WEIGHTS`. */
export const SOURCE_WEIGHT_DEFAULT = 0.85

/** Multiplier applied when the row carries a non-null `verified_by_user_id`. */
export const VERIFIED_BOOST = 1.1

/** Minimal row shape the trust-weight calculation reads. */
export type TrustRow = {
  /** Categorical provenance — `docs/architecture/brain/trust-signals.md` §"Source taxonomy". */
  source: string
  /** Non-null = user-verified — boosts the weight. */
  verified_by_user_id?: string | null
  /** Non-null = tombstoned — weight collapses to 0 (defense in depth). */
  retracted_at?: string | null
}

/**
 * Multiplicative trust weight for a retrieved row.
 *
 * `retracted_at` rows return 0 — defense in depth; tombstoned rows are
 * also excluded at the SQL level (`retracted_at IS NULL`), so a non-zero
 * `retracted_at` here means a code path skipped that filter and the row
 * must not survive ranking.
 */
export function rowTrustWeight(row: TrustRow): number {
  if (row.retracted_at != null) return 0
  const sourceWeight = SOURCE_WEIGHTS[row.source] ?? SOURCE_WEIGHT_DEFAULT
  return sourceWeight * (row.verified_by_user_id != null ? VERIFIED_BOOST : 1.0)
}
