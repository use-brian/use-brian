"use client";

/**
 * Goal detail page — `/w/[workspaceId]/goals/[goalId]` (app-web).
 *
 * The board drill-down: one goal's outcome, status, host, confirmation, the
 * human summary of its engine-verifiable acceptance contract (`done_when`),
 * its budget backstop, and the verified completion claim once an agent has
 * closed it. Read-only — the Confirm / Work affordances live on the board row
 * (and the Brain task panel); this surface explains a goal, it doesn't drive it.
 *
 * Mirrors the workflow / brain detail sub-route pattern: `use(params)` for the
 * route ids, full-width chrome (not the doc shell), a `BackButton` to the
 * board. Fetches via `getGoalDetail` (RLS-scoped server-side).
 *
 * v1 scope (docs/architecture/features/goals.md): the goal record + completion
 * claim + blocker. A budget-burndown chart and a per-iteration decision log are
 * deferred until the acting loop lands behind the COGS-metering barrier.
 *
 * Spec: docs/architecture/features/goals.md.
 * [COMP:app-web/goal-detail]
 */

import { use, useEffect, useState } from "react";
import { BackButton } from "@/components/ui/back-button";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { getGoalDetail, type DoneWhenNode, type GoalDetail } from "@/lib/api/goals";
import { cn } from "@/lib/utils";
import { STATUS_BADGE } from "../status-badge";

type AcceptanceLabels = {
  subtasks: string;
  query: string;
  tool: string;
  verify: string;
  all: string;
  any: string;
  not: string;
};

/** Human summary of the `done_when` acceptance tree. Prefers the author's own
 *  description on a query / tool leaf (e.g. "task complete"), falling back to a
 *  generic i18n label; combinators recurse. Never evaluates — the engine does
 *  that elsewhere (see packages/core/src/goals/done-when.ts). */
function summariseDoneWhen(node: DoneWhenNode, L: AcceptanceLabels): string {
  if ("all" in node) {
    return format(L.all, { items: node.all.map((n) => summariseDoneWhen(n, L)).join(", ") });
  }
  if ("any" in node) {
    return format(L.any, { items: node.any.map((n) => summariseDoneWhen(n, L)).join(", ") });
  }
  if ("not" in node) {
    return format(L.not, { item: summariseDoneWhen(node.not, L) });
  }
  if (node.kind === "subtasks") return L.subtasks;
  if (node.kind === "query") return node.query.description?.trim() || L.query;
  if (node.kind === "tool") return node.tool.description?.trim() || node.tool.tool || L.tool;
  return L.verify; // node.kind === "verify"
}

export default function GoalDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; goalId: string }>;
}) {
  const t = useT();
  const labels = t.goalsPage.detail;
  const { workspaceId, goalId } = use(params);
  const listHref = `/w/${workspaceId}/goals`;

  const [goal, setGoal] = useState<GoalDetail | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setGoal(undefined);
    void getGoalDetail(goalId).then((g) => {
      if (!cancelled) setGoal(g);
    });
    return () => {
      cancelled = true;
    };
  }, [goalId]);

  if (goal === undefined) {
    return (
      <div className="w-full px-6 py-10 text-sm text-muted-foreground">
        {t.goalsPage.loading}
      </div>
    );
  }

  if (goal === null) {
    return (
      <div className="w-full px-6 py-20 text-center flex flex-col gap-3">
        <div className="font-medium">{labels.notFoundTitle}</div>
        <p className="text-sm text-muted-foreground">{labels.notFoundBody}</p>
        <BackButton href={listHref} label={labels.back} className="mx-auto" />
      </div>
    );
  }

  // Budget backstops — only the set ones render. `maxSpend` is the load-bearing
  // dollar cap; iterations / deadline are the cheap always-available co-caps.
  const budgetLines: string[] = [];
  if (typeof goal.budget.maxSpend === "number") {
    budgetLines.push(format(labels.budgetMaxSpend, { amount: goal.budget.maxSpend }));
  }
  if (typeof goal.budget.maxIterations === "number") {
    budgetLines.push(format(labels.budgetMaxIterations, { count: goal.budget.maxIterations }));
  }
  if (goal.budget.deadline) {
    budgetLines.push(
      format(labels.budgetDeadline, { when: new Date(goal.budget.deadline).toLocaleDateString() }),
    );
  }

  const claim = goal.completionClaim;

  return (
    // TODO(goals): a budget-burndown chart (needs the COGS-metering barrier's
    // per-iteration spend) and a full per-iteration decision log (the acting
    // loop's run trace) are the natural next sections here. The detail
    // projection already carries `means` / `policy` for that follow-up.
    <div className="w-full h-full overflow-y-auto px-6 pt-6 pb-28 flex flex-col gap-6">
      <BackButton href={listHref} label={labels.back} />

      <header className="flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold flex-1 min-w-0 break-words">{goal.outcome}</h1>
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0",
            STATUS_BADGE[goal.status],
          )}
        >
          {t.goalsPage.status[goal.status]}
        </span>
      </header>

      {goal.status === "blocked" && goal.blockerReason && (
        <section className="flex flex-col gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3">
          <h2 className="text-xs uppercase tracking-wide text-red-600 dark:text-red-400">
            {labels.blockerHeading}
          </h2>
          <p className="text-sm text-red-600 dark:text-red-400">{goal.blockerReason}</p>
        </section>
      )}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
        <Field label={labels.statusHeading}>{t.goalsPage.status[goal.status]}</Field>

        <Field label={labels.hostHeading}>
          {goal.host ? (
            <span className="flex flex-col gap-0.5">
              <span>{t.goalsPage.host[goal.host.type]}</span>
              <span className="font-mono text-[11px] text-muted-foreground break-all">
                {goal.host.id}
              </span>
            </span>
          ) : (
            t.goalsPage.host.standalone
          )}
        </Field>

        <Field label={labels.confirmedHeading}>
          {goal.confirmedAt
            ? format(labels.confirmedAt, { when: new Date(goal.confirmedAt).toLocaleString() })
            : labels.notConfirmed}
        </Field>

        <Field label={labels.acceptanceHeading}>
          {summariseDoneWhen(goal.doneWhen, labels.acceptance)}
        </Field>

        {budgetLines.length > 0 && (
          <Field label={labels.budgetHeading}>
            <span className="flex flex-col gap-0.5">
              {budgetLines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </span>
          </Field>
        )}
      </dl>

      {claim && (
        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">
            {labels.completionHeading}
          </h2>
          <p className="text-sm text-foreground whitespace-pre-wrap break-words">
            {claim.because}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {format(labels.verifiedAt, { when: new Date(claim.verifiedAt).toLocaleString() })}
          </p>
        </section>
      )}
    </div>
  );
}

/** A label / value pair inside the detail `<dl>` grid. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-xs text-muted-foreground uppercase tracking-wide pt-0.5">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}
