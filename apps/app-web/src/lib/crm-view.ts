/**
 * CRM operator surface — pure view logic (no React, no IO). Owns:
 *
 *   - the section model (Deals / Contacts / Companies) + URL codec
 *     (`?section=contacts&filter=overdue&stage=...`) — the URL is the single
 *     source of truth so the sidebar panel, the surface, and the Home dock
 *     card (`?filter=overdue`) all speak one language;
 *   - the attention quick-filter predicates (Overdue close / Stale / No
 *     amount on deals; Orphaned on contacts) shared with their live counts —
 *     the `overdue` definition must match `countDealAttention` in
 *     packages/api/src/home/signals.ts (the `deal_attention` dock card);
 *   - per-section filters + sort;
 *   - the display-name joins (client-side — the flat route deliberately
 *     ships ids only, crm.md → "Operator surface");
 *   - the board's stage grouping + per-column amount summaries.
 *
 * Spec: docs/architecture/features/crm.md → "Operator surface".
 * [COMP:app-web/crm-view]
 */

import {
  isOpenStage,
  type CrmCompanyRow,
  type CrmContactRow,
  type CrmDealRow,
  type DealStage,
} from "@/lib/api/crm";

// ── Attention quick-filters ─────────────────────────────────────────────

/** Open deal untouched this long ⇒ stale. Mirrors the tasks surface's
 *  STALE_AFTER_DAYS so "stale" means one thing across operator apps. */
const STALE_AFTER_DAYS = 30;

export const DEAL_QUICK_FILTERS = ["overdue", "stale", "noAmount"] as const;
export type DealQuickFilter = (typeof DEAL_QUICK_FILTERS)[number];

export const CONTACT_QUICK_FILTERS = ["orphaned"] as const;
type ContactQuickFilter = (typeof CONTACT_QUICK_FILTERS)[number];

export type CrmQuickFilter = DealQuickFilter | ContactQuickFilter;
const CRM_QUICK_FILTERS: readonly CrmQuickFilter[] = [
  ...DEAL_QUICK_FILTERS,
  ...CONTACT_QUICK_FILTERS,
];

/** The section a quick-filter lives on — a `?filter=` deep link with no
 *  explicit section lands there (the dock card sends `?filter=overdue`). */
export function sectionForQuickFilter(filter: CrmQuickFilter): CrmSection {
  return filter === "orphaned" ? "contacts" : "deals";
}

/** Local calendar date as `YYYY-MM-DD` — lexicographic compare is safe. */
export function localDateStr(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/** Does the deal match the quick-filter at `now`? Pure so the chips'
 *  counts and the applied filter can never disagree. The `overdue`
 *  predicate is the surface half of the `deal_attention` dock contract:
 *  open stage + close_date strictly before today. */
export function matchesDealQuickFilter(
  row: CrmDealRow,
  filter: DealQuickFilter,
  now: Date,
): boolean {
  switch (filter) {
    case "overdue":
      return (
        isOpenStage(row.stage) &&
        row.closeDate !== null &&
        row.closeDate < localDateStr(now)
      );
    case "stale": {
      if (!isOpenStage(row.stage)) return false;
      const cutoff = now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
      return new Date(row.updatedAt).getTime() < cutoff;
    }
    case "noAmount":
      return isOpenStage(row.stage) && row.amount === null;
  }
}

function matchesContactQuickFilter(
  row: CrmContactRow,
  filter: ContactQuickFilter,
): boolean {
  switch (filter) {
    case "orphaned":
      return row.companyId === null;
  }
}

export type CrmQuickCounts = Record<CrmQuickFilter, number>;

export function crmQuickCounts(
  deals: readonly CrmDealRow[],
  contacts: readonly CrmContactRow[],
  now: Date,
): CrmQuickCounts {
  const counts: CrmQuickCounts = { overdue: 0, stale: 0, noAmount: 0, orphaned: 0 };
  for (const row of deals) {
    for (const f of DEAL_QUICK_FILTERS) {
      if (matchesDealQuickFilter(row, f, now)) counts[f]++;
    }
  }
  for (const row of contacts) {
    if (matchesContactQuickFilter(row, "orphaned")) counts.orphaned++;
  }
  return counts;
}

// ── View state + URL codec ──────────────────────────────────────────────

export const CRM_SECTIONS = ["deals", "contacts", "companies"] as const;
export type CrmSection = (typeof CRM_SECTIONS)[number];

const VIEW_MODES = ["board", "table"] as const;
type ViewMode = (typeof VIEW_MODES)[number];

export const DEAL_SORT_KEYS = ["updated", "amount", "close"] as const;
export type DealSortKey = (typeof DEAL_SORT_KEYS)[number];

export type CrmViewState = {
  section: CrmSection;
  /** Deals presentation — board is the default (pipeline-first, §1.4). */
  view: ViewMode;
  /** Active attention quick-filter, or null. */
  quick: CrmQuickFilter | null;
  /** Deal stage filter (empty = all). */
  stages: DealStage[];
  /** `null` = any; `"none"` = unlinked; else a company entity id. */
  company: string | "none" | null;
  /** `null` = any; else a tag (contacts/companies). */
  tag: string | null;
  /** Free-text needle over names (+ email/domain). */
  q: string;
  sort: DealSortKey;
  /** Reveal won/lost rows (they fold by default). */
  closed: boolean;
};

export const DEFAULT_CRM_VIEW: CrmViewState = {
  section: "deals",
  view: "board",
  quick: null,
  stages: [],
  company: null,
  tag: null,
  q: "",
  sort: "updated",
  closed: false,
};

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null {
  return value !== null && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

const STAGE_KEYS: readonly DealStage[] = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
];

/** Parse the surface's search params (unknown → default). The dock card's
 *  `?filter=overdue` deep link lands here: a quick-filter with no explicit
 *  section resolves to its home section. */
export function crmViewFromSearch(
  search: string | URLSearchParams | null | undefined,
): CrmViewState {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  if (!params) return { ...DEFAULT_CRM_VIEW };
  const quick = oneOf(params.get("filter"), CRM_QUICK_FILTERS);
  const section =
    oneOf(params.get("section"), CRM_SECTIONS) ??
    (quick ? sectionForQuickFilter(quick) : DEFAULT_CRM_VIEW.section);
  const stages = (params.get("stage") ?? "")
    .split(",")
    .filter((s): s is DealStage => (STAGE_KEYS as readonly string[]).includes(s));
  const companyRaw = params.get("company");
  const tagRaw = params.get("tag");
  return {
    section,
    view: oneOf(params.get("view"), VIEW_MODES) ?? DEFAULT_CRM_VIEW.view,
    quick,
    stages,
    company: companyRaw === null || companyRaw === "" ? null : companyRaw,
    tag: tagRaw === null || tagRaw === "" ? null : tagRaw,
    q: params.get("q") ?? "",
    sort: oneOf(params.get("sort"), DEAL_SORT_KEYS) ?? DEFAULT_CRM_VIEW.sort,
    closed: params.get("closed") === "1",
  };
}

/** Encode a view state back into search params (defaults omitted, so the
 *  bare `/crm` URL stays clean). Inverse of `crmViewFromSearch`. */
export function searchFromCrmView(state: CrmViewState): string {
  const params = new URLSearchParams();
  if (state.section !== DEFAULT_CRM_VIEW.section)
    params.set("section", state.section);
  if (state.view !== DEFAULT_CRM_VIEW.view) params.set("view", state.view);
  if (state.quick) params.set("filter", state.quick);
  if (state.stages.length > 0) params.set("stage", state.stages.join(","));
  if (state.company !== null) params.set("company", state.company);
  if (state.tag !== null) params.set("tag", state.tag);
  if (state.q.length > 0) params.set("q", state.q);
  if (state.sort !== DEFAULT_CRM_VIEW.sort) params.set("sort", state.sort);
  if (state.closed) params.set("closed", "1");
  return params.toString();
}

// ── Display-name joins (client-side) ────────────────────────────────────

export function companyNameById(
  companies: readonly CrmCompanyRow[],
): Map<string, string> {
  return new Map(companies.map((c) => [c.id, c.name]));
}

export function contactNameById(
  contacts: readonly CrmContactRow[],
): Map<string, string> {
  return new Map(contacts.map((c) => [c.id, c.name]));
}

/** Per-company rollup for the Companies table (contact + open-deal counts
 *  come free from the one flat payload). */
export function companyStats(
  contacts: readonly CrmContactRow[],
  deals: readonly CrmDealRow[],
): Map<string, { contacts: number; openDeals: number }> {
  const stats = new Map<string, { contacts: number; openDeals: number }>();
  const bump = (id: string, key: "contacts" | "openDeals") => {
    const cur = stats.get(id) ?? { contacts: 0, openDeals: 0 };
    cur[key]++;
    stats.set(id, cur);
  };
  for (const c of contacts) if (c.companyId) bump(c.companyId, "contacts");
  for (const d of deals) {
    if (d.companyId && isOpenStage(d.stage)) bump(d.companyId, "openDeals");
  }
  return stats;
}

/** Distinct tags across contacts + companies, sorted (the tag filter). */
export function crmTagOptions(
  contacts: readonly CrmContactRow[],
  companies: readonly CrmCompanyRow[],
): string[] {
  const tags = new Set<string>();
  for (const c of contacts) for (const t of c.tags) tags.add(t);
  for (const c of companies) for (const t of c.tags) tags.add(t);
  return [...tags].sort((a, b) => a.localeCompare(b));
}

// ── Applying the state ──────────────────────────────────────────────────

/** Filter deals to the view state. The closed fold applies FIRST (won/lost
 *  hide unless revealed or explicitly stage-filtered in); quick filters
 *  pick their own slice (they only ever match open stages). */
export function applyDealFilters(
  rows: readonly CrmDealRow[],
  state: CrmViewState,
  companyNames: Map<string, string>,
  now: Date,
): CrmDealRow[] {
  const needle = state.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (state.quick && state.quick !== "orphaned") {
      if (!matchesDealQuickFilter(row, state.quick, now)) return false;
    } else if (state.stages.length > 0) {
      if (!state.stages.includes(row.stage)) return false;
    } else if (!state.closed && !isOpenStage(row.stage)) {
      return false;
    }
    if (state.company !== null) {
      if (state.company === "none") {
        if (row.companyId !== null) return false;
      } else if (row.companyId !== state.company) return false;
    }
    if (needle) {
      const company = row.companyId
        ? (companyNames.get(row.companyId) ?? "")
        : "";
      if (
        !row.name.toLowerCase().includes(needle) &&
        !company.toLowerCase().includes(needle)
      )
        return false;
    }
    return true;
  });
}

export function applyContactFilters(
  rows: readonly CrmContactRow[],
  state: CrmViewState,
): CrmContactRow[] {
  const needle = state.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (state.quick === "orphaned" && !matchesContactQuickFilter(row, "orphaned"))
      return false;
    if (state.company !== null) {
      if (state.company === "none") {
        if (row.companyId !== null) return false;
      } else if (row.companyId !== state.company) return false;
    }
    if (state.tag !== null && !row.tags.includes(state.tag)) return false;
    if (
      needle &&
      !row.name.toLowerCase().includes(needle) &&
      !(row.email ?? "").toLowerCase().includes(needle)
    )
      return false;
    return true;
  });
}

export function applyCompanyFilters(
  rows: readonly CrmCompanyRow[],
  state: CrmViewState,
): CrmCompanyRow[] {
  const needle = state.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (state.tag !== null && !row.tags.includes(state.tag)) return false;
    if (
      needle &&
      !row.name.toLowerCase().includes(needle) &&
      !(row.domain ?? "").toLowerCase().includes(needle)
    )
      return false;
    return true;
  });
}

export function sortDeals(rows: CrmDealRow[], sort: DealSortKey): CrmDealRow[] {
  const sorted = [...rows];
  switch (sort) {
    case "updated":
      sorted.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      break;
    case "amount":
      // Biggest first; unpriced rows sink to the bottom.
      sorted.sort((a, b) => {
        if (a.amount === null && b.amount === null) return 0;
        if (a.amount === null) return 1;
        if (b.amount === null) return -1;
        return b.amount - a.amount;
      });
      break;
    case "close":
      // Soonest close first; undated rows sink (lexicographic — ISO dates).
      sorted.sort((a, b) => {
        if (a.closeDate === null && b.closeDate === null) return 0;
        if (a.closeDate === null) return 1;
        if (b.closeDate === null) return -1;
        return a.closeDate < b.closeDate ? -1 : a.closeDate > b.closeDate ? 1 : 0;
      });
      break;
  }
  return sorted;
}

// ── Board grouping ──────────────────────────────────────────────────────

export type StageSummary = {
  stage: DealStage;
  rows: CrmDealRow[];
  /** Sum of the column's priced amounts (null-amount rows excluded — the
   *  No-amount preset catches those). */
  amountSum: number;
};

/** Group filtered deals into stage columns, pipeline order. Every stage in
 *  `stages` gets a column even when empty (stable board layout). */
export function groupDealsByStage(
  rows: readonly CrmDealRow[],
  stages: readonly DealStage[],
): StageSummary[] {
  return stages.map((stage) => {
    const inStage = rows.filter((r) => r.stage === stage);
    return {
      stage,
      rows: inStage,
      amountSum: inStage.reduce((sum, r) => sum + (r.amount ?? 0), 0),
    };
  });
}

/** Compact money label for column headers / cards: $12.5k, $140k, $1.2M —
 *  one decimal below 100 of the unit, integers above. */
export function formatAmount(amount: number): string {
  const compact = (v: number, suffix: string) =>
    `$${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${suffix}`;
  if (Math.abs(amount) >= 1_000_000) return compact(amount / 1_000_000, "M");
  if (Math.abs(amount) >= 1_000) return compact(amount / 1_000, "k");
  return `$${amount.toLocaleString()}`;
}
