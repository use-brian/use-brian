"use client";

/**
 * Chat operator app — the full-page, ChatGPT-style chat surface at
 * `/w/<workspaceId>/chat`, the 6th operator app under Home.
 *
 * NOT a fork of the floating dock (`components/chrome/floating-chat.tsx`).
 * That component is 3.9k lines because it carries every doc-authoring
 * affordance — page anchoring, theme refinement, deck previews and floating
 * panel lifecycle. None of that belongs to a standalone chat, and copying it
 * would mean two divergent chat clients. Ordinary chat affordances DO belong
 * here: attachment pick/drop/paste, research, citations, outbound files,
 * retry/copy, and per-code-block copy all reuse the dock's shared seams.
 * This surface is built on
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
 * Layout: `OperatorTopbar` (view tabs + New chat) over transcript + composer;
 * shared rooms keep a persistent collapsible/resizable right-hand Work Bench
 * for live work, metadata, and pinned context without adding full-width rows
 * to the transcript.
 * The session rail lives in the LEFT SIDEBAR panel
 * (`doc/sidebar-panels/chat-sidebar-panel.tsx`), like every other operator
 * app — list in the sidebar, work in the body. The two coordinate through
 * URL state and `CHAT_SESSIONS_REFRESH_EVENT` (signals, never data).
 *
 * Assistant choice is PER CHAT: a new personal chat picks its interlocutor
 * in the composer chip (defaulting to the workspace primary) and the session
 * sticks to it — sessions are assistant-bound, and `/api/chat` rejects a
 * mismatched send. An open thread resolves and displays its bound assistant;
 * a room binds the assistant picked at creation (default the primary).
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
  type ChatFileAttachment,
  type CitationSource,
  type DocumentAttachment,
  type PendingConfirmation,
  type ToolUsed,
} from "@use-brian/chat-ui";
import remarkGfm from "remark-gfm";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Copy,
  Paperclip,
  Plus,
  RotateCw,
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
  ChatCitationList,
  type ResearchPhase,
} from "@/components/chrome/chat-activity";
import { ChatCodeBlock } from "@/components/chrome/chat-code-block";
import { ChatFileAttachments } from "@/components/chrome/chat-file-attachment";
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
  dispatchChatSessionActivity,
  dispatchChatSessionsRefresh,
  shouldAcceptRoomMirror,
} from "@/lib/chat-session-events";
import {
  createWorkspaceSession,
  extractMessageText,
  extractPresentedDocuments,
  extractToolUses,
  listSessionsForAssistants,
  listWorkspaceSessions,
  fetchSessionMessages,
  parseMessageAttachments,
  parsePresentedDocumentPayload,
  postRoomMessage,
  type MessageAttachmentRef,
  type DocSession,
  type WorkspaceSession,
} from "@/lib/api/sessions";
import { getUserInfo } from "@/lib/user";
import { markRoomSeen } from "@/lib/chat-seen";
import { fetchPendingQuestion } from "@/lib/api/pending-questions";
import { PendingQuestionPanel } from "@/components/chrome/pending-question-panel";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import { ChatContextPins } from "@/components/chat-app/chat-context-pins";
import { resolveRequestedFreshAssistant } from "@/components/chat-app/assistant-deeplink";
import {
  resolveMentionedAssistants,
  resolveWorkBenchAssistant,
} from "@/components/chat-app/multi-assistant-response";
import {
  imageFilesFromClipboard,
  readyAttachments,
  useFileAttachments,
} from "@/lib/use-file-attachments";
import { useFileDrop } from "@/lib/use-file-drop";
import {
  AttachmentChips,
  FileDropOverlay,
} from "@/components/doc/attachment-chips";
import { MessageAttachments } from "@/components/doc/message-attachment-card";
import { useRecordingUpload } from "@/lib/recordings/use-recording-upload";
import {
  ChatDocumentCard,
  ChatDocumentViewer,
} from "@/components/chat-app/chat-document-viewer";
import {
  coalesceAssistantRunMessages,
  type ChatSurfaceMessage as SurfaceMessage,
} from "@/components/chat-app/chat-transcript";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const REMARK_PLUGINS = [remarkGfm];
const CHAT_MARKDOWN_COMPONENTS = { pre: ChatCodeBlock };

/** The surface tag stamped on sessions minted here (migration 255). */
const APP_ORIGIN = "chat";

/** The dock's assistant-reply markdown wrapper, verbatim. */
const MARKDOWN_CLS =
  "chat-markdown prose prose-sm dark:prose-invert max-w-none text-[14px] leading-[1.6] text-foreground break-words";

/** Narrow an SSE `data` payload to an object without trusting its shape. */
function coercePayload(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/** A pending write confirmation observed by a room VIEWER (T11/D8 — mirrored
 *  off the per-session bus; the server gates who may act on it). */
type RemoteConfirmation = {
  toolCallId: string;
  toolName: string;
  displayName?: string;
  input: Record<string, unknown>;
  description?: string;
  displayLines?: string[];
  addresserUserId: string | null;
};

export function ChatSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT().chatApp;
  // The dock's chat dictionary — tool narration, activity copy, copy/stop
  // labels. Reused verbatim so the two surfaces never phrase one thing twice.
  const tChat = useT().chat;
  const tAttach = useT().attachments;
  const tRecordings = useT().recordings;
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
  const [researchMode, setResearchMode] = useState(false);
  const [researchQuota, setResearchQuota] = useState<{
    used: number;
    quota: number;
    isPaid: boolean;
  } | null>(null);
  const [researchExhausted, setResearchExhausted] = useState(false);
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
  /** The source currently occupying the Chat app's right-hand split pane. */
  const [openDocument, setOpenDocument] = useState<DocumentAttachment | null>(null);
  /** The viewer's own user id — filters this client's OWN turn out of the
   *  room's bus mirror (it streams over this client's POST already). */
  const meId = getUserInfo()?.id ?? null;
  /** The composer's Ask affordance (D1/T3): arms address intent for the next
   *  send in a room without typing a mention. Reset after each send. */
  const [askArmed, setAskArmed] = useState(false);
  /** Quiet "will reply after this" line (T5) — set by the server's `queued`
   *  SSE event, cleared when a turn settles. */
  const [queuedNotice, setQueuedNotice] = useState(false);
  /** `@` autocomplete popover (T12 — assistants only). */
  const [mentionOpen, setMentionOpen] = useState(false);
  /** A suspended askQuestion in the open room / thread (T11/D8). */
  const [pendingQuestion, setPendingQuestion] = useState<{
    approvalId: string;
    question: string;
    expiresAt: string | null;
    sessionId: string;
  } | null>(null);
  /** A teammate-turn write confirmation, mirrored to every viewer (T11). */
  const [remoteConfirmation, setRemoteConfirmation] = useState<RemoteConfirmation | null>(null);

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
  /** The room whose original POST stream this mounted surface is painting.
   *  Cleared as soon as that ownership ends so the persistent room-follow
   *  stream can take over, including for turns started by this same user. */
  const directTurnSessionRef = useRef<string | null>(null);
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
  /** The assistant ANSWERING my in-flight turn (T9 — `@Name` may pick a
   *  non-bound assistant); drives the streaming reply's avatar. */
  const turnAssistantRef = useRef<string | null>(null);
  /** Stop applies to the whole explicit multi-assistant response group, not
   *  just whichever serialized assistant is currently streaming. */
  const responseGroupAbortRef = useRef(false);

  // ── Per-turn activity state (the dock's streaming model, trimmed) ───
  // The chronological build-event log (reasoning runs + tool steps in true
  // SSE order) drives <ChatActivityFeed>; the tool timeline carries per-step
  // status/duration and becomes the committed message's receipt.
  const [toolTimeline, setToolTimeline] = useState<ToolUsed[]>([]);
  const [streamingEvents, setStreamingEvents] = useState<BuildEvent[]>([]);
  const [researchPhase, setResearchPhase] = useState<ResearchPhase | null>(null);
  const [citations, setCitations] = useState<CitationSource[]>([]);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const turnToolsRef = useRef<ToolUsed[]>([]);
  const turnDocumentsRef = useRef<DocumentAttachment[]>([]);
  const turnCitationsRef = useRef<CitationSource[]>([]);
  const turnFileAttachmentsRef = useRef<ChatFileAttachment[]>([]);
  const turnWorkerDescriptionsRef = useRef<Map<string, string>>(new Map());
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
    turnDocumentsRef.current = [];
    turnCitationsRef.current = [];
    turnFileAttachmentsRef.current = [];
    turnWorkerDescriptionsRef.current = new Map();
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
    setCitations([]);
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
  // A room binds the assistant picked at creation (default the primary).
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

  // First-party installers can open a fresh standard chat with one assistant
  // preselected. Existing sessions ignore this hint because their persisted
  // assistant binding remains authoritative.
  useEffect(() => {
    if (activeSessionId) return;
    const requested = resolveRequestedFreshAssistant(
      searchParams?.get("assistant") ?? null,
      assistants,
    );
    if (requested) setPickedAssistantId(requested);
  }, [activeSessionId, assistants, searchParams]);

  /** The assistant the CURRENT pane talks to. Open thread → its bound
   *  assistant (adoption record → merged rail row → primary for shared /
   *  unresolved rows); new chat → the picked one, defaulting to primary. */
  const activeAssistant = useMemo<WorkspaceAssistantSummary | null>(() => {
    if (activeSessionId) {
      // Rooms bind ANY workspace assistant at creation (default primary) —
      // the shared row echoes the binding, so mention/Ask labels, avatars
      // and sends all resolve to the room's own assistant.
      const boundId =
        sessionAssistantRef.current.get(activeSessionId) ??
        activeShared?.assistantId ??
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
  }, [activeSessionId, activeShared, personalSessions, assistants, pickedAssistantId, primaryAssistant]);

  // The full-page surface uses the SAME attachment lanes as the dock:
  // transient cache upload for ordinary files, direct recording ingestion for
  // video / recording-length audio, and one tray for pick, drop, and paste.
  const recordingUpload = useRecordingUpload(
    workspaceId,
    activeAssistant?.id ?? "",
  );
  const att = useFileAttachments(
    () => sessionIdRef.current ?? undefined,
    {
      onRouteMedia: activeAssistant
        ? (files) => {
            void (async () => {
              for (const file of files) await recordingUpload.run(file);
            })();
          }
        : undefined,
    },
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const drop = useFileDrop((files) => void att.upload(files), {
    disabled: !!pendingQuestion,
  });

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
    const persistedRows: SurfaceMessage[] = rows
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) => {
        const parsedUser =
          r.role === "user" ? parseMessageAttachments(r.content) : null;
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
        const documents =
          r.role === "assistant" ? extractPresentedDocuments(r.content) : [];
        return {
          id: r.id,
          role: r.role as "user" | "assistant",
          text: parsedUser?.text ?? extractMessageText(r.content),
          timestamp: new Date(r.timestamp),
          ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
          ...(documents.length > 0 ? { documents } : {}),
          ...(r.attachments && r.attachments.length > 0
            ? { fileAttachments: r.attachments }
            : {}),
          ...(parsedUser && parsedUser.attachments.length > 0
            ? { userAttachments: parsedUser.attachments }
            : {}),
          ...(r.senderName ? { senderName: r.senderName } : {}),
          ...(r.senderAssistantId ? { senderAssistantId: r.senderAssistantId } : {}),
        };
      })
      .filter(
        (m) =>
          m.text.length > 0 ||
          (m.toolsUsed?.length ?? 0) > 0 ||
          (m.userAttachments?.length ?? 0) > 0 ||
          (m.fileAttachments?.length ?? 0) > 0 ||
          (m.documents?.length ?? 0) > 0,
      );
    chat.loadMessages(coalesceAssistantRunMessages(persistedRows));
    // `chat.loadMessages` is a stable useCallback from the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tChat.toolNarration]);

  useEffect(() => {
    if (activeSessionId === hydratedRef.current) return;
    // Thread switches now arrive from the sidebar panel via the URL, so the
    // in-flight stream (if any) belongs to the OLD thread — kill it before
    // painting the new one, exactly what the old in-surface rail did on
    // row click.
    responseGroupAbortRef.current = true;
    directTurnSessionRef.current = null;
    stream.abort();
    chat.dispatch({ type: "stream/abort" });
    resetTurnActivity();
    att.clear();
    setError(null);
    setOpenDocument(null);
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

  // ── Live room follow (T13) ──────────────────────────────────────────
  // Every open viewer of a room holds ONE persistent subscription to the
  // per-session stream (follow mode): teammate posts fan in live, a
  // teammate's turn paints through the SAME feed pipeline the sender uses
  // (build-events + tool-narration), suspended turns surface, and settle
  // refetches the persisted transcript — events are signals, never data.
  // This client's OWN turn is filtered out only while this mounted surface's
  // exact-room POST is still painting it. Navigation/re-entry releases that
  // ownership, so the follow stream becomes the returning sender's live view.
  const [remoteActive, setRemoteActive] = useState(false);
  /** The assistant answering the REMOTE turn (from the turn_started /
   *  snapshot mirror) — viewers render the right avatar live. */
  const [remoteAssistantId, setRemoteAssistantId] = useState<string | null>(null);
  const [remoteText, setRemoteText] = useState("");
  const [remoteEvents, setRemoteEvents] = useState<BuildEvent[]>([]);
  const [remoteTools, setRemoteTools] = useState<ToolUsed[]>([]);
  const remoteLogRef = useRef<EventLog>(EMPTY_LOG);
  const remoteToolsRef = useRef<ToolUsed[]>([]);
  const remoteSeqRef = useRef(0);
  const remoteNarratedRef = useRef<Set<string>>(new Set());
  /** Bumped to re-open the stream after a server close (deploy, restart). */
  const [subscribeEpoch, setSubscribeEpoch] = useState(0);
  /** Bumped by the room stream's `pins_changed` signal — Work Bench
   *  refetches through its own loader (signals, never data). */
  const [pinsEpoch, setPinsEpoch] = useState(0);
  /** The room's working frame is a persistent right rail. Expanded is the
   *  remembered resizable drawer; collapsed is one icon-only column. */
  const [workBenchExpanded, setWorkBenchExpanded] = useState(true);
  const isSharedOpen = !!activeShared;

  const resetRemoteTurn = useCallback(() => {
    setRemoteAssistantId(null);
    remoteLogRef.current = EMPTY_LOG;
    remoteToolsRef.current = [];
    remoteNarratedRef.current.clear();
    setRemoteActive(false);
    setRemoteText("");
    setRemoteEvents([]);
    setRemoteTools([]);
  }, []);

  const refreshPendingQuestion = useCallback(
    (sessionId: string) => {
      void fetchPendingQuestion(sessionId)
        .then((q) => {
          setPendingQuestion(
            q
              ? {
                  approvalId: q.approvalId,
                  question: q.question ?? "",
                  expiresAt: q.expiresAt,
                  sessionId,
                }
              : null,
          );
        })
        .catch(() => {});
    },
    [],
  );

  useEffect(() => {
    if (!activeSessionId || !isSharedOpen) {
      resetRemoteTurn();
      setRemoteConfirmation(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const sessionId = activeSessionId;
    const mintRemoteId = () => `rev-${remoteSeqRef.current++}`;

    // Opening a room reads it — stamp the unread watermark (T7).
    markRoomSeen(workspaceId, sessionId);

    // A room found suspended on open surfaces its answer panel immediately
    // (any member with read access may answer — D8).
    refreshPendingQuestion(sessionId);

    const handleRoomEvent = (event: string, payload: Record<string, unknown>) => {
      const sender = typeof payload.senderUserId === "string" ? payload.senderUserId : null;
      const acceptsMirror = shouldAcceptRoomMirror({
        senderUserId: sender,
        viewerUserId: meId,
        sessionId,
        directTurnSessionId: directTurnSessionRef.current,
        directStreamInFlight: stream.inFlight(),
      });
      const ownsDirectStream =
        directTurnSessionRef.current === sessionId && stream.inFlight();
      switch (event) {
        case "status": {
          const working = payload.status === "running";
          // A GET opened just before this page's POST may carry a stale `idle`
          // frame after the optimistic start signal. Never let it erase live
          // direct ownership; a returning page has no such owner and trusts
          // the server status in both directions.
          if (working || !ownsDirectStream) {
            dispatchChatSessionActivity({ workspaceId, sessionId, working });
          }
          if (working && acceptsMirror) setRemoteActive(true);
          break;
        }
        case "user_message_saved": {
          if (!acceptsMirror) break;
          void loadTranscript(sessionId);
          markRoomSeen(workspaceId, sessionId);
          break;
        }
        case "turn_started": {
          dispatchChatSessionActivity({ workspaceId, sessionId, working: true });
          if (!acceptsMirror) break;
          resetRemoteTurn();
          setRemoteActive(true);
          if (typeof payload.assistantId === "string") {
            setRemoteAssistantId(payload.assistantId);
          }
          break;
        }
        case "snapshot": {
          if (!acceptsMirror) break;
          setRemoteActive(true);
          if (typeof payload.assistantId === "string") {
            setRemoteAssistantId(payload.assistantId);
          }
          setRemoteText(typeof payload.text === "string" ? payload.text : "");
          const reasoning =
            typeof payload.reasoning === "string" ? payload.reasoning : "";
          if (reasoning) {
            const next = appendReasoning(remoteLogRef.current, reasoning, mintRemoteId);
            if (next !== remoteLogRef.current) {
              remoteLogRef.current = next;
              setRemoteEvents(next.events);
            }
          }
          break;
        }
        case "activity": {
          if (!acceptsMirror) break;
          setRemoteActive(true);
          const kind = typeof payload.event === "string" ? payload.event : "";
          const id = typeof payload.id === "string" ? payload.id : "";
          const name = typeof payload.name === "string" ? payload.name : "";
          if (kind === "tool_start" && id && name) {
            if (remoteToolsRef.current.some((tool) => tool.id === id)) break;
            const seeded = describeToolFromInput(name, {}, tChat.toolNarration);
            const workerId =
              typeof payload.workerId === "string"
                ? payload.workerId
                : undefined;
            remoteToolsRef.current = [
              ...remoteToolsRef.current,
              {
                id,
                name,
                status: "running",
                description: seeded.description,
                ...(workerId ? { workerId } : {}),
              },
            ];
            setRemoteTools(remoteToolsRef.current);
            remoteLogRef.current = appendStep(
              remoteLogRef.current,
              seeded.description,
              mintRemoteId,
              { toolId: id },
            );
            setRemoteEvents(remoteLogRef.current.events);
          } else if (kind === "tool_input" && id) {
            const inputPayload =
              payload.input && typeof payload.input === "object"
                ? (payload.input as Record<string, unknown>)
                : {};
            const narration = describeToolFromInput(name, inputPayload, tChat.toolNarration);
            if (!narration) break;
            remoteToolsRef.current = remoteToolsRef.current.map((tool) =>
              tool.id === id
                ? {
                    ...tool,
                    description: narration.description,
                    ...(narration.url ? { url: narration.url } : {}),
                  }
                : tool,
            );
            setRemoteTools(remoteToolsRef.current);
            if (!remoteNarratedRef.current.has(id)) {
              remoteNarratedRef.current.add(id);
              remoteLogRef.current = updateStepText(
                remoteLogRef.current,
                id,
                narration.description,
                narration.url,
              );
              setRemoteEvents(remoteLogRef.current.events);
            }
          } else if (kind === "tool_result" && id) {
            const isError = payload.isError === true;
            remoteToolsRef.current = remoteToolsRef.current.map((tool) =>
              tool.id === id
                ? { ...tool, status: isError ? ("retried" as const) : ("done" as const) }
                : tool,
            );
            setRemoteTools(remoteToolsRef.current);
          } else if (kind === "tool_dropped" && id) {
            remoteToolsRef.current = remoteToolsRef.current.filter((tool) => tool.id !== id);
            setRemoteTools(remoteToolsRef.current);
            remoteLogRef.current = removeToolSteps(remoteLogRef.current, id);
            setRemoteEvents(remoteLogRef.current.events);
          } else if (kind === "tool_confirmation_required") {
            // Every viewer sees the pending card (D8); the server gates who
            // may act on it.
            setRemoteConfirmation({
              toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : "",
              toolName: typeof payload.toolName === "string" ? payload.toolName : "",
              displayName:
                typeof payload.displayName === "string" ? payload.displayName : undefined,
              input:
                payload.input && typeof payload.input === "object"
                  ? (payload.input as Record<string, unknown>)
                  : {},
              description:
                typeof payload.description === "string" ? payload.description : undefined,
              displayLines: Array.isArray(payload.displayLines)
                ? (payload.displayLines as string[])
                : undefined,
              addresserUserId:
                typeof payload.addresserUserId === "string" ? payload.addresserUserId : null,
            });
          } else if (kind === "tool_confirmation_resolved") {
            setRemoteConfirmation(null);
          }
          break;
        }
        case "pins_changed": {
          setPinsEpoch((n) => n + 1);
          break;
        }
        case "turn_completed": {
          dispatchChatSessionActivity({ workspaceId, sessionId, working: false });
          // The sender's POST stream owns its optimistic transcript. Refetching
          // the persisted reply here and then finalizing the same POST in
          // `onDone` paints two identical replies until the next refresh.
          if (!acceptsMirror) break;
          resetRemoteTurn();
          setRemoteConfirmation(null);
          setQueuedNotice(false);
          void loadTranscript(sessionId);
          void reloadShared();
          dispatchChatSessionsRefresh(workspaceId);
          markRoomSeen(workspaceId, sessionId);
          refreshPendingQuestion(sessionId);
          break;
        }
        default:
          break;
      }
    };

    void (async () => {
      try {
        const res = await authFetch(
          `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/stream`,
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
            handleRoomEvent(ev.event, coercePayload(ev.data));
          }
        }
      } catch {
        // Transport error / abort — reconnect below (or unmount).
      } finally {
        // Follow mode never closes server-side on idle, so a close means a
        // deploy / restart / network blip — re-open after a beat.
        if (!cancelled) {
          setTimeout(() => {
            if (!cancelled) setSubscribeEpoch((n) => n + 1);
          }, 3_000);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `resetRemoteTurn` / `refreshPendingQuestion` / `loadTranscript` /
    // `reloadShared` are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, isSharedOpen, subscribeEpoch, meId, workspaceId, tChat.toolNarration]);

  // Keep the transcript pinned to the newest turn as it streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    chat.state.messages,
    chat.state.streamingText,
    streamingEvents,
    toolTimeline,
    remoteText,
    remoteEvents,
  ]);

  const resetPane = useCallback(() => {
    responseGroupAbortRef.current = true;
    directTurnSessionRef.current = null;
    stream.abort();
    hydratedRef.current = null;
    sessionIdRef.current = null;
    setError(null);
    setInput("");
    setOpenDocument(null);
    att.clear();
    chat.loadMessages([]);
    chat.dispatch({ type: "stream/abort" });
    resetTurnActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, resetTurnActivity, att.clear]);

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
      // The room binds the assistant picked in the fresh pane's composer
      // chip (default: the workspace primary). Per-room for its lifetime.
      const created = await createWorkspaceSession(
        workspaceId,
        pickedAssistantId ?? undefined,
      );
      resetPane();
      setSharedSessions((rows) => [created, ...rows]);
      hydratedRef.current = created.id;
      sessionIdRef.current = created.id;
      if (created.assistantId) {
        sessionAssistantRef.current.set(created.id, created.assistantId);
      }
      selectSession(created.id, "workspace");
      dispatchChatSessionsRefresh(workspaceId);
    } catch {
      setError(t.newWorkspaceChatFailed);
    } finally {
      setStartingShared(false);
    }
  }, [pickedAssistantId, resetPane, selectSession, startingShared, t, workspaceId]);

  /** Stop the in-flight turn. Aborted streams fire neither onDone nor
   *  onError, so the state resets here (the dock's `handleAbort`). */
  const handleAbort = useCallback(() => {
    responseGroupAbortRef.current = true;
    // A room turn is server-owned and continues after the page stream closes.
    // Releasing direct ownership lets this room's follow stream immediately
    // render our own mirrored progress instead of making Stop look like a
    // completed server cancellation.
    directTurnSessionRef.current = null;
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
  /** Tracks whether the in-flight turn streamed an askQuestion step, so the
   *  settle can fetch the pending row and surface the answer panel. */
  const askedQuestionRef = useRef(false);
  const send = useCallback(async (override?: {
    text?: string;
    fileIds?: string[];
    truncateFromMessageId?: string;
    forceAddress?: boolean;
  }) => {
    const trimmed = (override?.text ?? input).trim();
    const usesComposerTray = override?.fileIds === undefined;
    const turnFileIds = override?.fileIds ?? att.fileIds();
    // Snapshot the interlocutor at send time — the turn belongs to it even
    // if the resolution inputs shift while the reply streams.
    const interlocutor = activeAssistant;
    if (
      (!trimmed && turnFileIds.length === 0) ||
      !interlocutor ||
      chat.state.isStreaming ||
      (usesComposerTray && att.uploading) ||
      pendingQuestion
    ) {
      return;
    }

    // The room decision (multiplayer chat D1/T3): in a room, send = POST
    // unless this message ADDRESSES the assistant (typed @mention or the
    // armed Ask affordance). The server re-validates either way, so this
    // only picks the endpoint.
    const isRoom = activeSessionId ? !!activeShared : view === "workspace";
    // Multi-assistant rooms (T9b): every distinct `@Name` answers, in the
    // order written. Retry/truncate remains a single-assistant operation — a
    // replay must not duplicate a previously completed response group.
    const mentioned = isRoom && !override?.truncateFromMessageId
      ? resolveMentionedAssistants(trimmed, assistants)
      : [];
    const targets = mentioned.length > 0 ? mentioned : [interlocutor];
    // Room posts are text-only. A file-bearing send must address the
    // assistant so the files reach `/api/chat` instead of being silently
    // discarded by the durable-post path.
    const addressed =
      !isRoom ||
      askArmed ||
      mentioned.length > 0 ||
      turnFileIds.length > 0 ||
      researchMode ||
      override?.forceAddress === true;
    setAskArmed(false);
    setMentionOpen(false);

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
        // Bind the room to the hero's picked interlocutor (default primary).
        const created = await createWorkspaceSession(workspaceId, interlocutor.id);
        sessionIdRef.current = created.id;
        hydratedRef.current = created.id;
        setSharedSessions((rows) => [created, ...rows]);
        sessionAssistantRef.current.set(created.id, interlocutor.id);
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

    // A silent room post (T2): send = post, instantly, for every member —
    // one durable row, no turn, no busy gate. The optimistic bubble stays;
    // the follow stream's refetch reconciles it against the stored row.
    if (isRoom && !addressed && sessionIdRef.current) {
      const targetId = sessionIdRef.current;
      chat.appendMessage({
        id: `local-${Date.now()}`,
        role: "user",
        text: trimmed,
        timestamp: new Date(),
      });
      setInput("");
      if (usesComposerTray) att.detach();
      setError(null);
      markRoomSeen(workspaceId, targetId);
      try {
        await postRoomMessage(targetId, trimmed);
      } catch {
        setError(t.postFailed);
      }
      return;
    }

    // "New chat" mints a fresh channel id (the §107 spec). The chat route's
    // sticky-channel fallback reunites every later turn of this conversation
    // on the row that first turn creates, even if the `session` event is
    // dropped — so we never fragment one chat across several rail rows.
    const channelId = sessionIdRef.current ? undefined : crypto.randomUUID();

    const localUserId = `local-${Date.now()}`;
    const userAttachments: MessageAttachmentRef[] = usesComposerTray
      ? readyAttachments(att.attachments).map((attachment) => ({
          id: attachment.fileId!,
          name: attachment.fileName,
          mime: attachment.mimeType,
          ...(attachment.previewUrl ? { dataUrl: attachment.previewUrl } : {}),
        }))
      : [];
    chat.appendMessage({
      id: localUserId,
      role: "user",
      text: trimmed,
      timestamp: new Date(),
      ...(userAttachments.length > 0 ? { userAttachments } : {}),
    } satisfies SurfaceMessage);
    setInput("");
    if (usesComposerTray) att.detach();
    setError(null);
    setQueuedNotice(false);
    responseGroupAbortRef.current = false;
    let sourceMessageId: string | null = null;
    const responseAssistantIds = targets.map((assistant) => assistant.id);

    // One visible human message, then one serialized turn per named
    // assistant. The first request persists the message and returns its id;
    // every later request reuses that row as a validated continuation.
    for (const [targetIndex, target] of targets.entries()) {
      if (responseGroupAbortRef.current) break;
      if (targetIndex > 0 && !sourceMessageId) break;

      askedQuestionRef.current = false;
      turnAssistantRef.current = target.id;
      chat.dispatch({ type: "stream/start" });
      turnTextRef.current = "";
      resetTurnActivity();
      turnStartedAtRef.current = Date.now();
      setTurnStartedAt(turnStartedAtRef.current);

      const directRoomSessionId = isRoom ? sessionIdRef.current : null;
      if (directRoomSessionId) {
        directTurnSessionRef.current = directRoomSessionId;
        dispatchChatSessionActivity({
          workspaceId,
          sessionId: directRoomSessionId,
          working: true,
        });
      }

      let turnFailed = false;
      await stream.start({
      url: `${API_URL}/api/chat`,
      authFetch: (url, init) => authFetch(String(url), init),
      body: {
        message: trimmed,
        workspaceId,
        assistantId: target.id,
        appOrigin: APP_ORIGIN,
        // The picked tier rides every turn; the server clamps to plan.
        model,
        ...(researchMode ? { mode: "research" as const } : {}),
        // The first persisted row owns the attachments. Later assistants see
        // them through room history; re-sending file ids would transcribe /
        // distil the same upload again.
        ...(targetIndex === 0 && turnFileIds.length > 0
          ? { fileIds: turnFileIds }
          : {}),
        ...(override?.truncateFromMessageId
          ? { truncateFromMessageId: override.truncateFromMessageId }
          : {}),
        // The Ask affordance marks address intent (T3) — the server decides.
        ...(isRoom && addressed ? { ask: true } : {}),
        ...(isRoom && targets.length > 1
          ? {
              roomResponseGroup: {
                assistantIds: responseAssistantIds,
                ...(sourceMessageId ? { sourceMessageId } : {}),
              },
            }
          : {}),
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
              sessionAssistantRef.current.set(id, target.id);
              chat.setSession(id);
              selectSession(id);
              // The fresh thread is now listable — tell the sidebar rail.
              dispatchChatSessionsRefresh(workspaceId);
            }
            break;
          }
          case "user_message_saved": {
            const id = typeof payload.id === "string" ? payload.id : null;
            if (id) {
              sourceMessageId ??= id;
              // Rekey only. Rebuilding this row would drop the optimistic
              // attachment previews that now belong to the transcript.
              chat.dispatch({
                type: "message/rekey",
                messageId: localUserId,
                id,
              });
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
          case "worker_start": {
            // A delegated assistant announces its human-friendly task before
            // its tool calls. Keep that label on the streamed steps so the
            // Work Bench can group current progress by assistant.
            const workerId =
              typeof payload.workerId === "string" ? payload.workerId : "";
            const description =
              typeof payload.description === "string"
                ? payload.description
                : undefined;
            if (workerId && description) {
              turnWorkerDescriptionsRef.current.set(workerId, description);
            }
            break;
          }
          case "tool_start": {
            const id = typeof payload.id === "string" ? payload.id : "";
            const name = typeof payload.name === "string" ? payload.name : "";
            if (!id || !name) break;
            // An askQuestion step means this turn may SUSPEND — the settle
            // fetches the pending row and surfaces the answer panel.
            if (name === "askQuestion") askedQuestionRef.current = true;
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
            const workerId =
              typeof payload.workerId === "string"
                ? payload.workerId
                : undefined;
            const workerDescription = workerId
              ? turnWorkerDescriptionsRef.current.get(workerId)
              : undefined;
            turnToolsRef.current = [
              ...turnToolsRef.current,
              {
                id,
                name,
                status: "running",
                description: seeded.description,
                ...(workerId ? { workerId } : {}),
                ...(workerDescription ? { workerDescription } : {}),
              },
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
          case "document_payload": {
            const document = parsePresentedDocumentPayload(payload);
            if (!document) break;
            turnDocumentsRef.current = [
              ...turnDocumentsRef.current.filter((item) => item.id !== document.id),
              document,
            ];
            setOpenDocument(document);
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
          case "citation": {
            if (!Array.isArray(payload.sources)) break;
            for (const source of payload.sources as Array<{
              url?: unknown;
              title?: unknown;
            }>) {
              if (
                typeof source.url !== "string" ||
                typeof source.title !== "string" ||
                turnCitationsRef.current.some((item) => item.url === source.url)
              ) {
                continue;
              }
              turnCitationsRef.current = [
                ...turnCitationsRef.current,
                { url: source.url, title: source.title },
              ];
            }
            setCitations(turnCitationsRef.current);
            break;
          }
          case "attachments": {
            if (Array.isArray(payload.attachments)) {
              turnFileAttachmentsRef.current =
                payload.attachments as ChatFileAttachment[];
            }
            break;
          }
          case "research_quota": {
            setResearchQuota({
              used: typeof payload.used === "number" ? payload.used : 0,
              quota: typeof payload.quota === "number" ? payload.quota : 0,
              isPaid: payload.isPaid === true,
            });
            break;
          }
          case "research_quota_exhausted": {
            setResearchExhausted(true);
            setResearchMode(false);
            setResearchQuota({
              used: typeof payload.used === "number" ? payload.used : 0,
              quota: typeof payload.quota === "number" ? payload.quota : 0,
              isPaid: false,
            });
            break;
          }
          case "queued": {
            // A quiet "will reply after this" line, never an error (T5). A
            // folded queue means another member's mention already armed the
            // follow-up turn — this message's row rides its backlog.
            setQueuedNotice(true);
            break;
          }
          case "posted": {
            // The server decided this message was a post, not an address
            // (T3 re-validation). The optimistic bubble already stands.
            turnFailed = true;
            chat.dispatch({ type: "stream/abort" });
            resetTurnActivity();
            break;
          }
          case "tool_confirmation_required": {
            // Suspended-turn card in the room transcript (T11/D8) — the
            // sender's own copy, off their POST stream.
            const toolCallId =
              typeof payload.toolCallId === "string" ? payload.toolCallId : "";
            if (!toolCallId) break;
            chat.addConfirmation({
              toolCallId,
              toolName: typeof payload.toolName === "string" ? payload.toolName : "",
              displayName:
                typeof payload.displayName === "string" ? payload.displayName : undefined,
              input:
                payload.input && typeof payload.input === "object"
                  ? (payload.input as Record<string, unknown>)
                  : {},
              description:
                typeof payload.description === "string" ? payload.description : undefined,
              displayLines: Array.isArray(payload.displayLines)
                ? (payload.displayLines as string[])
                : undefined,
              sessionId: sessionIdRef.current ?? "",
              status: "pending",
            });
            break;
          }
          case "error": {
            turnFailed = true;
            if (payload.code === "research_quota_exhausted") {
              setResearchExhausted(true);
              setResearchMode(false);
            }
            if (payload.code === "assistant_clearance_exceeds_room") {
              setError(t.assistantClearanceBlocked);
              break;
            }
            // Suspended on a question from an earlier turn: restore the
            // answer panel instead of a red error (the dock's recipe).
            if (payload.code === "pending_question_exists") {
              const approvalId =
                typeof payload.approvalId === "string" ? payload.approvalId : "";
              const sid = sessionIdRef.current ?? "";
              if (approvalId && sid) {
                setPendingQuestion({
                  approvalId,
                  question: typeof payload.question === "string" ? payload.question : "",
                  expiresAt:
                    typeof payload.expiresAt === "string" ? payload.expiresAt : null,
                  sessionId: sid,
                });
              }
              break;
            }
            const message =
              typeof payload.error === "string" ? payload.error : t.errorGeneric;
            setError(message);
            break;
          }
          default:
            // Unknown events remain additive: a newer server must never break
            // this client just because it emits chrome we do not know yet.
            break;
        }
      },
      onDone: () => {
        const settledRoomSessionId = directTurnSessionRef.current;
        directTurnSessionRef.current = null;
        if (settledRoomSessionId) {
          dispatchChatSessionActivity({
            workspaceId,
            sessionId: settledRoomSessionId,
            working: false,
          });
        }
        const finalText = turnTextRef.current.trim();
        const finalDocuments = turnDocumentsRef.current;
        const finalCitations = turnCitationsRef.current;
        const finalFileAttachments = turnFileAttachmentsRef.current;
        // Close any step the server never resolved, so the receipt shows a
        // finished turn rather than a spinner frozen mid-flight.
        const tools = turnToolsRef.current.map((tool) =>
          tool.status === "running" ? { ...tool, status: "done" as const } : tool,
        );
        const activityDurationMs =
          turnStartedAtRef.current != null
            ? Date.now() - turnStartedAtRef.current
            : undefined;
        if (
          finalText ||
          tools.length > 0 ||
          finalDocuments.length > 0 ||
          finalFileAttachments.length > 0
        ) {
          const finalMessage: SurfaceMessage = {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            text: finalText,
            timestamp: new Date(),
            senderAssistantId: target.id,
            ...(tools.length > 0 ? { toolsUsed: tools } : {}),
            ...(finalDocuments.length > 0
              ? { documents: finalDocuments }
              : {}),
            ...(activityDurationMs != null ? { activityDurationMs } : {}),
            ...(finalCitations.length > 0
              ? { citations: finalCitations }
              : {}),
            ...(finalFileAttachments.length > 0
              ? { fileAttachments: finalFileAttachments }
              : {}),
          };
          chat.dispatch({ type: "stream/finalize", finalMessage });
        } else {
          chat.dispatch({ type: "stream/abort" });
        }
        turnTextRef.current = "";
        resetTurnActivity();
        setQueuedNotice(false);
        chat.dispatch({ type: "confirmation/clear" });
        // Suspended on a question this turn — fetch the pending row so the
        // answer panel + composer gate surface immediately (dock recipe).
        if (askedQuestionRef.current && sessionIdRef.current) {
          refreshPendingQuestion(sessionIdRef.current);
        }
        if (isRoom && sessionIdRef.current) {
          markRoomSeen(workspaceId, sessionIdRef.current);
        }
        void reloadShared();
        // The turn may have auto-titled the thread — refresh the rail.
        dispatchChatSessionsRefresh(workspaceId);
      },
      onError: () => {
        turnFailed = true;
        directTurnSessionRef.current = null;
        chat.dispatch({ type: "stream/abort" });
        resetTurnActivity();
        setQueuedNotice(false);
        setError(t.errorGeneric);
        // The room backend may still be running after a transport failure.
        // Reconcile the rail from persisted session status instead of
        // declaring it idle just because this page lost its POST stream.
        dispatchChatSessionsRefresh(workspaceId);
      },
      });
      if (
        turnFailed ||
        askedQuestionRef.current ||
        responseGroupAbortRef.current
      ) {
        break;
      }
    }
    // Reconcile once after the whole serialized group, not after each member:
    // this makes persisted sender attribution authoritative without letting
    // an earlier fetch erase a later assistant's live/final row. It also
    // catches teammate posts that arrived while this direct stream owned the
    // room mirror and viewer identity had not hydrated yet.
    if (isRoom && sourceMessageId && sessionIdRef.current) {
      await loadTranscript(sessionIdRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, activeAssistant, activeSessionId, activeShared, askArmed, model, researchMode, view, workspaceId, chat.state.isStreaming, refreshPendingQuestion, reloadShared, resetTurnActivity, selectSession, startingShared, stream, t, tChat.toolNarration, att.attachments, att.uploading, att.fileIds, att.detach, pendingQuestion, assistants]);

  const retryUserMessage = useCallback(
    (messageId: string) => {
      if (stream.inFlight()) return;
      const messages = chat.state.messages as SurfaceMessage[];
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return;
      const message = messages[index];
      // Cached file ids are not carried on the render model after restore;
      // never pretend a retry can replay an attachment-bearing turn.
      if (
        message.role !== "user" ||
        !message.text.trim() ||
        message.userAttachments?.length
      ) {
        return;
      }
      chat.loadMessages(messages.slice(0, index));
      void send({
        text: message.text,
        truncateFromMessageId: message.id,
        forceAddress: true,
      });
    },
    [chat, send, stream],
  );

  const retryAssistantMessage = useCallback(
    (messageId: string) => {
      if (stream.inFlight()) return;
      const messages = chat.state.messages as SurfaceMessage[];
      const index = messages.findIndex((message) => message.id === messageId);
      if (index <= 0) return;
      const precedingUser = messages[index - 1];
      if (
        precedingUser.role !== "user" ||
        !precedingUser.text.trim() ||
        precedingUser.userAttachments?.length
      ) {
        return;
      }
      chat.loadMessages(messages.slice(0, index - 1));
      void send({
        text: precedingUser.text,
        truncateFromMessageId: precedingUser.id,
        forceAddress: true,
      });
    },
    [chat, send, stream],
  );

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

  // Work Bench uses the same active turn truth as the transcript. Direct
  // sends have the richest SSE timeline; followed teammate turns use the
  // mirrored timeline. A suspended question remains visible as waiting work
  // because the assistant cannot make further progress without the room.
  const workBenchTools = chat.state.isStreaming
    ? toolTimeline
    : remoteActive
      ? remoteTools
      : [];
  const workBenchWaiting =
    !chat.state.isStreaming &&
    !remoteActive &&
    !!pendingQuestion &&
    pendingQuestion.sessionId === activeSessionId;
  const workBenchTurnActive =
    chat.state.isStreaming || remoteActive || workBenchWaiting;
  const workBenchRunningTool = workBenchTools.find(
    (tool) => !tool.workerId && tool.status === "running",
  );
  const workBenchCurrentStep = workBenchWaiting
    ? pendingQuestion?.question ?? tChat.thinking
    : workBenchRunningTool?.description ??
      (chat.state.isStreaming && chat.state.streamingText
        ? tChat.activity.writing
        : remoteActive && remoteText
          ? tChat.activity.writing
          : researchPhase
            ? tChat.researchStatus[researchPhase]
            : tChat.thinking);
  const workBenchAssistant = resolveWorkBenchAssistant({
    roster: assistants,
    fallback: activeAssistant,
    localActive: chat.state.isStreaming,
    localAssistantId: turnAssistantRef.current,
    remoteActive,
    remoteAssistantId,
    waitingForInput: workBenchWaiting,
  });

  /** The reply avatar for a given ANSWERING assistant (multi-assistant
   *  rooms, T9) — falls back to the thread's bound assistant. */
  const avatarFor = (senderAssistantId?: string | null) => {
    const a =
      (senderAssistantId
        ? assistants.find((x) => x.id === senderAssistantId)
        : undefined) ?? activeAssistant;
    if (!a) return replyAvatar;
    return (
      <div className="mt-0.5 shrink-0">
        <AssistantAvatar
          id={a.id}
          name={a.name}
          iconSeed={a.iconSeed ?? undefined}
          size="sm"
        />
      </div>
    );
  };

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

  const messageActions = (
    messageId: string,
    text: string,
    alignEnd: boolean,
    onRetry?: () => void,
  ) => (
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
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          aria-label={tChat.retry}
          title={tChat.retry}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RotateCw className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );

  /** Fresh pane with nothing painted — render the new-chat hero instead of an
   *  empty transcript over a bottom bar. Any open/adopted session, streamed
   *  text, or teammate turn drops back to the normal transcript layout. */
  const heroMode =
    !activeSessionId &&
    chat.state.messages.length === 0 &&
    !chat.state.isStreaming &&
    !remoteActive;

  /** Interlocutor control, rendered INSIDE the composer box (bottom-left):
   *  a NEW personal chat picks its assistant here and the session sticks to
   *  it (sessions are assistant-bound; the server rejects a mismatched
   *  send). An open thread shows its bound assistant — never a mid-thread
   *  switch. A fresh Workspace pane picks the assistant the new ROOM will
   *  bind (per-room, for its lifetime). A single-assistant
   *  workspace degrades to the static label. */
  const interlocutorControl =
    activeAssistant &&
    (!activeSessionId && assistants.length > 1 ? (
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

  /** Whether the CURRENT pane is a room — an open shared thread, or the
   *  Workspace hero about to create one. Drives the post-vs-ask composer. */
  const paneIsRoom = activeSessionId ? !!activeShared : view === "workspace";

  /**
   * Resolve a pending write confirmation (`POST /api/chat/confirm`) — the
   * dock's recipe. In a room the SERVER gates who may act: the turn's
   * addresser or a workspace admin (T11/D8); a 403 here surfaces as the
   * quiet not-allowed note, never a broken card.
   */
  const resolveConfirmation = useCallback(
    async (toolCallId: string, action: "approve" | "deny", comment?: string) => {
      const sessionId =
        chat.state.pendingConfirmations.find((c) => c.toolCallId === toolCallId)
          ?.sessionId ??
        activeSessionId ??
        sessionIdRef.current;
      if (!sessionId) return;
      chat.updateConfirmation(toolCallId, {
        status: action === "approve" ? "approving" : "denied",
      });
      try {
        const res = await authFetch(`${API_URL}/api/chat/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            toolCallId,
            decision: action === "approve" ? "allow" : "deny",
            ...(action === "deny" && comment ? { comment } : {}),
          }),
        });
        if (res.ok) {
          chat.updateConfirmation(toolCallId, {
            status: action === "approve" ? "approved" : "denied",
          });
          if (remoteConfirmation?.toolCallId === toolCallId) {
            setRemoteConfirmation(null);
          }
        } else if (res.status === 403) {
          chat.updateConfirmation(toolCallId, { status: "pending" });
          setError(t.confirmNotAllowed);
        } else {
          chat.updateConfirmation(toolCallId, { status: "pending" });
        }
      } catch {
        chat.updateConfirmation(toolCallId, { status: "pending" });
      }
    },
    // `chat.updateConfirmation` is a stable callback from the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, chat.state.pendingConfirmations, remoteConfirmation, t],
  );

  /** `@` autocomplete (T12/T9 — assistants only, the WHOLE workspace
   *  roster): typing `@` (or a partial after it) at the end of the input
   *  offers every assistant that can answer here; picking one inserts the
   *  full mention, and that assistant answers the turn. */
  useEffect(() => {
    if (!paneIsRoom || assistants.length === 0) {
      setMentionOpen(false);
      return;
    }
    setMentionOpen(/(^|\s)@[^@]*$/.test(input));
  }, [input, paneIsRoom, assistants.length]);

  /** The typed partial after the trailing `@`, for roster filtering. */
  const mentionPartial = useMemo(() => {
    const m = input.match(/(^|\s)@([^@]*)$/);
    return m ? m[2].toLowerCase() : "";
  }, [input]);

  const mentionCandidates = useMemo(
    () =>
      assistants.filter((a) =>
        a.name.toLowerCase().startsWith(mentionPartial),
      ),
    [assistants, mentionPartial],
  );

  const insertMention = useCallback((name: string) => {
    setInput((cur) => cur.replace(/@[^@]*$/, `@${name} `));
    setMentionOpen(false);
  }, []);

  /** The composer, styled as the app's composite-control box (globals.css
   *  contract): ONE bordered box carrying the focus ring via `focus-within`,
   *  every inner focusable opting out of the global ring. Textarea on top;
   *  a control row beneath with the interlocutor control left and an icon Send
   *  (Stop while streaming) right. Rendered in the hero (centered) or the
   *  bottom bar — same node either way. */
  const composerBox = (
    <div
      className={cn(
        "relative rounded-xl border border-border bg-background shadow-sm",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35",
      )}
    >
      {/* Mention autocomplete — one entry (the room's assistant; human
          mentions are out of scope). Rendered above the box so it never
          shifts the composer. */}
      {mentionOpen && mentionCandidates.length > 0 && (
        <div className="absolute bottom-full left-2 z-20 mb-1 max-h-56 w-64 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
          {mentionCandidates.map((a) => (
            <button
              key={a.id}
              type="button"
              onMouseDown={(e) => {
                // mousedown, not click — keep the textarea focused.
                e.preventDefault();
                insertMention(a.name);
              }}
              aria-label={format(t.mentionInsertAria, { name: a.name })}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-accent"
            >
              <AssistantAvatar
                id={a.id}
                name={a.name}
                iconSeed={a.iconSeed ?? undefined}
                size="xs"
              />
              <span className="min-w-0 flex-1 truncate">@{a.name}</span>
            </button>
          ))}
        </div>
      )}
      <ChatComposer
        value={input}
        onChange={setInput}
        onSend={() => void send()}
        disabled={!!pendingQuestion}
        sendDisabled={chat.state.isStreaming || !activeAssistant || att.uploading}
        allowEmptySend={att.hasReady}
        onPaste={(event) => {
          if (pendingQuestion) return;
          const images = imageFilesFromClipboard(event.clipboardData);
          if (images.length === 0) return;
          event.preventDefault();
          void att.upload(images);
        }}
        placeholder={
          pendingQuestion
            ? tChat.pendingQuestion.composerDisabled
            : t.composerPlaceholder
        }
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
        slotAttachments={
          <>
            <AttachmentChips
              attachments={att.attachments}
              onRemove={att.remove}
            />
            {recordingUpload.status !== "idle" ? (
              <p
                role="status"
                className={cn(
                  "px-1 py-0.5 text-xs",
                  recordingUpload.status === "error"
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {recordingUpload.status === "uploading"
                  ? tRecordings.uploading
                  : recordingUpload.status === "processing"
                    ? tRecordings.processing
                    : recordingUpload.message}
              </p>
            ) : null}
          </>
        }
        slotPreInput={
          <div className="order-2 mr-auto flex min-w-0 items-center gap-0.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) void att.upload(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!!pendingQuestion}
              aria-label={tAttach.attach}
              title={tAttach.attach}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:shadow-none"
            >
              <Paperclip className="size-[17px]" aria-hidden />
            </button>
            {interlocutorControl}
            {/* Tier picker (Standard / Pro / Max) — the shared presentational
                control; without research/metered props it renders just the
                Select. Sits beside the assistant picker in the control row. */}
            <ComposerControls
              model={model}
              onModelChange={setModel}
              plan={workspacePlan}
              researchMode={researchMode}
              onResearchModeChange={setResearchMode}
              researchQuota={researchQuota}
              researchExhausted={researchExhausted}
              showResearch
              selectSide="top"
            />
            {/* The Ask affordance (D1/T3) — rooms only. In a room, send =
                post; arming this (or typing an @mention) makes the next send
                address the assistant. Never a "run a turn?" toggle on
                personal chats, where every send is already addressed. */}
            {paneIsRoom && activeAssistant && (
              <button
                type="button"
                onClick={() => setAskArmed((v) => !v)}
                aria-pressed={askArmed}
                aria-label={format(t.askLabel, { name: activeAssistant.name })}
                title={t.askArmedAria}
                className={cn(
                  "flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium transition-colors focus-visible:shadow-none",
                  askArmed
                    ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <AtSign className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">
                  {format(t.askLabel, { name: activeAssistant.name })}
                </span>
              </button>
            )}
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
    <div
      className="relative flex h-full min-h-0 flex-col"
      {...drop.dropProps}
    >
      <FileDropOverlay active={drop.isDragging} />
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
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
            {chat.state.messages.length === 0 &&
              !chat.state.isStreaming &&
              !remoteActive && (
                <p className="py-20 text-center text-sm text-muted-foreground">
                  {activeShared ? t.sharedTranscriptEmpty : t.transcriptEmpty}
                </p>
              )}
            {(chat.state.messages as SurfaceMessage[]).map((m, messageIndex) =>
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
                  {m.text ? (
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[14px] leading-[1.5] break-words whitespace-pre-wrap text-secondary-foreground shadow-sm">
                      {m.text}
                    </div>
                  ) : null}
                  {m.userAttachments?.length ? (
                    <div className="w-full max-w-[280px]">
                      <MessageAttachments attachments={m.userAttachments} />
                    </div>
                  ) : null}
                  {m.text
                    ? messageActions(
                        m.id,
                        m.text,
                        true,
                        m.userAttachments?.length
                          ? undefined
                          : () => retryUserMessage(m.id),
                      )
                    : null}
                </div>
              ) : (
                <div key={m.id} className="group flex gap-2.5">
                  {avatarFor(m.senderAssistantId)}
                  <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
                    {m.toolsUsed?.length ? (
                      <ChatActivitySummary
                        tools={m.toolsUsed}
                        durationMs={m.activityDurationMs}
                      />
                    ) : null}
                    {m.text ? (
                      <div className={MARKDOWN_CLS}>
                        <ChatMarkdown
                          text={m.text}
                          components={CHAT_MARKDOWN_COMPONENTS}
                          remarkPlugins={REMARK_PLUGINS}
                        />
                      </div>
                    ) : null}
                    {m.fileAttachments?.length ? (
                      <ChatFileAttachments attachments={m.fileAttachments} />
                    ) : null}
                    {m.citations?.length ? (
                      <ChatCitationList
                        citations={m.citations}
                        label={tChat.citationLabel}
                      />
                    ) : null}
                    {m.documents?.map((document) => (
                      <ChatDocumentCard
                        key={document.id}
                        document={document}
                        onOpen={setOpenDocument}
                      />
                    ))}
                    {m.text
                      ? messageActions(
                          m.id,
                          m.text,
                          false,
                          (chat.state.messages as SurfaceMessage[])[messageIndex - 1]
                            ?.userAttachments?.length
                            ? undefined
                            : () => retryAssistantMessage(m.id),
                        )
                      : null}
                  </div>
                </div>
              ),
            )}
            {/* Live turn — the dock's activity feed (shimmer status +
                reasoning/tool steps) above the streaming reply + caret. */}
            {chat.state.isStreaming && (
              <div className="flex gap-2.5">
                {avatarFor(turnAssistantRef.current)}
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
                        components={CHAT_MARKDOWN_COMPONENTS}
                        remarkPlugins={REMARK_PLUGINS}
                      />
                      <span
                        aria-hidden
                        className="ml-0.5 inline-block h-[16px] w-[2px] rounded-full bg-primary align-text-bottom shadow-[0_0_8px_var(--primary)] animate-pulse"
                      />
                    </div>
                  ) : null}
                  {citations.length > 0 ? (
                    <ChatCitationList
                      citations={citations}
                      label={tChat.citationLabel}
                    />
                  ) : null}
                </div>
              </div>
            )}
            {/* A teammate's turn, relayed off the per-session event bus
                through the SAME feed pipeline the sender uses (T13): the
                shimmer feed (reasoning + tool steps) above the live snapshot
                text. When the turn settles the PERSISTED transcript is
                refetched — the snapshot is never kept. */}
            {remoteActive && !chat.state.isStreaming && (
              <div className="flex gap-2.5">
                {avatarFor(remoteAssistantId)}
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  {remoteEvents.length > 0 || remoteTools.length > 0 ? (
                    <ChatActivityFeed
                      events={remoteEvents}
                      tools={remoteTools}
                      replyStreaming={remoteText.length > 0}
                      researchPhase={null}
                      startedAt={null}
                    />
                  ) : remoteText ? null : (
                    <span
                      role="status"
                      className="chat-shimmer-text text-xs font-medium"
                    >
                      {t.teammateWorking}
                    </span>
                  )}
                  {remoteText ? (
                    <div className={MARKDOWN_CLS}>
                      <ChatMarkdown
                        text={remoteText}
                        components={CHAT_MARKDOWN_COMPONENTS}
                        remarkPlugins={REMARK_PLUGINS}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            )}
            {/* Suspended-turn surfaces (T11/D8). The sender's own pending
                write confirmations ride their POST stream; a teammate's ride
                the activity mirror. EVERYONE sees the card — the server
                enforces who may act (addresser or workspace admin). */}
            {chat.state.pendingConfirmations
              .filter((c) => c.status === "pending" || c.status === "approving")
              .map((c) => (
                <ChatConfirmationCard
                  key={c.toolCallId}
                  confirmation={c}
                  approveLabel={tChat.confirmationApprove}
                  denyLabel={tChat.confirmationDeny}
                  approvingLabel={tChat.confirmationApproving}
                  onApprove={(toolCallId) => void resolveConfirmation(toolCallId, "approve")}
                  onDeny={(toolCallId, comment) =>
                    void resolveConfirmation(toolCallId, "deny", comment)
                  }
                />
              ))}
            {remoteConfirmation && !chat.state.isStreaming && (
              <ChatConfirmationCard
                confirmation={{
                  toolCallId: remoteConfirmation.toolCallId,
                  toolName: remoteConfirmation.toolName,
                  displayName: remoteConfirmation.displayName,
                  input: remoteConfirmation.input,
                  description: remoteConfirmation.description,
                  displayLines: remoteConfirmation.displayLines,
                  sessionId: activeSessionId ?? "",
                  status: "pending",
                }}
                approveLabel={tChat.confirmationApprove}
                denyLabel={tChat.confirmationDeny}
                approvingLabel={tChat.confirmationApproving}
                onApprove={(toolCallId) => void resolveConfirmation(toolCallId, "approve")}
                onDeny={(toolCallId, comment) =>
                  void resolveConfirmation(toolCallId, "deny", comment)
                }
              />
            )}
            {/* A suspended askQuestion — any member with read access may
                answer, attributed (D8); Answer/Cancel are the reader-gated
                session routes. */}
            {pendingQuestion && pendingQuestion.sessionId === activeSessionId && (
              <PendingQuestionPanel
                sessionId={pendingQuestion.sessionId}
                approvalId={pendingQuestion.approvalId}
                dict={tChat.pendingQuestion}
                onAnswered={() => setPendingQuestion(null)}
                onCancelled={() => setPendingQuestion(null)}
              />
            )}
            {/* Quiet queue notice (T5) — a mention landed mid-turn; the
                follow-up turn is armed. Never an error. */}
            {queuedNotice && (
              <p className="px-1 text-xs text-muted-foreground">{t.queuedNotice}</p>
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
      {openDocument ? (
        <ChatDocumentViewer
          document={openDocument}
          onClose={() => setOpenDocument(null)}
        />
      ) : activeShared && activeSessionId ? (
        <ChatContextPins
          sessionId={activeSessionId}
          workspaceId={workspaceId}
          refreshKey={pinsEpoch}
          startedByName={activeShared.startedByName}
          assistant={workBenchAssistant}
          turnActive={workBenchTurnActive}
          waitingForInput={workBenchWaiting}
          currentStep={workBenchCurrentStep}
          tools={workBenchTools}
          expanded={workBenchExpanded}
          onExpandedChange={setWorkBenchExpanded}
        />
      ) : null}
      </div>
      )}
    </div>
  );
}
