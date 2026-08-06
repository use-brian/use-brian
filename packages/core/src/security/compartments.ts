/**
 * Compartment axis (the fifth permission axis) — pure write-side helpers.
 *
 * Compartments are a non-hierarchical MLS "category" set, orthogonal to the
 * sensitivity ladder (./sensitivity.ts) and AND-composed with it. The read-gate
 * (`buildAccessPredicate`'s `row.compartments <@ $grant` clause +
 * `resolveReadCompartmentsSystem` = `member ∩ assistant`) lives on the API
 * side; this file owns the engine-side vocabulary:
 *
 *   - `CompartmentAccumulator` — the union analogue of `SensitivityAccumulator`,
 *     tracking the compartments of every row read in a turn so derived writes
 *     inherit the high-water union (the laundering guard).
 *   - `unionCompartments(...grants)` — deduped union of any number of grants.
 *   - `subsetCompartments(grant, requested)` — the write-gate test (`requested ⊆
 *     grant`); a `null`/`undefined` grant is the universe (always true).
 *
 * See docs/plans/compartment-axis.md.
 */

/**
 * Reserved namespace for machine-minted per-client compartments.
 *
 * Operator-authored compartment keys are a small taxonomy a human curates in
 * Studio (`compartments.key` matches `/^[a-z0-9][a-z0-9-]{0,38}$/`, so it can
 * never contain a colon). Client compartments are the opposite: one per
 * external principal, minted by the turn pipeline, unbounded in cardinality,
 * and never registered. Keeping them in their own namespace is what lets the
 * picker filter them out by rule instead of by list.
 *
 * Load-bearing, not decorative. A client contact row is `user_id` NULL (so the
 * team can see it at all), which means the automatic `user_id` partition is no
 * longer the client-vs-client wall — the compartment is. See
 * `docs/plans/client-principal.md` decisions D9 and D12.
 */
export const CLIENT_COMPARTMENT_PREFIX = 'client:'

/**
 * Mint the compartment for one external principal. The `externalUserId` is the
 * consumer's own durable index key, carried verbatim so an operator reading a
 * row can tell whose it is.
 */
export function clientCompartment(externalUserId: string): string {
  return `${CLIENT_COMPARTMENT_PREFIX}${externalUserId}`
}

/** Is this key in the reserved, machine-minted client namespace? */
export function isClientCompartment(key: string): boolean {
  return key.startsWith(CLIENT_COMPARTMENT_PREFIX)
}

/**
 * Per-turn accumulator. Call `note(row.compartments)` on every row read into
 * context; `compartments` returns the deduped union seen so far (starts empty).
 * Derived writes union this in so a row distilled from `{research}` + `{finance}`
 * sources is itself `{research, finance}` — high-water-mark, no laundering.
 */
export class CompartmentAccumulator {
  readonly #set = new Set<string>()

  get compartments(): string[] {
    return [...this.#set]
  }

  note(compartments: string[] | null | undefined): void {
    if (!compartments) return
    for (const c of compartments) this.#set.add(c)
  }
}

/** Deduped set-union of any number of compartment grants (nulls/empties skipped). */
export function unionCompartments(...grants: (string[] | null | undefined)[]): string[] {
  const set = new Set<string>()
  for (const g of grants) {
    if (!g) continue
    for (const c of g) set.add(c)
  }
  return [...set]
}

/**
 * Write-gate test: is `requested ⊆ grant`? A `null`/`undefined` grant is the
 * universe (the principal is cleared into every compartment) → always true. An
 * empty `requested` ([]) is the empty set → always a subset (true). Returns the
 * keys in `requested` that fall OUTSIDE `grant` would be the violation set; this
 * boolean form is what the tool-executor write-gate needs.
 */
export function subsetCompartments(
  grant: string[] | null | undefined,
  requested: string[] | null | undefined,
): boolean {
  if (grant == null) return true // universe grant
  if (!requested || requested.length === 0) return true // ∅ ⊆ anything
  const grantSet = new Set(grant)
  return requested.every((c) => grantSet.has(c))
}
