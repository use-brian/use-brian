/**
 * Brand typography + rights registers → the Office template compiler.
 *
 * The compiler already refuses a font resource with no licence metadata and
 * one whose embedding rights are prohibited or unknown. Both checks are about
 * the *file*: is this font legally embeddable at all. Neither can answer the
 * question the brand record exists to answer — **is the company licensed for
 * this typeface**, which is a fact about the company, not about the bytes.
 *
 * ## Why it matches on families, not resources
 *
 * A font resource ref is `{id, kind, hash, mime, sensitivity}`. There is no
 * family name on it, so a template's embedded fonts cannot be compared to a
 * brand's typography register through the resource list at all. The families
 * live on the text styles, which is what `collectFontFamilies` walks.
 *
 * That also makes the check strictly better than a resource comparison would
 * be: it catches a family the template *uses* even when no font file was
 * embedded for it (the common case — a template referencing a system or
 * webfont family nobody licensed).
 *
 * ## Why these are warnings
 *
 * A brand record is built up over an engagement and is very often incomplete;
 * `naming.name` is the only required field. Failing template admission because
 * a workspace has not finished filling in its typography register would make
 * the brand primitive something people route around, and would block work that
 * is perfectly legitimate. The finding a human needs is "this template uses
 * Helvetica Neue and your brand record has never heard of it" — which is a
 * prompt, not a verdict.
 *
 * The compiler's own font checks stay errors. Those are about the file being
 * legally embeddable, which is not a judgment call.
 *
 * Spec: docs/architecture/features/brand.md → "Typography reaches the template compiler"
 *
 * [COMP:brand/typography-gate]
 */

import { collectFontFamilies, type OfficeArtifactSnapshot, type OfficePreflightDiagnostic } from '@use-brian/office-model'
import type { BrandRight, TypeRole } from '@use-brian/shared'

export type BrandTypographyContext = {
  /** The active approved record's typography register. */
  typography: readonly TypeRole[]
  /** The active approved record's rights register. */
  rights: readonly BrandRight[]
}

/** Case- and whitespace-insensitive family comparison. */
function foldFamily(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * CSS generic families. Nobody licenses `sans-serif`, so it is neither a
 * family a brand can "account for" nor one worth flagging as unaccounted —
 * skipped on BOTH sides of the comparison. Skipping it on only one side is
 * what made the first version of this check report `sans-serif` as an
 * unlicensed typeface.
 */
const GENERIC_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'inherit', 'initial',
])

/**
 * Families the brand accounts for: every `family`, plus every entry in a
 * `fallback` stack. Fallbacks count — a brand that declares
 * `fallback: "Helvetica Neue, Arial, sans-serif"` has considered those, and
 * flagging them would be noise on every template.
 */
function accountedFamilies(typography: readonly TypeRole[]): Map<string, TypeRole> {
  const out = new Map<string, TypeRole>()
  for (const role of typography) {
    out.set(foldFamily(role.family), role)
    for (const fallback of role.fallback.split(',')) {
      const folded = foldFamily(fallback)
      if (folded.length === 0 || GENERIC_FAMILIES.has(folded)) continue
      if (!out.has(folded)) out.set(folded, role)
    }
  }
  return out
}

export function reviewBrandTypography(params: {
  snapshot: OfficeArtifactSnapshot
  brand: BrandTypographyContext
}): OfficePreflightDiagnostic[] {
  const { typography, rights } = params.brand
  // An empty register is "not captured yet", not "nothing is licensed".
  // Warning on every family would make the check pure noise for the many
  // workspaces whose brand record is still a name and a tagline.
  if (typography.length === 0) return []

  const accounted = accountedFamilies(typography)
  const rightsAssets = new Set(rights.map((r) => foldFamily(r.asset)))
  const diagnostics: OfficePreflightDiagnostic[] = []

  for (const family of collectFontFamilies(params.snapshot)) {
    const folded = foldFamily(family)
    if (GENERIC_FAMILIES.has(folded)) continue
    const role = accounted.get(folded)

    if (!role) {
      // A rights entry naming the typeface is enough — a brand can license a
      // face for one artifact without giving it a standing type role.
      if (rightsAssets.has(folded)) continue
      diagnostics.push({
        severity: 'warning',
        code: 'template.brand_font_unlisted',
        path: `snapshot.fonts.${family}`,
        message: `This template uses "${family}", which the brand record's typography and rights registers do not list. Confirm the workspace is licensed for it, or add it to the brand record.`,
      })
      continue
    }

    if (!role.licence || role.licence.trim().length === 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'template.brand_font_licence_unrecorded',
        path: `snapshot.fonts.${family}`,
        message: `The brand record lists "${family}" for the "${role.role}" role but records no licence for it. Add the licence so an admitted template carries its provenance.`,
      })
    }
  }

  return diagnostics
}
