"use client";

/**
 * Inline approval banner for a workflow step (app-web).
 *
 * Ported from `apps/web/src/components/workflow/approval-banner.tsx` (app
 * consolidation §5a). Renders accept / reject buttons + an optional comment.
 * Calls the unified approvals resolve endpoint via `resolveApproval()` (the
 * workflow SDK's `/api/approvals/:id/resolve` path — distinct from the
 * already-ported approvals queue's `/api/approvals/:id/respond`). On success
 * the parent re-fetches the workflow detail to reflect the resolved state.
 *
 * Spec: docs/architecture/features/workflow.md → approval inline.
 * [COMP:app-web/workflow]
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { resolveApproval } from "@/lib/api/workflow";
import { cn } from "@/lib/utils";

type Props = {
  approvalId: string;
  onResolved: () => void;
};

export function ApprovalBanner({ approvalId, onResolved }: Props) {
  const t = useT();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (outcome: "approved" | "rejected") => {
    setBusy(true);
    setError(null);
    const ok = await resolveApproval(approvalId, outcome, comment || undefined);
    setBusy(false);
    if (ok) {
      onResolved();
    } else {
      setError(t.workflowPage.detail.approveError);
    }
  };

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 flex flex-col gap-2">
      <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
        {t.workflowPage.detail.stepStatus.awaitingApproval}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={t.workflowPage.detail.approveComment}
        disabled={busy}
        rows={2}
        className={cn(
          "w-full text-xs px-2 py-1.5 bg-card border border-border rounded",
          "outline-none focus:ring-2 focus:ring-ring",
          "resize-none",
        )}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => act("approved")}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {t.workflowPage.detail.approveAction}
        </button>
        <button
          type="button"
          onClick={() => act("rejected")}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted disabled:opacity-50"
        >
          {t.workflowPage.detail.rejectAction}
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400 ml-auto">{error}</span>}
      </div>
    </div>
  );
}
