"use client";

/**
 * Brain grouped view (app-web) — the DEFAULT brain browse surface.
 *
 * Replaces the former flat `EntityRow` dump (every primitive in one
 * undifferentiated stack). Renders every visible brain row — entities
 * AND content (knowledge / files / tasks / memories / sessions) — bucketed
 * by kind in the grouped, themed style users preferred:
 *   - Entity rows (people / companies / projects / products / repositories
 *     / deals) carry their connection count (degree) + linked-kind dots,
 *     decorated from the workspace graph snapshot (matched by id).
 *   - Content rows (knowledge / files / tasks / memories / sessions) carry
 *     their sensitivity badge.
 *
 * Honors the page's search + filter chips + viewpoint: `rows` arrive
 * already scoped by `/api/brain/list`, so this component only groups +
 * decorates. Row click → `onSelect(row)` → the shared `BrainDetailDrawer`
 * (the parent owns drawer state), identical to the old flat list.
 *
 * The REAL force-directed doc lives in `graph-view.tsx` (the view
 * toggle's alternate). This file is the list/overview the toggle returns to.
 */

import { useCallback, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { entityColorVar } from "@/lib/brain-colors";
import { useT, format } from "@/lib/i18n/client";
import type {
  BrainGraph,
  BrainGraphNode,
  BrainGraphNodeKind,
  BrainRow,
} from "@/lib/api/brain";

type Props = {
  rows: BrainRow[];
  /** Workspace graph snapshot — used purely to decorate entity rows with
   *  their degree + neighbour-kind dots. `null` while loading; rows whose
   *  id isn't a graph node (CRM-sourced contacts/companies/deals) simply
   *  render without decoration. */
  graph: BrainGraph | null;
  /** Click handler — hands the row straight to `BrainDetailDrawer`. */
  onSelect: (row: BrainRow) => void;
  /**
   * Completed (done / archived) tasks — fetched separately so the Tasks
   * section can lead with live work and tuck finished items behind a "Show
   * completed" disclosure. `null`/empty ⇒ no toggle renders. The page only
   * fetches these when tasks are in scope (All or the Tasks chip), so they
   * never appear under an unrelated primitive filter.
   */
  completedTasks?: BrainRow[] | null;
  /** Whether the completed-task disclosure is open. */
  showCompletedTasks?: boolean;
  /** Flip the completed-task disclosure. */
  onToggleCompletedTasks?: () => void;
};

/** Chip tint per task status. Live work earns a little colour (in-progress =
 *  primary, blocked = amber); todo + the completed states stay neutral so the
 *  list reads calm. Reuses existing theme utilities — no new tokens. */
const TASK_STATUS_CLASS: Record<string, string> = {
  todo: "bg-muted text-muted-foreground border-border",
  in_progress: "bg-primary/10 text-primary border-primary/20",
  blocked:
    "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  done: "bg-muted text-muted-foreground border-border",
  archived: "bg-muted text-muted-foreground border-border",
};

/** Small lifecycle-status pill for a task row (todo / in progress / blocked /
 *  done / archived), localized via `brainPage.taskStatus`. */
function TaskStatusChip({ status }: { status: string }) {
  const t = useT();
  const labels = t.brainPage.taskStatus as Record<string, string>;
  return (
    <span
      className={cn(
        "shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium border",
        TASK_STATUS_CLASS[status] ?? "bg-muted text-muted-foreground border-border",
      )}
    >
      {labels[status] ?? status}
    </span>
  );
}

// Canonical group keys, in display order. Entity-like groups first (they
// carry the graph degree/neighbour decoration), content groups after.
type GroupKey =
  | "people"
  | "companies"
  | "projects"
  | "products"
  | "repositories"
  | "deals"
  | "knowledge"
  | "files"
  | "tasks"
  | "memories"
  | "sessions"
  | "other";

const GROUP_ORDER: GroupKey[] = [
  "people",
  "companies",
  "projects",
  "products",
  "repositories",
  "deals",
  "knowledge",
  "files",
  "tasks",
  "memories",
  "sessions",
  "other",
];

// Groups whose rows correspond to graph nodes — they show degree +
// neighbour-kind dots. Content groups show a sensitivity badge instead.
const ENTITY_GROUPS = new Set<GroupKey>([
  "people",
  "companies",
  "projects",
  "products",
  "repositories",
  "deals",
  "other",
]);

// Groups that earn a top legend swatch — the kinds with their own colour.
// `memories` is a first-class peer (its own lavender hue). The remaining content
// groups (files / tasks / sessions) share the neutral `other` slate, so listing
// them would just repeat the same swatch — they stay out of the legend.
const LEGEND_GROUPS = new Set<GroupKey>([
  "people",
  "companies",
  "projects",
  "products",
  "repositories",
  "deals",
  "knowledge",
  "memories",
]);

/** Normalise a `BrainRow.kind` — which mixes singular entity kinds
 *  (`person`, `project`) and plural primitive kinds (`people`, `files`) —
 *  into a single canonical group key. */
function groupOf(kind: BrainRow["kind"]): GroupKey {
  switch (kind) {
    case "person":
    case "people":
      return "people";
    case "company":
    case "companies":
      return "companies";
    case "project":
      return "projects";
    case "product":
      return "products";
    case "repository":
      return "repositories";
    case "deal":
    case "deals":
      return "deals";
    case "knowledge":
      return "knowledge";
    case "files":
      return "files";
    case "tasks":
      return "tasks";
    case "memories":
      return "memories";
    case "sessions":
      return "sessions";
    default:
      return "other";
  }
}

/** Theme-aware colour for a graph node kind (entity kinds + knowledge),
 *  used for the leading row dot and the neighbour-kind swatches. The palette
 *  is the shared `--entity-*` source of truth in `lib/brain-colors.ts`. */
function kindColor(kind: BrainGraphNodeKind): string {
  return entityColorVar(kind);
}

/** Canonical group for a graph node kind — the node-side analogue of
 *  `groupOf`, used to scope the name-fallback match to the same group. */
function nodeGroup(kind: BrainGraphNodeKind): GroupKey {
  switch (kind) {
    case "person":
      return "people";
    case "company":
      return "companies";
    case "project":
      return "projects";
    case "product":
      return "products";
    case "repository":
      return "repositories";
    case "deal":
      return "deals";
    case "knowledge":
      return "knowledge";
    case "memory":
      return "memories";
    case "skill":
    case "connector":
    case "other":
      return "other";
  }
}

/** Normalised name key for the fallback index: `group|lowercased-name`. */
function nameKey(group: GroupKey, name: string): string {
  return `${group}|${name.trim().toLowerCase()}`;
}

/** Leading dot colour for a group. Entity groups + memories map to their own
 *  colour; the remaining content groups (files/tasks/sessions) share the
 *  neutral `other` slate so entities stay visually dominant. */
function groupColor(group: GroupKey): string {
  switch (group) {
    case "people":
      return kindColor("person");
    case "companies":
      return kindColor("company");
    case "projects":
      return kindColor("project");
    case "products":
      return kindColor("product");
    case "repositories":
      return kindColor("repository");
    case "deals":
      return kindColor("deal");
    case "knowledge":
      return kindColor("knowledge");
    case "memories":
      return kindColor("memory");
    case "files":
    case "tasks":
    case "sessions":
    case "other":
      return kindColor("other");
  }
}

export function BrainGroupedView({
  rows,
  graph,
  onSelect,
  completedTasks,
  showCompletedTasks = false,
  onToggleCompletedTasks,
}: Props) {
  const t = useT();
  const legend = t.brainPage.graphView.legend;
  const filters = t.brainPage.filters;
  const completedCount = completedTasks?.length ?? 0;

  // Human label per group — composed from the existing filter-chip + graph
  // legend dictionaries (no new i18n keys needed).
  const groupLabel: Record<GroupKey, string> = {
    people: filters.people,
    companies: filters.companies,
    projects: legend.project,
    products: legend.product,
    repositories: legend.repository,
    deals: filters.deals,
    knowledge: filters.knowledge,
    files: filters.files,
    tasks: filters.tasks,
    memories: filters.memories,
    sessions: filters.sessions,
    other: legend.other,
  };

  // Per-node decoration from the graph snapshot: the node (carrying degree)
  // keyed by id, the set of kinds each node links to, and a name index used
  // as a fallback when a row's id isn't a graph node (CRM-sourced contacts/
  // companies live in their own tables, so their list-row id differs from the
  // entity-graph node id). The name index only keeps names that are UNIQUE
  // within their group, so an ambiguous name never picks up a wrong count.
  const decoration = useMemo(() => {
    const byId = new Map<string, BrainGraphNode>();
    const neighbourKinds = new Map<string, Set<BrainGraphNodeKind>>();
    const nameCount = new Map<string, number>();
    const nameNode = new Map<string, BrainGraphNode>();
    if (graph) {
      for (const n of graph.nodes) {
        byId.set(n.id, n);
        neighbourKinds.set(n.id, new Set());
        const key = nameKey(nodeGroup(n.kind), n.name);
        nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
        nameNode.set(key, n);
      }
      for (const e of graph.edges) {
        const s = byId.get(e.source);
        const tgt = byId.get(e.target);
        if (s && tgt) {
          neighbourKinds.get(e.source)?.add(tgt.kind);
          neighbourKinds.get(e.target)?.add(s.kind);
        }
      }
    }
    const uniqueByName = new Map<string, BrainGraphNode>();
    for (const [key, node] of nameNode) {
      if (nameCount.get(key) === 1) uniqueByName.set(key, node);
    }
    return { byId, neighbourKinds, uniqueByName };
  }, [graph]);

  // Resolve a row to its graph node: by id first, then by unique name within
  // the same group. Returns undefined for rows with no matching node (which
  // simply render without a count / neighbour dots).
  const resolveNode = useCallback(
    (row: BrainRow, group: GroupKey): BrainGraphNode | undefined =>
      decoration.byId.get(row.id) ??
      decoration.uniqueByName.get(nameKey(group, row.name)),
    [decoration],
  );

  // Rows bucketed by canonical group, in display order. Entity groups are
  // degree-sorted (busiest first, then name) to mirror the old graph view;
  // content groups keep the list endpoint's relevance/recency order.
  const groups = useMemo(() => {
    const buckets = new Map<GroupKey, BrainRow[]>();
    for (const row of rows) {
      const g = groupOf(row.kind);
      const list = buckets.get(g);
      if (list) list.push(row);
      else buckets.set(g, [row]);
    }
    // Ensure a Tasks section renders even when every task is completed (so
    // hidden by default) — the "Show completed" disclosure lives in it.
    if (completedCount > 0 && !buckets.has("tasks")) buckets.set("tasks", []);
    return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => {
      const list = buckets.get(g)!;
      if (ENTITY_GROUPS.has(g)) {
        list.sort(
          (a, b) =>
            (resolveNode(b, g)?.degree ?? 0) -
              (resolveNode(a, g)?.degree ?? 0) ||
            a.name.localeCompare(b.name),
        );
      }
      return { key: g, rows: list };
    });
  }, [rows, resolveNode, completedCount]);

  const presentLegend = useMemo(
    () => groups.map((g) => g.key).filter((g) => LEGEND_GROUPS.has(g)),
    [groups],
  );

  return (
    // pb-28: clear the fixed chat dock the chrome floats over the surface's
    // bottom-right, so the last entry row isn't trapped behind it.
    <div className="relative flex-1 min-h-0 overflow-y-auto bg-background pb-28">
      {presentLegend.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 border-b border-border text-[11px] text-muted-foreground">
          {presentLegend.map((g) => (
            <span key={g} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: groupColor(g) }}
              />
              {groupLabel[g]}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-4 px-4 py-4">
        {groups.map((group) => {
          const isEntity = ENTITY_GROUPS.has(group.key);
          return (
            <section key={group.key} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: groupColor(group.key) }}
                />
                {groupLabel[group.key]}
                <span className="text-muted-foreground/60">
                  {group.rows.length}
                </span>
              </div>
              <ul className="flex flex-col gap-1">
                {group.rows.map((row) => {
                  const node = resolveNode(row, group.key);
                  const degree = node?.degree ?? 0;
                  const kinds = node
                    ? Array.from(decoration.neighbourKinds.get(node.id) ?? [])
                    : [];
                  return (
                    <li key={`${row.kind}:${row.id}`}>
                      <button
                        type="button"
                        onClick={() => onSelect(row)}
                        className={cn(
                          "w-full text-left flex items-center gap-3 px-3 py-2 rounded-md border border-border bg-card",
                          "hover:border-primary/50 hover:bg-muted/40 transition-colors",
                        )}
                      >
                        <span
                          aria-hidden
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: groupColor(group.key) }}
                        />
                        <span className="flex-1 min-w-0 text-sm font-medium truncate">
                          {row.name}
                        </span>

                        {row.hasPending && (
                          <span
                            className="shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20"
                            aria-label="Pending review"
                          >
                            Pending
                          </span>
                        )}

                        {isEntity ? (
                          <>
                            {degree > 0 && (
                              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                                {degree}
                              </span>
                            )}
                            {kinds.length > 0 && (
                              <span className="hidden sm:flex shrink-0 items-center gap-1">
                                {kinds.map((k) => (
                                  <span
                                    key={k}
                                    aria-hidden
                                    title={legend[k]}
                                    className="inline-block h-2 w-2 rounded-full opacity-70"
                                    style={{ backgroundColor: kindColor(k) }}
                                  />
                                ))}
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            {group.key === "tasks" && row.status && (
                              <TaskStatusChip status={row.status} />
                            )}
                            {row.sensitivity && (
                              <span
                                className={cn(
                                  "shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium border",
                                  row.sensitivity === "confidential" &&
                                    "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
                                  row.sensitivity === "restricted" &&
                                    "bg-red-700/10 text-red-800 dark:text-red-300 border-red-700/30",
                                  row.sensitivity === "internal" &&
                                    "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
                                  row.sensitivity === "public" &&
                                    "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
                                )}
                              >
                                {row.sensitivity}
                              </span>
                            )}
                          </>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {/* Completed-task disclosure — only under the Tasks section, and
                  only when finished tasks exist. Collapsed by default so the
                  Brain leads with live work; reveal renders them dimmed +
                  struck through with their status chip. */}
              {group.key === "tasks" && completedCount > 0 && (
                <div className="mt-0.5">
                  <button
                    type="button"
                    onClick={onToggleCompletedTasks}
                    aria-expanded={showCompletedTasks}
                    className="inline-flex items-center gap-1 px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "size-3 transition-transform",
                        showCompletedTasks && "rotate-180",
                      )}
                    />
                    {format(
                      showCompletedTasks
                        ? t.brainPage.groupedView.hideCompleted
                        : t.brainPage.groupedView.showCompleted,
                      { count: completedCount },
                    )}
                  </button>
                  {showCompletedTasks && (
                    <ul className="mt-1 flex flex-col gap-1">
                      {(completedTasks ?? []).map((row) => (
                        <li key={`completed-task:${row.id}`}>
                          <button
                            type="button"
                            onClick={() => onSelect(row)}
                            className={cn(
                              "w-full text-left flex items-center gap-3 px-3 py-2 rounded-md border border-border bg-card opacity-60",
                              "transition-all hover:opacity-100 hover:border-primary/50 hover:bg-muted/40",
                            )}
                          >
                            <span
                              aria-hidden
                              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: groupColor("tasks") }}
                            />
                            <span className="flex-1 min-w-0 text-sm font-medium truncate line-through decoration-muted-foreground/40">
                              {row.name}
                            </span>
                            {row.status && <TaskStatusChip status={row.status} />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          );
        })}

      </div>
    </div>
  );
}
