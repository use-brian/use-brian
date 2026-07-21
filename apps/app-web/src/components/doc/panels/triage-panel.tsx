"use client";

/**
 * Triage panel — "Tasks assignable", rendered as a **doc-shell panel tab**
 * (`/w/[workspaceId]/p?panel=triage`). Task autopilot v2
 * (docs/plans/task-goal-autopilot.md §8): a top-level task the triage judge
 * deemed honestly assistable gets a DRAFT goal with a generated brief
 * (outcome + verification + approach). This surface is where the user reviews
 * those drafts: edit the brief, then **Confirm & arm** (clarity-gated - the
 * gate's question surfaces inline) or **Dismiss** (reversible → `abandoned`).
 * Confirmed goals leave this list and appear on the Autopilot board
 * (`?panel=goals`), which lists confirmed goals only.
 *
 * Entry is attention-routed via the home-dock `task_triage` needs-you card
 * (the Approvals / Autopilot pattern - no sidebar slot, no shortcut).
 *
 * Master-detail two-pane, actions in a top action bar (never a bottom footer -
 * it would collide with the floating chat dock).
 *
 * Spec: docs/architecture/features/goals.md → "Triage surface".
 * [COMP:app-web/triage-panel]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useWorkspaces } from "@/contexts/workspace-context";
import {
  abandonGoal,
  confirmGoal,
  getGoalDetail,
  listGoals,
  type GoalDetail,
  type GoalRow,
} from "@/lib/api/goals";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/components/ui/confirm-dialog";

export function TriagePanel() {
  const t = useT();
  const { activeId } = useWorkspaces();
  const [rows, setRows] = useState<GoalRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped after a pane action (confirm / dismiss) so the list re-pulls and a
  // still-open pane re-fetches its detail.
  const [refetchTick, setRefetchTick] = useState(0);
  const refetch = useCallback(() => setRefetchTick((n) => n + 1), []);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setRows(null);
    // Unconfirmed drafts only - the §8 triage population. Non-terminal by
    // default, so a dismissed (abandoned) draft leaves the queue.
    listGoals(activeId, { confirmed: false })
      .then((g) => {
        if (!cancelled) setRows(g);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, refetchTick]);

  // Keep a valid selection: default to the first row; drop a selection that
  // vanished after a confirm / dismiss.
  useEffect(() => {
    if (!rows || rows.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0].id));
  }, [rows]);

  return (
    <div className="h-full w-full flex">
      {/* Left: the assignable-task list */}
      <div className="w-[340px] shrink-0 border-r border-border flex flex-col min-h-0">
        <header className="flex flex-col gap-2 px-5 pt-5 pb-3 border-b border-border">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            {t.triagePage.title}
            {rows && rows.length > 0 && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">
                {format(t.triagePage.countBadge, { count: rows.length })}
              </span>
            )}
          </h1>
          <p className="text-xs text-muted-foreground">{t.triagePage.description}</p>
        </header>

        {rows === null ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            {t.triagePage.loading}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
            <ul className="flex flex-col gap-1.5">
              {rows.map((g) => (
                <TriageListRow
                  key={g.id}
                  goal={g}
                  selected={g.id === selectedId}
                  onSelect={() => setSelectedId(g.id)}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Right: the brief review pane */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selectedId ? (
          <TriageDetailPane
            key={selectedId}
            goalId={selectedId}
            refreshKey={refetchTick}
            onActed={refetch}
          />
        ) : (
          rows !== null && (
            <div className="h-full flex items-center justify-center px-8 text-center text-sm text-muted-foreground">
              {t.triagePage.selectPrompt}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** The centred empty state (nothing waiting for triage - the good state). */
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
        <path d="M9 11l3 3 8-8" />
        <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
      </svg>
      <div className="font-medium">{t.triagePage.emptyTitle}</div>
      <p className="text-sm text-muted-foreground max-w-md">{t.triagePage.emptyBody}</p>
    </div>
  );
}

/** One selectable row: the task title leads (the user thinks in tasks here);
 *  the drafted outcome is the support line. */
function TriageListRow({
  goal,
  selected,
  onSelect,
}: {
  goal: GoalRow;
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
        <span className="text-sm font-medium text-foreground line-clamp-2">
          {goal.hostTitle ?? goal.outcome}
        </span>
        {goal.hostTitle && (
          <span className="text-xs text-muted-foreground line-clamp-2">{goal.outcome}</span>
        )}
        <span className="text-[11px] text-muted-foreground">
          {format(t.triagePage.updated, {
            when: new Date(goal.updatedAt).toLocaleDateString(),
          })}
        </span>
      </button>
    </li>
  );
}

/**
 * The right pane: the judge's brief, fully editable before arming. Outcome,
 * verification, and approach are textareas; the judge's reason renders as a
 * quiet note. Confirm & arm routes the edits through the clarity-gated
 * confirm (an unclear configuration surfaces the gate's question inline and
 * refocuses the outcome field); Dismiss abandons the draft (reversible).
 */
function TriageDetailPane({
  goalId,
  refreshKey,
  onActed,
}: {
  goalId: string;
  refreshKey: number;
  onActed: () => void;
}) {
  const t = useT();
  const labels = t.triagePage;
  const [goal, setGoal] = useState<GoalDetail | null | undefined>(undefined);
  const [outcomeDraft, setOutcomeDraft] = useState("");
  const [verificationDraft, setVerificationDraft] = useState("");
  const [approachDraft, setApproachDraft] = useState("");
  const [busy, setBusy] = useState<null | "confirm" | "dismiss">(null);
  const [error, setError] = useState<string | null>(null);
  // The clarity gate's clarifying question (HTTP 200, ok:false) - guidance,
  // distinct from a hard error.
  const [question, setQuestion] = useState<string | null>(null);
  const outcomeRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setQuestion(null);
    setGoal(undefined);
    void getGoalDetail(goalId).then((g) => {
      if (cancelled) return;
      setGoal(g);
      setOutcomeDraft(g?.outcome ?? "");
      setVerificationDraft(g?.brief?.verification ?? "");
      setApproachDraft(g?.brief?.approach ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [goalId, refreshKey]);

  if (goal === undefined) {
    return (
      <div className="w-full px-8 py-10 text-sm text-muted-foreground">{labels.loading}</div>
    );
  }
  if (goal === null) {
    return (
      <div className="w-full px-8 py-20 text-center flex flex-col gap-2">
        <div className="font-medium">{labels.notFoundTitle}</div>
        <p className="text-sm text-muted-foreground">{labels.notFoundBody}</p>
      </div>
    );
  }

  async function handleConfirm() {
    if (!goal) return;
    const outcome = outcomeDraft.trim();
    if (!outcome) {
      setError(labels.confirmError);
      return;
    }
    setBusy("confirm");
    setError(null);
    setQuestion(null);
    // Send only what the user actually edited (else leave stored text alone).
    const verification = verificationDraft.trim();
    const approach = approachDraft.trim();
    const r = await confirmGoal(goalId, outcome !== goal.outcome ? outcome : undefined, {
      verification:
        verification && verification !== (goal.brief?.verification ?? "") ? verification : undefined,
      approach: approach && approach !== (goal.brief?.approach ?? "") ? approach : undefined,
    });
    setBusy(null);
    if (!r.ok) {
      if (r.needsClarification && r.question) {
        setQuestion(r.question);
        requestAnimationFrame(() => outcomeRef.current?.focus());
      } else {
        setError(r.error ?? labels.confirmError);
      }
      return;
    }
    onActed();
  }

  async function handleDismiss() {
    const ok = await confirmDialog({
      title: labels.dismissDialog.title,
      description: labels.dismissDialog.body,
      confirmLabel: labels.dismissDialog.confirm,
      cancelLabel: labels.dismissDialog.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy("dismiss");
    setError(null);
    const r = await abandonGoal(goalId);
    setBusy(null);
    if (!r.ok) {
      setError(r.error ?? labels.dismissError);
      return;
    }
    onActed();
  }

  return (
    <div className="w-full h-full flex flex-col">
      {/* Action bar - pinned to the TOP of the pane (the Autopilot pattern). */}
      <div className="shrink-0 border-b border-border px-8 py-4 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={handleDismiss}
          className="text-xs px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-accent/40 disabled:opacity-50"
        >
          {busy === "dismiss" ? labels.dismissing : labels.dismiss}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={handleConfirm}
          className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy === "confirm" ? labels.confirming : labels.confirmArm}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-8 pt-6 pb-6 flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          {goal.hostTitle && (
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {format(labels.taskHeading, { title: goal.hostTitle })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{labels.reviewHint}</p>
        </header>

        <BriefField
          label={labels.outcomeHeading}
          hint={labels.outcomeHint}
          value={outcomeDraft}
          onChange={setOutcomeDraft}
          rows={2}
          emphasis
          textareaRef={outcomeRef}
        />
        <BriefField
          label={labels.verificationHeading}
          hint={labels.verificationHint}
          value={verificationDraft}
          onChange={setVerificationDraft}
          rows={3}
        />
        <BriefField
          label={labels.approachHeading}
          hint={labels.approachHint}
          value={approachDraft}
          onChange={setApproachDraft}
          rows={4}
        />

        {goal.brief?.judgeReason && (
          <section className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 px-4 py-3">
            <h2 className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {labels.judgeReasonHeading}
            </h2>
            <p className="text-xs text-foreground">{goal.brief.judgeReason}</p>
          </section>
        )}

        {question && (
          <div className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-50/40 dark:bg-amber-950/10 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
              {labels.clarifyLabel}
            </p>
            <p className="text-xs text-foreground">{question}</p>
          </div>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    </div>
  );
}

/** One editable brief field: label, textarea, quiet hint. */
function BriefField({
  label,
  hint,
  value,
  onChange,
  rows,
  emphasis,
  textareaRef,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
  emphasis?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-xs uppercase tracking-wide text-muted-foreground">{label}</h2>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        maxLength={2000}
        aria-label={label}
        className={cn(
          "w-full resize-none rounded-md border border-border bg-background px-3 py-2 leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          emphasis ? "text-lg font-semibold" : "text-sm",
        )}
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </section>
  );
}
