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
 * State model: the URL is the durable source of truth for the view
 * (`tasks-view.ts` codec) — the sidebar panel and the Home dock card
 * (`?filter=stale`) deep-link into it. Search keeps an optimistic local mirror
 * and writes through `history.replaceState`, so typing filters immediately
 * without starting an RSC navigation per character. Mutations ride the existing
 * brain-inbox wire (`adjustBrainRow` / `deleteBrainRow`, supersession-aware:
 * every edit mints a new row id). Small non-destructive selections keep the
 * per-row retry loop; every multi-delete uses `bulkTasks`, removes the complete
 * selection optimistically, and restores only failed rows. Destructive bulk
 * may collect one shared reason so every rejected task teaches the workspace
 * independently.
 *
 * Spec: docs/architecture/features/tasks.md → "Operator surface".
 * [COMP:app-web/tasks-surface]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ChevronRight,
  CircleUserRound,
  Kanban,
  ListChecks,
  Rows3,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { UserAvatar } from "@/components/ui/user-avatar";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { cn } from "@/lib/utils";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { surfaceDataKey } from "@/lib/surface-prefetch";
import { useT } from "@/lib/i18n/client";
import {
  TaskSuggestionsBanner,
  TaskSuggestionsView,
} from "@/components/tasks/task-suggestions";
import { loadTaskCandidates } from "@/lib/api/task-guardrails";
import { TaskRulesPanel } from "@/components/tasks/task-rules-panel";
import { format } from "@/lib/i18n/format";
import { Checkbox } from "@/components/ui/checkbox";
import { promptDialog } from "@/components/ui/prompt-dialog";
import {
  adjustBrainRow,
  deleteBrainRow,
  type AdjustMemoryChanges,
} from "@/lib/api/brain-inbox";
import {
  bulkTasks,
  fetchWorkspaceTasks,
  taskIcon,
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

/** Above this many selected rows a uniform non-destructive edit uses the server
 * bulk endpoint instead of the per-row client loop. Delete always uses it. */
const SERVER_BULK_THRESHOLD = 50;
/** The server route accepts 1-200 ids per request. The operator list can
 *  contain 500 rows, so a filter-scoped selection may need three batches. */
const SERVER_BULK_BATCH_SIZE = 200;

const NONE = "__none__";

export function TasksSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT().tasksPage;
  const brainT = useT().brainPage;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const taskRulesOpen = searchParams.get("task-settings") === "rules";

  // ── Data ──────────────────────────────────────────────────────────────
  // Read through the surface cache: coming back to Tasks paints the last known
  // list on the first frame and revalidates behind it, instead of blanking to a
  // skeleton for a round trip every single visit. Hovering the Tasks icon in
  // the operator bar has usually already warmed this exact key
  // (`lib/surface-prefetch.ts`), so even a first visit often lands on data.
  const tasksKey = surfaceDataKey("tasks", workspaceId);
  const tasks = useCachedResource(tasksKey, () =>
    fetchWorkspaceTasks(workspaceId),
  );
  const rows = tasks.data ?? null;
  // Only an error with NOTHING to show is a load failure; a failed revalidation
  // behind a painted list stays quiet.
  const loadError = rows === null && tasks.error !== undefined;
  const [roster, setRoster] = useState<AssignableMember[] | null>(null);

  // Depend on the stable `refresh` callback, NOT the resource object — that
  // object is new every render, so a dep on it re-creates `reload` each time
  // and churns anything keyed on it.
  const refreshTasks = tasks.refresh;
  const reload = useCallback(() => {
    void refreshTasks();
  }, [refreshTasks]);

  /** Optimistic row patch - writes to the cache so the edit survives leaving
   *  the surface, and every mounted reader updates together. */
  const setRows = useCallback(
    (updater: (previous: TaskRow[]) => TaskRow[]) => {
      mutateSurfaceCache<TaskRow[]>(tasksKey, updater);
    },
    [tasksKey],
  );

  useEffect(() => {
    loadWorkspaceRoster(workspaceId)
      .then(setRoster)
      .catch(() => setRoster([]));
  }, [workspaceId]);

  // Pending-suggestion count for the tab badge + banner. The Suggestions view
  // keeps it current through `onCountChange`; this seed fetch covers the
  // table/board first paint. A count that cannot load is just 0 - the tasks
  // themselves are the page.
  const [suggestionCount, setSuggestionCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    loadTaskCandidates(workspaceId)
      .then((candidates) => {
        if (!cancelled) setSuggestionCount(candidates.length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // ── View state (URL is the source of truth) ───────────────────────────
  const urlView = useMemo(
    () => viewStateFromSearch(searchParams),
    [searchParams],
  );
  // Search is a rapid, client-only filter over rows already in memory. Keeping
  // the input controlled directly by `useSearchParams` made each keystroke
  // start a Next RSC navigation; the URL response then fed one stale character
  // back into the field and overwrote everything typed after it. The local
  // mirror paints and filters synchronously, while the native History API keeps
  // deep-link state current without a server navigation. Incoming URL changes
  // (saved views, sidebar links, back/forward) still reconcile the mirror.
  const [searchDraft, setSearchDraft] = useState(urlView.q);
  useEffect(() => {
    setSearchDraft(urlView.q);
  }, [urlView.q]);
  const view = useMemo(
    () =>
      urlView.q === searchDraft
        ? urlView
        : { ...urlView, q: searchDraft },
    [searchDraft, urlView],
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
  const setSearch = useCallback(
    (q: string) => {
      setSearchDraft(q);
      const search = searchFromViewState({ ...urlView, q });
      const href = search ? `${pathname}?${search}` : pathname;
      window.history.replaceState(window.history.state, "", href);
    },
    [pathname, urlView],
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
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleIds]);
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
  const selectAllFiltered = useCallback(() => {
    setSelected(new Set(filtered.map((row) => row.id)));
  }, [filtered]);
  const toggleAll = useCallback(() => {
    if (allSelected) setSelected(new Set());
    else selectAllFiltered();
  }, [allSelected, selectAllFiltered]);

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

  const handleSuggestionAccepted = useCallback(
    (task: TaskRow, openEditor: boolean) => {
      // The accept endpoint returns the canonical created row, so paint it
      // immediately instead of making Add-and-edit wait for a list round trip.
      setRows((current) => [task, ...current.filter((row) => row.id !== task.id)]);
      if (openEditor) setOpenTaskId(task.id);
      void refreshTasks();
    },
    [setRows, refreshTasks],
  );

  const setTaskRulesOpen = useCallback(
    (open: boolean) => {
      const next = new URLSearchParams(searchParams.toString());
      if (open) next.set("task-settings", "rules");
      else next.delete("task-settings");
      const search = next.toString();
      router.replace(search ? `${pathname}?${search}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  // ── Mutations (supersession-aware) ────────────────────────────────────
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  /** Patch a row in place after an adjust: apply local changes + swap to
   *  the supersession id everywhere (rows + selection). */
  const patchRow = useCallback(
    (id: string, newId: string | null, patch: Partial<TaskRow>) => {
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...patch, id: newId ?? r.id } : r)),
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

  /** Run a bulk mutation over the selection. Delete always takes the server
   * lane and disappears in one optimistic paint; failed ids are restored and
   * stay selected. Non-destructive edits keep the small client-loop / large
   * uniform-server split (`serverSet` — project bulk is per-row tags). */
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
        /** `reason` is "" for a plain delete (no tombstone, no rule). */
        | { kind: "delete"; reason: string },
    ) => {
      const ids = selectedVisible;
      if (ids.length === 0 || bulkBusy) return;
      const deleteSnapshot =
        apply.kind === "delete"
          ? (rows ?? []).filter((row) => ids.includes(row.id))
          : [];
      const restoreDeletedRows = (failedIds: string[]) => {
        if (apply.kind !== "delete" || failedIds.length === 0) return;
        const failed = new Set(failedIds);
        setRows((current) => {
          const present = new Set(current.map((row) => row.id));
          return [
            ...current,
            ...deleteSnapshot.filter(
              (row) => failed.has(row.id) && !present.has(row.id),
            ),
          ];
        });
      };
      const confirmedDeleted = new Set<string>();
      setBulkBusy(true);
      setBulkError(null);
      if (apply.kind === "delete") {
        const deleting = new Set(ids);
        setRows((current) => current.filter((row) => !deleting.has(row.id)));
        setSelected(new Set());
        setOpenTaskId((current) =>
          current && deleting.has(current) ? null : current,
        );
      }
      try {
        const serverEligible =
          apply.kind === "delete" || apply.serverSet !== null;
        if (
          apply.kind === "delete" ||
          (ids.length > SERVER_BULK_THRESHOLD && serverEligible)
        ) {
          // Server lane — ≤200 ids per request, then refetch (supersession
          // ids). A transport failure keeps that batch + every unattempted
          // id selected while preserving successes from earlier batches.
          const failed: string[] = [];
          let requestError: string | null = null;
          for (
            let offset = 0;
            offset < ids.length;
            offset += SERVER_BULK_BATCH_SIZE
          ) {
            const batchIds = ids.slice(offset, offset + SERVER_BULK_BATCH_SIZE);
            const body =
              apply.kind === "delete"
                ? apply.reason
                  ? ({
                      action: "delete",
                      ids: batchIds,
                      reason: apply.reason,
                      create_rule: true,
                    } as const)
                  : ({ action: "delete", ids: batchIds } as const)
                : ({
                    action: "update",
                    ids: batchIds,
                    set: apply.serverSet!,
                  } as const);
            const result = await bulkTasks(workspaceId, body);
            if (!("results" in result)) {
              failed.push(...ids.slice(offset));
              requestError = result.error;
              break;
            }
            const resultById = new Map(
              result.results.map((row) => [row.id, row] as const),
            );
            for (const id of batchIds) {
              if (resultById.get(id)?.ok) {
                if (apply.kind === "delete") confirmedDeleted.add(id);
              } else {
                // A missing per-id outcome is a failure too. The optimistic
                // delete must never hide a row the server did not confirm.
                failed.push(id);
              }
            }
          }
          restoreDeletedRows(failed);
          setSelected(new Set(failed));
          if (requestError) {
            setBulkError(requestError);
          } else if (failed.length > 0) {
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
          const result = await adjustBrainRow(
            workspaceId,
            "task",
            id,
            apply.changesFor(row),
          );
          if (result.ok) patchRow(id, result.newId, apply.patch(row));
          else failed.push(id);
        }
        if (failed.length > 0) {
          setSelected(new Set(failed));
          setBulkError(
            format(t.bulkPartialFail, {
              failed: String(failed.length),
              total: String(ids.length),
            }),
          );
        } else {
          setSelected(new Set());
        }
      } catch {
        let failedCount = ids.length;
        if (apply.kind === "delete") {
          const retryIds = ids.filter((id) => !confirmedDeleted.has(id));
          restoreDeletedRows(retryIds);
          setSelected(new Set(retryIds));
          failedCount = retryIds.length;
        }
        setBulkError(
          format(t.bulkPartialFail, {
            failed: String(failedCount),
            total: String(ids.length),
          }),
        );
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
    const answer = await promptDialog({
      title: t.bulkDeleteTitle,
      description: format(t.bulkDeleteConfirm, { count: String(count) }),
      placeholder: t.deleteReasonPlaceholder,
      confirmLabel: t.bulkDeleteAndAddRules,
      emptyConfirmLabel: format(t.bulkDeleteOnly, { count: String(count) }),
      cancelLabel: t.cancel,
      multiline: true,
      // Teaching a rule is the better outcome, not a toll: an empty box
      // still deletes, it just teaches nothing.
      allowEmpty: true,
    });
    if (answer === null) return;
    const reason = answer.trim();
    if (reason.length > 0 && reason.length < 3) {
      setBulkError(t.deleteReasonTooShort);
      return;
    }
    void runBulk({ kind: "delete", reason });
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
      // People read as faces, not strings — the same avatars the assignee
      // cell and board chips use, so one member looks identical everywhere.
      options: [
        {
          value: "none",
          label: t.unassignedOption,
          icon: (size: number) => (
            <CircleUserRound
              size={size}
              className="shrink-0 text-muted-foreground/50"
              aria-hidden
            />
          ),
        },
        ...(roster ?? []).map((m) => ({
          value: m.id,
          label: memberDisplayName(m) ?? t.memberUnknown,
          icon: (size: number) => (
            <UserAvatar
              name={memberDisplayName(m) ?? undefined}
              email={m.email ?? undefined}
              avatarUrl={m.avatarUrl}
              size={size}
            />
          ),
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
            <button
              type="button"
              aria-label={t.guardrails.rulesTitle}
              aria-pressed={taskRulesOpen}
              title={t.guardrails.rulesTitle}
              onClick={() => {
                setOpenTaskId(null);
                setTaskRulesOpen(true);
              }}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px]",
                taskRulesOpen
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60",
              )}
            >
              <ShieldCheck className="size-3.5" aria-hidden />
              <span className="max-lg:hidden">{t.guardrails.rulesTitle}</span>
            </button>
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
            <button
              type="button"
              aria-pressed={view.view === "suggestions"}
              aria-label={t.viewSuggestions}
              onClick={() => setView({ view: "suggestions" })}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px]",
                view.view === "suggestions"
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60",
              )}
            >
              <Sparkles className="size-3.5" aria-hidden />
              {t.viewSuggestions}
              {suggestionCount > 0 && (
                <span className="rounded-full bg-primary/15 px-1.5 text-[11px] tabular-nums text-primary">
                  {suggestionCount}
                </span>
              )}
            </button>
          </>
        }
      />

      {/* Suggestion-first: extracted candidates wait in the Suggestions view.
          The table/board show a one-line banner while any are pending
          ([COMP:app-web/task-suggestions],
          docs/architecture/features/task-guardrails.md). */}
      {view.view !== "suggestions" && (
        <TaskSuggestionsBanner
          count={suggestionCount}
          onReview={() => setView({ view: "suggestions" })}
        />
      )}

      {/* `relative`: the task peek panel floats over THIS box — it never
          reflows the table/board underneath, and never covers the bar. */}
      <div className="relative flex min-h-0 flex-1 flex-col">

      {/* Toolbar — cleanup presets + filters + search in ONE quiet strip
          (swaps for the bulk bar while rows are checked). The presets stay
          the two-click cleanup driver: tap → select-all → one bulk action;
          zero-count presets render disabled, never hidden (stable layout).
          The Suggestions view has its own chrome, so the toolbar hides there. */}
      {view.view === "suggestions" ? null : hasSelection ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent/30 px-4 py-2">
          <span className="text-[12.5px] font-medium">
            {format(t.selectedCount, { count: String(selectedVisible.length) })}
          </span>
          {!allSelected && (
            <button
              type="button"
              disabled={bulkBusy}
              onClick={selectAllFiltered}
              className="inline-flex h-7 items-center rounded-md px-2 text-[12.5px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {format(t.selectAllFiltered, {
                count: String(filtered.length),
              })}
            </button>
          )}
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
          {filtered.length > 0 && (
            <button
              type="button"
              onClick={selectAllFiltered}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ListChecks className="size-3.5" aria-hidden />
              {format(t.selectAllFiltered, {
                count: String(filtered.length),
              })}
            </button>
          )}
          <FilterBar
            defs={filterDefs}
            active={{
              assignee: view.assignee,
              // A quick-filter owns the status slice; its pill would lie.
              status: view.quick ? [] : view.statuses,
              priority: view.priority,
              project: view.project,
              due: view.due,
            }}
            onSet={(key, values) => {
              if (key === "assignee") setView({ assignee: values });
              else if (key === "status")
                setView({ quick: null, statuses: values as TaskStatus[] });
              else if (key === "priority")
                setView({ priority: values as TasksViewState["priority"] });
              else if (key === "project") setView({ project: values });
              else if (key === "due") setView({ due: values as TasksViewState["due"] });
            }}
            search={searchDraft}
            onSearch={setSearch}
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

      {/* Body — table, board, or the suggestions review view. */}
      {view.view === "suggestions" ? (
        <TaskSuggestionsView
          workspaceId={workspaceId}
          onAccepted={handleSuggestionAccepted}
          onCountChange={setSuggestionCount}
        />
      ) : (
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
      )}

        {/* Task peek panel — floats over the surface; Brain stays one click
            away via its header link. */}
        {!taskRulesOpen && openTask && (
          <TaskRecordDetail
            workspaceId={workspaceId}
            row={openTask}
            roster={roster}
            projects={projects}
            commitField={commitField}
            onDelete={async (reason) => {
              // No reason = plain delete: no tombstone, no rule.
              const result = await deleteBrainRow(
                workspaceId,
                "task",
                openTask.id,
                reason ? { reason, createRule: true } : undefined,
              );
              if (!result.ok) return result;
              setRows((prev) => prev.filter((row) => row.id !== openTask.id));
              setSelected((prev) => {
                const next = new Set(prev);
                next.delete(openTask.id);
                return next;
              });
              requestBrainRefresh(workspaceId);
              return { ok: true };
            }}
            onClose={() => setOpenTaskId(null)}
          />
        )}
        {taskRulesOpen && (
          <TaskRulesPanel
            workspaceId={workspaceId}
            onClose={() => setTaskRulesOpen(false)}
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
  const icon = taskIcon(row);
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
        className="flex min-w-0 items-center gap-1.5 py-1 text-left text-[13.5px] font-medium text-foreground hover:underline"
      >
        {icon && (
          <span className="shrink-0 text-[15px] leading-none" aria-hidden>
            {icon}
          </span>
        )}
        <span className="truncate">{row.title}</span>
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
