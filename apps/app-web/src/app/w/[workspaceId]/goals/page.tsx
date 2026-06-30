"use client";

/**
 * Goals board — `/w/[workspaceId]/goals` (app-web).
 *
 * Read-only observability over the goal-seeker primitive: lists the
 * workspace's goals (outcome / status / host / blocker), most-recently-updated
 * first, filterable by status. Goals are minted by the `setGoal` chat tool and
 * completed by the structural rollup; the acting loop and write actions
 * (cancel / re-arm) land alongside the COGS-metering barrier.
 *
 * app-web is single-workspace-per-route, so the board scopes to the route
 * workspace via `activeId` from `useWorkspaces()`. Renders full-width inside
 * the `/w/[workspaceId]` layout's `<main>` (its own chrome, not the doc shell).
 *
 * Spec: docs/architecture/features/goals.md.
 * [COMP:app-web/goals-board]
 */

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useWorkspaces } from "@/contexts/workspace-context";
import { listGoals, type GoalRow, type GoalStatus } from "@/lib/api/goals";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUS_BADGE: Record<GoalStatus, string> = {
  active: "bg-primary/15 text-primary",
  running: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  awaiting_approval: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  blocked: "bg-red-500/15 text-red-600 dark:text-red-400",
  done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  abandoned: "bg-muted text-muted-foreground",
};

const STATUS_FILTERS = [
  "all",
  "active",
  "running",
  "awaiting_approval",
  "blocked",
  "done",
  "abandoned",
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export default function GoalsPage() {
  const t = useT();
  const { activeId } = useWorkspaces();
  const [rows, setRows] = useState<GoalRow[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setRows(null);
    const status = statusFilter === "all" ? undefined : statusFilter;
    // A specific status (incl. terminal done/abandoned) returns that status;
    // "all" shows the non-terminal working set.
    listGoals(activeId, { status, includeTerminal: statusFilter !== "all" })
      .then((g) => {
        if (!cancelled) setRows(g);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, statusFilter]);

  const statusLabel = (s: StatusFilter): string =>
    s === "all" ? t.goalsPage.statusAll : t.goalsPage.status[s];

  const hostLabel = (host: GoalRow["host"]): string =>
    host ? t.goalsPage.host[host.type] : t.goalsPage.host.standalone;

  return (
    <div className="h-full w-full px-8 py-6 flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          {t.goalsPage.title}
          {rows && rows.length > 0 && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">
              {format(t.goalsPage.countBadge, { count: rows.length })}
            </span>
          )}
        </h1>
        <p className="text-sm text-muted-foreground">{t.goalsPage.description}</p>
      </header>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t.goalsPage.filterStatusLabel}</span>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            if (typeof v === "string") setStatusFilter(v as StatusFilter);
          }}
        >
          <SelectTrigger size="sm" className="min-w-[10rem] text-xs">
            <SelectValue>{statusLabel(statusFilter)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {statusLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {rows === null ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {t.goalsPage.loading}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 border border-border rounded-md bg-card/50">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="text-muted-foreground/40"
          >
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="5" />
            <circle cx="12" cy="12" r="1" />
          </svg>
          <div className="font-medium">{t.goalsPage.emptyTitle}</div>
          <p className="text-sm text-muted-foreground max-w-md">{t.goalsPage.emptyBody}</p>
        </div>
      ) : (
        <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
          {rows.map((g) => (
            <li
              key={g.id}
              className="border border-border rounded-md bg-card px-4 py-3 flex flex-col gap-1.5"
            >
              <div className="flex items-start gap-2">
                <span className="flex-1 text-sm font-medium text-foreground">
                  {g.outcome}
                </span>
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0",
                    STATUS_BADGE[g.status],
                  )}
                >
                  {t.goalsPage.status[g.status]}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="px-1.5 py-0.5 rounded bg-muted">{hostLabel(g.host)}</span>
                <span>
                  {format(t.goalsPage.updated, {
                    when: new Date(g.updatedAt).toLocaleDateString(),
                  })}
                </span>
              </div>
              {g.status === "blocked" && g.blockerReason && (
                <p className="text-[11px] text-red-600 dark:text-red-400">
                  {format(t.goalsPage.blocker, { reason: g.blockerReason })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
