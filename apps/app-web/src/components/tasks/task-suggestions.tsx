"use client";

/**
 * Task suggestions view - the review surface for suggestion-first creation.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 * Plan: docs/plans/tasks-suggestion-first.md §6
 *
 * Extracted task candidates no longer auto-create by default: everything the
 * admission gate did not drop waits here. The user reviews each suggestion -
 * approve it (optionally under a corrected title), approve it AND opt its
 * class back into automatic creation ("Always"), or dismiss it with a reason
 * that becomes a tombstone. A collapsed section audits what active allow
 * rules created without review.
 *
 * This replaced the old strip-above-the-table tray when suggestion-first
 * landed - a strip cannot host review affordances, and with every extracted
 * candidate holding by default the volume needs a real view. The main task
 * views show a one-line banner linking here instead.
 *
 * [COMP:app-web/task-suggestions]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Inbox,
  Pencil,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import {
  acceptTaskCandidate,
  dismissTaskCandidate,
  loadTaskCandidates,
  type TaskCandidate,
} from "@/lib/api/task-guardrails";

type Props = {
  workspaceId: string;
  /** Called after a candidate becomes a real task, so the task list can refetch. */
  onAccepted?: () => void;
  /** Reports the pending count so the surface can badge the tab + banner. */
  onCountChange?: (count: number) => void;
};

export function TaskSuggestionsView({
  workspaceId,
  onAccepted,
  onCountChange,
}: Props) {
  const t = useT().tasksPage.guardrails;
  const [candidates, setCandidates] = useState<TaskCandidate[] | null>(null);
  const [autoAccepted, setAutoAccepted] = useState<TaskCandidate[]>([]);
  const [autoOpen, setAutoOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<TaskCandidate | null>(null);
  const [reason, setReason] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [pending, auto] = await Promise.all([
        loadTaskCandidates(workspaceId),
        loadTaskCandidates(workspaceId, "auto_accepted"),
      ]);
      setCandidates(pending);
      setAutoAccepted(auto);
      onCountChange?.(pending.length);
    } catch {
      setCandidates([]);
      setError(t.loadFailed);
    }
  }, [workspaceId, onCountChange, t.loadFailed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const accept = useCallback(
    async (candidate: TaskCandidate, always: boolean) => {
      setBusyId(candidate.id);
      setError(null);
      const title =
        editingId === candidate.id && editTitle.trim().length >= 3
          ? editTitle.trim()
          : undefined;
      try {
        await acceptTaskCandidate(workspaceId, candidate.id, {
          title,
          always,
        });
        setCandidates((prev) => {
          const next = (prev ?? []).filter((c) => c.id !== candidate.id);
          onCountChange?.(next.length);
          return next;
        });
        setEditingId(null);
        onAccepted?.();
      } catch {
        setError(t.actionFailed);
      } finally {
        setBusyId(null);
      }
    },
    [workspaceId, onAccepted, onCountChange, editingId, editTitle, t.actionFailed],
  );

  const dismiss = useCallback(
    async (candidate: TaskCandidate, withReason: string | undefined) => {
      setBusyId(candidate.id);
      setError(null);
      try {
        await dismissTaskCandidate(workspaceId, candidate.id, withReason);
        setCandidates((prev) => {
          const next = (prev ?? []).filter((c) => c.id !== candidate.id);
          onCountChange?.(next.length);
          return next;
        });
      } catch {
        setError(t.actionFailed);
      } finally {
        setBusyId(null);
        setDismissing(null);
        setReason("");
      }
    },
    [workspaceId, onCountChange, t.actionFailed],
  );

  const pending = candidates ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Sparkles className="size-4 text-muted-foreground" aria-hidden />
            {t.suggestionsTitle}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t.suggestionsViewSubtitle}
          </p>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {candidates === null ? (
          <p className="text-sm text-muted-foreground">{t.suggestionsLoading}</p>
        ) : pending.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <Inbox className="size-6 text-muted-foreground/60" aria-hidden />
            <p className="text-sm text-foreground">{t.suggestionsEmpty}</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {t.suggestionsEmptyHint}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {pending.map((candidate) => {
              const expanded = expandedId === candidate.id;
              const editing = editingId === candidate.id;
              return (
                <li
                  key={candidate.id}
                  className="rounded-lg border border-border bg-background px-3 py-2.5"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      {editing ? (
                        <input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          autoFocus
                          className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
                          aria-label={t.editTitleLabel}
                        />
                      ) : (
                        <p className="text-sm text-foreground">
                          {candidate.title}
                          <button
                            type="button"
                            aria-label={t.editTitleLabel}
                            title={t.editTitleLabel}
                            onClick={() => {
                              setEditingId(candidate.id);
                              setEditTitle(candidate.title);
                            }}
                            className="ml-1.5 inline-flex align-middle text-muted-foreground/60 hover:text-foreground"
                          >
                            <Pencil className="size-3" aria-hidden />
                          </button>
                        </p>
                      )}
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {reasonLabel(candidate, t)}
                        {candidate.sourceKind
                          ? ` · ${t.sourceLabel.replace("{source}", candidate.sourceKind)}`
                          : ""}
                        {candidate.channelRef ? ` · ${candidate.channelRef}` : ""}
                      </p>
                      {(candidate.quality?.description ||
                        candidate.quality?.evidenceQuote) && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedId(expanded ? null : candidate.id)
                          }
                          aria-expanded={expanded}
                          className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <ChevronRight
                            className={cn(
                              "size-3 transition-transform",
                              expanded && "rotate-90",
                            )}
                            aria-hidden
                          />
                          {t.detailsToggle}
                        </button>
                      )}
                      {expanded && (
                        <div className="mt-1.5 flex flex-col gap-1.5 rounded-md bg-muted/40 p-2 text-xs">
                          {candidate.quality?.evidenceQuote && (
                            <p className="text-muted-foreground">
                              <span className="font-medium text-foreground">
                                {t.evidenceLabel}
                              </span>{" "}
                              &ldquo;{candidate.quality.evidenceQuote}&rdquo;
                            </p>
                          )}
                          {candidate.quality?.description && (
                            <p className="whitespace-pre-wrap text-muted-foreground">
                              {candidate.quality.description}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        disabled={busyId === candidate.id}
                        onClick={() => void accept(candidate, false)}
                        className="inline-flex items-center gap-1 rounded-md bg-action px-2 py-1 text-xs text-action-foreground hover:opacity-90 disabled:opacity-50"
                      >
                        <Check className="size-3.5" aria-hidden />
                        {t.accept}
                      </button>
                      <button
                        type="button"
                        disabled={
                          busyId === candidate.id ||
                          (!candidate.sourceKind && !candidate.channelRef)
                        }
                        title={t.acceptAlwaysHint}
                        onClick={() => void accept(candidate, true)}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                      >
                        {t.acceptAlways}
                      </button>
                      <button
                        type="button"
                        disabled={busyId === candidate.id}
                        onClick={() => {
                          setDismissing(candidate);
                          setReason("");
                        }}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                      >
                        <X className="size-3.5" aria-hidden />
                        {t.dismiss}
                      </button>
                    </div>
                  </div>

                  {dismissing?.id === candidate.id && (
                    <div className="mt-2 rounded-md border border-border bg-muted/30 p-3">
                      <p className="text-sm font-medium text-foreground">
                        {t.dismissTitle}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t.dismissBody}
                      </p>
                      <textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder={t.dismissPlaceholder}
                        rows={2}
                        className="mt-2 w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={reason.trim().length < 3}
                          onClick={() => void dismiss(candidate, reason.trim())}
                          className="rounded bg-action px-2.5 py-1 text-xs text-action-foreground disabled:opacity-50"
                        >
                          {t.dismissConfirm}
                        </button>
                        <button
                          type="button"
                          onClick={() => void dismiss(candidate, undefined)}
                          className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                        >
                          {t.dismissOnly}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDismissing(null);
                            setReason("");
                          }}
                          className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                        >
                          {t.cancel}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {autoAccepted.length > 0 && (
          <div className="border-t border-border pt-3">
            <button
              type="button"
              onClick={() => setAutoOpen((v) => !v)}
              aria-expanded={autoOpen}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn("size-3.5 transition-transform", autoOpen && "rotate-90")}
                aria-hidden
              />
              {t.autoCreatedTitle.replace("{count}", String(autoAccepted.length))}
            </button>
            {autoOpen && (
              <ul className="mt-2 flex flex-col gap-1">
                {autoAccepted.map((candidate) => (
                  <li
                    key={candidate.id}
                    className="flex items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {candidate.title}
                    </span>
                    <span className="shrink-0 truncate text-muted-foreground">
                      {candidate.matchedRuleClause ?? t.autoCreatedByRule}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The one-line banner the table/board views show while suggestions wait.
 * A banner, not the old inline tray: review lives in the Suggestions view.
 */
export function TaskSuggestionsBanner({
  count,
  onReview,
}: {
  count: number;
  onReview: () => void;
}) {
  const t = useT().tasksPage.guardrails;
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onReview}
      className="flex w-full items-center gap-2 border-b border-border bg-muted/30 px-4 py-2 text-left text-xs text-foreground hover:bg-muted/50"
    >
      <Sparkles className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {t.bannerText.replace("{count}", String(count))}
      </span>
      <span className="shrink-0 font-medium text-primary">{t.bannerReview}</span>
    </button>
  );
}

function reasonLabel(
  candidate: TaskCandidate,
  t: ReturnType<typeof useT>["tasksPage"]["guardrails"],
): string {
  const title = candidate.matchedTaskTitle ?? "";
  switch (candidate.reasonCode) {
    case "duplicate":
      return t.reasonDuplicate.replace("{title}", title);
    case "near_duplicate":
      return t.reasonNearDuplicate.replace("{title}", title);
    case "tombstoned":
      return t.reasonTombstoned;
    case "rule":
      return t.reasonRule;
    case "rule_requires":
      return t.reasonRuleRequires;
    case "not_a_task":
      return t.reasonNotTask;
    case "quality_unverified":
      return t.reasonQualityUnverified;
    case "suggested":
      return t.reasonSuggested;
    case "needs_spec": {
      const missing = candidate.quality?.missing
        .map((fact) => t.missingFacts[fact])
        .join(", ");
      return missing
        ? t.reasonNeedsSpec.replace("{missing}", missing)
        : t.reasonNeedsSpecGeneric;
    }
    default:
      return "";
  }
}
