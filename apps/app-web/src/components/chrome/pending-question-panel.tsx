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

import { useCallback, useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { ConnectorAuthorizationCard } from "./connector-authorization-card";
import type { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  cancelPendingQuestion,
  fetchPendingQuestion,
  submitAnswer,
  type PendingQuestionAction,
} from "@/lib/api/pending-questions";
import { QuestionAnswerForm } from "./question-answer-form";

export type PendingQuestionDict = ReturnType<typeof useT>["chat"]["pendingQuestion"];

export function PendingQuestionPanel({
  sessionId,
  approvalId,
  dict,
  onAnswered,
  onCancelled,
  action: initialAction,
}: {
  sessionId: string;
  approvalId: string;
  dict: PendingQuestionDict;
  onAnswered: () => void;
  onCancelled: () => void;
  action?: PendingQuestionAction | null;
}) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<PendingQuestionAction | null>(initialAction ?? null);
  const [actionResolved, setActionResolved] = useState(initialAction !== undefined);
  useEffect(() => {
    setAction(initialAction ?? null);
    setActionResolved(initialAction !== undefined);
    if (initialAction !== undefined) return;
    let cancelled = false;
    void fetchPendingQuestion(sessionId)
      .then((pending) => {
        if (!cancelled && pending?.approvalId === approvalId) setAction(pending.action);
      })
      .catch(() => { /* A later pending-input refresh can recover this action. */ })
      .finally(() => {
        if (!cancelled) setActionResolved(true);
      });
    return () => { cancelled = true; };
  }, [approvalId, initialAction, sessionId]);

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

  if (actionResolved && action) return <ConnectorAuthorizationCard
    key={`${sessionId}:${approvalId}:${action.provider}`}
    action={action} sessionId={sessionId} approvalId={approvalId} dict={dict}
    cancelling={cancelling} error={error} onAnswered={onAnswered} onCancel={() => void onCancel()}
  />;

  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/25">
        <TriangleAlert className="size-3.5" aria-hidden />
      </div>
      <div className="flex-1 min-w-0 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
        <QuestionAnswerForm
          dict={dict} value={answer} onChange={setAnswer} onSubmit={() => void onSubmit()}
          canSubmit={answer.trim().length > 0} submitting={submitting} disabled={cancelling}
          autoFocus ready={actionResolved} error={error}
          cancel={{ label: cancelling ? dict.cancelling : dict.cancel, onClick: () => void onCancel() }}
        />
      </div>
    </div>
  );
}
