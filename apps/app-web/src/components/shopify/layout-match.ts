/**
 * Matching a wanted page shape against the product templates a theme already
 * has.
 *
 * The picker this backs asks the merchant which SECTIONS the page should have,
 * not which file to use, because on a store that names one template per
 * product the file names carry no signal - they are the names of other
 * products. Fifty templates on such a store are typically four or five real
 * layouts repeated, so the first job here is collapsing that duplication.
 *
 * Everything in this module is pure: no React, no network. The picker is the
 * part that is hard to test, so the deciding is kept out of it.
 *
 * [COMP:app-web/shopify-app]
 */

/** One `templates/product.*.json`, as `shopifyListProductTemplates` returns it. */
export type Template = {
  /** null for the theme default (`templates/product.json`). */
  suffix: string | null;
  filename: string;
  /** Ordered section TYPES, enabled ones only. */
  sections: string[];
};

/** A distinct layout: every template whose section stack is byte-identical. */
export type LayoutShape = {
  signature: string;
  sections: string[];
  /** Every template with this exact stack, in the server's suffix order. */
  templates: Template[];
  /** The one whose suffix gets used unless the merchant overrides it. */
  representative: Template;
};

export type SectionFacet = {
  type: string;
  /** How many templates contain it. */
  count: number;
  /** Present in EVERY template, so it separates nothing and cannot be a filter. */
  universal: boolean;
};

/**
 * ORDERED, deliberately. Two templates holding the same sections in a
 * different order are different pages, and collapsing them would tell the
 * merchant they had picked a layout they had not seen.
 */
export function signatureOf(t: Pick<Template, "sections">): string {
  return t.sections.join(">");
}

/**
 * Collapse templates into the distinct layouts they actually represent.
 *
 * Sorted by how many templates share the shape, so the layout the store
 * already uses most is first - on a per-product-template store that is nearly
 * always the answer. The theme default is pinned last: it is the fallback, not
 * a design.
 */
export function groupTemplates(templates: readonly Template[]): LayoutShape[] {
  const byShape = new Map<string, Template[]>();
  for (const t of templates) {
    const key = t.suffix === null ? "\x00default" : signatureOf(t);
    const bucket = byShape.get(key);
    if (bucket) bucket.push(t);
    else byShape.set(key, [t]);
  }

  const shapes: LayoutShape[] = [];
  for (const bucket of byShape.values()) {
    shapes.push({
      signature: signatureOf(bucket[0]),
      sections: bucket[0].sections,
      templates: bucket,
      representative: bucket[0],
    });
  }

  return shapes.sort((a, b) => {
    const aDefault = a.representative.suffix === null;
    const bDefault = b.representative.suffix === null;
    if (aDefault !== bDefault) return aDefault ? 1 : -1;
    if (b.templates.length !== a.templates.length) return b.templates.length - a.templates.length;
    if (b.sections.length !== a.sections.length) return b.sections.length - a.sections.length;
    return (a.representative.suffix ?? "").localeCompare(b.representative.suffix ?? "");
  });
}

/**
 * Every section type in play, with how many templates carry it.
 *
 * A type present in all of them is marked `universal` rather than dropped: it
 * is worth SAYING that every layout has a buy button, and worth not offering
 * as a filter that narrows nothing.
 */
export function sectionFacets(templates: readonly Template[]): SectionFacet[] {
  const counts = new Map<string, number>();
  for (const t of templates) {
    // A template may repeat a type; it still counts once for "has this".
    for (const type of new Set(t.sections)) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count, universal: count === templates.length && templates.length > 0 }))
    .sort((a, b) => (b.count - a.count) || a.type.localeCompare(b.type));
}

/** Sections a shape has beyond what was asked for. Never a reason to exclude it. */
export function extrasOf(shape: LayoutShape, wanted: readonly string[]): string[] {
  const asked = new Set(wanted);
  return [...new Set(shape.sections)].filter((s) => !asked.has(s));
}

/** Wanted sections a shape does NOT have. Empty means it matches. */
function missingFrom(shape: LayoutShape, wanted: readonly string[]): string[] {
  const has = new Set(shape.sections);
  return wanted.filter((w) => !has.has(w));
}

/**
 * Split the shapes into what qualifies and what does not.
 *
 * Nothing is hidden. A shape that falls short is still shown, under `closest`,
 * naming exactly what it lacks - because "no results" is the one answer that
 * tells the merchant nothing about what to do next.
 */
export function matchShapes(
  shapes: readonly LayoutShape[],
  wanted: readonly string[],
): { matches: LayoutShape[]; closest: Array<{ shape: LayoutShape; missing: string[] }> } {
  const matches: LayoutShape[] = [];
  const closest: Array<{ shape: LayoutShape; missing: string[] }> = [];
  for (const shape of shapes) {
    const missing = missingFrom(shape, wanted);
    if (missing.length === 0) matches.push(shape);
    else closest.push({ shape, missing });
  }
  closest.sort((a, b) => a.missing.length - b.missing.length);
  return { matches, closest };
}

/**
 * How many templates would still qualify if `candidate` were also ticked.
 *
 * This is what makes a dead end visible BEFORE it is entered: a chip that
 * would take the result set to zero says so on its face instead of emptying
 * the page when clicked.
 */
export function remainingIfAlso(
  shapes: readonly LayoutShape[],
  wanted: readonly string[],
  candidate: string,
): number {
  const combined = wanted.includes(candidate) ? wanted : [...wanted, candidate];
  return matchShapes(shapes, combined).matches.reduce((n, s) => n + s.templates.length, 0);
}

/** The `handle` out of any Shopify product URL. Null when it is not one. */
export function productHandleFromUrl(raw: string): string | null {
  const m = /\/products\/([^/?#\s]+)/.exec(String(raw ?? "").trim());
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * A template suffix from a product name.
 *
 * Shopify accepts `[a-z0-9][a-z0-9_-]*` and the server derives the filename
 * from it, so anything outside that is collapsed rather than rejected. Returns
 * null when nothing usable survives (a name that is entirely punctuation, or
 * one in a script with no ASCII), because a silent fallback suffix would name
 * a live theme file after the wrong thing.
 */
export function suffixFromName(name: string, taken: readonly string[] = []): string | null {
  const base = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (!base || !/^[a-z0-9]/.test(base)) return null;

  // Colliding is a hard server-side refusal (the file it would clobber is some
  // other product's live page), so the collision is resolved here rather than
  // discovered there.
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const next = `${base}-${n}`;
    if (!used.has(next)) return next;
  }
  return null;
}
