"use client";

/**
 * Floating chat panel for app-web — the "ask AI to create a view"
 * affordance. It is mounted ONCE in `WorkspaceChrome` (the persistent
 * workspace layout) at `origin="doc"` and serves EVERY tab, so an in-flight
 * turn keeps streaming when the user switches surfaces and the conversation
 * is unified. The `origin` prop still gates the page-editing affordances on
 * `origin === 'doc'` (the dock supports a surface-scoped mode for other
 * hosts), but the chrome dock is always `'doc'`: on `/p/<pageId>` it targets
 * the open page (`docViewId`, derived from the path), and on every other tab
 * the path has no page so the next message mints a new one. See
 * docs/architecture/features/doc.md → "One dock, every surface".
 *
 *   ┌─ collapsed pill (bottom-middle) ───────────────────────┐
 *   │  Idle: "Ask for a view…"  ·  Streaming: mirrors live  │
 *   │  tool / streaming preview from the expanded panel.    │
 *   └────────────────────────────────────────────────────────┘
 *
 *   ┌─ expanded panel ───────────────────────────────────────┐
 *   │ header: title + collapse button                        │
 *   │ messages: empty-state OR <MessageList> with inline     │
 *   │   <ViewRenderer> blocks + "Open in this doc" pill   │
 *   │ activity feed (shimmer status + reasoning/tool steps)  │
 *   │   above the streaming text; committed bubbles keep a   │
 *   │   collapsed "Worked for Ns · k steps" receipt          │
 *   │ tool-confirmation cards inline between bubbles         │
 *   │ inline citations bar under each finalised assistant    │
 *   │ composer: textarea + Send (Stop while streaming)       │
 *   └────────────────────────────────────────────────────────┘
 *
 * SSE event coverage matches apps/web's ChatExperience (minus
 * `title_update` + `research_quota*` which have no doc surface). Each
 * event funnels through a single `onEvent` switch; long-lived per-turn
 * state lives in refs so callbacks can read the latest without re-binding
 * deps.
 *
 * Retry / Copy buttons hover-reveal on every assistant bubble. Retry
 * re-POSTs the most recent user message and tells the server to truncate
 * the prior assistant row (`truncateFromMessageId`) so the response
 * replaces the old one cleanly.
 *
 * Tool-confirmation flow: server emits `tool_confirmation_required` with
 * `{toolCallId, toolName, displayName, input, description, displayLines}`.
 * We render an inline approval card. Approve/Deny POSTs
 * `/api/chat/confirm` and the server resumes the stream.
 *
 * askQuestion suspend-resume: when the assistant asks a clarifying
 * question the engine suspends the session (persists a `kind='question'`
 * row, emits `awaiting_approval`, exits without `turn_complete`). We
 * suppress the generic approve/deny card for `askQuestion`, gate the
 * composer, and render `<PendingQuestionPanel>` so the user answers
 * (POST /answer) or cancels (POST /cancel). `GET /pending` on reload
 * restores the panel; after answer/cancel we poll session messages for
 * the resumed reply. See docs/architecture/engine/askquestion-suspend-resume.md.
 *
 * view_payload bridge: chat-ui's `useMessageStream` is event-agnostic,
 * so we consume `view_payload` ourselves and attach the entries to the
 * in-flight assistant message under `views[]`. Each view also fires a
 * `doc:draft-created` window event so the sidebar reload-tick bumps
 * and the new draft surfaces immediately.
 *
 * [COMP:app-web/floating-chat]
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  docPagePath,
  pageIdFromInAppHref,
  pageIdFromPathname,
} from "@/lib/doc-page-url";
import { DOC_COMMENTS_CHANGED_EVENT } from "@/lib/comment-events";
import {
  derivePageIcon,
  getAssistantIdentity,
  listWorkspaceAssistants,
  type AssistantIdentity,
  type WorkspaceAssistantSummary,
} from "@/lib/api/views";
import { PageIcon } from "@/components/doc/page-icon";
import { AssistantAvatar } from "@/components/assistant-avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  resolveChatTarget,
  type ChatTarget,
  type ChatTargetPage,
} from "@/lib/chat-target";
import { skillRowIdFromPathname } from "@/lib/skills-view";
import { deckIdFromPathname } from "@/lib/decks-view";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  FilePlus,
  FileText,
  MessageSquare,
  Paperclip,
  RotateCw,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  ChatMarkdown,
  ChatComposer,
  useChatSession,
  useMessageStream,
  type ChatFileAttachment,
  type CitationSource,
  type Message,
  type PendingConfirmation,
  type ToolUsed,
} from "@use-brian/chat-ui";
import { ChatFileAttachments } from "@/components/chrome/chat-file-attachment";
import { ChatCodeBlock } from "@/components/chrome/chat-code-block";
import {
  ChatActivityFeed,
  ChatActivitySummary,
  type ResearchPhase,
} from "@/components/chrome/chat-activity";
import {
  ComputerLiveChip,
  isBrowserToolName,
} from "@/components/chrome/computer-live-chip";
import { authFetch } from "@/lib/auth-fetch";
import { fetchModelMenu, fetchMeteredEstimate } from "@/lib/api/models";
import { publishBuildActivity } from "@/lib/build-activity";
import {
  appendReasoning,
  appendStep,
  EMPTY_LOG,
  removeToolSteps,
  updateStepText,
  type BuildEvent,
  type EventLog,
} from "@/lib/build-events";
import {
  describeToolFromInput,
  type NarrationDict,
} from "@/lib/tool-narration";
import { requestBrainRefresh } from "@/lib/brain-events";
import {
  SURFACE_CHAT_SEED_EVENT,
  type SurfaceChatSeed,
} from "@/lib/surface-chat-seed";
import {
  extractMessageText,
  extractToolUses,
  fetchLatestSession,
  fetchSessionMessages,
  parseMessageAttachments,
  type MessageAttachmentRef,
} from "@/lib/api/sessions";
import { MessageAttachments } from "@/components/doc/message-attachment-card";
import {
  fetchPendingQuestion,
  submitAnswer,
  cancelPendingQuestion,
} from "@/lib/api/pending-questions";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { ComposerControls } from "@/components/doc/composer-controls";
import { useT, format } from "@/lib/i18n/client";
import {
  collapseResolvedConfirmations,
  type ResolvedConfirmationCounts,
} from "@/lib/confirmation-collapse";
import { useIsOffline } from "@/lib/offline/use-offline-sync";
import type { AssistantRunState } from "@use-brian/doc-model";
import { cn } from "@/lib/utils";
import {
  imageFilesFromClipboard,
  readyAttachments,
  useFileAttachments,
} from "@/lib/use-file-attachments";
import { useRecordingUpload } from "@/lib/recordings/use-recording-upload";
import { useFileDrop } from "@/lib/use-file-drop";
import { useAutoGrowTextarea } from "@/lib/use-auto-grow-textarea";
import { AttachmentChips, FileDropOverlay } from "@/components/doc/attachment-chips";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * The non-doc workspace surfaces this dock can mount over. Each value is
 * also the `appOrigin` stamped on `/api/chat` sessions (migration 255 allows
 * them all on `sessions.app_origin`), so threads + Recents scope per-surface.
 */
export type ChatSurface =
  | "brain"
  | "studio"
  | "workflow"
  | "approvals"
  | "knowledge-base";

/**
 * Where the dock is mounted: the doc page surface (`'doc'`, the default —
 * page-first, with the page-target chip and `docViewId` plumbing) or one of
 * the workspace surfaces (general chat with a view-context chip; the
 * page-editing nudges are gated off). See
 * `docs/architecture/features/doc.md` → "One dock, every surface".
 */
type ChatOrigin = "doc" | ChatSurface;

/** Persisted across sessions so the model choice sticks. */
const MODEL_STORAGE_KEY = "doc-chat-model";
type ModelTier = "standard" | "pro" | "max";

/**
 * Per-workspace persisted choice of which assistant this doc chat talks
 * to. Defaults to the workspace primary (passed in as the `assistantId`
 * prop) but the user can switch to any accessible workspace assistant; the
 * selection sticks across reloads.
 */
function activeAssistantStorageKey(workspaceId: string): string {
  return `doc-active-assistant-id:${workspaceId}`;
}

/**
 * Persisted floating-dock dimensions (`mode="floating"` only). The user can
 * drag the panel's top / left edges to resize it; the chosen size sticks
 * across reloads. Side-panel + mobile-drawer modes fill their host and ignore
 * this entirely.
 */
const SIZE_STORAGE_KEY = "doc-chat-size";
const DEFAULT_CHAT_SIZE = { w: 460, h: 640 };
/** Floor — below this the composer + a couple of message rows stop fitting. */
const MIN_CHAT_W = 340;
const MIN_CHAT_H = 420;

type ChatSize = { w: number; h: number };

/**
 * Clamp a requested dock size to the floor and the live viewport (leaving a
 * 16px gutter on the left, 8% on top) so a resize — or a later window shrink —
 * can never push the panel off-screen.
 */
function clampChatSize(size: ChatSize): ChatSize {
  const hasWindow = typeof window !== "undefined";
  const maxW = hasWindow ? Math.max(MIN_CHAT_W, window.innerWidth - 32) : size.w;
  const maxH = hasWindow
    ? Math.max(MIN_CHAT_H, Math.round(window.innerHeight * 0.92))
    : size.h;
  return {
    w: Math.round(Math.max(MIN_CHAT_W, Math.min(size.w, maxW))),
    h: Math.round(Math.max(MIN_CHAT_H, Math.min(size.h, maxH))),
  };
}

/**
 * A dropped or blocked connection (SSE cut mid-stream, offline, or the server
 * severing a long request at its timeout) surfaces from `fetch`/`getReader()`
 * as a `TypeError`, NOT a clean server error with a useful message. Match it so
 * the chat shows a calm "connection dropped" line instead of the raw browser
 * string ("Failed to fetch" / "Load failed" / "NetworkError when attempting to
 * fetch resource"), which reads to the user as an app crash. A real server-sent
 * error (which carries a meaningful message) still surfaces verbatim.
 */
function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TypeError") return true;
  return /failed to fetch|load failed|network|connection|fetch failed/i.test(
    err.message,
  );
}

/**
 * Pointer to a doc draft emitted by `renderView`. Structurally
 * extends chat-ui's `ViewPayloadAttachment` (which carries `payload:
 * unknown` for inline-render consumers like apps/web), but doc
 * deliberately ignores `payload` — the draft on the doc is the
 * truth. The model speaks; the doc shows.
 */
type ViewAttachment = {
  toolUseId: string;
  payload: unknown;
  entity?: string;
  viewType?: string;
  viewId?: string;
  /** Whether the call appended to an existing draft or created a new one. */
  action?: "appended" | "created";
};

/** Extends chat-ui's Message with the per-message view list. */
type MessageWithViews = Message & {
  views?: ViewAttachment[];
  /**
   * The user's OWN uploaded attachments (pasted screenshots, picked/dropped
   * files), shown as thumbnail/file cards on their message bubble. On the live
   * send path these carry object-URL previews handed off from the composer
   * tray; on session restore they carry base64 thumbnails parsed from the
   * persisted `<attached_file>` blocks. Distinct from `fileAttachments`, which
   * are the assistant's outbound `sendFile` download cards.
   */
  userAttachments?: MessageAttachmentRef[];
};

/**
 * `ToolUsed` extended with optional per-op build-log lines for `patchPage`.
 * Doc-web local only — not pushed to `@use-brian/chat-ui` because these
 * per-op labels are doc-surface-specific.
 */
export type ToolUsedWithOps = ToolUsed & {
  /**
   * For `patchPage`: one human-readable line per op in the ops array
   * (e.g. "Adding heading 'Overview'", "Inserting a data table"). The
   * page-build-indicator renders these as sub-rows under the tool step.
   */
  opLines?: string[];
};

/** Alias for confirmations that may carry the `'failed'` execution status. */
type ConfirmationWithFailure = PendingConfirmation;

/** System-level inline notice (e.g. budget downgrade). */
type InlineNotice = {
  code: string;
  message: string;
};

/** Snapshot emitted to the parent so the collapsed pill can mirror activity. */
export type ChatActivity = {
  isStreaming: boolean;
  streamingText: string;
  activeTool: {
    name: string;
    description?: string;
    status: ToolUsed["status"];
  } | null;
};

type FloatingChatProps = {
  workspaceId: string;
  assistantId: string;
  /**
   * Layout mode. Default `'floating'` keeps the legacy bottom-right overlay.
   * `'side-panel'` strips fixed positioning so the chat fills its parent
   * container (used by `<DocSidePanel>` as the 3-column shell's right pane).
   */
  mode?: "floating" | "side-panel";
  /**
   * The surface this dock is mounted over (default `'doc'`). Stamped as
   * `appOrigin` on `/api/chat` sends and the resume lookup so threads scope
   * per-surface. Off doc, the page-editing affordances gate off: the
   * page-target chip becomes the surface-context chip, placeholder/empty
   * copy turns surface-neutral, `docViewId`/`docAnchorBlockId`/theme-refine
   * are not sent, page creation does not auto-navigate, the
   * `doc:surface-chat-seed` bus is consumed, and `requestBrainRefresh`
   * fires after each completed turn.
   */
  origin?: ChatOrigin;
  /**
   * Suppress the panel's own header bar. Set by a host that frames the chat
   * with its own chrome — the mobile bottom-sheet drawer supplies a grab handle
   * + title — so the chat doesn't render a second, redundant header.
   */
  hideHeader?: boolean;
  /** Optional: parent can mirror live activity into its own surface. */
  onActivityChange?: (activity: ChatActivity) => void;
  /**
   * The page currently open on the doc (the shell's `activeView`).
   * Drives the composer's context chip so the user can see which draft
   * this chat will edit — or that the next message will create a new one
   * (when `null` *and* the path has no `/p/<id>` segment). Structurally a
   * `ViewMetadata`; pass that straight in. Lags the path by one tick during
   * a switch, which `resolveChatTarget` reconciles against the live id.
   */
  activePage?: ChatTargetPage | null;
  /**
   * A prompt handed in from another surface (the default-viewer landing's
   * chatter) via the shell's chat-seed routing. Nonce-gated so a repeated
   * prompt re-fires. `autoSend` fires the turn immediately and — when
   * `docViewId` anchors it to a page — leaves the dock collapsed so the
   * construction streams onto the page body instead. Without `autoSend` we
   * just prefill the composer. See `lib/chat-seed.ts`.
   */
  seedRequest?: {
    prefill: string;
    autoSend?: boolean;
    docViewId?: string;
    /** Model tier + research flag for the seeded turn (the landing's picker). */
    model?: ModelTier;
    researchMode?: boolean;
    /** Ready attachment ids staged on the seeding surface (the landing's file
     *  picker / drop) — ride this turn as `/api/chat` `fileIds`. */
    fileIds?: string[];
    /**
     * Empty-line "Space for AI" anchor: the inline AI box's block. Rides the
     * autoSend turn as `docAnchorBlockId` so the generation lands after that
     * line (the chat route injects an "Insertion anchor" note). Paired with
     * `autoSend` + `docViewId`.
     */
    anchorBlockId?: string;
    nonce: number;
  };
  /**
   * Soft double-text guard: the assistant run another member started on THIS
   * page (null when idle or when the local user is the one running it). When
   * set, the composer shows a warning strip so a teammate doesn't fire a second
   * instruction at the same page. Soft by design — it warns, it doesn't block.
   */
  othersRun?: AssistantRunState | null;
};

const CLIENT_TIMEZONE: string | null = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
})();

export function FloatingChat({
  workspaceId,
  assistantId,
  mode = "floating",
  origin = "doc",
  hideHeader = false,
  onActivityChange,
  activePage = null,
  seedRequest,
  othersRun = null,
}: FloatingChatProps) {
  // 'side-panel' fills its parent column and stays open (no pill); 'floating'
  // is the bottom-right collapsible dock. Drives positioning + the pill below.
  const isSidePanel = mode === "side-panel";
  // Doc keeps the page-first affordances; a workspace surface gates them off.
  const isDocOrigin = origin === "doc";
  const t = useT().chat;
  // Chat is network/AI — fully unavailable offline. Disable the composer in the
  // bundled app when offline so a turn can't be started (no-op on web/thin).
  const offline = useIsOffline();
  const tRun = useT().docPage.assistantRun;
  const tAttach = useT().attachments;
  const tRec = useT().recordings;
  const router = useRouter();
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");

  // ── Assistant switcher ───────────────────────────────────────────────────
  // The chat talks to the workspace PRIMARY by default (the `assistantId`
  // prop), but the user can switch to any accessible workspace assistant.
  // The selection is persisted per-workspace and overrides the prop on mount;
  // `selectedAssistantId` is what every chat path below actually uses (resume,
  // send body, identity avatar). The backend still injects doc-editing
  // tools off `appOrigin: "doc"`, so any assistant can edit pages here.
  const [selectedAssistantId, setSelectedAssistantId] = useState<string>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem(
          activeAssistantStorageKey(workspaceId),
        );
        if (saved) return saved;
      } catch {
        /* private mode — fall through to the prop default */
      }
    }
    return assistantId;
  });
  // If the prop changes (workspace switch) and no persisted choice exists for
  // the new workspace, follow the new default primary.
  useEffect(() => {
    let persisted: string | null = null;
    try {
      persisted = window.localStorage.getItem(
        activeAssistantStorageKey(workspaceId),
      );
    } catch {
      /* private mode */
    }
    setSelectedAssistantId(persisted ?? assistantId);
  }, [assistantId, workspaceId]);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [workspaceAssistants, setWorkspaceAssistants] = useState<
    WorkspaceAssistantSummary[]
  >([]);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    listWorkspaceAssistants(workspaceId)
      .then((list) => {
        if (!cancelled) setWorkspaceAssistants(list);
      })
      .catch(() => {
        /* switcher just stays single-option; the default still works */
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // The assistant's display identity — drives the collapsed launcher's avatar
  // (its creature icon) instead of a generic chat glyph. Only the floating
  // launcher renders the FAB, so the fetch is skipped in side-panel mode.
  const [assistant, setAssistant] = useState<AssistantIdentity | null>(null);
  // Attached video is too large for the cache upload (Cloud Run's 32 MiB edge
  // cap / the 20 MB multer limit) and the model can't consume it inline, so
  // hand it to the recordings pipeline instead: direct-to-GCS upload → server
  // cost estimate → transcribe + file to the brain. `run` shows the full
  // pre-flight confirm — cost AND the blueprint picker (seeded from the
  // workspace default; no selection is passed here) — so a chat-dropped
  // recording can fill a blueprint exactly like a Studio upload.
  // See docs/architecture/media/transcription.md.
  const activeAssistantId = selectedAssistantId || assistantId;
  const rec = useRecordingUpload(workspaceId, activeAssistantId);
  const att = useFileAttachments(() => sessionIdRef.current ?? undefined, {
    // Only offer routing when we have a workspace + assistant to bind the
    // recording to; otherwise video falls to the guard (unsupported-here) chip.
    onRouteMedia:
      workspaceId && activeAssistantId
        ? (videos) => {
            void (async () => {
              for (const file of videos) await rec.run(file);
            })();
          }
        : undefined,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Resolve the assistant's avatar identity for the floating launcher FAB.
  useEffect(() => {
    if (isSidePanel || !selectedAssistantId) return;
    let cancelled = false;
    getAssistantIdentity(selectedAssistantId).then((identity) => {
      if (!cancelled) setAssistant(identity);
    });
    return () => {
      cancelled = true;
    };
  }, [isSidePanel, selectedAssistantId]);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [citations, setCitations] = useState<CitationSource[]>([]);
  // ToolUsedWithOps extends ToolUsed with optional per-op build-log lines
  // for patchPage. Defined below in the narration section.
  const [toolTimeline, setToolTimeline] = useState<ToolUsedWithOps[]>([]);
  const [notice, setNotice] = useState<InlineNotice | null>(null);
  // Model tier — persisted, plan-gated once /api/usage resolves. Replaces the
  // previously hardcoded "standard" send.
  const [model, setModel] = useState<ModelTier>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY);
      if (saved === "standard" || saved === "pro" || saved === "max") return saved;
    }
    return "standard";
  });
  const [workspacePlan, setWorkspacePlan] = useState<string | null>(null);
  // Research mode — ON adds `mode:'research'` to the next send (coordinator +
  // max-tier + higher turn ceiling, gated by the workspace's free quota).
  const [researchMode, setResearchMode] = useState(false);
  // Metered model selection (model-registry.md L8/L10/L15). Set ONLY through
  // the estimate→confirm flow in handleMeteredSelect — `meteredAccepted` on
  // the send body asserts the user saw the estimate at this budget. Research
  // mode wins over a metered pick (mirrors the server's precedence).
  const [metered, setMetered] = useState<{
    key: string;
    alias: string;
    profileId: string | null;
    toolRounds: number;
    label: string;
  } | null>(null);
  const [modelMenu, setModelMenu] = useState<import("@/lib/api/models").ModelMenu | null>(null);
  // Deferred research (surface seeds only): the first turn sends standard (a
  // cheap clarifying round-trip), then research arms once the reply lands —
  // the brain "Research my company" nudge semantics. Checked in onDone.
  const deferResearchRef = useRef(false);
  const [researchQuota, setResearchQuota] = useState<{ used: number; quota: number; isPaid: boolean } | null>(null);
  const [researchExhausted, setResearchExhausted] = useState(false);
  // askQuestion suspend-resume. When set, the session is suspended on a
  // `kind='question'` approval row: the composer is gated and the inline
  // answer panel renders below the messages. Cleared on submit/cancel.
  // See docs/architecture/engine/askquestion-suspend-resume.md.
  const [pendingQuestion, setPendingQuestion] = useState<{
    approvalId: string;
    question: string;
    expiresAt: string | null;
    sessionId: string;
  } | null>(null);
  // Drag-and-drop file attach over the whole chat panel. Disabled while a
  // clarifying question is pending (the composer is replaced by the answer
  // panel then, so there's nothing to attach to).
  const drop = useFileDrop((files) => void att.upload(files), {
    disabled: !!pendingQuestion,
  });
  // Set after the user answers/cancels — the resume worker takes a few
  // seconds to fire the continuation turn, so we poll session messages
  // for the synthesised reply to land without a manual refresh.
  const [resumePolling, setResumePolling] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ── Resizable floating dock ────────────────────────────────────────────
  // The bottom-right dock can be dragged bigger/smaller by its top + left
  // edges (it grows up-and-left from the corner). The size is persisted and
  // re-clamped to the viewport. Inert in side-panel / mobile-drawer modes,
  // which fill their host. See docs/architecture/features/doc.md → chat dock.
  const [chatSize, setChatSize] = useState<ChatSize>(() => {
    if (typeof window === "undefined") return DEFAULT_CHAT_SIZE;
    try {
      const raw = localStorage.getItem(SIZE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ChatSize>;
        if (typeof parsed?.w === "number" && typeof parsed?.h === "number") {
          return clampChatSize({ w: parsed.w, h: parsed.h });
        }
      }
    } catch {
      /* fall through to default */
    }
    return clampChatSize(DEFAULT_CHAT_SIZE);
  });
  // Live drag anchor — start pointer + size, and which edges this handle moves.
  const resizeRef = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
    axis: "x" | "y" | "xy";
  } | null>(null);
  const startResize = useCallback(
    (axis: "x" | "y" | "xy") => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = { x: e.clientX, y: e.clientY, w: chatSize.w, h: chatSize.h, axis };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — pointer events still fire on the handle */
      }
    },
    [chatSize.w, chatSize.h],
  );
  const moveResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const st = resizeRef.current;
    if (!st) return;
    // Anchored bottom-right: dragging the top edge UP (smaller clientY) and the
    // left edge LEFT (smaller clientX) makes the panel bigger.
    const dx = st.x - e.clientX;
    const dy = st.y - e.clientY;
    setChatSize(
      clampChatSize({
        w: st.axis === "y" ? st.w : st.w + dx,
        h: st.axis === "x" ? st.h : st.h + dy,
      }),
    );
  }, []);
  const endResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* nothing captured */
    }
  }, []);
  // Persist the size whenever it settles, and re-clamp on viewport shrink so the
  // dock never strands itself off-screen.
  useEffect(() => {
    if (isSidePanel || typeof window === "undefined") return;
    try {
      localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(chatSize));
    } catch {
      /* private mode — non-fatal */
    }
  }, [chatSize, isSidePanel]);
  useEffect(() => {
    if (isSidePanel || typeof window === "undefined") return;
    const onResize = () => setChatSize((s) => clampChatSize(s));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isSidePanel]);

  const session = useChatSession();
  const stream = useMessageStream();

  // ── Ref mirrors of state so SSE callbacks read latest without resub deps ──
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    sessionIdRef.current = session.state.sessionId;
  }, [session.state.sessionId]);

  // ── Thread reset ─────────────────────────────────────────────────────────
  // Abort any in-flight stream and wipe the bound session immediately. The
  // ref is set synchronously (the effect mirror lags a render) so a send
  // fired before the next paint can't reuse the old session id. Shared by
  // the assistant switcher, the origin (surface) switch, and surface seeds —
  // all three mean "the next send starts a fresh session". The epoch bump
  // invalidates any resume fetch still in flight (it checks the epoch before
  // dispatching), so a late response can't repopulate the wiped thread.
  const threadEpochRef = useRef(0);
  const resetThread = useCallback(() => {
    threadEpochRef.current += 1;
    stream.abort();
    sessionIdRef.current = null;
    session.setSession(null);
    session.loadMessages([]);
    session.clearConfirmations();
    setPendingQuestion(null);
    setResumePolling(false);
    setError(null);
    setNotice(null);
  }, [stream, session]);

  // ── Assistant switch ─────────────────────────────────────────────────────
  // A session is assistant-bound server-side: the backend rejects a turn when
  // `session.assistantId !== assistant.id`. So switching the interlocutor MUST
  // start a FRESH session — clear `sessionIdRef.current` (and the reducer's
  // session id + loaded messages) so the next send mints a new session for the
  // newly-selected assistant rather than appending to the old one. The
  // assistant-keyed resume effect then re-runs and pulls THAT assistant's
  // latest session for this surface, if any.
  const handleSwitchAssistant = useCallback(
    (id: string) => {
      setSwitcherOpen(false);
      if (id === selectedAssistantId) return;
      try {
        window.localStorage.setItem(activeAssistantStorageKey(workspaceId), id);
      } catch {
        /* private mode — selection just won't persist across reloads */
      }
      resetThread();
      setSelectedAssistantId(id);
    },
    [selectedAssistantId, workspaceId, resetThread],
  );

  // ── One persistent dock across every tab ─────────────────────────────────
  // The dock is mounted ONCE in `WorkspaceChrome` (the persistent workspace
  // layout) and stays mounted across every `/w/[id]/*` navigation, so an
  // in-flight turn keeps streaming when the user switches tabs (Home → Brain
  // → …). `origin` is therefore a constant `'doc'` here — there is no
  // per-surface dock to swap, so navigation must NOT reset the thread. (The
  // old design mounted a separate dock per surface and wiped the thread on the
  // `origin` change; that is exactly what made the conversation stop loading
  // on a tab switch.) See docs/architecture/features/doc.md → "One dock,
  // every surface".

  // ── Surface chat seeds ───────────────────────────────────────────────────
  // Any surface can open + prefill this dock via the shared seed bus
  // (`requestSurfaceChatSeed`; the brain pristine-nudge CTAs use the
  // `requestBrainChatSeed` alias). A nudge means "start a new conversation
  // about X" — reset the thread, expand, prefill, and arm research either for
  // this turn (`researchMode`) or the one after the first reply
  // (`deferResearch`). Listened for at every origin now that one unified dock
  // serves all surfaces — a brain nudge must still reach it on the doc origin.
  useEffect(() => {
    function onSeed(e: Event) {
      const seed = (e as CustomEvent<SurfaceChatSeed>).detail;
      if (!seed?.prefill?.trim()) return;
      resetThread();
      setExpanded(true);
      setInput(seed.prefill);
      deferResearchRef.current = !seed.researchMode && !!seed.deferResearch;
      setResearchMode(!!seed.researchMode);
    }
    window.addEventListener(SURFACE_CHAT_SEED_EVENT, onSeed);
    return () => window.removeEventListener(SURFACE_CHAT_SEED_EVENT, onSeed);
  }, [resetThread]);

  // The summary row for the currently-selected assistant — drives the header
  // switcher's avatar + name. Derived from the workspace list (fetched in both
  // floating + side-panel modes), with the avatar-only `assistant` identity as
  // a fallback before the list resolves.
  const activeAssistant = useMemo<
    Pick<WorkspaceAssistantSummary, "id" | "name" | "iconSeed"> | null
  >(() => {
    const fromList = workspaceAssistants.find((a) => a.id === selectedAssistantId);
    if (fromList) return fromList;
    if (assistant && assistant.id === selectedAssistantId) {
      return { id: assistant.id, name: assistant.name, iconSeed: assistant.iconSeed };
    }
    return selectedAssistantId
      ? { id: selectedAssistantId, name: t.emptyTitle, iconSeed: null }
      : null;
  }, [workspaceAssistants, selectedAssistantId, assistant, t.emptyTitle]);

  // Persist the model choice across sessions / reloads.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch {
      /* private mode — non-fatal */
    }
  }, [model]);

  // Resolve the workspace plan for model-tier gating (per-workspace billing).
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    authFetch(`${API_URL}/api/usage?workspace_id=${encodeURIComponent(workspaceId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { plan?: string } | null) => {
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

  // Snap an over-tier selection down once the plan resolves.
  // Metered menu — per-class models + saved profiles for this workspace
  // (absent models never listed: the server derives from configured provider
  // keys, L12). Fetched once per workspace; failure just hides the group.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void fetchModelMenu(workspaceId)
      .then((menu) => { if (!cancelled) setModelMenu(menu); })
      .catch(() => { if (!cancelled) setModelMenu(null); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  // Metered options: saved profiles first (named budgets), then the raw
  // models at their default 100-round budget. A profile some class names as
  // its workspace default sorts to the top with a default sublabel — the
  // default is prominence only, never a silent arm: picking it still runs
  // the same estimate→confirm flow (L8).
  const meteredOptions = useMemo(() => {
    if (!modelMenu) return [];
    const models = modelMenu.classes["metered"] ?? [];
    const defaultProfileIds = new Set(
      (modelMenu.defaults ?? []).map((d) => d.meteredProfileId).filter(Boolean),
    );
    const profiles = [...modelMenu.profiles].sort(
      (a, b) => Number(defaultProfileIds.has(b.id)) - Number(defaultProfileIds.has(a.id)),
    );
    const opts: Array<{ key: string; label: string; sublabel: string }> = [];
    for (const prof of profiles) {
      const sub = t.meteredProfileSub.replace("{rounds}", String(prof.toolRounds));
      opts.push({
        key: `p:${prof.id}`,
        label: `${prof.modelAlias} / ${prof.name}`,
        sublabel: defaultProfileIds.has(prof.id) ? `${t.meteredDefaultTag} · ${sub}` : sub,
      });
    }
    for (const m of models) {
      opts.push({ key: `m:${m.alias}`, label: m.alias, sublabel: t.meteredModelSub });
    }
    return opts;
  }, [modelMenu, t]);

  // Pre-flight invariant (L8): estimate at the CHOSEN budget → confirm →
  // only then arm the selection. The send body then carries
  // `meteredAccepted: true`; the server re-enforces regardless.
  const handleMeteredSelect = useCallback(
    (key: string | null) => {
      if (!key) { setMetered(null); return; }
      if (!workspaceId || !modelMenu) return;
      let alias: string; let profileId: string | null = null; let toolRounds = 100; let label: string;
      if (key.startsWith("p:")) {
        const prof = modelMenu.profiles.find((x) => x.id === key.slice(2));
        if (!prof) return;
        alias = prof.modelAlias; profileId = prof.id; toolRounds = prof.toolRounds;
        label = `${prof.modelAlias} / ${prof.name}`;
      } else {
        alias = key.slice(2); label = alias;
      }
      void (async () => {
        let description = t.meteredConfirmNoBilling.replace("{model}", label).replace("{rounds}", String(toolRounds));
        if (modelMenu.meteredBillingAvailable) {
          try {
            const est = await fetchMeteredEstimate(workspaceId, alias, toolRounds);
            if (est) {
              description = t.meteredConfirmBody
                .replace("{model}", label)
                .replace("{rounds}", String(est.toolRounds))
                .replace("{min}", String(est.minCredits))
                .replace("{max}", String(est.maxCredits));
            }
          } catch {
            // Estimate unavailable → confirm still shows the budget.
          }
        }
        const ok = await confirmDialog({
          title: t.meteredConfirmTitle,
          description,
          confirmLabel: t.meteredConfirmCta,
        });
        if (ok) {
          setResearchMode(false);
          setMetered({ key, alias, profileId, toolRounds, label });
        }
      })();
    },
    [workspaceId, modelMenu, t],
  );

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

  // Tracks the draft currently open on the doc. `renderView` appends
  // to this draft when set; otherwise creates a new draft. Lives in a
  // ref so the SSE callback reads the latest without re-binding.
  const activeViewIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Active page = the `/p/<pageId>` path segment (canonical URL).
    activeViewIdRef.current = pageIdFromPathname(pathname);
  }, [pathname]);

  // Tracks the workspace skill open in the Brain skill editor, the same
  // path-derived way. Sent as `viewingSkillRowId` so the assistant knows
  // which skill the user is looking at — the server injects the skill's
  // saved contents as turn context ("this skill" resolves to it).
  const viewingSkillRowIdRef = useRef<string | null>(null);
  useEffect(() => {
    viewingSkillRowIdRef.current = skillRowIdFromPathname(pathname);
  }, [pathname]);

  // Tracks the deck open in the live preview route, the same path-derived
  // way. Sent as `viewingDeckId` so "this deck" / "slide 3" resolve to the
  // preview the user is watching (server injects the deck outline as turn
  // context; the preview refreshes live after each edit).
  const viewingDeckIdRef = useRef<string | null>(null);
  useEffect(() => {
    viewingDeckIdRef.current = deckIdFromPathname(pathname);
  }, [pathname]);

  // Per-turn buffers — keyed by toolUseId / URL so re-emits replace prior entry.
  const turnViewsRef = useRef<ViewAttachment[]>([]);
  const turnTextRef = useRef("");
  // A multi-step turn streams text in segments separated by tool activity:
  // any prose the model emits alongside/around an intermediate tool step is
  // step narration, NOT the answer — the answer is the LAST text segment
  // (the tool-free synthesis turn). Without segmenting, a stray token the
  // model glues onto a tool-call turn (observed: Gemini echoing a `"20"`
  // text part next to an `inspectMyActivity(limit:20)` call) gets concatenated
  // in front of the real answer, e.g. "20I have diagnosed…".
  //
  // `tool_start` arms this flag (once per segment) and clears the live stream
  // buffer immediately, so the stale segment stops showing in the reply
  // preview while the tool runs. The next `text_delta` then discards the prior
  // segment from the finalized-message buffer (`turnTextRef`) before appending.
  // The finalized-buffer discard is deliberately LAZY (arm-then-discard-on-
  // next-text) rather than eager: a turn that answers and THEN calls a
  // bookkeeping tool (text, then `saveMemory`, then end-of-turn) has no later
  // text to trigger the discard, so `turnTextRef` keeps that answer.
  const pendingAnswerResetRef = useRef(false);
  const turnCitationsRef = useRef<CitationSource[]>([]);
  // Outbound file attachments (`sendFile`) — set by the `attachments` SSE
  // event, merged into the finalized assistant message at stream end.
  const turnFileAttachmentsRef = useRef<ChatFileAttachment[]>([]);
  const turnToolsRef = useRef<ToolUsedWithOps[]>([]);
  const turnWorkerDescriptionsRef = useRef<Map<string, string>>(new Map());
  // Accumulates the live `reasoning` SSE event text (verbatim model thinking),
  // streamed token-by-token alongside tool events. Reset per turn.
  const turnReasoningRef = useRef("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  // The turn's chronological build-event log — reasoning runs + build-step
  // narrations interleaved in SSE arrival order — published on the
  // build-activity bus to drive the inline generating widget's rolling feed.
  // `eventSeqRef` mints deterministic per-turn ids (counter, never
  // Date.now/random); `eventedToolIdsRef` dedups a re-emitted `tool_input`.
  const eventLogRef = useRef<EventLog>(EMPTY_LOG);
  const eventSeqRef = useRef(0);
  const eventedToolIdsRef = useRef<Set<string>>(new Set());
  const [streamingEvents, setStreamingEvents] = useState<BuildEvent[]>([]);
  const mintEventId = useCallback(() => `ev-${eventSeqRef.current++}`, []);
  // Per-tool call timing (performance.now at `tool_start`, closed at
  // `tool_result` into `durationMs`) — the activity feed's per-step readout.
  const toolStartTimesRef = useRef<Map<string, number>>(new Map());
  // Turn t0 (epoch ms) — drives the live elapsed counter and the committed
  // message's "Worked for Ns" receipt.
  const turnStartedAtRef = useRef<number | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  // Latest research/coordinator `status` phase for this turn — the activity
  // header shows it while no tool narration outranks it.
  const [researchPhase, setResearchPhase] = useState<ResearchPhase | null>(null);
  // Server-assigned assistant message id (from `assistant_message_saved`).
  const assistantIdRef = useRef<string | null>(null);
  // Set when this turn emitted an askQuestion confirmation (the suspend
  // path). The event carries no approvalId, so onDone probes GET /pending
  // to fetch it and surface the answer panel immediately — without making
  // the user send a doomed message first.
  const turnAskedQuestionRef = useRef(false);

  // ── Live activity mirror to parent + collapsed pill ────────────────────
  const isStreaming = session.state.isStreaming;
  const streamingText = session.state.streamingText;
  const activity = useMemo<ChatActivity>(() => {
    if (!isStreaming) {
      return { isStreaming: false, streamingText: "", activeTool: null };
    }
    const running = toolTimeline.find((t) => t.status === "running");
    const last =
      running ??
      (toolTimeline.length > 0
        ? toolTimeline[toolTimeline.length - 1]
        : undefined);
    return {
      isStreaming: true,
      streamingText,
      activeTool: last
        ? {
            name: last.name,
            description: last.description,
            status: last.status,
          }
        : null,
    };
  }, [isStreaming, streamingText, toolTimeline]);

  const onActivityChangeRef = useRef(onActivityChange);
  useEffect(() => {
    onActivityChangeRef.current = onActivityChange;
  }, [onActivityChange]);
  useEffect(() => {
    onActivityChangeRef.current?.(activity);
  }, [activity]);

  // Publish the full live detail (tool timeline + streaming text + reasoning)
  // to the build-activity bus so the page-body drafting indicator can render
  // it step-by-step. Fires per token; the bus keeps that off the heavy shell
  // tree (only the small indicator subtree subscribes). Doc-only — the
  // indicator lives in the page editor, which a surface dock never overlays.
  // See lib/build-activity.ts.
  useEffect(() => {
    if (!isDocOrigin) return;
    publishBuildActivity({
      isStreaming,
      tools: toolTimeline,
      text: streamingText,
      reasoning: streamingReasoning,
      events: streamingEvents,
    });
  }, [isDocOrigin, isStreaming, toolTimeline, streamingText, streamingReasoning, streamingEvents]);

  // ── Auto-scroll + escape/click-outside ─────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [
    session.state.messages,
    session.state.streamingText,
    toolTimeline,
    session.state.pendingConfirmations,
    pendingQuestion,
    resumePolling,
  ]);

  // A suspended question is not "active" (isStreaming is false once the
  // turn exits), so the live-activity pill won't signal it. Auto-expand
  // when a question appears — live or restored on reload — so the user
  // sees the answer panel instead of a silently-wedged composer. Fires
  // once per question (deps = the question ref), so manual collapse still
  // sticks afterward.
  useEffect(() => {
    if (pendingQuestion) setExpanded(true);
  }, [pendingQuestion]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ESC while streaming aborts the in-flight turn rather than
        // closing the panel — matches apps/web's behaviour. Click X to
        // collapse.
        if (stream.inFlight()) {
          stream.abort();
          session.dispatch({ type: "stream/abort" });
          return;
        }
        setExpanded(false);
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      // Preserve clicks landing inside portals (base-ui / radix dropdowns).
      if (
        target.closest("[data-radix-popper-content-wrapper]") ||
        target.closest("[data-base-ui-popup]") ||
        target.closest('[role="listbox"]') ||
        target.closest('[role="menu"]') ||
        target.closest('[role="dialog"]') ||
        target.closest('[role="tooltip"]')
      ) {
        return;
      }
      const node = panelRef.current;
      if (!node) return;
      if (node.contains(target as Node)) return;
      setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [expanded, stream, session]);

  // ── Session resume on mount ────────────────────────────────────────────
  //
  // Page reload should restore the most recent doc-scoped session for
  // this workspace + assistant so the user doesn't lose their thread on
  // refresh. One effect owns the full async sequence: list latest →
  // fetch messages → seed the reducer. Bails on:
  //
  //   • assistantId change mid-flight (AbortController + cancelled flag).
  //   • existing local state (sessionId already set, messages already
  //     populated, or stream in flight) — we never trample a fresh chat.
  //   • fetch failure → silent no-op (matches the "no error toast" rule
  //     in the spec — start fresh instead).
  //
  // Resumed messages are minted as `Message` rows identical in shape to
  // the SSE-finalised ones, so downstream renders (`MessageBubble`,
  // citations, retry handlers) treat them uniformly. Tool calls and
  // view payloads are intentionally omitted from the rehydrated state —
  // those only surface live via SSE; restoring them from `content`
  // JSONB would require parsing tool_use blocks and re-resolving view
  // payloads from the server, which is out of scope here.
  const sessionDispatchRef = useRef(session.dispatch);
  useEffect(() => {
    sessionDispatchRef.current = session.dispatch;
  }, [session.dispatch]);
  const streamRef = useRef(stream);
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  useEffect(() => {
    if (!selectedAssistantId) return;
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      // Don't trample an in-flight or already-populated session. The
      // refs avoid re-triggering the effect when those values change.
      if (sessionIdRef.current) return;
      if (streamRef.current.inFlight()) return;
      // A resetThread() (surface seed / assistant or origin switch) while
      // this fetch is in flight bumps the epoch — bail instead of
      // repopulating the freshly-wiped thread.
      const epoch = threadEpochRef.current;

      const latest = await fetchLatestSession({
        workspaceId,
        assistantId: selectedAssistantId,
        // Sessions are stamped per-surface — the doc dock resumes its doc
        // thread, a Brain dock its brain thread, and so on.
        appOrigin: origin,
        signal: controller.signal,
      });
      if (cancelled || !latest) return;

      // askQuestion suspend-resume: restore the inline answer panel if
      // this session was suspended on a question (e.g. the user reloaded
      // the page mid-wait — the exact wedge the screenshot showed). The
      // composer gate + panel let them answer or cancel instead of
      // hitting `pending_question_exists` on the next message.
      void fetchPendingQuestion(latest.id)
        .then((q) => {
          if (cancelled || !q || epoch !== threadEpochRef.current) return;
          setPendingQuestion({
            approvalId: q.approvalId,
            question: q.question ?? "",
            expiresAt: q.expiresAt,
            sessionId: latest.id,
          });
        })
        .catch(() => {});

      const rows = await fetchSessionMessages(latest.id, {
        signal: controller.signal,
      });
      if (cancelled) return;

      const messages = mapSessionRows(rows, t.toolNarration);

      if (messages.length === 0) {
        // Empty session — treat as no resume so a fresh send still
        // mints a new session id rather than appending to this one.
        return;
      }

      // Final guards: another concurrent send may have set the session
      // id, or a resetThread() may have wiped the thread, while we were
      // fetching. Either way, bail rather than overwrite.
      if (sessionIdRef.current) return;
      if (epoch !== threadEpochRef.current) return;

      const dispatch = sessionDispatchRef.current;
      dispatch({ type: "session/set", sessionId: latest.id });
      dispatch({ type: "messages/load", messages });
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedAssistantId, workspaceId, origin]);

  // askQuestion suspend-resume: after the user answers/cancels, the
  // resume worker fires a continuation turn on the poll-worker tick.
  // Poll session messages at 2s (up to 120s) so the synthesised reply
  // lands without a manual refresh, then stop. See
  // docs/architecture/engine/askquestion-suspend-resume.md.
  useEffect(() => {
    const sid = session.state.sessionId;
    if (!resumePolling || !sid) return;
    const startedAt = Date.now();
    const baseline = session.state.messages.length;
    const controller = new AbortController();
    const interval = setInterval(() => {
      if (Date.now() - startedAt > 120_000) {
        setResumePolling(false);
        return;
      }
      void fetchSessionMessages(sid, { signal: controller.signal })
        .then((rows) => {
          const mapped = mapSessionRows(rows, t.toolNarration);
          if (mapped.length <= baseline) return;
          sessionDispatchRef.current({ type: "messages/load", messages: mapped });
          setResumePolling(false);
        })
        .catch(() => {});
    }, 2_000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [resumePolling, session.state.sessionId, session.state.messages.length]);

  // ── Send + SSE loop ────────────────────────────────────────────────────

  /** Reset all per-turn buffers/state. Called at the start of each send. */
  const resetTurnBuffers = useCallback(() => {
    turnViewsRef.current = [];
    turnTextRef.current = "";
    pendingAnswerResetRef.current = false;
    turnCitationsRef.current = [];
    turnFileAttachmentsRef.current = [];
    turnToolsRef.current = [];
    turnWorkerDescriptionsRef.current = new Map();
    turnReasoningRef.current = "";
    eventLogRef.current = EMPTY_LOG;
    eventSeqRef.current = 0;
    eventedToolIdsRef.current = new Set();
    toolStartTimesRef.current = new Map();
    turnStartedAtRef.current = Date.now();
    assistantIdRef.current = null;
    turnAskedQuestionRef.current = false;
    setCitations([]);
    setToolTimeline([]);
    setStreamingReasoning("");
    setStreamingEvents([]);
    setTurnStartedAt(turnStartedAtRef.current);
    setResearchPhase(null);
  }, []);

  const sendMessage = useCallback(
    async (
      text: string,
      override?: {
        /**
         * Server-assigned id of the message that should be deleted along
         * with everything after it before the new turn starts. Used by
         * Retry to replace a prior assistant message.
         */
        truncateFromMessageId?: string;
        /**
         * Anchor this turn to a specific page (overriding the path-derived
         * id). The landing's build flow passes its pre-created draft id so
         * the model edits THAT page even before the path has settled.
         */
        docViewId?: string;
        /** Insertion anchor for this turn (overrides the pending Space-for-AI
         *  anchor) — the block the AI should generate after. */
        docAnchorBlockId?: string;
        /** Model tier + research flag for this turn, overriding the chat's
         *  current selection (the landing's picker drives the build turn). */
        model?: ModelTier;
        researchMode?: boolean;
        /** Attachment ids handed in from the seeding surface (the landing),
         *  used instead of this chat's own staged tray for the build turn. */
        fileIds?: string[];
      },
    ): Promise<boolean> => {
      // Guard block — each early-return reports `false` so callers (the seed
      // effect) know the send didn't start and must not burn the nonce.
      const trimmed = text.trim();
      const seededFileIds = override?.fileIds ?? [];
      if (!trimmed && !att.hasReady && seededFileIds.length === 0) return false;
      if (stream.inFlight()) return false;
      if (att.uploading) return false;
      // Suspended on a question — the answer flows through the inline
      // panel (POST /answer), never a fresh chat turn. Guards the Retry
      // path too, which calls sendMessage directly past the disabled composer.
      if (pendingQuestion) return false;

      // Snapshot the ready attachment ids for this turn, then clear the tray.
      // A seed (the landing's build flow) hands its own ids in — those win,
      // since this chat's own tray is empty on that path.
      const turnFileIds =
        seededFileIds.length > 0 ? seededFileIds : att.fileIds();

      // One-shot insertion anchor: the inline Space-for-AI box passes it on the
      // autoSend override (via the seed). Absent → the turn appends at the page
      // end as usual.
      const anchorBlockId = override?.docAnchorBlockId;

      const localUserId = `local-${Date.now()}`;
      // Snapshot the ready chips (this render) so the sent bubble shows the
      // user's own images/files immediately — otherwise they upload + ride the
      // turn as `fileIds` but leave no visible record. Reuse each chip's preview
      // object URL as the thumbnail; `att.detach()` (below) clears the tray
      // WITHOUT revoking these, transferring URL ownership to the message.
      const userAttachments: MessageAttachmentRef[] = readyAttachments(
        att.attachments,
      ).map((a) => ({
        id: a.fileId!,
        name: a.fileName,
        mime: a.mimeType,
        ...(a.previewUrl ? { dataUrl: a.previewUrl } : {}),
      }));
      const userMessage: MessageWithViews = {
        id: localUserId,
        role: "user",
        text: trimmed,
        timestamp: new Date(),
        ...(userAttachments.length > 0 ? { userAttachments } : {}),
      };
      session.appendMessage(userMessage);
      setInput("");
      att.detach();
      setError(null);
      setNotice(null);
      setResumePolling(false);
      session.clearConfirmations();
      session.dispatch({ type: "stream/start" });
      resetTurnBuffers();

      await stream.start({
        url: `${API_URL}/api/chat`,
        authFetch: (url, init) => authFetch(String(url), init),
        body: {
          message: trimmed,
          ...(turnFileIds.length > 0 ? { fileIds: turnFileIds } : {}),
          sessionId: sessionIdRef.current ?? undefined,
          // The landing's picker overrides the chat's current tier for the
          // build turn; otherwise the chat's own selection is used. An armed
          // metered pick (confirmed at selection time) wins over the tier —
          // unless this turn runs research mode, which forces its own model.
          model:
            metered && !override?.model && !(override?.researchMode ?? researchMode)
              ? metered.alias
              : override?.model ?? model,
          ...(metered && !override?.model && !(override?.researchMode ?? researchMode)
            ? {
                meteredAccepted: true,
                ...(metered.profileId
                  ? { meteredProfileId: metered.profileId }
                  : { meteredToolRounds: metered.toolRounds }),
              }
            : {}),
          // Deep-research mode → coordinator + max-tier + higher ceiling,
          // gated server-side by the workspace's free-research quota.
          ...((override?.researchMode ?? researchMode) ? { mode: "research" as const } : {}),
          workspaceId,
          // The selected interlocutor (primary by default, or whatever the
          // switcher set). A session is assistant-bound; the switch handler
          // wipes `sessionIdRef` so this turn mints a fresh session when the
          // assistant changed.
          assistantId: selectedAssistantId,
          // Migrations 187/255 — stamps newly-created sessions with the
          // surface they came from, so threads + Recents scope per-surface.
          appOrigin: origin,
          // Anchors the turn to a doc page: the model edits THAT page
          // (`patchPage`) instead of minting a fresh draft. An explicit
          // override (the landing's pre-created draft) wins over the
          // path-derived id, which may not have settled yet; absent both,
          // the next message mints a new draft. Doc-only — a workspace
          // surface never anchors to a page.
          ...(isDocOrigin && (override?.docViewId ?? activeViewIdRef.current)
            ? { docViewId: override?.docViewId ?? activeViewIdRef.current }
            : {}),
          // Empty-line "Space for AI": tells the server to inject an
          // insertion-anchor note so the model generates AFTER this block
          // (chat.ts → patchPage `add { after }`). Doc-only.
          ...(isDocOrigin && anchorBlockId
            ? { docAnchorBlockId: anchorBlockId }
            : {}),
          // The Brain skill editor route: tell the server which skill the
          // user is viewing so its saved contents ride the turn context.
          ...(viewingSkillRowIdRef.current
            ? { viewingSkillRowId: viewingSkillRowIdRef.current }
            : {}),
          // The deck live-preview route: tell the server which deck the
          // user is watching so its slide outline rides the turn context.
          ...(viewingDeckIdRef.current
            ? { viewingDeckId: viewingDeckIdRef.current }
            : {}),
          // The custom theme the user currently has applied (a per-user
          // localStorage value). Lets the server inject `refineActiveTheme` so
          // "make my theme warmer" works in chat. Only sent on a custom
          // palette, and only from the doc dock (theming is a doc affordance).
          ...(() => {
            const themeId =
              isDocOrigin &&
              typeof window !== "undefined" &&
              window.localStorage.getItem("doc:palette") === "custom"
                ? window.localStorage.getItem("doc:customThemeId")
                : null;
            return themeId ? { docActiveThemeId: themeId } : {};
          })(),
          ...(override?.truncateFromMessageId
            ? { truncateFromMessageId: override.truncateFromMessageId }
            : {}),
          ...(CLIENT_TIMEZONE ? { timezone: CLIENT_TIMEZONE } : {}),
        },
        onEvent: (event) => {
          const payload = coercePayload(event.data);
          switch (event.event) {
            case "session": {
              const id =
                typeof payload.sessionId === "string"
                  ? payload.sessionId
                  : null;
              if (id) session.setSession(id);
              break;
            }
            case "text_delta": {
              const delta = typeof payload.text === "string" ? payload.text : "";
              if (delta) {
                // A new answer segment is starting after intermediate tool
                // activity — the prior segment was step narration, not the
                // answer. Discard it from the finalized-message buffer so only
                // the last segment survives. (`tool_start` already cleared the
                // live stream buffer when it armed this flag.) See
                // `pendingAnswerResetRef` above.
                if (pendingAnswerResetRef.current) {
                  pendingAnswerResetRef.current = false;
                  turnTextRef.current = "";
                }
                turnTextRef.current += delta;
                session.dispatch({ type: "stream/append", text: delta });
              }
              break;
            }
            case "reasoning": {
              // Verbatim model thinking streamed live token-by-token. Accumulated
              // into `turnReasoningRef` and published to the build-activity bus so
              // the page-body indicator can render it in a distinct muted section.
              const delta = typeof payload.text === "string" ? payload.text : "";
              if (delta) {
                turnReasoningRef.current += delta;
                setStreamingReasoning(turnReasoningRef.current);
                // Fold the run into the chronological event log — coalesced
                // into one advancing "thinking" line until a step closes it.
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
              // Worker descriptions land before the tools they spawn —
              // cache them so `tool_start` can attach the description
              // to its timeline entry.
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
              // Dedup — re-emits keep the existing row (status may already
              // be `done` from a retry replay).
              if (turnToolsRef.current.some((t) => t.id === id)) break;
              // A tool step is beginning: any answer prose accumulated so far
              // was step narration, not the final answer. Arm the segment
              // reset so the NEXT `text_delta` discards it from the finalized
              // buffer (lazy — an answer-then-tool turn with no trailing text
              // keeps its answer), and clear the live stream buffer now so the
              // stale segment doesn't linger in the reply preview while the
              // tool runs. Guarded to fire once per segment (no redundant
              // dispatches across a multi-tool step). See `pendingAnswerResetRef`.
              if (!pendingAnswerResetRef.current) {
                pendingAnswerResetRef.current = true;
                session.dispatch({ type: "stream/reset" });
              }
              toolStartTimesRef.current.set(id, performance.now());
              const workerId =
                typeof payload.workerId === "string"
                  ? payload.workerId
                  : undefined;
              const workerDescription = workerId
                ? turnWorkerDescriptionsRef.current.get(workerId)
                : undefined;
              // Seed the friendliest label we can before the input parses —
              // the static per-tool map ("Checking your calendar") beats a
              // raw "Running gmailListMessages" placeholder. `tool_input`
              // upgrades it to the input-aware line moments later.
              const seeded = describeToolFromInput(name, {}, t.toolNarration);
              const entry: ToolUsedWithOps = {
                id,
                name,
                status: "running",
                description: seeded.description,
                ...(workerId ? { workerId } : {}),
                ...(workerDescription ? { workerDescription } : {}),
              };
              turnToolsRef.current = [...turnToolsRef.current, entry];
              setToolTimeline(turnToolsRef.current);
              // Mint the step row now so the feed shows the call the moment
              // it starts; `tool_input` rewrites the text in place.
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
              // The engine stripped this tool call from the persisted turn
              // (today: an askQuestion no-op) — retract the phantom timeline
              // step so the live UI matches what was saved. See
              // docs/architecture/engine/askquestion-suspend-resume.md.
              const id = typeof payload.id === "string" ? payload.id : "";
              if (!id) break;
              turnToolsRef.current = turnToolsRef.current.filter(
                (tool) => tool.id !== id,
              );
              setToolTimeline(turnToolsRef.current);
              // Retract the phantom rows from the event feed too.
              eventLogRef.current = removeToolSteps(eventLogRef.current, id);
              setStreamingEvents(eventLogRef.current.events);
              eventedToolIdsRef.current.delete(id);
              toolStartTimesRef.current.delete(id);
              break;
            }
            case "tool_input": {
              // Decorate the entry with a human-readable description now
              // that we know the tool's arguments. For `patchPage`, also
              // attach per-op narration lines so the build indicator renders
              // a live log of what the model is writing.
              const id = typeof payload.id === "string" ? payload.id : "";
              const name = typeof payload.name === "string" ? payload.name : "";
              if (!id) break;
              const input =
                payload.input && typeof payload.input === "object"
                  ? (payload.input as Record<string, unknown>)
                  : {};
              const narration = describeToolFromInput(
                name,
                input,
                t.toolNarration,
              );
              if (!narration) break;
              turnToolsRef.current = (turnToolsRef.current as ToolUsedWithOps[]).map((tool) =>
                tool.id === id
                  ? {
                      ...tool,
                      description: narration.description,
                      ...(narration.url ? { url: narration.url } : {}),
                      // patchPage: per-op narration lines for the build log.
                      ...(narration.opLines ? { opLines: narration.opLines } : {}),
                    }
                  : tool,
              );
              setToolTimeline(turnToolsRef.current);
              // Upgrade the tool's placeholder row (minted at `tool_start`)
              // to the input-aware narration, then append one extra row per
              // remaining `patchPage` op so the feed reads like a live build
              // log. Dedup a re-emitted `tool_input` for the same tool id.
              if (!eventedToolIdsRef.current.has(id)) {
                eventedToolIdsRef.current.add(id);
                const stepLines =
                  narration.opLines && narration.opLines.length > 0
                    ? narration.opLines
                    : [narration.description];
                const [first, ...rest] = stepLines;
                if (first) {
                  eventLogRef.current = updateStepText(
                    eventLogRef.current,
                    id,
                    first,
                    narration.url,
                  );
                }
                for (const line of rest) {
                  eventLogRef.current = appendStep(
                    eventLogRef.current,
                    line,
                    mintEventId,
                    { toolId: id },
                  );
                }
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
                      status: isError ? "retried" : "done",
                      ...(durationMs != null ? { durationMs } : {}),
                      ...(isError && errorMessage ? { errorMessage } : {}),
                    }
                  : tool,
              );
              setToolTimeline(turnToolsRef.current);
              // If a confirmed tool failed at execution time, flip the
              // green "Done" pill to red so the UI doesn't lie.
              if (isError) {
                const conf = session.state.pendingConfirmations.find(
                  (p) => p.toolCallId === id,
                );
                if (conf && conf.status === "approved") {
                  session.updateConfirmation(id, {
                    status: "failed",
                    ...(errorMessage ? { result: errorMessage } : {}),
                  });
                }
              }
              break;
            }
            case "citation": {
              if (!Array.isArray(payload.sources)) break;
              const raw = payload.sources as Array<{
                url?: unknown;
                title?: unknown;
              }>;
              for (const s of raw) {
                if (typeof s.url !== "string" || typeof s.title !== "string") {
                  continue;
                }
                if (
                  turnCitationsRef.current.some((c) => c.url === s.url)
                ) {
                  continue;
                }
                turnCitationsRef.current = [
                  ...turnCitationsRef.current,
                  { url: s.url, title: s.title },
                ];
              }
              setCitations(turnCitationsRef.current);
              break;
            }
            case "status": {
              // Research / coordinator phase codes only — `message`-only
              // statuses (connection retry, turn limit) stay silent. See
              // docs/architecture/engine/live-streaming.md → research banner.
              const phase =
                typeof payload.phase === "string" ? payload.phase : "";
              if (phase === "research_detected") setResearchPhase("detected");
              else if (phase === "research_starting") setResearchPhase("starting");
              else if (phase === "research_parallel") setResearchPhase("parallel");
              break;
            }
            case "tool_confirmation_required": {
              // askQuestion suspend-resume: the suspended question gets
              // its own inline answer panel (driven by the paired
              // `awaiting_approval` below), not the generic approve/deny
              // card. Rendering both would show two UIs for one row.
              // The event has no approvalId, so flag the turn and let
              // onDone probe GET /pending for the row + question.
              if (payload.toolName === "askQuestion") {
                turnAskedQuestionRef.current = true;
                break;
              }
              const toolCallId =
                typeof payload.toolCallId === "string"
                  ? payload.toolCallId
                  : "";
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
            case "awaiting_approval": {
              // askQuestion suspend-resume durability marker. For the
              // askQuestion tool, flip the chat into the suspended state
              // so the inline answer panel renders + the composer gates.
              // Other approval kinds keep flowing through the regular
              // confirmation UX above.
              if (payload.toolName !== "askQuestion") break;
              const approvalId =
                typeof payload.approvalId === "string"
                  ? payload.approvalId
                  : "";
              const sid = sessionIdRef.current ?? "";
              if (!approvalId || !sid) break;
              const toolInput =
                payload.toolInput && typeof payload.toolInput === "object"
                  ? (payload.toolInput as Record<string, unknown>)
                  : {};
              const question =
                typeof toolInput.question === "string"
                  ? toolInput.question
                  : typeof payload.describeText === "string"
                    ? payload.describeText
                    : "";
              setPendingQuestion({
                approvalId,
                question,
                expiresAt:
                  typeof payload.expiresAt === "string"
                    ? payload.expiresAt
                    : null,
                sessionId: sid,
              });
              break;
            }
            case "notice": {
              const code = typeof payload.code === "string" ? payload.code : "";
              if (code === "budget_downgraded") {
                setNotice({
                  code,
                  message: t.noticeBudgetDowngraded,
                });
              } else if (typeof payload.message === "string") {
                setNotice({ code, message: payload.message });
              }
              break;
            }
            case "view_payload": {
              // `renderView` lands a `data` block on a draft, server-side.
              // Doc is a draft-first surface — we never inline-render
              // the widget in chat; we just keep a pointer + (1) bridge
              // to the sidebar refresh, (2) auto-navigate to the draft
              // when a new one was created so the user sees the result.
              const toolUseId =
                typeof payload.toolUseId === "string"
                  ? payload.toolUseId
                  : "";
              const action =
                payload.action === "appended" || payload.action === "created"
                  ? payload.action
                  : undefined;
              const incoming: ViewAttachment = {
                toolUseId,
                payload: undefined,
                entity:
                  typeof payload.entity === "string"
                    ? payload.entity
                    : undefined,
                viewType:
                  typeof payload.viewType === "string"
                    ? payload.viewType
                    : undefined,
                viewId:
                  typeof payload.viewId === "string" &&
                  payload.viewId.length > 0
                    ? payload.viewId
                    : undefined,
                action,
              };
              turnViewsRef.current = [
                ...turnViewsRef.current.filter(
                  (v) => v.toolUseId !== incoming.toolUseId,
                ),
                incoming,
              ];
              if (incoming.viewId && typeof window !== "undefined") {
                // Refresh the doc sidebar so the draft surfaces
                // (created path) or its updated_at floats (appended).
                window.dispatchEvent(
                  new CustomEvent("doc:draft-created", {
                    detail: {
                      viewId: incoming.viewId,
                      toolUseId: incoming.toolUseId,
                      action: incoming.action,
                    },
                  }),
                );
                // Created path → land the user on the new draft so they
                // see the result immediately. Appended path leaves the
                // route alone; the page renderer rereads on focus.
                // Doc-only: a surface dock unmounts when the route leaves
                // its surface, which would kill this very stream — the
                // message's "Open in this doc" pill is the user-initiated
                // path there.
                if (
                  isDocOrigin &&
                  incoming.action === "created" &&
                  incoming.viewId !== activeViewIdRef.current
                ) {
                  // Canonical path → soft transition (no proxy redirect /
                  // full reload). The page renderer swaps in place.
                  router.replace(
                    docPagePath(workspaceId, incoming.viewId),
                    { scroll: false },
                  );
                }
              }
              break;
            }
            case "sub_page_created": {
              // The AI filed a new nested sub-page (createSubPage). It doesn't
              // ride the renderView/view_payload path, so bridge it to the
              // same `doc:draft-created` reload event — otherwise the child
              // sits server-side, invisible, until a manual refresh (its
              // parent never grows a disclosure chevron). We deliberately do
              // NOT navigate: the user asked to file a child under the page
              // they're on, not to jump into it (and one turn may create
              // several). The always-on sidebar toggle then reveals it.
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("doc:draft-created", {
                    detail: {
                      viewId:
                        typeof payload.pageId === "string"
                          ? payload.pageId
                          : undefined,
                      action: "created",
                    },
                  }),
                );
              }
              break;
            }
            case "page_created": {
              // The AI authored a brand-new ROOT page (renderPage) — e.g. the
              // user explicitly asked for a separate new page. Unlike a
              // sub-page, surface it the way the renderView/view_payload created
              // path did: reload the sidebar so the draft appears, then land the
              // user on it so they see the result immediately. Without this the
              // page is created server-side but stays invisible until a manual
              // refresh (the 2026-06-02 orphan-page incident).
              const newPageId =
                typeof payload.pageId === "string" ? payload.pageId : undefined;
              if (newPageId && typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("doc:draft-created", {
                    detail: { viewId: newPageId, action: "created" },
                  }),
                );
                // Doc-only auto-nav — same rationale as view_payload above:
                // leaving the surface would unmount this dock mid-stream.
                if (isDocOrigin && newPageId !== activeViewIdRef.current) {
                  router.replace(docPagePath(workspaceId, newPageId), {
                    scroll: false,
                  });
                }
              }
              break;
            }
            case "comment_posted":
            case "comment_resolved": {
              // The AI posted/resolved a comment thread (render-first
              // annotation, or a fan-out of several). Tell the editor to
              // refetch this page's threads + repaint the gutter. The editor
              // owns thread state; we just signal "something changed".
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent(DOC_COMMENTS_CHANGED_EVENT, {
                    detail: {
                      threadId:
                        typeof payload.threadId === "string"
                          ? payload.threadId
                          : undefined,
                    },
                  }),
                );
              }
              break;
            }
            case "assistant_message_saved": {
              const id = typeof payload.id === "string" ? payload.id : null;
              if (id) assistantIdRef.current = id;
              break;
            }
            case "attachments": {
              // Outbound file attachments (`sendFile`) — emitted once after
              // the final assistant row persists; merged into the finalized
              // message in onDone. Re-emits replace (idempotent).
              if (Array.isArray(payload.attachments)) {
                turnFileAttachmentsRef.current =
                  payload.attachments as ChatFileAttachment[];
              }
              break;
            }
            case "user_message_saved": {
              const id = typeof payload.id === "string" ? payload.id : null;
              if (!id) break;
              // Re-key the optimistic user message so retry hooks
              // can reference the real row.
              session.dispatch({
                type: "message/replace",
                messageId: localUserId,
                message: {
                  id,
                  role: "user",
                  text: trimmed,
                  timestamp: new Date(),
                },
              });
              break;
            }
            case "error": {
              // askQuestion suspend-resume: the chat route rejects a new
              // message while the session is suspended on a question.
              // Restore the answer panel instead of showing a red error —
              // the row's approvalId + question come straight off the 409.
              if (payload.code === "pending_question_exists") {
                const approvalId =
                  typeof payload.approvalId === "string"
                    ? payload.approvalId
                    : "";
                const sid = sessionIdRef.current ?? "";
                if (approvalId && sid) {
                  setPendingQuestion({
                    approvalId,
                    question:
                      typeof payload.question === "string"
                        ? payload.question
                        : "",
                    expiresAt:
                      typeof payload.expiresAt === "string"
                        ? payload.expiresAt
                        : null,
                    sessionId: sid,
                  });
                }
                break;
              }
              if (payload.code === "research_quota_exhausted") {
                setResearchExhausted(true);
                setResearchMode(false);
              }
              const msg =
                typeof payload.error === "string" ? payload.error : t.error;
              setError(msg);
              break;
            }
            case "research_quota": {
              // Server accepted the research turn and bumped the counter.
              setResearchQuota({
                used: typeof payload.used === "number" ? payload.used : 0,
                quota: typeof payload.quota === "number" ? payload.quota : 0,
                isPaid: payload.isPaid === true,
              });
              break;
            }
            case "research_quota_exhausted": {
              // Free workspace hit its lifetime research cap.
              setResearchExhausted(true);
              setResearchMode(false);
              setResearchQuota({
                used: typeof payload.used === "number" ? payload.used : 0,
                quota: typeof payload.quota === "number" ? payload.quota : 0,
                isPaid: false,
              });
              break;
            }
            case "doc_title_update": {
              // Two producers (migration 218 + the explicit-metadata stream):
              //   1. Auto-title — the AI's edit produced a page title + a
              //      *suggested* emoji icon (COALESCE semantics on the client).
              //   2. Explicit `setTitle`/`setIcon` via `patchPage` — carries
              //      `nameOrigin` + `overwrite: true`, the authoritative
              //      committed values to apply directly.
              // Bridge both to the shell (which owns `activeView` + the
              // sidebar) via a window event — same pattern as the
              // `view_payload` → `doc:draft-created` bridge above. The
              // shell's `applyAutoTitle` reflects them without a REST rename.
              const pageId =
                typeof payload.pageId === "string" ? payload.pageId : "";
              const title =
                typeof payload.title === "string" ? payload.title : "";
              const icon =
                typeof payload.icon === "string" ? payload.icon : null;
              const nameOrigin =
                payload.nameOrigin === "user" ||
                payload.nameOrigin === "auto" ||
                payload.nameOrigin === "placeholder"
                  ? payload.nameOrigin
                  : undefined;
              const overwrite = payload.overwrite === true;
              if (pageId && title && typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("doc:title-updated", {
                    detail: { pageId, title, icon, nameOrigin, overwrite },
                  }),
                );
              }
              break;
            }
            case "doc_theme_update": {
              // The chat's `refineActiveTheme` tool rebuilt the user's active
              // custom theme server-side. Bridge the new tokens to the
              // ThemeProvider via a window event (same pattern as title) so the
              // palette updates live without a page reload. CustomThemesProvider
              // listens and calls applyCustomTheme.
              const themeId =
                typeof payload.themeId === "string" ? payload.themeId : "";
              const tokens =
                payload.tokens && typeof payload.tokens === "object"
                  ? (payload.tokens as { light?: unknown; dark?: unknown })
                  : null;
              // The refined theme's light/dark intent — lets CustomThemesProvider
              // flip the doc mode when the user said "make it darker".
              const appearance =
                payload.appearance === "light" || payload.appearance === "dark"
                  ? payload.appearance
                  : undefined;
              if (themeId && tokens && typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("doc:theme-changed", {
                    detail: { themeId, tokens, appearance },
                  }),
                );
              }
              break;
            }
            // Intentionally unhandled:
            //   `title_update` — app-web doesn't show session titles
          }
        },
        onDone: () => {
          const askedQuestion = turnAskedQuestionRef.current;
          // Doc is an `app` surface with no chip affordance: strip any
          // `<followup>[...]</followup>` tag the model volunteered so it never
          // shows as literal text. The server also strips before persist
          // (see chat.ts) — this guards the live turn + pre-fix history.
          const finalText = stripFollowUps(turnTextRef.current);
          const views = turnViewsRef.current;
          const tools = turnToolsRef.current;
          const citations = turnCitationsRef.current;
          const fileAttachments = turnFileAttachmentsRef.current;
          // Total wall-clock for the "Worked for Ns · k steps" receipt —
          // only meaningful when the turn actually ran tools.
          const activityDurationMs =
            tools.length > 0 && turnStartedAtRef.current != null
              ? Math.max(0, Date.now() - turnStartedAtRef.current)
              : undefined;
          const finalMessage: MessageWithViews = {
            id: assistantIdRef.current ?? `assistant-${Date.now()}`,
            role: "assistant",
            text: finalText,
            timestamp: new Date(),
            ...(views.length > 0 ? { views } : {}),
            ...(tools.length > 0 ? { toolsUsed: tools } : {}),
            ...(activityDurationMs != null ? { activityDurationMs } : {}),
            ...(citations.length > 0 ? { citations } : {}),
            ...(fileAttachments.length > 0 ? { fileAttachments } : {}),
          };
          if (
            finalText.length === 0 &&
            views.length === 0 &&
            tools.length === 0 &&
            fileAttachments.length === 0
          ) {
            session.dispatch({ type: "stream/abort" });
          } else {
            session.dispatch({
              type: "stream/finalize",
              finalMessage,
            });
          }
          resetTurnBuffers();
          // Surface docks: a general chat turn may have written to the brain
          // (the assistant saves memories / entities while researching) —
          // nudge the brain page to re-pull so new rows appear without a
          // manual reload. Harmless on non-brain surfaces (only the brain
          // page listens).
          if (!isDocOrigin) requestBrainRefresh(workspaceId);
          // Deferred research (surface seeds): the clarifying first turn is
          // done — arm research for the answer turn.
          if (deferResearchRef.current) {
            deferResearchRef.current = false;
            setResearchMode(true);
          }
          // Suspended on a question this turn — the stream closed without
          // turn_complete and the suspend event carried no approvalId, so
          // fetch the pending row now to surface the answer panel + gate
          // the composer immediately. See askquestion-suspend-resume.md.
          if (askedQuestion) {
            const sid = sessionIdRef.current;
            if (sid) {
              void fetchPendingQuestion(sid)
                .then((q) => {
                  if (!q) return;
                  setPendingQuestion({
                    approvalId: q.approvalId,
                    question: q.question ?? "",
                    expiresAt: q.expiresAt,
                    sessionId: sid,
                  });
                })
                .catch(() => {});
            }
          }
        },
        onError: (err) => {
          setError(
            isTransportError(err)
              ? t.streamInterrupted
              : err instanceof Error
                ? err.message
                : t.error,
          );
          session.dispatch({ type: "stream/abort" });
          resetTurnBuffers();
        },
      });
      // Indicate to the caller (e.g. seed effect) that a stream actually started.
      return true;
    },
    [selectedAssistantId, workspaceId, origin, isDocOrigin, model, metered, researchMode, session, stream, t, resetTurnBuffers, pendingQuestion, att],
  );

  // ── Chat-seed: apply a prompt handed in from another surface ───────────
  // The default-viewer landing's chatter routes here through the shell
  // (see lib/chat-seed.ts). Nonce-gated so the same prompt re-fires.
  // `autoSend` fires the turn immediately, anchored to the seed's page
  // (`docViewId`) so the model edits it — the construction streams onto
  // the page body (live Yjs), so we leave the dock collapsed rather than
  // expanding the corner panel. Without `autoSend` we expand + prefill the
  // composer for the user to edit and send.
  const seedNonceRef = useRef(0);
  useEffect(() => {
    if (!seedRequest) return;
    if (seedRequest.nonce === seedNonceRef.current) return;
    if (seedRequest.autoSend) {
      // Reliability fix: advance the nonce ONLY after sendMessage confirms it
      // actually started a stream. sendMessage has several silent early-returns
      // (inFlight, pendingQuestion, empty text); if one fires, the nonce would
      // be burned and the build indicator would hang on "Thinking…" forever.
      // By deferring the nonce advance to a successful start, the effect retries
      // on the next render (e.g. once inFlight clears) until it succeeds.
      //
      // Reflect the landing's picks in the chat's own controls (so a follow-up
      // in the corner chat keeps them), and pass them as overrides so THIS
      // turn uses them even before the state settles.
      if (seedRequest.model) setModel(seedRequest.model);
      if (seedRequest.researchMode !== undefined)
        setResearchMode(seedRequest.researchMode);
      void sendMessage(seedRequest.prefill, {
        ...(seedRequest.docViewId ? { docViewId: seedRequest.docViewId } : {}),
        // Inline Space-for-AI: anchor the generation after the box's block so
        // it lands at that line, not the page end.
        ...(seedRequest.anchorBlockId
          ? { docAnchorBlockId: seedRequest.anchorBlockId }
          : {}),
        ...(seedRequest.model ? { model: seedRequest.model } : {}),
        ...(seedRequest.researchMode !== undefined
          ? { researchMode: seedRequest.researchMode }
          : {}),
        ...(seedRequest.fileIds && seedRequest.fileIds.length > 0
          ? { fileIds: seedRequest.fileIds }
          : {}),
      }).then((started) => {
        // Only mark the nonce consumed when the turn actually fired.
        if (started) seedNonceRef.current = seedRequest.nonce;
        // If not started (e.g. a prior stream is still in-flight), the effect
        // will re-run on the next render and retry.
      });
    } else {
      setExpanded(true);
      setInput(seedRequest.prefill);
      seedNonceRef.current = seedRequest.nonce;
    }
  }, [seedRequest, sendMessage]);

  // ── Retry / Copy / Confirmation handlers ───────────────────────────────

  const handleRetry = useCallback(
    (assistantMessageId: string) => {
      if (stream.inFlight()) return;
      const messages = session.state.messages;
      const idx = messages.findIndex((m) => m.id === assistantMessageId);
      if (idx <= 0) return;
      const precedingUser = messages[idx - 1];
      if (precedingUser.role !== "user") return;

      // Drop the assistant message (and the preceding user) from local
      // state — the server side will truncate from `precedingUser.id`
      // and rebuild from there.
      session.dispatch({
        type: "messages/load",
        messages: messages.slice(0, idx - 1),
      });

      void sendMessage(precedingUser.text, {
        truncateFromMessageId: precedingUser.id,
      });
    },
    [session, stream, sendMessage],
  );

  // Retry from the user's own message: re-send the same text and let the
  // server truncate from this message id (dropping it + everything after,
  // including the assistant turn it produced) before rebuilding. Mirrors
  // `handleRetry` but anchors on the user row itself.
  const handleRetryFromUser = useCallback(
    (userMessageId: string) => {
      if (stream.inFlight()) return;
      const messages = session.state.messages;
      const idx = messages.findIndex((m) => m.id === userMessageId);
      if (idx < 0) return;
      const userMsg = messages[idx];
      if (userMsg.role !== "user") return;

      // Drop this user message and everything after from local state — the
      // server truncates from `userMessageId` and rebuilds from there.
      session.dispatch({
        type: "messages/load",
        messages: messages.slice(0, idx),
      });

      void sendMessage(userMsg.text, {
        truncateFromMessageId: userMessageId,
      });
    },
    [session, stream, sendMessage],
  );

  const handleCopy = useCallback(async (messageId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(messageId);
      setTimeout(
        () => setCopiedMessageId((id) => (id === messageId ? null : id)),
        1500,
      );
    } catch {
      /* clipboard blocked — silently fail; the icon just won't flip */
    }
  }, []);

  const handleAbort = useCallback(() => {
    stream.abort();
    session.dispatch({ type: "stream/abort" });
  }, [stream, session]);

  const handleConfirmation = useCallback(
    async (toolCallId: string, action: "approve" | "deny") => {
      const conf = session.state.pendingConfirmations.find(
        (p) => p.toolCallId === toolCallId,
      );
      if (!conf) return;
      session.updateConfirmation(toolCallId, {
        status: action === "approve" ? "approving" : "denied",
      });
      try {
        const decision = action === "approve" ? "allow" : "deny";
        const res = await authFetch(`${API_URL}/api/chat/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: conf.sessionId,
            toolCallId,
            decision,
          }),
        });
        if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            result?: string;
          };
          session.updateConfirmation(toolCallId, {
            status: action === "approve" ? "approved" : "denied",
            result: data.result,
          });
        } else {
          // Reset to pending so the user can retry (e.g. 404 resolver expired).
          session.updateConfirmation(toolCallId, { status: "pending" });
        }
      } catch {
        session.updateConfirmation(toolCallId, { status: "pending" });
      }
    },
    [session],
  );

  // ── Doc deep-link ────────────────────────────────────────────────────
  const handleOpenInDoc = useCallback(
    (viewId: string) => {
      router.replace(docPagePath(workspaceId, viewId));
      setExpanded(false);
    },
    [router, workspaceId],
  );

  const messages = session.state.messages as MessageWithViews[];
  const showEmpty = messages.length === 0 && !isStreaming;
  // A browser tool anywhere in this session's activity (live timeline or a
  // restored receipt) arms the live-browser chip's task probe.
  const browserToolSeen = useMemo(
    () =>
      toolTimeline.some((tool) => isBrowserToolName(tool.name)) ||
      messages.some((msg) => msg.toolsUsed?.some((tool) => isBrowserToolName(tool.name))),
    [toolTimeline, messages],
  );
  // The page this chat will act on, derived from the path (the same id
  // sent as `docViewId` on send) and reconciled against the shell's
  // resolved metadata so the composer chip never names a stale page. See
  // docs/architecture/features/doc.md → "Chat target indicator".
  const chatTarget = resolveChatTarget(pageIdFromPathname(pathname), activePage);
  // Reducer stores the chat-ui type; we widen at the read boundary so
  // the local `"failed"` status surfaces through the JSX without the
  // shared type knowing about it.
  const pendingConfirmations = session.state.pendingConfirmations as ConfirmationWithFailure[];
  const visiblePending = pendingConfirmations.filter(
    (p) => p.status === "pending" || p.status === "approving",
  );
  const resolvedConfirmations = pendingConfirmations.filter(
    (p) =>
      p.status === "approved" ||
      p.status === "denied" ||
      p.status === "failed",
  );
  // Cap the resolved-receipt block at two rows (summary + newest) so a
  // long approve-one-at-a-time run can't bury the next pending card.
  const collapsedConfirmations =
    collapseResolvedConfirmations(resolvedConfirmations);

  // Idle copy — the doc dock nudges toward the page ("Ask for a view…");
  // a surface dock stays neutral ("Ask anything…"), with the view-context
  // nudge carried by the chip + the ambient block's surface line instead.
  const idlePlaceholder = isDocOrigin ? t.placeholder : t.surfacePlaceholder;

  // Pill activity label — mirrors apps/web's collapsed-pill behaviour
  // (running tool description, else streaming preview, else "Thinking…").
  const isActive = activity.isStreaming;
  const activeLabel = isActive
    ? activity.activeTool?.description ??
      collapseToOneLine(activity.streamingText) ??
      t.thinking
    : null;

  return (
    <div
      ref={panelRef}
      // The editor's area-select gesture (block-area-select.ts) skips presses
      // inside elements marked this way, so a drag in the chat selects its own
      // text instead of rubber-banding the page beneath it.
      data-area-select-ignore
      className={cn(
        isSidePanel
          ? "flex h-full w-full flex-col"
          : "fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2",
      )}
    >
      {/* Expanded panel — ALWAYS mounted. In floating mode it scales in from
          the bottom-right pill; in side-panel mode it fills the parent column
          and stays open. State (stream, tools, citations) survives toggles. */}
      <div
        aria-hidden={isSidePanel ? undefined : !expanded}
        {...drop.dropProps}
        // Floating dock: the open panel anchors flush to the corner (`bottom-0`)
        // so it reaches down to the container's `bottom-4` — the collapsed
        // launcher hides while open, so the old `bottom-full mb-2` perch just
        // stranded an empty strip below the panel. Size is user-resizable
        // (inline width/height); transitions stay on opacity/transform only so a
        // drag never lags behind an animated dimension.
        style={!isSidePanel ? { width: chatSize.w, height: chatSize.h } : undefined}
        className={cn(
          "relative flex flex-col overflow-hidden",
          isSidePanel
            ? "h-full w-full"
            : cn(
                "absolute right-0 bottom-0 origin-bottom-right",
                "max-w-[calc(100vw-2rem)] max-h-[92dvh]",
                "rounded-xl border border-border bg-popover shadow-2xl",
                "transition-[opacity,transform] duration-200 ease-out",
                expanded
                  ? "opacity-100 scale-100 translate-y-0 pointer-events-auto"
                  : "opacity-0 scale-95 translate-y-2 pointer-events-none",
              ),
        )}
      >
        {/* Resize handles (floating dock only) — a top edge (taller), a left
            edge (wider), and a top-left corner (both). The panel grows up-and-
            left from the bottom-right anchor. Inert when collapsed: the parent
            is `pointer-events-none` then. */}
        {!isSidePanel ? (
          <>
            <div
              role="separator"
              aria-label={t.resizeHandle}
              aria-orientation="horizontal"
              onPointerDown={startResize("xy")}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className="group/resize absolute left-0 top-0 z-20 size-3.5 cursor-nwse-resize"
            >
              <span
                aria-hidden
                className="absolute left-1 top-1 size-1.5 rounded-tl-sm border-l-2 border-t-2 border-muted-foreground/30 transition-colors group-hover/resize:border-primary/70"
              />
            </div>
            <div
              aria-hidden
              onPointerDown={startResize("y")}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className="absolute left-3.5 right-0 top-0 z-10 h-1.5 cursor-ns-resize"
            />
            <div
              aria-hidden
              onPointerDown={startResize("x")}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className="absolute left-0 top-3.5 bottom-0 z-10 w-1.5 cursor-ew-resize"
            />
          </>
        ) : null}
        <FileDropOverlay active={drop.isDragging} />
        {/* Header — hidden when the host frames the chat with its own chrome
            (the mobile bottom-sheet drawer). The collapse affordance only
            applies to the floating dock; a docked side panel has nothing to
            collapse into, so the X is omitted there. */}
        {!hideHeader ? (
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 shrink-0">
            {/* Assistant switcher — the chat's interlocutor. Defaults to the
                workspace primary; the user can switch to any accessible
                assistant. A single option degrades to a static label. */}
            {workspaceAssistants.length > 1 && activeAssistant ? (
              <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
                <PopoverTrigger
                  className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 -mx-1 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                  aria-label={t.switchAssistant}
                >
                  <AssistantAvatar
                    id={activeAssistant.id}
                    name={activeAssistant.name}
                    iconSeed={activeAssistant.iconSeed ?? undefined}
                    size="sm"
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
                    {t.switchAssistantTitle}
                  </p>
                  {workspaceAssistants.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => handleSwitchAssistant(a.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        a.id === selectedAssistantId
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      <AssistantAvatar id={a.id} name={a.name} iconSeed={a.iconSeed ?? undefined} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                      {a.id === selectedAssistantId ? (
                        <Check
                          className="size-4 shrink-0 text-primary"
                          aria-hidden
                        />
                      ) : null}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            ) : activeAssistant ? (
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
                <AssistantAvatar
                  id={activeAssistant.id}
                  name={activeAssistant.name}
                  iconSeed={activeAssistant.iconSeed ?? undefined}
                  size="sm"
                />
                <span className="truncate">{activeAssistant.name}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Sparkles className="size-3.5 text-primary" aria-hidden />
                {t.emptyTitle}
              </span>
            )}
            {!isSidePanel ? (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label={t.collapse}
                tabIndex={expanded ? 0 : -1}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Notice banner — sits above the messages, dismissible */}
        {notice ? (
          <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">
            <TriangleAlert className="size-3.5 mt-0.5 shrink-0" aria-hidden />
            <span className="flex-1 leading-relaxed">{notice.message}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label={t.noticeDismiss}
              className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded text-amber-700/70 dark:text-amber-300/70 hover:bg-amber-500/15"
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        ) : null}

        {/* Messages */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5"
        >
          {showEmpty ? (
            <div className="flex h-full items-center justify-center px-6">
              <div className="text-center space-y-1.5">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Sparkles className="size-5" aria-hidden />
                </div>
                <p className="text-sm font-medium text-foreground">
                  {t.emptyTitle}
                </p>
                <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
                  {isDocOrigin ? t.emptyDesc : t.surfaceEmptyDesc}
                </p>
              </div>
            </div>
          ) : null}

          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              assistant={activeAssistant}
              workspaceId={workspaceId}
              openInDocLabel={t.openInDoc}
              appendedLabel={t.viewAppended}
              createdLabel={t.viewCreated}
              onOpenInDoc={handleOpenInDoc}
              onRetry={handleRetry}
              onRetryUser={handleRetryFromUser}
              onCopy={handleCopy}
              copied={copiedMessageId === msg.id}
              retryLabel={t.retry}
              copyLabel={t.copy}
              copiedLabel={t.copied}
              citationLabel={t.citationLabel}
            />
          ))}

          {/* Live tool timeline + streaming text */}
          {isStreaming ? (
            <div className="flex gap-2.5">
              {activeAssistant ? (
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
              )}
              <div className="flex-1 min-w-0 pt-0.5 space-y-2">
                <ChatActivityFeed
                  events={streamingEvents}
                  tools={toolTimeline}
                  replyStreaming={streamingText.length > 0}
                  researchPhase={researchPhase}
                  startedAt={turnStartedAt}
                />
                {streamingText ? (
                  <div className="chat-markdown prose prose-sm dark:prose-invert max-w-none text-[14px] leading-[1.6] text-foreground break-words">
                    <ChatMarkdownWithLinks
                      text={streamingText}
                      workspaceId={workspaceId}
                      onOpenPage={handleOpenInDoc}
                    />
                    <span
                      aria-hidden
                      className="ml-0.5 inline-block h-[16px] w-[2px] align-text-bottom rounded-full bg-primary animate-pulse shadow-[0_0_8px_var(--primary)]"
                    />
                  </div>
                ) : null}
                {citations.length > 0 ? (
                  <CitationList citations={citations} label={t.citationLabel} />
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Resolved confirmation rows (approved/denied/failed) render ABOVE
              the pending cards — they happened earlier, and the actionable
              Approve/Deny card must sit nearest the auto-scrolled bottom. A
              long one-action-at-a-time run collapses everything but the
              newest receipt into one counts row (confirmation-collapse.ts),
              so the resolved block never buries the next pending card. */}
          {collapsedConfirmations.counts ? (
            <CollapsedConfirmationsRow
              counts={collapsedConfirmations.counts}
              doneTemplate={t.confirmationCollapsedDone}
              deniedTemplate={t.confirmationCollapsedDenied}
              failedTemplate={t.confirmationCollapsedFailed}
            />
          ) : null}
          {collapsedConfirmations.tail.map((conf) => (
            <ResolvedConfirmationRow
              key={conf.toolCallId}
              confirmation={conf}
              doneTemplate={t.confirmationDone}
              failedTemplate={t.confirmationFailed}
              deniedTemplate={t.confirmationDenied}
            />
          ))}

          {/* Pending confirmation cards — always visible regardless of stream state */}
          {visiblePending.map((conf) => (
            <PendingConfirmationBubble
              key={conf.toolCallId}
              confirmation={conf}
              approveLabel={t.confirmationApprove}
              denyLabel={t.confirmationDeny}
              approvingLabel={t.confirmationApproving}
              onApprove={(id) => void handleConfirmation(id, "approve")}
              onDeny={(id) => void handleConfirmation(id, "deny")}
            />
          ))}

          {/* askQuestion suspend-resume — inline answer surface. Renders
              when the engine emits awaiting_approval for askQuestion, when
              a new message is rejected with pending_question_exists, or
              when GET /pending on reload finds a suspended row. */}
          {pendingQuestion &&
          (!session.state.sessionId ||
            session.state.sessionId === pendingQuestion.sessionId) ? (
            <PendingQuestionPanel
              sessionId={pendingQuestion.sessionId}
              approvalId={pendingQuestion.approvalId}
              dict={t.pendingQuestion}
              onAnswered={() => {
                setPendingQuestion(null);
                setResumePolling(true);
              }}
              onCancelled={() => {
                setPendingQuestion(null);
                setResumePolling(true);
              }}
            />
          ) : null}

          {/* Resume-in-flight indicator while the continuation turn fires. */}
          {resumePolling ? (
            <ResumingIndicator label={t.pendingQuestion.resuming} />
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-border bg-card/40 px-3 py-2.5">
          {/* Live-browser chip — a persistent window into the assistant's
              cloud browser (watch / take over), probed off the task API so it
              never depends on the model relaying a link. */}
          <ComputerLiveChip
            workspaceId={workspaceId}
            sessionId={session.state.sessionId}
            browserToolSeen={browserToolSeen}
          />
          {/* Soft double-text guard — warns when another member already has the
              assistant working on this page (presence over Yjs awareness). */}
          {othersRun ? (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] text-foreground">
              <span
                aria-hidden
                className="claw-blink size-1.5 shrink-0 rounded-full bg-primary"
              />
              <span className="min-w-0 flex-1">
                {othersRun.actor?.name
                  ? format(tRun.guard, { name: othersRun.actor.name })
                  : tRun.guardAnon}
              </span>
            </div>
          ) : null}
          {/* Context chip — names the page this chat will edit, or signals
              that the next message mints a new draft. */}
          {isDocOrigin ? (
            <ChatTargetIndicator target={chatTarget} dict={t.target} />
          ) : (
            <SurfaceContextChip surface={origin} dict={t.surfaceTarget} />
          )}
          <ChatComposer
            value={input}
            onChange={setInput}
            onSend={() => void sendMessage(input)}
            // Hard-disable only for states where composing makes no sense
            // (suspended on a clarifying question, offline). While a reply
            // STREAMS the box stays typeable — `sendDisabled` blocks
            // Enter/Send so the user drafts their next message during the
            // assistant's turn instead of staring at a locked input.
            disabled={!!pendingQuestion || offline}
            sendDisabled={isStreaming}
            allowEmptySend={att.hasReady}
            // Paste a screenshot / copied image straight into the chat — it
            // stages as an attachment chip exactly like the paperclip or a
            // drag-drop and rides the next send (staging mid-stream is fine).
            // Guarded so a text paste (even rich text carrying a tagalong
            // image) still pastes as text; skipped while a clarifying question
            // holds the composer, matching the drop hook's `disabled`.
            onPaste={(e) => {
              if (pendingQuestion) return;
              const images = imageFilesFromClipboard(e.clipboardData);
              if (images.length === 0) return;
              e.preventDefault();
              void att.upload(images);
            }}
            placeholder={
              pendingQuestion
                ? t.pendingQuestion.composerDisabled
                : idlePlaceholder
            }
            sendLabel={t.send}
            slotAttachments={
              <>
                <AttachmentChips attachments={att.attachments} onRemove={att.remove} />
                {rec.status !== "idle" ? (
                  <p
                    className={
                      rec.status === "error"
                        ? "px-1 py-0.5 text-xs text-destructive"
                        : "px-1 py-0.5 text-xs text-muted-foreground"
                    }
                    role="status"
                  >
                    {rec.status === "uploading"
                      ? tRec.uploading
                      : rec.status === "processing"
                        ? tRec.processing
                        : rec.message}
                  </p>
                ) : null}
              </>
            }
            slotPreInput={
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) void att.upload(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  aria-label={tAttach.attach}
                  onClick={() => fileInputRef.current?.click()}
                  // Staging an attachment mid-stream is fine — it rides the
                  // NEXT send, same as pre-typed text.
                  disabled={!!pendingQuestion}
                  className={cn(
                    "shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-md",
                    "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    "disabled:opacity-50 disabled:pointer-events-none",
                  )}
                >
                  <Paperclip className="size-[18px]" aria-hidden />
                </button>
              </>
            }
            // Hide the built-in Send button while streaming so the
            // adjacent Stop button takes its place visually.
            sendButtonClassName={cn(
              "shrink-0 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground",
              "transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none",
              isStreaming && "hidden",
            )}
            slotPostInput={
              isStreaming ? (
                <button
                  type="button"
                  onClick={handleAbort}
                  aria-label={t.abort}
                  title={t.abort}
                  className={cn(
                    "shrink-0 inline-flex items-center justify-center",
                    "h-9 w-9 rounded-md bg-muted text-foreground/80",
                    "transition-colors hover:bg-muted/80 hover:text-destructive",
                  )}
                >
                  <Square className="size-3.5 fill-current" aria-hidden />
                </button>
              ) : null
            }
            className="flex flex-col gap-1"
            rowClassName="flex items-end gap-2"
            // ChatComposer auto-grows the textarea to fit content; we just set
            // the cap. A roomier `max-h-[240px]` (~10 lines) lets a longer
            // prompt stay fully visible before the box starts scrolling — the
            // old 160px clipped multi-line asks too early.
            textareaClassName={cn(
              "flex-1 min-w-0 min-h-[36px] max-h-[240px] resize-none overflow-y-auto rounded-md border border-border bg-background",
              "px-3 py-2 text-sm leading-relaxed outline-none",
              "placeholder:text-muted-foreground",
              "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
              "disabled:opacity-60",
            )}
          />
          {/* Controls — deep-research toggle + model tier picker, shared with
              the comment composers via <ComposerControls>. The dock keeps its
              own inline model / research state (entangled with the stream
              handler); the component is pure presentation. The dock is the
              primary doc page author, so it carries the research toggle —
              a research turn builds findings (charts/diagrams) onto the page. */}
          <ComposerControls
            model={model}
            onModelChange={setModel}
            plan={workspacePlan}
            researchMode={researchMode}
            onResearchModeChange={(next) => {
              // Research forces its own model — arming it clears a metered pick.
              if (next) setMetered(null);
              setResearchMode(next);
            }}
            researchQuota={researchQuota}
            researchExhausted={researchExhausted}
            showResearch
            meteredOptions={meteredOptions}
            meteredSelectedKey={metered?.key ?? null}
            onMeteredSelect={handleMeteredSelect}
            className="mt-2"
          />
        </div>
      </div>

      {/* Launcher — floating mode only. A compact pill: the doc assistant's
          small avatar (its creature icon) beside a short text nudge; fades +
          scales out when the panel expands. While a turn runs it tints to
          primary and the nudge mirrors the live tool / stream label. Falls back
          to a chat glyph until the identity resolves. */}
      {!isSidePanel && (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-hidden={expanded}
        aria-live={isActive ? "polite" : undefined}
        tabIndex={expanded ? -1 : 0}
        className={cn(
          "inline-flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 shadow-lg backdrop-blur",
          "max-w-[min(260px,calc(100vw-3rem))] text-left text-sm",
          "transition-[opacity,transform,background-color,box-shadow] duration-200 ease-out",
          isActive
            ? "border border-primary/40 bg-primary/10 text-foreground ring-2 ring-primary/20"
            : "border border-border bg-background/90 text-foreground/80 hover:bg-accent hover:text-foreground",
          expanded
            ? "opacity-0 scale-95 pointer-events-none"
            : "opacity-100 scale-100",
        )}
      >
        {assistant ? (
          <span
            aria-hidden
            className="inline-flex size-7 shrink-0 overflow-hidden rounded-full ring-1 ring-black/10 dark:ring-white/15"
          >
            <AssistantAvatar
              id={assistant.id}
              name={assistant.name}
              iconSeed={assistant.iconSeed ?? undefined}
              size="sm"
            />
          </span>
        ) : (
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <MessageSquare className="size-3.5" aria-hidden />
          </span>
        )}
        <span
          className={cn(
            "min-w-0 truncate",
            isActive ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {isActive ? activeLabel : idlePlaceholder}
        </span>
      </button>
      )}
    </div>
  );
}

/**
 * Coerce SSE payload to a record without throwing. Some events ship
 * pre-parsed objects (the canonical case), but a defensive parse
 * handles raw-string fallback from the SSE parser too.
 */
function coercePayload(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through.
    }
  }
  return {};
}

/**
 * Map persisted session rows to renderable chat messages. Shared by the
 * resume-on-mount seed and the post-answer resume poll. Drops empty
 * user/assistant rows (legacy / aborted turns) and non-text roles.
 *
 * Assistant rows also restore their `tool_use` blocks as a done-status
 * `toolsUsed[]` (re-narrated from each call's input) so the activity
 * receipt survives a reload. Timings are live-only and not restored.
 */
function mapSessionRows(
  rows: Awaited<ReturnType<typeof fetchSessionMessages>>,
  narration: NarrationDict,
): MessageWithViews[] {
  return rows
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m): MessageWithViews => {
      const toolsUsed =
        m.role === "assistant"
          ? extractToolUses(m.content).map((use): ToolUsed => {
              const described = describeToolFromInput(
                use.name,
                use.input,
                narration,
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
      // User rows: split the persisted body into clean text + structured
      // attachment refs (base64 image thumbnails), so a restored message shows
      // the same thumbnail cards as the live send — not the "📎 filename"
      // placeholder `extractMessageText` leaves behind.
      const parsedUser =
        m.role === "user" ? parseMessageAttachments(m.content) : null;
      return {
        id: m.id,
        role: m.role as "user" | "assistant",
        // Strip `<followup>` from restored assistant rows — pre-fix history may
        // carry the volunteered tag (the server now strips before persist).
        text:
          m.role === "assistant"
            ? stripFollowUps(extractMessageText(m.content))
            : (parsedUser?.text ?? extractMessageText(m.content)),
        timestamp: new Date(m.timestamp),
        ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
        ...(m.attachments && m.attachments.length > 0
          ? { fileAttachments: m.attachments }
          : {}),
        ...(parsedUser && parsedUser.attachments.length > 0
          ? { userAttachments: parsedUser.attachments }
          : {}),
      };
    })
    .filter(
      (m) =>
        m.text.trim().length > 0 ||
        m.fileAttachments?.length ||
        m.userAttachments?.length,
    );
}

/**
 * Remove any `<followup>[...]</followup>` chip tag from assistant text.
 * Doc is an `app` surface with no chip affordance, so the tag must never
 * render. Mirrors `stripFollowUps` in `@use-brian/shared` (kept inline to
 * avoid pulling the shared barrel into the browser bundle — the same reason
 * `apps/web` inlines its own copy). Also drops a trailing malformed opener so
 * a half-streamed tag can't survive.
 */
function stripFollowUps(text: string): string {
  return text
    .replace(/<followup>\s*\[[\s\S]*?\]\s*<\/followup>/g, "")
    .replace(/<followup[\s\S]*$/, "")
    .trimEnd();
}

/**
 * Squash a streamed markdown blob into a single-line preview for the
 * collapsed pill. Same heuristic apps/web uses.
 */
function collapseToOneLine(text: string): string | undefined {
  const trimmed = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[#>\-*+]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) return undefined;
  const MAX = 80;
  return trimmed.length > MAX ? trimmed.slice(-MAX) : trimmed;
}

// ── Tool narration ───────────────────────────────────────────────────────
// The describers (input-aware narration, patchPage op lines, static label
// map) live in `@/lib/tool-narration` — shared with the session-history
// restore path and unit-testable without React. [COMP:app-web/tool-narration]

type ChatTargetDict = ReturnType<typeof useT>["chat"]["target"];

/**
 * Composer context chip — tells the user which page this chat will act on
 * before they hit send. Mirrors the server's implicit edit-vs-create rule:
 * a page open on the path → the model edits it (`patchPage`); none open →
 * the next message mints a new draft (`renderPage`). The page glyph matches
 * the sidebar / title (the emoji `icon`, else the `derivePageIcon`
 * fallback). See docs/architecture/features/doc.md → "Chat target
 * indicator".
 */
function ChatTargetIndicator({
  target,
  dict,
}: {
  target: ChatTarget;
  dict: ChatTargetDict;
}) {
  if (target.mode === "create") {
    return (
      <div
        title={dict.creatingHint}
        className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] text-muted-foreground"
      >
        <FilePlus className="size-3 shrink-0 text-primary/70" aria-hidden />
        <span>{dict.creating}</span>
      </div>
    );
  }
  if (target.mode === "edit-pending") {
    return (
      <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] text-muted-foreground">
        <FileText className="size-3 shrink-0 opacity-70" aria-hidden />
        <span>{dict.editingUnknown}</span>
      </div>
    );
  }
  const { page } = target;
  const FallbackGlyph = derivePageIcon({
    entity: page.entity,
    viewType: page.viewType,
    nameOrigin: page.nameOrigin,
  });
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5 text-[11px] text-muted-foreground">
      <span className="shrink-0">{dict.editing}</span>
      <PageIcon
        icon={page.icon}
        fallback={FallbackGlyph}
        emojiClassName="shrink-0 text-[12px] leading-none"
        glyphClassName="size-3 shrink-0 opacity-70"
        imgClassName="size-3 shrink-0 rounded-[2px] object-cover"
      />
      <span className="truncate font-medium text-foreground">
        {page.name.trim() || dict.untitled}
      </span>
      {page.state === "draft" ? (
        <span className="shrink-0 rounded bg-muted px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">
          {dict.draftBadge}
        </span>
      ) : null}
    </div>
  );
}

type SurfaceTargetDict = ReturnType<typeof useT>["chat"]["surfaceTarget"];

/**
 * Composer context chip for the non-doc origins — the page-target chip's
 * sibling. A small nudge that this chat reads against the view the user is
 * on ("Asking about Brain"); the server half is the ambient skill block's
 * `surface` line (`buildAmbientDocSkillBlock`), so the nudge is true, not
 * decorative. See docs/architecture/features/doc.md → "One dock, every
 * surface".
 */
function SurfaceContextChip({
  surface,
  dict,
}: {
  surface: ChatSurface;
  dict: SurfaceTargetDict;
}) {
  return (
    <div
      title={dict.hint}
      className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] text-muted-foreground"
    >
      <Eye className="size-3 shrink-0 text-primary/70" aria-hidden />
      <span>{dict[surface]}</span>
    </div>
  );
}

/**
 * One message bubble + the inline ViewRenderer blocks (assistant only) +
 * hover-reveal Retry / Copy actions. Kept as a sibling component so the
 * parent's message map stays a thin loop.
 */
/**
 * Anchor renderer for assistant chat markdown. An in-app page href
 * (`/p/<pageId>`, `/w/<wid>/p/<pageId>`, or a bare page id) resolves via
 * `pageIdFromInAppHref` and soft-navigates through `onOpenPage` — the same doc
 * deep-link the "Open in doc" view action uses — instead of letting the browser
 * follow a broken relative link. External hrefs open in a new tab; a missing
 * href degrades to plain text.
 */
function ChatPageLink({
  href,
  children,
  workspaceId,
  onOpenPage,
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  workspaceId: string;
  onOpenPage: (pageId: string) => void;
}) {
  const pageId = pageIdFromInAppHref(href);
  if (pageId) {
    return (
      <a
        href={docPagePath(workspaceId, pageId)}
        onClick={(e) => {
          e.preventDefault();
          onOpenPage(pageId);
        }}
      >
        {children}
      </a>
    );
  }
  if (href && /^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  if (href) return <a href={href}>{children}</a>;
  return <>{children}</>;
}

/**
 * `ChatMarkdown` with in-app page links wired up (see {@link ChatPageLink}).
 * Used for both finalised assistant messages and the live streaming buffer so
 * a page reference is clickable the moment it renders.
 */
function ChatMarkdownWithLinks({
  text,
  workspaceId,
  onOpenPage,
}: {
  text: string;
  workspaceId: string;
  onOpenPage: (pageId: string) => void;
}) {
  const components = useMemo(
    () => ({
      a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <ChatPageLink {...props} workspaceId={workspaceId} onOpenPage={onOpenPage} />
      ),
      // Fenced code blocks carry a one-click copy affordance.
      pre: ChatCodeBlock,
    }),
    [workspaceId, onOpenPage],
  );
  return <ChatMarkdown text={text} components={components} />;
}

function MessageBubble({
  message,
  assistant,
  workspaceId,
  openInDocLabel,
  appendedLabel,
  createdLabel,
  onOpenInDoc,
  onRetry,
  onRetryUser,
  onCopy,
  copied,
  retryLabel,
  copyLabel,
  copiedLabel,
  citationLabel,
}: {
  message: MessageWithViews;
  // The interlocutor whose avatar fronts assistant replies — the active
  // assistant (switching assistants resets the session, so every assistant
  // message in a loaded conversation belongs to it). `null` before it
  // resolves, in which case the avatar degrades to the generic glyph.
  assistant: Pick<WorkspaceAssistantSummary, "id" | "name" | "iconSeed"> | null;
  workspaceId: string;
  openInDocLabel: string;
  appendedLabel: string;
  createdLabel: string;
  onOpenInDoc: (viewId: string) => void;
  onRetry: (assistantMessageId: string) => void;
  onRetryUser: (userMessageId: string) => void;
  onCopy: (messageId: string, text: string) => void;
  copied: boolean;
  retryLabel: string;
  copyLabel: string;
  copiedLabel: string;
  citationLabel: string;
}) {
  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end">
        {/* Neutral Notion-style bubble — a calm elevated `--secondary` surface,
            NOT a saturated `--primary` fill. The brand blue is reserved for the
            small accents (sparkle/spinner); a full-blue bubble was the loudest,
            least-cohesive element on the dark theme and white-on-blue missed
            WCAG AA (≈3.9:1). `--secondary` reads ~9:1 in both modes. */}
        {message.text ? (
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[14px] leading-[1.5] text-secondary-foreground shadow-sm break-words whitespace-pre-wrap">
            {message.text}
          </div>
        ) : null}
        {/* The user's own uploaded attachments (pasted images / picked files) —
            image thumbnails or file cards, right-aligned under the bubble. */}
        {message.userAttachments?.length ? (
          <div className="w-full max-w-[280px]">
            <MessageAttachments attachments={message.userAttachments} />
          </div>
        ) : null}
        {message.text ? (
          <div className="flex items-center gap-1 -mr-1 pt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <IconActionButton
              tooltip={copied ? copiedLabel : copyLabel}
              onClick={() => onCopy(message.id, message.text)}
            >
              {copied ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
            </IconActionButton>
            <IconActionButton
              tooltip={retryLabel}
              onClick={() => onRetryUser(message.id)}
            >
              <RotateCw className="size-3.5" aria-hidden />
            </IconActionButton>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="group flex gap-2.5">
      {assistant ? (
        <div className="mt-0.5 shrink-0">
          <AssistantAvatar
            id={assistant.id}
            name={assistant.name}
            iconSeed={assistant.iconSeed ?? undefined}
            size="sm"
          />
        </div>
      ) : (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
          <Sparkles className="size-3.5" aria-hidden />
        </div>
      )}
      <div className="flex-1 min-w-0 pt-0.5 space-y-2.5">
        {message.toolsUsed?.length ? (
          <ChatActivitySummary
            tools={message.toolsUsed}
            durationMs={message.activityDurationMs}
          />
        ) : null}
        {message.text ? (
          <div className="chat-markdown prose prose-sm dark:prose-invert max-w-none text-[14px] leading-[1.6] text-foreground break-words">
            <ChatMarkdownWithLinks
              text={message.text}
              workspaceId={workspaceId}
              onOpenPage={onOpenInDoc}
            />
          </div>
        ) : null}
        {message.views?.length ? (
          <div className="space-y-2">
            {message.views.map((view) => (
              <ViewBlock
                key={view.toolUseId}
                view={view}
                openInDocLabel={openInDocLabel}
                appendedLabel={appendedLabel}
                createdLabel={createdLabel}
                onOpenInDoc={onOpenInDoc}
              />
            ))}
          </div>
        ) : null}
        {message.fileAttachments?.length ? (
          <ChatFileAttachments attachments={message.fileAttachments} />
        ) : null}
        {message.citations && message.citations.length > 0 ? (
          <CitationList citations={message.citations} label={citationLabel} />
        ) : null}
        {message.text ? (
          <div className="flex items-center gap-1 -ml-1 pt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <IconActionButton
              tooltip={copied ? copiedLabel : copyLabel}
              onClick={() => onCopy(message.id, message.text)}
            >
              {copied ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
            </IconActionButton>
            <IconActionButton
              tooltip={retryLabel}
              onClick={() => onRetry(message.id)}
            >
              <RotateCw className="size-3.5" aria-hidden />
            </IconActionButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Small icon button with hover tooltip. */
function IconActionButton({
  tooltip,
  onClick,
  children,
}: {
  tooltip: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className="relative group/btn">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      >
        {children}
      </button>
      <div
        role="tooltip"
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 text-[10px] font-medium rounded bg-foreground text-background whitespace-nowrap opacity-0 group-hover/btn:opacity-100 pointer-events-none transition-opacity shadow-md"
      >
        {tooltip}
      </div>
    </div>
  );
}

/**
 * Confirmation pill for a `renderView` action. The widget itself never
 * inline-renders in chat — doc is a draft-first surface, so the
 * model speaks and the page renders. The pill states the entity that
 * was rendered + whether the call appended to the current draft or
 * created a new one. Click navigates to the draft.
 */
function ViewBlock({
  view,
  openInDocLabel,
  appendedLabel,
  createdLabel,
  onOpenInDoc,
}: {
  view: ViewAttachment;
  openInDocLabel: string;
  appendedLabel: string;
  createdLabel: string;
  onOpenInDoc: (viewId: string) => void;
}): ReactNode {
  if (!view.viewId) return null;
  const entityLabel =
    view.entity && view.viewType
      ? `${view.entity}/${view.viewType}`
      : view.entity ?? "view";
  const actionLabel =
    view.action === "appended" ? appendedLabel : createdLabel;
  return (
    <button
      type="button"
      onClick={() => onOpenInDoc(view.viewId!)}
      className={cn(
        "inline-flex items-center gap-2 rounded-md border border-border bg-background",
        "px-2.5 py-1.5 text-xs transition-colors",
        "hover:bg-muted",
      )}
      title={openInDocLabel}
    >
      <Sparkles className="size-3.5 text-primary shrink-0" aria-hidden />
      <span className="font-medium text-foreground">{entityLabel}</span>
      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">{actionLabel}</span>
      <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
    </button>
  );
}

/** Source chips, dedup'd by URL upstream, capped + expandable. */
function CitationList({
  citations,
  label,
}: {
  citations: CitationSource[];
  label: string;
}) {
  const VISIBLE = 4;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? citations : citations.slice(0, VISIBLE);
  const hidden = citations.length - VISIBLE;

  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground/70">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {visible.map((c) => (
          <a
            key={c.url}
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-muted/60 hover:bg-muted px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors truncate max-w-[220px]"
            title={c.url}
          >
            <ExternalLink className="size-2.5 shrink-0" aria-hidden />
            <span className="truncate">{c.title}</span>
          </a>
        ))}
        {!expanded && hidden > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex items-center rounded-md bg-muted/40 hover:bg-muted/70 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            +{hidden}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Inline approval card while a tool is awaiting user confirmation. */
function PendingConfirmationBubble({
  confirmation,
  approveLabel,
  denyLabel,
  approvingLabel,
  onApprove,
  onDeny,
}: {
  confirmation: ConfirmationWithFailure;
  approveLabel: string;
  denyLabel: string;
  approvingLabel: string;
  onApprove: (toolCallId: string) => void;
  onDeny: (toolCallId: string) => void;
}) {
  const title = confirmation.displayName ?? confirmation.toolName;
  const isInFlight = confirmation.status === "approving";
  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/25">
        <TriangleAlert className="size-3.5" aria-hidden />
      </div>
      <div className="flex-1 min-w-0 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        {confirmation.description ? (
          <p className="text-xs text-muted-foreground leading-relaxed">
            {confirmation.description}
          </p>
        ) : null}
        {confirmation.displayLines && confirmation.displayLines.length > 0 ? (
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {confirmation.displayLines.map((line, i) => (
              <li key={i} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onApprove(confirmation.toolCallId)}
            disabled={isInFlight}
            className={cn(
              "rounded-md bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground",
              "transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {isInFlight ? approvingLabel : approveLabel}
          </button>
          <button
            type="button"
            onClick={() => onDeny(confirmation.toolCallId)}
            disabled={isInFlight}
            className={cn(
              "rounded-md border border-border bg-background px-3 py-1 text-[12px] font-medium text-muted-foreground",
              "transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {denyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One compact counts-by-status row summarizing the resolved confirmations
 *  that collapsed out of the transcript ("7 completed · 1 denied") — the
 *  policy lives in `confirmation-collapse.ts`. Non-interactive: the full
 *  history is in the turn's persisted messages. */
function CollapsedConfirmationsRow({
  counts,
  doneTemplate,
  deniedTemplate,
  failedTemplate,
}: {
  counts: ResolvedConfirmationCounts;
  doneTemplate: string;
  deniedTemplate: string;
  failedTemplate: string;
}) {
  const parts: string[] = [];
  if (counts.approved > 0) {
    parts.push(format(doneTemplate, { count: counts.approved }));
  }
  if (counts.denied > 0) {
    parts.push(format(deniedTemplate, { count: counts.denied }));
  }
  if (counts.failed > 0) {
    parts.push(format(failedTemplate, { count: counts.failed }));
  }
  return (
    <div className="flex gap-2.5">
      <div className="opacity-60 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border">
        <Sparkles className="size-3.5" aria-hidden />
      </div>
      <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        {parts.join(" · ")}
      </div>
    </div>
  );
}

/** Resolved confirmation summary row (approved / denied / failed). */
function ResolvedConfirmationRow({
  confirmation,
  doneTemplate,
  failedTemplate,
  deniedTemplate,
}: {
  confirmation: ConfirmationWithFailure;
  doneTemplate: string;
  failedTemplate: string;
  deniedTemplate: string;
}) {
  const label = (
    confirmation.displayName ?? confirmation.toolName
  ).toLowerCase();
  const template =
    confirmation.status === "approved"
      ? doneTemplate
      : confirmation.status === "failed"
        ? failedTemplate
        : deniedTemplate;
  const tone =
    confirmation.status === "approved"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : confirmation.status === "failed"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <div className="flex gap-2.5">
      <div className="opacity-60 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border">
        <Sparkles className="size-3.5" aria-hidden />
      </div>
      <div className={cn("rounded-md px-3 py-2 text-xs", tone)}>
        <div>{format(template, { label })}</div>
        {confirmation.status === "failed" && confirmation.result ? (
          <div className="mt-1 text-[11px] opacity-80 break-words">
            {confirmation.result}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type PendingQuestionDict = ReturnType<typeof useT>["chat"]["pendingQuestion"];

/**
 * Inline answer surface for a suspended askQuestion. The question text is
 * already rendered as a normal assistant bubble above (the engine streams
 * it via text_delta before suspending), so this panel is compact: a
 * heading, an answer input, and Send / Cancel. Submit POSTs
 * /api/sessions/:id/answer/:approvalId; Cancel POSTs /cancel after a
 * confirm. See docs/architecture/engine/askquestion-suspend-resume.md.
 */
function PendingQuestionPanel({
  sessionId,
  approvalId,
  dict,
  onAnswered,
  onCancelled,
}: {
  sessionId: string;
  approvalId: string;
  dict: PendingQuestionDict;
  onAnswered: () => void;
  onCancelled: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  // Grow the answer box line-by-line as the user types (Shift+Enter newline),
  // capped by `max-h-40`; past that the overflow scrolls.
  useAutoGrowTextarea(answerRef, answer);

  const onSubmit = useCallback(async () => {
    const trimmed = answer.trim();
    if (!trimmed || submitting || cancelling) return;
    setSubmitting(true);
    setError(null);
    const result = await submitAnswer(sessionId, approvalId, trimmed);
    setSubmitting(false);
    if (!result.ok) {
      // 409 + idempotent === already resolved → clear and let the parent
      // poll for the resumed reply.
      if (result.httpStatus === 409 && result.idempotent) {
        onAnswered();
        return;
      }
      setError(result.error ?? dict.resumeError);
      return;
    }
    setAnswer("");
    onAnswered();
  }, [answer, submitting, cancelling, sessionId, approvalId, onAnswered, dict]);

  const onCancel = useCallback(async () => {
    if (cancelling || submitting) return;
    const confirmed = await confirmDialog({
      title: dict.cancel,
      description: dict.cancelConfirm,
      confirmLabel: dict.cancel,
      cancelLabel: dict.cancelConfirmKeep,
      variant: "destructive",
    });
    if (!confirmed) return;
    setCancelling(true);
    setError(null);
    const result = await cancelPendingQuestion(sessionId, approvalId);
    setCancelling(false);
    if (!result.ok) {
      setError(dict.resumeError);
      return;
    }
    onCancelled();
  }, [cancelling, submitting, sessionId, approvalId, onCancelled, dict]);

  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/25">
        <TriangleAlert className="size-3.5" aria-hidden />
      </div>
      <div className="flex-1 min-w-0 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
        <div className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
          {dict.heading}
        </div>
        <textarea
          ref={answerRef}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits; Shift+Enter newline — same as the composer.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onSubmit();
            }
          }}
          placeholder={dict.placeholder}
          rows={2}
          autoFocus
          disabled={submitting || cancelling}
          className={cn(
            "w-full min-h-[3.25rem] max-h-40 resize-none overflow-y-auto rounded-md border border-border bg-background",
            "px-2.5 py-1.5 text-[13px] leading-relaxed outline-none",
            "placeholder:text-muted-foreground",
            "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
            "disabled:opacity-60",
          )}
        />
        {error ? (
          <div className="text-xs text-destructive">{error}</div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => void onCancel()}
            disabled={submitting || cancelling}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px] font-medium text-muted-foreground",
              "transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {cancelling ? dict.cancelling : dict.cancel}
          </button>
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={submitting || cancelling || answer.trim().length === 0}
            className={cn(
              "rounded-md bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground",
              "transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {submitting ? dict.submitting : dict.submit}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pill shown while the resume worker fires the continuation turn. */
function ResumingIndicator({ label }: { label: string }) {
  return (
    <div className="flex justify-center pt-1">
      <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary ring-1 ring-primary/15">
        <span className="relative inline-flex h-2 w-2" aria-hidden>
          <span className="absolute inset-0 animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-block h-2 w-2 rounded-full bg-primary" />
        </span>
        {label}
      </span>
    </div>
  );
}
