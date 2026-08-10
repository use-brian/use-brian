/**
 * [COMP:app-web/shopify-app] — the half that must not be a model call.
 *
 * These assert the distinction the whole tab exists for: a trial size and a
 * full-size pack are different variants, and a total that quietly merges them
 * is worse than no total because it looks right.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateDemand,
  matchStock,
  demandKey,
  shortfall,
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

describe("[COMP:app-web/shopify-app] stock matching", () => {
  const rows = aggregateDemand([
    order([
      { title: "Immunity Boost", variant: "5g trial", sku: "IB-5G", quantity: 4 },
      { title: "Greens", variant: "", quantity: 2 },
    ]),
  ]).rows;

  it("matches by SKU first", () => {
    const m = matchStock(rows, [{ sku: "IB-5G", onHand: 10 }]);
    expect(m.get("sku:IB-5G")).toBe(10);
  });

  it("falls back to product + variant when there is no SKU", () => {
    const m = matchStock(rows, [{ product: "Greens", variant: "", onHand: 3 }]);
    expect(m.get("nm:Greens ")).toBe(3);
  });

  it("reports an unfound variant as null, never zero", () => {
    // The assertion that matters. Zero reads as "we have none", which is a
    // different and actionable claim from "I could not find it".
    const m = matchStock(rows, []);
    expect(m.get("sku:IB-5G")).toBeNull();
    expect(m.get("sku:IB-5G")).not.toBe(0);
  });
});

describe("[COMP:app-web/shopify-app] shortfall", () => {
  it("is null when stock is unknown", () => {
    expect(shortfall(5, null)).toBeNull();
  });

  it("is zero when stock covers demand, never negative", () => {
    expect(shortfall(2, 10)).toBe(0);
  });

  it("is the gap when stock is short", () => {
    expect(shortfall(10, 4)).toBe(6);
  });

  it("keys a row stably for React and for lookup", () => {
    expect(demandKey({ title: "A", variant: "x", sku: "S1", demand: 0, orders: 0 })).toBe("sku:S1");
    expect(demandKey({ title: "A", variant: "x", sku: "", demand: 0, orders: 0 })).toBe("nm:A x");
  });
});
