"use client";

/**
 * Tasks operator surface — `/w/[id]/tasks` (tasks-operator-surface §3).
 *
 * The PM's cleanup workhorse over the SAME `tasks` rows the Brain graph
 * reads (lens, not data): cleanup quick-filters with live counts → filter
 * row (assignee / status / priority / project / due + search) → group-by /
 * sort / show-completed → the dense table (inline cell edit per row) or the
 * board (kanban by status, drag to change status). Checking rows swaps the
 * filter row for the bulk bar: Status / Assign / Priority / Project /
 * Archive / Delete over the whole selection.
 *
 * State model: the URL is the single source of truth for the view
 * (`tasks-view.ts` codec) — the sidebar panel and the Home dock card
 * (`?filter=stale`) deep-link into it. Mutations ride the existing
 * brain-inbox wire (`adjustBrainRow` / `deleteBrainRow`, supersession-aware:
 * every edit mints a new row id) — a client loop for small selections
 * (per-row retry UX), the server bulk lane (`bulkTasks`) past
 * `SERVER_BULK_THRESHOLD`. Destructive bulk goes through `confirmDialog`.
 *
 * Spec: docs/architecture/features/tasks.md → "Operator surface".
 * [COMP:app-web/tasks-surface]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Kanban, Rows3 } from "lucide-react";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  adjustBrainRow,
  deleteBrainRow,
  type AdjustMemoryChanges,
} from "@/lib/api/brain-inbox";
import {
  bulkTasks,
  fetchWorkspaceTasks,
  taskPriority,
  type BulkTaskSet,
  type TaskPriority,
  type TaskRow,
  type TaskStatus,
} from "@/lib/api/tasks";
import {
  applyFilters,
  groupRows,
  isOpenStatus,
  projectOptions,
  quickFilterCounts,
  searchFromViewState,
  sortRows,
  tagsWithProject,
  taskProject,
  viewStateFromSearch,
  QUICK_FILTERS,
  GROUP_KEYS,
  SORT_KEYS,
  type QuickFilter,
  type TasksViewState,
} from "@/lib/tasks-view";
import { loadWorkspaceRoster } from "@/lib/api/workspace-roster";
import {
  memberDisplayName,
  resolveAssignee,
  type AssignableMember,
} from "@/components/brain/property-edit";
import {
  AssigneeCell,
  DueCell,
  PriorityCell,
  ProjectCell,
  StatusCell,
  STATUS_DOT,
} from "./task-cells";
import { TaskBoard } from "./task-board";
import { TaskRecordDetail } from "./task-record-detail";
import {
  FilterBar,
  ViewOptionRow,
  ViewOptionSection,
  type FilterDef,
} from "@/components/operator/filter-bar";
import { requestBrainRefresh } from "@/lib/brain-events";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Above this many selected rows the surface uses the server bulk endpoint
 *  (one round-trip) instead of the per-row client loop. */
const SERVER_BULK_THRESHOLD = 50;

const NONE = "__none__";

export function TasksSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT().tasksPage;
  const brainT = useT().brainPage;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── Data ──────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [roster, setRoster] = useState<AssignableMember[] | null>(null);

  const reload = useCallback(() => {
    setLoadError(false);
    fetchWorkspaceTasks(workspaceId)
      .then(setRows)
      .catch(() => setLoadError(true));
  }, [workspaceId]);

  useEffect(() => {
    setRows(null);
    reload();
    loadWorkspaceRoster(workspaceId)
      .then(setRoster)
      .catch(() => setRoster([]));
  }, [workspaceId, reload]);

  // ── View state (URL is the source of truth) ───────────────────────────
  const view = useMemo(
    () => viewStateFromSearch(searchParams),
    [searchParams],
  );
  const setView = useCallback(
    (patch: Partial<TasksViewState>) => {
      const next = { ...view, ...patch };
      const search = searchFromViewState(next);
      router.replace(search ? `${pathname}?${search}` : pathname, {
        scroll: false,
      });
    },
    [view, router, pathname],
  );

  // ── Derived ───────────────────────────────────────────────────────────
  const now = useMemo(() => new Date(), []);
  const all = rows ?? [];
  const counts = useMemo(() => quickFilterCounts(all, now), [all, now]);
  const projects = useMemo(() => projectOptions(all), [all]);
  const filtered = useMemo(
    () => sortRows(applyFilters(all, view, now), view.sort),
    [all, view, now],
  );
  const groups = useMemo(
    () => groupRows(filtered, view.group, now),
    [filtered, view.group, now],
  );
  const activeCount = useMemo(
    () => all.filter((r) => isOpenStatus(r.status)).length,
    [all],
  );
  const completedCount = all.length - activeCount;

  // ── Selection ─────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Prune ids that fell out of the current filter (acted on / filtered away).
  const visibleIds = useMemo(() => new Set(filtered.map((r) => r.id)), [filtered]);
  const selectedVisible = useMemo(
    () => [...selected].filter((id) => visibleIds.has(id)),
    [selected, visibleIds],
  );
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const allSelected =
    filtered.length > 0 && selectedVisible.length === filtered.length;
  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(filtered.map((r) => r.id)));
  }, [allSelected, filtered]);

  // ── Group collapse ────────────────────────────────────────────────────
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Peek panel — clicking a row opens the in-place editor, not Brain ──
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const openTask = useMemo(
    () => (rows ?? []).find((r) => r.id === openTaskId) ?? null,
    [rows, openTaskId],
  );

  // ── Mutations (supersession-aware) ────────────────────────────────────
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  /** Patch a row in place after an adjust: apply local changes + swap to
   *  the supersession id everywhere (rows + selection). */
  const patchRow = useCallback(
    (id: string, newId: string | null, patch: Partial<TaskRow>) => {
      setRows((prev) =>
        prev
          ? prev.map((r) =>
              r.id === id ? { ...r, ...patch, id: newId ?? r.id } : r,
            )
          : prev,
      );
      if (newId) {
        setSelected((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          next.add(newId);
          return next;
        });
      }
    },
    [],
  );

  /** One inline-cell commit: adjust + local patch. */
  const commitField = useCallback(
    async (
      row: TaskRow,
      changes: AdjustMemoryChanges,
      patch: Partial<TaskRow>,
    ): Promise<{ ok: boolean; error?: string }> => {
      const result = await adjustBrainRow(workspaceId, "task", row.id, changes);
      if (!result.ok) return { ok: false, error: result.error };
      patchRow(row.id, result.newId, patch);
      // Keep the peek panel anchored across the supersession id swap.
      setOpenTaskId((cur) =>
        cur === row.id ? (result.newId ?? row.id) : cur,
      );
      return { ok: true };
    },
    [workspaceId, patchRow],
  );

  /** Run a bulk mutation over the selection. Small selections loop the
   *  per-row wire (failed ids STAY SELECTED for a retry — the Reviews-queue
   *  contract); large ones take the server lane WHEN the change is uniform
   *  (`serverSet` — project bulk is per-row tags, so it always loops). */
  const runBulk = useCallback(
    async (
      apply:
        | {
            kind: "adjust";
            /** Per-row adjust body (project bulk differs per row). */
            changesFor: (row: TaskRow) => AdjustMemoryChanges;
            patch: (row: TaskRow) => Partial<TaskRow>;
            /** Uniform change for the server lane, or null = client-loop only. */
            serverSet: BulkTaskSet | null;
          }
        | { kind: "delete" },
    ) => {
      const ids = selectedVisible;
      if (ids.length === 0 || bulkBusy) return;
      setBulkBusy(true);
      setBulkError(null);
      try {
        const serverEligible =
          apply.kind === "delete" || apply.serverSet !== null;
        if (ids.length > SERVER_BULK_THRESHOLD && serverEligible) {
          // Server lane — one round trip, then refetch (supersession ids).
          const body =
            apply.kind === "delete"
              ? ({ action: "delete", ids } as const)
              : ({ action: "update", ids, set: apply.serverSet! } as const);
          const result = await bulkTasks(workspaceId, body);
          if (!("results" in result)) {
            setBulkError(result.error);
            return;
          }
          const failed = result.results.filter((r) => !r.ok).map((r) => r.id);
          setSelected(new Set(failed));
          if (failed.length > 0) {
            setBulkError(
              format(t.bulkPartialFail, {
                failed: String(failed.length),
                total: String(ids.length),
              }),
            );
          }
          reload();
          return;
        }
        // Client loop — sequential, per-row endpoints (Reviews-queue pattern).
        const failed: string[] = [];
        for (const id of ids) {
          const row = (rows ?? []).find((r) => r.id === id);
          if (!row) continue;
          if (apply.kind === "delete") {
            const result = await deleteBrainRow(workspaceId, "task", id);
            if (result.ok) {
              setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
              setSelected((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
            } else failed.push(id);
          } else {
            const result = await adjustBrainRow(
              workspaceId,
              "task",
              id,
              apply.changesFor(row),
            );
            if (result.ok) patchRow(id, result.newId, apply.patch(row));
            else failed.push(id);
          }
        }
        if (failed.length > 0) {
          setSelected(new Set(failed));
          setBulkError(
            format(t.bulkPartialFail, {
              failed: String(failed.length),
              total: String(ids.length),
            }),
          );
        } else if (apply.kind !== "delete") {
          setSelected(new Set());
        }
      } finally {
        setBulkBusy(false);
        // Other surfaces (Brain list, dock badge) repaint off this signal.
        requestBrainRefresh(workspaceId);
      }
    },
    [selectedVisible, bulkBusy, workspaceId, rows, patchRow, reload, t],
  );

  const bulkDelete = useCallback(async () => {
    const count = selectedVisible.length;
    if (count === 0) return;
    const ok = await confirmDialog({
      title: t.bulkDeleteTitle,
      description: format(t.bulkDeleteConfirm, { count: String(count) }),
      confirmLabel: t.bulkDelete,
      cancelLabel: t.cancel,
      variant: "destructive",
    });
    if (ok) void runBulk({ kind: "delete" });
  }, [selectedVisible, runBulk, t]);

  // ── Render ────────────────────────────────────────────────────────────
  const statusLabels = brainT.taskStatus as Record<string, string>;
  const priorityLabels = brainT.taskPriority as Record<string, string>;
  const quickLabels: Record<QuickFilter, string> = {
    stale: t.quickStale,
    doneOpen: t.quickDoneOpen,
    unassigned: t.quickUnassigned,
    noDue: t.quickNoDue,
  };
  const groupLabels: Record<string, string> = {
    status: t.groupStatus,
    assignee: t.groupAssignee,
    project: t.groupProject,
    due: t.groupDue,
    none: t.groupNone,
  };
  const sortLabels: Record<string, string> = {
    updated: t.sortUpdated,
    due: t.sortDue,
    priority: t.sortPriority,
    created: t.sortCreated,
  };
  const dueBucketLabels: Record<string, string> = {
    overdue: t.dueBucketOverdue,
    today: t.dueBucketToday,
    week: t.dueBucketWeek,
    later: t.dueBucketLater,
    none: t.noDate,
  };

  function groupLabel(key: string): string {
    if (view.group === "status") return statusLabels[key] ?? key;
    if (view.group === "assignee") {
      if (key === "") return t.unassignedOption;
      const m = roster ? resolveAssignee(roster, key) : null;
      return (m && memberDisplayName(m)) || t.memberUnknown;
    }
    if (view.group === "project") return key === "" ? t.noProject : key;
    if (view.group === "due") return dueBucketLabels[key] ?? key;
    return "";
  }

  const hasSelection = selectedVisible.length > 0;

  // Property → value defs for the FilterBar (Notion-style funnel picker).
  const filterDefs: FilterDef[] = [
    {
      key: "assignee",
      label: t.filterAssignee,
      options: [
        { value: "none", label: t.unassignedOption },
        ...(roster ?? []).map((m) => ({
          value: m.id,
          label: memberDisplayName(m) ?? t.memberUnknown,
        })),
      ],
    },
    {
      key: "status",
      label: t.filterStatus,
      options: (
        ["todo", "in_progress", "in_review", "blocked", "done", "archived"] as TaskStatus[]
      ).map((sKey) => ({
        value: sKey,
        label: statusLabels[sKey] ?? sKey,
        dot: STATUS_DOT[sKey],
      })),
    },
    {
      key: "priority",
      label: t.filterPriority,
      options: [
        { value: "none", label: priorityLabels.none ?? "None" },
        ...(["low", "medium", "high", "urgent"] as TaskPriority[]).map((pKey) => ({
          value: pKey,
          label: priorityLabels[pKey] ?? pKey,
        })),
      ],
    },
    {
      key: "project",
      label: t.filterProject,
      options: [
        { value: "none", label: t.noProject },
        ...projects.map((pName) => ({ value: pName, label: pName })),
      ],
    },
    {
      key: "due",
      label: t.filterDue,
      options: [
        { value: "overdue", label: t.dueOverdue },
        { value: "week", label: t.dueWeek },
        { value: "month", label: t.dueMonth },
        { value: "none", label: t.noDate },
      ],
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Chrome — the shared operator top bar names the app; the count
          summary + view toggle ride its right slot, replacing the old
          icon+title header row ([COMP:app-web/operator-topbar]). */}
      <OperatorTopbar
        app="tasks"
        right={
          <>
            {rows !== null && (
              <span className="text-[12.5px] text-sidebar-foreground/70 max-sm:hidden">
                {format(t.countSummary, {
                  total: String(all.length),
                  active: String(activeCount),
                })}
              </span>
            )}
            <button
              type="button"
              aria-pressed={view.view === "table"}
              aria-label={t.viewTable}
              onClick={() => setView({ view: "table" })}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px]",
                view.view === "table"
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60",
              )}
            >
              <Rows3 className="size-3.5" aria-hidden />
              {t.viewTable}
            </button>
            <button
              type="button"
              aria-pressed={view.view === "board"}
              aria-label={t.viewBoard}
              onClick={() => setView({ view: "board" })}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px]",
                view.view === "board"
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60",
              )}
            >
              <Kanban className="size-3.5" aria-hidden />
              {t.viewBoard}
            </button>
          </>
        }
      />

      {/* `relative`: the task peek panel floats over THIS box — it never
          reflows the table/board underneath, and never covers the bar. */}
      <div className="relative flex min-h-0 flex-1 flex-col">

      {/* Toolbar — cleanup presets + filters + search in ONE quiet strip
          (swaps for the bulk bar while rows are checked). The presets stay
          the two-click cleanup driver: tap → select-all → one bulk action;
          zero-count presets render disabled, never hidden (stable layout). */}
      {hasSelection ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent/30 px-4 py-2">
          <span className="text-[12.5px] font-medium">
            {format(t.selectedCount, { count: String(selectedVisible.length) })}
          </span>
          <BulkMenu
            label={t.bulkStatus}
            items={Object.fromEntries(
              (["todo", "in_progress", "in_review", "blocked", "done", "archived"] as TaskStatus[]).map(
                (s) => [s, statusLabels[s] ?? s],
              ),
            )}
            disabled={bulkBusy}
            onPick={(status) =>
              void runBulk({
                kind: "adjust",
                changesFor: () => ({ status: status as TaskStatus }),
                patch: () => ({ status: status as TaskStatus }),
                serverSet: { status: status as TaskStatus },
              })
            }
          />
          <BulkMenu
            label={t.bulkAssign}
            items={{
              [NONE]: t.unassignedOption,
              ...Object.fromEntries(
                (roster ?? []).map((m) => [m.id, memberDisplayName(m) ?? t.memberUnknown]),
              ),
            }}
            disabled={bulkBusy}
            onPick={(id) =>
              void runBulk({
                kind: "adjust",
                changesFor: () => ({ assignee_id: id === NONE ? null : id }),
                patch: () => ({ assigneeId: id === NONE ? null : id }),
                serverSet: { assignee_id: id === NONE ? null : id },
              })
            }
          />
          <BulkMenu
            label={t.bulkPriority}
            items={{
              [NONE]: priorityLabels.none ?? "None",
              ...Object.fromEntries(
                (["low", "medium", "high", "urgent"] as TaskPriority[]).map((p) => [
                  p,
                  priorityLabels[p] ?? p,
                ]),
              ),
            }}
            disabled={bulkBusy}
            onPick={(p) =>
              void runBulk({
                kind: "adjust",
                changesFor: () => ({
                  priority: p === NONE ? null : (p as TaskPriority),
                }),
                patch: (row) => ({
                  attributes:
                    p === NONE
                      ? Object.fromEntries(
                          Object.entries(row.attributes).filter(
                            ([k]) => k !== "priority",
                          ),
                        )
                      : { ...row.attributes, priority: p },
                }),
                serverSet: { priority: p === NONE ? null : (p as TaskPriority) },
              })
            }
          />
          <BulkMenu
            label={t.bulkProject}
            items={{
              [NONE]: t.noProject,
              ...Object.fromEntries(projects.map((p) => [p, p])),
            }}
            disabled={bulkBusy}
            onPick={(p) =>
              void runBulk({
                kind: "adjust",
                // Project is a per-row tags rewrite (tag namespace, §5) —
                // no uniform server set, so it always takes the client loop.
                changesFor: (row) => ({
                  tags: tagsWithProject(row.tags, p === NONE ? null : p),
                }),
                patch: (row) => ({
                  tags: tagsWithProject(row.tags, p === NONE ? null : p),
                }),
                serverSet: null,
              })
            }
          />
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() =>
              void runBulk({
                kind: "adjust",
                changesFor: () => ({ status: "archived" as TaskStatus }),
                patch: () => ({ status: "archived" as TaskStatus }),
                serverSet: { status: "archived" },
              })
            }
            className="inline-flex h-7 items-center rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-accent/60 disabled:opacity-50"
          >
            {t.bulkArchive}
          </button>
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => void bulkDelete()}
            className="inline-flex h-7 items-center rounded-md px-2 text-[12.5px] text-red-500 hover:bg-red-500/10 disabled:opacity-50"
          >
            {t.bulkDelete}
          </button>
          <button
            type="button"
            aria-label={t.bulkClear}
            onClick={() => setSelected(new Set())}
            className="ml-auto inline-flex h-7 items-center rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-accent/60"
          >
            {t.bulkClear}
          </button>
          {bulkError && (
            <span className="w-full text-[12px] text-red-500" role="alert">
              {bulkError}
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
          {QUICK_FILTERS.map((f) => {
            const active = view.quick === f;
            const count = counts[f];
            return (
              <button
                key={f}
                type="button"
                disabled={count === 0 && !active}
                aria-pressed={active}
                onClick={() =>
                  setView({ quick: active ? null : f, statuses: [] })
                }
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                  count === 0 && !active && "opacity-40",
                )}
              >
                {quickLabels[f]}
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
          <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden />
          <FilterBar
            defs={filterDefs}
            active={{
              assignee: view.assignee,
              status: view.quick ? null : (view.statuses[0] ?? null),
              priority: view.priority,
              project: view.project,
              due: view.due,
            }}
            onSet={(key, value) => {
              if (key === "assignee") setView({ assignee: value });
              else if (key === "status")
                setView({ quick: null, statuses: value ? [value as TaskStatus] : [] });
              else if (key === "priority")
                setView({ priority: value as TasksViewState["priority"] });
              else if (key === "project") setView({ project: value });
              else if (key === "due") setView({ due: value as TasksViewState["due"] });
            }}
            search={view.q}
            onSearch={(q) => setView({ q })}
            searchPlaceholder={t.searchPlaceholder}
            viewOptions={
              <>
                {view.view === "table" && (
                  <>
                    <ViewOptionSection label={t.groupBy}>
                      {GROUP_KEYS.map((g) => (
                        <ViewOptionRow
                          key={g}
                          label={groupLabels[g] ?? g}
                          selected={view.group === g}
                          onPick={() => setView({ group: g })}
                        />
                      ))}
                    </ViewOptionSection>
                    <ViewOptionSection label={t.sortLabel}>
                      {SORT_KEYS.map((sKey) => (
                        <ViewOptionRow
                          key={sKey}
                          label={sortLabels[sKey] ?? sKey}
                          selected={view.sort === sKey}
                          onPick={() => setView({ sort: sKey })}
                        />
                      ))}
                    </ViewOptionSection>
                  </>
                )}
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted">
                  <Checkbox
                    checked={view.completed}
                    onCheckedChange={(checked) => setView({ completed: checked })}
                    aria-label={t.showCompleted}
                  />
                  {t.showCompleted}
                  {completedCount > 0 && (
                    <span className="tabular-nums">({completedCount})</span>
                  )}
                </label>
              </>
            }
          />
        </div>
      )}

      {/* Body — table or board. */}
      <div className="min-h-0 flex-1 overflow-auto">
        {rows === null ? (
          <div className="p-6 text-sm text-muted-foreground">
            {loadError ? (
              <span>
                {t.loadFailed}{" "}
                <button
                  type="button"
                  onClick={reload}
                  className="underline hover:text-foreground"
                >
                  {t.retry}
                </button>
              </span>
            ) : (
              t.loading
            )}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            {all.length === 0 ? t.emptyAll : t.empty}
          </div>
        ) : view.view === "board" ? (
          <TaskBoard
            rows={filtered}
            roster={roster}
            showCompleted={view.completed || view.quick === "doneOpen"}
            onStatusDrop={(row, status) =>
              void commitField(row, { status }, { status })
            }
            onOpenRecord={(row) => setOpenTaskId(row.id)}
          />
        ) : (
          <div className="min-w-[640px]">
            {groups.map((group) => (
              <div key={group.key || "__all__"}>
                {view.group !== "none" && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={!collapsed.has(group.key)}
                    className="flex w-full items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-1.5 text-left text-[12px] font-semibold text-muted-foreground hover:bg-muted/50"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 transition-transform",
                        !collapsed.has(group.key) && "rotate-90",
                      )}
                      aria-hidden
                    />
                    {view.group === "status" && (
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          STATUS_DOT[group.key as TaskStatus] ?? "bg-muted-foreground/40",
                        )}
                        aria-hidden
                      />
                    )}
                    {groupLabel(group.key)}
                    <span className="tabular-nums font-normal">
                      {group.rows.length}
                    </span>
                  </button>
                )}
                {!collapsed.has(group.key) &&
                  group.rows.map((row) => (
                    <TaskTableRow
                      key={row.id}
                      row={row}
                      roster={roster}
                      projects={projects}
                      selected={selected.has(row.id)}
                      onToggle={toggle}
                      onOpen={(r) => setOpenTaskId(r.id)}
                      commitField={commitField}
                    />
                  ))}
              </div>
            ))}
            {/* Select-all footer strip. */}
            <div className="flex items-center gap-2 px-4 py-2 text-[12px] text-muted-foreground">
              <Checkbox
                checked={allSelected}
                indeterminate={hasSelection && !allSelected}
                onCheckedChange={toggleAll}
                aria-label={t.selectAll}
              />
              {t.selectAll}
              <span className="tabular-nums">({filtered.length})</span>
            </div>
          </div>
        )}
      </div>

        {/* Task peek panel — floats over the surface; Brain stays one click
            away via its header link. */}
        {openTask && (
          <TaskRecordDetail
            workspaceId={workspaceId}
            row={openTask}
            roster={roster}
            projects={projects}
            commitField={commitField}
            onClose={() => setOpenTaskId(null)}
          />
        )}
      </div>
    </div>
  );
}

/** One table row: checkbox + title (opens the peek editor) + inline cells. */
function TaskTableRow({
  row,
  roster,
  projects,
  selected,
  onToggle,
  onOpen,
  commitField,
}: {
  row: TaskRow;
  roster: AssignableMember[] | null;
  projects: string[];
  selected: boolean;
  onToggle: (id: string) => void;
  onOpen: (row: TaskRow) => void;
  commitField: (
    row: TaskRow,
    changes: AdjustMemoryChanges,
    patch: Partial<TaskRow>,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useT().tasksPage;
  return (
    <div
      className={cn(
        "group/task grid grid-cols-[28px_minmax(0,1fr)_128px_44px_96px_110px_100px] items-center gap-1 px-4 py-1.5 transition-colors md:grid-cols-[28px_minmax(0,1fr)_128px_150px_96px_110px_100px]",
        selected ? "bg-primary/5" : "hover:bg-muted/40",
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggle(row.id)}
        aria-label={format(t.selectRowAria, { title: row.title })}
        className={cn(
          "transition-opacity",
          !selected && "opacity-0 group-hover/task:opacity-100 group-focus-within/task:opacity-100",
        )}
      />
      <button
        type="button"
        onClick={() => onOpen(row)}
        title={t.openRecord}
        className="truncate py-1 text-left text-[13.5px] font-medium text-foreground hover:underline"
      >
        {row.title}
      </button>
      <StatusCell
        value={row.status}
        onCommit={(status) => commitField(row, { status }, { status })}
      />
      <AssigneeCell
        assigneeId={row.assigneeId}
        roster={roster}
        onCommit={(assigneeId) =>
          commitField(row, { assignee_id: assigneeId }, { assigneeId })
        }
      />
      <PriorityCell
        value={taskPriority(row)}
        onCommit={(priority) =>
          commitField(
            row,
            { priority },
            {
              attributes:
                priority === null
                  ? Object.fromEntries(
                      Object.entries(row.attributes).filter(([k]) => k !== "priority"),
                    )
                  : { ...row.attributes, priority },
            },
          )
        }
      />
      <ProjectCell
        value={taskProject(row)}
        projects={projects}
        onCommit={(project) => {
          const tags = tagsWithProject(row.tags, project);
          return commitField(row, { tags }, { tags });
        }}
      />
      <DueCell
        value={row.due}
        onCommit={(due) => commitField(row, { due_at: due }, { due })}
      />
    </div>
  );
}


/** Action menu for the bulk bar — always shows its action label; picking
 *  an item fires `onPick` over the whole selection (a menu, not a value
 *  binding, so the same item can be picked twice in a row). */
function BulkMenu({
  label,
  items,
  disabled,
  onPick,
}: {
  label: string;
  items: Record<string, string>;
  disabled?: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            className="inline-flex h-7 items-center rounded-md border border-border px-2 text-[12.5px] font-medium hover:bg-accent/60 disabled:opacity-50"
          >
            {label}
          </button>
        }
      />
      <DropdownMenuContent>
        {Object.entries(items).map(([value, itemLabel]) => (
          <DropdownMenuItem key={value} onClick={() => onPick(value)}>
            {itemLabel}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
