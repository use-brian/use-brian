"use client";

/**
 * Act on the numbers.
 *
 * The owner does not know which question to ask - that is the problem this tab
 * solves. So it offers real questions, and each one runs a REAL query here in
 * code. The table is the store's own numbers; the assistant only reads them
 * back. That ordering matters: a model asked "how is my store doing" invents an
 * agenda, a model handed six rows and a question does not.
 *
 * [COMP:app-web/shopify-app]
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { askAssistant, callTool, ShopifyCallError } from "@/lib/api/shopify";
import {
  AutoTable,
  DEFAULT_RANGE,
  Kpi,
  Note,
  RangeControl,
  type Range,
} from "./shopify-shared";

type FunnelArgs = { groupBy?: string; compareToPreviousPeriod?: boolean };
type Funnel = { rows?: Array<Record<string, unknown>>; no_human_sessions?: string };
type Sales = {
  orders_count?: number;
  revenue?: string;
  top_items?: Array<Record<string, unknown>>;
  truncated?: boolean;
};

type Analysis = {
  key: string;
  title: string;
  hint: string;
  brief: string;
  args?: FunnelArgs;
  sales?: boolean;
};

export function AnalyseTab({ workspaceId }: { workspaceId: string }) {
  const t = useT();

  const ANALYSES: Analysis[] = [
    {
      key: "dropout",
      title: t.shopifyApp.anDropout,
      hint: t.shopifyApp.anDropoutHint,
      args: {},
      brief: "Name the single worst drop-off step and what specifically to change about it.",
    },
    {
      key: "changed",
      title: t.shopifyApp.anChanged,
      hint: t.shopifyApp.anChangedHint,
      args: { compareToPreviousPeriod: true },
      brief:
        "Lead with what MOVED and by how much. If nothing moved meaningfully, say so and stop.",
    },
    {
      key: "source",
      title: t.shopifyApp.anSource,
      hint: t.shopifyApp.anSourceHint,
      args: { groupBy: "referrer_source" },
      brief: "Say which source converts best and worst, and whether the worst is worth keeping.",
    },
    {
      key: "device",
      title: t.shopifyApp.anDevice,
      hint: t.shopifyApp.anDeviceHint,
      args: { groupBy: "session_device_type" },
      brief: "Say whether one device is dragging the store down, and what to check on it first.",
    },
    {
      key: "country",
      title: t.shopifyApp.anCountry,
      hint: t.shopifyApp.anCountryHint,
      args: { groupBy: "session_country" },
      brief: "Say which markets are real and whether any deserve different shipping or currency.",
    },
    {
      key: "sells",
      title: t.shopifyApp.anSells,
      hint: t.shopifyApp.anSellsHint,
      sales: true,
      brief: "Say which items carry the store and which are dead weight.",
    },
  ];

  const [picked, setPicked] = useState(ANALYSES[0].key);
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [kpis, setKpis] = useState<Array<{ label: string; value: string }> | null>(null);
  const [caveats, setCaveats] = useState<string[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);

  async function run() {
    const analysis = ANALYSES.find((a) => a.key === picked);
    if (!analysis) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    setRows(null);
    setKpis(null);
    setCaveats([]);
    setStatus(t.shopifyApp.querying);

    try {
      let payload: unknown;
      const notes: string[] = [];

      if (analysis.sales) {
        const res = await callTool<Sales>(workspaceId, "shopifySalesReport", {
          since: range.since,
          until: range.until,
        });
        payload = res;
        setKpis([
          { label: t.shopifyApp.orders, value: String(res.orders_count ?? 0) },
          { label: t.shopifyApp.revenue, value: String(res.revenue ?? "0") },
          { label: t.shopifyApp.topItems, value: String((res.top_items ?? []).length) },
        ]);
        setRows(res.top_items ?? []);
        // Truncation is stated in the same breath as the number, never after.
        if (res.truncated) notes.push(t.shopifyApp.truncatedSales);
        if (!res.orders_count) notes.push(t.shopifyApp.noOrdersReal);
      } else {
        const res = await callTool<Funnel>(workspaceId, "shopifyStorefrontFunnel", {
          since: range.since,
          until: range.until,
          ...(analysis.args ?? {}),
        });
        payload = res;
        setRows(res.rows ?? []);
        // The documented trap: an all-bot store reports zero, and zero here is
        // a FINDING about the storefront, not an empty result to shrug at.
        if (res.no_human_sessions) {
          notes.push(`${t.shopifyApp.noHumanSessions} ${res.no_human_sessions}`);
        } else if (!(res.rows ?? []).length) {
          notes.push(t.shopifyApp.noRows);
        }
      }
      setCaveats(notes);
      setStatus(t.shopifyApp.working);

      const task = `Read these storefront numbers for this store and tell the owner what to do.

Question asked: ${analysis.title}
Window: ${range.since} to ${range.until}

These are the actual numbers, already queried. Do NOT re-query to get them again,
and do not contradict them:
${JSON.stringify(payload, null, 1)}

${analysis.brief}
${
  ask
    ? `\nThe owner also asked this, in their own words. Answer it FIRST, from the numbers
above, and say plainly if the numbers cannot answer it:\n"${ask}"\n`
    : ""
}
Rules:
- Three or four items at most, ranked. A list of twelve is a report nobody acts on.
- Each item names the number it came from and the concrete next step.
- If the numbers are all zero or too thin to support a conclusion, say exactly that
  and stop. Do not manufacture an insight to fill the space.
- Shoppers who added to cart and never reached checkout are anonymous and cannot be
  contacted. Treat that as a fix to the store, never as outreach.`;

      setAnswer(await askAssistant(workspaceId, task));
      setStatus(null);
    } catch (err) {
      setError(err instanceof ShopifyCallError ? err.message : String(err));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t.shopifyApp.whatToKnow}
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{t.shopifyApp.analysisHelp}</p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {ANALYSES.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={() => setPicked(a.key)}
            aria-pressed={a.key === picked}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
              a.key === picked
                ? "border-primary bg-primary/5"
                : "border-border bg-card hover:border-primary/40"
            }`}
          >
            <span className="block text-[13px] font-semibold">{a.title}</span>
            <span className="mt-0.5 block text-[11.5px] text-muted-foreground">{a.hint}</span>
          </button>
        ))}
      </div>

      <RangeControl
        range={range}
        onRange={setRange}
        onApply={() => void run()}
        busy={busy}
        applyLabel={t.shopifyApp.runIt}
      />

      <div className="space-y-1">
        <label htmlFor="shopify-ask" className="text-xs font-medium text-muted-foreground">
          {`${t.shopifyApp.askYourOwn} (${t.shopifyApp.optional})`}
        </label>
        <textarea
          id="shopify-ask"
          rows={2}
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder={t.shopifyApp.askPlaceholder}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
        <p className="text-[12px] text-muted-foreground">{t.shopifyApp.askHelp}</p>
      </div>

      {error ? <Note tone="error">{error}</Note> : null}
      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}

      {kpis ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {kpis.map((k) => (
            <Kpi key={k.label} label={k.label} value={k.value} />
          ))}
        </div>
      ) : null}

      {rows ? <AutoTable rows={rows} /> : null}
      {caveats.map((c) => (
        <Note key={c}>{c}</Note>
      ))}

      {answer ? (
        <pre className="whitespace-pre-wrap rounded-xl border border-border bg-card px-4 py-3 text-[13px]">
          {answer}
        </pre>
      ) : null}
    </div>
  );
}
