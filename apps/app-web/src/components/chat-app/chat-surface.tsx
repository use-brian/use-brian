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
 * The transcript chrome DOES follow the dock's look and streaming behaviour,
 * through the same shared pieces rather than a fork: `ChatActivityFeed` /
 * `ChatActivitySummary` (`chrome/chat-activity.tsx`) render the live shimmer
 * feed + the "Worked for Ns · k steps" receipt off the same
 * reasoning/tool SSE events, `build-events.ts` is the chronological reducer,
 * `tool-narration.ts` narrates the steps, and the bubbles/composer reuse the
 * dock's classes (neutral `--secondary` user bubble — never a saturated
 * primary fill — avatar-fronted assistant rows, streaming caret, Stop while
 * streaming).
 *
 * Layout: `OperatorTopbar` (view tabs + New chat) over transcript + composer.
 * The session rail lives in the LEFT SIDEBAR panel
 * (`doc/sidebar-panels/chat-sidebar-panel.tsx`), like every other operator
 * app — list in the sidebar, work in the body. The two coordinate through
 * URL state and `CHAT_SESSIONS_REFRESH_EVENT` (signals, never data).
 *
 * Assistant choice is PER CHAT: a new personal chat picks its interlocutor
 * in the composer chip (defaulting to the workspace primary) and the session
 * sticks to it — sessions are assistant-bound, and `/api/chat` rejects a
 * mismatched send. An open thread resolves and displays its bound assistant;
 * shared workspace chats stay on the primary.
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
  type ToolUsed,
} from "@use-brian/chat-ui";
import remarkGfm from "remark-gfm";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Plus,
  Sparkles,
  Square,
  User,
  Users,
} from "lucide-react";
import { createSSEBuffer, parseSSEStream } from "@use-brian/chat-ui";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { ComposerControls } from "@/components/doc/composer-controls";
import { useChatModelTier } from "@/lib/chat-model";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ChatActivityFeed,
  ChatActivitySummary,
  type ResearchPhase,
} from "@/components/chrome/chat-activity";
import {
  appendReasoning,
  appendStep,
  EMPTY_LOG,
  removeToolSteps,
  updateStepText,
  type BuildEvent,
  type EventLog,
} from "@/lib/build-events";
import { describeToolFromInput } from "@/lib/tool-narration";
import { authFetch } from "@/lib/auth-fetch";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  listWorkspaceAssistants,
  type WorkspaceAssistantSummary,
} from "@/lib/api/views";
import {
  CHAT_SESSIONS_REFRESH_EVENT,
  dispatchChatSessionsRefresh,
} from "@/lib/chat-session-events";
import {
  createWorkspaceSession,
  extractMessageText,
  extractToolUses,
  listSessionsForAssistants,
  listWorkspaceSessions,
  fetchSessionMessages,
  type DocSession,
  type WorkspaceSession,
} from "@/lib/api/sessions";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const REMARK_PLUGINS = [remarkGfm];

/** The surface tag stamped on sessions minted here (migration 255). */
const APP_ORIGIN = "chat";

/** The dock's assistant-reply markdown wrapper, verbatim. */
const MARKDOWN_CLS =
  "chat-markdown prose prose-sm dark:prose-invert max-w-none text-[14px] leading-[1.6] text-foreground break-words";

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
  // The dock's chat dictionary — tool narration, activity copy, copy/stop
  // labels. Reused verbatim so the two surfaces never phrase one thing twice.
  const tChat = useT().chat;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Model tier (`standard | pro | max`) — the shared seam (`chat-model.ts`):
  // persisted on the SAME localStorage key as the dock so one choice carries
  // across every chat surface, plan-gated (over-tier snaps down; the server
  // clamps regardless), paid workspaces defaulting to Pro. Applies per TURN,
  // so in a shared room each sender's turn runs on their own picked tier.
  const { model, setModel, plan: workspacePlan } = useChatModelTier(
    workspaceId,
    "standard",
  );
  const [assistants, setAssistants] = useState<WorkspaceAssistantSummary[]>([]);
  const primaryAssistant = useMemo(
    () => assistants.find((a) => a.kind === "primary") ?? assistants[0] ?? null,
    [assistants],
  );
  /** The new-chat pane's picked interlocutor (`null` = the primary default).
   *  Reset whenever the pane returns to a fresh chat — the pick is per chat,
   *  not a sticky preference. */
  const [pickedAssistantId, setPickedAssistantId] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  /** Personal rows across every assistant — resolves an open thread's binding
   *  (each row carries the `assistantId` it was fetched under). */
  const [personalSessions, setPersonalSessions] = useState<DocSession[]>([]);
  /** Sessions adopted mid-turn this mount: id → the assistant they were minted
   *  with, so the SECOND turn of a fresh chat resolves correctly before the
   *  rail refetch lands. */
  const sessionAssistantRef = useRef<Map<string, string>>(new Map());
  const [sharedSessions, setSharedSessions] = useState<WorkspaceSession[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [startingShared, setStartingShared] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  /** The open thread — URL state, so it is linkable and survives navigation. */
  const activeSessionId = searchParams?.get("s") ?? null;
  /** Which view is open. URL state too, so "the shared chats" is a link. */
  const view: "personal" | "workspace" =
    searchParams?.get("v") === "workspace" ? "workspace" : "personal";
  /** The open thread is shared when it is in the workspace list. */
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

  // ── Per-turn activity state (the dock's streaming model, trimmed) ───
  // The chronological build-event log (reasoning runs + tool steps in true
  // SSE order) drives <ChatActivityFeed>; the tool timeline carries per-step
  // status/duration and becomes the committed message's receipt.
  const [toolTimeline, setToolTimeline] = useState<ToolUsed[]>([]);
  const [streamingEvents, setStreamingEvents] = useState<BuildEvent[]>([]);
  const [researchPhase, setResearchPhase] = useState<ResearchPhase | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const turnToolsRef = useRef<ToolUsed[]>([]);
  const eventLogRef = useRef<EventLog>(EMPTY_LOG);
  const eventSeqRef = useRef(0);
  const eventedToolIdsRef = useRef<Set<string>>(new Set());
  const toolStartTimesRef = useRef<Map<string, number>>(new Map());
  const turnStartedAtRef = useRef<number | null>(null);
  // Accumulates the live `reasoning` SSE text (verbatim model thinking) —
  // `appendReasoning` takes the full run and paints its last non-empty line.
  const turnReasoningRef = useRef("");
  // A multi-step turn streams text in segments separated by tool activity:
  // prose the model emits alongside an intermediate tool step is step
  // narration, NOT the answer — the answer is the LAST text segment.
  // `tool_start` arms this flag and clears the live stream buffer; the next
  // `text_delta` then discards the prior segment from the finalized buffer.
  // Lazy on purpose: an answer-then-bookkeeping-tool turn with no trailing
  // text keeps its answer. (The dock's `pendingAnswerResetRef`, verbatim.)
  const pendingAnswerResetRef = useRef(false);
  const mintEventId = useCallback(() => `ev-${eventSeqRef.current++}`, []);

  const resetTurnActivity = useCallback(() => {
    turnToolsRef.current = [];
    eventLogRef.current = EMPTY_LOG;
    eventSeqRef.current = 0;
    eventedToolIdsRef.current.clear();
    toolStartTimesRef.current.clear();
    pendingAnswerResetRef.current = false;
    turnReasoningRef.current = "";
    turnStartedAtRef.current = null;
    setToolTimeline([]);
    setStreamingEvents([]);
    setResearchPhase(null);
    setTurnStartedAt(null);
  }, []);

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
  // Sessions are assistant-bound (`/api/chat` rejects a send whose
  // `assistantId` doesn't match the session's), so "which assistant am I
  // talking to" is a property of the THREAD: a new chat picks its
  // interlocutor in the composer chip and the session sticks to it; an open
  // thread resolves its bound assistant and never switches mid-thread.
  // Shared workspace chats stay on the primary.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    listWorkspaceAssistants(workspaceId)
      .then((list) => {
        if (!cancelled) setAssistants(list);
      })
      .catch(() => {
        if (!cancelled) setAssistants([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  /** The assistant the CURRENT pane talks to. Open thread → its bound
   *  assistant (adoption record → merged rail row → primary for shared /
   *  unresolved rows); new chat → the picked one, defaulting to primary. */
  const activeAssistant = useMemo<WorkspaceAssistantSummary | null>(() => {
    if (activeSessionId) {
      const boundId =
        sessionAssistantRef.current.get(activeSessionId) ??
        personalSessions.find((r) => r.id === activeSessionId)?.assistantId ??
        null;
      if (boundId) {
        const bound = assistants.find((a) => a.id === boundId);
        if (bound) return bound;
      }
      return primaryAssistant;
    }
    if (pickedAssistantId) {
      return (
        assistants.find((a) => a.id === pickedAssistantId) ?? primaryAssistant
      );
    }
    return primaryAssistant;
  }, [activeSessionId, personalSessions, assistants, pickedAssistantId, primaryAssistant]);

  // ── Shared sessions ─────────────────────────────────────────────────
  // The rail itself lives in the sidebar panel; the surface still needs the
  // shared list to know whether the OPEN thread is shared (the header badge
  // and the live-read subscription hang off that).
  const reloadShared = useCallback(async () => {
    try {
      setSharedSessions(await listWorkspaceSessions({ workspaceId }));
    } catch {
      // Keep the last known list — a transient failure must not flip a
      // shared thread's badge off.
    }
  }, [workspaceId]);

  useEffect(() => {
    void reloadShared();
  }, [reloadShared]);

  /** The merged personal rail — the surface's copy exists to resolve an open
   *  thread's assistant binding (deep links included), not to render a list. */
  const reloadPersonal = useCallback(async () => {
    if (assistants.length === 0) return;
    setPersonalSessions(
      await listSessionsForAssistants({
        workspaceId,
        assistantIds: assistants.map((a) => a.id),
      }),
    );
  }, [assistants, workspaceId]);

  useEffect(() => {
    void reloadPersonal();
  }, [reloadPersonal]);

  // The sidebar panel signals list changes (its rename / delete) here; the
  // surface re-fetches both copies so the shared badge and thread→assistant
  // resolution never go stale. Signals, never data.
  useEffect(() => {
    const handler = () => {
      void reloadShared();
      void reloadPersonal();
    };
    window.addEventListener(CHAT_SESSIONS_REFRESH_EVENT, handler);
    return () => window.removeEventListener(CHAT_SESSIONS_REFRESH_EVENT, handler);
  }, [reloadShared, reloadPersonal]);

  // ── Hydrate the open thread ─────────────────────────────────────────
  /** Load a thread's persisted transcript into the reducer. Assistant rows
   *  restore their `tool_use` blocks as a done-status receipt (re-narrated
   *  from each call's input, no timings — same as the dock's history
   *  restore). Also the refetch the live-read path runs when a teammate's
   *  turn lands — the SSE payload is a SIGNAL, never the data. */
  const loadTranscript = useCallback(async (sessionId: string) => {
    const rows = await fetchSessionMessages(sessionId);
    const rendered: SurfaceMessage[] = rows
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) => {
        const toolsUsed =
          r.role === "assistant"
            ? extractToolUses(r.content).map((use): ToolUsed => {
                const described = describeToolFromInput(
                  use.name,
                  use.input,
                  tChat.toolNarration,
                );
                return {
                  id: use.id,
                  name: use.name,
                  status: "done" as const,
                  description: described.description,
                  ...(described.url ? { url: described.url } : {}),
                };
              })
            : [];
        return {
          id: r.id,
          role: r.role as "user" | "assistant",
          text: extractMessageText(r.content),
          timestamp: new Date(r.timestamp),
          ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
          ...(r.senderName ? { senderName: r.senderName } : {}),
        };
      })
      .filter((m) => m.text.length > 0 || (m.toolsUsed?.length ?? 0) > 0);
    chat.loadMessages(rendered);
    // `chat.loadMessages` is a stable useCallback from the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tChat.toolNarration]);

  useEffect(() => {
    if (activeSessionId === hydratedRef.current) return;
    // Thread switches now arrive from the sidebar panel via the URL, so the
    // in-flight stream (if any) belongs to the OLD thread — kill it before
    // painting the new one, exactly what the old in-surface rail did on
    // row click.
    stream.abort();
    chat.dispatch({ type: "stream/abort" });
    resetTurnActivity();
    setError(null);
    hydratedRef.current = activeSessionId;
    sessionIdRef.current = activeSessionId;
    if (!activeSessionId) {
      chat.loadMessages([]);
      // Back on a fresh pane: the assistant pick is per chat, so it resets
      // to the primary default rather than sticking as a preference.
      setPickedAssistantId(null);
      return;
    }
    let cancelled = false;
    void loadTranscript(activeSessionId).then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
    // `chat.*` and `stream.abort` are stable callbacks from their hooks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, loadTranscript, resetTurnActivity]);

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
                void reloadShared();
                dispatchChatSessionsRefresh(workspaceId);
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
  }, [activeSessionId, activeShared, activeShared?.status, chat.state.isStreaming, loadTranscript, reloadShared, workspaceId]);

  // Keep the transcript pinned to the newest turn as it streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    chat.state.messages,
    chat.state.streamingText,
    streamingEvents,
    toolTimeline,
    remoteTurn,
  ]);

  const resetPane = useCallback(() => {
    stream.abort();
    hydratedRef.current = null;
    sessionIdRef.current = null;
    setError(null);
    setInput("");
    chat.loadMessages([]);
    chat.dispatch({ type: "stream/abort" });
    resetTurnActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, resetTurnActivity]);

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
      dispatchChatSessionsRefresh(workspaceId);
    } catch {
      setError(t.newWorkspaceChatFailed);
    } finally {
      setStartingShared(false);
    }
  }, [resetPane, selectSession, startingShared, t, workspaceId]);

  /** Stop the in-flight turn. Aborted streams fire neither onDone nor
   *  onError, so the state resets here (the dock's `handleAbort`). */
  const handleAbort = useCallback(() => {
    stream.abort();
    chat.dispatch({ type: "stream/abort" });
    turnTextRef.current = "";
    resetTurnActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, resetTurnActivity]);

  const copyResetRef = useRef<number | null>(null);
  const handleCopy = useCallback((messageId: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedMessageId(messageId);
    if (copyResetRef.current != null) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => setCopiedMessageId(null), 1500);
  }, []);

  // ── Send ────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const trimmed = input.trim();
    // Snapshot the interlocutor at send time — the turn belongs to it even
    // if the resolution inputs shift while the reply streams.
    const interlocutor = activeAssistant;
    if (!trimmed || !interlocutor || chat.state.isStreaming) return;

    // First send in a fresh Workspace pane: create the shared thread FIRST
    // (the explicit-create API — the thread is listable by teammates from
    // this moment), then stream this message into it. Without this a
    // session-less send would mint a PERSONAL session while the UI says
    // Workspace. The create happens before the optimistic paint so a
    // failure leaves the draft in the box instead of a stranded bubble.
    if (view === "workspace" && !sessionIdRef.current) {
      if (startingShared) return;
      setStartingShared(true);
      try {
        const created = await createWorkspaceSession(workspaceId);
        sessionIdRef.current = created.id;
        hydratedRef.current = created.id;
        setSharedSessions((rows) => [created, ...rows]);
        chat.setSession(created.id);
        selectSession(created.id, "workspace");
        dispatchChatSessionsRefresh(workspaceId);
      } catch {
        setError(t.newWorkspaceChatFailed);
        return;
      } finally {
        setStartingShared(false);
      }
    }

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
    resetTurnActivity();
    turnStartedAtRef.current = Date.now();
    setTurnStartedAt(turnStartedAtRef.current);

    await stream.start({
      url: `${API_URL}/api/chat`,
      authFetch: (url, init) => authFetch(String(url), init),
      body: {
        message: trimmed,
        workspaceId,
        assistantId: interlocutor.id,
        appOrigin: APP_ORIGIN,
        // The picked tier rides every turn; the server clamps to plan.
        model,
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
              // Record the binding so the next turn resolves this thread to
              // the SAME assistant before the rail refetch lands.
              sessionAssistantRef.current.set(id, interlocutor.id);
              chat.setSession(id);
              selectSession(id);
              // The fresh thread is now listable — tell the sidebar rail.
              dispatchChatSessionsRefresh(workspaceId);
            }
            break;
          }
          case "text_delta": {
            const delta = typeof payload.text === "string" ? payload.text : "";
            if (delta) {
              // A new answer segment after intermediate tool activity — the
              // prior segment was step narration, not the answer. Discard it
              // from the finalized buffer so only the last segment survives.
              if (pendingAnswerResetRef.current) {
                pendingAnswerResetRef.current = false;
                turnTextRef.current = "";
              }
              turnTextRef.current += delta;
              chat.dispatch({ type: "stream/append", text: delta });
            }
            break;
          }
          case "reasoning": {
            // Verbatim model thinking, token-by-token. Coalesced into one
            // advancing line in the chronological event log until a step
            // closes it (build-events.ts).
            const delta = typeof payload.text === "string" ? payload.text : "";
            if (delta) {
              turnReasoningRef.current += delta;
              const next = appendReasoning(
                eventLogRef.current,
                turnReasoningRef.current,
                mintEventId,
              );
              if (next !== eventLogRef.current) {
                eventLogRef.current = next;
                setStreamingEvents(next.events);
              }
            }
            break;
          }
          case "tool_start": {
            const id = typeof payload.id === "string" ? payload.id : "";
            const name = typeof payload.name === "string" ? payload.name : "";
            if (!id || !name) break;
            // Dedup — re-emits keep the existing row.
            if (turnToolsRef.current.some((tool) => tool.id === id)) break;
            // Arm the answer-segment reset and clear the live stream buffer
            // so stale narration stops showing while the tool runs. See
            // `pendingAnswerResetRef` above.
            if (!pendingAnswerResetRef.current) {
              pendingAnswerResetRef.current = true;
              chat.dispatch({ type: "stream/reset" });
            }
            toolStartTimesRef.current.set(id, performance.now());
            // Seed the friendliest label we can before the input parses;
            // `tool_input` upgrades it moments later.
            const seeded = describeToolFromInput(name, {}, tChat.toolNarration);
            turnToolsRef.current = [
              ...turnToolsRef.current,
              { id, name, status: "running", description: seeded.description },
            ];
            setToolTimeline(turnToolsRef.current);
            eventLogRef.current = appendStep(
              eventLogRef.current,
              seeded.description,
              mintEventId,
              { toolId: id },
            );
            setStreamingEvents(eventLogRef.current.events);
            break;
          }
          case "tool_dropped": {
            // The engine stripped this call from the persisted turn —
            // retract the phantom step so the live UI matches what was saved.
            const id = typeof payload.id === "string" ? payload.id : "";
            if (!id) break;
            turnToolsRef.current = turnToolsRef.current.filter(
              (tool) => tool.id !== id,
            );
            setToolTimeline(turnToolsRef.current);
            eventLogRef.current = removeToolSteps(eventLogRef.current, id);
            setStreamingEvents(eventLogRef.current.events);
            eventedToolIdsRef.current.delete(id);
            toolStartTimesRef.current.delete(id);
            break;
          }
          case "tool_input": {
            // Upgrade the placeholder row to the input-aware narration.
            const id = typeof payload.id === "string" ? payload.id : "";
            const name = typeof payload.name === "string" ? payload.name : "";
            if (!id) break;
            const inputPayload =
              payload.input && typeof payload.input === "object"
                ? (payload.input as Record<string, unknown>)
                : {};
            const narration = describeToolFromInput(
              name,
              inputPayload,
              tChat.toolNarration,
            );
            if (!narration) break;
            turnToolsRef.current = turnToolsRef.current.map((tool) =>
              tool.id === id
                ? {
                    ...tool,
                    description: narration.description,
                    ...(narration.url ? { url: narration.url } : {}),
                  }
                : tool,
            );
            setToolTimeline(turnToolsRef.current);
            if (!eventedToolIdsRef.current.has(id)) {
              eventedToolIdsRef.current.add(id);
              eventLogRef.current = updateStepText(
                eventLogRef.current,
                id,
                narration.description,
                narration.url,
              );
              setStreamingEvents(eventLogRef.current.events);
            }
            break;
          }
          case "tool_result": {
            const id = typeof payload.id === "string" ? payload.id : "";
            if (!id) break;
            const isError = payload.isError === true;
            const errorMessage =
              typeof payload.errorMessage === "string"
                ? payload.errorMessage
                : undefined;
            const startedAtMs = toolStartTimesRef.current.get(id);
            const durationMs =
              startedAtMs != null
                ? Math.max(0, Math.round(performance.now() - startedAtMs))
                : undefined;
            turnToolsRef.current = turnToolsRef.current.map((tool) =>
              tool.id === id
                ? {
                    ...tool,
                    status: isError ? ("retried" as const) : ("done" as const),
                    ...(durationMs != null ? { durationMs } : {}),
                    ...(isError && errorMessage ? { errorMessage } : {}),
                  }
                : tool,
            );
            setToolTimeline(turnToolsRef.current);
            break;
          }
          case "status": {
            // Research / coordinator phase codes only — `message`-only
            // statuses stay silent, same as the dock.
            const phase = typeof payload.phase === "string" ? payload.phase : "";
            if (phase === "research_detected") setResearchPhase("detected");
            else if (phase === "research_starting") setResearchPhase("starting");
            else if (phase === "research_parallel") setResearchPhase("parallel");
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
            // Every other event (citations, confirmations, view payloads) is
            // dock-only chrome for now. Ignoring an unknown event is the
            // additive contract: a newer server must never break this client.
            break;
        }
      },
      onDone: () => {
        const finalText = turnTextRef.current.trim();
        // Close any step the server never resolved, so the receipt shows a
        // finished turn rather than a spinner frozen mid-flight.
        const tools = turnToolsRef.current.map((tool) =>
          tool.status === "running" ? { ...tool, status: "done" as const } : tool,
        );
        const activityDurationMs =
          turnStartedAtRef.current != null
            ? Date.now() - turnStartedAtRef.current
            : undefined;
        if (finalText || tools.length > 0) {
          chat.dispatch({
            type: "stream/finalize",
            finalMessage: {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              text: finalText,
              timestamp: new Date(),
              ...(tools.length > 0 ? { toolsUsed: tools } : {}),
              ...(activityDurationMs != null ? { activityDurationMs } : {}),
            } satisfies Message,
          });
        } else {
          chat.dispatch({ type: "stream/abort" });
        }
        turnTextRef.current = "";
        resetTurnActivity();
        void reloadShared();
        // The turn may have auto-titled the thread — refresh the rail.
        dispatchChatSessionsRefresh(workspaceId);
      },
      onError: () => {
        chat.dispatch({ type: "stream/abort" });
        resetTurnActivity();
        setError(t.errorGeneric);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, activeAssistant, model, view, workspaceId, chat.state.isStreaming, reloadShared, resetTurnActivity, selectSession, startingShared, stream, t, tChat.toolNarration]);

  // The Personal/Workspace segmented control. Deliberately louder than a
  // typical tab pair (icons + roomier hit area): posting into a shared thread
  // versus a private one is a real audience change, so which mode is active
  // has to be legible at a glance.
  const viewTabCls = (active: boolean) =>
    cn(
      "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
      active
        ? "bg-background text-foreground shadow-sm"
        : "text-sidebar-foreground/60 hover:text-sidebar-accent-foreground",
    );

  /** The reply avatar — the open thread's bound assistant, like the dock. */
  const replyAvatar = activeAssistant ? (
    <div className="mt-0.5 shrink-0">
      <AssistantAvatar
        id={activeAssistant.id}
        name={activeAssistant.name}
        iconSeed={activeAssistant.iconSeed ?? undefined}
        size="sm"
      />
    </div>
  ) : (
    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
      <Sparkles className="size-3.5" aria-hidden />
    </div>
  );

  const copyButton = (messageId: string, text: string, alignEnd: boolean) => (
    <div
      className={cn(
        "flex items-center gap-1 pt-0.5 opacity-0 transition-opacity group-hover:opacity-100",
        alignEnd ? "-mr-1" : "-ml-1",
      )}
    >
      <button
        type="button"
        onClick={() => handleCopy(messageId, text)}
        aria-label={copiedMessageId === messageId ? tChat.copied : tChat.copy}
        title={copiedMessageId === messageId ? tChat.copied : tChat.copy}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {copiedMessageId === messageId ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </div>
  );

  /** Fresh pane with nothing painted — render the new-chat hero instead of an
   *  empty transcript over a bottom bar. Any open/adopted session, streamed
   *  text, or teammate turn drops back to the normal transcript layout. */
  const heroMode =
    !activeSessionId &&
    chat.state.messages.length === 0 &&
    !chat.state.isStreaming &&
    remoteTurn === null;

  /** Interlocutor control, rendered INSIDE the composer box (bottom-left):
   *  a NEW personal chat picks its assistant here and the session sticks to
   *  it (sessions are assistant-bound; the server rejects a mismatched
   *  send). An open thread shows its bound assistant — never a mid-thread
   *  switch. Shared chats stay on the workspace primary. A single-assistant
   *  workspace degrades to the static label. */
  const interlocutorControl =
    activeAssistant &&
    (!activeSessionId && view === "personal" && assistants.length > 1 ? (
      <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
        <PopoverTrigger
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:shadow-none"
          aria-label={tChat.switchAssistant}
        >
          <AssistantAvatar
            id={activeAssistant.id}
            name={activeAssistant.name}
            iconSeed={activeAssistant.iconSeed ?? undefined}
            size="xs"
          />
          <span className="truncate">{activeAssistant.name}</span>
          <ChevronDown
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-60 max-w-[calc(100vw-2rem)] gap-0.5 p-1"
        >
          <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {tChat.switchAssistantTitle}
          </p>
          {assistants.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                setPickedAssistantId(a.id);
                setSwitcherOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                a.id === activeAssistant.id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <AssistantAvatar
                id={a.id}
                name={a.name}
                iconSeed={a.iconSeed ?? undefined}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              {a.id === activeAssistant.id ? (
                <Check className="size-4 shrink-0 text-primary" aria-hidden />
              ) : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    ) : (
      <div className="flex min-w-0 items-center gap-1.5 px-1.5 py-1 text-xs font-medium text-muted-foreground">
        <AssistantAvatar
          id={activeAssistant.id}
          name={activeAssistant.name}
          iconSeed={activeAssistant.iconSeed ?? undefined}
          size="xs"
        />
        <span className="truncate">{activeAssistant.name}</span>
      </div>
    ));

  /** The composer, styled as the app's composite-control box (globals.css
   *  contract): ONE bordered box carrying the focus ring via `focus-within`,
   *  every inner focusable opting out of the global ring. Textarea on top;
   *  a control row beneath with the interlocutor control left and an icon Send
   *  (Stop while streaming) right. Rendered in the hero (centered) or the
   *  bottom bar — same node either way. */
  const composerBox = (
    <div
      className={cn(
        "rounded-xl border border-border bg-background shadow-sm",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35",
      )}
    >
      <ChatComposer
        value={input}
        onChange={setInput}
        onSend={() => void send()}
        sendDisabled={chat.state.isStreaming || !activeAssistant}
        placeholder={t.composerPlaceholder}
        sendLabel={
          <>
            <ArrowUp className="size-4" aria-hidden />
            <span className="sr-only">{t.send}</span>
          </>
        }
        // One flex-wrap container: the textarea takes the full first line
        // (`order-1 basis-full`), the control row wraps beneath it
        // (interlocutor `order-2 mr-auto`, Send/Stop `order-3`).
        rowClassName="flex flex-wrap items-center gap-1 px-2 pb-2"
        textareaClassName={cn(
          "order-1 max-h-[240px] min-w-0 basis-full resize-none overflow-y-auto",
          "bg-transparent px-1.5 pt-2.5 pb-1 text-sm leading-relaxed outline-none",
          "placeholder:text-muted-foreground focus-visible:shadow-none",
        )}
        slotPreInput={
          <div className="order-2 mr-auto flex min-w-0 items-center gap-0.5">
            {interlocutorControl}
            {/* Tier picker (Standard / Pro / Max) — the shared presentational
                control; without research/metered props it renders just the
                Select. Sits beside the assistant picker in the control row. */}
            <ComposerControls
              model={model}
              onModelChange={setModel}
              plan={workspacePlan}
              researchMode={false}
              onResearchModeChange={() => {}}
              researchQuota={null}
              researchExhausted={false}
              selectSide="top"
            />
          </div>
        }
        sendButtonClassName={cn(
          "order-3 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          "bg-primary text-primary-foreground transition-colors hover:bg-primary/90",
          "focus-visible:shadow-none disabled:opacity-40 disabled:pointer-events-none",
          chat.state.isStreaming && "hidden",
        )}
        slotPostInput={
          chat.state.isStreaming ? (
            <button
              type="button"
              onClick={handleAbort}
              aria-label={tChat.abort}
              title={tChat.abort}
              className={cn(
                "order-3 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                "bg-muted text-foreground/80 transition-colors hover:bg-muted/80 hover:text-destructive",
                "focus-visible:shadow-none",
              )}
            >
              <Square className="size-3.5 fill-current" aria-hidden />
            </button>
          ) : null
        }
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OperatorTopbar
        app="chat"
        center={
          <div
            role="tablist"
            aria-label={t.viewSwitchAria}
            className="flex items-center gap-0.5 rounded-lg bg-sidebar-accent/60 p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "personal"}
              onClick={() => selectSession(null, "personal")}
              className={viewTabCls(view === "personal")}
            >
              <User className="size-3.5" aria-hidden />
              {t.viewPersonal}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "workspace"}
              onClick={() => selectSession(null, "workspace")}
              className={viewTabCls(view === "workspace")}
            >
              <Users className="size-3.5" aria-hidden />
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

      {/* ── Hero / transcript + composer ──────────────────────────── */}
      {heroMode ? (
        // Fresh pane: the new-chat hero — ONE skeleton for both views
        // (identity, title, composer mid-screen), so switching the toggle
        // reads as changing the audience, not changing apps. Workspace adds
        // the shared-audience explainer, and its first send creates the
        // shared thread before streaming into it (see `send`).
        <section className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="flex w-full max-w-2xl flex-col items-center gap-5">
            {activeAssistant && (
              <div className="flex flex-col items-center gap-2.5 text-center">
                <AssistantAvatar
                  id={activeAssistant.id}
                  name={activeAssistant.name}
                  iconSeed={activeAssistant.iconSeed ?? undefined}
                  size="lg"
                />
                <h2 className="text-lg font-semibold text-foreground">
                  {view === "workspace"
                    ? t.workspaceHeroTitle
                    : format(t.heroTitle, { name: activeAssistant.name })}
                </h2>
                {view === "workspace" && (
                  <p className="flex items-center gap-1.5 text-sm leading-relaxed text-muted-foreground">
                    <Users className="size-4 shrink-0" aria-hidden />
                    {t.sharedTranscriptEmpty}
                  </p>
                )}
              </div>
            )}
            <div className="w-full">{composerBox}</div>
            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        </section>
      ) : (
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
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
            {chat.state.messages.length === 0 &&
              !chat.state.isStreaming &&
              remoteTurn === null && (
                <p className="py-20 text-center text-sm text-muted-foreground">
                  {activeShared ? t.sharedTranscriptEmpty : t.transcriptEmpty}
                </p>
              )}
            {(chat.state.messages as SurfaceMessage[]).map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="group flex flex-col items-end">
                  {/* Attribution chip — only in a shared thread, and only for
                      turns that are not the viewer's own (a bubble labelled
                      with your own name is noise). */}
                  {m.senderName && (
                    <span className="mb-0.5 px-1 text-[11px] text-muted-foreground">
                      {m.senderName}
                    </span>
                  )}
                  {/* Neutral Notion-style bubble — the dock's `--secondary`
                      surface, NOT a saturated primary fill (white-on-blue
                      missed WCAG AA; the brand blue stays on small accents). */}
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[14px] leading-[1.5] break-words whitespace-pre-wrap text-secondary-foreground shadow-sm">
                    {m.text}
                  </div>
                  {copyButton(m.id, m.text, true)}
                </div>
              ) : (
                <div key={m.id} className="group flex gap-2.5">
                  {replyAvatar}
                  <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
                    {m.toolsUsed?.length ? (
                      <ChatActivitySummary
                        tools={m.toolsUsed}
                        durationMs={m.activityDurationMs}
                      />
                    ) : null}
                    {m.text ? (
                      <div className={MARKDOWN_CLS}>
                        <ChatMarkdown text={m.text} remarkPlugins={REMARK_PLUGINS} />
                      </div>
                    ) : null}
                    {m.text ? copyButton(m.id, m.text, false) : null}
                  </div>
                </div>
              ),
            )}
            {/* Live turn — the dock's activity feed (shimmer status +
                reasoning/tool steps) above the streaming reply + caret. */}
            {chat.state.isStreaming && (
              <div className="flex gap-2.5">
                {replyAvatar}
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <ChatActivityFeed
                    events={streamingEvents}
                    tools={toolTimeline}
                    replyStreaming={chat.state.streamingText.length > 0}
                    researchPhase={researchPhase}
                    startedAt={turnStartedAt}
                  />
                  {chat.state.streamingText ? (
                    <div className={MARKDOWN_CLS}>
                      <ChatMarkdown
                        text={chat.state.streamingText}
                        remarkPlugins={REMARK_PLUGINS}
                      />
                      <span
                        aria-hidden
                        className="ml-0.5 inline-block h-[16px] w-[2px] rounded-full bg-primary align-text-bottom shadow-[0_0_8px_var(--primary)] animate-pulse"
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            )}
            {/* A teammate's turn, relayed off the per-session event bus. Its
                text is the live snapshot; when the turn settles we refetch
                the PERSISTED transcript rather than keeping this. */}
            {remoteTurn !== null && !chat.state.isStreaming && (
              <div className="flex gap-2.5">
                {replyAvatar}
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  {remoteTurn ? (
                    <div className={MARKDOWN_CLS}>
                      <ChatMarkdown text={remoteTurn} remarkPlugins={REMARK_PLUGINS} />
                    </div>
                  ) : (
                    <span
                      role="status"
                      className="chat-shimmer-text text-xs font-medium"
                    >
                      {t.teammateWorking}
                    </span>
                  )}
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Composer bar — the same composite box the hero centers, docked. */}
        <div className="shrink-0 px-4 pb-4 pt-1">
          <div className="mx-auto w-full max-w-3xl">{composerBox}</div>
        </div>
      </section>
      )}
    </div>
  );
}
