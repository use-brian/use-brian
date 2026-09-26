"use client";

/**
 * Brain grouped view (app-web) — the List tab of the brain browse surface.
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { entityColorVar } from "@/lib/brain-colors";
import { useT, format } from "@/lib/i18n/client";
import { useWorkspaces } from "@/contexts/workspace-context";
import type {
  BrainGraph,
  BrainGraphNode,
  BrainGraphNodeKind,
  BrainRow,
} from "@/lib/api/brain";
import { BrainFallbackCard } from "@/components/brain/file-segment-card";
import { brainKindToInboxPrimitive } from "@/lib/brain-row-target";
import { verifyBrainRow, deleteBrainRow } from "@/lib/api/brain-inbox";
import { requestBrainRefresh } from "@/lib/brain-events";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { UserAvatar } from "@/components/ui/user-avatar";
import { loadWorkspaceRoster } from "@/lib/api/workspace-roster";
import {
  memberDisplayName,
  resolveAssignee,
  type AssignableMember,
} from "@/components/brain/property-edit";

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
  /**
   * Row keys (`kind:id`) belonging to the MOST RECENT chunk, which animate in.
   * A set rather than an index range because rows are regrouped by kind for
   * display, so a fresh row's position in this view has nothing to do with its
   * arrival order. Omitted ⇒ nothing animates.
   */
  freshKeys?: ReadonlySet<string>;
  /** Rendered after the last group — the chunk sentinel / load-more control. */
  footer?: React.ReactNode;
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

/** How many tag chips a task row shows before collapsing into "+N". */
const TASK_ROW_TAG_CAP = 3;

/**
 * Per-task row decoration: tag chips (capped, "+N" overflow) and the
 * assignee's avatar (resolved from the workspace roster by the task's
 * `assignee_id` — a `workspace_members` row id). Renders nothing it can't
 * resolve: no roster yet (or a stale id) simply omits the avatar so the
 * list never blocks on the fetch. Tags hide below `sm` — the same
 * treatment as the entity rows' neighbour-kind dots.
 */
function TaskRowMeta({
  row,
  roster,
}: {
  row: BrainRow;
  roster: AssignableMember[] | null;
}) {
  const tags = row.tags ?? [];
  const overflow = tags.length - TASK_ROW_TAG_CAP;
  const assignee =
    row.assigneeId && roster ? resolveAssignee(roster, row.assigneeId) : null;
  const assigneeName = assignee ? memberDisplayName(assignee) : null;
  return (
    <>
      {tags.length > 0 && (
        <span className="hidden sm:flex shrink-0 items-center gap-1">
          {tags.slice(0, TASK_ROW_TAG_CAP).map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground border border-border"
            >
              {tag}
            </span>
          ))}
          {overflow > 0 && (
            <span className="text-[10px] text-muted-foreground/70 tabular-nums">
              +{overflow}
            </span>
          )}
        </span>
      )}
      {assignee && (
        <span className="shrink-0" title={assigneeName ?? undefined}>
          <UserAvatar
            name={assigneeName ?? undefined}
            email={assignee.email ?? undefined}
            avatarUrl={assignee.avatarUrl}
            size={18}
          />
        </span>
      )}
    </>
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

/** Every `BrainRow.kind` this grouped view renders as a first-class
 *  single-line row. A row whose kind is NOT here — a `file_segment`, or a
 *  future `search()` primitive this build predates — renders through
 *  `BrainFallbackCard` instead (which assumes no meaningful `name`). This is
 *  the grouped view's own render-capability list, so it stays an explicit
 *  literal rather than a derived "all primitives" set. */
const KNOWN_ROW_KINDS = new Set<BrainRow["kind"]>([
  "people",
  "companies",
  "deals",
  "knowledge",
  "memories",
  "files",
  "sessions",
  "tasks",
  "person",
  "company",
  "project",
  "deal",
  "product",
  "repository",
  "other",
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
    // A file_segment is a chunk of a file — home it under the Files section
    // (it renders as a fallback excerpt card, not the single-line file row).
    case "file_segment":
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
    case "skill_file":
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
  freshKeys,
  footer,
}: Props) {
  const t = useT();
  const legend = t.brainPage.graphView.legend;
  const filters = t.brainPage.filters;
  const completedCount = completedTasks?.length ?? 0;

  const { activeId: workspaceId } = useWorkspaces();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const [outcome, setOutcome] = useState<{ workspaceId: string; succeeded: number; failed: number } | null>(null);
  const selectableKeys = useMemo(
    () =>
      new Set(
        [...rows, ...(showCompletedTasks ? completedTasks ?? [] : [])]
          .filter((row) => KNOWN_ROW_KINDS.has(row.kind))
          .map((row) => `${row.kind}:${row.id}`),
      ),
    [rows, completedTasks, showCompletedTasks],
  );
  const [selection, setSelection] = useState(() => ({
    workspaceId,
    keys: new Set<string>(),
  }));
  // Reconcile before committing children: hidden keys must not resurrect when
  // a filter/disclosure is undone, or leak across workspaces with identical ids.
  const selectedKeys = new Set(
    selection.workspaceId === workspaceId
      ? [...selection.keys].filter((key) => selectableKeys.has(key))
      : [],
  );
  if (
    selection.workspaceId !== workspaceId ||
    selectedKeys.size !== selection.keys.size
  ) {
    setSelection({ workspaceId, keys: selectedKeys });
  }
  const setSelectedKeys = (keys: Set<string>) => setSelection({ workspaceId, keys });
  const selectedRows = [...rows, ...(showCompletedTasks ? completedTasks ?? [] : [])]
    .filter((row) => selectedKeys.has(`${row.kind}:${row.id}`));
  const eligibleRows = (action: "confirm" | "delete") => selectedRows.filter(
    (row) => row.id && brainKindToInboxPrimitive(row.kind) && (action === "delete" || row.hasPending),
  );
  async function runBulk(action: "confirm" | "delete") {
    if (busyRef.current || !workspaceId) return;
    const eligible = eligibleRows(action);
    if (!eligible.length) return;
    // Freeze the exact row identities before awaiting the dialog. Graph name
    // matching is decoration ONLY and must never determine a mutation target.
    busyRef.current = true;
    setBusy(true);
    setOutcome(null);
    const succeeded = new Set<string>();
    let failed = 0;
    try {
      if (action === "delete") {
        const ok = await confirmDialog({
          title: t.memoriesReview.delete,
          description: `${format(t.brainPage.groupedView.deleteScope, { count: eligible.length, selected: selectedKeys.size })} ${t.memoriesReview.deleteConfirmBody}`,
          confirmLabel: t.memoriesReview.deleteConfirmAction,
          cancelLabel: t.memoriesReview.cancel,
          variant: "destructive",
        });
        if (!ok || currentWorkspace.current !== workspaceId) return;
      }
      // CRM aliases and singular entity kinds can refer to the same physical
      // entity. Coalesce those requests, while accounting for every selected row.
      const targets = new Map<string, { row: BrainRow; keys: string[] }>();
      for (const row of eligible) {
        const primitive = brainKindToInboxPrimitive(row.kind)!;
        const identityKind = ["contact", "company", "deal"].includes(primitive) ? "entity" : primitive;
        const key = `${identityKind}:${row.id}`;
        const target = targets.get(key) ?? { row, keys: [] };
        target.keys.push(`${row.kind}:${row.id}`);
        targets.set(key, target);
      }
      for (const { row, keys } of targets.values()) {
        try {
          const primitive = brainKindToInboxPrimitive(row.kind)!;
          const result = await (action === "confirm" ? verifyBrainRow : deleteBrainRow)(workspaceId, primitive, row.id);
          if (result.ok) keys.forEach((key) => succeeded.add(key));
          else failed += keys.length;
        } catch {
          failed += keys.length;
        }
      }
      setSelection((previous) => previous.workspaceId === workspaceId
        ? { ...previous, keys: new Set([...previous.keys].filter((key) => !succeeded.has(key))) }
        : previous);
      if (currentWorkspace.current === workspaceId) setOutcome({ workspaceId, succeeded: succeeded.size, failed });
      if (succeeded.size) requestBrainRefresh(workspaceId);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const allSelected =
    selectableKeys.size > 0 && selectedKeys.size === selectableKeys.size;
  const selectionBox = (row: BrainRow) => {
    const key = `${row.kind}:${row.id}`;
    return (
      <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
        <Checkbox
          aria-label={format(t.brainPage.groupedView.selectRow, { name: row.name })}
          checked={selectedKeys.has(key)}
          disabled={busy}
          onCheckedChange={(checked) => {
            const next = new Set(selectedKeys);
            if (checked) next.add(key);
            else next.delete(key);
            setSelectedKeys(next);
          }}
        />
      </label>
    );
  };
  const selectionClass = (row: BrainRow) =>
    cn(
      "flex items-center rounded-md border transition-colors",
      selectedKeys.has(`${row.kind}:${row.id}`)
        ? "border-primary/50 bg-primary/10"
        : "border-border bg-card",
    );

  // Best-effort workspace roster for task assignee decoration.
  const hasAssignedTask = useMemo(
    () =>
      rows.some((r) => r.kind === "tasks" && r.assigneeId) ||
      (completedTasks ?? []).some((r) => r.assigneeId),
    [rows, completedTasks],
  );
  const [roster, setRoster] = useState<AssignableMember[] | null>(null);
  useEffect(() => {
    if (!workspaceId || !hasAssignedTask) return;
    let cancelled = false;
    loadWorkspaceRoster(workspaceId)
      .then((members) => {
        if (!cancelled) setRoster(members);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, hasAssignedTask]);

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


  // Entrance animation for the newest chunk only. Fresh rows are scattered
  // across groups after regrouping, so the stagger is counted here as they are
  // rendered rather than expressed as an `nth-child` rule. Capped at 8 steps:
  // past that the last rows of a big chunk would visibly lag behind the scroll.
  let freshSeen = 0;
  const chunkAnim = (key: string) => {
    if (!freshKeys?.has(key)) return undefined;
    const delay = Math.min(freshSeen++, 8) * 28;
    return { className: "animate-chunk-in", style: { animationDelay: `${delay}ms` } };
  };

  return (
    // pb-28: clear the fixed chat dock the chrome floats over the surface's
    // bottom-right, so the last entry row isn't trapped behind it.
    <div className="relative flex-1 min-h-0 overflow-y-auto bg-background pb-28">
      <div className="flex flex-wrap items-center gap-x-3 px-4 py-2 border-b border-border text-sm">
        <label className="flex min-h-11 cursor-pointer items-center gap-2">
          <Checkbox
            aria-label={t.brainPage.groupedView.selectAll}
            checked={allSelected}
            indeterminate={selectedKeys.size > 0 && !allSelected}
            disabled={busy || selectableKeys.size === 0}
            onCheckedChange={(checked) =>
              setSelectedKeys(checked ? new Set(selectableKeys) : new Set())
            }
          />
          {t.brainPage.groupedView.selectAll}
        </label>
        <span role="status" className="text-muted-foreground">
          {format(t.brainPage.groupedView.selectedCount, {
            count: selectedKeys.size,
          })}
        </span>
        <button
          type="button"
          disabled={busy || selectedKeys.size === 0}
          onClick={() => setSelectedKeys(new Set())}
          className="min-h-11 px-2 rounded-md hover:bg-muted/40 disabled:opacity-50"
        >
          {t.brainPage.groupedView.clearSelection}
        </button>
        <button type="button" disabled={busy || !workspaceId || eligibleRows("confirm").length === 0}
          onClick={() => void runBulk("confirm")}
          className="min-h-11 px-2 rounded-md hover:bg-muted/40 disabled:opacity-50">
          {format(t.brainPage.groupedView.bulkConfirm, { count: eligibleRows("confirm").length })}
        </button>
        <button type="button" disabled={busy || !workspaceId || eligibleRows("delete").length === 0}
          onClick={() => void runBulk("delete")}
          className="min-h-11 px-2 rounded-md text-destructive hover:bg-muted/40 disabled:opacity-50">
          {format(t.brainPage.groupedView.bulkDelete, { count: eligibleRows("delete").length })}
        </button>
        {busy && <span role="status">{t.brainPage.groupedView.bulkBusy}</span>}
        {outcome?.workspaceId === workspaceId && <span role="status">
          {format(t.brainPage.groupedView.bulkResult, { succeeded: outcome.succeeded, failed: outcome.failed })}
        </span>}

      </div>
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
                  // file_segment + any primitive this build predates render as
                  // a graceful fallback card, never the single-line row (which
                  // assumes a meaningful `name`). Defensive default — a future
                  // search primitive still renders, never a blank row or crash.
                  if (!KNOWN_ROW_KINDS.has(row.kind)) {
                    return (
                      <li
                        key={`${row.kind}:${row.id}`}
                        {...chunkAnim(`${row.kind}:${row.id}`)}
                      >
                        <BrainFallbackCard row={row} />
                      </li>
                    );
                  }
                  const node = resolveNode(row, group.key);
                  const degree = node?.degree ?? 0;
                  const kinds = node
                    ? Array.from(decoration.neighbourKinds.get(node.id) ?? [])
                    : [];
                  return (
                    <li
                      key={`${row.kind}:${row.id}`}
                      {...chunkAnim(`${row.kind}:${row.id}`)}
                    >
                      <div className={selectionClass(row)}>
                        {selectionBox(row)}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onSelect(row)}
                          className={cn(
                            "min-w-0 min-h-11 flex-1 text-left flex items-center gap-3 pr-3 py-2 rounded-md",
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
                              {group.key === "tasks" && (
                                <TaskRowMeta row={row} roster={roster} />
                              )}
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
                      </div>
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
                    disabled={busy}
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
                        <li key={`${row.kind}:${row.id}`}>
                          <div className={selectionClass(row)}>
                            {KNOWN_ROW_KINDS.has(row.kind) && selectionBox(row)}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => onSelect(row)}
                              className={cn(
                                "min-w-0 min-h-11 flex-1 text-left flex items-center gap-3 pr-3 py-2 rounded-md opacity-60",
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
                              <TaskRowMeta row={row} roster={roster} />
                              {row.status && <TaskStatusChip status={row.status} />}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          );
        })}

        {/* Chunk sentinel / load-more — after the last group, so it marks the
            true end of the list and the next chunk appends below it. */}
        {footer}
      </div>
    </div>
  );
}
