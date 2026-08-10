/**
 * Shopify surface view state — the section model and its URL codec.
 *
 * The URL is the single source of truth, the same contract `crm-view.ts` holds.
 * Two controls drive the same state (the topbar pills and the sidebar panel),
 * so keeping it in a `useState` would let them disagree, and a link to a
 * section would not survive being shared or a back button.
 *
 * Pure and dependency-free so it can be tested without React or the router.
 *
 * [COMP:app-web/shopify-app]
 */

export const SHOPIFY_SECTIONS = ["draft", "inventory", "analyse", "campaign"] as const;
export type ShopifySection = (typeof SHOPIFY_SECTIONS)[number];

/** Where the surface opens when the URL says nothing. */
export const DEFAULT_SHOPIFY_SECTION: ShopifySection = "draft";

const SECTION_SET: ReadonlySet<string> = new Set(SHOPIFY_SECTIONS);

export function isShopifySection(value: unknown): value is ShopifySection {
  return typeof value === "string" && SECTION_SET.has(value);
}

/**
 * The section a `?section=` value names.
 *
 * An absent OR unrecognised value falls back to the default rather than
 * rendering nothing: a stale link, a typo, or a section removed in a later
 * build must still land somewhere usable. Silently showing an empty surface is
 * the failure mode this guards.
 */
export function shopifySectionFromParams(
  params: { get(key: string): string | null } | null | undefined,
): ShopifySection {
  const raw = params?.get("section");
  return isShopifySection(raw) ? raw : DEFAULT_SHOPIFY_SECTION;
}

/**
 * The query string for a section link.
 *
 * The default section is written explicitly rather than omitted. The sidebar
 * renders these as hrefs, and an href of `?` (or bare `/w/<id>/shopify`) reads
 * as "no section" to the eye and breaks the active-row highlight.
 */
export function shopifySectionHref(workspaceId: string, section: ShopifySection): string {
  return `/w/${workspaceId}/shopify?section=${section}`;
}
