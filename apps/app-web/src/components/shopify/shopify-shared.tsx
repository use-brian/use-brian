"use client";

/**
 * Shared chrome for the Shopify surface: the date/order-number range control,
 * KPI cards, notes and the auto-shaped result table.
 *
 * [COMP:app-web/shopify-app]
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useT } from "@/lib/i18n/client";

export const iso = (d: Date): string => d.toISOString().slice(0, 10);
const daysAgo = (n: number): string => iso(new Date(Date.now() - (n - 1) * 864e5));

export type Range = { preset: string; since: string; until: string };
export type OrderNo = { from: string; to: string };

export const DEFAULT_RANGE: Range = { preset: "7", since: daysAgo(7), until: iso(new Date()) };

/** Digits only: "#1042" and "1042" are the same order to Shopify. */
export const orderDigits = (v: string): string => String(v ?? "").replace(/[^0-9]/g, "");

export function RangeControl({
  range,
  onRange,
  orderNo,
  onOrderNo,
  onApply,
  busy,
  applyLabel,
}: {
  range: Range;
  onRange: (r: Range) => void;
  orderNo?: OrderNo;
  onOrderNo?: (o: OrderNo) => void;
  onApply: () => void;
  busy?: boolean;
  applyLabel: string;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);

  const presets = [
    { value: "1", label: t.shopifyApp.today, days: 1 },
    { value: "7", label: t.shopifyApp.last7, days: 7 },
    { value: "30", label: t.shopifyApp.last30, days: 30 },
    { value: "60", label: t.shopifyApp.last60, days: 60 },
    { value: "custom", label: t.shopifyApp.custom, days: 0 },
  ];
  const custom = range.preset === "custom";

  function apply() {
    setError(null);
    // A backwards range matches nothing and reads as "no orders" rather than
    // "you typed it backwards", so both are checked before anything runs.
    if (custom && range.since > range.until) {
      setError(t.shopifyApp.badDateRange);
      return;
    }
    if (orderNo?.from && orderNo?.to && Number(orderNo.from) > Number(orderNo.to)) {
      setError(t.shopifyApp.badOrderRange);
      return;
    }
    onApply();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t.shopifyApp.period}>
          <SearchableSelect
            value={range.preset}
            onValueChange={(v) => {
              const p = presets.find((x) => x.value === v);
              onRange(
                v === "custom" || !p
                  ? { ...range, preset: "custom" }
                  : { preset: v, since: daysAgo(p.days), until: iso(new Date()) },
              );
            }}
            items={presets.map(({ value, label }) => ({ value, label }))}
            className="min-w-[150px]"
            aria-label={t.shopifyApp.period}
          />
        </Field>

        {custom ? (
          <>
            <Field label={t.shopifyApp.from}>
              <input
                type="date"
                value={range.since}
                max={iso(new Date())}
                onChange={(e) => onRange({ ...range, since: e.target.value })}
                className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
              />
            </Field>
            <Field label={t.shopifyApp.to}>
              <input
                type="date"
                value={range.until}
                max={iso(new Date())}
                onChange={(e) => onRange({ ...range, until: e.target.value })}
                className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
              />
            </Field>
          </>
        ) : null}

        {orderNo && onOrderNo ? (
          <>
            <Field label={t.shopifyApp.orderFrom}>
              <input
                inputMode="numeric"
                value={orderNo.from}
                placeholder="1001"
                onChange={(e) => onOrderNo({ ...orderNo, from: orderDigits(e.target.value) })}
                className="h-9 w-28 rounded-lg border border-border bg-background px-2 text-sm"
              />
            </Field>
            <Field label={t.shopifyApp.orderTo}>
              <input
                inputMode="numeric"
                value={orderNo.to}
                placeholder="1099"
                onChange={(e) => onOrderNo({ ...orderNo, to: orderDigits(e.target.value) })}
                className="h-9 w-28 rounded-lg border border-border bg-background px-2 text-sm"
              />
            </Field>
          </>
        ) : null}

        <Button onClick={apply} disabled={busy}>
          {applyLabel}
        </Button>
      </div>
      {error ? <Note tone="error">{error}</Note> : null}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function Kpi({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function Note({
  children,
  tone = "warn",
}: {
  children: React.ReactNode;
  tone?: "warn" | "error" | "muted";
}) {
  const cls =
    tone === "error"
      ? "border-l-destructive bg-destructive/10"
      : tone === "muted"
        ? "border-l-border bg-muted/40"
        : "border-l-amber-500 bg-amber-500/10";
  return (
    <div className={`rounded-r-lg border-l-[3px] px-3 py-2 text-[13px] ${cls}`}>{children}</div>
  );
}

const COL_LABEL: Record<string, string> = {
  sessions: "Sessions",
  online_store_visitors: "Visitors",
  sessions_with_cart_additions: "Added to cart",
  sessions_that_reached_checkout: "Reached checkout",
  sessions_that_completed_checkout: "Bought",
  conversion_rate: "Conversion",
};

const prettyCol = (k: string): string =>
  COL_LABEL[k] ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * Render rows without assuming a column list.
 *
 * A GROUPED ShopifyQL query drops the `columns` list entirely, and the
 * percent-change variant adds columns no fixed list has, so the shape is taken
 * from the rows themselves. Zipping against a hardcoded header is how these
 * tables silently mislabel their own numbers.
 */
export function AutoTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (!rows.length) return null;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const isNum = (v: unknown) => v !== "" && v != null && Number.isFinite(Number(v));

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {cols.map((c) => (
              <th
                key={c}
                className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${
                  isNum(rows[0][c]) ? "text-right" : "text-left"
                }`}
              >
                {prettyCol(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {cols.map((c) => (
                <td
                  key={c}
                  className={`px-3 py-2 ${isNum(r[c]) ? "text-right tabular-nums" : "text-left"}`}
                >
                  {r[c] == null || r[c] === "" ? "-" : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
