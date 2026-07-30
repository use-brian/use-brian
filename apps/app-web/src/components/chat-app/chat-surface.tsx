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
 * Two views, both in the URL (`?v=workspace`, `?s=<sessionId>`):
 *
 *   - **Personal** — UNIFIED history (T3): all of the caller's non-draft web
 *     sessions with no `app_origin` filter, so a thread started in the dock and
 *     one started here are one history. New chats minted here stamp
 *     `app_origin='chat'`.
 *   - **Workspace** — sessions any member can read and post to
 *     (`visibility='workspace'`), clearance-filtered server-side. Every viewer
 *     subscribes the per-session event bus so a teammate's turn appears live,
 *     and a concurrent turn is refused with `shared_session_busy` rather than
 *     interleaved (one in-flight turn per shared session).
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
import { Loader2, MoreHorizontal, Pencil, Plus, Trash2, Users } from "lucide-react";
import { createSSEBuffer, parseSSEStream } from "@use-brian/chat-ui";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { authFetch } from "@/lib/auth-fetch";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { listWorkspaceAssistants } from "@/lib/api/views";
import {
  createWorkspaceSession,
  deleteSession,
  extractMessageText,
  listSessions,
  listWorkspaceSessions,
  renameSessionTitle,
  fetchSessionMessages,
  type DocSession,
  type WorkspaceSession,
} from "@/lib/api/sessions";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const REMARK_PLUGINS = [remarkGfm];

/** The surface tag stamped on sessions minted here (migration 255). */
const APP_ORIGIN = "chat";

/**
 * A transcript row. Widens `chat-ui`'s `Message` with the sender's display
 * name, which only shared threads carry — the package stays host-agnostic, so
 * per-surface fields live here rather than in its shared type.
 */
type SurfaceMessage = Message & { senderName?: string };

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
  const [sharedSessions, setSharedSessions] = useState<WorkspaceSession[]>([]);
  const [railLoading, setRailLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [startingShared, setStartingShared] = useState(false);

  /** The open thread — URL state, so it is linkable and survives navigation. */
  const activeSessionId = searchParams?.get("s") ?? null;
  /** Which view is open. URL state too, so "the shared chats" is a link. */
  const view: "personal" | "workspace" =
    searchParams?.get("v") === "workspace" ? "workspace" : "personal";
  /** The open thread is shared when it is in the workspace rail. */
  const activeShared = useMemo(
    () => sharedSessions.find((r) => r.id === activeSessionId) ?? null,
    [sharedSessions, activeSessionId],
  );

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

  const buildHref = useCallback(
    (id: string | null, nextView: "personal" | "workspace") => {
      const params = new URLSearchParams();
      if (nextView === "workspace") params.set("v", "workspace");
      if (id) params.set("s", id);
      const qs = params.toString();
      return qs ? `${pathname}?${qs}` : (pathname ?? "");
    },
    [pathname],
  );

  const selectSession = useCallback(
    (id: string | null, nextView: "personal" | "workspace" = view) => {
      router.replace(buildHref(id, nextView), { scroll: false });
    },
    [buildHref, router, view],
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

  // ── Session rails ───────────────────────────────────────────────────
  // Both rails load regardless of the open view: the Workspace tab has to know
  // whether the open thread is shared (for the header badge and the live
  // subscription) even when the user is looking at Personal, and a rail that
  // only loads on tab-click flashes empty on every switch.
  const reloadRail = useCallback(async () => {
    if (!assistantId) return;
    setRailLoading(true);
    const [personal, shared] = await Promise.all([
      listSessions({ workspaceId, assistantId }),
      listWorkspaceSessions({ workspaceId }),
    ]);
    setSessions(personal);
    setSharedSessions(shared);
    setRailLoading(false);
  }, [assistantId, workspaceId]);

  useEffect(() => {
    if (!assistantId) return;
    void reloadRail();
  }, [assistantId, reloadRail]);

  // ── Hydrate the open thread ─────────────────────────────────────────
  /** Load a thread's persisted transcript into the reducer. Also the refetch
   *  the live-read path runs when a teammate's turn lands — the SSE payload is
   *  a SIGNAL, never the data (the workspace-events contract). */
  const loadTranscript = useCallback(async (sessionId: string) => {
    const rows = await fetchSessionMessages(sessionId);
    const rendered: SurfaceMessage[] = rows
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) => ({
        id: r.id,
        role: r.role as "user" | "assistant",
        text: extractMessageText(r.content),
        timestamp: new Date(r.timestamp),
        ...(r.senderName ? { senderName: r.senderName } : {}),
      }))
      .filter((m) => m.text.length > 0);
    chat.loadMessages(rendered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeSessionId === hydratedRef.current) return;
    hydratedRef.current = activeSessionId;
    sessionIdRef.current = activeSessionId;
    if (!activeSessionId) {
      chat.loadMessages([]);
      return;
    }
    let cancelled = false;
    void loadTranscript(activeSessionId).then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
    // `chat.loadMessages` is a stable useCallback from the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, loadTranscript]);

  // ── Live read of a shared thread ────────────────────────────────────
  // Every viewer of a shared session subscribes the per-session event bus, so
  // a teammate's turn appears without a refresh. The stream reports the turn's
  // status and streams the reply-so-far; when it settles we refetch the
  // persisted transcript rather than trusting the snapshot text, so what the
  // viewer ends up with is exactly what was stored.
  const [remoteTurn, setRemoteTurn] = useState<string | null>(null);
  useEffect(() => {
    if (!activeSessionId || !activeShared) {
      setRemoteTurn(null);
      return;
    }
    // Our OWN turn streams over its POST; a second subscription would
    // double-drive the same bubble.
    if (chat.state.isStreaming) return;

    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await authFetch(
          `${API_URL}/api/sessions/${encodeURIComponent(activeSessionId)}/stream`,
          { signal: controller.signal },
        );
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const buf = createSSEBuffer();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          for (const ev of parseSSEStream(decoder.decode(value, { stream: true }), buf)) {
            if (ev.event === "snapshot") {
              const d = ev.data as { text?: string };
              setRemoteTurn(d.text ?? "");
            } else if (ev.event === "done") {
              if (!cancelled) {
                setRemoteTurn(null);
                void loadTranscript(activeSessionId);
                void reloadRail();
              }
              return;
            }
          }
        }
      } catch {
        // Transport error / abort — the next open of this thread refetches.
      } finally {
        if (!cancelled) setRemoteTurn(null);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // Re-subscribing whenever the teammate's status flips is the point: the
    // endpoint closes immediately when nothing is in flight.
  }, [activeSessionId, activeShared, activeShared?.status, chat.state.isStreaming, loadTranscript, reloadRail]);

  // Keep the transcript pinned to the newest turn as it streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.state.messages, chat.state.streamingText]);

  const resetPane = useCallback(() => {
    stream.abort();
    hydratedRef.current = null;
    sessionIdRef.current = null;
    setError(null);
    setInput("");
    chat.loadMessages([]);
    chat.dispatch({ type: "stream/reset" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);

  const startNewChat = useCallback(() => {
    resetPane();
    selectSession(null, "personal");
  }, [resetPane, selectSession]);

  /**
   * Start a shared thread. An EXPLICIT create, not a flag on the first turn:
   * the thread has to be listable by teammates from the moment it is started,
   * otherwise "I made us a chat" points at nothing until the first message.
   */
  const startNewWorkspaceChat = useCallback(async () => {
    if (startingShared) return;
    setStartingShared(true);
    try {
      const created = await createWorkspaceSession(workspaceId);
      resetPane();
      setSharedSessions((rows) => [created, ...rows]);
      hydratedRef.current = created.id;
      sessionIdRef.current = created.id;
      selectSession(created.id, "workspace");
    } catch {
      setError(t.newWorkspaceChatFailed);
    } finally {
      setStartingShared(false);
    }
  }, [resetPane, selectSession, startingShared, t, workspaceId]);

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
            // A shared session takes one turn at a time. Say who we are waiting
            // for in the surface's own words rather than echoing the server
            // sentence, which is written for every client.
            if (payload.code === "shared_session_busy") {
              setError(t.sharedBusy);
              break;
            }
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
    async (row: DocSession | WorkspaceSession) => {
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
    async (row: DocSession | WorkspaceSession) => {
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

  const rows: Array<DocSession | WorkspaceSession> =
    view === "workspace" ? sharedSessions : sessions;
  const visibleSessions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((s) => s.title.toLowerCase().includes(needle));
  }, [search, rows]);

  const viewTabCls = (active: boolean) =>
    cn(
      "rounded-md px-2 py-1 text-xs font-medium transition-colors",
      active
        ? "bg-background text-foreground shadow-sm"
        : "text-sidebar-foreground/70 hover:text-sidebar-accent-foreground",
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OperatorTopbar
        app="chat"
        center={
          <div
            role="tablist"
            aria-label={t.viewSwitchAria}
            className="flex items-center gap-0.5 rounded-lg bg-sidebar-accent/50 p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "personal"}
              onClick={() => selectSession(null, "personal")}
              className={viewTabCls(view === "personal")}
            >
              {t.viewPersonal}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "workspace"}
              onClick={() => selectSession(null, "workspace")}
              className={viewTabCls(view === "workspace")}
            >
              {t.viewWorkspace}
            </button>
          </div>
        }
        right={
          <button
            type="button"
            onClick={
              view === "workspace"
                ? () => void startNewWorkspaceChat()
                : startNewChat
            }
            disabled={startingShared}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50"
          >
            <Plus className="size-3.5" aria-hidden />
            {view === "workspace" ? t.newWorkspaceChat : t.newChat}
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
            {railLoading && rows.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t.loading}</p>
            )}
            {!railLoading && visibleSessions.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {view === "workspace" ? t.workspaceRailEmpty : t.railEmpty}
              </p>
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
                    "w-full rounded-md px-2 py-1.5 pr-7 text-left text-xs transition-colors",
                    row.id === activeSessionId
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-foreground/80 hover:bg-sidebar-accent/60",
                  )}
                >
                  <span className="block truncate">{row.title}</span>
                  {"startedByUserId" in row && (
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {row.startedByName
                        ? format(t.startedBy, { name: row.startedByName })
                        : t.startedByUnknown}
                    </span>
                  )}
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
          {/* Nobody should be able to mistake a shared thread for a private
              one. The badge shows whenever the OPEN session is shared, not
              whenever the Workspace tab is selected. */}
          {activeShared && (
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
              <Users className="size-3.5 shrink-0" aria-hidden />
              <span>{t.sharedBadge}</span>
              {activeShared.startedByName && (
                <span className="truncate">
                  {format(t.startedBy, { name: activeShared.startedByName })}
                </span>
              )}
            </div>
          )}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
              {chat.state.messages.length === 0 &&
                !chat.state.isStreaming &&
                remoteTurn === null && (
                  <p className="py-20 text-center text-sm text-muted-foreground">
                    {activeShared ? t.sharedTranscriptEmpty : t.transcriptEmpty}
                  </p>
                )}
              {(chat.state.messages as SurfaceMessage[]).map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="ml-auto flex max-w-[85%] flex-col items-end">
                    {/* Attribution chip — only in a shared thread, and only for
                        turns that are not the viewer's own (a bubble labelled
                        with your own name is noise). */}
                    {m.senderName && (
                      <span className="mb-0.5 px-1 text-[11px] text-muted-foreground">
                        {m.senderName}
                      </span>
                    )}
                    <div className="rounded-2xl bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground">
                      {m.text}
                    </div>
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
              {/* A teammate's turn, relayed off the per-session event bus. Its
                  text is the live snapshot; when the turn settles we refetch
                  the PERSISTED transcript rather than keeping this. */}
              {remoteTurn !== null && !chat.state.isStreaming && (
                <div className="max-w-[95%] text-sm leading-relaxed [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3">
                  {remoteTurn ? (
                    <ChatMarkdown text={remoteTurn} remarkPlugins={REMARK_PLUGINS} />
                  ) : (
                    <span className="inline-flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      {t.teammateWorking}
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
