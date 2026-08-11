// @vitest-environment jsdom
/**
 * [COMP:app-web/shopify-app] Inventory vs orders: the stock half is arithmetic.
 *
 * The load-bearing assertion here is that the assistant is never consulted.
 * The tab used to ask it for stock, which could not work - the consult runs at
 * a 10-tool-call budget against a tool that filtered one SKU per call, and the
 * store's line items mostly carry no SKU at all - and the symptom was an
 * all-dashes ON HAND column under a generic apology.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callTool = vi.fn();
const askAssistant = vi.fn();
vi.mock("@/lib/api/shopify", () => ({
  callTool: (...args: unknown[]) => callTool(...args),
  askAssistant: (...args: unknown[]) => askAssistant(...args),
  extractJson: (text: string) => JSON.parse(text),
  ShopifyCallError: class ShopifyCallError extends Error {},
}));

import { I18nProvider } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { en } from "@/lib/i18n/dictionaries/en";
import { InventoryTab } from "../inventory-tab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;
/** Mirrors the tab's own constants: 25 per page (a cost ceiling), 6 pages. */
const STOCK_PAGE = 25;
const MAX_STOCK_PAGES = 6;
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** The stock fetch awaits a chain of pages, so one tick is not enough. */
async function settle(ticks = 12) {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <InventoryTab workspaceId={WORKSPACE} />
      </I18nProvider>,
    );
  });
  await settle();
}

function button(text: string): HTMLButtonElement {
  const match = [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!match) throw new Error(`button not found: ${text}`);
  return match;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

/** Body rows as `[product, ordered, onHand, short]`. */
function rows(): string[][] {
  return [...container!.querySelectorAll("tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].slice(1).map((td) => td.textContent?.trim() ?? ""),
  );
}

/** One bagel order: no SKU anywhere, which is the real store's shape. */
const ORDERS = {
  items: [
    {
      name: "#1042",
      items: [
        { title: "Blueberry Bagel", variant: null, sku: null, quantity: 15 },
        { title: "Onion Bagel", variant: null, sku: null, quantity: 4 },
      ],
    },
  ],
  has_next_page: false,
};

/** Inventory as Shopify projects it: the placeholder variant title. */
const STOCK = {
  items: [
    {
      sku: null,
      product: "Blueberry Bagel",
      variant: "Default Title",
      total_available: 40,
      tracked: true,
      locations_truncated: false,
      locations: [{ location: "Shop Front", available: 40 }],
    },
    {
      sku: null,
      product: "Onion Bagel",
      variant: "Default Title",
      total_available: 1,
      tracked: true,
      locations_truncated: false,
      locations: [{ location: "Shop Front", available: 1 }],
    },
  ],
  has_next_page: false,
};

beforeEach(() => {
  callTool.mockReset();
  askAssistant.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("[COMP:app-web/shopify-app] inventory vs orders", () => {
  /**
   * The tab makes TWO kinds of inventory call: one `first: 10` probe at mount
   * to prime the location picker, and the `first: 25` pages of a breakdown.
   * They are routed apart here, or the probe silently eats the first queued
   * page and the pagination assertions test nothing.
   */
  function route(stockPages: unknown[] = [STOCK]) {
    let page = 0;
    callTool.mockImplementation(async (_ws: string, tool: string, args: { first?: number }) => {
      if (tool === "shopifyListOrders") return ORDERS;
      if (args.first !== STOCK_PAGE) return { items: [], has_next_page: false };
      const out = stockPages[Math.min(page, stockPages.length - 1)];
      page += 1;
      return out;
    });
  }

  /** Inventory pages of a breakdown, in order. */
  function stockCalls() {
    return callTool.mock.calls.filter(
      (c) => c[1] === "shopifyGetInventoryLevels" && (c[2] as { first?: number }).first === STOCK_PAGE,
    );
  }

  it("never consults the assistant for stock", async () => {
    // The regression test for the whole bug. Reintroducing the model call is
    // the one change that cannot pass this.
    route();
    await mount();
    await click(button(dict.shopifyApp.buildBreakdown));
    expect(askAssistant).not.toHaveBeenCalled();
  });

  it("fills ON HAND for a no-SKU line whose stock row says Default Title", async () => {
    // The exact failure on screen: every row dashed because an order line's
    // empty variant never met the inventory row's placeholder title.
    route();
    await mount();
    await click(button(dict.shopifyApp.buildBreakdown));
    expect(rows()).toEqual([
      ["Blueberry Bagel", "15", "40", "-"],
      ["Onion Bagel", "4", "1", "3"],
    ]);
  });

  it("omits the cursor on the first stock page and forwards end_cursor after", async () => {
    route([
      { ...STOCK, items: [STOCK.items[0]], has_next_page: true, end_cursor: "CUR1" },
      { items: [STOCK.items[1]], has_next_page: false },
    ]);
    await mount();
    await click(button(dict.shopifyApp.buildBreakdown));

    expect(stockCalls()).toHaveLength(2);
    expect(stockCalls()[0][2]).not.toHaveProperty("cursor");
    expect((stockCalls()[1][2] as { cursor?: string }).cursor).toBe("CUR1");
    // Both pages joined, so the second page's row is matched too.
    expect(rows()[1]).toEqual(["Onion Bagel", "4", "1", "3"]);
  });

  it("stops at the page cap and says so rather than calling the rest zero", async () => {
    let page = 0;
    callTool.mockImplementation(async (_ws: string, tool: string, args: { first?: number }) => {
      if (tool === "shopifyListOrders") return ORDERS;
      if (args.first !== STOCK_PAGE) return { items: [], has_next_page: false };
      page += 1;
      // A cursor that keeps advancing, as a real store's would.
      return { items: [STOCK.items[0]], has_next_page: true, end_cursor: `C${page}` };
    });
    await mount();
    await click(button(dict.shopifyApp.buildBreakdown));

    expect(stockCalls()).toHaveLength(MAX_STOCK_PAGES);
    expect(container!.textContent).toContain("more variants than the 150 that were read");
    // The row we never reached is a dash, not a zero and not a shortfall.
    expect(rows()[1]).toEqual(["Onion Bagel", "4", "-", "-"]);
  });

  it("stops if the cursor stops advancing, instead of reading page one forever", async () => {
    // The tool re-parses its arguments through a zod object, which STRIPS
    // undeclared keys. If `cursor` ever stops being declared, every request is
    // page one and the loop looks like a success while reading the same 25
    // variants six times over.
    route([{ items: [STOCK.items[0]], has_next_page: true, end_cursor: "STUCK" }]);
    await mount();
    await click(button(dict.shopifyApp.buildBreakdown));
    expect(stockCalls()).toHaveLength(2);
  });

  it("keeps the pages it already read when a later page fails", async () => {
    let page = 0;
    callTool.mockImplementation(async (_ws: string, tool: string, args: { first?: number }) => {
      if (tool === "shopifyListOrders") return ORDERS;
      if (args.first !== STOCK_PAGE) return { items: [], has_next_page: false };
      page += 1;
      if (page === 1) return { items: [STOCK.items[0]], has_next_page: true, end_cursor: "C" };
      throw new Error("throttled");
    });
    await mount();
    await click(button(dict.shopifyApp.buildBreakdown));
    // Partial stock beats no stock: the row we did read keeps its number.
    expect(rows()[0]).toEqual(["Blueberry Bagel", "15", "40", "-"]);
    expect(rows()[1]).toEqual(["Onion Bagel", "4", "-", "-"]);
  });

  it("ticks a row without changing what was ordered", async () => {
    route();
    await mount();
    await click(button(dict.shopifyApp.buildBreakdown));
    expect(container!.textContent).toContain("0 of 2 packed");

    await click(container!.querySelector<HTMLElement>("tbody tr [role=checkbox]")!);
    expect(container!.textContent).toContain("1 of 2 packed");
    expect(rows()[0][1]).toBe("15");
  });

  it("sorts A to Z for picking without losing the ticks", async () => {
    route();
    await mount();
    await click(button(dict.shopifyApp.buildBreakdown));
    await click(container!.querySelector<HTMLElement>("tbody tr [role=checkbox]")!);

    await click(button(dict.shopifyApp.sortAtoZ));
    expect(rows().map((r) => r[0])).toEqual(["Blueberry Bagel", "Onion Bagel"]);
    expect(container!.textContent).toContain("1 of 2 packed");
  });
});
