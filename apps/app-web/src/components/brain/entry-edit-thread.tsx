"use client";

/**
 * Temporary, row-bound conversational editor for one Brain Review entry.
 * Separate from EntryThread: this surface receives exactly one confirmed write
 * capability, while Ask remains mechanically read-only.
 *
 * A presentation of the shared conversation controller (M5 WP-E) over its
 * `brain_edit` session (`review-thread-conversation.ts`): send, the
 * compare-and-set Stop, the Apply/Keep editing confirmation and the re-attach
 * after a dropped stream are the controller's. This surface keeps the apply
 * semantics: the `updateBrainEntry` card reads as the edit itself, and the
 * `brain_entry_updated` receipt refreshes Brain and re-anchors the drawer.
 *
 * Spec: docs/architecture/brain/corrections.md -> "Conversational entry editing".
 * [COMP:app-web/brain-entry-edit-thread]
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Sparkles, Square } from "lucide-react";
import { ChatMarkdown, type Message, type PendingConfirmation } from "@use-brian/chat-ui";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import {
  createBrainEditSession,
  type BrainEditSession,
  type BrainPrimitive,
} from "@/lib/api/brain-inbox";
import { requestBrainRefresh } from "@/lib/brain-events";
import type { ClassifiedTurnFrame } from "@/lib/chat/turn-frames";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { latestNotice, reviewThreadView, useReviewConversation } from "./review-thread-conversation";

const CLIENT_TIMEZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
})();

type Props = {
  workspaceId: string;
  primitive: BrainPrimitive;
  rowId: string;
  onUpdated: (liveRowId: string) => void | Promise<void>;
};

/** The live row id an applied edit returned, when it is this entry's kind. */
export function appliedEditRowId(frame: ClassifiedTurnFrame, primitive: BrainPrimitive): string | null {
  if (frame.event !== "brain_entry_updated") return null;
  return frame.payload.primitive === primitive && typeof frame.payload.liveRowId === "string"
    ? frame.payload.liveRowId
    : null;
}

/** The edit card names the edit itself; other cards keep their own name. */
export function editConfirmationCard(confirmation: PendingConfirmation, heading: string): PendingConfirmation {
  return confirmation.toolName === "updateBrainEntry" ? { ...confirmation, displayName: heading } : confirmation;
}

export function EntryEditThread({
  workspaceId,
  primitive,
  rowId,
  onUpdated,
}: Props) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const review = t.memoriesReview;

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [assistant, setAssistant] = useState<{
    id: string;
    name: string;
  } | null>(null);
  // The request shown while the edit session is being minted.
  const [minting, setMinting] = useState<string | null>(null);
  // Turns of earlier (rotated) sessions: the temporary transcript stays
  // visible so the interaction still reads continuously.
  const [carried, setCarried] = useState<readonly Message[]>([]);
  const [boundSessionId, setBoundSessionId] = useState<string | null>(null);

  const editSessionRef = useRef<BrainEditSession | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const primitiveRef = useRef(primitive);
  primitiveRef.current = primitive;
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;

  const { controller, state, sendBound } = useReviewConversation({
    workspaceId,
    sessionId: boundSessionId,
    kind: "entry-edit-thread",
    // The applied edit's receipt, dispatched once to this presentation.
    onSurfaceEffect: (frame) => {
      const liveRowId = appliedEditRowId(frame, primitiveRef.current);
      if (!liveRowId) return;
      setSuccess(labels.editThreadSuccess);
      requestBrainRefresh(workspaceId);
      void onUpdatedRef.current(liveRowId);
    },
  });
  const view = reviewThreadView(state);
  const busy = view.busy || minting !== null;
  const errorNotice = latestNotice(state, ["error", "stopTurnFailed", "confirmNotAllowed", "reconnectFailed"]);

  // A direct property edit or an approved superseding mutation can replace
  // the live row id. Rotate only the server session, at the next send: a
  // running turn keeps its own session and stream until it ends.
  useEffect(() => {
    const bound = editSessionRef.current?.entryContext;
    if (!bound || (bound.primitive === primitive && bound.rowId === rowId)) {
      return;
    }
    editSessionRef.current = null;
  }, [primitive, rowId]);

  useEffect(() => {
    if (minting !== null && view.busy) setMinting(null);
  }, [minting, view.busy]);

  useEffect(() => {
    const bottom = bottomRef.current;
    if (bottom && typeof bottom.scrollIntoView === "function") {
      bottom.scrollIntoView({ block: "nearest" });
    }
  }, [view.messages.length, view.streamingText, state?.transcript.pendingConfirmations, busy]);

  async function ensureSession(): Promise<BrainEditSession | null> {
    if (editSessionRef.current) return editSessionRef.current;
    const created = await createBrainEditSession(workspaceId, primitive, rowId);
    if ("error" in created) {
      setError(created.error);
      return null;
    }
    editSessionRef.current = created;
    setAssistant({ id: created.assistantId, name: created.assistantName });
    return created;
  }

  async function send(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    setDraft("");
    setError(null);
    setSuccess(null);
    setMinting(text);

    const created = await ensureSession();
    if (!created) {
      setMinting(null);
      setDraft(text);
      return;
    }
    if (created.sessionId !== boundSessionId) {
      // A rotated session: keep the earlier turns on screen.
      const previous = view.messages;
      if (previous.length) setCarried((current) => [...current, ...previous]);
      setBoundSessionId(created.sessionId);
    }
    const result = await sendBound(created.sessionId, {
      text,
      assistantId: created.assistantId,
      bodyExtras: CLIENT_TIMEZONE ? { timezone: CLIENT_TIMEZONE } : {},
      onRejected: () => setDraft((current) => (current.trim() ? current : text)),
    });
    setMinting(null);
    if (result === "busy" || result === "invalid") setDraft((current) => (current.trim() ? current : text));
  }

  async function settle(
    toolCallId: string,
    decision: "approve" | "deny",
    comment?: string,
  ) {
    if (!controller) return;
    const outcome = await controller.respondConfirmation(toolCallId, decision, comment);
    // A refusal keeps the card retryable; the forbidden case shows the
    // controller's `confirmNotAllowed` notice.
    if (outcome === "failed") setError(review.askError);
  }

  const suggestions = [
    labels.editThreadSuggestion1,
    labels.editThreadSuggestion2,
    labels.editThreadSuggestion3,
  ];
  const pending = (state?.transcript.pendingConfirmations ?? []).filter(
    (item) => item.status === "pending" || item.status === "approving",
  );
  const messages = [...carried, ...view.messages];
  const hasTurns = messages.length > 0 || busy;
  const noticeText = errorNotice?.code === "error"
    ? errorNotice.message ?? review.askError
    : errorNotice?.code === "stopTurnFailed"
      ? t.chatApp.stopTurnFailed
      : errorNotice?.code === "confirmNotAllowed"
        ? t.chatApp.confirmNotAllowed
        : errorNotice?.code === "reconnectFailed"
          ? t.chat.turnReconnectFailed
          : null;
  const shownError = error ?? noticeText;

  return (
    <section className="mt-1 flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground/80">
          <Sparkles className="size-3.5" aria-hidden />
          {labels.editThreadHeading}
        </h3>
        {hasTurns ? (
          <span className="text-[11px] text-muted-foreground/60">
            {labels.editThreadEphemeral}
          </span>
        ) : null}
      </div>

      {!hasTurns ? (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => void send(suggestion)}
              disabled={busy}
              className="rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-3" aria-live="polite">
        {messages.map((message) =>
          message.role === "user" ? (
            <div
              key={message.id}
              className="max-w-[85%] self-end rounded-lg bg-muted px-3 py-1.5 text-sm whitespace-pre-wrap break-words"
            >
              {message.text}
            </div>
          ) : (
            <div key={message.id} className="flex gap-2.5">
              <AssistantAvatar
                id={assistant?.id ?? "assistant"}
                name={assistant?.name ?? review.unknownAuthor}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-xs font-medium text-foreground/80">
                  {assistant?.name ?? review.unknownAuthor}
                </div>
                <div className="chat-markdown text-sm leading-relaxed break-words">
                  <ChatMarkdown text={message.text} />
                </div>
              </div>
            </div>
          ),
        )}

        {minting !== null ? (
          <div className="max-w-[85%] self-end rounded-lg bg-muted px-3 py-1.5 text-sm whitespace-pre-wrap break-words">
            {minting}
          </div>
        ) : null}

        {busy && view.streamingText ? (
          <div className="flex gap-2.5">
            <AssistantAvatar
              id={assistant?.id ?? "assistant"}
              name={assistant?.name ?? review.unknownAuthor}
              size="sm"
            />
            <div className="chat-markdown min-w-0 flex-1 text-sm leading-relaxed break-words">
              <ChatMarkdown text={view.streamingText} />
            </div>
          </div>
        ) : busy ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {review.thinking}
          </div>
        ) : null}

        {pending.map((confirmation) => (
          <ChatConfirmationCard
            key={confirmation.toolCallId}
            confirmation={editConfirmationCard(confirmation, labels.editThreadHeading)}
            approveLabel={labels.editThreadApply}
            denyLabel={labels.editThreadKeepEditing}
            approvingLabel={labels.editThreadApplying}
            onApprove={(id) => void settle(id, "approve")}
            onDeny={(id, comment) => void settle(id, "deny", comment)}
          />
        ))}
      </div>

      {success ? (
        <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {success}
        </p>
      ) : null}
      {shownError ? (
        <p className="text-xs text-red-500" role="alert">
          {shownError}
        </p>
      ) : null}
      {latestNotice(state, ["reconnecting"]) ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t.chat.turnReconnecting}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-end gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 transition-[border-color,box-shadow,background-color] focus-within:border-ring focus-within:bg-background [&_:focus-visible]:shadow-none">
          <textarea
            value={draft}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send(draft);
              }
            }}
            disabled={busy}
            placeholder={labels.editThreadPlaceholder}
            className="max-h-40 flex-1 resize-none field-sizing-content bg-transparent text-[16px] md:text-sm outline-none focus-visible:shadow-none placeholder:text-muted-foreground/60 disabled:opacity-60"
          />
          {/* `size-11 sm:size-6` (C 16 / M3): the tap is the touch send path. */}
          {view.busy ? (
            <button
              type="button"
              // The controller's compare-and-set Stop ends the server turn.
              onClick={() => void controller?.stop()}
              disabled={state?.run.stopRequested === true}
              aria-label={labels.threadStop}
              title={labels.threadStop}
              className="mb-0.5 inline-flex size-11 sm:size-6 shrink-0 items-center justify-center rounded-full bg-foreground/80 text-background"
            >
              <Square className="size-2.5" fill="currentColor" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send(draft)}
              disabled={!draft.trim()}
              aria-label={review.send}
              title={review.send}
              className={cn(
                "mb-0.5 inline-flex size-11 sm:size-6 shrink-0 items-center justify-center rounded-full transition-colors",
                draft.trim()
                  ? "bg-action text-action-foreground hover:bg-action/90"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <ArrowUp className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          {labels.editThreadDisclosure}
        </p>
      </div>
      <div ref={bottomRef} aria-hidden />
    </section>
  );
}
