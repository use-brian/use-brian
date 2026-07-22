"use client";

/**
 * Tuning chat panel — ported faithfully from
 * `apps/feed-web/src/components/tuning-chat-panel.tsx`
 * (docs/plans/feed-web-consolidation.md §7.3): the chat surface where the
 * operator teaches the assistant voice rules over `@use-brian/chat-ui` +
 * `POST /api/chat` SSE, with session resume (`channelId='tuning'`), voice
 * notes, copy/retry, a model-tier picker gated by the workspace plan, and
 * the research-mode toggle gated by the free-research quota.
 *
 * Port deltas (disposition rules §6):
 *   - Session resume rides `fetchFeedSessionIdByChannel` (feed SDK) +
 *     `fetchSessionMessages`/`extractMessageText` (sessions SDK) instead of
 *     inline fetches; `extractMessageText` also collapses `<attached_file>`
 *     wrappers to a tidy name on resume (app-web's canonical extractor).
 *   - Plan gating rides `getUsage()` (`@/lib/api/usage`).
 *   - The research-exhausted upsell deep-links `${webAppUrl()}/plans` — the
 *     plans page lives on the marketing origin (composer-controls.tsx
 *     pattern), where feed-web used its own-origin `/plans`.
 *   - All copy via `useT().feedPage.tuningChat`.
 *
 * [COMP:app-web/feed-tuning-chat]
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  ChatMarkdown,
  useChatSession,
  useMessageStream,
  type Message,
} from "@use-brian/chat-ui";
import { authFetch } from "@/lib/auth-fetch";
import { fetchFeedSessionIdByChannel } from "@/lib/api/feed";
import { fetchSessionMessages, extractMessageText } from "@/lib/api/sessions";
import { getUsage } from "@/lib/api/usage";
import { webAppUrl } from "@/lib/primary-auth";
import { VoiceRecorder } from "@/components/feed/voice-recorder";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronDownIcon } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const TUNING_CHANNEL_ID = "tuning";

/** Persisted across sessions so the operator's model choice sticks. */
const MODEL_STORAGE_KEY = "feed-chat-model";
type ModelTier = "standard" | "pro" | "max";

type SessionEvent = { sessionId?: string };
type TextDeltaEvent = { text?: string };
type AssistantSavedEvent = { id?: string };
type ErrorEvent = { error?: string; code?: string };
type ResearchQuotaEvent = { used?: number; quota?: number; isPaid?: boolean };
type StatusEvent = { message?: string };

type StagedAttachment = {
  localId: string;
  fileName: string;
  fileId?: string;
  status: "uploading" | "done" | "error";
  error?: string;
};

export type TuningChatPanelHandle = {
  /** Drop a draft into the composer and focus it. Optionally flip research mode on. */
  insertPrompt(text: string, opts?: { researchMode?: boolean }): void;
};

export const TuningChatPanel = forwardRef<
  TuningChatPanelHandle,
  {
    assistantId: string;
    assistantName: string;
    /**
     * Active workspace — used to resolve the plan (model-tier gating) and
     * the research quota via `GET /api/usage`. Omit to disable gating.
     */
    workspaceId?: string;
    /** Optional helper line under the suggestion banner. */
    headline?: string;
    /** Suggested starter prompts shown in the empty state. */
    suggestions?: string[];
    /** When provided, the header renders a collapse button (floating shell). */
    onClose?: () => void;
  }
>(function TuningChatPanel(props, ref) {
  const { assistantId, assistantName, workspaceId, headline, suggestions, onClose } = props;

  const t = useT().feedPage.tuningChat;
  const session = useChatSession();
  const stream = useMessageStream();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  // Model tier. Persisted across sessions; gated by the workspace plan
  // (pro/max disabled on lower plans) once `/api/usage` resolves.
  const [model, setModel] = useState<ModelTier>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY);
      if (saved === "standard" || saved === "pro" || saved === "max") return saved;
    }
    return "standard";
  });
  // null = plan not yet loaded; gating effects wait for a concrete value.
  const [workspacePlan, setWorkspacePlan] = useState<string | null>(null);
  // Research-mode toggle. ON → the next send adds `mode: 'research'`, which
  // the server turns into coordinator + max-tier model + a higher turn
  // ceiling, gated by the workspace's free-research quota. The SSE handler
  // trips `researchExhausted` when the server denies a turn.
  const [researchMode, setResearchMode] = useState(false);
  const [researchQuota, setResearchQuota] = useState<{ used: number; quota: number; isPaid: boolean } | null>(null);
  const [researchExhausted, setResearchExhausted] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    insertPrompt(text: string, opts?: { researchMode?: boolean }) {
      setInput((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${text}` : text));
      if (opts?.researchMode && !researchExhausted) setResearchMode(true);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
  }), [researchExhausted]);

  useEffect(() => {
    sessionIdRef.current = session.state.sessionId;
  }, [session.state.sessionId]);

  // Persist the model choice so it sticks across panel opens / reloads.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch {
      /* private mode / quota — non-fatal */
    }
  }, [model]);

  // Resolve the workspace plan for model-tier gating. Billing is
  // per-workspace; the same endpoint backs the main web app's picker.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    getUsage(workspaceId)
      .then((data) => {
        if (cancelled || !data?.plan) return;
        setWorkspacePlan(data.plan);
      })
      .catch(() => {
        /* gating stays permissive; the server clamps the tier anyway */
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Snap an over-tier selection back down once the plan resolves, so a
  // stored "max" on a downgraded plan doesn't silently send the wrong tier.
  useEffect(() => {
    if (workspacePlan === "free" && model !== "standard") setModel("standard");
    else if (workspacePlan === "pro" && model === "max") setModel("pro");
  }, [workspacePlan, model]);

  // Paid workspaces default to Pro (cost-and-pricing → "Default chat is Pro").
  // The legacy default was Standard, so on the first paid plan-load (once per
  // device, guarded by a shared flag alongside MODEL_STORAGE_KEY) raise a
  // still-Standard selection up to Pro. Genuine Pro/Max picks are left
  // untouched; once migrated a deliberate Standard choice sticks. Free plans
  // are clamped to Standard by the effect above.
  useEffect(() => {
    if (!workspacePlan || workspacePlan === "free") return;
    if (typeof window === "undefined") return;
    const flagKey = `${MODEL_STORAGE_KEY}-pro-default-migrated`;
    try {
      if (localStorage.getItem(flagKey) === "1") return;
      localStorage.setItem(flagKey, "1");
    } catch {
      return; // private mode — leave the selection as-is
    }
    setModel((m) => (m === "standard" ? "pro" : m));
  }, [workspacePlan]);

  // Resume the persisted tuning session for this user+assistant — same
  // semantics as feed-web's standalone /chat page (channel_id='tuning').
  useEffect(() => {
    if (!assistantId) return;
    let cancelled = false;
    (async () => {
      const sessionId = await fetchFeedSessionIdByChannel(assistantId, TUNING_CHANNEL_ID);
      if (cancelled || !sessionId) return;
      session.setSession(sessionId);

      const rows = await fetchSessionMessages(sessionId);
      if (cancelled || rows.length === 0) return;
      const msgs: Message[] = rows
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          text: extractMessageText(m.content),
          timestamp: new Date(m.timestamp),
        }))
        .filter((m) => m.text.trim().length > 0);
      if (!cancelled) session.loadMessages(msgs);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session.state.messages, session.state.streamingText]);

  const sendMessage = useCallback(
    async (text: string, fileIds: string[], truncateFromMessageId?: string) => {
      const trimmed = text.trim();
      if (!trimmed && fileIds.length === 0) return;

      const userMessage: Message = {
        id: `local-${Date.now()}`,
        role: "user",
        text: trimmed || (fileIds.length > 0 ? t.voiceNote : ""),
        timestamp: new Date(),
      };
      session.appendMessage(userMessage);
      setInput("");
      setAttachments([]);
      setError(null);
      setStatusMessage(null);
      session.dispatch({ type: "stream/start" });

      let finalText = "";

      await stream.start({
        url: `${API_URL}/api/chat`,
        authFetch: (input, init) => authFetch(input.toString(), init),
        body: {
          message: trimmed,
          assistantId,
          sessionId: sessionIdRef.current ?? undefined,
          channelId: TUNING_CHANNEL_ID,
          model,
          // Forward the research-mode toggle. The server upgrades to the
          // coordinator + max-tier model + higher turn ceiling, gated by
          // the workspace's free-research quota.
          ...(researchMode ? { mode: "research" as const } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(fileIds.length > 0 ? { fileIds } : {}),
          ...(truncateFromMessageId ? { truncateFromMessageId } : {}),
        },
        onEvent: (event) => {
          const raw = event.data;
          const payload: Record<string, unknown> =
            typeof raw === "object" && raw !== null
              ? (raw as Record<string, unknown>)
              : (() => { try { return JSON.parse(raw as string) as Record<string, unknown>; } catch { return {}; } })();
          switch (event.event) {
            case "session": {
              const data = payload as SessionEvent;
              if (data.sessionId) session.setSession(data.sessionId);
              break;
            }
            case "status": {
              const data = payload as StatusEvent;
              if (data.message) setStatusMessage(data.message);
              break;
            }
            case "text_delta": {
              const data = payload as TextDeltaEvent;
              if (data.text) {
                session.dispatch({ type: "stream/append", text: data.text as string });
                finalText += data.text as string;
                // First token — clear any transient status line.
                if (finalText.length === (data.text as string).length) setStatusMessage(null);
              }
              break;
            }
            case "research_quota": {
              // Server accepted the research turn and bumped the counter.
              const data = payload as ResearchQuotaEvent;
              setResearchQuota({
                used: data.used ?? 0,
                quota: data.quota ?? 0,
                isPaid: data.isPaid ?? false,
              });
              break;
            }
            case "research_quota_exhausted": {
              // Free workspace hit its lifetime research cap. Drop the
              // toggle and surface the upgrade affordance.
              const data = payload as ResearchQuotaEvent;
              setResearchExhausted(true);
              setResearchMode(false);
              setResearchQuota({
                used: data.used ?? 0,
                quota: data.quota ?? 0,
                isPaid: false,
              });
              break;
            }
            case "assistant_message_saved": {
              const data = payload as AssistantSavedEvent;
              session.dispatch({
                type: "stream/finalize",
                finalMessage: {
                  id: (data.id as string | undefined) ?? `assistant-${Date.now()}`,
                  role: "assistant",
                  text: finalText,
                  timestamp: new Date(),
                },
              });
              finalText = "";
              break;
            }
            case "error": {
              const data = payload as ErrorEvent;
              if (data.code === "research_quota_exhausted") {
                setResearchExhausted(true);
                setResearchMode(false);
              }
              setError((data.error as string | undefined) ?? t.streamError);
              setStatusMessage(null);
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
          setError(err instanceof Error ? err.message : t.streamFailed);
          session.dispatch({ type: "stream/abort" });
        },
      });
    },
    [assistantId, session, stream, model, researchMode, workspaceId, t],
  );

  const onSend = useCallback(async () => {
    if (stream.inFlight()) return;
    const readyFileIds = attachments
      .filter((a) => a.status === "done" && a.fileId)
      .map((a) => a.fileId!);
    if (!input.trim() && readyFileIds.length === 0) return;
    if (attachments.some((a) => a.status === "uploading")) {
      setError(t.waitUpload);
      return;
    }
    await sendMessage(input, readyFileIds);
  }, [attachments, input, sendMessage, stream, t]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void onSend();
      }
    },
    [onSend],
  );

  const uploadVoice = useCallback(
    async (blob: Blob) => {
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type });
      const localId = `voice-${Date.now()}`;
      setAttachments((prev) => [...prev, { localId, fileName: file.name, status: "uploading" }]);
      setError(null);

      const formData = new FormData();
      formData.append("files", file);
      if (sessionIdRef.current) formData.append("sessionId", sessionIdRef.current);

      try {
        const res = await authFetch(`${API_URL}/api/files/upload`, { method: "POST", body: formData });
        if (!res.ok) throw new Error(t.uploadFailed);
        const data = (await res.json()) as {
          sessionId: string;
          files: Array<{ id?: string; fileName: string; error?: string }>;
        };
        if (data.sessionId && !sessionIdRef.current) {
          sessionIdRef.current = data.sessionId;
          session.setSession(data.sessionId);
        }
        const result = data.files[0];
        if (!result?.id) throw new Error(result?.error ?? t.uploadFailed);
        setAttachments((prev) =>
          prev.map((a) => a.localId === localId ? { ...a, status: "done", fileId: result.id } : a),
        );
        await sendMessage("", [result.id]);
      } catch (err) {
        setAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? { ...a, status: "error", error: err instanceof Error ? err.message : t.uploadFailed }
              : a,
          ),
        );
        setError(err instanceof Error ? err.message : t.voiceUploadFailed);
      }
    },
    [sendMessage, session, t],
  );

  const handleCopy = useCallback(async (messageId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId((id) => (id === messageId ? null : id)), 1500);
    } catch { /* clipboard blocked */ }
  }, []);

  const handleRetry = useCallback((messageId: string) => {
    if (stream.inFlight()) return;
    const msgs = session.state.messages;
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const msg = msgs[idx];
    if (msg.role === "user") {
      session.loadMessages(msgs.slice(0, idx));
      void sendMessage(msg.text, [], msg.id);
    } else {
      if (idx <= 0) return;
      const prev = msgs[idx - 1];
      if (prev.role !== "user") return;
      session.loadMessages(msgs.slice(0, idx - 1));
      void sendMessage(prev.text, [], prev.id);
    }
  }, [session, stream, sendMessage]);

  const messages = session.state.messages;
  const isStreaming = session.state.isStreaming;
  const streamingText = session.state.streamingText;
  const assistantInitial = assistantName.charAt(0).toUpperCase();
  const lastAssistantIdx = [...messages].reverse().findIndex((m) => m.role === "assistant");
  const lastAssistantId = lastAssistantIdx >= 0 ? messages[messages.length - 1 - lastAssistantIdx].id : null;
  const showEmpty = messages.length === 0 && !isStreaming;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
      <div className="relative shrink-0 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/70 text-xs font-semibold ring-1 ring-border">
            {assistantInitial}
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-card" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight">
                {t.title}
              </span>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                {t.live}
              </span>
            </div>
            <span className="block text-[11px] leading-tight text-muted-foreground truncate">
              {headline ?? format(t.headline, { name: assistantName })}
            </span>
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t.collapse}
              title={t.collapse}
              className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <ChevronDownIcon />
            </button>
          ) : null}
        </div>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 py-4 space-y-5">
          {showEmpty ? (
            <EmptyState suggestions={suggestions} onPick={(s) => {
              setInput(s);
              requestAnimationFrame(() => inputRef.current?.focus());
            }} />
          ) : null}

          {messages.map((msg) => {
            const isLastAssistant = msg.id === lastAssistantId;
            if (msg.role === "user") {
              return (
                <div key={msg.id} className="flex justify-end group">
                  <div className="max-w-[85%] space-y-1">
                    {msg.text && (
                      <div className="inline-block max-w-full rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[14px] leading-[1.5] text-primary-foreground shadow-sm whitespace-pre-wrap break-words">
                        {msg.text}
                      </div>
                    )}
                    <div className="flex items-center gap-0.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity -mr-1">
                      <ActionButton tooltip={copiedMessageId === msg.id ? t.copied : t.copy} onClick={() => void handleCopy(msg.id, msg.text)}>
                        {copiedMessageId === msg.id ? <CheckIcon /> : <CopyIcon />}
                      </ActionButton>
                      {!isStreaming && (
                        <ActionButton tooltip={t.retry} onClick={() => handleRetry(msg.id)}>
                          <RetryIcon />
                        </ActionButton>
                      )}
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div key={msg.id} className="flex gap-2.5 group">
                <div className="mt-0.5 shrink-0 w-7 h-7 rounded-lg bg-primary/10 text-primary text-[11px] font-semibold flex items-center justify-center ring-1 ring-primary/15">
                  {assistantInitial}
                </div>
                <div className="flex-1 min-w-0 text-[14px] leading-[1.6] text-foreground break-words pt-0.5 space-y-1.5">
                  {msg.text && (
                    <div className="chat-markdown prose prose-sm dark:prose-invert max-w-none">
                      <ChatMarkdown text={msg.text} />
                    </div>
                  )}
                  <div className="flex items-center gap-0.5 -ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <ActionButton tooltip={copiedMessageId === msg.id ? t.copied : t.copy} onClick={() => void handleCopy(msg.id, msg.text)}>
                      {copiedMessageId === msg.id ? <CheckIcon /> : <CopyIcon />}
                    </ActionButton>
                    {isLastAssistant && !isStreaming && (
                      <ActionButton tooltip={t.retry} onClick={() => handleRetry(msg.id)}>
                        <RetryIcon />
                      </ActionButton>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {isStreaming && (
            <div className="flex gap-2.5">
              <div className="mt-0.5 shrink-0 w-7 h-7 rounded-lg bg-primary/10 text-primary text-[11px] font-semibold flex items-center justify-center ring-1 ring-primary/15">
                {assistantInitial}
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                {streamingText ? (
                  <div className="text-[14px] leading-[1.6] text-foreground break-words chat-markdown prose prose-sm dark:prose-invert max-w-none">
                    <ChatMarkdown text={streamingText} />
                    <span className="inline-block w-[2px] h-[16px] bg-primary rounded-full animate-pulse ml-0.5 align-text-bottom" />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                    <span className="flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "300ms" }} />
                    </span>
                    {statusMessage ?? t.thinking}
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border/60 bg-card/60 backdrop-blur-sm px-3 pt-2.5 pb-3">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachments.map((a) => (
              <span
                key={a.localId}
                className={
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] " +
                  (a.status === "error"
                    ? "border-destructive/40 text-destructive"
                    : a.status === "uploading"
                      ? "border-border text-muted-foreground"
                      : "border-emerald-500/40 text-emerald-300")
                }
              >
                <MicDot status={a.status} />
                {a.fileName}
                {a.status === "uploading" ? ` · ${t.uploading}` : null}
                {a.status === "error" ? ` · ${a.error ?? t.attachmentFailed}` : null}
              </span>
            ))}
          </div>
        )}

        <div className="rounded-xl border border-border/70 bg-background/60 shadow-sm focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15 transition-all">
          <div className="px-3.5 pt-2.5">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              // Typeable while the reply streams — `onSend` no-ops on
              // `stream.inFlight()`, so Enter can't double-send; the message
              // list carries the thinking indicator.
              placeholder={t.composerPlaceholder}
              rows={1}
              className="w-full bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground/60 resize-none outline-none min-h-[24px] max-h-[140px] py-0.5 leading-relaxed"
              style={{ fieldSizing: "content" } as React.CSSProperties}
            />
          </div>
          <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1">
            {/* Recording mid-stream is fine — the note stages as an
                attachment and rides the NEXT send, same as pre-typed text. */}
            <VoiceRecorder onRecorded={(blob) => void uploadVoice(blob)} />
            <ResearchModeToggle
              active={researchMode}
              exhausted={researchExhausted}
              quota={researchQuota}
              onToggle={() => {
                if (researchExhausted) {
                  // `/plans` lives on the marketing origin (apps/web) —
                  // deep-link via webAppUrl(), the composer-controls pattern.
                  if (typeof window !== "undefined") window.location.href = `${webAppUrl()}/plans`;
                  return;
                }
                setResearchMode((v) => !v);
              }}
            />
            <div className="flex-1" />
            <Select value={model} onValueChange={(v) => { if (v) setModel(v as ModelTier); }}>
              <SelectTrigger
                size="sm"
                className="text-xs gap-1.5 bg-muted/50 hover:bg-muted border-transparent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top" align="end" alignItemWithTrigger={false} className="w-auto min-w-56">
                <SelectItem value="standard">
                  <div className="flex flex-col gap-0.5 py-0.5">
                    <span className="text-sm font-medium">{t.modelStandard}</span>
                    <span className="text-[11px] text-muted-foreground">{t.modelStandardDesc}</span>
                  </div>
                </SelectItem>
                <SelectItem value="pro" disabled={workspacePlan === "free"}>
                  <div className="flex flex-col gap-0.5 py-0.5">
                    <span className="text-sm font-medium">{t.modelPro}</span>
                    <span className="text-[11px] text-muted-foreground">{t.modelProDesc}</span>
                  </div>
                </SelectItem>
                <SelectItem value="max" disabled={workspacePlan === "free" || workspacePlan === "pro"}>
                  <div className="flex flex-col gap-0.5 py-0.5">
                    <span className="text-sm font-medium">{t.modelMax}</span>
                    <span className="text-[11px] text-muted-foreground">{t.modelMaxDesc}</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            {isStreaming ? (
              <button
                onClick={() => stream.abort()}
                className="p-2 rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                title={t.stop}
              >
                <StopIcon />
              </button>
            ) : (
              <button
                onClick={() => void onSend()}
                disabled={!input.trim() && attachments.filter((a) => a.status === "done").length === 0}
                className="p-2 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-sm shrink-0"
                title={t.send}
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

function EmptyState({
  suggestions,
  onPick,
}: {
  suggestions?: string[];
  onPick: (s: string) => void;
}) {
  const t = useT().feedPage;
  const items = suggestions && suggestions.length > 0
    ? suggestions
    : [t.tuningChat.suggestion1, t.tuningChat.suggestion2, t.tuningChat.suggestion3];
  return (
    <div className="space-y-3 animate-fade-in">
      <div className="rounded-xl border border-primary/20 bg-gradient-to-br from-primary/[0.07] via-primary/[0.03] to-transparent p-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <SparkIcon />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium leading-snug">{t.tuningChat.emptyTitle}</p>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {t.tuningChat.emptyBodyBefore}{" "}
              <span className="font-medium text-foreground">{t.voice.discuss}</span>{" "}
              {t.tuningChat.emptyBodyAfter}
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="px-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {t.tuningChat.trySuggestions}
        </p>
        <div className="flex flex-col gap-1.5">
          {items.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className="group flex items-start gap-2 rounded-xl border border-border/60 bg-background/40 px-3 py-2 text-left text-[13px] leading-snug text-foreground/90 hover:border-primary/40 hover:bg-primary/[0.04] transition-colors"
            >
              <span className="mt-0.5 text-muted-foreground group-hover:text-primary transition-colors">
                <ArrowRightIcon />
              </span>
              <span>{s}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Composer toggle that flips the next send into deep-research mode. The
 * server turns `mode: 'research'` into coordinator + max-tier model + a
 * higher turn ceiling, gated by the workspace's free-research quota.
 *
 *   - idle      — muted pill with a sparkle, "Research"
 *   - active    — primary-tinted pill, shows remaining count on free plans
 *   - exhausted — amber pill, click routes to the marketing /plans page
 */
function ResearchModeToggle({
  active,
  exhausted,
  quota,
  onToggle,
}: {
  active: boolean;
  exhausted: boolean;
  quota: { used: number; quota: number; isPaid: boolean } | null;
  onToggle: () => void;
}) {
  const t = useT().feedPage.tuningChat;
  const tooltip = (() => {
    if (exhausted) return t.researchTooltipExhausted;
    if (quota?.isPaid) return t.researchTooltipUnlimited;
    if (quota) {
      const remaining = Math.max(0, quota.quota - quota.used);
      return format(t.researchTooltipRemaining, { remaining, quota: quota.quota });
    }
    return t.researchTooltip;
  })();

  return (
    <button
      type="button"
      onClick={onToggle}
      title={tooltip}
      aria-pressed={active}
      className={
        "inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[12px] font-medium transition-colors shrink-0 " +
        (exhausted
          ? "text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
          : active
            ? "text-primary bg-primary/15 hover:bg-primary/20"
            : "text-muted-foreground hover:text-primary hover:bg-muted")
      }
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
      </svg>
      <span className="hidden sm:inline">{t.research}</span>
      {active && quota && !quota.isPaid && (
        <span className="ml-0.5 text-[10.5px] opacity-70 tabular-nums">
          {Math.max(0, quota.quota - quota.used)}/{quota.quota}
        </span>
      )}
    </button>
  );
}

function ActionButton({
  tooltip,
  onClick,
  children,
}: {
  tooltip: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative group/btn">
      <button
        onClick={onClick}
        className="flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        {children}
      </button>
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 bg-foreground text-background text-[11px] font-medium rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 pointer-events-none transition-opacity shadow-lg">
        {tooltip}
      </div>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function RetryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}
function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M5.6 5.6l2.1 2.1" />
      <path d="M16.3 16.3l2.1 2.1" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
      <path d="M5.6 18.4l2.1-2.1" />
      <path d="M16.3 7.7l2.1-2.1" />
    </svg>
  );
}
function ArrowRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function MicDot({ status }: { status: StagedAttachment["status"] }) {
  const cls =
    status === "error"
      ? "bg-destructive"
      : status === "uploading"
        ? "bg-amber-400 animate-pulse"
        : "bg-emerald-400";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />;
}
