"use client";

/**
 * Inspection drawer — "Ask about this" surface in the brain inbox.
 *
 * Slide-in right-edge panel containing an ephemeral chat with the
 * workspace's primary assistant (resolved server-side). The chat is
 * read-only — no save/delete tools are wired in this session — so the
 * model can only inspect and explain. Card buttons remain the only
 * mutation path.
 *
 * The first user message is prefixed with a preamble that gives the
 * model the memory context; the bubble shows only the question.
 * Subsequent messages flow normally with the inspection-session id.
 *
 * A presentation of the shared conversation controller (M5 WP-E) over the
 * inspection session minted on open (`review-thread-conversation.ts`):
 * the reply streams through the controller's direct stream (paint batched
 * per frame, reasoning never in the answer), and a dropped stream
 * re-attaches instead of reading as an empty reply.
 *
 * Spec: docs/architecture/brain/corrections.md → "Entry assistant threads on
 * the shared controller (M5)". [COMP:app-web/brain-inspection-drawer]
 */

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import {
  createInspectionSession,
  type BrainPrimitive,
  type InspectionSession,
} from "@/lib/api/brain-inbox";
import {
  latestNotice,
  reviewThreadView,
  stripReviewPreamble,
  useReviewConversation,
} from "@/components/brain/review-thread-conversation";

const CLIENT_TIMEZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
})();

type Props = {
  workspaceId: string;
  primitive: BrainPrimitive;
  rowId: string;
  memorySummary: string;
  memoryDetail: string | null;
  savingAssistantName: string;
  onClose: () => void;
};

/** The model-facing memory context prefixed to the first question. */
export function buildMemoryPreamble(savingAssistantName: string, memorySummary: string, memoryDetail: string | null): string {
  // Threaded to the model as the leading block of the user's first
  // message. Gives the model the memory body, source assistant,
  // and the user's intent ("help me decide").
  const detailLine = memoryDetail ? `\nDetail: ${memoryDetail}` : "";
  return (
    `[Memory review context]\n` +
    `The user is reviewing a memory saved by their assistant "${savingAssistantName}":\n` +
    `Summary: ${memorySummary}${detailLine}\n\n` +
    `Help the user decide whether to confirm, adjust, or delete this memory. ` +
    `You are read-only here — you cannot save, delete, or modify memories yourself; ` +
    `the user will act on the card. Be brief and concrete.\n\n` +
    `[User asks]\n`
  );
}

type ChatTurn = { key: string; role: "user" | "assistant"; text: string };

export function InspectionDrawer({
  workspaceId,
  primitive,
  rowId,
  memorySummary,
  memoryDetail,
  savingAssistantName,
  onClose,
}: Props) {
  const t = useT();
  const [session, setSession] = useState<InspectionSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Turns that settled with no reply text, by their question's id.
  const [settledEmpty, setSettledEmpty] = useState<ReadonlyMap<string, string>>(new Map());

  // Create the inspection session on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await createInspectionSession(workspaceId, primitive, rowId);
      if (cancelled) return;
      if ("error" in result) {
        setSessionError(result.error);
      } else {
        setSession(result);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, primitive, rowId]);

  const { state, sendBound, currentController } = useReviewConversation({
    workspaceId,
    sessionId: session?.sessionId ?? null,
    kind: "inspection-drawer",
  });
  const view = reviewThreadView(state);
  const busy = view.busy;

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function send() {
    if (!session || busy || draft.trim().length === 0) return;
    const userText = draft.trim();
    setDraft("");

    // First turn gets the preamble; subsequent turns send the raw text.
    const isFirst = view.messages.length === 0;
    const messageBody = isFirst
      ? buildMemoryPreamble(savingAssistantName, memorySummary, memoryDetail) + userText
      : userText;
    const result = await sendBound(session.sessionId, {
      text: messageBody,
      assistantId: session.assistantId,
      bodyExtras: CLIENT_TIMEZONE ? { timezone: CLIENT_TIMEZONE } : {},
      onRejected: () => setDraft((current) => (current.trim() ? current : userText)),
    });
    if (result !== "completed" && result !== "failed") return;
    // A settled turn without reply text gets a marker so the user isn't
    // staring at a blank bubble; a failure says why.
    const bound = currentController();
    const snapshot = bound?.getSessionId() === session.sessionId ? bound.getSnapshot() : null;
    const rows = snapshot?.transcript.messages ?? [];
    const last = rows[rows.length - 1];
    const notice = latestNotice(snapshot, ["error"]);
    const failure = `${t.memoriesReview.askError} ${notice?.code === "error" ? notice.message ?? notice.errorCode : ""}`.trim();
    if (last?.role !== "user") {
      // Failed before the server accepted it: the question is back in the
      // composer, and the error line says why.
      if (result === "failed") setSessionError(failure);
      return;
    }
    const text = result === "failed" ? failure : t.memoriesReview.askEmptyResponse;
    setSettledEmpty((current) => new Map(current).set(last.id, text));
  }

  const turns: ChatTurn[] = view.messages.flatMap((message): ChatTurn[] => {
    const turn: ChatTurn = { key: message.id, role: message.role === "user" ? "user" : "assistant", text: message.role === "user" ? stripReviewPreamble(message.text) : message.text };
    const stub = settledEmpty.get(message.id);
    return stub ? [turn, { key: `${message.id}-settled`, role: "assistant", text: stub }] : [turn];
  });
  if (busy && view.streamingText) turns.push({ key: "live", role: "assistant", text: view.streamingText });

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label={t.memoriesReview.askAboutThis}
      onClick={onClose}
    >
      <div
        // `h-dvh` (C 74 / M6): on iOS the layout viewport kept the bottom-
        // anchored composer under the keyboard.
        className="w-full max-w-md h-dvh bg-card border-l border-border flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="text-sm font-semibold truncate">
              {session?.assistantName ?? t.memoriesReview.connecting}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {t.memoriesReview.inspectionMode}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            // Full-screen sheet below `sm`: the close is the way out (C 15 / M3).
            className="inline-flex h-11 w-11 sm:h-7 sm:w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t.memoriesReview.close}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Memory context summary */}
        <div className="px-4 py-3 border-b border-border bg-background/50">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            {t.memoriesReview.reviewingMemory}
          </div>
          <div className="text-xs text-foreground break-words">{memorySummary}</div>
          {memoryDetail && (
            <div className="text-xs text-muted-foreground mt-1 break-words line-clamp-3">
              {memoryDetail}
            </div>
          )}
        </div>

        {/* Conversation */}
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {sessionError && (
            <div className="text-xs text-red-500">{sessionError}</div>
          )}
          {turns.length === 0 && !sessionError && (
            <div className="text-xs text-muted-foreground italic">
              {t.memoriesReview.askPlaceholderBody}
            </div>
          )}
          {turns.map((turn) => (
            <div
              key={turn.key}
              className={
                turn.role === "user"
                  ? "self-end max-w-[85%] text-xs bg-secondary text-secondary-foreground rounded-md px-3 py-2 whitespace-pre-wrap"
                  : "self-start max-w-[95%] text-xs bg-muted text-foreground rounded-md px-3 py-2 whitespace-pre-wrap"
              }
            >
              {turn.text}
            </div>
          ))}
          {/* Only while awaiting the first chunk — once text streams in,
              the bubble itself is the signal that the model is responding. */}
          {busy && !view.streamingText ? (
            <div className="self-start text-xs text-muted-foreground italic">
              {t.memoriesReview.thinking}
            </div>
          ) : null}
          {latestNotice(state, ["reconnecting", "reconnectFailed"]) ? (
            <div className="self-start text-xs text-muted-foreground" role="status">
              {latestNotice(state, ["reconnecting"]) ? t.chat.turnReconnecting : t.chat.turnReconnectFailed}
            </div>
          ) : null}
        </div>

        {/* Composer */}
        <div className="border-t border-border px-4 py-3 flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            // Typeable while the reply streams — `send()` no-ops on busy, so
            // Enter can't double-send; only the session-less state locks it.
            disabled={!session}
            placeholder={t.memoriesReview.askInputPlaceholder}
            rows={3}
            className="text-[16px] md:text-sm px-3 py-2 rounded-md border border-border bg-background resize-y"
          />
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-muted-foreground">
              {t.memoriesReview.inspectionDisclosure}
            </div>
            <button
              type="button"
              onClick={() => void send()}
              disabled={!session || busy || draft.trim().length === 0}
              className="text-xs px-3 py-1.5 rounded-md bg-action text-action-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t.memoriesReview.sending : t.memoriesReview.send}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
