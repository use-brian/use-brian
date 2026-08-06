/**
 * The brand record — one typed, versioned positioning document per brand.
 *
 * This is the canonical schema every writer validates against: the Studio
 * draft editor (app-web), the `updateBrandDraft` chat tool, the brain-MCP
 * `saveBrandDraft` bridge, and the `/api/workspaces/:id/brand` routes. One
 * schema, four writers — a second hand-written shape is exactly how the
 * palette repo's markdown template and its TypeScript type drifted apart
 * (docs/plans/brand-primitive.md §1 evidence 2).
 *
 * Lives in `packages/shared` and is dependency-free apart from zod, so the
 * browser bundle can import it for client-side form validation. Precedent:
 * `packages/shared/src/doc-theme/build-tokens.ts`.
 *
 * ## What belongs here (and what does not)
 *
 * The record holds machine-consumable positioning data: tokens, bindings,
 * claims, rights, lifecycle status, and *short* strategy/messaging text.
 * Long-form prose — briefs, identity guides, consultation narrative — stays
 * in the knowledge base and is referenced from `sources[]` (decision D2).
 * The record must stay digest-sized: it is the input to the L1 `# Brand`
 * prompt block, which is capped at ~2,500 characters.
 *
 * Explicitly excluded (they live in the presentation portal or the KB):
 * `hero`, `slug`/`theme` presentation keys, `executiveSummary`,
 * `statusBoard`, the whole `designSystem` section, `readiness.areas`, and
 * `governance.roadmap`.
 *
 * ## Strictness
 *
 * Every object is `.strict()`: an unknown key fails validation rather than
 * being silently dropped. A field group that is absent means "not captured
 * yet" — only `naming.name` is required, because a brand with no name is not
 * a brand. Array fields default to `[]` so a partial group validates without
 * enumerating every list.
 *
 * Spec: docs/architecture/features/brand.md
 * Plan: docs/plans/brand-primitive.md §4 (the authoritative field list)
 *
 * [COMP:brand/record-schema]
 */

import { z } from 'zod'

// ── Shared scalars ────────────────────────────────────────────────────────

const shortText = z.string().trim().min(1).max(200)
const line = z.string().trim().min(1).max(500)
const paragraph = z.string().trim().min(1).max(2000)
const shortList = z.array(shortText).max(40)
const lineList = z.array(line).max(40)

/**
 * Decision status on a brand *choice* — a color token, an application.
 *
 * Ported verbatim from the palette portal's `DecisionStatus`
 * (`tools/brand-portal/site/src/lib/brand-types.ts`), which the markdown
 * template also carries ("Status: observed / recommended / approved / open").
 *
 * This is NOT the asset-production lifecycle
 * (`exploration → shortlisted → approved master → superseded`). That one is
 * carried structurally by the record lifecycle itself: an unapproved
 * direction has no approved version, so the whole record stays a draft. See
 * docs/architecture/features/brand.md → "Two vocabularies".
 */
export const DECISION_STATUSES = ['observed', 'recommended', 'approved', 'open'] as const
export type DecisionStatus = (typeof DECISION_STATUSES)[number]

/**
 * Claim status. Distinct from `DecisionStatus` on purpose: a claim is a
 * factual assertion about the company that can be made in copy, so its axis
 * is evidentiary (is it substantiated?), not deliberative (is it decided?).
 * `prohibited` is the load-bearing value — the future Office release gate
 * reads it to refuse a generated artifact that repeats a banned claim.
 */
export const CLAIM_STATUSES = ['approved', 'unverified', 'prohibited'] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

/** Logo variants the markdown template's logo table enumerates. */
export const LOGO_VARIANTS = ['primary', 'compact', 'reversed', 'oneColor', 'favicon', 'other'] as const
export type LogoVariantKind = (typeof LOGO_VARIANTS)[number]

/** Application kinds — what a brand system gets applied to. */
export const APPLICATION_KINDS = [
  'logo',
  'letterhead',
  'invoice',
  'presentation',
  'businessCard',
  'social',
  'web',
  'other',
] as const
export type ApplicationKind = (typeof APPLICATION_KINDS)[number]

// ── Group: naming ─────────────────────────────────────────────────────────

/**
 * Naming and legal usage. `capitalization` and `restrictedTerms` are
 * per-turn writing rules, so they ride the L1 digest — an assistant that
 * writes "UseBrian" when the rule says "Use Brian" is the failure this group
 * exists to prevent.
 */
export const BrandNamingSchema = z
  .object({
    /** The only required field in the whole record. */
    name: shortText,
    /** Customer-facing name when it differs from `name`. */
    publicName: shortText.optional(),
    /** Registered entity name, for contracts and footers. */
    legalName: shortText.optional(),
    /** The category noun that follows the name ("the AI company brain"). */
    descriptor: line.optional(),
    /** Exact casing rule, e.g. "Use Brian - two words, both capitalized". */
    capitalization: line.optional(),
    pronunciation: line.optional(),
    tagline: line.optional(),
    domains: shortList.default([]),
    handles: shortList.default([]),
    trademarkStatus: line.optional(),
    /** Terms copy must never use (competitor names, retired product names). */
    restrictedTerms: shortList.default([]),
  })
  .strict()

// ── Group: strategy ───────────────────────────────────────────────────────

export const BrandStrategySchema = z
  .object({
    purpose: paragraph.optional(),
    mission: paragraph.optional(),
    vision: paragraph.optional(),
    audience: lineList.default([]),
    positioning: paragraph.optional(),
    promise: paragraph.optional(),
    differentiators: lineList.default([]),
    personality: shortList.default([]),
    /** What the brand is deliberately NOT - the anti-personality. */
    notPersonality: shortList.default([]),
  })
  .strict()

// ── Group: messaging ──────────────────────────────────────────────────────

export const MessagePillarSchema = z
  .object({
    title: shortText,
    statement: paragraph,
    proof: lineList.default([]),
  })
  .strict()

/**
 * One voice trait. The `{trait, means, avoid}` triple is what makes voice
 * actionable in a prompt: "Direct" alone is decoration, "Direct - means lead
 * with the answer; avoid throat-clearing preambles" is an instruction.
 */
export const VoiceTraitSchema = z
  .object({
    trait: shortText,
    means: line,
    avoid: line,
  })
  .strict()

export const BrandLocaleNotesSchema = z
  .object({
    en: paragraph.optional(),
    ja: paragraph.optional(),
    zh: paragraph.optional(),
  })
  .strict()

export const BrandMessagingSchema = z
  .object({
    /** The one-sentence positioning line. Highest-priority digest field. */
    oneLine: line.optional(),
    elevator: paragraph.optional(),
    supportingLine: line.optional(),
    pillars: z.array(MessagePillarSchema).max(12).default([]),
    voice: z.array(VoiceTraitSchema).max(12).default([]),
    toneNotes: lineList.default([]),
    /** Vocabulary to prefer in copy. */
    preferred: shortList.default([]),
    /** Vocabulary to avoid in copy. */
    avoid: shortList.default([]),
    localeNotes: BrandLocaleNotesSchema.optional(),
  })
  .strict()

// ── Group: colors ─────────────────────────────────────────────────────────

/**
 * An approved foreground/background contrast pair. The markdown template
 * carries this column and the portal's `ColorToken` dropped it; it is the
 * one accessibility fact a generator cannot re-derive from hex values alone
 * (it encodes which pairings the brand has actually signed off on).
 */
export const ContrastPairSchema = z
  .object({
    foreground: shortText,
    background: shortText,
    /** Measured ratio, e.g. "7.1:1", plus the standard it meets. */
    ratio: shortText.optional(),
    usage: line.optional(),
  })
  .strict()

export const ColorTokenSchema = z
  .object({
    name: shortText,
    /** Design-token identifier, e.g. "--brand-ink". */
    token: shortText,
    /** The value as authored - hex, rgb(), or a token reference. */
    value: shortText,
    /** Where it is used, e.g. "primary surface", "accent". */
    role: line,
    status: z.enum(DECISION_STATUSES).optional(),
    contrastPairs: z.array(ContrastPairSchema).max(20).optional(),
  })
  .strict()

// ── Group: typography ─────────────────────────────────────────────────────

export const TypeRoleSchema = z
  .object({
    /** e.g. "display", "body", "mono". */
    role: shortText,
    family: shortText,
    /** Weight / size / tracking guidance for this role. */
    treatment: line,
    fallback: shortText,
    /** Licence the family ships under - the template compiler's input. */
    licence: line.optional(),
    /** Where the licence or the font files came from. */
    source: line.optional(),
  })
  .strict()

// ── Group: logoVariants ───────────────────────────────────────────────────

export const LogoVariantSchema = z
  .object({
    variant: z.enum(LOGO_VARIANTS),
    /**
     * `workspace_files.id` of the approved master. Binding by id - not by
     * path or prose - is what makes "attach the approved logo" deterministic
     * (decision D7).
     */
    fileId: z.string().uuid().optional(),
    /** Minimum reproduction size, e.g. "24px tall on screen". */
    minSize: line.optional(),
    /** Backgrounds this variant is cleared for. */
    backgrounds: shortList.optional(),
    clearSpace: line.optional(),
    notes: line.optional(),
  })
  .strict()

// ── Group: visual ─────────────────────────────────────────────────────────

export const BrandVisualSchema = z
  .object({
    logoRules: lineList.default([]),
    visualPrinciples: lineList.default([]),
    imagery: lineList.default([]),
    motion: lineList.default([]),
  })
  .strict()

// ── Group: applications ───────────────────────────────────────────────────

/**
 * Where an application's artifact actually lives. A typed binding replaces
 * the portal's `preview` / `download` href pair: a workspace file, an Office
 * template at a specific version, or an external URL.
 */
export const ApplicationBindingSchema = z.union([
  z.object({ fileId: z.string().uuid() }).strict(),
  z.object({ officeTemplateId: z.string().uuid(), version: z.number().int().min(1) }).strict(),
  z.object({ url: z.string().url().max(2048) }).strict(),
])

export const BrandApplicationSchema = z
  .object({
    name: shortText,
    kind: z.enum(APPLICATION_KINDS),
    status: z.enum(DECISION_STATUSES),
    binding: ApplicationBindingSchema.optional(),
    notes: line.optional(),
  })
  .strict()

// ── Group: claims ─────────────────────────────────────────────────────────

export const BrandClaimSchema = z
  .object({
    text: line,
    status: z.enum(CLAIM_STATUSES),
    /** What substantiates it - an audit, a metric, a customer count. */
    evidence: paragraph.optional(),
  })
  .strict()

// ── Group: rights ─────────────────────────────────────────────────────────

export const BrandRightSchema = z
  .object({
    /** What the right covers - a typeface, a photo set, an illustration. */
    asset: shortText,
    creator: shortText,
    licence: line,
    restrictions: paragraph.optional(),
    /** `workspace_files.id` of the licence document itself. */
    evidenceFileId: z.string().uuid().optional(),
  })
  .strict()

// ── Group: governance ─────────────────────────────────────────────────────

export const BrandGovernanceSchema = z
  .object({
    owner: shortText.optional(),
    /** e.g. "quarterly". */
    reviewCadence: shortText.optional(),
    /** ISO date (YYYY-MM-DD) of the next scheduled review. */
    nextReview: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'nextReview must be an ISO date (YYYY-MM-DD)')
      .optional(),
    rules: lineList.default([]),
    openDecisions: lineList.default([]),
  })
  .strict()

// ── Group: sources ────────────────────────────────────────────────────────

/**
 * Provenance link back to the long-form material this record condenses.
 * `kbPath` points at a knowledge-base entry, `fileId` at a workspace file,
 * `url` at anything external. At least one locator is required - a source
 * with no locator is a note, not a source.
 */
export const BrandSourceSchema = z
  .object({
    label: shortText,
    kbPath: z.string().trim().min(1).max(512).optional(),
    fileId: z.string().uuid().optional(),
    url: z.string().url().max(2048).optional(),
    /** What this source contributed to the record. */
    contribution: line,
  })
  .strict()
  .refine(
    (s) => Boolean(s.kbPath || s.fileId || s.url),
    { message: 'a source needs at least one of kbPath, fileId, or url' },
  )

// ── The record ────────────────────────────────────────────────────────────

export const BrandRecordSchema = z
  .object({
    naming: BrandNamingSchema,
    strategy: BrandStrategySchema.optional(),
    messaging: BrandMessagingSchema.optional(),
    colors: z.array(ColorTokenSchema).max(120).default([]),
    typography: z.array(TypeRoleSchema).max(40).default([]),
    logoVariants: z.array(LogoVariantSchema).max(20).default([]),
    visual: BrandVisualSchema.optional(),
    applications: z.array(BrandApplicationSchema).max(60).default([]),
    claims: z.array(BrandClaimSchema).max(120).default([]),
    rights: z.array(BrandRightSchema).max(60).default([]),
    governance: BrandGovernanceSchema.optional(),
    sources: z.array(BrandSourceSchema).max(60).default([]),
  })
  .strict()

export type BrandRecord = z.infer<typeof BrandRecordSchema>
export type BrandNaming = z.infer<typeof BrandNamingSchema>
export type BrandStrategy = z.infer<typeof BrandStrategySchema>
export type BrandMessaging = z.infer<typeof BrandMessagingSchema>
export type BrandVisual = z.infer<typeof BrandVisualSchema>
export type BrandGovernance = z.infer<typeof BrandGovernanceSchema>
export type ColorToken = z.infer<typeof ColorTokenSchema>
export type TypeRole = z.infer<typeof TypeRoleSchema>
export type LogoVariant = z.infer<typeof LogoVariantSchema>
export type MessagePillar = z.infer<typeof MessagePillarSchema>
export type VoiceTrait = z.infer<typeof VoiceTraitSchema>
export type ContrastPair = z.infer<typeof ContrastPairSchema>
export type BrandApplication = z.infer<typeof BrandApplicationSchema>
export type ApplicationBinding = z.infer<typeof ApplicationBindingSchema>
export type BrandClaim = z.infer<typeof BrandClaimSchema>
export type BrandRight = z.infer<typeof BrandRightSchema>
export type BrandSource = z.infer<typeof BrandSourceSchema>

/**
 * The record's field groups, in the order the Studio editor renders them and
 * the order `updateBrandDraft` documents. Exported so a partial-update caller
 * enumerates groups from one place instead of re-listing them.
 */
export const BRAND_RECORD_GROUPS = [
  'naming',
  'strategy',
  'messaging',
  'colors',
  'typography',
  'logoVariants',
  'visual',
  'applications',
  'claims',
  'rights',
  'governance',
  'sources',
] as const
export type BrandRecordGroup = (typeof BRAND_RECORD_GROUPS)[number]

/**
 * Partial-update shape: every group optional, validated with the same rules
 * as the full record. This is what `updateBrandDraft` and the draft-upsert
 * route accept — a caller patches `messaging` without resending `colors`.
 *
 * Spelled out rather than derived via `.partial()` so the array caps stay
 * visible next to the group they bound, and so a patch never inherits a
 * `.default([])` — an absent group in a patch means "leave it alone", which
 * is the opposite of the empty array a default would substitute.
 */
export const BrandRecordPatchSchema = z
  .object({
    naming: BrandNamingSchema.optional(),
    strategy: BrandStrategySchema.optional(),
    messaging: BrandMessagingSchema.optional(),
    colors: z.array(ColorTokenSchema).max(120).optional(),
    typography: z.array(TypeRoleSchema).max(40).optional(),
    logoVariants: z.array(LogoVariantSchema).max(20).optional(),
    visual: BrandVisualSchema.optional(),
    applications: z.array(BrandApplicationSchema).max(60).optional(),
    claims: z.array(BrandClaimSchema).max(120).optional(),
    rights: z.array(BrandRightSchema).max(60).optional(),
    governance: BrandGovernanceSchema.optional(),
    sources: z.array(BrandSourceSchema).max(60).optional(),
  })
  .strict()

export type BrandRecordPatch = z.infer<typeof BrandRecordPatchSchema>

/**
 * Merge a patch onto a draft, group by group.
 *
 * Group-level replacement, NOT a deep merge: passing `messaging` replaces the
 * whole messaging group. Deep-merging arrays has no defensible semantics
 * (does a 2-item `voice` patch append, replace by index, or replace whole?)
 * and a model that means "add one voice trait" can read the record first —
 * `getBrand` exists for exactly that. Group replacement is the rule the tool
 * description states, so the model's mental model matches the code.
 *
 * Returns an unvalidated object; the caller validates with
 * `BrandRecordSchema` so a patch that leaves the draft invalid is rejected
 * at the same chokepoint a whole-record write would be.
 */
export function mergeBrandRecordPatch(
  base: BrandRecord | null,
  patch: BrandRecordPatch,
): Record<string, unknown> {
  const merged: Record<string, unknown> = base ? { ...base } : {}
  for (const group of BRAND_RECORD_GROUPS) {
    const value = patch[group]
    if (value !== undefined) merged[group] = value
  }
  return merged
}

/**
 * The seed a brand row starts from when it is created with a name only.
 * Kept here (not in the store) so the Studio "new brand" form, the routes,
 * and the tools all begin from the same shape.
 */
export function emptyBrandRecord(name: string): BrandRecord {
  return BrandRecordSchema.parse({ naming: { name } })
}
