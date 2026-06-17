import { normalizeName, jaroWinkler } from '../entities/resolver.js'

/**
 * Re-derivation matching (`docs/plans/skills-as-procedural-brain-primitive.md`
 * §5.2 + §10.4 — "the weakest spot in the trust math").
 *
 * Decides whether a newly-induced skill is a RE-DERIVATION of an existing one
 * (→ `recordRederivation`, raising confidence) versus genuinely new (→ create a
 * new suggested skill). Deliberately STRICT: prefer false negatives (a missed
 * match just keeps a skill suggested a little longer) over false positives
 * (merging two distinct procedures, which corrupts both).
 *
 * [COMP:skills/rederivation-match]
 */

export type InducedSkillCandidate = { slug: string; name: string; whenToUse?: string }
export type ExistingSkillForMatch = { rowId: string; slug: string; name: string; whenToUse?: string }

/** Name-similarity floor for treating an induced skill as a re-derivation. */
export const SKILL_REDERIVATION_NAME_THRESHOLD = 0.92
/** when_to_use similarity floor — guards same-name / different-trigger collisions. */
export const SKILL_REDERIVATION_TRIGGER_THRESHOLD = 0.8

/**
 * Match rules, in order:
 *   1. Exact slug match (case-insensitive) — unambiguous, always wins.
 *   2. High name similarity (jaroWinkler ≥ name threshold). When BOTH the
 *      candidate and the existing skill carry a when_to_use, that must also be
 *      similar (≥ trigger threshold), so "Weekly Update (investors)" and
 *      "Weekly Update (standup)" do not collapse into one.
 *
 * Returns the best existing match, or null when the induced skill is new.
 */
export function matchInducedSkill(
  candidate: InducedSkillCandidate,
  existing: readonly ExistingSkillForMatch[],
): ExistingSkillForMatch | null {
  const candSlug = candidate.slug.trim().toLowerCase()
  for (const e of existing) {
    if (e.slug.trim().toLowerCase() === candSlug) return e
  }

  const candName = normalizeName(candidate.name)
  const candWhen = candidate.whenToUse ? normalizeName(candidate.whenToUse) : null
  let best: ExistingSkillForMatch | null = null
  let bestScore = SKILL_REDERIVATION_NAME_THRESHOLD
  for (const e of existing) {
    const nameScore = jaroWinkler(candName, normalizeName(e.name))
    if (nameScore < bestScore) continue
    if (candWhen && e.whenToUse) {
      const whenScore = jaroWinkler(candWhen, normalizeName(e.whenToUse))
      if (whenScore < SKILL_REDERIVATION_TRIGGER_THRESHOLD) continue
    }
    best = e
    bestScore = nameScore
  }
  return best
}
