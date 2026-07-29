/**
 * `segment-coverage.ts` — honest recall over a partially-embedded corpus.
 *
 * Shared across the segment corpora for the same reason as `segment-lexical.ts`
 * (B7 — docs/plans/corpus-substrate-hardening.md §6/§7).
 *
 * **Why this exists.** The vector arm filters `WHERE embedding IS NOT NULL`.
 * With the drain paused, budgeted (see the embed budget in
 * `brain/embeddings.md`), or simply behind, results come from a fraction of the
 * corpus and were reported with full confidence — the model had no way to know
 * it had searched a slice, so "I found nothing about the shipment" and "nothing
 * about the shipment has been indexed yet" were indistinguishable in its input.
 *
 * Since the embed budget makes partial coverage a DESIGNED steady state rather
 * than a transient, disclosure is not optional (D9). Precedent: the BADCHARSET
 * degraded-search note in the same connector, and the coverage/gap model in
 * `whatsapp-brian` / `wechat-brian`.
 *
 * [COMP:brain/segment-coverage]
 */

/**
 * Ceiling on the bounded count behind a coverage note. Counting unembedded
 * rows exactly could scan the whole backlog; the note only needs to say
 * "some" versus "a lot", so the query stops here and the note says "at least".
 */
export const COVERAGE_PROBE_LIMIT = 5000

export type SegmentCoverage = {
  /** True when rows inside the query's own filter scope have no embedding. */
  partial: boolean
  /** Unembedded rows found in scope, capped at `COVERAGE_PROBE_LIMIT`. */
  unembeddedInScope: number
  /** True when the probe hit its cap, so the real number is higher. */
  capped: boolean
  /** Model-facing sentence, or null when coverage is complete. */
  note: string | null
}

export const FULL_COVERAGE: SegmentCoverage = {
  partial: false,
  unembeddedInScope: 0,
  capped: false,
  note: null,
}

/**
 * Turn a bounded unembedded count into a coverage verdict.
 *
 * The note is addressed to the model, not the user: it says what was searched
 * and what to do about it, so the model can qualify its answer instead of
 * asserting an absence it cannot support. `corpusLabel` names the corpus in
 * the sentence ("mailbox archive", "recording transcripts").
 */
export function buildSegmentCoverage(
  unembeddedInScope: number,
  corpusLabel: string,
): SegmentCoverage {
  if (unembeddedInScope <= 0) return FULL_COVERAGE
  const capped = unembeddedInScope >= COVERAGE_PROBE_LIMIT
  const amount = capped
    ? `at least ${COVERAGE_PROBE_LIMIT.toLocaleString('en-US')}`
    : String(unembeddedInScope)
  return {
    partial: true,
    unembeddedInScope,
    capped,
    note:
      `Partial coverage: ${amount} passages in this ${corpusLabel} are not indexed for meaning yet, ` +
      'so meaning-based matches were drawn from the indexed portion only (keyword matching still covered everything). ' +
      'Treat a negative result as inconclusive rather than as an absence, and say so if it matters to the answer.',
  }
}
