"use client";

/**
 * Tasks surface sidebar panel — swapped into the persistent left sidebar
 * while the Tasks operator surface is active. Styled on the Brain panel's
 * recipe (`brain-sidebar-panel.tsx`): `.doc-nav-active` nav rows (no
 * primary blue), quiet tabular counts, cleanup presets wearing the same
 * amber attention badge the Brain Reviews row uses, and uppercase block
 * headers.
 *
 * Sections:
 *   - All tasks + Cleanup — the quick-filter presets with live counts,
 *     deep-linking into `/tasks?filter=…` (the same codec the surface +
 *     the Home dock card use, so "needs cleanup" means one thing
 *     everywhere);
 *   - Views — saved task views (named filter sets, per-workspace
 *     localStorage via `tasks-view.ts`): apply on click, save the current
 *     URL state, hover-delete.
 *
 * Fetches its own row copy for the counts (the "sidebar fetches its own
 * copy" pattern) — cheap against the flat list endpoint, refreshed on the
 * brain-refresh signal the surface fires after mutations.
 *
 * [COMP:app-web/tasks-surface] (the sidebar-panel flavour)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";
import { fetchWorkspaceTasks, type TaskRow } from "@/lib/api/tasks";
import {
  QUICK_FILTERS,
  quickFilterCounts,
  readSavedViews,
  searchFromViewState,
  viewStateFromSearch,
  writeSavedViews,
  type QuickFilter,
  type SavedTaskView,
} from "@/lib/tasks-view";

/** The Brain panel's nav-row recipe — active is the `.doc-nav-active` pill. */
const rowCls = (active: boolean) =>
  cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
    active
      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

const sectionHeaderCls =
  "px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45";

/** The Brain Reviews row's amber attention badge. */
function AttentionBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="shrink-0 min-w-[1.1rem] h-[1.1rem] px-1 inline-flex items-center justify-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[10px] font-semibold tabular-nums">
      {count}
    </span>
  );
}

export function TasksSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT().tasksPage;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── Live counts (own fetch; refreshed on the surface's mutate signal) ──
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  const refresh = useCallback(() => {
    fetchWorkspaceTasks(workspaceId)
      .then(setRows)
      .catch(() => setRows([]));
  }, [workspaceId]);
  useEffect(() => {
    setRows(null);
    refresh();
    window.addEventListener(BRAIN_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(BRAIN_REFRESH_EVENT, refresh);
  }, [refresh]);
  const counts = useMemo(
    () => quickFilterCounts(rows ?? [], new Date()),
    [rows],
  );

  const activeQuick = viewStateFromSearch(searchParams).quick;
  const quickLabels: Record<QuickFilter, string> = {
    stale: t.quickStale,
    doneOpen: t.quickDoneOpen,
    unassigned: t.quickUnassigned,
    noDue: t.quickNoDue,
  };

  // ── Saved views ───────────────────────────────────────────────────────
  const [views, setViews] = useState<SavedTaskView[]>([]);
  useEffect(() => {
    setViews(readSavedViews(workspaceId));
  }, [workspaceId]);
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");

  const saveCurrent = useCallback(() => {
    const name = draftName.trim();
    if (name.length === 0) return;
    const view: SavedTaskView = {
      id: `v_${Math.random().toString(36).slice(2, 10)}`,
      name,
      search: searchFromViewState(viewStateFromSearch(searchParams)),
    };
    const next = [...views, view];
    setViews(next);
    writeSavedViews(workspaceId, next);
    setNaming(false);
    setDraftName("");
  }, [draftName, searchParams, views, workspaceId]);

  const removeView = useCallback(
    (id: string) => {
      const next = views.filter((v) => v.id !== id);
      setViews(next);
      writeSavedViews(workspaceId, next);
    },
    [views, workspaceId],
  );

  const base = `/w/${workspaceId}/tasks`;
  const currentSearch = searchParams?.toString() ?? "";
  const allActive =
    (pathname?.endsWith("/tasks") ?? false) &&
    !activeQuick &&
    currentSearch === "";

  return (
    <div className="flex flex-col gap-3 px-1 pt-1">
      {/* All tasks — the unfiltered surface. */}
      <div className="flex flex-col gap-0.5">
        <Link href={base} aria-current={allActive ? "page" : undefined} className={rowCls(allActive)}>
          <span className="min-w-0 flex-1 truncate">{t.allTasks}</span>
          {rows !== null && (
            <span className="shrink-0 tabular-nums text-[11px] text-sidebar-foreground/50">
              {rows.length}
            </span>
          )}
        </Link>
      </div>

      {/* Cleanup presets — live counts as the amber attention badge. */}
      <div>
        <div className={sectionHeaderCls}>{t.cleanupLabel}</div>
        <div className="flex flex-col gap-0.5">
          {QUICK_FILTERS.map((f) => (
            <Link
              key={f}
              href={`${base}?filter=${f}`}
              aria-current={activeQuick === f ? "page" : undefined}
              className={rowCls(activeQuick === f)}
            >
              <span className="min-w-0 flex-1 truncate">{quickLabels[f]}</span>
              <AttentionBadge count={counts[f]} />
            </Link>
          ))}
        </div>
      </div>

      {/* Saved views */}
      <div>
        <div className="group/views flex items-center">
          <span className={cn(sectionHeaderCls, "min-w-0 flex-1 truncate pb-0")}>
            {t.savedViews}
          </span>
          <button
            type="button"
            aria-label={t.saveViewAria}
            onClick={() => setNaming((v) => !v)}
            className="flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/50 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-hover/views:opacity-100"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <div className="mt-1.5 flex flex-col gap-0.5">
          {naming && (
            <input
              type="text"
              autoFocus
              value={draftName}
              placeholder={t.viewNamePlaceholder}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveCurrent();
                }
                if (e.key === "Escape") {
                  setNaming(false);
                  setDraftName("");
                }
              }}
              onBlur={() => {
                if (draftName.trim().length > 0) saveCurrent();
                else setNaming(false);
              }}
              className="h-7 w-full rounded-md border border-border bg-background px-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          )}
          {views.length === 0 && !naming ? (
            <div className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
              {t.noSavedViews}
            </div>
          ) : (
            views.map((v) => (
              <div key={v.id} className="group/view relative">
                <button
                  type="button"
                  onClick={() =>
                    router.push(v.search ? `${base}?${v.search}` : base)
                  }
                  className={rowCls(
                    currentSearch === v.search && currentSearch !== "",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`${t.deleteView}: ${v.name}`}
                  onClick={() => removeView(v.id)}
                  className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-sidebar-foreground/50 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-destructive group-hover/view:opacity-100"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
