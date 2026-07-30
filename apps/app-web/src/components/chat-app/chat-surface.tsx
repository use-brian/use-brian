"use client";

/**
 * Chat operator app — the full-page, ChatGPT-style chat surface at
 * `/w/<workspaceId>/chat`, the 6th operator app under Home.
 *
 * NOT a fork of the floating dock (`components/chrome/floating-chat.tsx`).
 * That component is 3.9k lines because it carries every doc-authoring
 * affordance — page anchoring, theme refinement, deck previews, the
 * quick-capture recorder. None of that belongs to a standalone chat, and
 * copying it would mean two divergent chat clients. This surface is built on
 * the `@use-brian/chat-ui` primitives instead (`useChatSession` for state,
 * `useMessageStream` for the SSE-over-POST loop, `ChatComposer`,
 * `ChatMarkdown`), which is exactly what that package exists for
 * (chat-miniapp-home-config.md T4). The dock keeps floating over this surface
 * like every other one (T2) — it is a different thread lifecycle, not a
 * duplicate of this one.
 *
 * Layout: `OperatorTopbar` (tab chip + New chat) over a two-pane body —
 * a left session rail (recents, searchable, rename / delete) and the
 * transcript + composer.
 *
 * The open thread lives in the URL (`?s=<sessionId>`), not in component state:
 * that makes a chat linkable, gives back/forward the behaviour a user expects
 * from a full-page surface, and lets the sidebar panel deep-link a recent
 * without a private bus between two components.
 *
 * Personal history is UNIFIED (T3): the rail lists all of the caller's
 * non-draft web sessions with no `app_origin` filter, so a thread started in
 * the dock and one started here are one history. New chats minted here stamp
 * `app_origin='chat'`.
 *
 * Spec: docs/architecture/features/chat-app.md.
 * [COMP:app-web/chat-surface]
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChatComposer,
  ChatMarkdown,
  useChatSession,
  useMessageStream,
  type Message,
} from "@use-brian/chat-ui";
import remarkGfm from "remark-gfm";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { authFetch } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { listWorkspaceAssistants } from "@/lib/api/views";
import {
  deleteSession,
  extractMessageText,
  listSessions,
  renameSessionTitle,
  fetchSessionMessages,
  type DocSession,
} from "@/lib/api/sessions";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const REMARK_PLUGINS = [remarkGfm];

/** The surface tag stamped on sessions minted here (migration 255). */
const APP_ORIGIN = "chat";

/** Narrow an SSE `data` payload to an object without trusting its shape. */
function coercePayload(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

export function ChatSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT().chatApp;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<DocSession[]>([]);
  const [railLoading, setRailLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  /** The open thread — URL state, so it is linkable and survives navigation. */
  const activeSessionId = searchParams?.get("s") ?? null;

  const chat = useChatSession();
  const stream = useMessageStream();
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The id the next turn should resume. Kept in a ref so the send closure
   *  reads the value at send time, not at render time. */
  const sessionIdRef = useRef<string | null>(null);
  /** The thread currently painted. Guards the hydrate effect from re-fetching
   *  (and wiping a live stream) when WE are the ones who just put the id in
   *  the URL — a fresh session adopts its server id mid-turn. */
  const hydratedRef = useRef<string | null>(null);
  /** Accumulated assistant text for the turn, so `stream/finalize` has a body. */
  const turnTextRef = useRef("");

  const selectSession = useCallback(
    (id: string | null) => {
      router.replace(id ? `${pathname}?s=${encodeURIComponent(id)}` : pathname ?? "", {
        scroll: false,
      });
    },
    [pathname, router],
  );

  // ── Assistant resolution ────────────────────────────────────────────
  // A session is assistant-bound, and the Chat app always talks to the
  // workspace primary — the dock owns the assistant switcher (T2), so
  // duplicating it here would fork the "which assistant am I talking to"
  // question across two surfaces.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    listWorkspaceAssistants(workspaceId)
      .then((list) => {
        if (cancelled) return;
        const primary = list.find((a) => a.kind === "primary") ?? list[0];
        setAssistantId(primary?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setAssistantId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // ── Session rail ────────────────────────────────────────────────────
  const reloadRail = useCallback(async () => {
    if (!assistantId) return;
    setRailLoading(true);
    const rows = await listSessions({ workspaceId, assistantId });
    setSessions(rows);
    setRailLoading(false);
  }, [assistantId, workspaceId]);

  useEffect(() => {
    if (!assistantId) return;
    void reloadRail();
  }, [assistantId, reloadRail]);

  // ── Hydrate the open thread ─────────────────────────────────────────
  useEffect(() => {
    if (activeSessionId === hydratedRef.current) return;
    hydratedRef.current = activeSessionId;
    sessionIdRef.current = activeSessionId;
    if (!activeSessionId) {
      chat.loadMessages([]);
      return;
    }
    let cancelled = false;
    void fetchSessionMessages(activeSessionId).then((rows) => {
      if (cancelled) return;
      chat.loadMessages(
        rows
          .filter((r) => r.role === "user" || r.role === "assistant")
          .map((r) => ({
            id: r.id,
            role: r.role as "user" | "assistant",
            text: extractMessageText(r.content),
            timestamp: new Date(r.timestamp),
          }))
          .filter((m) => m.text.length > 0),
      );
    });
    return () => {
      cancelled = true;
    };
    // `chat.loadMessages` is a stable useCallback from the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // Keep the transcript pinned to the newest turn as it streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.state.messages, chat.state.streamingText]);

  const startNewChat = useCallback(() => {
    stream.abort();
    hydratedRef.current = null;
    sessionIdRef.current = null;
    setError(null);
    setInput("");
    chat.loadMessages([]);
    chat.dispatch({ type: "stream/reset" });
    selectSession(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectSession, stream]);

  // ── Send ────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || !assistantId || chat.state.isStreaming) return;

    // "New chat" mints a fresh channel id (the §107 spec). The chat route's
    // sticky-channel fallback reunites every later turn of this conversation
    // on the row that first turn creates, even if the `session` event is
    // dropped — so we never fragment one chat across several rail rows.
    const channelId = sessionIdRef.current ? undefined : crypto.randomUUID();

    chat.appendMessage({
      id: `local-${Date.now()}`,
      role: "user",
      text: trimmed,
      timestamp: new Date(),
    });
    setInput("");
    setError(null);
    chat.dispatch({ type: "stream/start" });
    turnTextRef.current = "";

    await stream.start({
      url: `${API_URL}/api/chat`,
      authFetch: (url, init) => authFetch(String(url), init),
      body: {
        message: trimmed,
        workspaceId,
        assistantId,
        appOrigin: APP_ORIGIN,
        ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
        ...(channelId ? { channelId } : {}),
      },
      onEvent: (event) => {
        const payload = coercePayload(event.data);
        switch (event.event) {
          case "session": {
            const id = typeof payload.sessionId === "string" ? payload.sessionId : null;
            if (id && id !== sessionIdRef.current) {
              // Adopt BEFORE the URL write: `hydratedRef` is what stops the
              // hydrate effect from re-fetching this thread and wiping the
              // reply that is streaming into it right now.
              sessionIdRef.current = id;
              hydratedRef.current = id;
              chat.setSession(id);
              selectSession(id);
            }
            break;
          }
          case "text_delta": {
            const delta = typeof payload.text === "string" ? payload.text : "";
            if (delta) {
              turnTextRef.current += delta;
              chat.dispatch({ type: "stream/append", text: delta });
            }
            break;
          }
          case "error": {
            const message =
              typeof payload.error === "string" ? payload.error : t.errorGeneric;
            setError(message);
            break;
          }
          default:
            // Every other event (tool activity, citations, confirmations) is
            // dock-only chrome for now. Ignoring an unknown event is the
            // additive contract: a newer server must never break this client.
            break;
        }
      },
      onDone: () => {
        const finalText = turnTextRef.current.trim();
        if (finalText) {
          chat.dispatch({
            type: "stream/finalize",
            finalMessage: {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              text: finalText,
              timestamp: new Date(),
            } satisfies Message,
          });
        } else {
          chat.dispatch({ type: "stream/abort" });
        }
        turnTextRef.current = "";
        void reloadRail();
      },
      onError: () => {
        chat.dispatch({ type: "stream/abort" });
        setError(t.errorGeneric);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, assistantId, workspaceId, chat.state.isStreaming, reloadRail, selectSession, stream, t]);

  // ── Rail actions ────────────────────────────────────────────────────
  const onRename = useCallback(
    async (row: DocSession) => {
      setMenuFor(null);
      const next = await promptDialog({
        title: t.renameTitle,
        defaultValue: row.title,
        placeholder: t.renamePlaceholder,
        confirmLabel: t.renameConfirm,
      });
      if (!next || next.trim() === row.title) return;
      try {
        await renameSessionTitle(row.id, next.trim());
        await reloadRail();
      } catch {
        setError(t.renameFailed);
      }
    },
    [reloadRail, t],
  );

  const onDelete = useCallback(
    async (row: DocSession) => {
      setMenuFor(null);
      const ok = await confirmDialog({
        title: t.deleteTitle,
        description: t.deleteBody,
        confirmLabel: t.deleteConfirm,
        variant: "destructive",
      });
      if (!ok) return;
      try {
        await deleteSession(row.id);
        if (row.id === activeSessionId) startNewChat();
        await reloadRail();
      } catch {
        setError(t.deleteFailed);
      }
    },
    [activeSessionId, reloadRail, startNewChat, t],
  );

  const visibleSessions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(needle));
  }, [search, sessions]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OperatorTopbar
        app="chat"
        right={
          <button
            type="button"
            onClick={startNewChat}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Plus className="size-3.5" aria-hidden />
            {t.newChat}
          </button>
        }
      />

      <div className="flex min-h-0 flex-1">
        {/* ── Session rail ──────────────────────────────────────── */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-background/60 md:flex">
          <div className="p-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.searchPlaceholder}
              aria-label={t.searchPlaceholder}
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-primary/50"
            />
          </div>
          <nav aria-label={t.railAria} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {railLoading && sessions.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t.loading}</p>
            )}
            {!railLoading && visibleSessions.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t.railEmpty}</p>
            )}
            {visibleSessions.map((row) => (
              <div key={row.id} className="group relative">
                <button
                  type="button"
                  onClick={() => {
                    stream.abort();
                    setError(null);
                    selectSession(row.id);
                  }}
                  aria-current={row.id === activeSessionId ? "true" : undefined}
                  className={cn(
                    "w-full truncate rounded-md px-2 py-1.5 pr-7 text-left text-xs transition-colors",
                    row.id === activeSessionId
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-foreground/80 hover:bg-sidebar-accent/60",
                  )}
                >
                  {row.title}
                </button>
                <button
                  type="button"
                  aria-label={t.rowActionsAria}
                  onClick={() => setMenuFor(menuFor === row.id ? null : row.id)}
                  className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                >
                  <MoreHorizontal className="size-3.5" aria-hidden />
                </button>
                {menuFor === row.id && (
                  <div className="absolute top-full right-1 z-20 mt-0.5 w-32 overflow-hidden rounded-md border border-border bg-popover shadow-md">
                    <button
                      type="button"
                      onClick={() => void onRename(row)}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent"
                    >
                      <Pencil className="size-3.5" aria-hidden />
                      {t.rename}
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(row)}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-destructive hover:bg-accent"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      {t.delete}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </nav>
        </aside>

        {/* ── Transcript + composer ─────────────────────────────── */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
              {chat.state.messages.length === 0 && !chat.state.isStreaming && (
                <p className="py-20 text-center text-sm text-muted-foreground">
                  {t.transcriptEmpty}
                </p>
              )}
              {chat.state.messages.map((m) =>
                m.role === "user" ? (
                  <div
                    key={m.id}
                    className="ml-auto max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground"
                  >
                    {m.text}
                  </div>
                ) : (
                  <div
                    key={m.id}
                    className="max-w-[95%] text-sm leading-relaxed [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_table]:block [&_table]:overflow-x-auto"
                  >
                    <ChatMarkdown text={m.text} remarkPlugins={REMARK_PLUGINS} />
                  </div>
                ),
              )}
              {chat.state.isStreaming && (
                <div className="max-w-[95%] text-sm leading-relaxed [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3">
                  {chat.state.streamingText ? (
                    <ChatMarkdown
                      text={chat.state.streamingText}
                      remarkPlugins={REMARK_PLUGINS}
                    />
                  ) : (
                    <span className="inline-flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      {t.thinking}
                    </span>
                  )}
                </div>
              )}
              {error && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          </div>

          <div className="border-t border-border px-4 py-3">
            <div className="mx-auto w-full max-w-3xl">
              <ChatComposer
                value={input}
                onChange={setInput}
                onSend={() => void send()}
                sendDisabled={chat.state.isStreaming || !assistantId}
                placeholder={t.composerPlaceholder}
                sendLabel={t.send}
                className="rounded-xl border border-border bg-background p-1.5"
                textareaClassName="max-h-40 w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
                rowClassName="flex items-end gap-2"
                sendButtonClassName="inline-flex shrink-0 items-center rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
