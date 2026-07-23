import { normalizeName, jaroWinkler } from '../entities/resolver.js'

/**
 * Re-derivation matching (`docs/architecture/engine/skill-system.md`
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

// ── Workflow-subsumption gate (origin-aware induction) ───────────────

export type WorkflowForSkillMatch = { id: string; name: string }

/** Containment only counts when the shorter normalized name is at least this
 *  long — "sync" ⊂ "daily sync report" must not trigger subsumption. */
const SUBSUMPTION_CONTAINMENT_MIN_LENGTH = 8

/**
 * The novelty gate for skill candidates induced from a workflow-origin
 * session (`docs/architecture/engine/skill-system.md` → "Origin-aware
 * induction"). A candidate whose name mirrors an ACTIVE workflow is not new
 * knowledge — the workflow definition already encodes the procedure — so the
 * curator must not stage it. Match rules, in order:
 *
 *   1. High name similarity (jaroWinkler ≥ threshold) against a workflow name.
 *   2. Containment: one normalized name contains the other and the shorter is
 *      ≥ SUBSUMPTION_CONTAINMENT_MIN_LENGTH chars — catches the canonical
 *      "<workflow name> workflow"-shaped mirror where token-level similarity
 *      dips below the strict threshold.
 *
 * Like `matchInducedSkill` this stays name-based and strict: a false negative
 * only lets a redundant card reach the (human-gated) queue, while a false
 * positive would silently discard a genuinely novel technique.
 */
export function matchSkillAgainstWorkflows(
  candidate: { name: string },
  workflows: readonly WorkflowForSkillMatch[],
): WorkflowForSkillMatch | null {
  const candName = normalizeName(candidate.name)
  if (!candName) return null
  let best: WorkflowForSkillMatch | null = null
  // Same similarity bar as skill↔skill re-derivation — the mirror case
  // ("Daily team standup workflow" from the "Daily team standup" workflow's
  // own session) clears via containment even when the score alone would not.
  let bestScore = SKILL_REDERIVATION_NAME_THRESHOLD
  for (const w of workflows) {
    const wfName = normalizeName(w.name)
    if (!wfName) continue
    const shorter = candName.length <= wfName.length ? candName : wfName
    const longer = candName.length <= wfName.length ? wfName : candName
    if (shorter.length >= SUBSUMPTION_CONTAINMENT_MIN_LENGTH && longer.includes(shorter)) {
      return w
    }
    const score = jaroWinkler(candName, wfName)
    if (score >= bestScore) {
      best = w
      bestScore = score
    }
  }
  return best
}
