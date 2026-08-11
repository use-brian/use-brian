import { describe, it, expect } from "vitest";
import {
  groupTemplates,
  sectionFacets,
  matchShapes,
  extrasOf,
  remainingIfAlso,
  signatureOf,
  suffixFromName,
  type Template,
} from "../layout-match";

const tpl = (suffix: string | null, sections: string[]): Template => ({
  suffix,
  filename: suffix ? `templates/product.${suffix}.json` : "templates/product.json",
  sections,
});

/** The shape this store actually repeats: the same 8 sections, many times. */
const RICH = ["main-product", "related-products", "image-with-text", "horizontal-ticker", "comparison-table", "icon-bar", "collapsible-content", "testimonials"];
const SIMPLE = ["main-product", "related-products", "horizontal-ticker", "rich-text", "featured-collection", "icon-bar"];

const STORE: Template[] = [
  tpl(null, ["main-product", "related-products"]),
  tpl("amla", RICH),
  tpl("ashwagandha", RICH),
  tpl("beetroot", RICH),
  tpl("bagel-lucky-bag", SIMPLE),
  tpl("bagel-lucky-bag-b", SIMPLE),
];

describe("[COMP:app-web/shopify-app] Layout matching", () => {
  it("collapses templates that are the same layout under different product names", () => {
    const shapes = groupTemplates(STORE);
    expect(shapes).toHaveLength(3);
    // Most-used first: three rich pages beat two simple ones.
    expect(shapes[0].templates.map((t) => t.suffix)).toEqual(["amla", "ashwagandha", "beetroot"]);
    expect(shapes[0].representative.suffix).toBe("amla");
    expect(shapes[1].templates).toHaveLength(2);
    // The theme default is a fallback, not a design. Always last.
    expect(shapes[2].representative.suffix).toBeNull();
  });

  it("keeps the same sections in a different ORDER as a different layout", () => {
    // Amla puts the image before the ticker; 5redsuperfood the other way round.
    // They are different pages, and merging them would name a layout the
    // merchant never looked at.
    const reordered = [...RICH];
    [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
    expect(signatureOf({ sections: reordered })).not.toBe(signatureOf({ sections: RICH }));
    expect(groupTemplates([tpl("a", RICH), tpl("b", reordered)])).toHaveLength(2);
  });

  it("never groups the theme default into a custom shape, even with an identical stack", () => {
    const shapes = groupTemplates([tpl(null, SIMPLE), tpl("twin", SIMPLE)]);
    expect(shapes).toHaveLength(2);
    expect(shapes[0].representative.suffix).toBe("twin");
  });

  it("marks a section every template has as universal rather than offering it as a filter", () => {
    const facets = sectionFacets(STORE);
    const universal = facets.filter((f) => f.universal).map((f) => f.type);
    expect(universal).toEqual(expect.arrayContaining(["main-product", "related-products"]));
    expect(facets.find((f) => f.type === "comparison-table")).toMatchObject({ count: 3, universal: false });
    // Ordered by how many templates carry it, so the store's own habits lead.
    expect(facets[0].count).toBeGreaterThanOrEqual(facets[facets.length - 1].count);
  });

  it("counts a repeated section type once per template", () => {
    // 5redsuperfood carries image-with-text twice. It still HAS it, once.
    const facets = sectionFacets([tpl("a", ["main-product", "image-with-text", "image-with-text"])]);
    expect(facets.find((f) => f.type === "image-with-text")?.count).toBe(1);
  });

  it("splits into matches and closest, and never hides a layout", () => {
    const shapes = groupTemplates(STORE);
    const { matches, closest } = matchShapes(shapes, ["comparison-table", "collapsible-content"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].representative.suffix).toBe("amla");
    expect(matches.length + closest.length).toBe(shapes.length);
    // The nearest miss comes first, and it names what it lacks.
    expect(closest[0].missing.length).toBeLessThanOrEqual(closest[1].missing.length);
    expect(closest.find((c) => c.shape.representative.suffix === null)?.missing).toEqual([
      "comparison-table",
      "collapsible-content",
    ]);
  });

  it("reports the sections a match carries beyond what was asked for", () => {
    const shapes = groupTemplates(STORE);
    const extras = extrasOf(shapes[0], ["comparison-table"]);
    expect(extras).toContain("testimonials");
    expect(extras).not.toContain("comparison-table");
  });

  it("returns zero remaining for a combination no template has", () => {
    const shapes = groupTemplates(STORE);
    // Nothing carries both a comparison table and a featured collection.
    expect(remainingIfAlso(shapes, ["comparison-table"], "featured-collection")).toBe(0);
    // And the counts are template counts, not shape counts.
    expect(remainingIfAlso(shapes, [], "comparison-table")).toBe(3);
    expect(remainingIfAlso(shapes, ["comparison-table"], "comparison-table")).toBe(3);
  });

  it("nothing wanted means nothing is excluded", () => {
    const shapes = groupTemplates(STORE);
    const { matches, closest } = matchShapes(shapes, []);
    expect(matches).toHaveLength(shapes.length);
    expect(closest).toHaveLength(0);
  });

  describe("suffixFromName", () => {
    it("derives a Shopify-legal suffix and sidesteps a collision", () => {
      expect(suffixFromName("Immunity Boost")).toBe("immunity-boost");
      expect(suffixFromName("  Hojicha / Black Maca!! ")).toBe("hojicha-black-maca");
      expect(suffixFromName("Immunity Boost", ["immunity-boost"])).toBe("immunity-boost-2");
      expect(suffixFromName("Immunity Boost", ["immunity-boost", "immunity-boost-2"])).toBe("immunity-boost-3");
    });

    it("refuses rather than inventing a name when nothing usable survives", () => {
      // A silent fallback would write a live theme file named after nothing.
      expect(suffixFromName("!!!")).toBeNull();
      expect(suffixFromName("")).toBeNull();
      expect(suffixFromName("   ")).toBeNull();
    });
  });
});
