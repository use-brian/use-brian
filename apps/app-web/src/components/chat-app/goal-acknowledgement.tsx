"use client";

/**
 * Pinned composer feedback for a goal that crossed the durable arming
 * boundary. The receipt is session-scoped so it cannot leak into another
 * chat when the host changes conversations.
 *
 * [COMP:app-web/goal-acknowledgement]
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, LoaderCircle, Target, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { GoalExecutionActivity } from "@/components/chat-app/goal-execution-activity";

export type GoalAcceptedNotice = {
  goalId: string;
  outcome: string;
  sessionId: string;
};

export type GoalAcknowledgementLabels = {
  accepted: string;
  executing: string;
  done: string;
  blocked: string;
  abandoned: string;
  open: string;
  dismiss: string;
};

export function goalAcceptedNoticeFromPayload(
  payload: Record<string, unknown>,
): GoalAcceptedNotice | null {
  const goalId = typeof payload.goalId === "string" ? payload.goalId.trim() : "";
  const outcome = typeof payload.outcome === "string" ? payload.outcome.trim() : "";
  const sessionId =
    typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  if (!goalId || !outcome || !sessionId) return null;
  return { goalId, outcome, sessionId };
}

export function GoalAcknowledgement({
  notice,
  workspaceId,
  labels,
  onDismiss,
  followActivity = true,
  className,
}: {
  notice: GoalAcceptedNotice;
  workspaceId: string;
  labels: GoalAcknowledgementLabels;
  onDismiss: () => void;
  followActivity?: boolean;
  className?: string;
}) {
  const [executionStatus, setExecutionStatus] = useState<string | null>(null);
  useEffect(() => setExecutionStatus(null), [notice.goalId]);
  const statusLabel = executionStatus === "done"
    ? labels.done
    : executionStatus === "blocked"
      ? labels.blocked
      : executionStatus === "abandoned"
        ? labels.abandoned
        : labels.executing;
  const executing = executionStatus !== "done"
    && executionStatus !== "blocked"
    && executionStatus !== "abandoned";

  return (
    <section
      role="status"
      data-testid="goal-acknowledgement"
      className={cn(
        "relative overflow-hidden rounded-xl border border-primary/25 bg-primary/[0.055] px-3 py-2.5 shadow-sm",
        "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Target className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 pr-6">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
              {labels.accepted}
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              {executing ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : null}
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs font-medium leading-relaxed text-foreground">
            {notice.outcome}
          </p>
          <GoalExecutionActivity
            goalId={notice.goalId}
            enabled={followActivity}
            onStatusChange={setExecutionStatus}
            className="mt-2 border-t border-primary/10 pt-1.5"
          />
          <Link
            href={`/w/${encodeURIComponent(workspaceId)}/goals/${encodeURIComponent(notice.goalId)}`}
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            {labels.open}
            <ArrowUpRight className="size-3" aria-hidden />
          </Link>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={labels.dismiss}
          title={labels.dismiss}
          className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    </section>
  );
}
