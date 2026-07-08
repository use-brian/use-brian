/**
 * Skill activation governance (`docs/architecture/engine/skill-system.md`
 * §5.2-5.3).
 *
 * Confidence-gated activation is the moat: authored skills are born active;
 * auto-induced skills are born SUGGESTED (scoped to the originating assistant,
 * offered-not-auto-invoked) and earn activation only via:
 *   1. human confirmation, or
 *   2. independent re-derivation (the same skill induced from N distinct episodes).
 *
 * Raw usage (invocations / succeeded / absence-of-correction) NEVER raises
 * confidence — it is gameable / poison-prone (feeds demotion only). And
 * `ingested`-source skills (induced from ingested external content) can ONLY be
 * activated by human confirmation — re-derivation alone never activates them
 * (the shared-brain poisoning defense, §5.3).
 *
 * [COMP:skills/activation-governance]
 */

/** A skill is active (freely invocable) once confidence reaches this. */
export const SKILL_ACTIVATION_THRESHOLD = 1.0

/**
 * Confidence added per independent re-derivation. With the threshold at 1.0,
 * two independent re-derivations activate a `self`-source skill (plan §5.2
 * "default 2 additional independent derivations").
 */
export const SKILL_REDERIVATION_INCREMENT = 0.5

export type SkillInductionSource = 'self' | 'ingested' | 'authored'

export type SkillActivationInputs = {
  inductionSource: SkillInductionSource
  confidence: number
  /** True once any member has confirmed the skill (verified_by_user_id set). */
  humanConfirmed: boolean
}

/**
 * Whether a skill should be ACTIVE vs SUGGESTED.
 *   - `authored`            → always active (a human wrote it)
 *   - human confirmed       → active (any source — confirmation is the strongest signal)
 *   - `ingested`, unconfirmed → NEVER active (re-derivation cannot activate it)
 *   - `self`, unconfirmed   → active iff confidence ≥ threshold
 */
export function shouldActivateSkill(i: SkillActivationInputs): boolean {
  if (i.inductionSource === 'authored') return true
  if (i.humanConfirmed) return true
  if (i.inductionSource === 'ingested') return false
  return i.confidence >= SKILL_ACTIVATION_THRESHOLD
}
