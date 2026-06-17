/**
 * Sensitivity tiers for knowledge and memory.
 *
 * Three-tier hierarchical model:
 *   public < internal < confidential
 *
 * Assistant carries a `clearance` (max tier it can read). Rows carry a
 * `sensitivity`. Read filter: row.sensitivity <= assistant.clearance.
 *
 * Write stamp: during a turn, an accumulator tracks the max sensitivity of
 * every source the model saw. Memory/KB writes inherit that max — so
 * confidential data cannot silently become an internal memory.
 *
 * See docs/architecture/platform/sensitivity.md.
 */

export type Sensitivity = 'public' | 'internal' | 'confidential'

export const SENSITIVITY_VALUES: readonly Sensitivity[] = ['public', 'internal', 'confidential'] as const

export const RANK: Record<Sensitivity, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
}

export function isSensitivity(v: unknown): v is Sensitivity {
  return typeof v === 'string' && v in RANK
}

export function maxSensitivity(...values: Sensitivity[]): Sensitivity {
  let top: Sensitivity = 'public'
  for (const v of values) {
    if (RANK[v] > RANK[top]) top = v
  }
  return top
}

/**
 * Lowest (most-restrictive) tier among the values. Used to bound an
 * assistant's READ ceiling by the acting member's clearance:
 * `minSensitivity(member.clearance, assistant.clearance)`. Empty → the
 * highest tier (`confidential`), so a missing argument never widens access.
 */
export function minSensitivity(...values: Sensitivity[]): Sensitivity {
  let bottom: Sensitivity = 'confidential'
  for (const v of values) {
    if (RANK[v] < RANK[bottom]) bottom = v
  }
  return bottom
}

export function canRead(clearance: Sensitivity, rowSensitivity: Sensitivity): boolean {
  return RANK[rowSensitivity] <= RANK[clearance]
}

/**
 * Effective write-stamp floor for a turn's model-driven saves.
 *
 * Normal turns return the per-turn accumulator's `.max` (with `public` as
 * the baseline) — the "no silent downgrade" rule: a write inherits the
 * highest tier of any source the model saw, so confidential context can't be
 * laundered into a lower-tier row.
 *
 * **Research mode is a provenance exception.** A research turn's findings come
 * from the public web; the addendum's "brain-first" rule has the model read
 * known entities / KB (default `internal`) *before* web research purely to
 * avoid re-discovering facts. Those orientation reads must not over-restrict
 * the genuinely-public findings, so the floor drops to `public`.
 *
 * `confidential` stays a HARD floor even in research mode: if a confidential
 * source was read this turn, derived saves remain `confidential`. Research
 * mode classifies public web data as public; it is never a licence to launder
 * a cap-table / PII / deal-terms row into a public note. This is the one
 * tier with incident history (see docs/architecture/platform/sensitivity.md
 * → "Research-mode provenance").
 */
export function researchWriteFloor(
  accumulatorMax: Sensitivity | null | undefined,
  researchMode?: boolean,
): Sensitivity {
  const max: Sensitivity = accumulatorMax ?? 'public'
  if (researchMode) return max === 'confidential' ? 'confidential' : 'public'
  return max
}

/**
 * Per-turn accumulator. Call `note(s)` on every row read into context.
 * `max` reflects the highest tier seen so far. Starts at `public`.
 *
 * Used by memory/KB write paths to stamp newly created rows without
 * downgrade — see saveMemory and addKnowledgeEntry call sites.
 */
export class SensitivityAccumulator {
  #max: Sensitivity = 'public'

  get max(): Sensitivity {
    return this.#max
  }

  note(s: Sensitivity | null | undefined): void {
    if (!s) return
    if (RANK[s] > RANK[this.#max]) this.#max = s
  }
}
