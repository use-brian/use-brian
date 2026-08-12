"use client";

/**
 * Temporary, row-bound conversational editor for one Brain Review entry.
 * Separate from EntryThread: this surface receives exactly one confirmed write
 * capability, while Ask remains mechanically read-only.
 *
 * Spec: docs/architecture/brain/corrections.md -> "Conversational entry editing".
 * [COMP:app-web/brain-entry-edit-thread]
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Sparkles, Square } from "lucide-react";
import {
  ChatMarkdown,
  useChatSession,
  useMessageStream,
  type PendingConfirmation,
} from "@use-brian/chat-ui";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import { authFetch } from "@/lib/auth-fetch";
import {
  createBrainEditSession,
  type BrainEditSession,
  type BrainPrimitive,
} from "@/lib/api/brain-inbox";
import { requestBrainRefresh } from "@/lib/brain-events";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type Props = {
  workspaceId: string;
  primitive: BrainPrimitive;
  rowId: string;
  onUpdated: (liveRowId: string) => void | Promise<void>;
};

function payloadOf(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object") return data as Record<string, unknown>;
  try {
    return JSON.parse(String(data)) as Record<string, unknown>;
  } catch {
    return {};
  }
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
  const chat = t.chat;
  const session = useChatSession();
  const stream = useMessageStream();
  const { start: startStream, abort: abortStream } = stream;

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [assistant, setAssistant] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const editSessionRef = useRef<BrainEditSession | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const streamedTextRef = useRef("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => abortStream(), [abortStream]);

  // A direct property edit or an approved superseding mutation can replace
  // the live row id. Rotate only the server session; the local temporary
  // transcript stays visible so the interaction still reads continuously.
  useEffect(() => {
    const bound = editSessionRef.current?.entryContext;
    if (!bound || (bound.primitive === primitive && bound.rowId === rowId)) {
      return;
    }
    editSessionRef.current = null;
    sessionIdRef.current = null;
    session.setSession(null);
    session.clearConfirmations();
  }, [primitive, rowId, session]);

  useEffect(() => {
    const bottom = bottomRef.current;
    if (bottom && typeof bottom.scrollIntoView === "function") {
      bottom.scrollIntoView({ block: "nearest" });
    }
  }, [session.state.messages, session.state.pendingConfirmations, busy]);

  async function ensureSession(): Promise<BrainEditSession | null> {
    if (editSessionRef.current) return editSessionRef.current;
    const created = await createBrainEditSession(workspaceId, primitive, rowId);
    if ("error" in created) {
      setError(created.error);
      return null;
    }
    editSessionRef.current = created;
    sessionIdRef.current = created.sessionId;
    session.setSession(created.sessionId);
    setAssistant({ id: created.assistantId, name: created.assistantName });
    return created;
  }

  async function send(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    setDraft("");
    setError(null);
    setSuccess(null);
    setBusy(true);
    session.appendMessage({
      id: `edit-user-${Date.now()}`,
      role: "user",
      text,
      timestamp: new Date(),
    });
    session.dispatch({ type: "stream/start" });
    streamedTextRef.current = "";

    try {
      const created = await ensureSession();
      if (!created) {
        session.dispatch({ type: "stream/abort" });
        setDraft(text);
        return;
      }
      await startStream({
        url: `${API_URL}/api/chat`,
        authFetch: (input, init) => authFetch(input.toString(), init),
        body: {
          message: text,
          assistantId: created.assistantId,
          workspaceId,
          sessionId: created.sessionId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        onEvent: (event) => {
          const payload = payloadOf(event.data);
          switch (event.event) {
            case "session": {
              if (typeof payload.sessionId === "string") {
                sessionIdRef.current = payload.sessionId;
                session.setSession(payload.sessionId);
              }
              break;
            }
            case "text_delta": {
              if (typeof payload.text === "string" && payload.text) {
                streamedTextRef.current += payload.text;
                session.dispatch({ type: "stream/append", text: payload.text });
              }
              break;
            }
            case "tool_confirmation_required": {
              const toolCallId =
                typeof payload.toolCallId === "string"
                  ? payload.toolCallId
                  : "";
              if (!toolCallId || payload.toolName !== "updateBrainEntry") break;
              const confirmation: PendingConfirmation = {
                toolCallId,
                toolName: "updateBrainEntry",
                displayName: labels.editThreadHeading,
                input:
                  payload.input && typeof payload.input === "object"
                    ? (payload.input as Record<string, unknown>)
                    : {},
                description:
                  typeof payload.description === "string"
                    ? payload.description
                    : undefined,
                displayLines: Array.isArray(payload.displayLines)
                  ? (payload.displayLines as string[])
                  : undefined,
                sessionId: created.sessionId,
                status: "pending",
              };
              session.addConfirmation(confirmation);
              break;
            }
            case "tool_result": {
              const id = typeof payload.id === "string" ? payload.id : "";
              if (id && payload.isError === true) {
                session.updateConfirmation(id, {
                  status: "failed",
                  result:
                    typeof payload.errorMessage === "string"
                      ? payload.errorMessage
                      : review.askError,
                });
              }
              break;
            }
            case "brain_entry_updated": {
              if (
                payload.primitive === primitive &&
                typeof payload.liveRowId === "string"
              ) {
                setSuccess(labels.editThreadSuccess);
                requestBrainRefresh(workspaceId);
                void onUpdated(payload.liveRowId);
              }
              break;
            }
            case "assistant_message_saved": {
              if (streamedTextRef.current) {
                session.dispatch({
                  type: "stream/finalize",
                  finalMessage: {
                    id:
                      typeof payload.id === "string"
                        ? payload.id
                        : `edit-assistant-${Date.now()}`,
                    role: "assistant",
                    text: streamedTextRef.current,
                    timestamp: new Date(),
                  },
                });
                streamedTextRef.current = "";
              }
              break;
            }
            case "error": {
              setError(
                typeof payload.message === "string"
                  ? payload.message
                  : typeof payload.error === "string"
                    ? payload.error
                    : review.askError,
              );
              break;
            }
          }
        },
        onError: (cause) => {
          setError(cause instanceof Error ? cause.message : review.askError);
        },
      });
    } finally {
      if (streamedTextRef.current) {
        session.dispatch({
          type: "stream/finalize",
          finalMessage: {
            id: `edit-assistant-${Date.now()}`,
            role: "assistant",
            text: streamedTextRef.current,
            timestamp: new Date(),
          },
        });
        streamedTextRef.current = "";
      } else {
        session.dispatch({ type: "stream/abort" });
      }
      setBusy(false);
    }
  }

  async function settle(
    toolCallId: string,
    decision: "allow" | "deny",
    comment?: string,
  ) {
    const confirmation = session.state.pendingConfirmations.find(
      (item) => item.toolCallId === toolCallId,
    );
    if (!confirmation) return;
    session.updateConfirmation(toolCallId, {
      status: decision === "allow" ? "approving" : "denied",
    });
    try {
      const response = await authFetch(`${API_URL}/api/chat/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: confirmation.sessionId || sessionIdRef.current,
          toolCallId,
          decision,
          ...(decision === "deny" && comment ? { comment } : {}),
        }),
      });
      session.updateConfirmation(toolCallId, {
        status: response.ok
          ? decision === "allow"
            ? "approved"
            : "denied"
          : "pending",
      });
      if (!response.ok) setError(review.askError);
    } catch {
      session.updateConfirmation(toolCallId, { status: "pending" });
      setError(review.askError);
    }
  }

  const suggestions = [
    labels.editThreadSuggestion1,
    labels.editThreadSuggestion2,
    labels.editThreadSuggestion3,
  ];
  const pending = session.state.pendingConfirmations.filter(
    (item) => item.status === "pending" || item.status === "approving",
  );

  return (
    <section className="mt-1 flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground/80">
          <Sparkles className="size-3.5" aria-hidden />
          {labels.editThreadHeading}
        </h3>
        {session.state.messages.length > 0 ? (
          <span className="text-[11px] text-muted-foreground/60">
            {labels.editThreadEphemeral}
          </span>
        ) : null}
      </div>

      {session.state.messages.length === 0 ? (
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
        {session.state.messages.map((message) =>
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

        {busy && session.state.streamingText ? (
          <div className="flex gap-2.5">
            <AssistantAvatar
              id={assistant?.id ?? "assistant"}
              name={assistant?.name ?? review.unknownAuthor}
              size="sm"
            />
            <div className="chat-markdown min-w-0 flex-1 text-sm leading-relaxed break-words">
              <ChatMarkdown text={session.state.streamingText} />
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
            confirmation={confirmation}
            approveLabel={labels.editThreadApply}
            denyLabel={labels.editThreadKeepEditing}
            approvingLabel={labels.editThreadApplying}
            onApprove={(id) => void settle(id, "allow")}
            onDeny={(id, comment) => void settle(id, "deny", comment)}
          />
        ))}
      </div>

      {success ? (
        <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {success}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-end gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 transition-[border-color,box-shadow,background-color] focus-within:border-ring focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/30">
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
            className="max-h-40 flex-1 resize-none field-sizing-content bg-transparent text-sm outline-none focus-visible:shadow-none placeholder:text-muted-foreground/60 disabled:opacity-60"
          />
          {busy ? (
            <button
              type="button"
              onClick={abortStream}
              aria-label={labels.threadStop}
              title={labels.threadStop}
              className="mb-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/80 text-background"
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
                "mb-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors",
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
