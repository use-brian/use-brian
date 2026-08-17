"use client";

/**
 * Inline answer surface for a suspended askQuestion. Extracted from
 * `floating-chat.tsx` so the Chat operator surface renders the SAME panel in
 * a room transcript (multiplayer chat T11/D8 — any member with read access
 * may answer, attributed; the answer/cancel routes are already reader-gated
 * for shared chats).
 *
 * The question text is already rendered as a normal assistant bubble above
 * (the engine streams it via text_delta before suspending), so this panel is
 * compact: a heading, an answer input, and Send / Cancel. Submit POSTs
 * /api/sessions/:id/answer/:approvalId; Cancel POSTs /cancel after a
 * confirm. See docs/architecture/engine/askquestion-suspend-resume.md.
 */

import { useCallback, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  cancelPendingQuestion,
  submitAnswer,
} from "@/lib/api/pending-questions";
import { useAutoGrowTextarea } from "@/lib/use-auto-grow-textarea";

export type PendingQuestionDict = ReturnType<typeof useT>["chat"]["pendingQuestion"];

export function PendingQuestionPanel({
  sessionId,
  approvalId,
  dict,
  onAnswered,
  onCancelled,
}: {
  sessionId: string;
  approvalId: string;
  dict: PendingQuestionDict;
  onAnswered: () => void;
  onCancelled: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  // Grow the answer box line-by-line as the user types (Shift+Enter newline),
  // capped by `max-h-40`; past that the overflow scrolls.
  useAutoGrowTextarea(answerRef, answer);

  const onSubmit = useCallback(async () => {
    const trimmed = answer.trim();
    if (!trimmed || submitting || cancelling) return;
    setSubmitting(true);
    setError(null);
    const result = await submitAnswer(sessionId, approvalId, trimmed);
    setSubmitting(false);
    if (!result.ok) {
      // 409 + idempotent === already resolved → clear and let the parent
      // poll for the resumed reply.
      if (result.httpStatus === 409 && result.idempotent) {
        onAnswered();
        return;
      }
      setError(result.error ?? dict.resumeError);
      return;
    }
    setAnswer("");
    onAnswered();
  }, [answer, submitting, cancelling, sessionId, approvalId, onAnswered, dict]);

  const onCancel = useCallback(async () => {
    if (cancelling || submitting) return;
    const confirmed = await confirmDialog({
      title: dict.cancel,
      description: dict.cancelConfirm,
      confirmLabel: dict.cancel,
      cancelLabel: dict.cancelConfirmKeep,
      variant: "destructive",
    });
    if (!confirmed) return;
    setCancelling(true);
    setError(null);
    const result = await cancelPendingQuestion(sessionId, approvalId);
    setCancelling(false);
    if (!result.ok) {
      setError(dict.resumeError);
      return;
    }
    onCancelled();
  }, [cancelling, submitting, sessionId, approvalId, onCancelled, dict]);

  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/25">
        <TriangleAlert className="size-3.5" aria-hidden />
      </div>
      <div className="flex-1 min-w-0 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
        <div className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
          {dict.heading}
        </div>
        <textarea
          ref={answerRef}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits; Shift+Enter newline — same as the composer.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onSubmit();
            }
          }}
          placeholder={dict.placeholder}
          rows={2}
          autoFocus
          disabled={submitting || cancelling}
          className={cn(
            "w-full min-h-[3.25rem] max-h-40 resize-none overflow-y-auto rounded-md border border-border bg-background",
            "px-2.5 py-1.5 text-[13px] leading-relaxed outline-none",
            "placeholder:text-muted-foreground",
            "disabled:opacity-60",
          )}
        />
        {error ? (
          <div className="text-xs text-destructive">{error}</div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => void onCancel()}
            disabled={submitting || cancelling}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px] font-medium text-muted-foreground",
              "transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {cancelling ? dict.cancelling : dict.cancel}
          </button>
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={submitting || cancelling || answer.trim().length === 0}
            className={cn(
              "rounded-md bg-action px-3 py-1 text-[12px] font-medium text-action-foreground",
              "transition-colors hover:bg-action/90 disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {submitting ? dict.submitting : dict.submit}
          </button>
        </div>
      </div>
    </div>
  );
}
