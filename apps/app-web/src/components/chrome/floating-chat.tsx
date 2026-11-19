"use client";
import { ChatRetainedHistoryNotice } from "@/components/chat-app/chat-retained-history-notice";
import { useDurableDraft } from "@/lib/offline/use-durable-draft";


import { canonicalInteractionAdditions } from "@/lib/live-interaction/canonical";
import { LiveInteractionJobs, LiveInteractionQuestionControls } from "./live-interaction-jobs";
import { availableAppWidth, subscribeAppViewport } from "@/lib/app-viewport";

import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Floating chat panel for app-web — the ambient "Ask anything…"
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
 *   │  Idle: "Ask anything…"  ·  Streaming: mirrors live    │
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
 *
 * The dock is a PRESENTATION of the shared conversation controller (M5,
 * `[COMP:app-web/conversation-controller]`): every FloatingChat instance of
 * this renderer (the desktop dock, the mobile drawer, Feed hosts) attaches to
 * the same conversation-registry entry for the doc thread through
 * `useConversation` with the dock profile (`DOCK_TURN_TRANSCRIPT`). The
 * controller owns the direct stream, the follow/re-attach stream, Stop,
 * approvals, pending input, mid-turn queue and the per-turn transcript; the
 * dock keeps the page target and `docViewId`, the surface effects of its own
 * turns (`onSurfaceEffect`, dispatched once), resize, the collapsed pill, the
 * `ChatActivity` mirror, recorder ownership and seeds. Notice codes map to
 * this dock's existing copy. See docs/architecture/features/doc.md →
 * "One conversation, every dock instance" and chat-app.md → "Shared client
 * controller ownership".
 *
 * Retry / Copy buttons hover-reveal on every assistant bubble. Retry
 * re-sends the user message and tells the server to truncate from it
 * (`truncateFromMessageId`, the controller's `edit`) so the response
 * replaces the old one cleanly.
 *
 * Tool confirmations render as inline approval cards
 * (`ChatConfirmationCard`, chat-confirmation-card.tsx: recognised tools show
 * a rich per-tool preview parsed from `input`); Approve/Deny goes through the
 * controller's one `respondConfirmation` path (live card or restored card,
 * 403 shown as `confirmNotAllowed`).
 *
 * askQuestion suspend-resume: the controller presents the suspended question
 * (from the pending-input probe when the turn ends or on reload, or from a
 * `pending_question_exists` refusal; never as an approval card); the dock
 * gates the composer and renders `<PendingQuestionPanel>`. After the panel's
 * answer/cancel POST, `questionSettled` follows the resumed turn over the
 * session stream inside the bounded resume window (no message poll). See
 * docs/architecture/engine/askquestion-suspend-resume.md.
 *
 * [COMP:app-web/floating-chat]
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  docPagePath,
  pageIdFromInAppHref,
  pageIdFromPathname,
  surfaceFromPathname,
  panelFromSearch,
} from "@/lib/doc-page-url";
import { DOC_COMMENTS_CHANGED_EVENT } from "@/lib/comment-events";
import {
  SlashCommandIndicator,
  SlashCommandMenuList,
  useSlashCommands,
} from "@/components/chat-app/slash-command-autocomplete";
import {
  GoalAcknowledgement,
  goalAcceptedNoticeFromPayload,
  type GoalAcceptedNotice,
} from "@/components/chat-app/goal-acknowledgement";
import { deploymentCapabilities, isHostedEdition } from "@/lib/edition";
import { modelTierPlanGateApplies } from "@/lib/plan-gate";
import {
  ASSISTANT_REFRESH_EVENT,
  type AssistantRefreshDetail,
} from "@/lib/assistant-events";
import {
  readActiveAssistantId,
  writeActiveAssistantId,
} from "@/lib/active-assistant";
import { nextReplyVoiceHint } from "@/lib/next-reply-voice";
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
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  FilePlus,
  FileText,
  MessageSquare,
  Paperclip,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  ChatComposer,
  initialChatState,
  initialTurnTranscript,
  type PendingConfirmation,
  type ToolUsed,
} from "@use-brian/chat-ui";
import {
  RESUME_ATTACH_WINDOW_MS,
  type ConversationBodyExtras,
  type ConversationController,
  type ConversationNotice,
  type ConversationQuestion,
  type ConversationSendInput,
  type ConversationState,
  type PresentationCapabilities,
} from "@/lib/chat/conversation-controller";
import { provisionalConversationKey } from "@/lib/chat/conversation-registry";
import { conversationAttachmentTray } from "@/lib/chat/conversation-attachments";
import type { ClassifiedTurnFrame } from "@/lib/chat/turn-frames";
import { useConversation } from "@/lib/chat/use-conversation";
import { currentOfflineWriteAuthority } from "@/lib/offline/application-write-authority";
import { QueuedInputs } from "@/components/ui/queued-inputs";
import {
  ChatMarkdownWithLinks,
  MessageBubble,
  mapSessionRows,
  type MessageWithViews,
} from "@/components/chrome/chat-message-bubble";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import {
  ChatActivityFeed,
  ChatCitationList,
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
import {
  BRAIN_ENTRY_VIEW_EVENT,
  requestBrainRefresh,
  type BrainEntryViewDetail,
} from "@/lib/brain-events";
import { viewingBrainEntryFromLocation } from "@/lib/brain-deep-link";
import type { BrainPrimitive } from "@/lib/api/brain-inbox";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
import {
  SURFACE_CHAT_SEED_EVENT,
  type SurfaceChatSeed,
} from "@/lib/surface-chat-seed";
import {
  fetchLatestSession,
  type MessageAttachmentRef,
} from "@/lib/api/sessions";
import { PendingQuestionPanel } from "./pending-question-panel";
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
import {
  useRecordingUpload,
  type StagedRecording,
} from "@/lib/recordings/use-recording-upload";
import { dispatchRecordingParticipantsUpdated } from "@/lib/recordings/recording-events";
import { companionChatPhase } from "@/lib/companion-chat-state";
import { useDockRecorder } from "@/lib/recorder/use-dock-recorder";
import { useLiveRecordingPage } from "@/lib/recordings/use-live-recording-page";
import {
  getDockRecorderSessionId,
  ensureDockRecorderInteractionSession,
  publishDockRecorderController,
  sendDockRecorderVoiceClip,
} from "@/lib/recorder/dock-recorder-bridge";
import {
  DockRecorderButton,
  DockRecorderNotice,
  DockRecorderRecovery,
  DockRecorderStrip,
  pickCaptureSource,
} from "@/components/chrome/dock-recorder";
import { useFileDrop } from "@/lib/use-file-drop";
import { AttachmentChips, FileDropOverlay } from "@/components/doc/attachment-chips";
import { RecordingUploadStatus } from "@/components/recordings/recording-upload-status";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/**
 * The non-doc workspace surfaces this dock can mount over. Each value is
 * also the `appOrigin` stamped on `/api/chat` sessions (migration 255 allows
 * them all on `sessions.app_origin`), so threads + Recents scope per-surface.
 */
export type ChatSurface =
  | "brain"
  | "studio"
  | "workflow"
  | "approvals";

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

// Per-workspace persisted choice of which assistant this doc chat talks to
// (defaults to the workspace primary, switchable to any accessible workspace
// assistant, sticks across reloads) now lives in `lib/active-assistant.ts` —
// the landing's draft-assistant picker reads the same key.

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
  const maxW = hasWindow ? Math.max(0, availableAppWidth() - 32) : size.w;
  const maxH = hasWindow
    ? Math.max(MIN_CHAT_H, Math.round(window.innerHeight * 0.92))
    : size.h;
  return {
    w: Math.round(Math.min(maxW, Math.max(MIN_CHAT_W, size.w))),
    h: Math.round(Math.max(MIN_CHAT_H, Math.min(size.h, maxH))),
  };
}

/**
 * Pointer to a doc draft emitted by `renderView`. Structurally
 * extends chat-ui's `ViewPayloadAttachment` (which carries `payload:
 * unknown` for inline-render consumers like apps/web), but doc
 * deliberately ignores `payload` — the draft on the doc is the
 * truth. The model speaks; the doc shows.
 */
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
  phase: "idle" | "loading" | "thinking" | "responding" | "action-required";
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
    /** Recording ids staged without processing on the seeding surface. */
    attachedRecordingIds?: string[];
    /**
     * Empty-line "Space for AI" anchor: the inline AI box's block. Rides the
     * autoSend turn as `docAnchorBlockId` so the generation lands after that
     * line (the chat route injects an "Insertion anchor" note). Paired with
     * `autoSend` + `docViewId`.
     */
    anchorBlockId?: string;
    /** Draft-assistant pick (the landing's picker): switch the dock's
     *  interlocutor to this assistant — the manual switcher's fresh-session
     *  rule — before the seeded turn fires. */
    assistantId?: string;
    nonce: number;
  };
  /**
   * Soft double-text guard: the assistant run another member started on THIS
   * page (null when idle or when the local user is the one running it). When
   * set, the composer shows a warning strip so a teammate doesn't fire a second
   * instruction at the same page. Soft by design — it warns, it doesn't block.
   */
  othersRun?: AssistantRunState | null;
  /** Reveal and focus the already-mounted composer when this token changes. */
  messageBrianRequest?: number;
  /** Called after the requested composer is mounted, visible, and focused. */
  onMessageBrianRevealed?: () => void;
};

const CLIENT_TIMEZONE: string | null = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
})();

// ── One doc thread, every dock instance (M5 WP-C) ────────────────────────
// Which conversation a dock thread is bound to, shared by every FloatingChat
// instance of this renderer, so the desktop dock, the mobile drawer and the
// Feed drawer hosts acquire ONE conversation-registry entry: a resize across
// `lg` or opening the drawer shows the same live turn. Keyed by the write
// authority (apiOrigin, viewer, workspace) plus the dock origin, so another
// identity or deployment never sees a binding; reset with local data. A
// separate desktop chat window is another realm with its own bindings.
// See docs/architecture/features/doc.md → "One conversation, every dock
// instance".

export type DockThreadBinding = {
  /** The bound server session, or null while the thread is provisional. */
  sessionId: string | null;
  /** Provisional client id; a reset mints a new one (a new registry entry). */
  clientId: string;
  /** Bumped by every reset, so a late lookup cannot rebind a wiped thread. */
  epoch: number;
  /** After an answered question: the resumed turn is awaited until then. */
  awaitingResumeUntil: number | null;
  /** History epoch when the resume wait began; a later reload ends the wait. */
  awaitingResumeEpoch: number;
  /** The latest-session lookup ran (or runs) for this epoch. */
  resumeLookup: boolean;
};

type DockThreadEntry = { value: DockThreadBinding; listeners: Set<() => void> };
const dockThreads = new Map<string, DockThreadEntry>();
let dockClientSeq = 0;

function mintDockClientId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `dock-${Date.now()}-${++dockClientSeq}`;
}

function freshDockThread(epoch: number): DockThreadBinding {
  return {
    sessionId: null,
    clientId: mintDockClientId(),
    epoch,
    awaitingResumeUntil: null,
    awaitingResumeEpoch: 0,
    resumeLookup: false,
  };
}

function dockThreadEntry(key: string): DockThreadEntry {
  let entry = dockThreads.get(key);
  if (!entry) {
    entry = { value: freshDockThread(0), listeners: new Set() };
    dockThreads.set(key, entry);
  }
  return entry;
}

/** Binding key: write authority plus dock origin. */
export function dockThreadKey(
  authority: { apiOrigin: string; viewerId: string; workspaceId: string } | null,
  workspaceId: string,
  origin: string,
): string {
  return authority
    ? JSON.stringify([authority.apiOrigin, authority.viewerId, authority.workspaceId, origin])
    : JSON.stringify(["", "", workspaceId, origin]);
}

export function readDockThread(key: string): DockThreadBinding {
  return dockThreadEntry(key).value;
}

/** Patch a binding; a function returning null leaves it unchanged. */
export function updateDockThread(
  key: string,
  patch:
    | Partial<DockThreadBinding>
    | ((current: DockThreadBinding) => Partial<DockThreadBinding> | null),
): void {
  const entry = dockThreadEntry(key);
  const next = typeof patch === "function" ? patch(entry.value) : patch;
  if (!next) return;
  entry.value = { ...entry.value, ...next };
  for (const listener of [...entry.listeners]) listener();
}

/**
 * "The next send starts a fresh session": a new provisional entry. With
 * `resume: false` (a surface seed, a session-rebound recovery) the fresh
 * thread is final: the latest-session lookup is marked done for the new
 * epoch, so it cannot re-bind the thread the reset just left (M5Q-20).
 * An assistant switch off the doc surface keeps `resume: true` and resumes
 * that assistant's latest thread for the surface.
 */
export function resetDockThread(key: string, options: { resume?: boolean } = {}): void {
  const resume = options.resume ?? true;
  updateDockThread(key, (current) => ({ ...freshDockThread(current.epoch + 1), resumeLookup: !resume }));
}

function subscribeDockThread(key: string, listener: () => void): () => void {
  const entry = dockThreadEntry(key);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

if (typeof window !== "undefined") {
  // The registry disposes every controller on this signal; the bindings
  // that pointed at them start over too.
  window.addEventListener("brian:local-data-cleared", () => {
    for (const key of [...dockThreads.keys()]) resetDockThread(key);
  });
}

function useDockThread(key: string): DockThreadBinding {
  const subscribe = useCallback((listener: () => void) => subscribeDockThread(key, listener), [key]);
  const read = useCallback(() => readDockThread(key), [key]);
  return useSyncExternalStore(subscribe, read, read);
}

// A surface seed reaches every mounted dock instance; only the first one
// resets the thread and queues its auto-send, so one seed is one turn.
const claimedSurfaceSeeds = new WeakSet<object>();

/** True for the first dock instance that handles this seed event. */
export function claimSurfaceSeed(seed: object): boolean {
  if (claimedSurfaceSeeds.has(seed)) return false;
  claimedSurfaceSeeds.add(seed);
  return true;
}

// ── Build-activity log ──────────────────────────────────────────────────
// The page-body generating widget reads a chronological log of reasoning
// runs and build steps (lib/build-events.ts). It is rebuilt from the
// controller's frame observer (`onFrame`) and kept per conversation, so every
// dock instance on the thread publishes the same log.

type DockBuildLog = {
  log: EventLog;
  reasoning: string;
  seq: number;
  started: Set<string>;
  evented: Set<string>;
};
type DockBuildLogEntry = { state: DockBuildLog; listeners: Set<() => void> };
const dockBuildLogs = new WeakMap<object, DockBuildLogEntry>();

function emptyDockBuildLog(): DockBuildLog {
  return { log: EMPTY_LOG, reasoning: "", seq: 0, started: new Set(), evented: new Set() };
}

function dockBuildLogEntry(owner: object): DockBuildLogEntry {
  let entry = dockBuildLogs.get(owner);
  if (!entry) {
    entry = { state: emptyDockBuildLog(), listeners: new Set() };
    dockBuildLogs.set(owner, entry);
  }
  return entry;
}

function publishDockBuildLog(entry: DockBuildLogEntry, next: DockBuildLog) {
  entry.state = next;
  for (const listener of [...entry.listeners]) listener();
}

/** A new turn (or a mid-turn split) starts an empty log. */
export function resetDockBuildLog(owner: object): void {
  const entry = dockBuildLogEntry(owner);
  if (entry.state.log === EMPTY_LOG && !entry.state.reasoning) return;
  publishDockBuildLog(entry, emptyDockBuildLog());
}

/** Fold one observed frame into the log (direct frames, or follow `activity`). */
export function observeDockBuildFrame(
  owner: object,
  frame: ClassifiedTurnFrame,
  narration: NarrationDict,
): void {
  const entry = dockBuildLogEntry(owner);
  const followed = frame.stream === "follow" && frame.event === "activity";
  const event = followed ? String(frame.payload.event) : frame.event;
  const payload = frame.payload;
  if ((frame.stream === "direct" && frame.event === "input_applied") || (frame.stream === "follow" && frame.event === "turn_started")) {
    resetDockBuildLog(owner);
    return;
  }
  const state = entry.state;
  const mint = () => `ev-${state.seq++}`;
  const id = typeof payload.id === "string" ? payload.id : "";
  switch (event) {
    case "reasoning": {
      const delta = typeof payload.text === "string" ? payload.text : "";
      if (!delta) return;
      const reasoning = state.reasoning + delta;
      // Coalesced into one advancing "thinking" line until a step closes it.
      const log = appendReasoning(state.log, reasoning, mint);
      publishDockBuildLog(entry, { ...state, reasoning, log });
      return;
    }
    case "tool_start": {
      const name = typeof payload.name === "string" ? payload.name : "";
      if (!id || !name || state.started.has(id)) return;
      state.started.add(id);
      // The step row appears the moment the call starts; `tool_input`
      // rewrites it in place with the input-aware narration.
      const seeded = describeToolFromInput(name, {}, narration);
      const log = appendStep(state.log, seeded.description, mint, { toolId: id });
      publishDockBuildLog(entry, { ...state, log });
      return;
    }
    case "tool_dropped": {
      if (!id) return;
      state.started.delete(id);
      state.evented.delete(id);
      publishDockBuildLog(entry, { ...state, log: removeToolSteps(state.log, id) });
      return;
    }
    case "tool_input": {
      if (!id || state.evented.has(id)) return;
      state.evented.add(id);
      const name = typeof payload.name === "string" ? payload.name : "";
      const input = payload.input && typeof payload.input === "object"
        ? (payload.input as Record<string, unknown>)
        : {};
      const narrated = describeToolFromInput(name, input, narration);
      // patchPage: one extra row per remaining op, a live build log.
      const lines = narrated.opLines && narrated.opLines.length > 0 ? narrated.opLines : [narrated.description];
      const [first, ...rest] = lines;
      let log = first ? updateStepText(state.log, id, first, narrated.url) : state.log;
      for (const line of rest) log = appendStep(log, line, mint, { toolId: id });
      publishDockBuildLog(entry, { ...state, log });
      return;
    }
  }
}

const hydratedBuildLogs = new WeakSet<object>();

/**
 * A dock returning to a still-running turn rebuilds its chronological feed
 * from the controller's bounded build log, then continues from `onFrame`.
 */
export function hydrateDockBuildLog(
  controller: Pick<ConversationController, "getBuildLog">,
  narration: NarrationDict,
): void {
  if (hydratedBuildLogs.has(controller)) return;
  hydratedBuildLogs.add(controller);
  const entry = dockBuildLogEntry(controller);
  if (entry.state.log !== EMPTY_LOG || entry.state.reasoning) return;
  for (const frame of controller.getBuildLog().frames) observeDockBuildFrame(controller, frame, narration);
}

const NO_BUILD_EVENTS: BuildEvent[] = [];

/** The current turn's build events for a conversation. */
export function readDockBuildEvents(owner: object): BuildEvent[] {
  return dockBuildLogs.get(owner)?.state.log.events ?? NO_BUILD_EVENTS;
}

function useDockBuildEvents(owner: object | null): BuildEvent[] {
  const subscribe = useCallback((listener: () => void) => {
    if (!owner) return () => {};
    const entry = dockBuildLogEntry(owner);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }, [owner]);
  const read = useCallback(() => (owner ? readDockBuildEvents(owner) : NO_BUILD_EVENTS), [owner]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Slack past the controller's resume window before the wait indicator gives up. */
const RESUME_WAIT_GRACE_MS = 30_000;

const selectConversation = (state: ConversationState) => state;
const ACTIVE_RUN_PHASES = new Set(["running", "suspended"]);

/** This dock's copy for a controller error notice (existing keys only). */
export function dockErrorCopy(
  notice: Extract<ConversationNotice, { code: "error" }>,
  t: ReturnType<typeof useT>["chat"],
  tChatApp: ReturnType<typeof useT>["chatApp"],
): string {
  switch (notice.errorCode) {
    // Dropped provider connection: retrying is safe and usually enough.
    case "upstream_connection_reset":
      return notice.customEndpoint ? tChatApp.upstreamConnectionResetCustom : tChatApp.upstreamConnectionReset;
    // Endpoint unreachable: the copy points at the settings check.
    case "upstream_unreachable":
      return notice.customEndpoint ? tChatApp.upstreamUnreachableCustom : tChatApp.upstreamUnreachable;
    case "session_assistant_mismatch":
      return tChatApp.sessionRebound;
    // A dropped or blocked connection reads as a calm "connection dropped"
    // line, never the raw browser string.
    case "stream_interrupted":
    case "stream_failed":
      return t.streamInterrupted;
    default:
      // Server-authored text for codes this dock does not translate.
      return notice.message ?? t.error;
  }
}

/** This dock's copy for a typed turn notice, or null when it has none. */
export function dockTurnNoticeCopy(
  notice: Extract<ConversationNotice, { code: "turnNotice" }>,
  t: ReturnType<typeof useT>["chat"],
): string | null {
  if (notice.notice === "budget_downgraded") return t.noticeBudgetDowngraded;
  // Server-authored English rides in `message`; prefer translated copy.
  if (notice.notice === "custom_model_image_fallback") return t.noticeCustomModelImageFallback;
  if (notice.notice === "custom_model_endpoint_fallback") return t.noticeCustomModelEndpointFallback;
  return notice.message ?? null;
}

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
  messageBrianRequest,
  onMessageBrianRevealed,
}: FloatingChatProps) {
  // 'side-panel' fills its parent column and stays open (no pill); 'floating'
  // is the bottom-right collapsible dock. Drives positioning + the pill below.
  const isSidePanel = mode === "side-panel";
  // Doc keeps the page-first affordances; a workspace surface gates them off.
  const isDocOrigin = origin === "doc";
  const t = useT().chat;
  const tChatApp = useT().chatApp;
  // Chat is network/AI — fully unavailable offline. Disable the composer in the
  // bundled app when offline so a turn can't be started (no-op on web/thin).
  const offline = useIsOffline();
  const tRun = useT().docPage.assistantRun;
  const tAttach = useT().attachments;
  const tRec = useT().recordings;
  const tRecorder = useT().recorder;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const showPageTarget = isDocOrigin && surfaceFromPathname(pathname) === "p" && !panelFromSearch(searchParams);
  const [expanded, setExpanded] = useState(false);
  const [input, setInput, draftStorageFailed] = useDurableDraft(workspaceId, `dock:${pathname}`);
  const draftWarning = useT().comments.localDraftFailed;
  const [acceptedGoal, setAcceptedGoal] =
    useState<GoalAcceptedNotice | null>(null);
  /** Anchors the slash-command popup and scopes its outside-click dismissal
   *  to the composer area. */
  const slashContainerRef = useRef<HTMLDivElement | null>(null);
  const slashCommands = useSlashCommands({
    enabled: true,
    workspaceId,
    value: input,
    onChange: setInput,
    containerRef: slashContainerRef,
  });
  const [pendingSurfaceSeed, setPendingSurfaceSeed] =
    useState<SurfaceChatSeed | null>(null);
  const surfaceSeedAttemptRef = useRef<SurfaceChatSeed | null>(null);

  useEffect(() => {
    if (messageBrianRequest === undefined || isSidePanel) return;
    setExpanded(true);
  }, [isSidePanel, messageBrianRequest]);

  const acknowledgedMessageBrianRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (messageBrianRequest === undefined) return;
    if (!isSidePanel && !expanded) return;
    if (acknowledgedMessageBrianRef.current === messageBrianRequest) return;
    acknowledgedMessageBrianRef.current = messageBrianRequest;
    onMessageBrianRevealed?.();
  }, [expanded, isSidePanel, messageBrianRequest, onMessageBrianRevealed]);

  // ── Assistant switcher ───────────────────────────────────────────────────
  // The chat talks to the workspace PRIMARY by default (the `assistantId`
  // prop), but the user can switch to any accessible workspace assistant.
  // The selection is persisted per-workspace and overrides the prop on mount;
  // `selectedAssistantId` is what every chat path below actually uses (resume,
  // send body, identity avatar). The backend still injects doc-editing
  // tools off `appOrigin: "doc"`, so any assistant can edit pages here.
  const [selectedAssistantId, setSelectedAssistantId] = useState<string>(
    () => readActiveAssistantId(workspaceId) ?? assistantId,
  );
  // If the prop changes (workspace switch) and no persisted choice exists for
  // the new workspace, follow the new default primary.
  useEffect(() => {
    setSelectedAssistantId(readActiveAssistantId(workspaceId) ?? assistantId);
  }, [assistantId, workspaceId]);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [workspaceAssistants, setWorkspaceAssistants] = useState<
    WorkspaceAssistantSummary[]
  >([]);
  const reloadWorkspaceAssistants = useCallback(() => {
    if (!workspaceId) return;
    listWorkspaceAssistants(workspaceId)
      .then((list) => setWorkspaceAssistants(list))
      .catch(() => {
        /* switcher just stays single-option; the default still works */
      });
  }, [workspaceId]);

  useEffect(() => {
    reloadWorkspaceAssistants();
  }, [reloadWorkspaceAssistants]);

  // Live refresh. This dock lives in the `/w/[workspaceId]` layout and never
  // unmounts, so the effect above fires once per full page load — a create in
  // Studio (or by a teammate, or in another tab) would otherwise stay invisible
  // until an app restart. Signals arrive via the workspace event spine.
  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<AssistantRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      reloadWorkspaceAssistants();
    };
    window.addEventListener(ASSISTANT_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ASSISTANT_REFRESH_EVENT, onRefresh);
  }, [workspaceId, reloadWorkspaceAssistants]);

  // The assistant's display identity — drives the collapsed launcher's avatar
  // (its creature icon) instead of a generic chat glyph. Only the floating
  // launcher renders the FAB, so the fetch is skipped in side-panel mode.
  const [assistant, setAssistant] = useState<AssistantIdentity | null>(null);
  // Recording-sized media bypasses the multipart cap and uploads directly to
  // storage, but attachment is not permission to transcribe. Keep the staged
  // ids in the composer so the next turn can clarify purpose first.
  // See docs/architecture/media/transcription.md.
  const activeAssistantId = selectedAssistantId || assistantId;
  const rec = useRecordingUpload(workspaceId, activeAssistantId);
  const [pendingRecordings, setPendingRecordings] = useState<StagedRecording[]>([]);
  const att = useFileAttachments(() => sessionIdRef.current ?? undefined, {
    // One tray per dock origin beside the registry: the desktop dock, the
    // phone drawer and Feed hosts share it, and it outlives any one mount
    // (chat-app.md -> "Conversation attachment trays").
    tray: conversationAttachmentTray(workspaceId, { provisional: provisionalConversationKey("dock", origin) }),
    // Only offer routing when we have a workspace + assistant to bind the
    // recording to; otherwise video falls to the guard (unsupported-here) chip.
    onRouteMedia:
      workspaceId && activeAssistantId
        ? async (videos) => {
            for (const file of videos) {
              const staged = await rec.stage(file);
              if (staged) setPendingRecordings((current) => [...current, staged]);
            }
          }
        : undefined,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Errors this dock raises itself (a rebound session); controller notices
  // supply the rest.
  const [localError, setLocalError] = useState<string | null>(null);
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
  // Model tier — persisted, plan-gated once /api/usage resolves. Replaces the
  // previously hardcoded "standard" send.
  const [model, setModel] = useState<ModelTier>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY);
      if (saved === "standard" || saved === "pro" || saved === "max") return saved;
    }
    return deploymentCapabilities().planEntitlements ? "standard" : "pro";
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
  const [customEndpoint, setCustomEndpoint] = useState<{
    key: string;
    selector: string;
    label: string;
  } | null>(null);
  const [modelMenu, setModelMenu] = useState<import("@/lib/api/models").ModelMenu | null>(null);
  // Deferred research (surface seeds only): the first turn sends standard (a
  // cheap clarifying round-trip), then research arms once the reply lands —
  // the brain "Research my company" nudge semantics. Checked in onDone.
  const deferResearchRef = useRef(false);
  const [researchQuota, setResearchQuota] = useState<{ used: number; quota: number; isPaid: boolean } | null>(null);
  const [researchExhausted, setResearchExhausted] = useState(false);
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
    onResize();
    return subscribeAppViewport(onResize);
  }, [isSidePanel]);

  // ── The conversation (M5: this dock is a presentation) ─────────────────
  // Every dock instance on this thread reads one shared binding and so
  // acquires one conversation-registry entry. The controller owns the turn:
  // the direct stream, the follow/re-attach stream, Stop, approvals,
  // pending input, the mid-turn queue and the per-turn transcript.
  const writeAuthority = currentOfflineWriteAuthority(workspaceId);
  const threadKey = dockThreadKey(writeAuthority, workspaceId, origin);
  const threadKeyRef = useRef(threadKey);
  threadKeyRef.current = threadKey;
  const thread = useDockThread(threadKey);
  // A provisional entry re-keys to its session on the `session` frame. Until
  // the binding catches up, read the adopted id from the entry this instance
  // already holds, so the same render keeps the same controller.
  const boundRef = useRef<{ clientId: string; controller: ConversationController | null }>({
    clientId: "",
    controller: null,
  });
  const adoptedSessionId =
    !thread.sessionId &&
    boundRef.current.clientId === thread.clientId &&
    boundRef.current.controller &&
    !boundRef.current.controller.isDisposed()
      ? boundRef.current.controller.getSessionId()
      : null;
  // Capabilities read through refs: they close over state declared below.
  const surfaceEffectRef = useRef<(frame: ClassifiedTurnFrame) => void>(() => {});
  const frameObserverRef = useRef<(frame: ClassifiedTurnFrame) => void>(() => {});
  const narrationRef = useRef(t.toolNarration);
  narrationRef.current = t.toolNarration;
  const capabilities = useMemo<PresentationCapabilities>(
    () => ({
      profile: "dock",
      onSurfaceEffect: (frame) => surfaceEffectRef.current(frame),
      onFrame: (frame) => frameObserverRef.current(frame),
      describeTool: (name, toolInput) => describeToolFromInput(name, toolInput, narrationRef.current),
      mapHistoryRows: (rows) => mapSessionRows(rows, narrationRef.current),
    }),
    [],
  );
  const presentationId = useId();
  const { controller, value: conversation } = useConversation(
    {
      workspaceId,
      sessionId: thread.sessionId ?? adoptedSessionId,
      provisionalKey: provisionalConversationKey("dock", `${origin}:${thread.clientId}`),
      presentationId,
      capabilities,
    },
    selectConversation,
  );
  boundRef.current = { clientId: thread.clientId, controller };
  useLayoutEffect(() => {
    if (controller) hydrateDockBuildLog(controller, narrationRef.current);
  }, [controller]);

  // ── Derived turn state (one snapshot, every instance) ──────────────────
  const transcript = conversation?.transcript ?? initialChatState;
  const sessionId = transcript.sessionId;
  // Read by callbacks (uploads, the recorder binding, interaction answers).
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  const mirror = conversation?.mirror ?? null;
  const directLive = transcript.isStreaming;
  // A re-attached turn (after a dropped POST, a reload or the resumed
  // question turn) paints the controller's mirror in the same live bubble.
  const mirrorLive = !directLive && !!mirror?.active;
  const isStreaming = directLive || mirrorLive;
  const liveActivity = directLive
    ? conversation!.activity
    : mirrorLive
      ? mirror!.activity
      : initialTurnTranscript;
  const streamingText = directLive ? transcript.streamingText : mirrorLive ? mirror!.text : "";
  const replyPhase = directLive ? transcript.replyPhase : mirror?.replyPhase ?? "generating";
  const researchPhase = directLive
    ? conversation?.researchPhase ?? null
    : mirrorLive
      ? mirror!.researchPhase
      : null;
  const turnStartedAt = directLive ? liveActivity.startedAt : mirrorLive ? mirror!.startedAt : null;
  const streamingReasoning = directLive ? liveActivity.reasoning : mirrorLive ? mirror!.reasoning : "";
  // The assistant the live turn answers as (the streaming avatar).
  const liveAssistantId = conversation?.liveAssistantId ?? null;
  const toolTimeline = liveActivity.tools as ToolUsedWithOps[];
  const citations = liveActivity.citations;
  const streamingEvents = useDockBuildEvents(controller);
  const pendingInteraction = conversation?.interaction.pending ?? null;
  // askQuestion suspend-resume: the controller presents the suspended
  // question (pending-input probe at turn end or on reload, or a
  // `pending_question_exists` refusal);
  // the composer is gated and the inline answer panel renders below.
  const pendingQuestion =
    pendingInteraction?.kind === "question"
      ? (pendingInteraction.payload as ConversationQuestion)
      : null;
  const notices = conversation?.notices ?? [];
  const reconnecting = notices.some((item) => item.code === "reconnecting");
  const awaitingResume = thread.awaitingResumeUntil !== null;

  // Drag-and-drop file attach over the whole chat panel. Disabled while a
  // clarifying question is pending (the composer is replaced by the answer
  // panel then, so there's nothing to attach to).
  const drop = useFileDrop((files) => void att.upload(files), {
    disabled: !!pendingQuestion || rec.busy,
  });

  // ── Thread reset ─────────────────────────────────────────────────────────
  // Bind a fresh provisional entry: the next send starts a fresh session.
  // Shared by the assistant switcher (off doc), surface seeds and the
  // session-rebound recovery. The departing entry detaches; a turn still
  // running there keeps its bounded detached stream in the registry, and
  // its queue never reaches the new composer. The epoch bump invalidates any
  // latest-session lookup still in flight.
  const resetThread = useCallback((options: { resume?: boolean } = {}) => {
    resetDockThread(threadKeyRef.current, { resume: options.resume ?? false });
    setLocalError(null);
  }, []);

  // ── Assistant switch ─────────────────────────────────────────────────────
  // On the DOC surface a switch is a per-turn re-address, not a thread
  // reset: the doc dock's personal thread reuses the multi-assistant room
  // machinery (chat-app.md → "Choosing an assistant" → the doc-dock
  // bullet), so the next send simply carries the new `assistantId`, the
  // server runs that turn AS the new assistant and stamps its reply, and
  // the conversation — including any in-flight turn, which completes as the
  // assistant that started it — is kept.
  //
  // Every other origin keeps the fresh-session rule: those sessions are
  // strictly assistant-bound server-side (the backend rejects a turn when
  // `session.assistantId !== assistant.id`), so we clear
  // `sessionIdRef.current` (and the reducer's session id + loaded messages)
  // and let the assistant-keyed resume effect pull the new assistant's
  // latest session for the surface, if any.
  const handleSwitchAssistant = useCallback(
    (id: string) => {
      setSwitcherOpen(false);
      if (id === selectedAssistantId) return;
      writeActiveAssistantId(workspaceId, id);
      if (!isDocOrigin) resetThread({ resume: true });
      setSelectedAssistantId(id);
    },
    [selectedAssistantId, workspaceId, resetThread, isDocOrigin],
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
  // (`requestSurfaceChatSeed`, including the brain pristine-nudge CTAs). A
  // nudge means "start a new conversation
  // about X" — reset the thread, expand, prefill (or queue the explicitly
  // confirmed auto-send), and arm research either for this turn
  // (`researchMode`) or the one after the first reply (`deferResearch`).
  // Listened for at every origin now that one unified dock serves all surfaces
  // — a brain nudge must still reach it on the doc origin.
  useEffect(() => {
    function onSeed(e: Event) {
      const seed = (e as CustomEvent<SurfaceChatSeed>).detail;
      if (!seed?.prefill?.trim()) return;
      setExpanded(true);
      // Every mounted dock instance hears the seed; the first one owns it,
      // so one seed resets the shared thread once and sends at most once.
      if (!claimSurfaceSeed(seed)) return;
      resetThread();
      if (seed.autoSend) {
        setInput("");
        setPendingSurfaceSeed(seed);
      } else {
        setPendingSurfaceSeed(null);
        setInput(seed.prefill);
      }
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
    if (!workspaceId || !deploymentCapabilities().planEntitlements) return;
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
    // Labels prefer the registry displayName ("DeepSeek V4 Pro") — aliases
    // stay the technical identity the send body carries.
    const nameFor = (alias: string) => models.find((m) => m.alias === alias)?.displayName ?? alias;
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
        label: `${nameFor(prof.modelAlias)} / ${prof.name}`,
        sublabel: defaultProfileIds.has(prof.id) ? `${t.meteredDefaultTag} · ${sub}` : sub,
      });
    }
    for (const m of models) {
      opts.push({ key: `m:${m.alias}`, label: m.displayName, sublabel: t.meteredModelSub });
    }
    return opts;
  }, [modelMenu, t]);
  const customOptions = useMemo(() =>
    (modelMenu?.customEndpoints ?? []).map((endpoint) => ({
      key: endpoint.id,
      label: `${endpoint.endpointName} / ${endpoint.name === endpoint.endpointName ? endpoint.modelId : endpoint.name}`,
      sublabel: `${endpoint.modelId}${endpoint.tiers.length > 0 ? ` · ${endpoint.tiers.map((tier) =>
        tier === "standard" ? t.modelStandard : tier === "pro" ? t.modelPro : tier === "max" ? t.modelMax : t.research
      ).join(", ")}` : ""}`,
    })), [modelMenu, t.modelStandard, t.modelPro, t.modelMax, t.research]);

  // Pre-flight invariant (L8): estimate at the CHOSEN budget → confirm →
  // only then arm the selection. The send body then carries
  // `meteredAccepted: true`; the server re-enforces regardless.
  const handleMeteredSelect = useCallback(
    (key: string | null) => {
      if (!key) { setMetered(null); return; }
      if (!workspaceId || !modelMenu) return;
      const nameFor = (a: string) =>
        (modelMenu.classes["metered"] ?? []).find((m) => m.alias === a)?.displayName ?? a;
      let alias: string; let profileId: string | null = null; let toolRounds = 100; let label: string;
      if (key.startsWith("p:")) {
        const prof = modelMenu.profiles.find((x) => x.id === key.slice(2));
        if (!prof) return;
        alias = prof.modelAlias; profileId = prof.id; toolRounds = prof.toolRounds;
        label = `${nameFor(prof.modelAlias)} / ${prof.name}`;
      } else {
        alias = key.slice(2); label = nameFor(alias);
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
    const capabilities = deploymentCapabilities();
    if (modelTierPlanGateApplies(capabilities, workspacePlan, model)) {
      setModel(model === "max" && workspacePlan === "pro" ? "pro" : "standard");
    }
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

  // Seed from the canonical Brain deep link, then let the detail drawer's
  // live event override it for Review rows opened from local page state.
  // Every turn carries that exact pair so "this entry" cannot be mistaken
  // for a Doc title.
  const viewingBrainEntryRef = useRef<{
    primitive: BrainPrimitive;
    rowId: string;
  } | null>(null);
  useEffect(() => {
    viewingBrainEntryRef.current = viewingBrainEntryFromLocation(
      pathname,
      new URLSearchParams(searchParams.toString()),
    );
  }, [pathname, searchParams]);
  useEffect(() => {
    const onEntryView = (event: Event) => {
      const detail = (event as CustomEvent<BrainEntryViewDetail>).detail;
      if (detail.workspaceId !== workspaceId) return;
      viewingBrainEntryRef.current = detail.entry
        ? {
            primitive: detail.entry.primitive as BrainPrimitive,
            rowId: detail.entry.rowId,
          }
        : null;
    };
    window.addEventListener(BRAIN_ENTRY_VIEW_EVENT, onEntryView);
    return () => window.removeEventListener(BRAIN_ENTRY_VIEW_EVENT, onEntryView);
  }, [workspaceId]);

  // ── Live activity mirror to parent + collapsed pill ────────────────────
  const pendingConfirmations = transcript.pendingConfirmations as ConfirmationWithFailure[];
  const activity = useMemo<ChatActivity>(() => {
    const replyGenerating = isStreaming && replyPhase === "generating";
    const requiresAction =
      Boolean(pendingQuestion) ||
      pendingConfirmations.some(
        (confirmation) =>
          confirmation.status === "pending" || confirmation.status === "approving",
      );
    const phase = companionChatPhase({
      isStreaming: replyGenerating,
      hasStreamingText: Boolean(streamingText),
      requiresAction,
      isLoading: awaitingResume,
    });
    if (!replyGenerating) {
      return { isStreaming: false, streamingText: "", phase, activeTool: null };
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
      phase,
      activeTool: last
        ? {
            name: last.name,
            description: last.description,
            status: last.status,
          }
        : null,
    };
  }, [isStreaming, replyPhase, pendingQuestion, awaitingResume, pendingConfirmations, streamingText, toolTimeline]);

  const onActivityChangeRef = useRef(onActivityChange);
  useEffect(() => {
    onActivityChangeRef.current = onActivityChange;
  }, [onActivityChange]);
  useEffect(() => {
    onActivityChangeRef.current?.(activity);
  }, [activity]);

  // ── Controller notices → this dock's copy ──────────────────────────────
  const errorNotice = notices.find(
    (item): item is Extract<ConversationNotice, { code: "error" }> => item.code === "error",
  );
  const controllerError = errorNotice
    ? dockErrorCopy(errorNotice, t, tChatApp)
    : notices.some((item) => item.code === "reconnectFailed")
      ? t.turnReconnectFailed
      : notices.some((item) => item.code === "stopTurnFailed")
        ? tChatApp.stopTurnFailed
        : notices.some((item) => item.code === "confirmNotAllowed")
          ? tChatApp.confirmNotAllowed
          : null;
  const error = localError ?? controllerError;
  const turnNotice = notices.find(
    (item): item is Extract<ConversationNotice, { code: "turnNotice" }> => item.code === "turnNotice",
  );
  const turnNoticeCopy = turnNotice ? dockTurnNoticeCopy(turnNotice, t) : null;
  const notice: InlineNotice | null = reconnecting
    ? { code: "reconnecting", message: t.turnReconnecting }
    : turnNotice && turnNoticeCopy
      ? { code: "turnNotice", message: turnNoticeCopy }
      : null;
  const dismissNotice = useCallback(() => {
    if (!controller) return;
    controller.dismissNotice(reconnecting ? "reconnecting" : "turnNotice");
  }, [controller, reconnecting]);

  // Error codes that change this dock's own state, handled once per notice.
  const handledNoticesRef = useRef(new WeakSet<object>());
  useEffect(() => {
    if (!errorNotice || handledNoticesRef.current.has(errorNotice)) return;
    handledNoticesRef.current.add(errorNotice);
    if (errorNotice.errorCode === "research_quota_exhausted") {
      setResearchExhausted(true);
      setResearchMode(false);
    }
    // The dock is holding a session this surface cannot re-address (a
    // resume that attached a row bound to another assistant). Nothing was
    // written server-side, so the recovery is simply to drop the binding:
    // the next send mints a fresh session. The dock has no new-chat
    // control, so otherwise every retry hits the same refusal.
    if (errorNotice.errorCode === "session_assistant_mismatch") {
      resetThread();
      setLocalError(tChatApp.sessionRebound);
    }
  }, [errorNotice, resetThread, tChatApp.sessionRebound]);

  // Text whose delivery is uncertain comes back to the composer; it is
  // never resent automatically (offline contract point 7).
  const unsentCount = conversation?.unsent.length ?? 0;
  useEffect(() => {
    if (!controller || unsentCount === 0) return;
    const texts = controller.takeUnsent();
    if (texts.length === 0) return;
    const restored = texts.join("\n\n");
    setInput((current) => (current.trim() ? `${current}\n\n${restored}` : restored));
  }, [controller, unsentCount, setInput]);

  // The resumed-question wait ends when the resumed turn paints, when
  // history is re-read (the reply landed or the bounded window closed), or
  // at the window's end.
  const historyEpoch = conversation?.historyEpoch ?? 0;
  useEffect(() => {
    const until = thread.awaitingResumeUntil;
    if (until === null) return;
    const clear = () =>
      updateDockThread(threadKey, (current) =>
        current.awaitingResumeUntil === until ? { awaitingResumeUntil: null } : null,
      );
    if (isStreaming || historyEpoch > thread.awaitingResumeEpoch) {
      clear();
      return;
    }
    const timer = setTimeout(clear, Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [thread.awaitingResumeUntil, thread.awaitingResumeEpoch, historyEpoch, isStreaming, threadKey]);

  // Surface docks: a general chat turn may have written to the brain (the
  // assistant saves memories / entities while researching), so nudge the
  // brain page to re-pull once the turn is over, re-attached turns included.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && !isDocOrigin) requestBrainRefresh(workspaceId);
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, isDocOrigin, workspaceId]);

  // Publish the full live detail (tool timeline + streaming text + reasoning)
  // to the build-activity bus so the page-body drafting indicator can render
  // it step-by-step. Every instance on the thread publishes the same shared
  // snapshot. Doc-only — the indicator lives in the page editor, which a
  // surface dock never overlays. See lib/build-activity.ts.
  useEffect(() => {
    if (!isDocOrigin) return;
    publishBuildActivity({
      isStreaming,
      tools: toolTimeline,
      text: streamingText,
      reasoning: streamingReasoning,
      events: streamingEvents,
      // A build seeded from the landing runs with this dock collapsed, so an
      // error rendered HERE is an error nobody sees. Publishing it is what
      // lets the page body report a build that failed before it streamed.
      error: error ?? null,
    });
  }, [isDocOrigin, isStreaming, toolTimeline, streamingText, streamingReasoning, streamingEvents, error]);

  // ── Auto-scroll + escape/click-outside ─────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [
    transcript.messages,
    streamingText,
    toolTimeline,
    pendingConfirmations,
    pendingQuestion,
    awaitingResume,
  ]);

  // A suspended question is not "active" (isStreaming is false once the
  // turn exits), so the live-activity pill won't signal it. Auto-expand
  // when a question appears — live or restored on reload — so the user
  // sees the answer panel instead of a silently-wedged composer. Fires
  // once per question, so manual collapse still sticks afterward.
  const pendingQuestionId = pendingQuestion?.approvalId ?? null;
  useEffect(() => {
    if (pendingQuestionId) setExpanded(true);
  }, [pendingQuestionId]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ESC while streaming stops the in-flight turn rather than
        // closing the panel — matches apps/web's behaviour. Click X to
        // collapse.
        if (isStreaming) {
          void controller?.stop();
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
  }, [expanded, isStreaming, controller]);

  // ── Session resume ─────────────────────────────────────────────────────
  //
  // A reload restores the most recent session for this surface so the user
  // does not lose their thread. The lookup runs once per binding epoch for
  // every instance on the thread; it only BINDS the session. The controller
  // then seeds the authorized history through `mapHistoryRows`, re-attaches a
  // turn still running (hydrate probe) and restores a pending question or
  // tool confirmation. Bails when the thread is already bound or this entry
  // has started a turn, so a fresh chat is never trampled; a failed lookup
  // starts fresh.
  useEffect(() => {
    if (!selectedAssistantId || !controller) return;
    const key = threadKey;
    const binding = readDockThread(key);
    if (binding.sessionId || binding.resumeLookup) return;
    const started = controller.getSnapshot();
    if (controller.getSessionId() || started.transcript.messages.length > 0 || started.transcript.isStreaming) return;
    const { epoch, clientId } = binding;
    updateDockThread(key, { resumeLookup: true });
    const abort = new AbortController();
    let settled = false;
    void fetchLatestSession({
      workspaceId,
      // The doc dock resumes SURFACE-scoped, across the workspace's
      // assistants: its thread is per-turn addressable, so the latest doc
      // thread is the resume target no matter which assistant is
      // currently picked (the thread's binding is just whoever founded
      // it). Other origins stay assistant-keyed.
      ...(origin === "doc"
        ? { scope: "workspace" as const }
        : { assistantId: selectedAssistantId }),
      // Sessions are stamped per-surface — the doc dock resumes its doc
      // thread, a Brain dock its brain thread, and so on.
      appOrigin: origin,
      signal: abort.signal,
    }).catch(() => null).then((latest) => {
      settled = true;
      if (!latest) return;
      // Defence in depth for the doc dock's `scope: "workspace"` resume. A
      // row we ATTACH must be one the server lets the current pick ANSWER
      // on — the `docSurface` policy in `chat.ts`, i.e. `app_origin ===
      // 'doc'`; anything else is a dead thread. The server predicate is the
      // fix (`DOC_DOCK_RESUME_ROW`); this guard covers an older API.
      if (origin === "doc" && latest.appOrigin !== "doc") return;
      // A send, reset or switch while the lookup was out wins.
      const now = controller.getSnapshot();
      if (controller.getSessionId() || now.transcript.messages.length > 0 || now.transcript.isStreaming) return;
      updateDockThread(key, (current) =>
        current.epoch === epoch && current.clientId === clientId && !current.sessionId
          ? { sessionId: latest.id }
          : null,
      );
    });
    return () => {
      if (settled) return;
      abort.abort();
      // A torn-down lookup may run again for this epoch.
      updateDockThread(key, (current) =>
        current.epoch === epoch && current.clientId === clientId && !current.sessionId
          ? { resumeLookup: false }
          : null,
      );
    };
  }, [selectedAssistantId, workspaceId, origin, controller, threadKey]);

  // ── Surface effects of this dock's turns (dispatched once) ─────────────
  // The controller hands each surface-effect and presentation frame of a
  // turn this instance started to this instance only (or to the latest
  // attached one when the originator is gone), so a sidebar refresh or an
  // auto-navigation never fires twice across the dock and the drawer.
  surfaceEffectRef.current = (frame) => {
    const { payload } = frame;
    switch (frame.event) {
      case "goal_accepted": {
        const notice = goalAcceptedNoticeFromPayload(payload);
        if (notice) setAcceptedGoal(notice);
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
      case "recording_participants_updated": {
        const recordingId =
          typeof payload.recordingId === "string" ? payload.recordingId : "";
        const pageId =
          typeof payload.pageId === "string" ? payload.pageId : undefined;
        if (recordingId) {
          dispatchRecordingParticipantsUpdated({
            recordingId,
            ...(pageId ? { pageId } : {}),
          });
        }
        break;
      }
      case "brain_entry_updated": {
        const primitive =
          typeof payload.primitive === "string"
            ? (payload.primitive as BrainPrimitive)
            : null;
        const previousRowId =
          typeof payload.previousRowId === "string" ? payload.previousRowId : null;
        const liveRowId =
          typeof payload.liveRowId === "string" ? payload.liveRowId : null;
        requestBrainRefresh(workspaceId);
        const open = viewingBrainEntryRef.current;
        if (
          primitive &&
          previousRowId &&
          liveRowId &&
          open?.primitive === primitive &&
          open.rowId === previousRowId
        ) {
          viewingBrainEntryRef.current = { primitive, rowId: liveRowId };
          const params = new URLSearchParams(window.location.search);
          params.set("row", liveRowId);
          if (primitive === "task") params.delete("kind");
          else params.set("kind", primitive);
          router.replace(`${pathname}?${params.toString()}`, { scroll: false });
        }
        break;
      }
      case "view_payload": {
        // `renderView` lands a `data` block on a draft, server-side. Doc is
        // a draft-first surface: the controller keeps the pointer on the
        // committed reply (`views[]`); here we (1) bridge to the sidebar
        // refresh and (2) auto-navigate to a newly created draft.
        const viewId =
          typeof payload.viewId === "string" && payload.viewId.length > 0
            ? payload.viewId
            : undefined;
        const action =
          payload.action === "appended" || payload.action === "created"
            ? payload.action
            : undefined;
        if (viewId && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("doc:draft-created", {
              detail: {
                viewId,
                toolUseId: typeof payload.toolUseId === "string" ? payload.toolUseId : "",
                action,
              },
            }),
          );
          // Created path → land the user on the new draft (soft transition;
          // the persistent dock survives `router.replace`). Doc-only.
          if (isDocOrigin && action === "created" && viewId !== activeViewIdRef.current) {
            router.replace(docPagePath(workspaceId, viewId), { scroll: false });
          }
        }
        break;
      }
      case "sub_page_created": {
        // A new nested sub-page (createSubPage): refresh the sidebar so the
        // child appears, but do NOT navigate — the user asked to file a
        // child under the page they're on.
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("doc:draft-created", {
              detail: {
                viewId: typeof payload.pageId === "string" ? payload.pageId : undefined,
                action: "created",
              },
            }),
          );
        }
        break;
      }
      case "page_created": {
        // A brand-new ROOT page (renderPage): reload the sidebar so the
        // draft appears, then land the user on it (doc-only).
        const newPageId = typeof payload.pageId === "string" ? payload.pageId : undefined;
        if (newPageId && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("doc:draft-created", {
              detail: { viewId: newPageId, action: "created" },
            }),
          );
          if (isDocOrigin && newPageId !== activeViewIdRef.current) {
            router.replace(docPagePath(workspaceId, newPageId), { scroll: false });
          }
        }
        break;
      }
      case "comment_posted":
      case "comment_resolved": {
        // The editor owns thread state; we just signal "something changed".
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent(DOC_COMMENTS_CHANGED_EVENT, {
              detail: {
                threadId: typeof payload.threadId === "string" ? payload.threadId : undefined,
              },
            }),
          );
        }
        break;
      }
      case "doc_title_update": {
        // Auto-title or an explicit `setTitle`/`setIcon`: bridge to the
        // shell (which owns `activeView` + the sidebar) via a window event.
        const pageId = typeof payload.pageId === "string" ? payload.pageId : "";
        const title = typeof payload.title === "string" ? payload.title : "";
        const icon = typeof payload.icon === "string" ? payload.icon : null;
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
        // `refineActiveTheme` rebuilt the active custom theme: bridge the
        // new tokens (and light/dark intent) to CustomThemesProvider.
        const themeId = typeof payload.themeId === "string" ? payload.themeId : "";
        const tokens =
          payload.tokens && typeof payload.tokens === "object"
            ? (payload.tokens as { light?: unknown; dark?: unknown })
            : null;
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
      // Intentionally unhandled: `title_update` (no session titles here),
      // `mention_unreachable` (rooms only).
    }
  };

  // Every validated frame of this dock's turns: the build-activity log, and
  // the thread binding the moment a provisional thread gets its session.
  frameObserverRef.current = (frame) => {
    if (!controller) return;
    observeDockBuildFrame(controller, frame, t.toolNarration);
    if (frame.stream === "direct" && frame.event === "session" && typeof frame.payload.sessionId === "string") {
      const adopted = frame.payload.sessionId;
      const clientId = thread.clientId;
      updateDockThread(threadKey, (current) =>
        current.clientId === clientId && !current.sessionId ? { sessionId: adopted } : null,
      );
    }
  };

  // ── Send ───────────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    (
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
        /** Staged recording ids handed in from the seeding surface. */
        attachedRecordingIds?: string[];
        /** Run THIS turn as this assistant (the landing's draft-assistant
         *  picker) — the seed effect switches `selectedAssistantId` in the
         *  same tick, but this closure still holds the old value, so the
         *  override is what makes the build turn run on the picked assistant. */
        assistantId?: string;
      },
    ): Promise<boolean> => {
      // Guard block — each early-return reports `false` so callers (the seed
      // effect, the recorder's voice clip) know the send didn't start.
      const trimmed = text.trim();
      const seededFileIds = override?.fileIds ?? [];
      const turnRecordingIds =
        override?.attachedRecordingIds ??
        pendingRecordings.map((recording) => recording.recordingId);
      if (
        !trimmed &&
        !att.hasReady &&
        seededFileIds.length === 0 &&
        turnRecordingIds.length === 0
      ) return Promise.resolve(false);
      if (!controller) return Promise.resolve(false);
      if (att.uploading) return Promise.resolve(false);
      if (rec.busy) return Promise.resolve(false);
      // Suspended on a question — the answer flows through the inline
      // panel (POST /answer), never a fresh chat turn. Guards the Retry
      // path too, which calls sendMessage directly past the disabled composer.
      if (pendingQuestion) return Promise.resolve(false);
      const before = controller.getSnapshot();
      if (before.transcript.isStreaming || ACTIVE_RUN_PHASES.has(before.run.phase)) return Promise.resolve(false);

      // Snapshot the ready attachment ids for this turn. A seed (the
      // landing's build flow) hands its own ids in — those win, and this
      // chat's own tray stays as it is.
      const usesComposerTray = seededFileIds.length === 0;
      const turnFileIds = usesComposerTray ? att.fileIds() : seededFileIds;
      // The sent bubble shows the user's own images/files immediately. Reuse
      // each chip's preview object URL as the thumbnail; `att.detach()`
      // (on acceptance) clears the tray WITHOUT revoking these, transferring
      // URL ownership to the message.
      const userAttachments: MessageAttachmentRef[] = usesComposerTray
        ? readyAttachments(att.attachments).map((a) => ({
            id: a.fileId!,
            name: a.fileName,
            mime: a.mimeType,
            ...(a.previewUrl ? { dataUrl: a.previewUrl } : {}),
          }))
        : [];

      // The landing's picker overrides the chat's current tier for the
      // build turn; otherwise the chat's own selection is used. An armed
      // metered pick (confirmed at selection time) wins over the tier —
      // unless this turn runs research mode, which forces its own model.
      const researchOn = override?.researchMode ?? researchMode;
      const useCustom = !!customEndpoint && !override?.model && !researchOn;
      const useMetered = !!metered && !override?.model && !researchOn;
      // The custom theme the user currently has applied (a per-user
      // localStorage value), so "make my theme warmer" works in chat. Only
      // sent on a custom palette, and only from the doc dock.
      const themeId =
        isDocOrigin &&
        typeof window !== "undefined" &&
        window.localStorage.getItem("doc:palette") === "custom"
          ? window.localStorage.getItem("doc:customThemeId")
          : null;
      // Anchors the turn to a doc page: an explicit override (the landing's
      // pre-created draft) wins over the path-derived id; absent both, the
      // next message mints a new draft. Doc-only.
      const docViewId = isDocOrigin ? override?.docViewId ?? activeViewIdRef.current : null;
      // One-shot "Space for AI" insertion anchor (doc-only).
      const anchorBlockId = isDocOrigin ? override?.docAnchorBlockId : undefined;
      const bodyExtras: ConversationBodyExtras = {
        // Stamps newly-created sessions with the surface they came from, so
        // threads + Recents scope per-surface (migrations 187/255).
        appOrigin: origin,
        model: useCustom
          ? customEndpoint!.selector
          : useMetered
            ? metered!.alias
            : override?.model ?? model,
        ...(useMetered
          ? {
              meteredAccepted: true,
              ...(metered!.profileId
                ? { meteredProfileId: metered!.profileId }
                : { meteredToolRounds: metered!.toolRounds }),
            }
          : {}),
        // Deep-research mode → coordinator + max-tier + higher ceiling,
        // gated server-side by the workspace's free-research quota.
        ...(researchOn ? { mode: "research" as const } : {}),
        ...(docViewId ? { docViewId } : {}),
        ...(anchorBlockId ? { docAnchorBlockId: anchorBlockId } : {}),
        // The Brain skill editor route: the viewed skill rides the context.
        ...(viewingSkillRowIdRef.current
          ? { viewingSkillRowId: viewingSkillRowIdRef.current }
          : {}),
        ...(viewingBrainEntryRef.current
          ? { viewingBrainEntry: { ...viewingBrainEntryRef.current } }
          : {}),
        ...(themeId ? { docActiveThemeId: themeId } : {}),
        ...(CLIENT_TIMEZONE ? { timezone: CLIENT_TIMEZONE } : {}),
      };
      const composerText = text;
      const turn: ConversationSendInput = {
        presentationId,
        text: trimmed,
        fileIds: turnFileIds,
        recordingIds: turnRecordingIds,
        bodyExtras,
        // Who answers THIS turn — the seed's addressed pick wins over the
        // switcher's selection. The controller stamps it on the reply as
        // `senderAssistantId` so a mixed-voice thread renders each avatar.
        assistantId: override?.assistantId ?? selectedAssistantId,
        ...(userAttachments.length > 0 ? { userMessage: { userAttachments } } : {}),
        // Accepted (`session` / `user_message_saved`): the staged chips now
        // belong to the sent message.
        onAccepted: () => {
          if (usesComposerTray) att.detach();
        },
        // Failed before acceptance: hand the text back; the chips were never
        // detached. Nothing is re-sent automatically.
        onRejected: () => {
          setInput((current) => (current.trim() ? current : composerText));
        },
      };
      const pending = override?.truncateFromMessageId
        ? controller.edit({ ...turn, messageId: override.truncateFromMessageId })
        : controller.send(turn);
      // The controller begins a turn synchronously when it accepts the
      // start; a refused start (busy, empty, invalid) leaves the run
      // generation unchanged.
      const started = controller.getSnapshot().identity.generation !== before.identity.generation;
      if (!started) return Promise.resolve(false);
      setInput("");
      setPendingRecordings([]);
      setLocalError(null);
      void pending.then((result) => {
        // Deferred research (surface seeds): the clarifying first turn is
        // done — arm research for the answer turn.
        if (result === "completed" && deferResearchRef.current) {
          deferResearchRef.current = false;
          setResearchMode(true);
        }
      });
      return Promise.resolve(true);
    },
    [controller, presentationId, selectedAssistantId, origin, isDocOrigin, model, metered, customEndpoint, researchMode, pendingQuestion, pendingRecordings, rec.busy, att, setInput],
  );

  // Surface auto-send is intentionally a two-effect handoff: the event
  // listener above first resets the thread and records the seed, then this
  // effect runs on the settled render where `sendMessage` sees the fresh
  // session ref. A failed start (for example, a suspended question) leaves the
  // seed pending and retries when the chat state changes. The ref prevents a
  // render during one async attempt from dispatching the same turn twice.
  useEffect(() => {
    const seed = pendingSurfaceSeed;
    if (!seed?.autoSend || surfaceSeedAttemptRef.current === seed) return;
    surfaceSeedAttemptRef.current = seed;
    void sendMessage(seed.prefill, {
      researchMode: !!seed.researchMode,
    }).then((started) => {
      surfaceSeedAttemptRef.current = null;
      if (!started) return;
      setPendingSurfaceSeed((current) => (current === seed ? null : current));
    });
  }, [pendingSurfaceSeed, sendMessage]);

  /**
   * Hand a message to the turn that is already running (mid-turn input), and
   * clear the composer as an ordinary send would. The controller owns the
   * queue: it posts the side request, moves a taken input into the thread,
   * and sends whatever the turn never took as one ordinary turn at its end.
   * See docs/architecture/engine/mid-turn-input.md.
   */
  const queueMessage = useCallback(
    (text: string, steer: boolean): boolean => {
      if (!controller) return false;
      const queued = controller.queue(text, steer, {
        bodyExtras: {
          appOrigin: origin,
          ...(CLIENT_TIMEZONE ? { timezone: CLIENT_TIMEZONE } : {}),
        },
        assistantId: selectedAssistantId,
      });
      if (!queued) return false;
      setInput("");
      setLocalError(null);
      return true;
    },
    [controller, origin, selectedAssistantId, setInput],
  );

  // ── Dock live recording (docs/architecture/media/live-capture.md) ──────
  // ONE recorder instance serves both render sites (the collapsed launcher
  // row and the expanded composer), so a capture started collapsed keeps
  // running when the panel opens. The stop fork lands on the same two lanes
  // a dropped file takes: short → voice-clip auto-send on THIS chat; long →
  // the recording ingestion flow (the full cost + blueprint +
  // destination confirm), stamped kind='meeting' — a recorder-originated
  // long capture is a meeting, and kind routes the transcriber ladder.
  const interactionT = useT().liveInteraction;
  const liveRecording = useLiveRecordingPage(workspaceId, activeAssistantId);
  // Capture saves have their own serial lane. Never gate chat/attachments on
  // this uploader's busy state: the recorder reports its background progress.
  const captureUpload = useRecordingUpload(workspaceId, activeAssistantId);
  const recorder = useDockRecorder({
    enabled: !!workspaceId && !!activeAssistantId,
    workspaceId,
    assistantId: activeAssistantId,
    captureNamePrefix: tRecorder.captureName,
    saveProgress: {
      status: captureUpload.status,
      uploadProgress: captureUpload.uploadProgress,
      message: captureUpload.message,
    },
    ensureInteractionSession: () => ensureDockRecorderInteractionSession(async () => {
      const existing = sessionIdRef.current;
      if (existing) return existing;
      const key = threadKeyRef.current;
      const { epoch } = readDockThread(key);
      const response = await authFetch(`${API_URL}/api/sessions/personal`, {
            signal: AbortSignal.timeout(5_000),
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, assistantId: activeAssistantId, channelId: crypto.randomUUID() }),
      });
      if (!response.ok) throw new Error("Could not create interaction chat");
      const { session: created } = await response.json();
      // A concurrent typed send or navigation wins. Never replace its binding.
      if (readDockThread(key).epoch !== epoch) throw new Error("Chat changed");
      if (sessionIdRef.current) return sessionIdRef.current;
      // Bind the shared thread: every dock instance moves to the new session.
      updateDockThread(key, { sessionId: created.id });
      sessionIdRef.current = created.id;
      return created.id;
    }),
    getSessionId: () =>
      getDockRecorderSessionId(() => sessionIdRef.current ?? undefined),
    sendVoiceClip: (fileId: string) =>
      sendDockRecorderVoiceClip(
        fileId,
        (fallbackFileId) => sendMessage("", { fileIds: [fallbackFileId] }),
      ),
    prepareLivePage: liveRecording.prepare,
    prepareCaptureSource: (initialSource) => pickCaptureSource(initialSource, tRecorder),
    streamLiveWindow: liveRecording.streamWindow,
    onMeetingCapture: async (file: File, live?: { pageId?: string; sessionId?: string; liveWindowsDone?: Promise<void>; recoveryId?: string; assistantId?: string }) => {
      const outcome = await captureUpload.run(file, {
        kind: "meeting",
        automatic: true,
        recoveryId: live?.recoveryId,
        assistantId: live?.assistantId,
        ...(live ? { existingPageId: live.pageId } : {}),
        ...(live?.sessionId ? { liveSessionId: live.sessionId } : {}),
        ...(live?.liveWindowsDone ? { liveWindowsDone: live.liveWindowsDone } : {}),
      });
      // The recorder's own notice reports this outcome (queued / kept /
      // step-aware failure) on BOTH render sites, collapsed included — the
      // upload hook's inline line below the composer only ever shows
      // expanded, so it would either be invisible or say it twice.
      captureUpload.dismiss();
      return outcome.outcome === "queued"
        ? {
            outcome: "queued",
            recordingId: outcome.recording.recordingId,
            message: outcome.message,
          }
        : outcome;
    },
  });

  // Feed replaces this dock's CHAT chrome, not its universal recorder. Publish
  // the one persistent controller so the replacement dock can render the same
  // button/strip without mounting a second capture engine that would reset on
  // navigation.
  useLayoutEffect(() => {
    // The mobile drawer mounts another FloatingChat in side-panel mode. It
    // consumes the recorder UI but must never replace the persistent desktop
    // controller published by this floating instance.
    if (isSidePanel) return;
    return publishDockRecorderController(recorder);
  }, [isSidePanel, recorder]);

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
      // The landing's draft-assistant pick: a per-turn RE-ADDRESS, not a
      // thread reset — the doc thread is per-turn addressable (chat-app.md →
      // "Choosing an assistant" → the doc-dock bullet), so the build turn
      // simply runs as the picked assistant inside the same conversation.
      // Update + persist the selection so follow-ups stay with the pick, and
      // pass it as a send override since `selectedAssistantId` in this
      // closure is still the old value. On a retry render (send returned
      // false) the ids already match and this block no-ops.
      const seedAssistantId =
        seedRequest.assistantId &&
        seedRequest.assistantId !== selectedAssistantId
          ? seedRequest.assistantId
          : undefined;
      if (seedAssistantId) {
        writeActiveAssistantId(workspaceId, seedAssistantId);
        setSelectedAssistantId(seedAssistantId);
      }
      void sendMessage(seedRequest.prefill, {
        ...(seedAssistantId ? { assistantId: seedAssistantId } : {}),
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
        ...(seedRequest.attachedRecordingIds && seedRequest.attachedRecordingIds.length > 0
          ? { attachedRecordingIds: seedRequest.attachedRecordingIds }
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
  }, [seedRequest, sendMessage, selectedAssistantId, workspaceId]);

  // ── Retry / Copy / Confirmation handlers ───────────────────────────────

  const handleRetry = useCallback(
    (assistantMessageId: string) => {
      if (isStreaming) return;
      const messages = transcript.messages;
      const idx = messages.findIndex((m) => m.id === assistantMessageId);
      if (idx <= 0) return;
      const precedingUser = messages[idx - 1];
      if (precedingUser.role !== "user") return;
      // The controller drops the preceding user message and everything
      // after from the thread; the server truncates from its id and
      // rebuilds from there.
      void sendMessage(precedingUser.text, {
        truncateFromMessageId: precedingUser.id,
      });
    },
    [isStreaming, transcript.messages, sendMessage],
  );

  // Retry from the user's own message: re-send the same text and let the
  // server truncate from this message id (dropping it + everything after,
  // including the assistant turn it produced) before rebuilding. Mirrors
  // `handleRetry` but anchors on the user row itself.
  const handleRetryFromUser = useCallback(
    (userMessageId: string) => {
      if (isStreaming) return;
      const userMsg = transcript.messages.find((m) => m.id === userMessageId);
      if (!userMsg || userMsg.role !== "user") return;
      void sendMessage(userMsg.text, {
        truncateFromMessageId: userMessageId,
      });
    },
    [isStreaming, transcript.messages, sendMessage],
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

  // One Stop for every dock instance: the controller's compare-and-set Stop
  // waits for the turn's public owner, keeps reading the stream while the
  // request is pending, aborts locally only once the server confirms, and
  // then sends whatever was queued as one ordinary turn (the queued text is
  // why the user reached for Stop in the first place). A failed Stop leaves
  // the turn running and shows `stopTurnFailed`.
  const handleAbort = useCallback(() => {
    void controller?.stop();
  }, [controller]);

  // One approval path: a live card answers `/api/chat/confirm`, a restored
  // card its approval row; a 403 shows `confirmNotAllowed` and the card
  // stays retryable.
  const handleConfirmation = useCallback(
    async (
      toolCallId: string,
      action: "approve" | "deny",
      comment?: string,
    ) => {
      if (!controller) return;
      const outcome = await controller.respondConfirmation(toolCallId, action, comment);
      // Same-tab repair for every approval-backed surface (queue + Home
      // dock): the click's own tab should not wait for the workspace event.
      if (outcome === "resolved") requestApprovalsRefresh(workspaceId);
    },
    [controller, workspaceId],
  );

  // The panel performed the answer/cancel POST. The controller resolves the
  // question and follows the resumed turn over the session stream within the
  // bounded resume window (askquestion-suspend-resume.md → "Resume attach
  // and poll retirement"); the indicator shows until that turn paints or
  // history is re-read.
  const handleQuestionSettled = useCallback(
    (approvalId: string) => {
      if (!controller) return;
      const epochAtSettle = controller.getSnapshot().historyEpoch;
      if (!controller.questionSettled(approvalId)) return;
      updateDockThread(threadKeyRef.current, {
        awaitingResumeUntil: Date.now() + RESUME_ATTACH_WINDOW_MS + RESUME_WAIT_GRACE_MS,
        awaitingResumeEpoch: epochAtSettle,
      });
    },
    [controller],
  );

  // ── Doc deep-link ────────────────────────────────────────────────────
  const handleOpenInDoc = useCallback(
    (viewId: string) => {
      router.replace(docPagePath(workspaceId, viewId));
      setExpanded(false);
    },
    [router, workspaceId],
  );

  const messages = transcript.messages as MessageWithViews[];
  // Doc-dock per-turn re-address: a mid-thread switch keeps the transcript,
  // so name who the NEXT reply comes from (doc.md → "Next-reply hint").
  // Hidden while streaming: queued input rides the running turn's voice.
  const nextReplyVoiceId =
    isDocOrigin && !isStreaming
      ? nextReplyVoiceHint(messages, selectedAssistantId)
      : null;
  const showEmpty = messages.length === 0 && !isStreaming;
  // The streaming avatar is the assistant the live turn answers as (a
  // seeded pick, a re-addressed doc turn, a re-attached mirror).
  const liveVoice =
    (liveAssistantId
      ? workspaceAssistants.find((a) => a.id === liveAssistantId)
      : undefined) ?? activeAssistant;
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

  // Idle copy stays generic: the dock can answer, research, create, and edit;
  // page or surface context is carried by the target chip instead of implying
  // that every prompt must request a view.
  const idlePlaceholder = showPageTarget ? t.placeholder : t.surfacePlaceholder;

  // Pill activity label — mirrors apps/web's collapsed-pill behaviour
  // (running tool description, else streaming preview, else "Thinking…").
  const isActive = activity.isStreaming;
  const activeLabel = isActive
    ? activity.activeTool?.description ??
      collapseToOneLine(activity.streamingText) ??
      t.thinking
    : null;
  const uploadProgressPercent = Math.round(
    Math.min(1, Math.max(0, rec.uploadProgress)) * 100,
  );
  const uploadProgressLabel = tRec.uploadingProgress.replace(
    "{percent}",
    String(uploadProgressPercent),
  );

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
        aria-busy={rec.status === "uploading"}
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
                "max-w-[calc(var(--native-app-width,100vw)-2rem)] max-h-[92dvh]",
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
                className="absolute left-1 top-1 size-1.5 rounded-tl-sm border-l-2 border-t-2 border-muted-foreground/30 transition-colors group-hover/resize:border-interaction/50"
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
                  className="w-60 max-w-[calc(var(--native-app-width,100vw)-2rem)] gap-0.5 p-1"
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
              onClick={dismissNotice}
              aria-label={t.noticeDismiss}
              className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded text-amber-700/70 dark:text-amber-300/70 hover:bg-amber-500/15"
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        ) : null}

        <ChatRetainedHistoryNotice sessionId={sessionId} onExpire={() => controller?.loadMessages([])} />
        {/* Messages */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5"
        >
          {recorder.interactionChatSessionId && recorder.interactionChatSessionId === sessionId && recorder.interactionStatus !== "idle" && (
            <div className="space-y-2 rounded-lg bg-muted/40 p-3">
              <p role={recorder.interactionStatus === "gap" ? "alert" : "status"} className="text-sm">
                {recorder.interactionStatus === "unavailable" ? interactionT.personalOnly : recorder.interactionStatus === "gap" ? interactionT.error : interactionT.listening}
              </p>
              {recorder.interactionCaptureId && <LiveInteractionQuestionControls key={recorder.interactionCaptureId} captureId={recorder.interactionCaptureId} />}
              <button type="button" className="min-h-8 max-sm:min-h-11 text-sm underline" onClick={() => recorder.setInteractionEnabled(false)}>{interactionT.stop}</button>
            </div>
          )}
          <LiveInteractionJobs
            recordingSessionId={recorder.interactionCaptureId ? recorder.interactionChatSessionId : null}
            recordingCaptureId={recorder.interactionCaptureId}
            workspaceId={workspaceId}
            sessionId={sessionId}
            messageIds={new Set(messages.map((message) => message.id))}
            onCanonical={(sid, rows, ids) => {
              if (sessionIdRef.current !== sid || !controller) return;
              // Refresh ONLY canonical voice-job rows. Never reload or replace
              // the typed turn, optimistic user message, or streaming buffer.
              for (const message of canonicalInteractionAdditions(transcript.messages, mapSessionRows(rows, t.toolNarration, false), ids)) {
                controller.appendMessage(message);
              }
            }}
          />
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
                  {showPageTarget ? t.emptyDesc : t.surfaceEmptyDesc}
                </p>
              </div>
            </div>
          ) : null}

          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              // Per-reply voice: a mixed-voice doc thread resolves each
              // assistant row's avatar from its `senderAssistantId` stamp;
              // unstamped rows (humans, pre-390 history) fall back to the
              // active assistant.
              assistant={
                (msg.senderAssistantId
                  ? workspaceAssistants.find(
                      (a) => a.id === msg.senderAssistantId,
                    )
                  : undefined) ?? activeAssistant
              }
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

          {/* Live tool timeline + streaming text: this dock's own turn, or the
              controller's mirror of a re-attached one. */}
          {isStreaming ? (
            <div className="flex gap-2.5">
              {liveVoice ? (
                <div className="mt-0.5 shrink-0">
                  <AssistantAvatar
                    id={liveVoice.id}
                    name={liveVoice.name}
                    iconSeed={liveVoice.iconSeed ?? undefined}
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
                  replyPhase={replyPhase}
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
                    {replyPhase === "generating" && (
                      <span
                        aria-hidden
                        className="ml-0.5 inline-block h-[16px] w-[2px] align-text-bottom rounded-full bg-foreground animate-pulse"
                      />
                    )}
                  </div>
                ) : null}
                {citations.length > 0 ? (
                  <ChatCitationList citations={citations} label={t.citationLabel} />
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Messages handed to the running turn, not yet taken by it.
              See docs/architecture/engine/mid-turn-input.md. */}
          <QueuedInputs
            inputs={conversation?.queued ? [...conversation.queued] : []}
            dict={t.queue}
            onSteer={(inputId) => void controller?.steer(inputId)}
          />

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
            <ChatConfirmationCard
              key={conf.toolCallId}
              confirmation={conf}
              approveLabel={t.confirmationApprove}
              denyLabel={t.confirmationDeny}
              approvingLabel={t.confirmationApproving}
              onApprove={(id) => void handleConfirmation(id, "approve")}
              onDeny={(id, comment) =>
                void handleConfirmation(id, "deny", comment)
              }
            />
          ))}

          {/* askQuestion suspend-resume — inline answer surface. Renders
              when the engine emits awaiting_approval for askQuestion, when
              a new message is rejected with pending_question_exists, or
              when GET /pending on reload finds a suspended row. */}
          {pendingQuestion &&
          (!sessionId ||
            sessionId === pendingQuestion.sessionId) ? (
            <PendingQuestionPanel
              sessionId={pendingQuestion.sessionId}
              approvalId={pendingQuestion.approvalId}
              dict={t.pendingQuestion}
              onAnswered={() => handleQuestionSettled(pendingQuestion.approvalId)}
              onCancelled={() => handleQuestionSettled(pendingQuestion.approvalId)}
            />
          ) : null}

          {/* Resume-in-flight indicator while the continuation turn of an
              answered question is awaited, and the "working" state while the
              dock re-attaches to a turn that has not painted yet. */}
          {awaitingResume || (reconnecting && !streamingText) ? (
            <ResumingIndicator label={t.pendingQuestion.resuming} />
          ) : null}

          {error ? (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        {/* Composer */}
        <div
          ref={slashContainerRef}
          className="relative shrink-0 border-t border-border bg-card/40 px-3 py-2.5"
        >
          {/* Slash-command menu — offers invocable skills while the draft is a
              half-typed `/command`; the server seam resolves the real thing. */}
          <SlashCommandMenuList
            commands={slashCommands}
            className="bottom-full left-3 mb-1"
          />
          {/* Live-browser chip — a persistent window into the assistant's
              cloud browser (watch / take over), probed off the task API so it
              never depends on the model relaying a link. */}
          <ComputerLiveChip
            workspaceId={workspaceId}
            sessionId={sessionId}
            browserToolSeen={browserToolSeen}
          />
          {/* Soft double-text guard — warns when another member already has the
              assistant working on this page (presence over Yjs awareness). */}
          {othersRun ? (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-primary/5 px-2.5 py-1.5 text-[11px] text-foreground">
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
          {nextReplyVoiceId && activeAssistant ? (
            <div
              className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              <AssistantAvatar
                id={activeAssistant.id}
                name={activeAssistant.name}
                iconSeed={activeAssistant.iconSeed ?? undefined}
                size="xs"
              />
              <span className="min-w-0 truncate">
                {format(t.nextReplyFrom, { name: activeAssistant.name })}
              </span>
            </div>
          ) : null}
          {/* Context chip — names the page this chat will edit, or signals
              that the next message mints a new draft. */}
          {isDocOrigin ? (
            showPageTarget ? <ChatTargetIndicator target={chatTarget} dict={t.target} /> : null
          ) : (
            <SurfaceContextChip surface={origin} dict={t.surfaceTarget} />
          )}
      {draftStorageFailed && <p role="status" className="text-xs text-muted-foreground">{draftWarning}</p>}
          <ChatComposer
            value={input}
            onChange={setInput}
            onKeyDown={slashCommands.handleKeyDown}
            highlightRanges={slashCommands.highlightRanges}
            inputWrapClassName="flex-1 min-w-0 max-md:min-w-[10rem] rounded-md border border-border bg-background focus-within:border-ring [&_:focus-visible]:shadow-none"
            focusRequest={messageBrianRequest}
            // While a turn streams, Send QUEUES: the message is handed to the
            // running turn, which takes it at its next safe boundary.
            // Cmd/Ctrl+Enter steers instead — take it as soon as possible.
            // See docs/architecture/engine/mid-turn-input.md.
            onSend={() =>
              isStreaming ? queueMessage(input, false) : void sendMessage(input)
            }
            onSteer={
              isStreaming ? () => void queueMessage(input, true) : undefined
            }
            // Hard-disable only for states where composing makes no sense
            // (suspended on a clarifying question, offline).
            disabled={!!pendingQuestion}
            // Mid-turn sends are text-only: an attachment needs the full
            // pre-turn pipeline (cache read, PDF distillation, transcription),
            // which belongs to a turn of its own. Staged chips stay visible
            // and ride the next turn.
            sendDisabled={
              rec.busy ||
              (isStreaming && (att.hasReady || pendingRecordings.length > 0))
            }
            allowEmptySend={att.hasReady || pendingRecordings.length > 0}
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
            sendLabel={isStreaming && replyPhase === "generating" ? t.queue.send : t.send}
            slotAttachments={
              <>
                {acceptedGoal?.sessionId === sessionId ? (
                  <GoalAcknowledgement
                    notice={acceptedGoal}
                    workspaceId={workspaceId}
                    labels={{
                      accepted: tChatApp.goalAcceptedLabel,
                      executing: tChatApp.goalAcceptedStatus,
                      done: tChatApp.goalAcceptedDone,
                      blocked: tChatApp.goalAcceptedBlocked,
                      abandoned: tChatApp.goalAcceptedAbandoned,
                      open: tChatApp.goalAcceptedOpen,
                      dismiss: tChatApp.goalAcceptedDismiss,
                    }}
                    onDismiss={() => setAcceptedGoal(null)}
                    className="mb-1.5"
                  />
                ) : null}
                <SlashCommandIndicator
                  commands={slashCommands}
                  className="mb-1.5"
                />
                {/* Live-recording chrome (expanded mode) — same shared
                    recorder instance as the collapsed pill. */}
                <DockRecorderRecovery rec={recorder} className="mb-1.5" />
                <DockRecorderNotice rec={recorder} className="mb-1.5" />
                <DockRecorderStrip rec={recorder} className="mb-1.5" />
                <AttachmentChips attachments={att.attachments} onRemove={att.remove} />
                {pendingRecordings.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {pendingRecordings.map((recording) => (
                      <span
                        key={recording.recordingId}
                        className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        <span aria-hidden>◉</span>
                        {tRec.chatStagedChip.replace("{name}", recording.title)}
                        <button
                          type="button"
                          onClick={() => setPendingRecordings((current) =>
                            current.filter((item) => item.recordingId !== recording.recordingId)
                          )}
                          aria-label={`${tAttach.remove} ${recording.title}`}
                          className="rounded p-0.5 hover:bg-muted"
                        >
                          <X className="size-3" aria-hidden />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <RecordingUploadStatus
                  status={rec.status}
                  uploadProgress={rec.uploadProgress}
                  message={rec.message}
                  className="space-y-2 px-1 py-2"
                />
              </>
            }
            slotPreInput={
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  disabled={rec.busy}
                  className="hidden"
                  onChange={(e) => {
                    if (!rec.busy && e.target.files) void att.upload(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  aria-label={tAttach.attach}
                  onClick={() => fileInputRef.current?.click()}
                  // Staging an attachment mid-stream is fine — it rides the
                  // NEXT send, same as pre-typed text.
                  disabled={!!pendingQuestion || rec.busy}
                  className={cn(
                    "shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-md",
                    "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    "disabled:opacity-50 disabled:pointer-events-none",
                  )}
                >
                  <Paperclip className="size-[18px]" aria-hidden />
                </button>
                <DockRecorderButton rec={recorder} disabled={!!pendingQuestion || rec.busy} />
              </>
            }
            // Send stays visible while streaming — it queues into the running
            // turn — and Stop sits beside it. The muted treatment marks the
            // difference: this send joins a turn rather than starting one.
            sendButtonClassName={cn(
              "shrink-0 rounded-md px-3 py-2 text-xs font-medium transition-colors",
              "disabled:opacity-50 disabled:pointer-events-none",
              isStreaming && replyPhase === "generating"
                ? "bg-muted text-foreground/80 hover:bg-muted/80"
                : "bg-action text-action-foreground hover:bg-action/90",
            )}
            slotPostInput={
              isStreaming && replyPhase === "generating" ? (
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
            // Wraps below `md` (responsive contract M8): while streaming the
            // attach, record, Send and Stop controls left the textarea
            // ~150px wide on a 390px sheet. The input wrap is `flex-1
            // min-w-0`, so it takes the first line and the buttons drop to a
            // second one only when they no longer fit beside it.
            rowClassName="flex flex-wrap items-end gap-2 md:flex-nowrap"
            // ChatComposer auto-grows the textarea to fit content; we just set
            // the cap. A roomier `max-h-[240px]` (~10 lines) lets a longer
            // prompt stay fully visible before the box starts scrolling — the
            // old 160px clipped multi-line asks too early.
            textareaClassName={cn(
              "w-full min-w-0 min-h-[36px] max-h-[240px] resize-none overflow-y-auto bg-transparent",
              "px-3 py-2 text-sm leading-relaxed outline-none",
              "placeholder:text-muted-foreground focus-visible:shadow-none",
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
              if (next) {
                setMetered(null);
                setCustomEndpoint(null);
              }
              setResearchMode(next);
            }}
            researchQuota={researchQuota}
            researchExhausted={researchExhausted}
            meteredOptions={meteredOptions}
            meteredSelectedKey={metered?.key ?? null}
            onMeteredSelect={handleMeteredSelect}
            customOptions={customOptions}
            customSelectedKey={customEndpoint?.key ?? null}
            onCustomSelect={(key) => {
              if (!key) { setCustomEndpoint(null); return; }
              const endpoint = modelMenu?.customEndpoints.find((item) => item.id === key);
              if (!endpoint) return;
              setResearchMode(false);
              setMetered(null);
              setCustomEndpoint({ key, selector: endpoint.selector, label: endpoint.name });
            }}
            className="mt-2"
          />
        </div>
      </div>

      {/* Live-recording chrome (collapsed mode) — the recovery banner, the
          first-use/error notice, and the active recorder strip stack ABOVE
          the launcher row. Keep chat reachable while capturing and saving;
          opening it reuses the same recorder and originating chat session. */}
      {!isSidePanel && !expanded ? (
        <>
          <DockRecorderRecovery rec={recorder} />
          <DockRecorderNotice rec={recorder} />
          <DockRecorderStrip rec={recorder} />
        </>
      ) : null}
      {/* Launcher — floating mode only. A compact pill: the doc assistant's
          small avatar (its creature icon) beside a short text nudge; fades +
          scales out when the panel expands. While a turn runs it tints to
          primary and the nudge mirrors the live tool / stream label. Falls back
          to a chat glyph until the identity resolves. Recording never hides
          the chat launcher: users can open the originating conversation to
          type or read answers without stopping capture or navigating away.
          The record button stays mounted through arming/holding so its live
          press gesture keeps its anchor. */}
      {!isSidePanel && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-hidden={expanded}
              aria-busy={rec.status === "uploading"}
              aria-label={
                rec.status === "uploading"
                  ? `${idlePlaceholder}. ${uploadProgressLabel}`
                  : undefined
              }
              aria-live={isActive ? "polite" : undefined}
              tabIndex={expanded ? -1 : 0}
              className={cn(
                "relative inline-flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 shadow-lg backdrop-blur",
                "max-w-[min(260px,calc(var(--native-app-width,100vw)-3rem))] text-left text-sm",
                "transition-[opacity,transform,background-color,box-shadow] duration-200 ease-out",
                isActive
                  ? "border border-primary/40 bg-primary/10 text-foreground ring-2 ring-primary/20"
                  : "border border-border bg-background/90 text-foreground/80 hover:bg-accent hover:text-foreground",
                expanded
                  ? "opacity-0 scale-95 pointer-events-none"
                  : "opacity-100 scale-100",
              )}
            >
              {rec.status === "uploading" ? (
                <span
                  aria-hidden
                  data-upload-progress-ring
                  className="pointer-events-none absolute -inset-[3px] rounded-full p-[2px]"
                  style={{
                    background: `conic-gradient(from -90deg, var(--primary) 0% ${uploadProgressPercent}%, transparent ${uploadProgressPercent}% 100%)`,
                    WebkitMask:
                      "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                    WebkitMaskComposite: "xor",
                    maskComposite: "exclude",
                    filter:
                      "drop-shadow(0 0 5px color-mix(in srgb, var(--primary) 38%, transparent))",
                  }}
                />
              ) : null}
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
            <DockRecorderButton
              rec={recorder}
              variant="floating"
              disabled={rec.busy}
              className={cn(
                "transition-[opacity,transform] duration-200 ease-out",
                expanded
                  ? "opacity-0 scale-95 pointer-events-none"
                  : "opacity-100 scale-100",
              )}
            />
          </div>
        )}
    </div>
  );
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

// PendingQuestionPanel moved to `pending-question-panel.tsx` so the Chat
// operator surface renders the same panel in a room transcript (multiplayer
// chat T11/D8). Imported above.

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
