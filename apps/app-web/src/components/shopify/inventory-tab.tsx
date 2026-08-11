"use client";

/**
 * Inventory vs orders.
 *
 * BOTH halves are arithmetic. Demand is computed here from the structured line
 * items `shopifyListOrders` returns (title + variant + sku + quantity), and
 * stock is computed here from an enumeration of `shopifyGetInventoryLevels`.
 * Neither is a model call, and the stock half is the interesting one because
 * it used to be.
 *
 * The old version handed stock lookup to the workspace assistant. That could
 * not work, for two reasons that both hid behind the same blank column:
 *
 *  - The consult runs at the default assistant-call budget - 10 tool calls -
 *    and `shopifyGetInventoryLevels` filtered by ONE sku or ONE product per
 *    call. A breakdown of 18 variants therefore could not finish, and most of
 *    those variants carried no sku at all, so no argument the tool had could
 *    reach them. The model burned the budget, the loop finalized with its
 *    generic apology, the reply was not the JSON the tab asked for, and every
 *    ON HAND cell rendered a dash under a "Sorry, I couldn't complete that
 *    turn." line.
 *  - The same tool at `first: 50` was over Shopify's hard 1000-point
 *    single-query ceiling and had never returned anything on any store, which
 *    is why the location picker below has only ever offered one option.
 *
 * The fix is not a bigger budget. It is that this was never a judgement call:
 * enumerate the catalogue, join on sku or normalized name, subtract. See
 * `lib/shopify-demand.ts` for the join and its honesty rules.
 *
 * [COMP:app-web/shopify-app]
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import { callTool, ShopifyCallError } from "@/lib/api/shopify";
import {
  ALL_LOCATIONS,
  aggregateDemand,
  demandKey,
  matchStock,
  onHandOf,
  shortfall,
  type Demand,
  type DemandRow,
  type OrderRow,
  type StockCell,
  type StockRow,
} from "@/lib/shopify-demand";
import {
  DEFAULT_RANGE,
  Field,
  Kpi,
  Note,
  RangeControl,
  iso,
  orderDigits,
  type OrderNo,
  type Range,
} from "./shopify-shared";

type OrdersPage = { items?: OrderRow[]; has_next_page?: boolean; end_cursor?: string };
type StockPage = { items?: StockRow[]; has_next_page?: boolean; end_cursor?: string };

/** Up to 6 pages of 50. Stated in the UI when it bites, never silently. */
const MAX_PAGES = 6;

/**
 * 25, not 50. `InventoryLevels` costs `2 + first * 35` points and Shopify
 * refuses any single query over 1000 before running it, so 50 (1752) was never
 * servable. 25 is 877, leaving headroom for the manual field costs Shopify
 * reserves the right to set.
 */
const STOCK_PAGE = 25;
/** 150 variants, mirroring MAX_PAGES for orders. Stated in the UI when it bites. */
const MAX_STOCK_PAGES = 6;

type Sort = "demand" | "name";

export function InventoryTab({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [orderNo, setOrderNo] = useState<OrderNo>({ from: "", to: "" });
  const [location, setLocation] = useState(ALL_LOCATIONS);
  const [locations, setLocations] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demand, setDemand] = useState<Demand | null>(null);
  const [more, setMore] = useState(false);
  const [orderCount, setOrderCount] = useState(0);
  const [stock, setStock] = useState<Map<string, StockCell> | null>(null);
  const [stockComplete, setStockComplete] = useState(true);
  const [stockNote, setStockNote] = useState<string | null>(null);
  const [truncatedLocations, setTruncatedLocations] = useState(0);
  const [sort, setSort] = useState<Sort>("demand");
  const [packed, setPacked] = useState<Set<string>>(new Set());

  // Real locations, from the store. A typed location that does not exist
  // returns nothing and looks exactly like "no stock", so this is a picker
  // rather than a text field and the options come from the store itself.
  // `first: 10` because this query is cost-limited (see STOCK_PAGE) - the
  // previous `first: 50` was rejected by Shopify every time, which is why this
  // list has always been empty.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await callTool<StockPage>(workspaceId, "shopifyGetInventoryLevels", {
          first: 10,
        });
        if (alive) setLocations(locationNames(res.items ?? []));
      } catch {
        // A location list we cannot read is not a reason to block the tab -
        // the all-locations total still works, and a breakdown fills this in
        // from its own enumeration anyway.
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

  /**
   * Every variant in the store, or as many as the page cap allows.
   *
   * A page that throws keeps the pages already read rather than discarding the
   * run: partial stock plus a note beats no stock at all, and the caller marks
   * the rest unknown rather than zero.
   */
  async function fetchStock(): Promise<{ rows: StockRow[]; complete: boolean; note: string | null }> {
    let rows: StockRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_STOCK_PAGES; page += 1) {
      let res: StockPage;
      try {
        res = await callTool<StockPage>(workspaceId, "shopifyGetInventoryLevels", {
          first: STOCK_PAGE,
          ...(cursor ? { cursor } : {}),
        });
      } catch (err) {
        return {
          rows,
          complete: false,
          note: err instanceof ShopifyCallError ? err.message : String(err),
        };
      }
      rows = rows.concat(res.items ?? []);
      // The cursor guard is not paranoia: the tool re-parses its arguments
      // through a zod object, which STRIPS undeclared keys. If `cursor` ever
      // stops being declared, every page is page one and the loop looks like
      // a success while reading the same 25 variants six times.
      if (!res.has_next_page || !res.end_cursor || res.end_cursor === cursor) {
        return { rows, complete: true, note: null };
      }
      cursor = res.end_cursor;
    }
    return { rows, complete: false, note: null };
  }

  async function run() {
    setBusy(true);
    setError(null);
    setStock(null);
    setStockNote(null);
    setPacked(new Set());
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
      // Exact demand is on screen before stock is read. If the stock step
      // fails, the owner still has the half that is pure arithmetic.
      setDemand(agg);
      setStatus(t.shopifyApp.readingStock);

      const { rows, complete, note } = await fetchStock();
      // The enumeration sees every location the store has, so it is a strictly
      // better source for the picker than the single priming call at mount.
      setLocations(locationNames(rows));
      setStock(matchStock(agg.rows, rows, location, complete));
      setStockComplete(complete);
      setStockNote(note);
      setTruncatedLocations(
        location === ALL_LOCATIONS ? 0 : rows.filter((r) => r.locations_truncated).length,
      );
      setStatus(null);
    } catch (err) {
      setError(err instanceof ShopifyCallError ? err.message : String(err));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => {
    if (!demand) return [];
    const list = [...demand.rows];
    return sort === "name"
      ? list.sort((a, b) => a.title.localeCompare(b.title) || a.variant.localeCompare(b.variant))
      : list;
  }, [demand, sort]);

  const shortCount = demand && stock
    ? demand.rows.filter((r) => (shortfall(r.demand, stock.get(demandKey(r))) ?? 0) > 0).length
    : 0;
  // A row whose stock we could not resolve cannot be counted short OR safe, so
  // the Short KPI understates unless the unknowns are stated beside it.
  const unknownCount = demand && stock
    ? demand.rows.filter((r) => {
        const kind = stock.get(demandKey(r))?.kind;
        return kind === "unknown" || kind === "untracked";
      }).length
    : 0;

  function togglePacked(key: string, on: boolean) {
    setPacked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <div className="space-y-3">
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
            { value: ALL_LOCATIONS, label: t.shopifyApp.allLocations },
            ...locations.map((l) => ({ value: l, label: l })),
          ]}
          className="min-w-[240px]"
          aria-label={t.shopifyApp.stockLocation}
        />
      </Field>

      {error ? <Note tone="error">{error}</Note> : null}
      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}

      {demand ? (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
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
          {!stockComplete ? (
            <Note>
              {format(t.shopifyApp.stockCapped, { count: MAX_STOCK_PAGES * STOCK_PAGE })}
            </Note>
          ) : null}
          {stockNote ? <Note tone="error">{`${t.shopifyApp.stockFailed} ${stockNote}`}</Note> : null}
          {truncatedLocations ? (
            <Note>{format(t.shopifyApp.locationsTruncated, { count: truncatedLocations })}</Note>
          ) : null}
          {stock ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <Kpi label={t.shopifyApp.short} value={shortCount} />
              {unknownCount ? (
                <Kpi label={t.shopifyApp.stockUnknown} value={unknownCount} />
              ) : null}
            </div>
          ) : null}

          <div className="flex max-w-3xl flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-muted-foreground">
              {format(t.shopifyApp.packProgress, {
                done: packed.size,
                total: demand.rows.length,
              })}
            </p>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-xs font-medium text-muted-foreground">
                {t.shopifyApp.sortBy}
              </span>
              <Button
                size="sm"
                variant={sort === "demand" ? "secondary" : "ghost"}
                onClick={() => setSort("demand")}
              >
                {t.shopifyApp.sortMostOrdered}
              </Button>
              <Button
                size="sm"
                variant={sort === "name" ? "secondary" : "ghost"}
                onClick={() => setSort("name")}
              >
                {t.shopifyApp.sortAtoZ}
              </Button>
              {packed.size ? (
                <Button size="sm" variant="ghost" onClick={() => setPacked(new Set())}>
                  {t.shopifyApp.clearTicks}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="max-w-3xl overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="w-9 px-2.5 py-1.5">
                    <span className="sr-only">{t.shopifyApp.packed}</span>
                  </th>
                  <th className="px-2.5 py-1.5 text-left font-semibold">{t.shopifyApp.product}</th>
                  <th className="w-20 px-2.5 py-1.5 text-right font-semibold">
                    {t.shopifyApp.ordered}
                  </th>
                  <th className="w-24 px-2.5 py-1.5 text-right font-semibold">
                    {t.shopifyApp.onHand}
                  </th>
                  <th className="w-20 px-2.5 py-1.5 text-right font-semibold">
                    {t.shopifyApp.short}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const key = demandKey(r);
                  const cell = stock?.get(key);
                  const gap = shortfall(r.demand, cell);
                  const done = packed.has(key);
                  return (
                    <tr
                      key={key}
                      className={cn(
                        "border-b border-border last:border-0",
                        done
                          ? "opacity-45"
                          : gap
                            ? "text-amber-600 dark:text-amber-400"
                            : undefined,
                      )}
                    >
                      <td className="px-2.5 py-2 align-top">
                        <Checkbox
                          checked={done}
                          onCheckedChange={(v) => togglePacked(key, v)}
                          aria-label={format(t.shopifyApp.packRow, { product: r.title })}
                        />
                      </td>
                      <td className="px-2.5 py-2">
                        <span className={cn("block font-medium", done && "line-through")}>
                          {r.title}
                        </span>
                        {subLine(r) ? (
                          <span className="block text-[12px] text-muted-foreground">
                            {subLine(r)}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2.5 py-2 text-right align-top text-base font-semibold tabular-nums">
                        {r.demand}
                      </td>
                      {/* A variant we could not resolve shows a dash, never 0:
                          an unknown rendered as zero is how "we have none of
                          these" gets invented. A variant Shopify is not
                          tracking says so in words, for the same reason. */}
                      <td className="px-2.5 py-2 text-right align-top tabular-nums">
                        {cell?.kind === "untracked" ? (
                          <span className="text-[12px] text-muted-foreground">
                            {t.shopifyApp.notTracked}
                          </span>
                        ) : (
                          (onHandOf(cell) ?? "-")
                        )}
                      </td>
                      <td className="px-2.5 py-2 text-right align-top tabular-nums">
                        {gap ? gap : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Variant and SKU as one muted line under the product, or nothing. */
function subLine(row: DemandRow): string {
  return [row.variant, row.sku].filter(Boolean).join(" · ");
}

/** Distinct location names across a page of inventory rows, sorted. */
function locationNames(rows: StockRow[]): string[] {
  const names = new Set<string>();
  for (const r of rows) {
    for (const l of r.locations ?? []) if (l?.location) names.add(l.location);
  }
  return [...names].sort();
}
