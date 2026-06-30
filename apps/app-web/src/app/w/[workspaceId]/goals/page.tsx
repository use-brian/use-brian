"use client";

/**
 * Goals board — `/w/[workspaceId]/goals` (app-web).
 *
 * Observability + light control over the goal-seeker primitive: lists the
 * workspace's goals (outcome / status / host / blocker), most-recently-updated
 * first, filterable by status. Each row drills into the goal detail page and
 * carries the same Confirm / Work-this affordances the Brain task panel does:
 * a DRAFT goal can be confirmed (armed), a confirmed goal can be worked, and a
 * working / completed goal shows its state. Goals are minted by the `setGoal`
 * chat tool (or auto-drafted per task) and completed by the structural rollup.
 *
 * app-web is single-workspace-per-route, so the board scopes to the route
 * workspace via `activeId` from `useWorkspaces()`. Renders full-width inside
 * the `/w/[workspaceId]` layout's `<main>` (its own chrome, not the doc shell).
 *
 * Spec: docs/architecture/features/goals.md.
 * [COMP:app-web/goals-board]
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useWorkspaces } from "@/contexts/workspace-context";
import {
  confirmGoal,
  listGoals,
  workGoal,
  type GoalRow,
} from "@/lib/api/goals";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STATUS_BADGE } from "./status-badge";

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
  // Bumped after a row action (confirm / work) so the board re-pulls and the
  // acted row reflects its new state (armed / working).
  const [refetchTick, setRefetchTick] = useState(0);
  const refetch = useCallback(() => setRefetchTick((n) => n + 1), []);

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
  }, [activeId, statusFilter, refetchTick]);

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
            <GoalListItem
              key={g.id}
              goal={g}
              detailHref={`/w/${activeId}/goals/${encodeURIComponent(g.id)}`}
              hostLabel={hostLabel(g.host)}
              onActed={refetch}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One goal row: a clickable header (drills into the detail page) plus the
 * inline action that fits the goal's state — Confirm a draft, Work a confirmed
 * goal, or a Working / Completed label. Holds its own busy / error /
 * clarifying-question state so one row's action never blocks another.
 */
function GoalListItem({
  goal,
  detailHref,
  hostLabel,
  onActed,
}: {
  goal: GoalRow;
  detailHref: string;
  hostLabel: string;
  onActed: () => void;
}) {
  const t = useT();
  const actions = t.goalsPage.actions;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The §12 clarity gate's clarifying question (HTTP 200, ok:false) — shown as
  // guidance, distinct from a hard error.
  const [question, setQuestion] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    setQuestion(null);
    const r = await confirmGoal(goal.id);
    setBusy(false);
    if (!r.ok) {
      if (r.needsClarification && r.question) {
        setQuestion(r.question);
      } else {
        setError(r.error ?? actions.confirmError);
      }
      return;
    }
    onActed();
  }

  async function handleWork() {
    setBusy(true);
    setError(null);
    setQuestion(null);
    const r = await workGoal(goal.id);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? actions.workError);
      return;
    }
    onActed();
  }

  return (
    <li className="border border-border rounded-md bg-card px-4 py-3 flex flex-col gap-2">
      <Link
        href={detailHref}
        aria-label={t.goalsPage.openAria}
        className="group flex flex-col gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-start gap-2">
          <span className="flex-1 text-sm font-medium text-foreground group-hover:underline">
            {goal.outcome}
          </span>
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0",
              STATUS_BADGE[goal.status],
            )}
          >
            {t.goalsPage.status[goal.status]}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="px-1.5 py-0.5 rounded bg-muted">{hostLabel}</span>
          <span>
            {format(t.goalsPage.updated, {
              when: new Date(goal.updatedAt).toLocaleDateString(),
            })}
          </span>
        </div>
      </Link>

      {goal.status === "blocked" && goal.blockerReason && (
        <p className="text-[11px] text-red-600 dark:text-red-400">
          {format(t.goalsPage.blocker, { reason: goal.blockerReason })}
        </p>
      )}

      <div className="flex items-center gap-2">
        {!goal.confirmedAt ? (
          <button
            type="button"
            disabled={busy}
            onClick={handleConfirm}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? actions.confirming : actions.confirm}
          </button>
        ) : goal.status === "done" ? (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            {actions.completed}
          </span>
        ) : goal.status === "abandoned" ? null : goal.hasWorkflow ? (
          <span className="text-xs text-muted-foreground">{actions.working}</span>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={handleWork}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? actions.starting : actions.work}
          </button>
        )}
      </div>

      {question && (
        <div className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-50/40 dark:bg-amber-950/10 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
            {actions.clarifyLabel}
          </p>
          <p className="text-xs text-foreground">{question}</p>
        </div>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </li>
  );
}
