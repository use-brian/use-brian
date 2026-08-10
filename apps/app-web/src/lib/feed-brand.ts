/**
 * Pure mappers from the approved brand record onto what the Feed renders
 * (feed-revamp-depth D36-D38).
 *
 * All pure and all null-tolerant, because every Feed brand consumer is
 * optional: a workspace with no brand, or one whose brand is still a draft,
 * must render exactly what it rendered before this existed.
 *
 * [COMP:app-web/feed-brand]
 */

import type { BrandRecord } from "@use-brian/shared/brand";

export type BrandPreviewIdentity = {
  /** The name a platform would show. */
  displayName: string | null;
  /**
   * The real handle, or null. Deliberately nullable: before this, the preview
   * INVENTED one by lowercasing the assistant name, so a workspace whose real
   * handle differed saw a confident lie on the one surface whose job is
   * showing how the post will look in public. No handle now renders no handle.
   */
  handle: string | null;
  /** `workspace_files` id of the logo to use as the avatar, or null. */
  logoFileId: string | null;
};

export function brandPreviewIdentity(
  brand: BrandRecord | null,
): BrandPreviewIdentity {
  if (!brand) return { displayName: null, handle: null, logoFileId: null };
  const naming = brand.naming;
  const handle = naming.handles?.[0]?.trim() ?? "";
  return {
    displayName: naming.publicName?.trim() || naming.name?.trim() || null,
    handle: handle ? handle.replace(/^@/, "") : null,
    logoFileId: brandLogoFileId(brand),
  };
}

/**
 * The compact logo if the brand has one, else the primary. A preview avatar is
 * a 36px circle; a full lockup is unreadable there, which is exactly what the
 * `compact` variant exists for.
 */
export function brandLogoFileId(brand: BrandRecord | null): string | null {
  if (!brand) return null;
  const variants = brand.logoVariants ?? [];
  const pick =
    variants.find((v) => v.variant === "compact" && v.fileId) ??
    variants.find((v) => v.variant === "primary" && v.fileId) ??
    variants.find((v) => v.fileId);
  return pick?.fileId ?? null;
}

// ── Brand check (D38) ───────────────────────────────────────────────────────

export type BrandCopyFlag = {
  /** The phrase as the brand wrote it, for the operator to recognise. */
  phrase: string;
  kind: "restricted" | "avoid" | "claim";
};

/** Fold case, collapse whitespace, drop punctuation that varies by keyboard. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Phrases shorter than this are skipped. A 4-character restricted term like
 * "best" matches inside "bestseller" and every other innocent word, and a
 * check that cries wolf is one the operator learns to ignore -- which costs
 * more than not having it.
 */
const MIN_PHRASE = 12;

/**
 * Literal, case-folded, exact-phrase containment. The same discipline as the
 * Office claim gate, and deliberately not fuzzy: this WARNS and never blocks
 * (D38), so a false positive is a cost with no upside. The operator is the
 * author, not the suspect.
 */
export function brandCopyFlags(
  brand: BrandRecord | null,
  text: string,
): BrandCopyFlag[] {
  if (!brand || !text.trim()) return [];
  const haystack = normalize(text);
  if (!haystack) return [];

  const candidates: BrandCopyFlag[] = [
    ...(brand.naming.restrictedTerms ?? []).map((phrase) => ({
      phrase,
      kind: "restricted" as const,
    })),
    ...(brand.messaging?.avoid ?? []).map((phrase) => ({
      phrase,
      kind: "avoid" as const,
    })),
    ...(brand.claims ?? [])
      .filter((c) => c.status === "prohibited")
      .map((c) => ({ phrase: c.text, kind: "claim" as const })),
  ];

  const seen = new Set<string>();
  const flags: BrandCopyFlag[] = [];
  for (const candidate of candidates) {
    const needle = normalize(candidate.phrase);
    if (needle.length < MIN_PHRASE) continue;
    if (seen.has(needle)) continue;
    if (haystack.includes(needle)) {
      seen.add(needle);
      flags.push(candidate);
    }
  }
  return flags;
}

/** The read-only voice block on `/feed/voice` (D37). */
export function brandVoiceSummary(brand: BrandRecord | null): {
  traits: { trait: string; means: string; avoid: string }[];
  toneNotes: string[];
  capitalization: string | null;
} | null {
  if (!brand?.messaging) return null;
  const traits = brand.messaging.voice ?? [];
  const toneNotes = brand.messaging.toneNotes ?? [];
  const capitalization = brand.naming.capitalization?.trim() || null;
  if (traits.length === 0 && toneNotes.length === 0 && !capitalization) {
    return null;
  }
  return { traits, toneNotes, capitalization };
}

/** Message pillars, offered as one-click month themes in the Plan rail. */
export function brandPillarLabels(brand: BrandRecord | null): string[] {
  if (!brand?.messaging?.pillars) return [];
  return brand.messaging.pillars
    .map((p) => p.title.trim())
    .filter(Boolean);
}
