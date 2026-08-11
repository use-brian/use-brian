/**
 * [COMP:app-web/shopify-app] — the half that must not be a model call.
 *
 * These assert the distinction the whole tab exists for: a trial size and a
 * full-size pack are different variants, and a total that quietly merges them
 * is worse than no total because it looks right.
 */

import { describe, it, expect } from "vitest";
import {
  ALL_LOCATIONS,
  aggregateDemand,
  matchStock,
  demandKey,
  onHandOf,
  shortfall,
  variantKey,
  type OrderRow,
} from "../shopify-demand";

const order = (items: OrderRow["items"], extra: Partial<OrderRow> = {}): OrderRow => ({
  name: "#1001",
  items,
  ...extra,
});

describe("[COMP:app-web/shopify-app] demand aggregation", () => {
  it("keeps a trial size separate from a full-size pack", () => {
    // Same product title, different variant and SKU. Merging these is the
    // failure this tab was rebuilt to prevent.
    const out = aggregateDemand([
      order([
        { title: "Immunity Boost", variant: "5g trial", sku: "IB-5G", quantity: 3 },
        { title: "Immunity Boost", variant: "150g", sku: "IB-150", quantity: 2 },
      ]),
    ]);
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r.sku).sort()).toEqual(["IB-150", "IB-5G"]);
    expect(out.totalUnits).toBe(5);
  });

  it("sums the same SKU across orders", () => {
    const out = aggregateDemand([
      order([{ title: "A", sku: "A-1", quantity: 2 }]),
      order([{ title: "A", sku: "A-1", quantity: 5 }]),
    ]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].demand).toBe(7);
    expect(out.rows[0].orders).toBe(2);
  });

  it("never folds a SKU-less line into a SKU'd row", () => {
    // Same title, but one line has no SKU. Merging would present a guess as a
    // total; keeping them apart is visibly odd, which is the point.
    const out = aggregateDemand([
      order([
        { title: "A", variant: "150g", sku: "A-150", quantity: 1 },
        { title: "A", variant: "150g", quantity: 1 },
      ]),
    ]);
    expect(out.rows).toHaveLength(2);
    expect(out.noSku).toBe(1);
  });

  it("counts orders whose lines were truncated", () => {
    // An understated total that looks complete is the worst shape available,
    // so the count has to survive to the UI.
    const out = aggregateDemand([
      order([{ title: "A", sku: "A-1", quantity: 1 }], { items_truncated: true }),
      order([{ title: "B", sku: "B-1", quantity: 1 }]),
    ]);
    expect(out.linesTruncated).toBe(1);
  });

  it("treats a missing quantity as zero rather than NaN", () => {
    const out = aggregateDemand([order([{ title: "A", sku: "A-1" }])]);
    expect(out.rows[0].demand).toBe(0);
    expect(out.totalUnits).toBe(0);
  });

  it("survives an order with no line items at all", () => {
    expect(aggregateDemand([order(null), order([])]).rows).toEqual([]);
  });

  it("orders rows by demand, so the biggest need reads first", () => {
    const out = aggregateDemand([
      order([
        { title: "small", sku: "S", quantity: 1 },
        { title: "big", sku: "B", quantity: 9 },
      ]),
    ]);
    expect(out.rows[0].sku).toBe("B");
  });
});

describe("[COMP:app-web/shopify-app] variant identity", () => {
  it("treats Shopify's Default Title placeholder as no variant at all", () => {
    // The join's whole failure mode. An order line reports variantTitle null
    // for a single-variant product; the inventory projection reports the
    // placeholder string. Raw, they never meet, and every SKU-less row shows a
    // dash while the fetch is working perfectly.
    expect(variantKey("Blueberry Bagel", "Default Title")).toBe(
      variantKey("Blueberry Bagel", ""),
    );
    expect(variantKey("Blueberry Bagel", null)).toBe(variantKey("Blueberry Bagel", undefined));
    expect(variantKey("Blueberry Bagel", "  default   TITLE ")).toBe(
      variantKey("Blueberry Bagel", ""),
    );
  });

  it("folds case and internal whitespace on both sides", () => {
    expect(variantKey(" Blueberry   Bagel ", "6 Pack")).toBe(
      variantKey("blueberry bagel", "6 pack"),
    );
  });

  it("does not let the separator make two different variants collide", () => {
    // A space separator makes product "A B" variant "C" indistinguishable from
    // product "A" variant "B C".
    expect(variantKey("A B", "C")).not.toBe(variantKey("A", "B C"));
  });

  it("normalizes the demand side too, so one stock row cannot serve two rows", () => {
    // Normalizing only the stock side leaves these as two demand rows that
    // both match the same stock row, double-counting the shortfall. A wrong
    // number is worse than a dash.
    const out = aggregateDemand([
      order([
        { title: "Greens", quantity: 2 },
        { title: "greens", quantity: 3 },
      ]),
    ]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].demand).toBe(5);
  });
});

describe("[COMP:app-web/shopify-app] stock matching", () => {
  const rows = aggregateDemand([
    order([
      { title: "Immunity Boost", variant: "5g trial", sku: "IB-5G", quantity: 4 },
      { title: "Greens", variant: "", quantity: 2 },
    ]),
  ]).rows;

  const greensKey = `nm:${variantKey("Greens", "")}`;

  it("matches by SKU first", () => {
    const m = matchStock(rows, [{ sku: "IB-5G", total_available: 10 }]);
    expect(m.get("sku:IB-5G")).toEqual({ kind: "known", onHand: 10 });
  });

  it("matches a no-SKU line against the Default Title placeholder", () => {
    // This is the row the user actually sees blank: a bagel with no SKU whose
    // inventory row carries Shopify's placeholder variant title.
    const m = matchStock(rows, [
      { product: "Greens", variant: "Default Title", total_available: 3 },
    ]);
    expect(m.get(greensKey)).toEqual({ kind: "known", onHand: 3 });
  });

  it("reports an unfound variant as unknown, never zero", () => {
    // The assertion that matters. Zero reads as "we have none", which is a
    // different and actionable claim from "I could not find it".
    const m = matchStock(rows, []);
    expect(m.get("sku:IB-5G")).toEqual({ kind: "unknown" });
    expect(onHandOf(m.get("sku:IB-5G"))).toBeNull();
  });

  it("says not-tracked rather than zero when Shopify is not counting the item", () => {
    // An untracked item reports inventoryQuantity 0 with no levels. Rendering
    // that as 0 invents "we have none of these".
    const m = matchStock(rows, [{ sku: "IB-5G", total_available: 0, tracked: false }]);
    expect(m.get("sku:IB-5G")).toEqual({ kind: "untracked" });
  });

  it("uses the cross-location total for all-locations, not a sum of levels", () => {
    // total_available is Shopify's own figure and is immune to the nested
    // inventoryLevels(first: 10) cut-off; summing the array is not.
    const m = matchStock(
      rows,
      [
        {
          sku: "IB-5G",
          total_available: 12,
          locations: [
            { location: "Shop", available: 5 },
            { location: "Warehouse", available: 7 },
          ],
        },
      ],
      ALL_LOCATIONS,
    );
    expect(m.get("sku:IB-5G")).toEqual({ kind: "known", onHand: 12 });
  });

  it("uses the named location's own figure when one is chosen", () => {
    const m = matchStock(
      rows,
      [
        {
          sku: "IB-5G",
          total_available: 12,
          locations: [
            { location: "Shop", available: 5 },
            { location: "Warehouse", available: 7 },
          ],
        },
      ],
      "Warehouse",
    );
    expect(m.get("sku:IB-5G")).toEqual({ kind: "known", onHand: 7 });
  });

  it("reports a real zero when a COMPLETE location list omits the location", () => {
    // Shopify only materializes a level where the item is stocked, so this is
    // the one place a zero is honest, and the merchant needs it.
    const m = matchStock(
      rows,
      [{ sku: "IB-5G", total_available: 5, locations: [{ location: "Shop", available: 5 }] }],
      "Warehouse",
    );
    expect(m.get("sku:IB-5G")).toEqual({ kind: "none" });
    expect(onHandOf(m.get("sku:IB-5G"))).toBe(0);
  });

  it("refuses that zero when the location list may have been cut off", () => {
    const m = matchStock(
      rows,
      [
        {
          sku: "IB-5G",
          total_available: 5,
          locations_truncated: true,
          locations: [{ location: "Shop", available: 5 }],
        },
      ],
      "Warehouse",
    );
    expect(m.get("sku:IB-5G")).toEqual({ kind: "unknown" });
  });

  it("keeps matched rows true when the enumeration hit its page cap", () => {
    // A capped read makes the rows we did NOT reach unknown. It does not make
    // the rows we did reach any less true.
    const m = matchStock(rows, [{ sku: "IB-5G", total_available: 9 }], ALL_LOCATIONS, false);
    expect(m.get("sku:IB-5G")).toEqual({ kind: "known", onHand: 9 });
    expect(m.get(greensKey)).toEqual({ kind: "unknown" });
  });
});

describe("[COMP:app-web/shopify-app] shortfall", () => {
  it("is null when stock is unknown or untracked, so nothing is invented", () => {
    expect(shortfall(5, { kind: "unknown" })).toBeNull();
    expect(shortfall(5, { kind: "untracked" })).toBeNull();
    expect(shortfall(5, undefined)).toBeNull();
  });

  it("is the whole demand when stock is a real zero", () => {
    expect(shortfall(5, { kind: "none" })).toBe(5);
  });

  it("is zero when stock covers demand, never negative", () => {
    expect(shortfall(2, { kind: "known", onHand: 10 })).toBe(0);
  });

  it("is the gap when stock is short", () => {
    expect(shortfall(10, { kind: "known", onHand: 4 })).toBe(6);
  });

  it("keys a row stably for React and for lookup", () => {
    expect(demandKey({ title: "A", variant: "x", sku: "S1", demand: 0, orders: 0 })).toBe("sku:S1");
    expect(demandKey({ title: "A", variant: "x", sku: "", demand: 0, orders: 0 })).toBe(
      `nm:${variantKey("A", "x")}`,
    );
  });
});
