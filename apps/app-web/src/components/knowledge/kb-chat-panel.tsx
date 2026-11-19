"use client";

/**
 * Ask & update KB — the embedded chat panel on the focused knowledge source
 * (Studio → Knowledge master-detail, plan D4).
 *
 * A presentation of the shared conversation controller (M5 WP-E) scoped to
 * the focused source: every turn carries `kbSourceId`, which the chat route
 * injects as PRIVATE runtime context (the provenance split — see
 * knowledge-base.md → "Ask & update chat"). Runs as the workspace primary
 * assistant; session resume rides a sticky `kb-scope:<sourceId>` channel id
 * (the tuning-chat pattern), and the controller seeds the resumed transcript.
 * Send, the compare-and-set Stop, the re-attach after a dropped stream and the
 * approvals are the controller's; a confirmation pending at reload is restored.
 *
 * The point of hosting chat HERE is the write loop: KB writes are per-edit
 * approved, so `tool_confirmation_required` renders the shared
 * `ChatConfirmationCard` inline — including the unified-diff preview the
 * server computes for `updateKnowledgeEntry` — and Approve/Deny goes through
 * the controller's `respondConfirmation` exactly like the floating dock.
 *
 * [COMP:app-web/kb-chat-panel]
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChatMarkdown, type Message } from "@use-brian/chat-ui";
import { authFetch } from "@/lib/auth-fetch";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
import { extractMessageText, type DocSessionMessage } from "@/lib/api/sessions";
import type { ConversationController, ConversationState, PresentationCapabilities } from "@/lib/chat/conversation-controller";
import { provisionalConversationKey } from "@/lib/chat/conversation-registry";
import { useConversation } from "@/lib/chat/use-conversation";
import { listWorkspaceAssistants } from "@/lib/api/views";
import { pickPrimaryAssistant } from "@/lib/primary-assistant";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { ArrowUp, Square } from "lucide-react";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type KbChatScope =
  | { kind: "source"; sourceId: string }
  | { kind: "manual" };

function scopeChannelId(scope: KbChatScope): string {
  return scope.kind === "source" ? `kb-scope:${scope.sourceId}` : "kb-scope:manual";
}

function scopeKbSourceId(scope: KbChatScope): string {
  return scope.kind === "source" ? scope.sourceId : "manual";
}

/** Authorized history as text turns (the panel renders no tool receipts). */
export function mapKbHistoryRows(rows: DocSessionMessage[]): Message[] {
  return rows.flatMap((row): Message[] => {
    if (row.role !== "user" && row.role !== "assistant") return [];
    const text = extractMessageText(row.content);
    return text.trim() ? [{ id: row.id, role: row.role, text, timestamp: new Date(row.timestamp) }] : [];
  });
}

/** The inline line a notice shows, or null. Server text is shown for untranslated errors. */
export function kbNoticeText(
  state: ConversationState | null,
  copy: { streamError: string; stopTurnFailed: string; confirmNotAllowed: string; reconnecting: string; reconnectFailed: string },
): { text: string; tone: "error" | "status" } | null {
  if (!state) return null;
  for (let index = state.notices.length - 1; index >= 0; index--) {
    const notice = state.notices[index]!;
    switch (notice.code) {
      case "error": return { text: notice.message ?? copy.streamError, tone: "error" };
      case "stopTurnFailed": return { text: copy.stopTurnFailed, tone: "error" };
      case "confirmNotAllowed": return { text: copy.confirmNotAllowed, tone: "error" };
      case "reconnectFailed": return { text: copy.reconnectFailed, tone: "error" };
      case "reconnecting": return { text: copy.reconnecting, tone: "status" };
      default: break;
    }
  }
  return null;
}

export function KbChatPanel({
  workspaceId,
  scope,
}: {
  workspaceId: string;
  scope: KbChatScope;
}) {
  const t = useT();
  const copy = t.studioPage.knowledgePage.chat;
  const chatCopy = t.chat;

  const [input, setInput] = useState("");
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(true);
  // The sticky per-source session found by channel; null before the first turn.
  const [resumed, setResumed] = useState<{ channelId: string; sessionId: string | null } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const channelId = scopeChannelId(scope);
  const kbSourceId = scopeKbSourceId(scope);

  // Resolve the workspace primary + find the sticky per-source session.
  // Keyed on the scope so switching rail rows swaps the whole thread.
  useEffect(() => {
    let cancelled = false;
    setResuming(true);
    setResumed(null);
    (async () => {
      let sessionId: string | null = null;
      try {
        const assistants = await listWorkspaceAssistants(workspaceId);
        const primary = pickPrimaryAssistant(assistants);
        if (cancelled) return;
        if (!primary) return;
        setAssistantId(primary.id);
        const res = await authFetch(
          `${API_URL}/api/sessions/by-channel?assistantId=${encodeURIComponent(primary.id)}&channelId=${encodeURIComponent(channelId)}`,
        );
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { id?: string };
          if (body.id) sessionId = body.id;
        }
      } catch {
        /* resume is best-effort — a miss just starts fresh */
      } finally {
        if (!cancelled) {
          setResumed({ channelId, sessionId });
          setResuming(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, channelId]);

  // The controller entry: the resumed session, else a provisional entry for
  // this scope that a first turn's `session` frame adopts.
  const clientId = useId();
  const presentationId = useId();
  const heldRef = useRef<{ channelId: string; controller: ConversationController | null }>({ channelId, controller: null });
  if (heldRef.current.channelId !== channelId) heldRef.current = { channelId, controller: null };
  const held = heldRef.current.controller;
  const adoptedSessionId = held && !held.isDisposed() ? held.getSessionId() : null;
  const resumedSessionId = resumed?.channelId === channelId ? resumed.sessionId : null;
  const capabilities = useMemo<PresentationCapabilities>(
    () => ({ profile: "dock", mapHistoryRows: mapKbHistoryRows }),
    [],
  );
  const { controller, value: state } = useConversation(
    {
      workspaceId,
      sessionId: resumedSessionId ?? adoptedSessionId,
      provisionalKey: provisionalConversationKey("kb", `${channelId}:${clientId}`),
      presentationId,
      capabilities,
    },
    (snapshot) => snapshot,
  );
  heldRef.current.controller = controller;

  const transcript = state?.transcript;
  const messages = transcript?.messages ?? [];
  const direct = transcript?.isStreaming === true;
  const mirrored = !direct && state?.mirror.active === true;
  const isStreaming = direct || mirrored;
  const streamingText = direct ? transcript!.streamingText : mirrored ? state!.mirror.text : "";
  const pending = (transcript?.pendingConfirmations ?? []).filter(
    (c) => c.status === "pending" || c.status === "approving",
  );
  const notice = kbNoticeText(state, {
    streamError: copy.streamError,
    stopTurnFailed: t.chatApp.stopTurnFailed,
    confirmNotAllowed: t.chatApp.confirmNotAllowed,
    reconnecting: chatCopy.turnReconnecting,
    reconnectFailed: chatCopy.turnReconnectFailed,
  });

  // Keep the thread pinned to the bottom while streaming.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, transcript?.pendingConfirmations]);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !assistantId || !controller) return;
      const before = controller.getSnapshot().identity.generation;
      void controller.send({
        presentationId,
        text: trimmed,
        assistantId,
        bodyExtras: { channelId, kbSourceId },
        // Failed before the server accepted it: the text returns; nothing is resent.
        onRejected: () => setInput((current) => (current.trim() ? current : trimmed)),
      });
      // A refused start (busy, invalid) leaves the run generation unchanged.
      if (controller.getSnapshot().identity.generation !== before) setInput("");
    },
    [assistantId, channelId, controller, kbSourceId, presentationId],
  );

  const handleConfirmation = useCallback(
    async (toolCallId: string, action: "approve" | "deny", comment?: string) => {
      if (!controller) return;
      const outcome = await controller.respondConfirmation(toolCallId, action, comment);
      if (outcome === "resolved") requestApprovalsRefresh(workspaceId);
    },
    [controller, workspaceId],
  );

  const onSend = useCallback(() => {
    if (isStreaming) return;
    sendMessage(input);
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex h-[26rem] max-h-[60dvh] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {resuming ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {copy.loading}
          </div>
        ) : messages.length === 0 && !isStreaming ? (
          <div className="py-8 text-center text-xs leading-relaxed text-muted-foreground">
            {copy.empty}
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "max-w-[85%] rounded-xl px-3 py-2 text-[13px] leading-relaxed",
                m.role === "user"
                  ? "self-end bg-primary/10 text-foreground"
                  : "self-start bg-muted/60 text-foreground",
              )}
            >
              <ChatMarkdown text={m.text} />
            </div>
          ))}

          {isStreaming && streamingText && (
            <div className="max-w-[85%] self-start rounded-xl bg-muted/60 px-3 py-2 text-[13px] leading-relaxed">
              <ChatMarkdown text={streamingText} />
            </div>
          )}
          {isStreaming && !streamingText && (
            <div className="self-start px-1 text-xs text-muted-foreground animate-pulse">
              {copy.thinking}
            </div>
          )}

          {pending.map((conf) => (
            <ChatConfirmationCard
              key={conf.toolCallId}
              confirmation={conf}
              approveLabel={chatCopy.confirmationApprove}
              denyLabel={chatCopy.confirmationDeny}
              approvingLabel={chatCopy.confirmationApproving}
              onApprove={(id) => void handleConfirmation(id, "approve")}
              onDeny={(id, comment) => void handleConfirmation(id, "deny", comment)}
            />
          ))}
        </div>

        {notice && (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={cn(
              "mt-3 rounded-lg px-3 py-2 text-[12px]",
              notice.tone === "error" ? "bg-destructive/10 text-destructive" : "bg-muted/60 text-muted-foreground",
            )}
          >
            {notice.text}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border/60 p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder={assistantId ? copy.placeholder : copy.noAssistant}
            disabled={!assistantId || resuming || !controller}
            className={cn(
              "min-h-[2.25rem] max-h-32 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-[16px] md:text-[13px]",
              "placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50",
            )}
          />
          {isStreaming ? (
            <button
              type="button"
              // One Stop entry point: the controller's compare-and-set Stop.
              onClick={() => void controller?.stop()}
              disabled={state?.run.stopRequested === true}
              aria-label={copy.stop}
              title={copy.stop}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Square className="size-3.5" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!input.trim() || !assistantId || resuming}
              aria-label={copy.send}
              title={copy.send}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-action text-action-foreground transition-colors hover:bg-action/90 disabled:opacity-40"
            >
              <ArrowUp className="size-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
