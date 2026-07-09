/**
 * Skill activation + confidence governance (`docs/architecture/engine/skill-system.md`
 * §"Governance — graded confidence").
 *
 * Confidence is a **graded trust meter** in [0,1], not a binary gate:
 *
 *   - `authored`  → a human wrote it: born certified (confidence 1.0, active, verified).
 *   - `self`      → induced from the team's own interaction and admitted through the
 *                   approval gate: born at MEDIUM confidence, active-but-uncertified.
 *   - `ingested`  → induced from ingested external content: born SUGGESTED (inactive),
 *                   the poisoning hard-bar — a human must eye the body before it runs.
 *
 * The meter moves on two axes:
 *   - **Usage + re-derivation** nudge it up SLIGHTLY (`+SKILL_USAGE_CONFIDENCE_INCREMENT`
 *     per corrected-free use / independent re-derivation) but are CAPPED at
 *     `SKILL_USAGE_CONFIDENCE_CAP` (< 1.0). Evidence alone can never certify a skill —
 *     this preserves the anti-poisoning intent (gaming usage tops out below full trust).
 *   - **Human confirmation** (the Confirm action, or a human edit of name/body — D2) is the
 *     ONLY path to `SKILL_ACTIVATION_THRESHOLD` (1.0): it stamps the verifier, lifts
 *     confidence to 1.0, and activates. So `confidence === 1.0 ⇔ a human certified it`.
 *
 * `shouldActivateSkill` models the human-gated induction path (every `store.create`
 * caller is human-gated: the approval-apply of a staged creation, or a user authoring a
 * skill directly). The curator's silent `createUmbrella` consolidation is NOT human-gated
 * and is born SUGGESTED by its own explicit insert (`workspace-curator-scope.ts`).
 *
 * [COMP:skills/activation-governance]
 */

export type SkillInductionSource = 'self' | 'ingested' | 'authored'

/**
 * The certified confidence. Reached ONLY by human confirmation / human edit — never by
 * usage or re-derivation. `confidence === SKILL_ACTIVATION_THRESHOLD ⇔ verified`.
 */
export const SKILL_ACTIVATION_THRESHOLD = 1.0

/** Birth confidence for a `self`-induced skill admitted through the approval gate:
 *  medium — usable and honest that it is not yet certified. */
export const SKILL_SELF_BORN_CONFIDENCE = 0.5

/** Confidence added per corrected-free invocation AND per independent re-derivation.
 *  Deliberately slight — evidence is a weak, gameable signal. */
export const SKILL_USAGE_CONFIDENCE_INCREMENT = 0.05

/** Ceiling that usage + re-derivation can raise confidence to. Strictly below the
 *  activation threshold: evidence approaches, but never reaches, full trust. */
export const SKILL_USAGE_CONFIDENCE_CAP = 0.9

/** Birth confidence by provenance tier. */
export function bornConfidence(inductionSource: SkillInductionSource): number {
  if (inductionSource === 'authored') return SKILL_ACTIVATION_THRESHOLD
  if (inductionSource === 'self') return SKILL_SELF_BORN_CONFIDENCE
  return 0.0 // ingested — the hard bar
}

/** Whether a skill is born ACTIVE (usable) vs SUGGESTED (needs a human's eyes first).
 *  `authored` + `self` are born active; `ingested` is born suggested. */
export function bornActivated(inductionSource: SkillInductionSource): boolean {
  return inductionSource !== 'ingested'
}

/** Whether birth itself certifies the skill. Only `authored` — a human writing the
 *  body IS the certification, so it is born verified at confidence 1.0. `self` is
 *  admitted (approved) but not yet certified; `ingested` is neither. */
export function bornVerified(inductionSource: SkillInductionSource): boolean {
  return inductionSource === 'authored'
}

/**
 * The next confidence after one corrected-free use or one independent re-derivation:
 * a slight bump, capped below full trust. Call ONLY for un-verified skills — a verified
 * skill sits at 1.0 and must not be dragged down to the cap.
 */
export function nextUsageConfidence(current: number): number {
  return Math.min(current + SKILL_USAGE_CONFIDENCE_INCREMENT, SKILL_USAGE_CONFIDENCE_CAP)
}

export type SkillActivationInputs = {
  inductionSource: SkillInductionSource
  /** True once any member has confirmed the skill (verified_by_user_id set). */
  humanConfirmed: boolean
}

/**
 * Whether a skill should be ACTIVE vs SUGGESTED, for the human-gated induction path.
 *   - human confirmed        → active (the strongest signal, any source)
 *   - `ingested`, unconfirmed → NEVER active (a human must eye the body first)
 *   - `authored` / `self`     → active (born active; `self` is active-but-uncertified)
 *
 * Note: activation is no longer confidence-gated — confidence is a separate graded
 * meter. A `self` skill is active from birth at medium confidence and stays active as
 * the meter climbs; only human confirmation moves it to certified (1.0).
 */
export function shouldActivateSkill(i: SkillActivationInputs): boolean {
  if (i.humanConfirmed) return true
  return bornActivated(i.inductionSource)
}
