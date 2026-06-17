/**
 * Decision logic for a classifier registry.
 *
 * Inputs: matches from positive rules + blocks from negative rules.
 * Output: a single `ClassifierDecision<T>` per the escalation ladder.
 *
 * Spec: docs/architecture/brain/classification/README.md §Tier model,
 * §Conflict resolution.
 */

import type {
  ClassifierBlock,
  ClassifierDecision,
  ClassifierMatch,
} from './types.js'
import { DEFAULT_HINT_FLOOR } from './types.js'

export type DecideOptions = {
  /** Drop probabilistic matches below this confidence from the decision. */
  hintFloor?: number
}

/**
 * Resolve raw matches + blocks into a single decision.
 *
 * Ladder:
 *   1. Apply negative rules — drop any positive match whose value
 *      appears in a block at the same-or-higher tier.
 *   2. If any deterministic positive survives → kind: 'override' with
 *      the highest-confidence deterministic (specificity / registration
 *      order tiebreaks).
 *   3. Else if any probabilistic positive survives above the hint floor
 *      → kind: 'hint' with the surviving set sorted desc by confidence.
 *   4. Else if any block fired → kind: 'blocked' with the blocks.
 *   5. Else → kind: 'no_signal'.
 */
export function decide<T extends string>(
  matches: ClassifierMatch<T>[],
  blocks: ClassifierBlock<T>[],
  options: DecideOptions = {},
): ClassifierDecision<T> {
  const hintFloor = options.hintFloor ?? DEFAULT_HINT_FLOOR

  // Negative rules suppress positives at the same-or-lower tier.
  // Implementation: a deterministic block suppresses both deterministic
  // and probabilistic positives producing that value; a probabilistic
  // block only suppresses probabilistic positives.
  const detBlocked = new Set<string>()
  const probBlocked = new Set<string>()
  for (const b of blocks) {
    if (b === undefined) continue
    // ClassifierBlock has no tier field today; the rule that produced it
    // does — but blocks come in already-resolved. To preserve the same-
    // tier-only semantics, the caller is expected to tag block.reason
    // with the tier; for v1 we treat all blocks as deterministic (they
    // suppress everything matching). Probabilistic negative rules are
    // not yet a feature; revisit when introduced.
    for (const v of b.blocked) {
      detBlocked.add(v)
      probBlocked.add(v)
    }
  }

  const survivingDet: ClassifierMatch<T>[] = []
  const survivingProb: ClassifierMatch<T>[] = []
  for (const m of matches) {
    if (m.tier === 'deterministic') {
      if (!detBlocked.has(m.value)) survivingDet.push(m)
    } else {
      if (!probBlocked.has(m.value) && m.confidence >= hintFloor) {
        survivingProb.push(m)
      }
    }
  }

  if (survivingDet.length > 0) {
    return { kind: 'override', match: pickBest(survivingDet) }
  }
  if (survivingProb.length > 0) {
    survivingProb.sort((a, b) => b.confidence - a.confidence)
    return blocks.length > 0
      ? { kind: 'hint', matches: survivingProb, suppressedBy: blocks }
      : { kind: 'hint', matches: survivingProb }
  }
  if (blocks.length > 0) {
    return { kind: 'blocked', suppressedBy: blocks }
  }
  return { kind: 'no_signal' }
}

/**
 * Pick the winning match among same-tier candidates.
 *   1. Highest confidence.
 *   2. Tie → highest specificity (default 1 on the rule, surfaced via
 *      the match — but ClassifierMatch doesn't carry specificity; the
 *      registry preserves rule order so first-registered wins on tie).
 *   3. Stable on registration order (input array order preserved).
 */
function pickBest<T extends string>(ms: ClassifierMatch<T>[]): ClassifierMatch<T> {
  let best = ms[0]!
  for (let i = 1; i < ms.length; i++) {
    const m = ms[i]!
    if (m.confidence > best.confidence) best = m
  }
  return best
}
