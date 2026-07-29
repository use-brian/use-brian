"use client";

/**
 * Task suggestions tray - the held half of the admission gate.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 *
 * Renders the candidates the gate refused to create outright but would not
 * silently drop either: near-duplicates, and tasks missing a field the
 * workspace requires. Accepting writes the real task; dismissing WITH a reason
 * writes a tombstone so the class stops coming back.
 *
 * HIDDEN AT ZERO. A healthy workspace never sees this strip. That is
 * load-bearing: a permanently-visible tray would become the second task list
 * the guardrail exists to prevent.
 *
 * [COMP:app-web/task-suggestions]
 */

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import {
  acceptTaskCandidate,
  dismissTaskCandidate,
  loadTaskCandidates,
  type TaskCandidate,
} from "@/lib/api/task-guardrails";

type Props = {
  workspaceId: string;
  /** Called after a candidate becomes a real task, so the list can refetch. */
  onAccepted?: () => void;
};

export function TaskSuggestions({ workspaceId, onAccepted }: Props) {
  const t = useT().tasksPage.guardrails;
  const [candidates, setCandidates] = useState<TaskCandidate[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<TaskCandidate | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setCandidates(await loadTaskCandidates(workspaceId));
    } catch {
      // A tray that cannot load is not worth interrupting the task list for -
      // the tasks themselves are the page, this is an accessory.
      setCandidates([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const accept = useCallback(
    async (candidate: TaskCandidate) => {
      setBusyId(candidate.id);
      setError(null);
      try {
        await acceptTaskCandidate(workspaceId, candidate.id);
        setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
        onAccepted?.();
      } catch {
        setError(t.actionFailed);
      } finally {
        setBusyId(null);
      }
    },
    [workspaceId, onAccepted, t.actionFailed],
  );

  const dismiss = useCallback(
    async (candidate: TaskCandidate, withReason: string | undefined) => {
      setBusyId(candidate.id);
      setError(null);
      try {
        await dismissTaskCandidate(workspaceId, candidate.id, withReason);
        setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
      } catch {
        setError(t.actionFailed);
      } finally {
        setBusyId(null);
        setDismissing(null);
        setReason("");
      }
    },
    [workspaceId, t.actionFailed],
  );

  if (candidates.length === 0) return null;

  return (
    <section className="border-b border-border bg-muted/30 px-4 py-3">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-foreground">
          {t.suggestionsTitle}
        </h2>
        <span className="text-xs text-muted-foreground">
          {t.suggestionsSubtitle}
        </span>
      </div>

      {error ? (
        <p className="mb-2 text-xs text-destructive">{error}</p>
      ) : null}

      <ul className="flex flex-col gap-1.5">
        {candidates.map((candidate) => (
          <li
            key={candidate.id}
            className="flex items-start gap-3 rounded-md border border-border/60 bg-background px-3 py-2"
          >
            <AlertCircle
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">
                {candidate.title}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {reasonLabel(candidate, t)}
                {candidate.sourceKind
                  ? ` · ${t.sourceLabel.replace("{source}", candidate.sourceKind)}`
                  : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                disabled={busyId === candidate.id}
                onClick={() => void accept(candidate)}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
              >
                <Check className="size-3.5" aria-hidden />
                {t.accept}
              </button>
              <button
                type="button"
                disabled={busyId === candidate.id}
                onClick={() => {
                  setDismissing(candidate);
                  setReason("");
                }}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                <X className="size-3.5" aria-hidden />
                {t.dismiss}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {dismissing ? (
        <div className="mt-3 rounded-md border border-border bg-background p-3">
          <p className="text-sm font-medium text-foreground">
            {t.dismissTitle}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t.dismissBody}</p>
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
              onClick={() => void dismiss(dismissing, reason.trim())}
              className="rounded bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
            >
              {t.dismissConfirm}
            </button>
            <button
              type="button"
              onClick={() => void dismiss(dismissing, undefined)}
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
      ) : null}
    </section>
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
    default:
      return "";
  }
}
