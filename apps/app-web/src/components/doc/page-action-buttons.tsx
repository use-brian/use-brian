"use client";

/**
 * Page-header action buttons (mig 321) — the human-approval gesture of the
 * page-actions feature. Renders every enabled binding that resolves for this
 * page (page-scoped + blueprint-scoped); a click confirms via `confirmDialog`
 * (with per-kind cost framing — a goal button starts credit-spending
 * autonomous work) and then invokes the action server-side. A workflow
 * invoke runs INLINE server-side and the resulting run appears in the
 * adjacent `PageWorkflowRuns` chip (`requestWorkflowRefresh` nudges it).
 *
 * Chrome, never a doc-model block: post-paint fetch, renders nothing when no
 * binding resolves, and a fetch failure hides the strip rather than erroring
 * the page.
 *
 * [COMP:app-web/page-action-buttons]
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, Target } from "lucide-react";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT, format } from "@/lib/i18n/client";
import { requestWorkflowRefresh } from "@/lib/workflow-events";
import { cn } from "@/lib/utils";
import {
  invokePageAction,
  listPageActions,
  type PageActionRow,
} from "@/lib/api/page-actions";

type Feedback = { actionId: string; tone: "ok" | "error"; text: string };

export function PageActionButtons({
  pageId,
  workspaceId,
}: {
  pageId: string;
  workspaceId: string;
}) {
  const dict = useT();
  const t = dict.docPage.pageActions;
  const [actions, setActions] = useState<PageActionRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const load = useCallback(async () => {
    try {
      setActions(await listPageActions(pageId));
    } catch {
      // Best-effort chrome — leave the strip hidden on fetch failure.
    }
  }, [pageId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Transient result pill; clears itself.
  useEffect(() => {
    if (!feedback) return;
    const tid = window.setTimeout(() => setFeedback(null), 6000);
    return () => window.clearTimeout(tid);
  }, [feedback]);

  const onClick = async (action: PageActionRow) => {
    if (busyId) return;
    const framing =
      action.action.kind === "goal" ? t.confirmGoal : t.confirmWorkflow;
    const confirmed = await confirmDialog({
      title: format(t.confirmTitle, { label: action.label }),
      description: action.confirmCopy ? `${framing}\n\n${action.confirmCopy}` : framing,
      confirmLabel: t.confirmRun,
      cancelLabel: t.cancel,
    });
    if (!confirmed) return;

    setBusyId(action.id);
    setFeedback(null);
    const outcome = await invokePageAction(pageId, action.id);
    setBusyId(null);

    if (!outcome.ok) {
      setFeedback({ actionId: action.id, tone: "error", text: outcome.error || t.failed });
      return;
    }
    if (outcome.result.kind === "goal") {
      setFeedback({ actionId: action.id, tone: "ok", text: t.goalStarted });
      return;
    }
    // Workflow run — surface the terminal state; the runs chip carries the
    // detail link (nudge it to re-fetch).
    requestWorkflowRefresh(workspaceId);
    if (outcome.result.status === "failed") {
      setFeedback({
        actionId: action.id,
        tone: "error",
        text: outcome.result.error?.message || t.failed,
      });
    } else {
      setFeedback({ actionId: action.id, tone: "ok", text: t.done });
    }
  };

  if (actions.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={busyId !== null}
          onClick={() => void onClick(action)}
          title={action.confirmCopy ?? action.label}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm font-medium",
            "text-foreground transition-colors hover:bg-muted disabled:opacity-60",
          )}
        >
          {busyId === action.id ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : action.icon ? (
            <span aria-hidden>{action.icon}</span>
          ) : action.action.kind === "goal" ? (
            <Target className="size-3.5" aria-hidden />
          ) : (
            <Play className="size-3.5" aria-hidden />
          )}
          <span className="max-w-32 truncate">{action.label}</span>
        </button>
      ))}
      {feedback && (
        <span
          className={cn(
            "ml-1 max-w-56 truncate rounded px-1.5 py-0.5 text-xs font-medium",
            feedback.tone === "ok"
              ? "bg-green-500/10 text-green-700 dark:text-green-400"
              : "bg-red-500/10 text-red-700 dark:text-red-400",
          )}
          title={feedback.text}
        >
          {feedback.text}
        </span>
      )}
    </div>
  );
}
