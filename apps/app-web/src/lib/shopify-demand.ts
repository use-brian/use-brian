/**
 * Order → demand aggregation and stock matching for the Shopify app's
 * "Inventory vs orders" tab.
 *
 * Pure and exported separately so it can be tested without React or the
 * network, because BOTH halves of that tab must be arithmetic rather than a
 * model call.
 *
 * Demand was always arithmetic. An earlier version handed a prose list of
 * `"2x Widget"` strings to the assistant and asked it to both infer the
 * variants and add up the numbers. That was wrong twice: the projection
 * carried no variant and no SKU so the inference was impossible, and summing
 * integers was never a model's job. The tool now returns structured lines and
 * the sum happens here.
 *
 * STOCK used to be the other way, and it could not work. The tab asked the
 * workspace assistant to look up on-hand quantities, but that consult runs at
 * the default assistant-call budget (10 tool calls) against an inventory tool
 * that filtered by ONE sku per call - and most order lines in a real store
 * carry no sku at all, so no argument the tool had could reach them. The model
 * burned the budget and the tab rendered a dash on every row. It is now the
 * same shape as demand: enumerate the catalogue, join it here.
 *
 * [COMP:app-web/shopify-app]
 */

/** One line item as `shopifyListOrders` projects it. */
type OrderLine = {
  title?: string | null;
  variant?: string | null;
  quantity?: number | null;
  sku?: string | null;
};

export type OrderRow = {
  name?: string | null;
  fulfillment_status?: string | null;
  items?: OrderLine[] | null;
  /** True when the order had more lines than the tool projected. */
  items_truncated?: boolean | null;
};

export type DemandRow = {
  title: string;
  variant: string;
  sku: string;
  demand: number;
  orders: number;
};

export type Demand = {
  rows: DemandRow[];
  /** Orders whose line items were cut off, so their demand is understated. */
  linesTruncated: number;
  /** Lines with no SKU — grouped by name instead, and matched by name later. */
  noSku: number;
  totalUnits: number;
};

/**
 * The two sides of the name join do not spell an absent variant the same way.
 *
 * An order line reports `variantTitle: null` for a single-variant product, so
 * it arrives here as `""`. The inventory projection reports the productVariant's
 * own title, which for that same product is the literal string "Default Title"
 * — Shopify's placeholder for the option it creates when a merchant never
 * defines one. Comparing them raw means `"Blueberry Bagel "` never meets
 * `"Blueberry Bagel Default Title"`, and every SKU-less row shows a dash even
 * when the stock fetch worked perfectly. That was the whole bug for a store
 * whose products carry no SKUs.
 */
const NO_VARIANT = new Set(["", "default title"]);

const norm = (v?: string | null): string =>
  String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * One identity for "same product, same variant", built the same way from
 * either side of the join.
 *
 * The separator is an escaped NUL because it is the one character that cannot
 * appear in a Shopify title. A space separator (what this used to be) makes
 * product `"A B"` variant `"C"` collide with product `"A"` variant `"B C"`.
 * Written as `\x00` rather than a literal NUL byte: a raw NUL makes the whole
 * source file binary to grep, which silently hides it from every audit.
 *
 * Accepted collisions, both judged better than the alternative:
 *  - Two products differing only in case or internal whitespace fold into one
 *    row. Shopify permits that, but a store with both `Greens` and `greens` has
 *    a bigger problem, and folding is more often right than splitting.
 *  - A merchant who genuinely left a variant named "Default Title" is treated
 *    as having no variant. That is the intended reading.
 */
export function variantKey(title?: string | null, variant?: string | null): string {
  const v = norm(variant);
  return `${norm(title)}\x00${NO_VARIANT.has(v) ? "" : v}`;
}

/**
 * Exact demand per variant.
 *
 * Keyed on SKU when there is one, because that is the identity the store
 * itself uses; falls back to the normalized product+variant name when a line
 * has no SKU. The two keyspaces stay apart deliberately — folding a SKU-less
 * line into a SKU'd row would be a guess presented as a total.
 *
 * The name fallback normalizes on BOTH sides of the later join, not just the
 * stock side. Normalizing only there would leave `"Greens"` and `"greens"` as
 * two demand rows that both match one stock row, double-counting the shortfall
 * — a wrong number, which is worse than a dash.
 */
export function aggregateDemand(orders: OrderRow[]): Demand {
  const rows = new Map<string, DemandRow>();
  let linesTruncated = 0;
  let noSku = 0;

  for (const order of orders) {
    if (order.items_truncated) linesTruncated += 1;
    for (const line of order.items ?? []) {
      const title = line.title || "(untitled)";
      const variant = line.variant || "";
      const sku = line.sku || "";
      if (!sku) noSku += 1;
      const key = sku ? `sku:${sku}` : `nm:${variantKey(title, variant)}`;
      const row = rows.get(key) ?? { title, variant, sku, demand: 0, orders: 0 };
      row.demand += Number(line.quantity) || 0;
      row.orders += 1;
      rows.set(key, row);
    }
  }

  const list = [...rows.values()].sort((a, b) => b.demand - a.demand);
  return {
    rows: list,
    linesTruncated,
    noSku,
    totalUnits: list.reduce((sum, r) => sum + r.demand, 0),
  };
}

/** One variant as `shopifyGetInventoryLevels` projects it. */
export type StockRow = {
  sku?: string | null;
  product?: string | null;
  variant?: string | null;
  total_available?: number | null;
  tracked?: boolean | null;
  locations_truncated?: boolean | null;
  locations?: Array<{ location?: string | null; available?: number | null }> | null;
};

/**
 * What we actually know about one variant's stock.
 *
 * Four facts, not two, because collapsing them loses the distinction the whole
 * table depends on. A dash and a zero are different claims, and so are "we did
 * not find it" and "Shopify is not counting it".
 */
export type StockCell =
  | { kind: "known"; onHand: number }
  /** A real zero: the location list was complete and this location was not in it. */
  | { kind: "none" }
  /** Inventory tracking is off, so Shopify's 0 means nothing. */
  | { kind: "untracked" }
  /** Not found, or possibly cut off. Renders as a dash, never as 0. */
  | { kind: "unknown" };

/** All locations, as opposed to one named one. */
export const ALL_LOCATIONS = "";

/**
 * Join stock rows onto demand rows, by SKU first and normalized name second.
 *
 * @param location `ALL_LOCATIONS` for the cross-location total, or a location name.
 * @param complete false when the enumeration hit its page cap. An unmatched row
 *        is then "we did not look far enough", never "we have none" — but a row
 *        that DID match is still true, so it keeps its number.
 */
export function matchStock(
  demand: DemandRow[],
  stock: StockRow[],
  location: string = ALL_LOCATIONS,
  complete: boolean = true,
): Map<string, StockCell> {
  const bySku = new Map<string, StockRow>();
  const byName = new Map<string, StockRow>();
  for (const s of stock) {
    if (s.sku) bySku.set(String(s.sku), s);
    byName.set(variantKey(s.product, s.variant), s);
  }

  const out = new Map<string, StockCell>();
  for (const row of demand) {
    const hit =
      (row.sku ? bySku.get(row.sku) : undefined) ?? byName.get(variantKey(row.title, row.variant));
    out.set(demandKey(row), cellFor(hit, location, complete));
  }
  return out;
}

function cellFor(hit: StockRow | undefined, location: string, complete: boolean): StockCell {
  // Not found. If the enumeration was complete this is a deleted or archived
  // product; if it was capped we simply did not read far enough. Either way we
  // do not know, and `complete` only changes what the UI says about it.
  if (!hit) return { kind: "unknown" };

  // Shopify reports `inventoryQuantity: 0` with no levels for an untracked
  // item. Rendering that as 0 invents "we have none of these".
  if (hit.tracked === false) return { kind: "untracked" };

  if (location === ALL_LOCATIONS) {
    // `total_available` is Shopify's own cross-location total, so it is immune
    // to the nested `inventoryLevels(first: 10)` cut-off. Never sum locations[].
    return hit.total_available == null
      ? { kind: "unknown" }
      : { kind: "known", onHand: Number(hit.total_available) };
  }

  const at = (hit.locations ?? []).find((l) => l?.location === location);
  if (at && at.available != null) return { kind: "known", onHand: Number(at.available) };

  // Shopify only materializes an inventory level where the item is actually
  // stocked, so a COMPLETE list that omits this location genuinely means zero
  // here. That is the one place a 0 is honest — and the merchant needs it, or
  // a branch with none of something reads the same as one we could not check.
  // A possibly-truncated list proves nothing.
  return hit.locations_truncated ? { kind: "unknown" } : { kind: "none" };
}

/** Stable identity for a demand row, for React keys and stock lookup. */
export function demandKey(row: DemandRow): string {
  return row.sku ? `sku:${row.sku}` : `nm:${variantKey(row.title, row.variant)}`;
}

/** Units short, or null when stock is not a number we can subtract from. */
export function shortfall(demand: number, cell: StockCell | undefined): number | null {
  if (!cell) return null;
  if (cell.kind === "known") return Math.max(0, demand - cell.onHand);
  if (cell.kind === "none") return demand;
  return null;
}

/** The number an ON HAND cell shows, or null when it is not a number at all. */
export function onHandOf(cell: StockCell | undefined): number | null {
  if (cell?.kind === "known") return cell.onHand;
  if (cell?.kind === "none") return 0;
  return null;
}
