"use client";

/**
 * Inventory vs orders.
 *
 * The split is the point. Demand is ARITHMETIC, so it is computed here from
 * the structured line items `shopifyListOrders` returns (title + variant + sku
 * + quantity) and rendered BEFORE the assistant is involved. The assistant is
 * asked for one thing only: stock at the chosen location.
 *
 * [COMP:app-web/shopify-app]
 */

import { useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useT } from "@/lib/i18n/client";
import { askAssistant, callTool, extractJson, ShopifyCallError } from "@/lib/api/shopify";
import {
  aggregateDemand,
  demandKey,
  matchStock,
  shortfall,
  type Demand,
  type OrderRow,
  type StockRow,
} from "@/lib/shopify-demand";
import {
  DEFAULT_RANGE,
  Field,
  Kpi,
  LooseAnswer,
  Note,
  RangeControl,
  iso,
  orderDigits,
  type OrderNo,
  type Range,
} from "./shopify-shared";

type OrdersPage = { items?: OrderRow[]; has_next_page?: boolean; end_cursor?: string };
type Levels = { items?: Array<{ locations?: Array<{ location?: string }> }> };

/** Up to 6 pages of 50. Stated in the UI when it bites, never silently. */
const MAX_PAGES = 6;

export function InventoryTab({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [orderNo, setOrderNo] = useState<OrderNo>({ from: "", to: "" });
  const [location, setLocation] = useState("");
  const [locations, setLocations] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demand, setDemand] = useState<Demand | null>(null);
  const [more, setMore] = useState(false);
  const [orderCount, setOrderCount] = useState(0);
  const [stock, setStock] = useState<Map<string, number | null> | null>(null);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [loose, setLoose] = useState<string | null>(null);

  // Real locations, from the store. A typed location that does not exist
  // returns nothing and looks exactly like "no stock", so this is a picker
  // rather than a text field and the options come from the store itself.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await callTool<Levels>(workspaceId, "shopifyGetInventoryLevels", { first: 50 });
        const names = new Set<string>();
        for (const it of res.items ?? []) {
          for (const l of it.locations ?? []) if (l.location) names.add(l.location);
        }
        if (alive) setLocations([...names].sort());
      } catch {
        // A location list we cannot read is not a reason to block the tab -
        // the primary-location default still works.
        if (alive) setLocations([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  async function fetchOrders(): Promise<{ items: OrderRow[]; more: boolean }> {
    const endExclusive = iso(new Date(new Date(`${range.until}T00:00:00Z`).getTime() + 864e5));
    const query = `created_at:>=${range.since} created_at:<${endExclusive}`;
    let items: OrderRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await callTool<OrdersPage>(workspaceId, "shopifyListOrders", {
        query,
        first: 50,
        ...(cursor ? { cursor } : {}),
      });
      items = items.concat(res.items ?? []);
      if (!res.has_next_page || !res.end_cursor) return { items, more: false };
      cursor = res.end_cursor;
    }
    return { items, more: true };
  }

  async function run() {
    setBusy(true);
    setError(null);
    setLoose(null);
    setStock(null);
    setUnmatched([]);
    setStatus(t.shopifyApp.readingOrders);
    try {
      const page = await fetchOrders();
      // Shopify has no order-NUMBER range filter, so this half is applied here.
      const from = orderNo.from ? Number(orderNo.from) : null;
      const to = orderNo.to ? Number(orderNo.to) : null;
      const filtered =
        from == null && to == null
          ? page.items
          : page.items.filter((o) => {
              const d = orderDigits(String(o.name ?? ""));
              if (!d) return false;
              const n = Number(d);
              return (from == null || n >= from) && (to == null || n <= to);
            });

      setOrderCount(filtered.length);
      setMore(page.more);
      if (!filtered.length) {
        setDemand(null);
        setStatus(t.shopifyApp.noOrders);
        return;
      }

      const agg = aggregateDemand(filtered);
      // Exact demand is on screen before the assistant runs. If the stock step
      // fails, the owner still has the half that is arithmetic.
      setDemand(agg);
      setStatus(t.shopifyApp.checkingStock);

      const task = `Look up current stock for these exact variants and return it. Do NOT recount
demand - it is already computed from the order data and is authoritative.

Location: ${location || "the store's primary location (say which one you used)"}

Variants (identify by SKU where present):
${agg.rows
  .map(
    (r) =>
      `- sku=${r.sku || "(none)"} | product=${r.title} | variant=${r.variant || "(none)"} | ordered=${r.demand}`,
  )
  .join("\n")}

Use your inventory tool to get AVAILABLE stock at that location for each one.
If you cannot find a variant, say so for that variant rather than guessing a number.

Reply with ONLY a JSON object, no prose:
{"location":"...","stock":[{"sku":"","product":"","variant":"","onHand":0}],
 "unmatched":["variants you could not find"],"notes":""}`;

      const answer = await askAssistant(workspaceId, task);
      const parsed = extractJson<{ stock?: StockRow[]; unmatched?: string[] }>(answer);
      if (!parsed || !Array.isArray(parsed.stock)) {
        setLoose(answer);
        setStatus(null);
        return;
      }
      setStock(matchStock(agg.rows, parsed.stock));
      setUnmatched(parsed.unmatched ?? []);
      setStatus(null);
    } catch (err) {
      setError(err instanceof ShopifyCallError ? err.message : String(err));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  const shortCount =
    demand && stock
      ? demand.rows.filter((r) => (shortfall(r.demand, stock.get(demandKey(r)) ?? null) ?? 0) > 0)
          .length
      : 0;

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t.shopifyApp.whichOrders}
      </h2>

      <RangeControl
        range={range}
        onRange={setRange}
        orderNo={orderNo}
        onOrderNo={setOrderNo}
        onApply={() => void run()}
        busy={busy}
        applyLabel={t.shopifyApp.buildBreakdown}
      />

      <Field label={t.shopifyApp.stockLocation}>
        <SearchableSelect
          value={location}
          onValueChange={setLocation}
          items={[
            { value: "", label: t.shopifyApp.primaryLocation },
            ...(locations ?? []).map((l) => ({ value: l, label: l })),
          ]}
          className="min-w-[240px]"
          aria-label={t.shopifyApp.stockLocation}
        />
      </Field>

      {error ? <Note tone="error">{error}</Note> : null}
      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}

      {demand ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi label={t.shopifyApp.orders} value={orderCount} />
            <Kpi label={t.shopifyApp.variants} value={demand.rows.length} />
            <Kpi label={t.shopifyApp.unitsOrdered} value={demand.totalUnits} />
          </div>

          {/* Every caveat that makes a total less than complete, stated WITH
              the total rather than after it. */}
          {more ? <Note>{t.shopifyApp.partialWindow}</Note> : null}
          {demand.linesTruncated ? (
            <Note>{`${demand.linesTruncated} ${t.shopifyApp.linesTruncated}`}</Note>
          ) : null}
          {demand.noSku ? <Note>{`${demand.noSku} ${t.shopifyApp.noSkuLines}`}</Note> : null}
          {unmatched.length ? (
            <Note>{`${t.shopifyApp.notFound} ${unmatched.join(", ")}`}</Note>
          ) : null}
          {stock ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Kpi label={t.shopifyApp.short} value={shortCount} />
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-semibold">{t.shopifyApp.product}</th>
                  <th className="px-3 py-2 text-left font-semibold">{t.shopifyApp.variant}</th>
                  <th className="px-3 py-2 text-left font-semibold">{t.shopifyApp.sku}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t.shopifyApp.ordered}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t.shopifyApp.onHand}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t.shopifyApp.short}</th>
                </tr>
              </thead>
              <tbody>
                {demand.rows.map((r) => {
                  const onHand = stock ? (stock.get(demandKey(r)) ?? null) : null;
                  const gap = shortfall(r.demand, onHand);
                  return (
                    <tr
                      key={demandKey(r)}
                      className={`border-b border-border last:border-0 ${gap ? "text-amber-600 dark:text-amber-400" : ""}`}
                    >
                      <td className="px-3 py-2">{r.title}</td>
                      <td className="px-3 py-2">{r.variant || "-"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.sku || "-"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.demand}</td>
                      {/* A variant the assistant could not find shows a dash,
                          never 0: an unknown rendered as zero is how "we have
                          none of these" gets invented. */}
                      <td className="px-3 py-2 text-right tabular-nums">{onHand ?? "-"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{gap ? gap : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {loose ? <LooseAnswer text={loose} /> : null}
    </div>
  );
}
