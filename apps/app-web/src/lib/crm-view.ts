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
  type CrmFieldDefinition,
  type CrmPipeline,
  type CrmPipelineStage,
  type CrmRecordBundle,
  type DealStage,
} from "@/lib/api/crm";
// One codec for the multi-value URL shape across both operator surfaces —
// see tasks-view.ts (docs/architecture/features/tasks.md carries the spec).
import { multiParam } from "@/lib/tasks-view";

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
export type CrmRecordKind = "deal" | "contact" | "company";

/** Canonical collection/detail hrefs. Search state is kept verbatim so
 * opening a record and returning to its collection preserves the lens. */
export function crmCollectionHref(workspaceId: string, search = ""): string {
  const path = `/w/${encodeURIComponent(workspaceId)}/crm`;
  return search ? `${path}?${search}` : path;
}

export function crmRecordHref(
  workspaceId: string,
  kind: CrmRecordKind,
  recordId: string,
  search = "",
): string {
  const path = `${crmCollectionHref(workspaceId)}/${kind}/${encodeURIComponent(recordId)}`;
  return search ? `${path}?${search}` : path;
}

/** Guard the cold record response against a stale or mistyped route. */
export function crmRecordMatchesRoute(
  bundle: CrmRecordBundle | null | undefined,
  kind: CrmRecordKind,
  recordId: string,
): bundle is CrmRecordBundle {
  return bundle?.record.kind === kind && bundle.record.id === recordId;
}

const VIEW_MODES = ["board", "table"] as const;
type ViewMode = (typeof VIEW_MODES)[number];

export const DEAL_SORT_KEYS = ["updated", "amount", "close"] as const;
export type DealSortKey = (typeof DEAL_SORT_KEYS)[number];

export type CrmViewState = {
  section: CrmSection;
  /** Dedicated consequential-action workspace layered over the record lens. */
  review: "email" | null;
  /** Selected pending approval while `review=email`. */
  draft: string | null;
  /** Deals presentation — board is the default (pipeline-first, §1.4). */
  view: ViewMode;
  /** Active attention quick-filter, or null. */
  quick: CrmQuickFilter | null;
  /** Selected stable pipeline id. Null resolves to the workspace default. */
  pipeline: string | null;
  /**
   * Deal stage filter (empty = all). Like every property filter here, it is
   * a SET — OR within the property, AND across properties, matching the
   * Tasks surface (they drive the same `FilterBar`).
   */
  stages: string[];
  /** Company filter: entity ids and/or `"none"` (unlinked). Empty = any. */
  company: string[];
  /** Tag filter (contacts/companies): any-of. Empty = any. */
  tag: string[];
  /** Typed custom-field filters keyed by stable field key. */
  custom: Record<string, string[]>;
  /** `cf:<fieldKey>` for a single-valued custom grouping. */
  group: string | null;
  /** Free-text needle over names (+ email/domain). */
  q: string;
  sort: DealSortKey;
  /** Reveal won/lost rows (they fold by default). */
  closed: boolean;
};

export const DEFAULT_CRM_VIEW: CrmViewState = {
  section: "deals",
  review: null,
  draft: null,
  view: "board",
  quick: null,
  pipeline: null,
  stages: [],
  company: [],
  tag: [],
  custom: {},
  group: null,
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
  const stages = multiParam(params, "stage", { splitCommas: true });
  const custom: Record<string, string[]> = {};
  for (const [key, value] of params.entries()) {
    if (!key.startsWith("cf.") || !value) continue;
    const fieldKey = key.slice(3);
    custom[fieldKey] = [...(custom[fieldKey] ?? []), value];
  }
  return {
    section,
    review: params.get("review") === "email" ? "email" : null,
    draft: params.get("review") === "email" ? params.get("draft") : null,
    view: oneOf(params.get("view"), VIEW_MODES) ?? DEFAULT_CRM_VIEW.view,
    quick,
    pipeline: params.get("pipeline"),
    stages,
    // Company ids are opaque and comma-free, so they comma-join; tags are
    // user text and repeat the param instead (a tag may contain a comma).
    company: multiParam(params, "company", { splitCommas: true }),
    tag: multiParam(params, "tag", { splitCommas: false }),
    custom,
    group: params.get("group"),
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
  if (state.review === "email") {
    params.set("review", "email");
    if (state.draft) params.set("draft", state.draft);
  }
  if (state.view !== DEFAULT_CRM_VIEW.view) params.set("view", state.view);
  if (state.quick) params.set("filter", state.quick);
  if (state.pipeline) params.set("pipeline", state.pipeline);
  if (state.stages.length > 0) params.set("stage", state.stages.join(","));
  if (state.company.length > 0) params.set("company", state.company.join(","));
  // Repeated, never joined — a tag may contain a comma.
  for (const tag of state.tag) params.append("tag", tag);
  for (const fieldKey of Object.keys(state.custom).sort()) {
    for (const value of state.custom[fieldKey] ?? []) params.append(`cf.${fieldKey}`, value);
  }
  if (state.group) params.set("group", state.group);
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

/** Any-of over the company set (`"none"` = unlinked); empty = unfiltered. */
function matchesCompany(
  row: { companyId: string | null },
  company: readonly string[],
): boolean {
  if (company.length === 0) return true;
  return company.some((c) =>
    c === "none" ? row.companyId === null : row.companyId === c,
  );
}

/** Any-of over the tag set; empty = unfiltered. */
function matchesTag(
  row: { tags: readonly string[] },
  tag: readonly string[],
): boolean {
  if (tag.length === 0) return true;
  return tag.some((t) => row.tags.includes(t));
}

export const CRM_EMPTY_CUSTOM_VALUE = "__none__";

function customValue(row: { customFields?: Record<string, unknown> }, key: string): unknown {
  return row.customFields?.[key];
}

function matchesCustomFields(
  row: { customFields?: Record<string, unknown> },
  filters: Record<string, string[]>,
): boolean {
  return Object.entries(filters).every(([key, selected]) => {
    if (selected.length === 0) return true;
    const value = customValue(row, key);
    const empty = value === null || value === undefined || value === ""
      || (Array.isArray(value) && value.length === 0);
    if (empty) return selected.includes(CRM_EMPTY_CUSTOM_VALUE);
    if (Array.isArray(value)) return selected.some((choice) => value.includes(choice));
    return selected.includes(String(value));
  });
}

/** Filter deals to the view state. The closed fold applies FIRST (won/lost
 *  hide unless revealed or explicitly stage-filtered in); quick filters
 *  pick their own slice (they only ever match open stages). */
export function applyDealFilters(
  rows: readonly CrmDealRow[],
  state: CrmViewState,
  companyNames: Map<string, string>,
  now: Date,
  pipeline?: CrmPipeline | null,
): CrmDealRow[] {
  const needle = state.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (pipeline) {
      const belongs = row.pipelineId
        ? row.pipelineId === pipeline.id
        : pipeline.isDefault;
      if (!belongs) return false;
    }
    if (state.quick && state.quick !== "orphaned") {
      if (!matchesDealQuickFilter(row, state.quick, now)) return false;
    } else if (state.stages.length > 0) {
      const resolved = pipeline ? resolveDealPipelineStage(row, pipeline) : null;
      if (!state.stages.includes(resolved?.id ?? row.stage)) return false;
    } else if (
      !state.closed &&
      (pipeline
        ? resolveDealPipelineStage(row, pipeline)?.category !== "open"
        : !isOpenStage(row.stage))
    ) {
      return false;
    }
    if (!matchesCompany(row, state.company)) return false;
    if (!matchesCustomFields(row, state.custom)) return false;
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
    if (!matchesCompany(row, state.company)) return false;
    if (!matchesTag(row, state.tag)) return false;
    if (!matchesCustomFields(row, state.custom)) return false;
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
    if (!matchesTag(row, state.tag)) return false;
    if (!matchesCustomFields(row, state.custom)) return false;
    if (
      needle &&
      !row.name.toLowerCase().includes(needle) &&
      !(row.domain ?? "").toLowerCase().includes(needle)
    )
      return false;
    return true;
  });
}

export type CrmCustomGroup<T> = { value: string; label: string; rows: T[] };

export function groupRowsByCustomField<T extends { customFields?: Record<string, unknown> }>(
  rows: readonly T[],
  field: CrmFieldDefinition,
  referenceLabels: Map<string, string> = new Map(),
  emptyLabel = "No value",
  booleanLabels: { true: string; false: string } = { true: "true", false: "false" },
  unavailableLabel = "Unavailable record",
): CrmCustomGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const raw = customValue(row, field.fieldKey);
    const value = raw === null || raw === undefined || raw === "" ? CRM_EMPTY_CUSTOM_VALUE : String(raw);
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  return [...groups.entries()]
    .map(([value, groupedRows]) => ({
      value,
      label: value === CRM_EMPTY_CUSTOM_VALUE
        ? emptyLabel
        : field.fieldType === "boolean"
          ? value === "true" ? booleanLabels.true : booleanLabels.false
          : field.fieldType === "entity_reference"
            ? referenceLabels.get(value) ?? unavailableLabel
            : value,
      rows: groupedRows,
    }))
    .sort((a, b) => {
      if (a.value === CRM_EMPTY_CUSTOM_VALUE) return 1;
      if (b.value === CRM_EMPTY_CUSTOM_VALUE) return -1;
      return a.label.localeCompare(b.label);
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

export type PipelineStageSummary = {
  stage: CrmPipelineStage;
  rows: CrmDealRow[];
  /** Explicit per-currency totals. Mixed currencies are never combined. */
  currencyTotals: Record<string, number>;
};

/** Resolve a deal's stable stage, with the legacy key as the migration bridge. */
export function resolveDealPipelineStage(
  row: CrmDealRow,
  pipeline: CrmPipeline,
): CrmPipelineStage | null {
  return pipeline.stages.find((stage) => stage.id === row.pipelineStageId)
    ?? pipeline.stages.find((stage) => stage.legacyKey === row.stage)
    ?? null;
}

export function legacyStageForPipelineStage(stage: CrmPipelineStage): DealStage {
  if (stage.legacyKey) return stage.legacyKey;
  if (stage.category === "won") return "won";
  if (stage.category === "lost") return "lost";
  return "lead";
}

function currencyCode(row: CrmDealRow): string {
  const code = row.currencyCode?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : "USD";
}

/** Group filtered deals into stable pipeline-stage columns. */
export function groupDealsByPipelineStage(
  rows: readonly CrmDealRow[],
  pipeline: CrmPipeline,
  stages: readonly CrmPipelineStage[],
): PipelineStageSummary[] {
  return stages.map((stage) => {
    const inStage = rows.filter(
      (row) => resolveDealPipelineStage(row, pipeline)?.id === stage.id,
    );
    const currencyTotals: Record<string, number> = {};
    for (const row of inStage) {
      if (row.amount === null) continue;
      const code = currencyCode(row);
      currencyTotals[code] = Math.round(((currencyTotals[code] ?? 0) + row.amount) * 100) / 100;
    }
    return {
      stage,
      rows: inStage,
      currencyTotals,
    };
  });
}

/** Currency-explicit compact label for working views. */
export function formatAmount(amount: number, currency = "USD", compact = true): string {
  const code = currency.trim().toUpperCase() || "USD";
  if (!compact) {
    return `${code} ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  const withSuffix = (v: number, suffix: string) =>
    `${code} ${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${suffix}`;
  if (Math.abs(amount) >= 1_000_000) return withSuffix(amount / 1_000_000, "M");
  if (Math.abs(amount) >= 1_000) return withSuffix(amount / 1_000, "k");
  return `${code} ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function formatCurrencyTotals(
  values: Record<string, number>,
  compact = false,
): string {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => formatAmount(amount, currency, compact))
    .join(" · ");
}
