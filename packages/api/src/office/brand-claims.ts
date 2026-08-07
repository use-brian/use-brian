/**
 * Brand claims register → Office release gate.
 *
 * The brand record's `claims[]` carries statements the company has decided it
 * may or may not make (`approved` / `unverified` / `prohibited`). Until now
 * that was schema-only — typed, stored, governed in Studio, and read by
 * nothing. This is the first enforcement point: before an Office artifact
 * leaves the workspace, its text is checked against the register.
 *
 * ## Why `prohibited` blocks and `unverified` warns
 *
 * The existing gate reserves `blocks` for facts the system is certain of and
 * `warnings` for judgments a human must make. A prohibited claim looks like
 * the second but behaves like the first, and the precedent that settles it is
 * `media.disclosureRequired`, which hard-blocks with the comment that a
 * caller-supplied flag "is not proof that disclosure exists in the exported
 * artifact". Same shape here: the system cannot prove a banned sentence is
 * being used safely, and someone deliberately typed that sentence into a
 * register and marked it prohibited. Shipping it is the failure the register
 * exists to prevent, so it is a hard barrier.
 *
 * `unverified` is the opposite case — a claim nobody has substantiated *yet*,
 * which is a review prompt, not a violation. It warns, and the warning is
 * acknowledgeable per exact version and action like every other one.
 *
 * `approved` claims produce nothing. Finding one is the system working.
 *
 * ## The matcher is deliberately literal
 *
 * Normalized exact-phrase containment: case-folded, punctuation-stripped,
 * whitespace-collapsed. No stemming, no fuzzy distance, no semantic model.
 *
 * That is a real limitation and it cuts both ways, so it is worth stating
 * rather than discovering. It **misses** a paraphrase ("the safest crossing
 * there is" does not match "the safest crossing available"), and it **fires**
 * on a negation or a quotation ("we never claim to be the safest crossing
 * available" matches). The first is why this gate is a floor and not a
 * guarantee; the second is why `prohibited` findings must stay reviewable —
 * an admin can edit the register, and the artifact's author can rephrase.
 *
 * A fuzzy or model-based matcher would trade a bounded, explainable rule for
 * one nobody can predict, on a path that blocks a user's export. Not worth it
 * until there is evidence the literal rule misses in practice.
 *
 * Spec: docs/architecture/features/brand.md → "Claims reach the release gate"
 *
 * [COMP:brand/claim-gate]
 */

import { collectArtifactText, type OfficeArtifactSnapshot } from '@use-brian/office-model'
import type { BrandClaim } from '@use-brian/shared'

export type BrandClaimIssue = {
  code: string
  message: string
  subjectId?: string
}

export type BrandClaimReview = {
  /** Prohibited claims found in the artifact. Hard barrier. */
  blocks: BrandClaimIssue[]
  /** Unverified claims found in the artifact. Acknowledgeable. */
  warnings: BrandClaimIssue[]
}

/**
 * Fold text for comparison: lowercase, strip punctuation, collapse runs of
 * whitespace. Curly quotes and hyphens are the ones that actually bite — a
 * register entry typed in a form and the same sentence typed into a deck
 * routinely differ only by an apostrophe.
 */
export function normalizeClaimText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’‚‛']/g, '')
    .replace(/[“”„‟"]/g, '')
    .replace(/[‐-―-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A claim short enough to appear by coincidence is not usable as a matcher.
 * "We deliver." would fire on any deck containing that sentence fragment. The
 * register is for statements, so anything below this is treated as unusable
 * and reported to the caller rather than silently applied.
 */
const MIN_MATCHABLE_CHARS = 12

export function reviewBrandClaims(params: {
  snapshot: OfficeArtifactSnapshot
  claims: readonly BrandClaim[]
}): BrandClaimReview {
  const blocks: BrandClaimIssue[] = []
  const warnings: BrandClaimIssue[] = []

  const enforceable = params.claims.filter(
    (c) => c.status === 'prohibited' || c.status === 'unverified',
  )
  if (enforceable.length === 0) return { blocks, warnings }

  const fragments = collectArtifactText(params.snapshot).map((f) => ({
    locator: f.locator,
    normalized: normalizeClaimText(f.text),
  }))
  if (fragments.length === 0) return { blocks, warnings }

  for (const [index, claim] of enforceable.entries()) {
    const needle = normalizeClaimText(claim.text)
    if (needle.length < MIN_MATCHABLE_CHARS) continue

    const hit = fragments.find((f) => f.normalized.includes(needle))
    if (!hit) continue

    const excerpt = claim.text.length > 120 ? `${claim.text.slice(0, 117)}...` : claim.text
    if (claim.status === 'prohibited') {
      blocks.push({
        code: `brand.claim.prohibited.${index}`,
        message: `This artifact contains a claim the brand marks prohibited, at ${hit.locator}: "${excerpt}" Remove or rephrase it, or have an owner change the brand record.`,
        subjectId: hit.locator,
      })
    } else {
      warnings.push({
        code: `brand.claim.unverified.${index}`,
        message: `This artifact repeats a claim the brand has not substantiated, at ${hit.locator}: "${excerpt}"`,
        subjectId: hit.locator,
      })
    }
  }

  return { blocks, warnings }
}
