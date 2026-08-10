/**
 * Order → demand aggregation for the Shopify app's "Inventory vs orders" tab.
 *
 * Pure and exported separately so it can be tested without React or the
 * network, because this is the half that must NOT be a model call.
 *
 * Demand is arithmetic. An earlier version handed a prose list of
 * `"2x Widget"` strings to the assistant and asked it to both infer the
 * variants and add up the numbers. That was wrong twice: the projection
 * carried no variant and no SKU so the inference was impossible, and summing
 * integers was never a model's job. The tool now returns structured lines and
 * the sum happens here.
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
 * Exact demand per variant.
 *
 * Keyed on SKU when there is one, because that is the identity the store
 * itself uses; falls back to title+variant when a line has no SKU. The two
 * keyspaces stay apart deliberately — folding a SKU-less line into a SKU'd row
 * would be a guess presented as a total.
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
      const key = sku ? `sku:${sku}` : `nm:${title} ${variant}`;
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

/** Stock for one variant, as the assistant reports it back. */
export type StockRow = {
  sku?: string | null;
  product?: string | null;
  variant?: string | null;
  onHand?: number | null;
};

/**
 * Match stock rows to demand rows, by SKU first and name second.
 *
 * Returns `null` for a variant the assistant could not find. That is NOT zero:
 * an unknown rendered as zero is how "we have none of these" gets invented.
 */
export function matchStock(
  demand: DemandRow[],
  stock: StockRow[],
): Map<string, number | null> {
  const bySku = new Map<string, StockRow>();
  const byName = new Map<string, StockRow>();
  for (const s of stock) {
    if (s.sku) bySku.set(String(s.sku), s);
    byName.set(`${s.product ?? ""} ${s.variant ?? ""}`, s);
  }
  const out = new Map<string, number | null>();
  for (const row of demand) {
    const hit = (row.sku ? bySku.get(row.sku) : undefined) ?? byName.get(`${row.title} ${row.variant}`);
    out.set(demandKey(row), hit && hit.onHand != null ? Number(hit.onHand) : null);
  }
  return out;
}

/** Stable identity for a demand row, for React keys and stock lookup. */
export function demandKey(row: DemandRow): string {
  return row.sku ? `sku:${row.sku}` : `nm:${row.title} ${row.variant}`;
}

/** Units short, or null when stock is unknown. Never guesses. */
export function shortfall(demand: number, onHand: number | null): number | null {
  return onHand == null ? null : Math.max(0, demand - onHand);
}
