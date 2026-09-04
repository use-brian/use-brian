"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Ask & update KB — the embedded chat panel on the focused knowledge source
 * (Studio → Knowledge master-detail, plan D4).
 *
 * A lean web chat host over `@use-brian/chat-ui` + `POST /api/chat` SSE,
 * scoped to the focused source: every turn carries `kbSourceId`, which the
 * chat route injects as PRIVATE runtime context (the provenance split — see
 * knowledge-base.md → "Ask & update chat"). Runs as the workspace primary
 * assistant; session resume rides a sticky `kb-scope:<sourceId>` channel id
 * (the tuning-chat pattern).
 *
 * The point of hosting chat HERE is the write loop: KB writes are per-edit
 * approved, so `tool_confirmation_required` renders the shared
 * `ChatConfirmationCard` inline — including the unified-diff preview the
 * server computes for `updateKnowledgeEntry` — and Approve/Deny POSTs
 * `/api/chat/confirm` exactly like the floating dock.
 *
 * [COMP:app-web/kb-chat-panel]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChatMarkdown,
  useChatSession,
  useMessageStream,
  type Message,
  type PendingConfirmation,
} from "@use-brian/chat-ui";
import { authFetch } from "@/lib/auth-fetch";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
import {
  fetchSessionMessages,
  extractMessageText,
  stopTurn,
} from "@/lib/api/sessions";
import { listWorkspaceAssistants } from "@/lib/api/views";
import { pickPrimaryAssistant } from "@/lib/primary-assistant";
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

  const session = useChatSession();
  const stream = useMessageStream();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(true);
  const sessionIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const channelId = scopeChannelId(scope);
  const kbSourceId = scopeKbSourceId(scope);

  useEffect(() => {
    sessionIdRef.current = session.state.sessionId;
  }, [session.state.sessionId]);

  // Resolve the workspace primary + resume the sticky per-source session.
  // Keyed on the scope so switching rail rows swaps the whole thread.
  useEffect(() => {
    let cancelled = false;
    setResuming(true);
    setError(null);
    session.setSession(null);
    session.loadMessages([]);
    session.clearConfirmations();
    (async () => {
      try {
        const assistants = await listWorkspaceAssistants(workspaceId);
        const primary = pickPrimaryAssistant(assistants);
        if (cancelled) return;
        if (!primary) {
          setResuming(false);
          return;
        }
        setAssistantId(primary.id);
        const res = await authFetch(
          `${API_URL}/api/sessions/by-channel?assistantId=${encodeURIComponent(primary.id)}&channelId=${encodeURIComponent(channelId)}`,
        );
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { id?: string };
          if (body.id && !cancelled) {
            session.setSession(body.id);
            const rows = await fetchSessionMessages(body.id);
            if (cancelled) return;
            const restored: Message[] = rows
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => ({
                id: m.id,
                role: m.role as "user" | "assistant",
                text: extractMessageText(m.content),
                timestamp: new Date(m.timestamp),
              }))
              .filter((m) => m.text.trim().length > 0);
            session.loadMessages(restored);
          }
        }
      } catch {
        /* resume is best-effort — a miss just starts fresh */
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
      stream.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, channelId]);

  // Keep the thread pinned to the bottom while streaming.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session.state.messages, session.state.streamingText, session.state.pendingConfirmations]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !assistantId) return;

      session.appendMessage({
        id: `local-${Date.now()}`,
        role: "user",
        text: trimmed,
        timestamp: new Date(),
      });
      setInput("");
      setError(null);
      session.dispatch({ type: "stream/start" });

      let finalText = "";

      await stream.start({
        url: `${API_URL}/api/chat`,
        authFetch: (input, init) => authFetch(input.toString(), init),
        body: {
          message: trimmed,
          assistantId,
          workspaceId,
          sessionId: sessionIdRef.current ?? undefined,
          channelId,
          kbSourceId,
        },
        onEvent: (event) => {
          const raw = event.data;
          const payload: Record<string, unknown> =
            typeof raw === "object" && raw !== null
              ? (raw as Record<string, unknown>)
              : (() => {
                  try {
                    return JSON.parse(raw as string) as Record<string, unknown>;
                  } catch {
                    return {};
                  }
                })();
          switch (event.event) {
            case "session": {
              const sid = payload.sessionId;
              if (typeof sid === "string" && sid) session.setSession(sid);
              break;
            }
            case "text_delta": {
              const text = payload.text;
              if (typeof text === "string" && text) {
                session.dispatch({ type: "stream/append", text });
                finalText += text;
              }
              break;
            }
            case "tool_confirmation_required": {
              const toolCallId =
                typeof payload.toolCallId === "string" ? payload.toolCallId : "";
              if (!toolCallId) break;
              const conf: PendingConfirmation = {
                toolCallId,
                toolName:
                  typeof payload.toolName === "string" ? payload.toolName : "",
                displayName:
                  typeof payload.displayName === "string"
                    ? payload.displayName
                    : undefined,
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
                sessionId: sessionIdRef.current ?? "",
                status: "pending",
              };
              session.addConfirmation(conf);
              break;
            }
            case "tool_result": {
              // A confirmed tool that failed at execution flips its pill red.
              const id = typeof payload.id === "string" ? payload.id : "";
              if (!id || payload.isError !== true) break;
              const conf = session.state.pendingConfirmations.find(
                (p) => p.toolCallId === id,
              );
              if (conf && conf.status === "approved") {
                session.updateConfirmation(id, {
                  status: "failed",
                  ...(typeof payload.errorMessage === "string"
                    ? { result: payload.errorMessage }
                    : {}),
                });
              }
              break;
            }
            case "assistant_message_saved": {
              session.dispatch({
                type: "stream/finalize",
                finalMessage: {
                  id:
                    (payload.id as string | undefined) ??
                    `assistant-${Date.now()}`,
                  role: "assistant",
                  text: finalText,
                  timestamp: new Date(),
                },
              });
              finalText = "";
              break;
            }
            case "error": {
              setError(
                (payload as { message?: string }).message ??
                  (payload.error as string | undefined) ??
                  copy.streamError,
              );
              session.dispatch({ type: "stream/abort" });
              break;
            }
          }
        },
        onDone: () => {
          if (finalText.length > 0) {
            session.dispatch({
              type: "stream/finalize",
              finalMessage: {
                id: `assistant-${Date.now()}`,
                role: "assistant",
                text: finalText,
                timestamp: new Date(),
              },
            });
          } else {
            session.dispatch({ type: "stream/abort" });
          }
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : copy.streamError);
          session.dispatch({ type: "stream/abort" });
        },
      });
    },
    [assistantId, channelId, kbSourceId, session, stream, workspaceId, copy.streamError],
  );

  const handleConfirmation = useCallback(
    async (toolCallId: string, action: "approve" | "deny", comment?: string) => {
      const conf = session.state.pendingConfirmations.find(
        (p) => p.toolCallId === toolCallId,
      );
      if (!conf) return;
      session.updateConfirmation(toolCallId, {
        status: action === "approve" ? "approving" : "denied",
      });
      try {
        const res = await authFetch(`${API_URL}/api/chat/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: conf.sessionId || sessionIdRef.current,
            toolCallId,
            decision: action === "approve" ? "allow" : "deny",
            ...(action === "deny" && comment ? { comment } : {}),
          }),
        });
        if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as { result?: string };
          session.updateConfirmation(toolCallId, {
            status: action === "approve" ? "approved" : "denied",
            result: data.result,
          });
          requestApprovalsRefresh(workspaceId);
        } else {
          session.updateConfirmation(toolCallId, { status: "pending" });
        }
      } catch {
        session.updateConfirmation(toolCallId, { status: "pending" });
      }
    },
    [session, workspaceId],
  );

  const onSend = useCallback(() => {
    if (stream.inFlight()) return;
    void sendMessage(input);
  }, [input, sendMessage, stream]);

  const messages = session.state.messages;
  const isStreaming = session.state.isStreaming;
  const streamingText = session.state.streamingText;
  const pending = session.state.pendingConfirmations.filter(
    (c) => c.status === "pending" || c.status === "approving",
  );

  return (
    <div className="flex h-[26rem] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
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

        {error && (
          <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {error}
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
            disabled={!assistantId || resuming}
            className={cn(
              "min-h-[2.25rem] max-h-32 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px]",
              "placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50",
            )}
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={() => {
                const sid = sessionIdRef.current;
                stream.abort();
                session.dispatch({ type: "stream/abort" });
                // The server no longer reads a client close as Stop
                // (2026-08-24: a dropped connection keeps the turn running
                // so it can be re-attached), so the explicit stop is the
                // only thing that ends it. Idempotent server-side, and the
                // local teardown already happened, so a failure is swallowed.
                if (sid) void stopTurn(sid).catch(() => {});
              }}
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
