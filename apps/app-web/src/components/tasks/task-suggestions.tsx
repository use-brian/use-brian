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
  ChevronDown,
  ChevronRight,
  Inbox,
  ListTodo,
  LoaderCircle,
  Pencil,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  acceptTaskCandidate,
  dismissTaskCandidate,
  loadTaskCandidates,
  type TaskCandidate,
} from "@/lib/api/task-guardrails";
import type { TaskRow } from "@/lib/api/tasks";
import { requestSurfaceChatSeed } from "@/lib/surface-chat-seed";

type Props = {
  workspaceId: string;
  /** Gives the parent the created row for cache insertion and optional editing. */
  onAccepted?: (task: TaskRow, openEditor: boolean) => void;
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

  const correctedTitle = useCallback(
    (candidate: TaskCandidate) =>
      editingId === candidate.id && editTitle.trim().length >= 3
        ? editTitle.trim()
        : undefined,
    [editingId, editTitle],
  );

  const finishAccepted = useCallback(
    (candidate: TaskCandidate, task: TaskRow, openEditor: boolean) => {
      setCandidates((prev) => {
        const next = (prev ?? []).filter((c) => c.id !== candidate.id);
        onCountChange?.(next.length);
        return next;
      });
      setEditingId(null);
      onAccepted?.(task, openEditor);
    },
    [onAccepted, onCountChange],
  );

  const accept = useCallback(
    async (
      candidate: TaskCandidate,
      options: { always?: boolean; openEditor?: boolean } = {},
    ) => {
      setBusyId(candidate.id);
      setError(null);
      try {
        const result = await acceptTaskCandidate(workspaceId, candidate.id, {
          title: correctedTitle(candidate),
          always: options.always,
        });
        finishAccepted(candidate, result.task, !!options.openEditor);
      } catch {
        setError(t.actionFailed);
      } finally {
        setBusyId(null);
      }
    },
    [workspaceId, correctedTitle, finishAccepted, t.actionFailed],
  );

  const addWithInstructions = useCallback(
    async (candidate: TaskCandidate) => {
      const instruction = await promptDialog({
        title: format(t.addWithInstructionsTitle, { title: candidate.title }),
        description: t.addWithInstructionsBody,
        placeholder: t.addWithInstructionsPlaceholder,
        confirmLabel: t.addWithInstructionsConfirm,
        cancelLabel: t.cancel,
        multiline: true,
      });
      if (!instruction) return;

      setBusyId(candidate.id);
      setError(null);
      try {
        const result = await acceptTaskCandidate(workspaceId, candidate.id, {
          title: correctedTitle(candidate),
        });
        finishAccepted(candidate, result.task, false);
        requestSurfaceChatSeed({
          prefill: format(t.addWithInstructionsPrompt, {
            title: result.task.title,
            taskId: result.task.id,
            instruction,
          }),
          autoSend: true,
        });
      } catch {
        setError(t.actionFailed);
      } finally {
        setBusyId(null);
      }
    },
    [workspaceId, correctedTitle, finishAccepted, t],
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
    <div className="min-h-0 flex-1 overflow-auto bg-muted/10">
      <div
        data-testid="task-suggestions-canvas"
        className="flex w-full flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8 xl:px-10"
      >
        <header className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-background px-4 py-4 shadow-sm sm:flex-row sm:items-start sm:justify-between sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-foreground">
                  {t.suggestionsTitle}
                </h2>
                {candidates !== null && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                    {format(t.pendingCount, { count: pending.length })}
                  </span>
                )}
              </div>
              <p className="mt-1 max-w-4xl text-sm leading-relaxed text-muted-foreground">
                {t.suggestionsViewSubtitle}
              </p>
            </div>
          </div>
        </header>

        {error ? (
          <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {candidates === null ? (
          <div className="rounded-2xl border border-border/70 bg-background px-5 py-8 text-sm text-muted-foreground shadow-sm">
            {t.suggestionsLoading}
          </div>
        ) : pending.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-background/70 px-6 py-14 text-center">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-muted">
              <Inbox className="size-5 text-muted-foreground/70" aria-hidden />
            </span>
            <p className="mt-1 text-sm font-medium text-foreground">
              {t.suggestionsEmpty}
            </p>
            <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">
              {t.suggestionsEmptyHint}
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
            {pending.map((candidate) => {
              const expanded = expandedId === candidate.id;
              const editing = editingId === candidate.id;
              const busy = busyId === candidate.id;
              const hasDetails = Boolean(
                candidate.quality?.description || candidate.quality?.evidenceQuote,
              );
              return (
                <li
                  key={candidate.id}
                  className="group rounded-2xl border border-border/75 bg-background p-4 shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-border hover:shadow-md sm:p-5"
                >
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0">
                      {editing ? (
                        <input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          autoFocus
                          className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground outline-none"
                          aria-label={t.editTitleLabel}
                        />
                      ) : (
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                            <ListTodo className="size-3.5" aria-hidden />
                          </span>
                          <h3 className="min-w-0 flex-1 text-[15px] font-medium leading-snug text-foreground">
                            {candidate.title}
                          </h3>
                          <button
                            type="button"
                            aria-label={t.editTitleLabel}
                            title={t.editTitleLabel}
                            onClick={() => {
                              setEditingId(candidate.id);
                              setEditTitle(candidate.title);
                            }}
                            className="inline-flex shrink-0 rounded p-1 text-muted-foreground/60 opacity-70 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                          >
                            <Pencil className="size-3" aria-hidden />
                          </button>
                        </div>
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="rounded-full bg-muted px-2 py-1 font-medium text-foreground/75">
                          {reasonLabel(candidate, t)}
                        </span>
                        {candidate.sourceKind && (
                          <span className="rounded-full border border-border/70 px-2 py-1">
                            {t.sourceLabel.replace("{source}", candidate.sourceKind)}
                          </span>
                        )}
                        {candidate.channelRef && (
                          <span className="max-w-full truncate rounded-full border border-border/70 px-2 py-1 font-mono">
                            {candidate.channelRef}
                          </span>
                        )}
                      </div>

                      {candidate.quality?.description && !expanded && (
                        <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                          {candidate.quality.description}
                        </p>
                      )}

                      {hasDetails && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() =>
                            setExpandedId(expanded ? null : candidate.id)
                          }
                          aria-expanded={expanded}
                          className="mt-2 -ml-1 text-muted-foreground"
                        >
                          <ChevronRight
                            className={cn(
                              "size-3 transition-transform",
                              expanded && "rotate-90",
                            )}
                            aria-hidden
                          />
                          {t.detailsToggle}
                        </Button>
                      )}

                      {expanded && (
                        <div className="mt-2 flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed">
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

                    <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                      <div className="inline-flex shrink-0 rounded-lg shadow-sm">
                        <Button
                          type="button"
                          disabled={busy}
                          onClick={() => void accept(candidate)}
                          className="rounded-r-none"
                        >
                          {busy ? (
                            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Check className="size-3.5" aria-hidden />
                          )}
                          {t.accept}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            disabled={busy}
                            render={
                              <Button
                                type="button"
                                aria-label={t.addOptions}
                                title={t.addOptions}
                                className="rounded-l-none border-l border-action-foreground/20 px-2"
                              >
                                <ChevronDown className="size-3.5" aria-hidden />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end" className="w-72">
                            <DropdownMenuItem
                              className="items-start py-2.5"
                              onClick={() =>
                                void accept(candidate, { openEditor: true })
                              }
                            >
                              <Pencil className="mt-0.5" aria-hidden />
                              <span className="flex min-w-0 flex-col">
                                <span className="font-medium">{t.addAndEdit}</span>
                                <span className="text-xs leading-snug text-muted-foreground">
                                  {t.addAndEditHint}
                                </span>
                              </span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="items-start py-2.5"
                              onClick={() => void addWithInstructions(candidate)}
                            >
                              <WandSparkles className="mt-0.5" aria-hidden />
                              <span className="flex min-w-0 flex-col">
                                <span className="font-medium">
                                  {t.addWithInstructions}
                                </span>
                                <span className="text-xs leading-snug text-muted-foreground">
                                  {t.addWithInstructionsHint}
                                </span>
                              </span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={!candidate.sourceKind && !candidate.channelRef}
                              className="items-start py-2.5"
                              onClick={() =>
                                void accept(candidate, { always: true })
                              }
                            >
                              <SlidersHorizontal className="mt-0.5" aria-hidden />
                              <span className="flex min-w-0 flex-col">
                                <span className="font-medium">
                                  {t.acceptAlways}
                                </span>
                                <span className="text-xs leading-snug text-muted-foreground">
                                  {t.acceptAlwaysHint}
                                </span>
                              </span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setDismissing(candidate);
                          setReason("");
                        }}
                        className="text-muted-foreground"
                      >
                        <X className="size-3.5" aria-hidden />
                        {t.dismiss}
                      </Button>
                    </div>
                  </div>

                  {dismissing?.id === candidate.id && (
                    <div className="mt-4 rounded-xl border border-border bg-muted/30 p-4">
                      <p className="text-sm font-medium text-foreground">
                        {t.dismissTitle}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {t.dismissBody}
                      </p>
                      <textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder={t.dismissPlaceholder}
                        rows={3}
                        className="mt-3 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                      />
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={reason.trim().length < 3}
                          onClick={() => void dismiss(candidate, reason.trim())}
                        >
                          {t.dismissConfirm}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void dismiss(candidate, undefined)}
                        >
                          {t.dismissOnly}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDismissing(null);
                            setReason("");
                          }}
                        >
                          {t.cancel}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {autoAccepted.length > 0 && (
          <section className="rounded-2xl border border-border/70 bg-background px-4 py-3 shadow-sm">
            <button
              type="button"
              onClick={() => setAutoOpen((v) => !v)}
              aria-expanded={autoOpen}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform",
                  autoOpen && "rotate-90",
                )}
                aria-hidden
              />
              {t.autoCreatedTitle.replace("{count}", String(autoAccepted.length))}
            </button>
            {autoOpen && (
              <ul className="mt-2 grid gap-1 lg:grid-cols-2">
                {autoAccepted.map((candidate) => (
                  <li
                    key={candidate.id}
                    className="flex items-baseline justify-between gap-3 rounded-lg px-2 py-2 text-xs hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {candidate.title}
                    </span>
                    <span className="max-w-[50%] shrink-0 truncate text-muted-foreground">
                      {candidate.matchedRuleClause ?? t.autoCreatedByRule}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
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
