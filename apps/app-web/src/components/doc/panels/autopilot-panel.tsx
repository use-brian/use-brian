"use client";

/**
 * Autopilot panel — the goals board, rendered as a **doc-shell panel tab**
 * (`/w/[workspaceId]/p?panel=goals`), NOT its own top-level route. Opened from
 * the home dock's "Autopilot needs you" card and the Brain task panel; the doc
 * tab strip, sidebar, and chat dock persist around it. The legacy
 * `/w/[workspaceId]/goals` route redirects here (its `[goalId]` detail
 * sub-route stays a full page for deep links). Spec:
 * docs/architecture/features/doc.md → "Top bar" (panel tabs).
 *
 * Deliberately has NO sidebar slot or keyboard shortcut (the Approvals
 * pattern): entry is attention-routed via the home-dock `autopilot` needs-you
 * card and the Brain task panel's autopilot affordance.
 *
 * **Master-detail two-pane, CONFIRMED goals only** (task-goal-autopilot.md §8).
 * Drafts live on the Triage panel (`?panel=triage`, `triage-panel.tsx`) — this
 * board lists goals that are armed and ready to kick start, working, blocked,
 * or finished (`listGoals(..., confirmed: true)`). The right pane renders the
 * full contract (what "done" means, how it's worked, budget, confirmation
 * state) with no navigation, and its actions live in a **top action bar**
 * (pinned above the scroll region, not a bottom footer — the footer position
 * collided with the bottom-right floating chat dock): **Work this** for an
 * armed goal, **Discard** while non-terminal; a working / completed goal shows
 * its state. (The pane keeps a defensive draft branch for deep links to a
 * draft id, but the board list never contains one.)
 *
 * app-web is single-workspace-per-route, so the board scopes to the route
 * workspace via `activeId` from `useWorkspaces()`.
 *
 * Spec: docs/architecture/features/goals.md.
 * [COMP:app-web/goals-board]
 */

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useWorkspaces } from "@/contexts/workspace-context";
import {
  abandonGoal,
  confirmGoal,
  getGoalDetail,
  listGoals,
  workGoal,
  type GoalDetail,
  type GoalRow,
  type GoalStatus,
} from "@/lib/api/goals";
import { useCachedResource } from "@/lib/surface-cache";
import { goalDetailCacheKey, goalsCacheKey } from "@/lib/surface-prefetch";
import { requestGoalRefresh } from "@/lib/goal-events";
import { openWorkspaceSettings } from "@/lib/workspace-settings-events";
import { Skeleton } from "@/components/skeleton";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { BackButton } from "@/components/ui/back-button";
import { STATUS_BADGE } from "./goal-status-badge";
import { summariseDoneWhen } from "./goal-done-when";

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

/** A goal is a DRAFT (needs confirmation) when it's unconfirmed and not terminal
 *  — the auto-drafted "Complete: …" goals minted per task. This is the split
 *  that turns the flat list into a queue. */
function isDraft(g: { confirmedAt: string | null; status: GoalStatus }): boolean {
  return g.confirmedAt === null && g.status !== "done" && g.status !== "abandoned";
}

export function AutopilotPanel() {
  const t = useT();
  const { activeId } = useWorkspaces();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Phone single-pane (responsive contract M1 / M5): below `md` the list and
  // the detail are two screens, not two columns. The first row is still
  // auto-SELECTED (so `md+` opens on a goal), but the detail only takes the
  // pane once a row is TAPPED, and Back returns to the list. On `md+` both
  // render side by side and this flag is inert.
  const [detailOpen, setDetailOpen] = useState(false);

  // One cache slot per status filter (instant-navigation contract N1): a
  // re-open paints the last-known board on the first frame and revalidates
  // behind it. Liveness comes from the spine map marking `goals:<wid>` on
  // GOAL_REFRESH_EVENT - the `goal` primitive on the server leg (a goal an
  // assistant confirmed from chat, a draft the judge minted from a worker)
  // and `requestGoalRefresh` on the same-tab leg after a pane action - so
  // this panel carries no refetch tick of its own. A specific status (incl.
  // terminal done/abandoned) returns that status; "all" shows the
  // non-terminal working set. Confirmed only (§8) — drafts are triaged on
  // the Triage panel, never listed here. `listGoals` answers `[]` on a
  // non-OK response, so the catch covers a network failure the way the
  // pre-cache `setRows([])` did.
  const board = useCachedResource<GoalRow[]>(
    activeId ? goalsCacheKey(activeId, statusFilter) : null,
    () => {
      const status = statusFilter === "all" ? undefined : statusFilter;
      return listGoals(activeId ?? "", {
        status,
        includeTerminal: statusFilter !== "all",
        confirmed: true,
      }).catch(() => [] as GoalRow[]);
    },
  );
  const rows: GoalRow[] | null = board.data ?? (board.loading ? null : []);
  // After a pane action (confirm / work / discard): mark the board and the
  // open detail stale so both revalidate while their rows stay up.
  const refetch = () => requestGoalRefresh(activeId ?? null);

  // Keep a valid selection: default to the first row; drop a selection that
  // vanished after a filter change or a discard (an abandoned goal leaves the
  // "all" set).
  useEffect(() => {
    if (!rows || rows.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0].id));
  }, [rows]);

  const statusLabel = (s: StatusFilter): string =>
    s === "all" ? t.goalsPage.statusAll : t.goalsPage.status[s];

  const hostLabel = (host: GoalRow["host"]): string =>
    host ? t.goalsPage.host[host.type] : t.goalsPage.host.standalone;

  return (
    <div className="h-full w-full flex flex-col md:flex-row">
      {/* Left: the list. Full-width on a phone, where it yields the pane to
          the detail once a row is tapped (see `detailOpen`). */}
      <div
        className={cn(
          "w-full md:w-[340px] shrink-0 md:border-r border-border flex flex-col min-h-0",
          detailOpen && "max-md:hidden",
        )}
      >
        <header className="flex flex-col gap-2 px-5 pt-5 pb-3 border-b border-border">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            {t.goalsPage.title}
            {rows && rows.length > 0 && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">
                {format(t.goalsPage.countBadge, { count: rows.length })}
              </span>
            )}
          </h1>
          <p className="text-xs text-muted-foreground">{t.goalsPage.description}</p>
          <label className="flex flex-col gap-1 text-xs">
            <span className="sr-only">{t.goalsPage.filterStatusLabel}</span>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                if (typeof v === "string") setStatusFilter(v as StatusFilter);
              }}
            >
              <SelectTrigger size="sm" className="min-w-[10rem] text-[16px] md:text-xs">
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
        </header>

        {rows === null ? (
          // Cold cache only (N4): geometry-matched rows, never a sentence. A
          // re-open never reaches this branch - the cached board paints.
          <ListRowsSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
            <ul className="flex flex-col gap-1.5">
              {rows.map((g) => (
                <GoalListRow
                  key={g.id}
                  goal={g}
                  hostLabel={hostLabel(g.host)}
                  selected={g.id === selectedId}
                  onSelect={() => {
                    setSelectedId(g.id);
                    setDetailOpen(true);
                  }}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Right: the detail pane. On a phone it is the second screen, with a
          Back row above the action bar (M1: every control reachable). */}
      <div
        className={cn(
          "flex-1 min-w-0 overflow-y-auto flex flex-col",
          !detailOpen && "max-md:hidden",
        )}
      >
        {selectedId ? (
          <>
            <div className="shrink-0 border-b border-border px-4 py-1 md:hidden">
              <BackButton
                label={t.goalsPage.backToList}
                onClick={() => setDetailOpen(false)}
                className="min-h-11"
              />
            </div>
            <GoalDetailPane
              key={selectedId}
              workspaceId={activeId ?? ""}
              goalId={selectedId}
              seed={rows?.find((r) => r.id === selectedId) ?? null}
              hostLabel={hostLabel}
              onActed={refetch}
            />
          </>
        ) : (
          rows !== null && (
            <div className="h-full flex items-center justify-center px-4 md:px-8 text-center text-sm text-muted-foreground">
              {t.goalsPage.selectPrompt}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** Cold-cache rows for the list column (N4) - the row recipe's geometry. */
function ListRowsSkeleton() {
  return (
    <div className="flex-1 min-h-0 overflow-hidden px-3 py-3 flex flex-col gap-1.5" aria-busy>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="rounded-md border border-border bg-card px-3 py-2.5 flex flex-col gap-2">
          <Skeleton className="h-3.5" style={{ width: `${48 + ((i * 17) % 40)}%` }} />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

/** The centred empty state (no goals at all). */
function EmptyState() {
  const t = useT();
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 px-6">
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
  );
}

/** The draft / status chip, shared by the list row and the detail pane so a
 *  draft reads as "Draft" (not a misleading "Active") everywhere. */
function GoalBadge({ goal }: { goal: { confirmedAt: string | null; status: GoalStatus } }) {
  const t = useT();
  if (isDraft(goal)) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 bg-amber-500/15 text-amber-600 dark:text-amber-400">
        {t.goalsPage.draftBadge}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0",
        STATUS_BADGE[goal.status],
      )}
    >
      {t.goalsPage.status[goal.status]}
    </span>
  );
}

/** One selectable row in the left list. */
function GoalListRow({
  goal,
  hostLabel,
  selected,
  onSelect,
}: {
  goal: GoalRow;
  hostLabel: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "w-full text-left rounded-md border px-3 py-2.5 flex flex-col gap-1.5 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected
            ? "border-primary/40 bg-primary/5"
            : "border-border bg-card hover:bg-accent/40",
        )}
      >
        <div className="flex items-start gap-2">
          <span className="flex-1 text-sm font-medium text-foreground line-clamp-2">
            {goal.outcome}
          </span>
          <GoalBadge goal={goal} />
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="px-1.5 py-0.5 rounded bg-muted">{hostLabel}</span>
          <span>
            {format(t.goalsPage.updated, {
              when: new Date(goal.updatedAt).toLocaleDateString(),
            })}
          </span>
        </div>
      </button>
    </li>
  );
}

/**
 * The right pane: one goal's full acceptance contract, plus the pre-run
 * affordances. A draft gets an editable outcome + Confirm & arm / Discard; a
 * confirmed goal gets Work this / Discard; a working / completed goal shows its
 * state. The §12 clarity-gate question surfaces inline and refocuses the
 * outcome field so the user can refine and re-confirm.
 */
function GoalDetailPane({
  workspaceId,
  goalId,
  seed,
  hostLabel,
  onActed,
}: {
  workspaceId: string;
  goalId: string;
  /** The board row for this goal (title + status), painted while the
   *  detail is cold so the pane never opens blank. */
  seed: GoalRow | null;
  hostLabel: (host: GoalRow["host"]) => string;
  onActed: () => void;
}) {
  const t = useT();
  const labels = t.goalsPage.detail;
  const actions = t.goalsPage.actions;
  // Shared with the full `/goals/[goalId]` page; marked stale by the spine map
  // (`goal:<wid>:`) on every goal change, including this pane's own actions
  // via `onActed` -> `requestGoalRefresh`. `getGoalDetail` answers `null` on
  // a non-OK response, so a cold `error` is a network failure: render it as
  // not-found rather than a skeleton forever.
  const detail = useCachedResource<GoalDetail | null>(
    goalDetailCacheKey(workspaceId, goalId),
    () => getGoalDetail(goalId),
  );
  const goal =
    detail.data === undefined && detail.error !== undefined ? null : detail.data;
  const [outcomeDraft, setOutcomeDraft] = useState(seed?.outcome ?? "");
  // The outcome field is an editable draft: adopt a (re)validated outcome
  // only while the draft still equals the last value it was seeded from, so
  // a spine revalidation mid-edit never clobbers what the user typed.
  const adoptedOutcomeRef = useRef<string | null>(seed?.outcome ?? null);
  useEffect(() => {
    if (!goal) return;
    const adopted = adoptedOutcomeRef.current;
    setOutcomeDraft((cur) => (adopted === null || cur === adopted ? goal.outcome : cur));
    adoptedOutcomeRef.current = goal.outcome;
  }, [goal]);
  const [busy, setBusy] = useState<null | "confirm" | "work" | "discard">(null);
  const [error, setError] = useState<string | null>(null);
  // The §12 clarity gate's clarifying question (HTTP 200, ok:false) — guidance,
  // distinct from a hard error.
  const [question, setQuestion] = useState<string | null>(null);
  const outcomeRef = useRef<HTMLTextAreaElement>(null);

  if (goal === undefined) {
    // Cold cache: the board row already knows the title and status, so the
    // pane opens on those and skeletons only the contract below (N4).
    return (
      <div className="w-full h-full flex flex-col" aria-busy>
        {seed && (
          <header className="shrink-0 px-4 md:px-8 pt-6 flex items-start justify-between gap-3">
            <h1 className="text-xl font-semibold flex-1 min-w-0 break-words">{seed.outcome}</h1>
            <GoalBadge goal={seed} />
          </header>
        )}
        <div className="px-4 md:px-8 pt-6 flex flex-col gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-6">
              <Skeleton className="h-3 w-20 shrink-0" />
              <Skeleton className="h-3.5" style={{ width: `${40 + ((i * 19) % 45)}%` }} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (goal === null) {
    return (
      <div className="w-full px-4 md:px-8 py-20 text-center flex flex-col gap-2">
        <div className="font-medium">{labels.notFoundTitle}</div>
        <p className="text-sm text-muted-foreground">{labels.notFoundBody}</p>
      </div>
    );
  }

  const draft = isDraft(goal);

  async function handleConfirm() {
    if (!goal) return;
    const outcome = outcomeDraft.trim();
    if (!outcome) {
      setError(actions.confirmError);
      return;
    }
    setBusy("confirm");
    setError(null);
    setQuestion(null);
    // Only send the outcome when the user actually edited it (else leave the
    // stored text untouched).
    const r = await confirmGoal(goalId, outcome !== goal.outcome ? outcome : undefined);
    setBusy(null);
    if (!r.ok) {
      if (r.needsClarification && r.question) {
        setQuestion(r.question);
        requestAnimationFrame(() => outcomeRef.current?.focus());
      } else {
        setError(r.error ?? actions.confirmError);
      }
      return;
    }
    onActed();
  }

  async function handleWork() {
    setBusy("work");
    setError(null);
    const r = await workGoal(goalId);
    setBusy(null);
    if (!r.ok) {
      setError(r.error ?? actions.workError);
      return;
    }
    onActed();
  }

  async function handleDiscard() {
    const ok = await confirmDialog({
      title: t.goalsPage.discardDialog.title,
      description: t.goalsPage.discardDialog.body,
      confirmLabel: t.goalsPage.discardDialog.confirm,
      cancelLabel: t.goalsPage.discardDialog.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy("discard");
    setError(null);
    const r = await abandonGoal(goalId);
    setBusy(null);
    if (!r.ok) {
      setError(r.error ?? actions.discardError);
      return;
    }
    onActed();
  }

  const workedBy = goal.hasWorkflow ? labels.workedBySet : labels.workedByNone;
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
  const discardable = goal.status !== "done" && goal.status !== "abandoned";

  return (
    <div className="w-full h-full flex flex-col">
      {/* Action bar — pinned to the TOP of the pane (previously a bottom footer)
          so the Discard / Confirm & arm / Work-this controls never collide with
          the bottom-right floating chat dock. */}
      <div className="shrink-0 border-b border-border px-4 md:px-8 py-4 flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {goal.status === "done"
            ? actions.completed
            : goal.status === "abandoned"
              ? actions.discarded
              : goal.hasWorkflow && goal.status === "running"
                ? actions.working
                : null}
        </div>
        <div className="flex items-center gap-2">
          {discardable && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={handleDiscard}
              className="text-xs px-3 py-1.5 min-h-11 md:min-h-0 rounded-md border border-border text-foreground hover:bg-accent/40 disabled:opacity-50"
            >
              {busy === "discard" ? actions.discarding : actions.discard}
            </button>
          )}
          {draft ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={handleConfirm}
              className="text-xs px-3 py-1.5 min-h-11 md:min-h-0 rounded-md bg-action text-action-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy === "confirm" ? actions.confirming : actions.confirmArm}
            </button>
          ) : (
            !goal.hasWorkflow &&
            goal.status !== "done" &&
            goal.status !== "abandoned" && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={handleWork}
                className="text-xs px-3 py-1.5 min-h-11 md:min-h-0 rounded-md bg-action text-action-foreground hover:opacity-90 disabled:opacity-50"
              >
                {busy === "work" ? actions.starting : actions.work}
              </button>
            )
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8 pt-6 pb-6 flex flex-col gap-6">
        <header className="flex items-start justify-between gap-3">
          {draft ? (
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              <textarea
                ref={outcomeRef}
                value={outcomeDraft}
                onChange={(e) => setOutcomeDraft(e.target.value)}
                rows={2}
                maxLength={2000}
                aria-label={labels.outcomeHeading}
                className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-lg font-semibold leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-xs text-muted-foreground">{actions.editHint}</p>
            </div>
          ) : (
            <h1 className="text-xl font-semibold flex-1 min-w-0 break-words">{goal.outcome}</h1>
          )}
          <GoalBadge goal={goal} />
        </header>

        {goal.status === "blocked" && goal.blockerReason && (
          <section className="flex flex-col gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3">
            <h2 className="text-xs uppercase tracking-wide text-red-600 dark:text-red-400">
              {labels.blockerHeading}
            </h2>
            <p className="text-sm text-red-600 dark:text-red-400">{goal.blockerReason === "goal_source_scope_unavailable" ? labels.sourceAccessChanged : goal.blockerReason}</p>
            {goal.blockerReason === "goal_source_scope_unavailable" && (
              <button type="button" className="min-h-11 self-start rounded-md border border-border px-3 text-sm font-medium"
                onClick={() => openWorkspaceSettings("ws-access")}>{labels.reviewDepartmentAccess}</button>
            )}
          </section>
        )}

        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
          <Field label={labels.hostHeading}>
            {goal.host ? (
              <span className="flex flex-col gap-0.5">
                <span>{hostLabel(goal.host)}</span>
                <span className="font-mono text-[11px] text-muted-foreground break-all">
                  {goal.host.id}
                </span>
              </span>
            ) : (
              t.goalsPage.host.standalone
            )}
          </Field>

          <Field label={labels.acceptanceHeading}>
            {summariseDoneWhen(goal.doneWhen, labels.acceptance)}
          </Field>

          <Field label={labels.workedByHeading}>{workedBy}</Field>

          <Field label={labels.confirmedHeading}>
            {goal.confirmedAt
              ? format(labels.confirmedAt, { when: new Date(goal.confirmedAt).toLocaleString() })
              : labels.notConfirmed}
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

        {question && (
          <div className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-50/40 dark:bg-amber-950/10 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
              {actions.clarifyLabel}
            </p>
            <p className="text-xs text-foreground">{question}</p>
          </div>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
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
