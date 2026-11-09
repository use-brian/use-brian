"use client";

/** Reuse tool-request presentation, never its execution/resume authority. */
import { useEffect, useId, useRef, useState } from "react";
import { QuestionAnswerForm } from "./question-answer-form";
import { ChatConfirmationCard } from "./chat-confirmation-card";
import { answerExternalQuestion, respondByKind } from "@/lib/api/approvals";
import type { ExternalActionConfirmation as Request } from "@/lib/api/pending-questions";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
import { useT } from "@/lib/i18n/client";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

export function ExternalActionConfirmation({ workspaceId, request, onResolved }: {
  workspaceId: string;
  request: Request;
  onResolved?: () => void;
}) {
  const dictionary = useT();
  const t = dictionary.chatApp.approvalReview;
  const question = request.method === "question";
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const hasOptions = !!request.options?.length;
  // Base UI needs the value-to-label mapping even after the popup unmounts.
  const choiceItems = (request.options ?? []).map((label, index) => ({ value: String(index), label }));
  if (request.allowCustom === true) choiceItems.push({ value: "custom", label: t.customAnswer });
  const custom = !hasOptions || choice === "custom";
  const answer = custom ? draft : choice === null ? "" : request.options?.[Number(choice)] ?? "";
  const validAnswer = answer.length >= 1 && answer.length <= 32768 && answer.trim().length > 0;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"approved" | "rejected" | "answered" | "changed" | null>(null);
  const [error, setError] = useState(false);
  const expiry = Date.parse(request.expiresAt);
  const [expired, setExpired] = useState(!Number.isFinite(expiry) || expiry <= Date.now());
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const remaining = expiry - Date.now();
    setExpired(!Number.isFinite(remaining) || remaining <= 0);
    const timer = Number.isFinite(remaining) && remaining > 0
      ? setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647)) : undefined;
    return () => { mounted.current = false; clearTimeout(timer); };
  }, [expiry]);

  const decide = async (decision: "approved" | "rejected" | "answered") => {
    if ((decision === "answered" && !validAnswer) || locked.current || result || !Number.isFinite(expiry) || expiry <= Date.now()) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    try {
      const response = decision === "answered"
        ? await answerExternalQuestion(request.approvalId, answer)
        : await respondByKind({ id: request.approvalId, kind: "external_action" }, decision);
      if (!mounted.current) return;
      if (response.ok) {
        setResult(decision);
        onResolved?.();
      } else if ("status" in response && [403, 404, 409, 410].includes(response.status ?? 0)) {
        // A competing decision/revocation is not this person's successful choice.
        setResult("changed");
        onResolved?.();
      } else {
        setError(true);
      }
      requestApprovalsRefresh(workspaceId);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (result) return <p role="status" className="text-xs text-muted-foreground">{result === "approved" ? t.allowed : result === "rejected" ? t.denied : result === "answered" ? t.answered : t.changed}</p>;
  return (
    <div data-external-confirmation={request.approvalId}>
      <ChatConfirmationCard
        confirmation={{
          toolCallId: `external:${request.approvalId}`,
          approvalId: request.approvalId,
          toolName: "external_action",
          displayName: request.title,
          description: request.message,
          displayLines: request.options,
          input: {},
          sessionId: "",
          allowPersistentApproval: false,
          status: busy ? "approving" : "pending",
        }}
        approveLabel={request.options?.[0] ?? t.allow}
        denyLabel={request.options?.[1] ?? t.deny}
        approvingLabel={t.allowing}
        disabled={expired}
        allowComment={false}
        showInput={false}
        actions={question ? (
          <QuestionAnswerForm
            dict={dictionary.chat.pendingQuestion} ariaLabel={request.title} value={draft} onChange={setDraft}
            onSubmit={() => void decide("answered")} canSubmit={validAnswer}
            submitting={busy} disabled={expired} showInput={custom} answerLabel={t.yourAnswer}
            selectionControls={hasOptions ? (
              <div className="space-y-1">
                <label id={`${inputId}-choice`}>{t.chooseAnswer}</label>
                <Select items={choiceItems} value={choice} onValueChange={setChoice} disabled={busy || expired}>
                  <SelectTrigger aria-labelledby={`${inputId}-choice`} className="min-h-11 w-full text-base whitespace-pre-wrap break-words [&_[data-slot=select-value]]:line-clamp-none">
                    <SelectValue placeholder={t.chooseAnswer} />
                  </SelectTrigger>
                  <SelectContent>
                    {choiceItems.map(item => <SelectItem key={item.value} value={item.value} className="min-h-11 text-base [&_span]:whitespace-pre-wrap [&_span]:break-words">{item.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : undefined}
          />
        ) : undefined}
        onApprove={() => void decide("approved")}
        onDeny={() => void decide("rejected")}
      />
      {expired && <p role="status" className="text-xs text-muted-foreground">{t.expired}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{question ? t.answerFailed : t.decisionFailed}</p>}
    </div>
  );
}
