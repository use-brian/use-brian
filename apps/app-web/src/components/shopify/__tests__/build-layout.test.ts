/**
 * [COMP:app-web/shopify-app] - assembling a template that does not exist yet.
 *
 * This is the only path in the Shopify surface that writes into a live theme,
 * and the failure it exists to avoid is a page that renders BLANK because it
 * names a section the theme does not ship. The defence is structural: every
 * section in the output was lifted whole out of a template that is already in
 * that theme, so there is nothing to validate.
 */

import { describe, expect, it } from "vitest";
import { assembleTemplate, parseThemeJson, planGraft } from "../build-layout";
import type { Template } from "../layout-match";

const tpl = (suffix: string | null, sections: string[]): Template => ({
  suffix,
  filename: suffix ? `templates/product.${suffix}.json` : "templates/product.json",
  sections,
});

const AMLA = tpl("amla", ["main-product", "collapsible-content"]);
const BAGEL = tpl("bagel", ["main-product", "featured-collection", "icon-bar"]);
const BIG = tpl("big", ["main-product", "featured-collection", "icon-bar", "testimonials", "video"]);
const STORE = [tpl(null, ["main-product"]), AMLA, BAGEL, BIG];

const body = (sections: Record<string, unknown>, order: string[], banner = false) =>
  (banner ? "/* auto-generated, do not edit */\n" : "") + JSON.stringify({ sections, order });

describe("[COMP:app-web/shopify-app] Building a layout", () => {
  it("plans a graft that names a donor for every section the base lacks", () => {
    const plan = planGraft(STORE, AMLA, ["collapsible-content", "featured-collection"]);
    expect(plan?.sections).toEqual(["main-product", "collapsible-content", "featured-collection"]);
    // Already present, so not grafted twice.
    expect(plan?.grafts.map((g) => g.type)).toEqual(["featured-collection"]);
    // The SMALLER donor wins: a plain instance beats a heavily built page.
    expect(plan?.grafts[0].donor.suffix).toBe("bagel");
  });

  it("refuses when a wanted section exists in no template at all", () => {
    // It may not exist in the theme either, and a template naming a section
    // the theme lacks renders as a blank page.
    expect(planGraft(STORE, AMLA, ["slideshow"])).toBeNull();
  });

  it("carries the donor's whole section, not just its type", () => {
    // A bare { type } renders with empty settings and no blocks: a section
    // that is present and says nothing.
    const plan = planGraft(STORE, AMLA, ["featured-collection"])!;
    const bodies = new Map([
      ["amla", body({ main: { type: "main-product" }, faq: { type: "collapsible-content" } }, ["main", "faq"])],
      ["bagel", body({
        fc: { type: "featured-collection", settings: { heading: "More greens", count: 4 }, blocks: { b1: { type: "card" } }, block_order: ["b1"] },
      }, ["fc"])],
    ]);

    const out = parseThemeJson(assembleTemplate(plan, bodies));
    const sections = out.sections as Record<string, Record<string, unknown>>;
    const grafted = Object.values(sections).find((s) => s.type === "featured-collection")!;
    expect(grafted.settings).toEqual({ heading: "More greens", count: 4 });
    expect(grafted.block_order).toEqual(["b1"]);
    expect(out.order).toEqual(["main", "faq", "featured-collection"]);
  });

  it("drops the base's disabled sections so the file matches the card that was clicked", () => {
    const plan = planGraft(STORE, AMLA, [])!;
    const bodies = new Map([
      ["amla", body({
        main: { type: "main-product" },
        old: { type: "video", disabled: true },
      }, ["main", "old"])],
    ]);

    const out = parseThemeJson(assembleTemplate(plan, bodies));
    expect(out.order).toEqual(["main"]);
    expect(Object.keys(out.sections as object)).toEqual(["main"]);
  });

  it("never grafts a section in switched off", () => {
    // It was asked for. Arriving disabled would be the same blank result the
    // merchant was trying to avoid, with nothing saying so.
    const plan = planGraft([AMLA, BIG], AMLA, ["testimonials"])!;
    const bodies = new Map([
      ["amla", body({ main: { type: "main-product" } }, ["main"])],
      ["big", body({ t: { type: "testimonials", disabled: false, settings: { quote: "x" } } }, ["t"])],
    ]);
    const sections = parseThemeJson(assembleTemplate(plan, bodies)).sections as Record<string, Record<string, unknown>>;
    expect(sections.testimonials).not.toHaveProperty("disabled");
    expect(sections.testimonials.settings).toEqual({ quote: "x" });
  });

  it("refuses a donor whose only instance of the section is disabled", () => {
    const plan = planGraft([AMLA, BIG], AMLA, ["testimonials"])!;
    const bodies = new Map([
      ["amla", body({ main: { type: "main-product" } }, ["main"])],
      ["big", body({ t: { type: "testimonials", disabled: true } }, ["t"])],
    ]);
    expect(() => assembleTemplate(plan, bodies)).toThrow(/no enabled testimonials section/);
  });

  it("strips the auto-generated banner Shopify prepends, on every body it reads", () => {
    // Theme JSON is not valid JSON as stored. A base or a DONOR carrying the
    // banner must both parse.
    const plan = planGraft(STORE, AMLA, ["featured-collection"])!;
    const bodies = new Map([
      ["amla", body({ main: { type: "main-product" } }, ["main"], true)],
      ["bagel", body({ fc: { type: "featured-collection" } }, ["fc"], true)],
    ]);
    expect(() => assembleTemplate(plan, bodies)).not.toThrow();
  });

  it("does not collide with a section id the base already uses", () => {
    const plan = planGraft(STORE, AMLA, ["featured-collection"])!;
    const bodies = new Map([
      ["amla", body({ "featured-collection": { type: "main-product" } }, ["featured-collection"])],
      ["bagel", body({ fc: { type: "featured-collection" } }, ["fc"])],
    ]);
    const out = parseThemeJson(assembleTemplate(plan, bodies));
    expect(out.order).toEqual(["featured-collection", "featured-collection-2"]);
  });

  it("keeps template keys the picker knows nothing about", () => {
    // `sections` and `order` are the only two this code understands. Dropping
    // the rest would silently strip theme settings on every clone.
    const plan = planGraft(STORE, AMLA, [])!;
    const raw = JSON.stringify({ sections: { main: { type: "main-product" } }, order: ["main"], layout: "full-width" });
    const out = parseThemeJson(assembleTemplate(plan, new Map([["amla", raw]])));
    expect(out.layout).toBe("full-width");
  });
});
