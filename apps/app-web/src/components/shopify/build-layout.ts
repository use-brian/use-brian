/**
 * Assembling a product template that does not exist yet, out of ones that do.
 *
 * The theme's available section types are NOT enumerable from this surface:
 * `themeSectionTypes` is private to the Shopify client and no tool exposes it.
 * That is not a gap to route around - it is why this builds by CLONING a real
 * template and GRAFTING sections lifted whole out of other real templates in
 * the same theme. Every type that lands in the output provably exists in the
 * theme, so the blank-page failure the server validates against is unreachable
 * by construction rather than by being caught.
 *
 * Grafting the whole section object, not just its `type`, is the other half:
 * a bare `{ type }` renders with empty settings and no blocks, which is a
 * section that is present and says nothing. The donor's settings come with it,
 * which means the donor's TEXT comes with it, which the assistant then
 * rewrites. Saying that out loud in the confirm dialog is part of the design.
 *
 * [COMP:app-web/shopify-app]
 */

import type { Template } from "./layout-match";

/** Shopify prepends a `/* ... *\/` banner, so stored theme JSON is not JSON. */
export function parseThemeJson(raw: string): Record<string, unknown> {
  return JSON.parse(String(raw ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim()) as Record<string, unknown>;
}

type SectionBag = Record<string, { type?: string; disabled?: boolean } & Record<string, unknown>>;

export type GraftPlan = {
  /** The template being cloned. */
  base: Template;
  /** Which template each added section is lifted from, in output order. */
  grafts: Array<{ type: string; donor: Template }>;
  /** Every section type the finished template will have, in order. */
  sections: string[];
};

/**
 * Decide what to clone and what to graft, without reading anything yet.
 *
 * Returns null when the wish cannot be met from what the theme has: a wanted
 * type that appears in NO template is a section the theme may not ship at all,
 * and inventing it is exactly the blank page this whole path avoids.
 */
export function planGraft(
  templates: readonly Template[],
  base: Template,
  wanted: readonly string[],
): GraftPlan | null {
  const have = new Set(base.sections);
  const grafts: GraftPlan["grafts"] = [];
  for (const type of wanted) {
    if (have.has(type)) continue;
    // Prefer a donor with the fewest sections: a smaller page is likelier to
    // hold a plain instance of the section than a heavily customized one.
    const donor = templates
      .filter((t) => t.suffix !== null && t.sections.includes(type))
      .sort((a, b) => a.sections.length - b.sections.length)[0];
    if (!donor) return null;
    grafts.push({ type, donor });
    have.add(type);
  }
  return { base, grafts, sections: [...base.sections, ...grafts.map((g) => g.type)] };
}

/**
 * Build the template body.
 *
 * `bodies` maps a template suffix (empty string for the theme default) to its
 * RAW file content, exactly as `shopifyReadProductTemplate` returned it.
 *
 * Disabled sections are dropped rather than carried: they are already absent
 * from every stack this surface displays, so keeping them would make the file
 * disagree with the card the merchant clicked.
 */
export function assembleTemplate(plan: GraftPlan, bodies: Map<string, string>): string {
  const baseKey = plan.base.suffix ?? "";
  const baseRaw = bodies.get(baseKey);
  if (baseRaw === undefined) throw new Error(`Missing template body for "${baseKey}"`);

  const parsed = parseThemeJson(baseRaw);
  const bag = { ...((parsed.sections ?? {}) as SectionBag) };
  const order = (Array.isArray(parsed.order) ? [...(parsed.order as string[])] : []).filter(
    (k) => bag[k] && bag[k].disabled !== true,
  );
  for (const key of Object.keys(bag)) {
    if (!order.includes(key)) delete bag[key];
  }

  for (const graft of plan.grafts) {
    const donorRaw = bodies.get(graft.donor.suffix ?? "");
    if (donorRaw === undefined) throw new Error(`Missing template body for "${graft.donor.suffix}"`);
    const donorBag = (parseThemeJson(donorRaw).sections ?? {}) as SectionBag;
    const found = Object.values(donorBag).find((s) => s?.type === graft.type && s.disabled !== true);
    if (!found) throw new Error(`"${graft.donor.suffix}" has no enabled ${graft.type} section`);

    const key = freshKey(bag, graft.type);
    // `disabled` is dropped along the way: a section grafted in because it was
    // ASKED for must not arrive switched off.
    const { disabled: _disabled, ...section } = found;
    bag[key] = section;
    order.push(key);
  }

  return JSON.stringify({ ...parsed, sections: bag, order }, null, 2);
}

/** A section id that does not collide with one the base already uses. */
function freshKey(bag: SectionBag, type: string): string {
  const base = type.replace(/[^a-z0-9_-]/gi, "-");
  if (!bag[base]) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base}-${n}`;
    if (!bag[next]) return next;
  }
}
