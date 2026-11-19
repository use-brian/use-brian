"use client";

/**
 * Inline answer surface for a suspended askQuestion. Extracted from
 * `floating-chat.tsx` so the Chat operator surface renders the SAME panel in
 * a room transcript (multiplayer chat T11/D8 — any member with read access
 * may answer, attributed; the answer/cancel routes are already reader-gated
 * for shared chats).
 *
 * The question text is already rendered as a normal assistant bubble above
 * (the engine streams it via text_delta before suspending, and the history
 * read keeps a delivered question round's text and payload, M5Q-13), so this
 * panel is compact and names the question only as the form's accessible name: a heading, the question's options as a single choice when it
 * offers them (the project `Select`, with a "write another answer" choice when
 * `allowCustom` is not false), the answer input, and Send / Cancel. Options
 * and `allowCustom` come from the pending read (the question payload contract,
 * so a restored card renders the same panel). Submit POSTs
 * /api/sessions/:id/answer/:approvalId; Cancel POSTs /cancel after a
 * confirm. See docs/architecture/engine/askquestion-suspend-resume.md.
 */

import { useCallback, useEffect, useId, useState } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type PendingQuestionDict = ReturnType<typeof useT>["chat"]["pendingQuestion"];

export function PendingQuestionPanel({
  sessionId,
  approvalId,
  dict,
  onAnswered,
  onCancelled,
  action: initialAction,
  options: initialOptions,
  allowCustom: initialAllowCustom,
}: {
  sessionId: string;
  approvalId: string;
  dict: PendingQuestionDict;
  onAnswered: () => void;
  onCancelled: () => void;
  action?: PendingQuestionAction | null;
  /** The question's single-choice options, when the host already holds the payload. */
  options?: string[];
  allowCustom?: boolean;
}) {
  const inputId = useId();
  const [answer, setAnswer] = useState("");
  const [payload, setPayload] = useState<{ question?: string; options?: string[]; allowCustom?: boolean }>({ options: initialOptions, allowCustom: initialAllowCustom });
  const [choice, setChoice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<PendingQuestionAction | null>(initialAction ?? null);
  const [actionResolved, setActionResolved] = useState(initialAction !== undefined);
  useEffect(() => {
    setAction(initialAction ?? null);
    setActionResolved(initialAction !== undefined);
    setPayload({ options: initialOptions, allowCustom: initialAllowCustom });
    setChoice(null);
    if (initialAction !== undefined) return;
    let cancelled = false;
    void fetchPendingQuestion(sessionId)
      .then((pending) => {
        if (cancelled || pending?.approvalId !== approvalId) return;
        setAction(pending.action);
        setPayload({ question: pending.question ?? undefined, options: pending.options, allowCustom: pending.allowCustom });
      })
      .catch(() => { /* A later pending-input refresh can recover this action. */ })
      .finally(() => {
        if (!cancelled) setActionResolved(true);
      });
    return () => { cancelled = true; };
    // The option list is a payload value, not a render dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalId, initialAction, sessionId]);

  const options = payload.options && payload.options.length > 0 ? payload.options : null;
  // `allowCustom` defaults to true in the question payload contract.
  const allowCustom = payload.allowCustom !== false;
  // Base UI needs the value-to-label mapping even after the popup unmounts.
  const choiceItems = options
    ? [...options.map((label, index) => ({ value: String(index), label })), ...(allowCustom ? [{ value: "custom", label: dict.customAnswer }] : [])]
    : [];
  const custom = !options || choice === "custom";
  const response = custom ? answer : choice === null ? "" : options[Number(choice)] ?? "";

  const onSubmit = useCallback(async () => {
    // A chosen option is sent as the answer text through the same route.
    const trimmed = response.trim();
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
    setChoice(null);
    onAnswered();
  }, [response, submitting, cancelling, sessionId, approvalId, onAnswered, dict]);

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
          canSubmit={response.trim().length > 0} submitting={submitting} disabled={cancelling}
          autoFocus ready={actionResolved} error={error} showInput={custom} ariaLabel={payload.question}
          selectionControls={options ? (
            <div className="space-y-1">
              <label id={`${inputId}-choice`} className="text-xs text-muted-foreground">{dict.chooseAnswer}</label>
              <Select items={choiceItems} value={choice} onValueChange={(value) => setChoice(value as string | null)} disabled={submitting || cancelling}>
                <SelectTrigger aria-labelledby={`${inputId}-choice`} className="min-h-8 max-sm:min-h-11 w-full text-base whitespace-pre-wrap break-words [&_[data-slot=select-value]]:line-clamp-none">
                  <SelectValue placeholder={dict.chooseAnswer} />
                </SelectTrigger>
                <SelectContent>
                  {choiceItems.map((item) => <SelectItem key={item.value} value={item.value} className="min-h-8 max-sm:min-h-11 text-base [&_span]:whitespace-pre-wrap [&_span]:break-words">{item.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : undefined}
          cancel={{ label: cancelling ? dict.cancelling : dict.cancel, onClick: () => void onCancel() }}
        />
      </div>
    </div>
  );
}
