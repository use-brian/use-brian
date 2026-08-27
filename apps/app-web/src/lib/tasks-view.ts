/**
 * Tasks operator surface — pure view logic (no React, no IO except the
 * saved-views localStorage helpers). Owns:
 *
 *   - the filter model + URL codec (`?filter=stale&status=todo&...`) — the
 *     URL is the single source of truth so the sidebar panel, the surface,
 *     and the Home dock card (`?filter=stale`) all speak one language;
 *   - the cleanup quick-filter predicates (Stale / Done, not closed /
 *     Unassigned / No due date) shared with their live counts;
 *   - the stable Project registry-id facet;
 *   - group-by + sort;
 *   - saved views (named filter sets, per-workspace localStorage);
 *   - `multiParam`, the multi-value search-param codec — defined here
 *     because tasks.md carries its spec, imported by the CRM twin
 *     (`crm-view.ts`) so the two surfaces can't drift on URL shape.
 *
 * Spec: docs/architecture/features/tasks.md → "Operator surface".
 * [COMP:app-web/tasks-view]
 */

import {
  taskPriority,
  type TaskPriority,
  type TaskRow,
  type TaskStatus,
} from "@/lib/api/tasks";

// ── Local-day formatting ────────────────────────────────────────────────

/**
 * Local-calendar `YYYY-MM-DD` for an ISO timestamp — the day the VIEWER's
 * timezone puts it on. Never `iso.slice(0, 10)`: that reads the UTC prefix,
 * which is the previous day for any timestamp east of UTC (a `+08`
 * local-midnight due renders as yesterday), so the peek/date-editor showed
 * a different day than the calendar grid placed the chip on.
 */
export function localIsoDay(iso: string): string {
  const d = new Date(iso);
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Project facet (stable registry id) ─────────────────────────────────

export function taskProject(row: Pick<TaskRow, "projectId">): string | null {
  return row.projectId ?? null;
}

/** Distinct project names across rows, sorted for the filter dropdown. */
export function projectOptions(rows: readonly TaskRow[]): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const p = taskProject(row);
    if (p) names.add(p);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ── Cleanup quick-filters ───────────────────────────────────────────────

/** Open (= not done/archived) untouched this long ⇒ stale. Shared with the
 *  Home dock's task_cleanup signal (packages/api/src/home/signals.ts) — the
 *  card and the surface must agree on what "needs cleanup" means. */
const STALE_AFTER_DAYS = 30;

export const QUICK_FILTERS = [
  "stale",
  "doneOpen",
  "unassigned",
  "noDue",
] as const;
export type QuickFilter = (typeof QUICK_FILTERS)[number];

const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "todo",
  "in_progress",
  "in_review",
  "blocked",
]);

export function isOpenStatus(status: TaskStatus): boolean {
  return OPEN_STATUSES.has(status);
}

/** Does `row` match the quick-filter at `now`? Pure so the counts and the
 *  applied filter can never disagree. */
export function matchesQuickFilter(
  row: TaskRow,
  filter: QuickFilter,
  now: Date,
): boolean {
  switch (filter) {
    case "stale": {
      if (!isOpenStatus(row.status)) return false;
      const cutoff = now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
      return new Date(row.updatedAt).getTime() < cutoff;
    }
    case "doneOpen":
      // Finished work still cluttering the live list — `done` but never
      // archived. One bulk Archive clears the class.
      return row.status === "done";
    case "unassigned":
      return isOpenStatus(row.status) && row.assigneeId === null;
    case "noDue":
      return isOpenStatus(row.status) && row.due === null;
  }
}

export function quickFilterCounts(
  rows: readonly TaskRow[],
  now: Date,
): Record<QuickFilter, number> {
  const counts: Record<QuickFilter, number> = {
    stale: 0,
    doneOpen: 0,
    unassigned: 0,
    noDue: 0,
  };
  for (const row of rows) {
    for (const f of QUICK_FILTERS) {
      if (matchesQuickFilter(row, f, now)) counts[f]++;
    }
  }
  return counts;
}

// ── Filter model + URL codec ────────────────────────────────────────────

export const GROUP_KEYS = ["status", "assignee", "project", "due", "none"] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];

export const SORT_KEYS = ["updated", "due", "priority", "created"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

const VIEW_MODES = ["table", "board", "suggestions"] as const;
type ViewMode = (typeof VIEW_MODES)[number];

type DueFilter = "overdue" | "week" | "month" | "none";

/**
 * Every property filter is a SET of values, matched as OR within the
 * property and AND across properties ("Alice or Bob, and status Todo").
 * Empty = the property is unfiltered. The `"none"` sentinel (unassigned /
 * no project / no priority) is an ordinary member of its set, so
 * "unassigned or Alice" is expressible; it can't collide with a real value
 * because no member id or project name is the literal string `none`.
 * Spec: docs/architecture/features/tasks.md → "Every filter is multi-select".
 */
export type TasksViewState = {
  /** Active cleanup quick-filter, or null. */
  quick: QuickFilter | null;
  /** Status filter (empty = all). */
  statuses: TaskStatus[];
  /** Assignee filter: member ids and/or `"none"` (unassigned). */
  assignee: string[];
  /** Priority filter: priorities and/or `"none"` (no priority). */
  priority: (TaskPriority | "none")[];
  /** Project filter: project names and/or `"none"` (no project). */
  project: string[];
  due: DueFilter[];
  /** Free-text needle over the title. */
  q: string;
  group: GroupKey;
  sort: SortKey;
  view: ViewMode;
  /** Reveal done/archived rows (they hide by default). */
  completed: boolean;
};

export const DEFAULT_VIEW_STATE: TasksViewState = {
  quick: null,
  statuses: [],
  assignee: [],
  priority: [],
  project: [],
  due: [],
  q: "",
  group: "status",
  sort: "updated",
  view: "table",
  completed: false,
};

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null {
  return value !== null && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Read a multi-value param. Closed vocabularies and opaque ids comma-join
 * into ONE param (`?assignee=m1,m2`); user-authored text REPEATS the param
 * (`?project=Q3&project=Ops,Fun`) because a name may itself contain a comma
 * and splitting it would silently produce two filters that match nothing.
 * Both shapes parse for every key, so the pre-multi single-value deep links
 * (`?assignee=m1`) still work. Order is preserved (it drives the pill's
 * lead label); duplicates are dropped.
 */
export function multiParam(
  params: URLSearchParams,
  key: string,
  { splitCommas }: { splitCommas: boolean },
): string[] {
  const out: string[] = [];
  for (const raw of params.getAll(key)) {
    for (const piece of splitCommas ? raw.split(",") : [raw]) {
      const value = piece.trim();
      if (value.length > 0 && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

/** Keep only the values in a closed vocabulary (unknown → dropped). */
function allOf<T extends string>(values: string[], allowed: readonly T[]): T[] {
  return values.filter((v): v is T =>
    (allowed as readonly string[]).includes(v),
  );
}

const STATUS_KEYS: readonly TaskStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "archived",
];
const PRIORITY_KEYS: readonly TaskPriority[] = [
  "low",
  "medium",
  "high",
  "urgent",
];
const PRIORITY_FILTER_KEYS: readonly (TaskPriority | "none")[] = [
  ...PRIORITY_KEYS,
  "none",
];
const DUE_KEYS: readonly DueFilter[] = ["overdue", "week", "month", "none"];

/** Parse the surface's search params into a view state (unknown → default).
 *  The dock card's `?filter=stale` deep link lands here. */
export function viewStateFromSearch(
  search: string | URLSearchParams | null | undefined,
): TasksViewState {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  if (!params) return { ...DEFAULT_VIEW_STATE };
  return {
    quick: oneOf(params.get("filter"), QUICK_FILTERS),
    statuses: allOf(
      multiParam(params, "status", { splitCommas: true }),
      STATUS_KEYS,
    ),
    // Member ids are opaque and comma-free, so they comma-join.
    assignee: multiParam(params, "assignee", { splitCommas: true }),
    priority: allOf(
      multiParam(params, "priority", { splitCommas: true }),
      PRIORITY_FILTER_KEYS,
    ),
    // Project names are user text — repeated params only (see `multiParam`).
    project: multiParam(params, "project", { splitCommas: false }),
    due: allOf(multiParam(params, "due", { splitCommas: true }), DUE_KEYS),
    q: params.get("q") ?? "",
    group: oneOf(params.get("group"), GROUP_KEYS) ?? DEFAULT_VIEW_STATE.group,
    sort: oneOf(params.get("sort"), SORT_KEYS) ?? DEFAULT_VIEW_STATE.sort,
    view: oneOf(params.get("view"), VIEW_MODES) ?? DEFAULT_VIEW_STATE.view,
    completed: params.get("completed") === "1",
  };
}

/** Encode a view state back into search params (defaults omitted, so the
 *  bare `/tasks` URL stays clean). Inverse of `viewStateFromSearch`. */
export function searchFromViewState(state: TasksViewState): string {
  const params = new URLSearchParams();
  if (state.quick) params.set("filter", state.quick);
  if (state.statuses.length > 0) params.set("status", state.statuses.join(","));
  if (state.assignee.length > 0) params.set("assignee", state.assignee.join(","));
  if (state.priority.length > 0) params.set("priority", state.priority.join(","));
  // Repeated, never joined — a project name may contain a comma.
  for (const project of state.project) params.append("project", project);
  if (state.due.length > 0) params.set("due", state.due.join(","));
  if (state.q.length > 0) params.set("q", state.q);
  if (state.group !== DEFAULT_VIEW_STATE.group) params.set("group", state.group);
  if (state.sort !== DEFAULT_VIEW_STATE.sort) params.set("sort", state.sort);
  if (state.view !== DEFAULT_VIEW_STATE.view) params.set("view", state.view);
  if (state.completed) params.set("completed", "1");
  return params.toString();
}

// ── Applying the state ──────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function matchesDue(row: TaskRow, due: DueFilter, now: Date): boolean {
  if (due === "none") return row.due === null;
  if (row.due === null) return false;
  const t = new Date(row.due).getTime();
  switch (due) {
    case "overdue":
      return t < now.getTime();
    case "week":
      return t >= now.getTime() - DAY_MS && t <= now.getTime() + 7 * DAY_MS;
    case "month":
      return t >= now.getTime() - DAY_MS && t <= now.getTime() + 31 * DAY_MS;
  }
}

/** Filter rows to the view state. The completed fold applies FIRST (done /
 *  archived hide unless revealed or explicitly filtered/quick-filtered in). */
export function applyFilters(
  rows: readonly TaskRow[],
  state: TasksViewState,
  now: Date,
): TaskRow[] {
  const needle = state.q.trim().toLowerCase();
  return rows.filter((row) => {
    // Quick filters pick their own status slice (e.g. doneOpen NEEDS done
    // rows), so they bypass the completed fold.
    if (state.quick) {
      if (!matchesQuickFilter(row, state.quick, now)) return false;
    } else if (state.statuses.length > 0) {
      if (!state.statuses.includes(row.status)) return false;
    } else if (!state.completed && !isOpenStatus(row.status)) {
      return false;
    }
    // Within a property the values are an OR; across properties, an AND.
    if (state.assignee.length > 0) {
      const hit = state.assignee.some((a) =>
        a === "none" ? row.assigneeId === null : row.assigneeId === a,
      );
      if (!hit) return false;
    }
    if (state.priority.length > 0) {
      const p = taskPriority(row);
      if (!state.priority.some((x) => (x === "none" ? p === null : p === x)))
        return false;
    }
    if (state.project.length > 0) {
      const p = taskProject(row);
      if (!state.project.some((x) => (x === "none" ? p === null : p === x)))
        return false;
    }
    if (
      state.due.length > 0 &&
      !state.due.some((d) => matchesDue(row, d, now))
    )
      return false;
    if (needle && !row.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}

const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function sortRows(rows: TaskRow[], sort: SortKey): TaskRow[] {
  const sorted = [...rows];
  switch (sort) {
    case "updated":
      sorted.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      break;
    case "due":
      // Soonest due first; undated rows sink to the bottom.
      sorted.sort((a, b) => {
        if (a.due === null && b.due === null) return 0;
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return new Date(a.due).getTime() - new Date(b.due).getTime();
      });
      break;
    case "priority":
      sorted.sort((a, b) => {
        const pa = taskPriority(a);
        const pb = taskPriority(b);
        const ra = pa ? PRIORITY_RANK[pa] : 4;
        const rb = pb ? PRIORITY_RANK[pb] : 4;
        return ra - rb;
      });
      break;
    case "created":
      // The list endpoint has no created_at; id-stable fallback keeps the
      // order deterministic (full created sort is a follow-up).
      sorted.sort((a, b) => a.id.localeCompare(b.id));
      break;
  }
  return sorted;
}

export type TaskGroup = {
  /** Stable group key: a status, member id / "", project name / "", or a
   *  due bucket. `""` = the "none" bucket for its dimension. */
  key: string;
  rows: TaskRow[];
};

const STATUS_GROUP_ORDER: readonly TaskStatus[] = [
  "in_progress",
  "in_review",
  "todo",
  "blocked",
  "done",
  "archived",
];

export type DueBucket = "overdue" | "today" | "week" | "later" | "none";
const DUE_BUCKET_ORDER: readonly DueBucket[] = [
  "overdue",
  "today",
  "week",
  "later",
  "none",
];

export function dueBucket(row: Pick<TaskRow, "due">, now: Date): DueBucket {
  if (row.due === null) return "none";
  const t = new Date(row.due).getTime();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = startOfDay.getTime() + DAY_MS;
  if (t < startOfDay.getTime()) return "overdue";
  if (t < endOfDay) return "today";
  if (t < endOfDay + 7 * DAY_MS) return "week";
  return "later";
}

/** Group sorted rows. Group order is semantic (status lifecycle / due
 *  urgency) or by size (assignee / project, biggest first, "none" last). */
export function groupRows(
  rows: TaskRow[],
  group: GroupKey,
  now: Date,
): TaskGroup[] {
  if (group === "none") return [{ key: "", rows }];
  const buckets = new Map<string, TaskRow[]>();
  for (const row of rows) {
    const key =
      group === "status"
        ? row.status
        : group === "assignee"
          ? row.assigneeId ?? ""
          : group === "project"
            ? taskProject(row) ?? ""
            : dueBucket(row, now);
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }
  if (group === "status") {
    return STATUS_GROUP_ORDER.filter((s) => buckets.has(s)).map((s) => ({
      key: s,
      rows: buckets.get(s)!,
    }));
  }
  if (group === "due") {
    return DUE_BUCKET_ORDER.filter((b) => buckets.has(b)).map((b) => ({
      key: b,
      rows: buckets.get(b)!,
    }));
  }
  // assignee / project: biggest group first, the "none" bucket last.
  return [...buckets.entries()]
    .sort((a, b) => {
      if (a[0] === "") return 1;
      if (b[0] === "") return -1;
      return b[1].length - a[1].length;
    })
    .map(([key, groupRows]) => ({ key, rows: groupRows }));
}

// ── Saved views (per-workspace localStorage) ────────────────────────────

export type SavedTaskView = {
  id: string;
  name: string;
  /** The encoded search string (`searchFromViewState`). */
  search: string;
};

function savedViewsKey(workspaceId: string): string {
  return `tasks:views:${workspaceId}`;
}

export function readSavedViews(workspaceId: string): SavedTaskView[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(savedViewsKey(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is SavedTaskView =>
        !!v &&
        typeof v === "object" &&
        typeof (v as SavedTaskView).id === "string" &&
        typeof (v as SavedTaskView).name === "string" &&
        typeof (v as SavedTaskView).search === "string",
    );
  } catch {
    return [];
  }
}

export function writeSavedViews(
  workspaceId: string,
  views: SavedTaskView[],
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(savedViewsKey(workspaceId), JSON.stringify(views));
  } catch {
    // Non-fatal — saved views are a convenience.
  }
}
