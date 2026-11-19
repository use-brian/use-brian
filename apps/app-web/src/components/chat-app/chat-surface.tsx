"use client";
import { useDurableDraft } from "@/lib/offline/use-durable-draft";

import styles from "./chat-surface.module.css";
import { ChatRetainedHistoryNotice } from "./chat-retained-history-notice";
import { ConversationVisibilityControl } from "./conversation-visibility-control";
import { RoutineChatPickup } from "@/components/workflow/routine-intake";


import { useChatHandoff } from "@/lib/use-chat-handoff";
import { readChatDrafts, writeChatDrafts, type RecoverableChatDraft } from "@/lib/chat-draft-recovery";
import { LiveInteractionJobs, LiveInteractionQuestionControls } from "@/components/chrome/live-interaction-jobs";
import { canonicalInteractionAdditions } from "@/lib/live-interaction/canonical";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Chat operator app — the full-page, ChatGPT-style chat surface at
 * `/w/<workspaceId>/chat`, the 6th operator app under Home.
 *
 * NOT a fork of the floating dock (`components/chrome/floating-chat.tsx`).
 * That component is 3.9k lines because it carries page-surface affordances —
 * an open-page anchor, theme refinement, deck previews and floating-panel
 * lifecycle. Those do not belong to standalone Chat. Page authoring itself
 * DOES: the server injects ambient Page reads plus `delegateDocEdit`, with
 * workspace-room Page pins as the validated existing-page edit scope. The
 * client stays a single ordinary chat transport and renders the resulting Page
 * link in the transcript. Attachment pick/drop/paste, research, citations,
 * outbound files, retry/copy, and per-code-block copy reuse the dock's shared seams.
 * This surface is a presentation of the shared conversation controller
 * (`lib/chat/use-conversation.ts`, page profile: send, follow, reconnect,
 * Stop, approvals and the mid-turn queue, M5) over the `@use-brian/chat-ui`
 * primitives (`ChatComposer`, `ChatMarkdown`, the turn transcript), which is
 * exactly what that package exists for (chat-miniapp-home-config.md T4). The ambient dock stays mounted by the
 * persistent workspace chrome, but is hidden on this route: showing a second
 * chat launcher over the full-page composer duplicates the affordance and can
 * cover Send at narrower viewport sizes.
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
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChatComposer,
  ChatMarkdown,
  initialChatState,
  initialTurnTranscript,
  type ReplyTo,
  type ToolUsed,
} from "@use-brian/chat-ui";
import remarkGfm from "remark-gfm";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { navigateChatLocation } from "@/lib/chat-last-location";
import { ChatRecoveryAction } from "./chat-recovery";
import { ChatLegacyHistory } from "./chat-legacy-history";
import { ChatDisplayHistoryRow } from "./chat-display-history";
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Copy,
  Pencil,
  Plus,
  Reply,
  RotateCw,
  Route,
  Sparkles,
  Square,
  User,
  Users,
  X,
} from "lucide-react";
import { auditTurnUrl } from "@/lib/turn-audit";
import type {
  ConversationController,
  ConversationNotice,
  ConversationQuestion,
  ConversationSendResult,
  ConversationState,
  PresentationCapabilities,
} from "@/lib/chat/conversation-controller";
import { conversationRegistry, provisionalConversationKey } from "@/lib/chat/conversation-registry";
import { conversationAttachmentTray, moveConversationAttachments } from "@/lib/chat/conversation-attachments";
import type { ClassifiedTurnFrame } from "@/lib/chat/turn-frames";
import { useConversation } from "@/lib/chat/use-conversation";
import { currentOfflineWriteAuthority } from "@/lib/offline/application-write-authority";
import type { Dictionary } from "@/lib/i18n";
import { QueuedInputs } from "@/components/ui/queued-inputs";
import { ChatContextBar, useChatVisibleViewport } from "./chat-responsive-controls";
import { ChatAudienceMenu } from "./chat-audience-menu";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { ClientDeliveryOversight } from "./client-delivery-oversight";
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
} from "@/components/chrome/chat-activity";
import { ChatCodeBlock } from "@/components/chrome/chat-code-block";
import { ChatFileAttachments } from "@/components/chrome/chat-file-attachment";
import { RecordingUploadStatus } from "@/components/recordings/recording-upload-status";
import {
  DockRecorderButton,
  DockRecorderOptions,
  DockRecorderNotice,
  DockRecorderRecovery,
  DockRecorderStrip,
} from "@/components/chrome/dock-recorder";
import {
  registerDockRecorderChatTarget,
  useGlobalDockRecorder,
} from "@/lib/recorder/dock-recorder-bridge";
import { claimFloatingRecorder } from "@/lib/recorder/floating-recorder-slot";
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
import {
  collectToolResults,
  restoreAssistantActivity,
} from "@/lib/activity-receipt";
import { authFetch } from "@/lib/auth-fetch";
import { beginChatSendFeedback } from "@/lib/chat-send-feedback";
import { createChatStreamObserver } from "@/lib/chat-stream-observation";
import { useT, useLocale, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/skeleton";
import { listWorkspaceAssistants, type WorkspaceAssistantSummary } from "@/lib/api/views";
import {
  patchSharedChatSessions,
  promoteChatSession,
  cacheCreatedChatSession,
  readCachedTranscript,
  fetchChatTranscript,
  evictTranscriptCache,
  isAuthoritativeRosterDenial,
  useChatSessionsData,
  useCurrentChatSummary,
  writeTranscriptCache,
} from "@/lib/chat-surface-data";
import {
  dispatchChatSessionActivity,
  dispatchChatSessionsRefresh,
} from "@/lib/chat-session-events";
import {
  createWorkspaceSession,
  rebindWorkspaceSessionAssistant,
  extractMessageText,
  extractPresentedDocuments,
  isSessionHistoryUnavailable,
  parseMessageAttachments,
  parsePresentedDocumentPayload,
  postRoomMessage,
  editRoomMessage,
  fetchMentionableRoster,
  postSessionTyping,
  getChatSessionSummary,
  type ChatSessionSummary,
  type MessageAttachmentRef,
  type DocSession,
  type DocSessionMessage,
  type WorkspaceSession,
  type UnreachableMention,
} from "@/lib/api/sessions";
import { getUserInfo } from "@/lib/user";
import { markRoomSeen } from "@/lib/chat-seen";
import {
  askAffordanceVisible,
  effectiveHumanCount,
  FRESH_PANE_POLICY,
  isAddressedSend,
  midTurnPath,
  PENDING_POLICY,
  typingPresenceActive,
  type ChatSessionPolicy,
} from "@/lib/chat-session-policy";
import {useCreationContext} from "@/components/context/mode-aware-context";
import { ContextScopeChips } from "@/components/context/context-scope-chips";
import {
  listContextProjects,
  listContextTeams,
  type ContextProject,
  type ContextTeam,
} from "@/lib/api/context-scopes";
import {
  readChatLocation,
  seedChatLocation,
  writeChatLocation,
  type ChatLocation,
  type ChatView,
} from "@/lib/chat-last-location";
import { personalChatHandoffPath } from "@/lib/chat-handoff";
import { accelEnterLabel } from "@/lib/surface-shortcuts";
import type { ExternalActionConfirmation as ExternalRequest } from "@/lib/api/pending-questions";
import { APPROVALS_REFRESH_EVENT, requestApprovalsRefresh, type ApprovalsRefreshDetail } from "@/lib/approvals-events";
import { PendingQuestionPanel } from "@/components/chrome/pending-question-panel";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import { ExternalActionConfirmation } from "@/components/chrome/external-action-confirmation";
import { ChatContextPins } from "@/components/chat-app/chat-context-pins";
import { ChatSidePane, ChatSidePaneToggle } from "@/components/chat-app/chat-side-pane";
import { ChatPaneLink, PaneLinkProvider } from "@/components/chat-app/chat-link-routing";
import {
  adoptFreshChatPane,
  resetFreshChatPane,
  updateChatPane,
  useChatPane,
} from "@/lib/chat-pane-session";
import { openInPane, refreshPaneRef, type OpenOptions, type PaneRef } from "@/lib/chat-pane-tabs";
import { useChatPanePins } from "@/lib/use-chat-pane-pins";
import {
  desktopBrowserPane,
  isBrowserToolName,
  reportTurnChat,
  subscribeBrowserPane,
} from "@/lib/desktop-browser-pane";
import { getComputerTask } from "@/lib/api/computer";
import { resolveRequestedFreshAssistant } from "@/components/chat-app/assistant-deeplink";
import {
  isAssistantPickerLive,
  partitionRoomMentions,
  resolveWorkBenchAssistant,
  type RoomMentionTarget,
} from "@/components/chat-app/multi-assistant-response";
import {
  MentionAutocompleteList,
  useAssistantMentions,
} from "@/components/chat-app/mention-autocomplete";
import {
  isSlashCommandShaped,
  sentSlashCommandOf,
  SlashCommandIndicator,
  SlashCommandMenuList,
  useSlashCommands,
} from "@/components/chat-app/slash-command-autocomplete";
import {
  GoalAcknowledgement,
  goalAcceptedNoticeFromPayload,
  type GoalAcceptedNotice,
} from "@/components/chat-app/goal-acknowledgement";
import {
  GoalPursuitCard,
  GoalPursuitSticky,
  interleaveSessionGoals,
} from "@/components/chat-app/goal-pursuit";
import { listGoals, type GoalRow as SessionGoalRow } from "@/lib/api/goals";
import {
  canEditUserMessage,
  resolveEditDispatch,
} from "@/components/chat-app/message-edit";
import {
  buildReplyTarget,
  canReplyToMessage,
  condenseQuote,
  selectionTextWithin,
} from "@/components/chat-app/message-reply";
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
import {
  useRecordingUpload,
  type StagedRecording,
} from "@/lib/recordings/use-recording-upload";
import {
  ChatDocumentCard,
} from "@/components/chat-app/chat-document-viewer";
import { ChatPageLinkCard } from "@/components/chat-app/chat-page-link-card";
import { announceResearchChanged, ChatResearchCard, useSessionResearch } from "@/components/chat-app/research-detail";
import { ApprovalReviewAttention } from "@/components/chat-app/approval-review-attention";
import {
  PAGE_WRITING_TOOLS,
  collectPageWrites,
  pageIdsFromToolResult,
  pageLinksForRow,
} from "@/lib/chat-page-links";
import { docPagePath } from "@/lib/doc-page-url";
import {
  coalesceAssistantRunMessages,
  computeTranscriptRowMeta,
  formatTranscriptDayLabel,
  formatTranscriptTime,
  type ChatSurfaceMessage as SurfaceMessage,
} from "@/components/chat-app/chat-transcript";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";
const REMARK_PLUGINS = [remarkGfm];
// Links in a reply open in the side pane, never away from the chat (D9).
const CHAT_MARKDOWN_COMPONENTS = { pre: ChatCodeBlock, a: ChatPaneLink };
/** Stable empties for the cold-cache case, so memoised derivations keyed on
 *  the lists do not recompute every render. */
const EMPTY_PERSONAL: DocSession[] = [];
const EMPTY_SHARED: WorkspaceSession[] = [];

/** The surface tag stamped on sessions minted here (migration 255). */
const APP_ORIGIN = "chat";

/** Re-send the `true` typing beacon at this cadence while composing — well
 *  inside the bus's 12s decay window, so a live typist never flickers off. */
const TYPING_BEACON_REFRESH_MS = 4_000;

/** No draft change for this long reads as "stopped typing". */
const TYPING_IDLE_OFF_MS = 5_000;

/** Full-page reading scale; compact docks retain their own denser typography. */
const MARKDOWN_CLS =
  "chat-markdown prose prose-sm dark:prose-invert max-w-none text-[16px] @[560px]/chat-reading:text-[15px] leading-[1.65] text-foreground [overflow-wrap:anywhere]";

/** The whole conversation snapshot (the page renders most of it). */
const selectConversation = (state: ConversationState) => state;
const EMPTY_TOOLS: ToolUsed[] = [];
const EMPTY_TYPERS: ConversationState["room"]["typers"] = [];
const EMPTY_NOTICES: readonly ConversationNotice[] = [];
const EMPTY_IDS: ReadonlySet<string> = new Set();
/** Frames that feed the chronological activity log (replayed on return). */
const FEED_FRAMES: ReadonlySet<string> = new Set([
  "input_applied", "reasoning", "tool_start", "tool_dropped", "tool_input", "turn_started", "snapshot", "activity",
]);

/**
 * Coalesce persisted assistant rows into replies. One reply is persisted as
 * one row per tool round, so adjacent rows merge (`coalesceAssistantRunMessages`).
 * A text-only row (no tool round) finished its reply, so the next assistant
 * row starts another one: a queued input the running turn took splits it into
 * two replies, persisted after both user rows, and both must stay visible.
 */
const coalesceTranscriptReplies = (rows: SurfaceMessage[]): SurfaceMessage[] => {
  const replies: SurfaceMessage[][] = [[]];
  let previous: SurfaceMessage | undefined;
  for (const row of rows) {
    const finished = previous?.role === "assistant" && !previous.toolsUsed?.length && previous.text.trim().length > 0;
    if (finished && row.role === "assistant") replies.push([]);
    replies[replies.length - 1].push(row);
    previous = row;
  }
  return replies.flatMap((reply) => coalesceAssistantRunMessages(reply));
};

/** The page's own send the conversation is painting, for frames that need
 *  its context (session adoption, recency rollback, send feedback). */
type PageSendContext = {
  /** The navigation epoch the send started in; a moved pane adopts nothing. */
  epoch: number;
  owningSessionId: string | null;
  text: string;
  assistantId: string;
  channelId: string | undefined;
  contextGroupId: string | null;
  contextProjectId: string | null;
  inputSaved: boolean;
  localSend: ReturnType<typeof beginChatSendFeedback>;
  rollbackRecency: () => void;
};

/** The page copy for the conversation controller's typed notice codes
 *  (chat-app.md → "Shared client controller ownership": copy stays in the
 *  presentation). Existing keys only; `slot` names where the page shows it. */
type PageNoticeCopy = {
  chatApp: Pick<Dictionary["chatApp"],
    | "turnReconnecting" | "errorGeneric" | "turnReclaimed" | "turnFailed" | "turnStoppedBy" | "turnStopped"
    | "turnStoppedByYou" | "queuedNotice" | "stopTurnFailed" | "confirmNotAllowed" | "assistantClearanceBlocked"
    | "deliveryAudienceBlocked" | "upstreamConnectionReset" | "upstreamConnectionResetCustom" | "upstreamUnreachable"
    | "upstreamUnreachableCustom" | "clearanceBelowRejectedRoom" | "clearanceBelowRejectedMessage"
    | "clearanceBelowSkippedRoom" | "clearanceBelowSkippedMessage">;
  chat: Pick<Dictionary["chat"],
    | "turnReconnectFailed" | "noticePostReplyAuthorityChanged" | "noticeCustomModelImageFallback"
    | "noticeCustomModelEndpointFallback" | "noticeBudgetDowngraded">;
};
export type PageNoticeSlot = "error" | "turnNotice" | "turnEnd" | "reconnect" | "queued";
/** Server-authored `message` shows only for codes this build does not
 *  translate; `sharedChat` marks a withheld shared-chat answer. */
export const pageNoticeCopy = (
  notice: ConversationNotice,
  copy: PageNoticeCopy,
  context: {
    viewerId: string | null;
    ownsDirectRun: boolean;
    stoppedByViewer?: boolean;
    /** The assistant a clearance refusal or skip is about (the copy names it,
     *  never a clearance level), and whether the chat is a room. */
    clearanceNames?: { rejected: string | null; skipped: string | null };
    conversation?: "room" | "message";
  },
): { slot: PageNoticeSlot; text: string } | null => {
  const serverText = "message" in notice && typeof notice.message === "string" && notice.message ? notice.message : null;
  switch (notice.code) {
    case "reconnecting":
      return { slot: "reconnect", text: copy.chatApp.turnReconnecting };
    case "reconnectFailed":
      return { slot: "error", text: copy.chat.turnReconnectFailed };
    case "turnEnd": {
      if (notice.reason === "stalled_reclaimed" || notice.reason === "timeout") return { slot: "turnEnd", text: copy.chatApp.turnReclaimed };
      // The sender's own failed POST already shows its error.
      if (notice.reason === "failed") return context.ownsDirectRun ? null : { slot: "turnEnd", text: copy.chatApp.turnFailed };
      if (notice.reason === "stopped_by_user") {
        return {
          slot: "turnEnd",
          // This tab asked for the Stop: the viewer is the stopper, whatever
          // display name the server attached.
          text: context.stoppedByViewer
            ? copy.chatApp.turnStoppedByYou
            : notice.stoppedByName
            ? format(copy.chatApp.turnStoppedBy, { name: notice.stoppedByName })
            // A system cancellation without a named human never reads as "you".
            : notice.senderUserId !== null && notice.senderUserId === context.viewerId
              ? copy.chatApp.turnStoppedByYou : copy.chatApp.turnStopped,
        };
      }
      return null;
    }
    case "queued":
      return { slot: "queued", text: copy.chatApp.queuedNotice };
    case "turnNotice": {
      const known: Record<string, string> = {
        post_reply_authority_changed: copy.chat.noticePostReplyAuthorityChanged,
        custom_model_image_fallback: copy.chat.noticeCustomModelImageFallback,
        custom_model_endpoint_fallback: copy.chat.noticeCustomModelEndpointFallback,
        budget_downgraded: copy.chat.noticeBudgetDowngraded,
      };
      if (notice.notice === "assistant_clearance_below_conversation") {
        // A response-group member skipped because it cannot read the chat.
        const name = context.clearanceNames?.skipped;
        const text = name
          ? format(context.conversation === "message" ? copy.chatApp.clearanceBelowSkippedMessage : copy.chatApp.clearanceBelowSkippedRoom, { name })
          : serverText;
        return text ? { slot: "turnNotice", text } : null;
      }
      const text = Object.hasOwn(known, notice.notice) ? known[notice.notice] : serverText;
      return text ? { slot: "turnNotice", text } : null;
    }
    case "stopTurnFailed":
      return { slot: "error", text: copy.chatApp.stopTurnFailed };
    case "confirmNotAllowed":
      return { slot: "error", text: copy.chatApp.confirmNotAllowed };
    case "error": {
      const custom = notice.customEndpoint === true;
      if (notice.errorCode === "assistant_clearance_exceeds_room") return { slot: "error", text: copy.chatApp.assistantClearanceBlocked };
      if (notice.errorCode === "assistant_clearance_below_conversation") {
        // A mention rejected because that assistant cannot read the chat.
        const name = context.clearanceNames?.rejected;
        return {
          slot: "error",
          text: name
            ? format(context.conversation === "message" ? copy.chatApp.clearanceBelowRejectedMessage : copy.chatApp.clearanceBelowRejectedRoom, { name })
            : serverText ?? copy.chatApp.errorGeneric,
        };
      }
      if (notice.errorCode === "delivery_audience_unverified" && notice.sharedChat === true) return { slot: "error", text: copy.chatApp.deliveryAudienceBlocked };
      if (notice.errorCode === "upstream_connection_reset") return { slot: "error", text: custom ? copy.chatApp.upstreamConnectionResetCustom : copy.chatApp.upstreamConnectionReset };
      if (notice.errorCode === "upstream_unreachable") return { slot: "error", text: custom ? copy.chatApp.upstreamUnreachableCustom : copy.chatApp.upstreamUnreachable };
      return { slot: "error", text: serverText ?? copy.chatApp.errorGeneric };
    }
    case "servedBy":
      return null;
  }
};

export function ChatSurface({ workspaceId }: { workspaceId: string }) {
  const [historyRecoverySessionId, setHistoryRecoverySessionId] = useState<string | null>(null);
  const t = useT().chatApp;
  const searchCopy = useT().workspaceSearch;
  const chatLabel = useT().operatorBar.chat;
  const locale = useLocale();
  // The dock's chat dictionary — tool narration, activity copy, copy/stop
  // labels. Reused verbatim so the two surfaces never phrase one thing twice.
  const tChat = useT().chat;
  const tAttach = useT().attachments;
  const tRecordings = useT().recordings;
  const interactionT = useT().liveInteraction;
  const publishedAssistantLabel = useT().comments.assistantName;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The ambient dock is hidden on this route (a second launcher would
  // duplicate the full-page composer), but its recorder controller stays
  // mounted. Rehost that ONE controller in this composer — the Feed /
  // skill-rail recipe — so the record affordance is sticky on every surface
  // and a capture keeps running across the surface switch. Null until the
  // dock publishes (primary assistant still resolving).
  const dockRecorder = useGlobalDockRecorder();
  // Chat owns recorder chrome beside its composer at every width. Release
  // only the presentation slot on navigation; capture stays on the dock.
  useEffect(() => claimFloatingRecorder(), []);

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
  const [acceptedGoal, setAcceptedGoal] =
    useState<GoalAcceptedNotice | null>(null);
  /** In-chat pursuit: the goals that originated in the open session (mig 481),
   *  rendered inline in the transcript + as the sticky strip. Repair-driven:
   *  reloaded on session open and on each live `goal_accepted` signal. */
  const [sessionGoals, setSessionGoals] = useState<SessionGoalRow[]>([]);
  /** Live status per goal id, lifted from each inline card's activity stream
   *  so the sticky strip and the composer receipt share ONE subscription. */
  const [goalLiveStatuses, setGoalLiveStatuses] = useState<
    Record<string, string>
  >({});
  /** The session the current `sessionGoals` belong to — a stale fetch that
   *  resolves after a thread switch must not paint the wrong session. */
  const sessionGoalsForRef = useRef<string | null>(null);
  const [researchQuota, setResearchQuota] = useState<{
    used: number;
    quota: number;
    isPaid: boolean;
  } | null>(null);
  const [researchExhausted, setResearchExhausted] = useState(false);
  // The roster and both session lists come from the cache the sidebar panel
  // reads too (`lib/chat-surface-data.ts`): a revisit paints them on the
  // first frame, the spine and the same-tab refresh signal mark them stale,
  // and this surface carries no list fetch of its own.
  const {
    assistants,
    assistantsLoaded,
    personal: cachedPersonalSessions,
    shared: cachedSharedSessions,
    refreshShared,
    retainedSyncedAt,
  } = useChatSessionsData(workspaceId);
  /** The room's clearance-filtered `@mention` roster (T-H4) — assistants plus
   *  ONLY the members who can read THIS room. Null until fetched (a fresh
   *  Workspace pane with no session yet, or the fetch hasn't landed); the
   *  merged roster below falls back to assistants-only until it does. Never
   *  read for clearance logic here — the endpoint already filtered it. */
  const [mentionRoster, setMentionRoster] = useState<{
    assistants: { id: string; name: string }[];
    members: { id: string; name: string }[];
  } | null>(null);
  /** D-H4 — members named in the last send/edit who could not be reached
   *  because they fail this room's clearance. Cleared at the top of every
   *  `send()` so it never survives past the message that produced it. */
  const [unreachableNote, setUnreachableNote] = useState<UnreachableMention[]>([]);
  const primaryAssistant = useMemo(
    () => assistants.find((a) => a.kind === "primary") ?? assistants[0] ?? null,
    [assistants],
  );
  /** The new-chat pane's picked interlocutor (`null` = the primary default).
   *  Reset whenever the pane returns to a fresh chat — the pick is per chat,
   *  not a sticky preference. */
  const [pickedAssistantId, setPickedAssistantId] = useState<string | null>(null);
  const handoffAssistantRef = useRef<string | null>(null);
  const [contextTeams, setContextTeams] = useState<ContextTeam[]>([]);
  const [contextProjects, setContextProjects] = useState<ContextProject[]>([]);
  const [pickedContextGroupId, setPickedContextGroupId] = useState<string | null>(null);
  const [pickedContextProjectId, setPickedContextProjectId] = useState<string | null>(null);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [composerAddOpen, setComposerAddOpen] = useState(false);
  /** Personal rows across every assistant — resolves an open thread's binding
   *  (each row carries the `assistantId` it was fetched under). */
  const personalSessions: DocSession[] = cachedPersonalSessions ?? EMPTY_PERSONAL;
  /** Sessions adopted mid-turn this mount: id → the assistant they were minted
   *  with, so the SECOND turn of a fresh chat resolves correctly before the
   *  rail refetch lands. */
  const sessionAssistantRef = useRef<Map<string, string>>(new Map());
  const sharedSessions: WorkspaceSession[] = cachedSharedSessions ?? EMPTY_SHARED;
  const [input, setInput, draftStorageFailed] = useDurableDraft(workspaceId, `chat:${searchParams?.get("s") ?? "new"}`);
  const draftWarning = useT().comments.localDraftFailed;
  const [error, setError] = useState<string | null>(null);
  const [startingShared, setStartingShared] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  /** The viewer's own user id — filters this client's OWN turn out of the
   *  room's bus mirror (it streams over this client's POST already). */
  const meId = getUserInfo()?.id ?? null;
  const [recoveryDrafts,setRecoveryDrafts] = useState<RecoverableChatDraft[]>([]);
  useEffect(() => { setRecoveryDrafts(meId ? readChatDrafts(workspaceId,meId) : []); },[workspaceId,meId]);
  const updateRecoveryDrafts = (drafts:RecoverableChatDraft[]) => {
    setRecoveryDrafts(drafts);
    if(meId) writeChatDrafts(workspaceId,meId,drafts);
  };
  /** The composer's Ask affordance (D1/T3): arms address intent for the next
   *  send in a room without typing a mention. Reset after each send. */
  const [askArmed, setAskArmed] = useState(false);
  /** The user message open in the inline editor, and its working text. */
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  /**
   * The live text selection inside one transcript message, with the viewport
   * rect to anchor the floating Reply pill to.
   *
   * Selecting first and replying second is the affordance: a reply that quotes
   * a whole answer to ask about one figure in it is barely a reply, so the
   * pill appears where the user's eyes already are rather than making them
   * travel to the row's hover bar and lose the selection getting there.
   */
  const [selectionQuote, setSelectionQuote] = useState<{
    messageId: string;
    text: string;
    top: number;
    left: number;
  } | null>(null);
  /** The open thread — URL state, so it is linkable and survives navigation. */
  const urlSessionId = searchParams?.get("s") ?? null;
  /** Which view is open. URL state too, so "the shared chats" is a link. */
  const urlView: ChatView =
    searchParams?.get("v") === "workspace" ? "workspace" : "personal";
  /** Whether the URL names the location itself — a deep link, a rail row, an
   *  in-surface navigation, the installer's fresh-chat hint. A BARE
   *  `/w/<id>/chat` (how the nav rail, the Home app-bar and ⌘1 spell "the Chat
   *  app") names nothing, which is when the remembered location speaks. */
  const urlPinsLocation =
    urlSessionId !== null ||
    searchParams?.get("v") != null ||
    searchParams?.get("assistant") != null;
  /** The remembered location mid-restore, held until the URL catches up.
   *  Rendering from it instead of waiting for `router.replace` to land is what
   *  keeps re-entry from flashing the new-chat hero first. */
  const [restoring, setRestoring] = useState<ChatLocation | null>(null);
  const activeSessionId = restoring ? restoring.sessionId : urlSessionId;
  const view: ChatView = restoring ? restoring.view : urlView;
  /**
   * The side pane of the open chat (chat-parity D4-D8). Its tabs and whether
   * it is open live in the per-chat store, not in this component, so they
   * survive leaving `/chat` (T6). Every chat starts with it closed.
   */
  const pane = useChatPane(workspaceId, activeSessionId);
  // Saved research of this chat, matched to the replies that delivered it.
  const sessionResearch = useSessionResearch(workspaceId, activeSessionId);
  // One hero context picker for both views (chat-parity T5). A fresh personal
  // pane's Team/Project choice stays this surface's own state (handoffs and
  // restored drafts seed it), held by the shared creation context.
  const creationContext=useCreationContext(activeSessionId?"existing":view==="workspace"?"new-shared":"private",{
    teamId:pickedContextGroupId,
    projectId:pickedContextProjectId,
    select:(team,project)=>{setPickedContextGroupId(team);setPickedContextProjectId(project);},
  });
  /** The open thread's rail row, from either list: a personal chat or a room. */
  const activeRow: DocSession | WorkspaceSession | null = useMemo(
    () =>
      sharedSessions.find((r) => r.id === activeSessionId) ??
      personalSessions.find((r) => r.id === activeSessionId) ??
      null,
    [sharedSessions, personalSessions, activeSessionId],
  );
  /** The selected session supplies its current policy and settings capability
   *  projection when the rail only has the list row. */
  const [activeSummary, setActiveSummary] = useState<ChatSessionSummary | null>(null);
  const summaryWanted = !!activeSessionId && (!activeRow?.policy || !activeRow.capabilities);
  useEffect(() => {
    if (!activeSessionId || !summaryWanted) return;
    const controller = new AbortController();
    void getChatSessionSummary(activeSessionId, controller.signal).then((summary) => {
      if (!controller.signal.aborted && summary?.id === activeSessionId) setActiveSummary(summary);
    });
    return () => controller.abort();
  }, [activeSessionId, summaryWanted]);
  const paneSummary = useCurrentChatSummary(workspaceId, activeSummary?.id === activeSessionId ? activeSummary : null);
  const activeContextSession = paneSummary?.capabilities ? paneSummary : activeRow ?? paneSummary;
  /** An open room's starter ("Started by"); a personal chat has none. */
  const activeStartedByName =
    (activeRow as Partial<WorkspaceSession> | null)?.startedByName ??
    paneSummary?.startedByName ??
    null;
  /**
   * How the CURRENT pane behaves (chat-parity T1). A personal chat is a room
   * with one human (D1), so every branch below reads one of these flags and
   * none asks which list the thread is in or which view is open. The view
   * only decides what a fresh pane creates, and a fresh pane behaves the same
   * either way: one human, every message addressed (FRESH_PANE_POLICY).
   */
  const panePolicy: ChatSessionPolicy = !activeSessionId
    ? FRESH_PANE_POLICY
    : activeRow?.policy ?? paneSummary?.policy ?? PENDING_POLICY;


  // ── In-chat goal pursuit (docs/architecture/features/goals.md) ────────────
  /** Reload the open session's goals. Guarded against thread switches: only
   *  the session `sessionGoalsForRef` still points at may paint state. */
  const reloadSessionGoals = useCallback(
    async (sessionId: string) => {
      const rows = await listGoals(workspaceId, {
        originSessionId: sessionId,
        includeTerminal: true,
      }).catch(() => [] as SessionGoalRow[]);
      if (sessionGoalsForRef.current !== sessionId) return;
      setSessionGoals(rows);
    },
    [workspaceId],
  );

  useEffect(() => {
    sessionGoalsForRef.current = activeSessionId ?? null;
    setSessionGoals([]);
    setGoalLiveStatuses({});
    if (!activeSessionId) return;
    void reloadSessionGoals(activeSessionId);
  }, [activeSessionId, reloadSessionGoals]);

  const handleGoalStatusChange = useCallback((goalId: string, status: string) => {
    setGoalLiveStatuses((prev) =>
      prev[goalId] === status ? prev : { ...prev, [goalId]: status },
    );
  }, []);

  /**
   * `@` autocomplete's roster (T9/T-H4/T-H5): the WHOLE workspace assistant
   * list, merged with this room's clearance-passing members when the
   * conversation posts (other humans read it) and `mentionRoster` has landed.
   * Assistants are ordered FIRST so an exact name tie resolves to the
   * assistant (D-H3), matching the server's `resolveRoomMentions`. A fresh
   * pane (no session yet, so no room to scope member clearance against) and a
   * personal chat (nobody else to notify) offer assistants only.
   */
  const mentionTargets: (RoomMentionTarget & { iconSeed?: number | null })[] = useMemo(() => {
    if (panePolicy.post && mentionRoster) {
      return [
        ...mentionRoster.assistants.map((a) => ({
          id: a.id,
          name: a.name,
          mentionKind: "assistant" as const,
          iconSeed: assistants.find((x) => x.id === a.id)?.iconSeed ?? null,
        })),
        ...mentionRoster.members.map((m) => ({
          id: m.id,
          name: m.name,
          mentionKind: "member" as const,
        })),
      ];
    }
    return assistants.map((a) => ({
      id: a.id,
      name: a.name,
      mentionKind: "assistant" as const,
      iconSeed: a.iconSeed,
    }));
  }, [panePolicy.post, mentionRoster, assistants]);

  /** `@` autocomplete (T9/T-H4/T-H5): typing `@` (or a partial after it) at
   *  the end of the input offers every assistant that can answer here, plus
   *  (in a room) every teammate who can read it; picking an assistant
   *  addresses the turn, picking a teammate just notifies them (D-H2).
   *  Escape or a click outside collapses it, and a confirmed mention is
   *  painted as a chip rather than left looking like prose. */
  const mentions = useAssistantMentions({
    // Every Chat conversation answers in several voices (D1, `multiVoice`).
    enabled: panePolicy.multiVoice,
    assistants: mentionTargets,
    value: input,
    onChange: setInput,
  });
  /** Slash-command discovery — a draft that is a half-typed `/command` offers
   *  the invocable skills; the send stays an ordinary message and the server
   *  seam does the real resolution. Anchored to the same composer box as the
   *  mention popup (the two queries are mutually exclusive: one starts with
   *  `/`, the other contains `@`). */
  const slashCommands = useSlashCommands({
    enabled: true,
    workspaceId,
    value: input,
    onChange: setInput,
    containerRef: mentions.containerRef,
  });
  /** The same autocomplete inside the inline message editor — one instance is
   *  enough because only one message is editable at a time. */
  const editMentions = useAssistantMentions({
    enabled: panePolicy.multiVoice,
    assistants: mentionTargets,
    value: editingText,
    onChange: setEditingText,
  });

  // ── The conversation (M5 WP-B) ──────────────────────────────────────
  // The page is a presentation of the scoped conversation controller
  // (`lib/chat/conversation-controller.ts`): send, follow, reconnect, Stop,
  // approvals, pending input and the mid-turn queue live there and outlive
  // this surface, so a turn keeps running across a chat switch (A -> B -> A)
  // and a route change. This surface keeps URL selection, history display,
  // rooms UI, the Work Bench and the composer. Contract: chat-app.md →
  // "Shared client controller ownership".
  const presentationIdRef = useRef<string | null>(null);
  presentationIdRef.current ??= `page:${crypto.randomUUID()}`;
  /** A fresh pane's provisional conversation; every new chat mints another. */
  const [freshPaneKey, setFreshPaneKey] = useState(() => crypto.randomUUID());
  const freshPaneKeyRef = useRef(freshPaneKey);
  freshPaneKeyRef.current = freshPaneKey;
  /** The conversation whose turn this viewer asked to stop: the server names
   *  the stopper, but only this tab knows the stopper is the viewer. */
  const [stopRequestedHere, setStopRequestedHere] = useState<ConversationController | null>(null);
  /** The frame observer, assigned below once its handlers exist. */
  const pageFrameRef = useRef<(frame: ClassifiedTurnFrame) => void>(() => {});
  const replayFrameRef = useRef<(frame: ClassifiedTurnFrame) => void>(() => {});
  const pageCapabilities = useMemo<PresentationCapabilities>(() => ({
    profile: "page",
    describeTool: (name, toolInput) => describeToolFromInput(name, toolInput, tChat.toolNarration),
    pageIdsFromToolResult: (toolName, output, isError) =>
      PAGE_WRITING_TOOLS.has(toolName) ? pageIdsFromToolResult(output, isError) : [],
    parseDocument: (payload) => parsePresentedDocumentPayload(payload),
    onFrame: (frame) => pageFrameRef.current(frame),
  }), [tChat.toolNarration]);
  const conversation = useConversation({
    workspaceId,
    sessionId: activeSessionId,
    provisionalKey: provisionalConversationKey("page", freshPaneKey),
    presentationId: presentationIdRef.current,
    capabilities: pageCapabilities,
    // A room holds its whole-life follow stream once its policy says so; the
    // policy can land after the conversation exists (a deep link, a new room).
    room: panePolicy === PENDING_POLICY ? undefined : panePolicy.presence,
  }, selectConversation);
  const controller = conversation.controller;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const convo = conversation.value;
  const transcript = convo?.transcript ?? initialChatState;
  /** The transcript as this page reads and edits it: the conversation's own. */
  const chat = useMemo(() => ({
    state: transcript,
    loadMessages: (messages: SurfaceMessage[]) => controllerRef.current?.loadMessages(messages),
    appendMessage: (message: SurfaceMessage) => controllerRef.current?.appendMessage(message),
  }), [transcript]);
  /** Whether the conversation's direct POST is painting a turn, read live. */
  const stream = useMemo(() => ({
    inFlight: () => !!controllerRef.current?.getSnapshot().transcript.isStreaming,
  }), []);
  /**
   * The entry a send targets: the selected session's, or this fresh pane's
   * provisional one. Acquired directly (the same registry key the hook binds),
   * so a send right after creating a room does not wait for a render.
   */
  const conversationFor = useCallback((sessionId: string | null): ConversationController | null => {
    const authority = currentOfflineWriteAuthority(workspaceId);
    if (!authority) return null;
    return conversationRegistry().acquire(
      { apiOrigin: authority.apiOrigin, viewerId: authority.viewerId, workspaceId: authority.workspaceId },
      sessionId ? { sessionId } : { provisional: provisionalConversationKey("page", freshPaneKeyRef.current) },
    );
  }, [workspaceId]);
  /** Humans taking part as this client sees them now (D2): the server's count
   *  raised by any new sender the transcript shows, so a second human's first
   *  post switches the room rules on without a reload. */
  const paneHumanCount = effectiveHumanCount({
    serverCount: activeRow?.humanCount ?? paneSummary?.humanCount ?? null,
    viewerUserId: meId,
    senderUserIds: (chat.state.messages as SurfaceMessage[]).map((m) => m.senderUserId),
  });

  /** Transcript command rendering needs the roster the composer fetches
   *  lazily: pull it as soon as history contains a slash-shaped user message,
   *  so restored `/goal …` turns style as commands without a `/` keystroke. */
  useEffect(() => {
    if (slashCommands.roster) return;
    const hasCommandShaped = (chat.state.messages as SurfaceMessage[]).some(
      (m) => m.role === "user" && m.text.length > 0 && isSlashCommandShaped(m.text),
    );
    if (hasCommandShaped) slashCommands.ensureRoster();
    // The hook returns a fresh object every render; roster + ensureRoster are
    // its stable parts, so depending on those (not the object) keeps this quiet.
  }, [chat.state.messages, slashCommands.roster, slashCommands.ensureRoster]);
  /** The selected session, read by callbacks that outlive a render. */
  const sessionIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followTranscriptRef = useRef(true);
  const scrolledSessionRef = useRef<string | null | undefined>(undefined);

  /** Where each session goal's inline card anchors in the transcript (after
   *  the last message at-or-before its creation — the arming turn). */
  const goalPlacement = useMemo(
    () =>
      interleaveSessionGoals(
        chat.state.messages as SurfaceMessage[],
        sessionGoals,
      ),
    [chat.state.messages, sessionGoals],
  );

  const jumpToGoalCard = useCallback((goalId: string) => {
    scrollRef.current
      ?.querySelector(`[data-goal-pursuit-id="${CSS.escape(goalId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  // A session ID alone cannot distinguish A -> B -> A. Invalidate work on
  // every navigation, before aborting streams (abort can run callbacks).
  const sessionEpochRef = useRef(0);
  const transcriptRequestRef = useRef(0);
  const transcriptAbortRef = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => {
    transcriptRequestRef.current += 1;
    transcriptAbortRef.current?.abort();
    // Strict Mode's effect replay must hydrate again after cancelling its read.
    hydratedRef.current = null;
  }, []);
  // Upload and first send share this identity until the server ID is adopted.
  const freshChannelIdRef = useRef<string | null>(null);
  /** The thread currently painted. Guards the hydrate effect from re-fetching
   *  (and wiping a live stream) when WE are the ones who just put the id in
   *  the URL — a fresh session adopts its server id mid-turn. */
  const hydratedRef = useRef<string | null>(null);
  // ── The chronological activity feed ─────────────────────────────────
  // The conversation keeps each turn's tools, notes, citations, documents
  // and page links (`[COMP:chat-ui/turn-transcript]`, FULL_PAGE preset). The
  // feed's chronological log of reasoning runs and tool steps
  // (build-events.ts) is this presentation's, rebuilt from the frame
  // observer in arrival order for the direct turn and for the mirror.
  const [streamingEvents, setStreamingEvents] = useState<BuildEvent[]>([]);
  const eventLogRef = useRef<EventLog>(EMPTY_LOG);
  const eventSeqRef = useRef(0);
  const eventToolIdsRef = useRef<Set<string>>(new Set());
  const eventedToolIdsRef = useRef<Set<string>>(new Set());
  const turnReasoningRef = useRef("");
  const mintEventId = useCallback(() => `ev-${eventSeqRef.current++}`, []);
  const resetEventLog = useCallback(() => {
    eventLogRef.current = EMPTY_LOG;
    eventSeqRef.current = 0;
    eventToolIdsRef.current.clear();
    eventedToolIdsRef.current.clear();
    turnReasoningRef.current = "";
    setStreamingEvents([]);
  }, []);
  const [remoteEvents, setRemoteEvents] = useState<BuildEvent[]>([]);
  const remoteLogRef = useRef<EventLog>(EMPTY_LOG);
  const remoteSeqRef = useRef(0);
  const remoteToolIdsRef = useRef<Set<string>>(new Set());
  const remoteNarratedRef = useRef<Set<string>>(new Set());
  const mintRemoteId = useCallback(() => `rev-${remoteSeqRef.current++}`, []);
  const resetRemoteLog = useCallback(() => {
    remoteLogRef.current = EMPTY_LOG;
    remoteSeqRef.current = 0;
    remoteToolIdsRef.current.clear();
    remoteNarratedRef.current.clear();
    setRemoteEvents([]);
  }, []);
  // The live turn, as the conversation publishes it.
  const activity = convo?.activity ?? initialTurnTranscript;
  const toolTimeline: ToolUsed[] = activity.tools;
  const citations = activity.citations;
  const researchPhase = convo?.researchPhase ?? null;
  const turnStartedAt = activity.startedAt;
  /** A followed turn this tab is not painting directly: a teammate's, or its
   *  own after the direct stream dropped (the mirror, chat-app.md →
   *  "Disconnect is not a stop"). */
  const mirror = convo?.mirror ?? null;
  const remoteActive = !!mirror?.active;
  const remoteText = mirror?.text ?? "";
  const remoteReplyPhase = mirror?.replyPhase ?? "generating";
  const remoteResearchPhase = mirror?.researchPhase ?? null;
  const remoteStartedAt = mirror?.startedAt ?? null;
  const remoteTools: ToolUsed[] = mirror?.activity.tools ?? EMPTY_TOOLS;
  const remoteAssistantId = mirror?.assistantId ?? null;
  /** This tab's own personal turn, re-attached after a reload or a dropped
   *  direct stream: no direct POST paints it, yet the conversation's turn is
   *  live (`turnLive`, the same test that makes `send` answer busy and `queue`
   *  accept). Mid-turn input joins it exactly as it joins a direct turn. */
  const reattachedTurnLive = !transcript.isStreaming && !panePolicy.presence && !!convo?.turnLive;
  /** The conversation is re-attaching after a dropped connection. */
  const reattachPendingRef = useRef(false);
  /** Who the latest clearance refusal (`error`) or skip (`notice`) named. */
  const clearanceNamesRef = useRef<{ rejected: string | null; skipped: string | null }>({ rejected: null, skipped: null });
  /** The open conversation's stopped line is current (a confirmed Stop). */
  const stoppedTurnRef = useRef(false);
  /** The banner on screen is this page's own transient history-read failure. */
  const transientErrorRef = useRef(false);
  /** Messages handed to the running turn and not yet taken (the tray). */
  const queuedInputs = useMemo(
    () => (convo?.queued ?? []).filter((item) => item.sessionId === activeSessionId).map((item) => ({ ...item })),
    [convo?.queued, activeSessionId],
  );
  /** Teammates currently composing, from the room's presence frames. */
  const roomTypers = convo?.room.typers ?? EMPTY_TYPERS;
  /** A suspended askQuestion in the open room / thread (T11/D8). */
  const pendingInteraction = convo?.interaction.pending ?? null;
  const pendingQuestion = pendingInteraction?.kind === "question"
    ? (pendingInteraction.payload as ConversationQuestion)
    : null;
  // The controller's typed notices, in this page's existing copy.
  const noticeCopy = useMemo(() => ({ chatApp: t, chat: tChat }), [t, tChat]);
  const conversationNotices = convo?.notices ?? EMPTY_NOTICES;
  stoppedTurnRef.current = conversationNotices.some((notice) => notice.code === "turnEnd" && notice.reason === "stopped_by_user");
  reattachPendingRef.current = conversationNotices.some((notice) => notice.code === "reconnecting")
    || convo?.run.connection === "reconnecting" || convo?.run.connection === "disconnected";
  const pageNotices = conversationNotices.map((notice) => pageNoticeCopy(notice, noticeCopy, {
    viewerId: meId,
    stoppedByViewer: !!controller && stopRequestedHere === controller,
    clearanceNames: clearanceNamesRef.current,
    conversation: panePolicy.post ? "room" : "message",
    ownsDirectRun: transcript.isStreaming || conversationNotices.some((item) => item.code === "error"),
  }));
  const pageNoticeText = (slot: PageNoticeSlot) => pageNotices.find((notice) => notice?.slot === slot)?.text ?? null;
  const turnNotice = pageNoticeText("turnNotice");
  const queuedNotice = pageNoticeText("queued") !== null;
  const turnEndNotice = pageNoticeText("turnEnd");
  const reconnectNotice = pageNoticeText("reconnect") !== null;
  const noticeError = pageNoticeText("error");
  /** This page's own error line first, then the conversation's. */
  const shownError = error ?? noticeError;

  const buildHref = useCallback(
    (id: string | null, nextView: ChatView) => {
      const params = new URLSearchParams();
      if (nextView === "workspace") params.set("v", "workspace");
      if (id) params.set("s", id);
      const qs = params.toString();
      return qs ? `${pathname}?${qs}` : (pathname ?? "");
    },
    [pathname],
  );

  /** A seed applied this mount, until the render it produced lands. Read by
   *  the write effect below, which would otherwise commit the pre-restore
   *  (bare) location over the memory it was just restored from. */
  const seededRef = useRef<ChatLocation | null>(null);

  const selectSession = useCallback(
    (id: string | null, nextView: ChatView = view, preserveUpload = false) => {
      // Navigation intent wins immediately, before the URL render catches up.
      if (!preserveUpload) freshChannelIdRef.current = null;
      // A user-driven move always outranks a restore still catching up.
      seededRef.current = null;
      setRestoring(null);
      const href = buildHref(id, nextView);
      if (!navigateChatLocation(href, true)) router.replace(href, { scroll: false });
    },
    [buildHref, router, view],
  );

  // ── Re-entry: the remembered location ───────────────────────────────
  // The Chat app is entered from the nav rail / Home app-bar / ⌘1, all of
  // which target the BARE `/w/<id>/chat` — so without this, every surface
  // switch reset the audience to Personal and closed the open thread. Only a
  // bare URL restores, and only once per mount: a deep link, a rail row and an
  // in-surface navigation all state a location outright and win, exactly the
  // rule `seedDocTabs` applies to the doc tab strip. Clicking New chat while
  // the surface is already mounted is a live URL change that never routes
  // through here, so it still opens a fresh pane.
  const restoreAttemptedRef = useRef(false);
  useEffect(() => {
    if (restoreAttemptedRef.current || !workspaceId) return;
    restoreAttemptedRef.current = true;
    const seed = seedChatLocation(
      readChatLocation(workspaceId),
      urlPinsLocation,
    );
    if (!seed) return;
    seededRef.current = seed;
    setRestoring(seed);
    const href = buildHref(seed.sessionId, seed.view);
    if (!navigateChatLocation(href, true)) router.replace(href, { scroll: false });
  }, [buildHref, router, urlPinsLocation, workspaceId]);

  // The rewrite landed — every restorable location produces a `?v=`/`?s=` URL
  // — so the URL is authoritative again and the held seed is spent.
  useEffect(() => {
    if (restoring && urlPinsLocation) setRestoring(null);
  }, [restoring, urlPinsLocation]);

  // Remember where the user is, per workspace, for the next entry. Writing on
  // every change (rather than on unmount) keeps the memory correct even when
  // the tab is closed or the app is quit from inside a thread. The mount pass
  // of this effect runs in the SAME commit as the restore above, still holding
  // the bare location — writing it would erase the memory a tick before the
  // restored render arrives, so a pending seed suppresses exactly that write.
  useEffect(() => {
    if (!workspaceId) return;
    const seeded = seededRef.current;
    if (seeded) {
      if (seeded.view !== view || seeded.sessionId !== activeSessionId) return;
      seededRef.current = null;
    }
    writeChatLocation(workspaceId, { view, sessionId: activeSessionId });
  }, [activeSessionId, view, workspaceId]);

  // ── Assistant resolution ────────────────────────────────────────────
  // Sessions are assistant-bound (`/api/chat` rejects a send whose
  // `assistantId` doesn't match the session's), so "which assistant am I
  // talking to" is a property of the THREAD: a new chat picks its
  // interlocutor in the composer chip and the session sticks to it; an open
  // thread resolves its bound assistant and never switches mid-thread.
  // A room binds the assistant picked at creation (default the primary).
  // The roster itself is `assistants` from the cached `chat-roster:` key
  // above; nothing fetches it here.

  useEffect(() => {
    let cancelled = false;
    // Keep archived Projects available for immutable historical-session chips;
    // the shared picker filters them out of new selections.
    Promise.all([listContextTeams(workspaceId), listContextProjects(workspaceId, true)])
      .then(([teams, projects]) => {
        if (!cancelled) { setContextTeams(teams); setContextProjects(projects); }
      })
      .catch(() => {
        if (!cancelled) { setContextTeams([]); setContextProjects([]); }
      });
    return () => { cancelled = true; };
  }, [workspaceId]);

  // The room's clearance-filtered `@mention` roster (T-H4). Keyed on the open
  // session, not on every keystroke — `mentionable` is a roster snapshot, not
  // a live search. Only a conversation that posts has teammates to mention; a
  // fresh pane has no session yet, so it is left null and `mentionTargets`
  // above falls back to assistants-only until the first send mints one.
  useEffect(() => {
    if (!panePolicy.post || !activeSessionId) {
      setMentionRoster(null);
      return;
    }
    let cancelled = false;
    fetchMentionableRoster(activeSessionId)
      .then((roster) => {
        if (!cancelled) setMentionRoster(roster);
      })
      .catch(() => {
        if (!cancelled) setMentionRoster(null);
      });
    return () => {
      cancelled = true;
    };
  }, [panePolicy.post, activeSessionId]);

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
        activeRow?.assistantId ??
        paneSummary?.assistantId ??
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
  }, [activeSessionId, activeRow, paneSummary, assistants, pickedAssistantId, primaryAssistant]);
  // Read by the mid-turn queue at post time — the pane's assistant can change
  // between mounting the hook and sending.
  const activeAssistantIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeAssistantIdRef.current = activeAssistant?.id ?? null;
  }, [activeAssistant]);

  /**
   * Pick the pane's interlocutor from the composer chip.
   *
   * A fresh pane just remembers the choice (the room/session binds it on
   * create). An open personal chat (a room with one human, D1) re-addresses
   * its next turns on the same thread without moving its binding: the picked
   * assistant answers there under its own clearance (T3), the way the doc
   * dock's thread switches. An OPEN room persists it — the binding is the room's default
   * voice for every member, so it has to survive a reload and reach the
   * other people in it. The optimistic write must move the adoption REF as
   * well as the row: the ref wins in `activeAssistant`, so updating only the
   * row would leave a freshly-created room showing its old assistant.
   *
   * A refusal here is a real answer (the server admits exactly the
   * assistants that could already answer by mention), so it surfaces as the
   * server's own sentence and the chip snaps back.
   */
  const pickAssistant = useCallback(
    async (assistantId: string) => {
      const sessionId = activeSessionId;
      if (!sessionId) {
        setPickedAssistantId(assistantId);
        return;
      }
      if (!panePolicy.post) {
        sessionAssistantRef.current.set(sessionId, assistantId);
        setPickedAssistantId(assistantId);
        return;
      }
      const previous =
        sessionAssistantRef.current.get(sessionId) ??
        activeRow?.assistantId ??
        paneSummary?.assistantId;
      if (previous === assistantId) return;
      sessionAssistantRef.current.set(sessionId, assistantId);
      patchSharedChatSessions(workspaceId, (rows) =>
        rows.map((row) => (row.id === sessionId ? { ...row, assistantId } : row)),
      );
      setError(null);
      try {
        await rebindWorkspaceSessionAssistant(sessionId, assistantId);
        // The rail and the dock render the room's assistant too.
        dispatchChatSessionsRefresh(workspaceId);
      } catch (err) {
        if (previous) sessionAssistantRef.current.set(sessionId, previous);
        else sessionAssistantRef.current.delete(sessionId);
        patchSharedChatSessions(workspaceId, (rows) =>
          rows.map((row) =>
            row.id === sessionId ? { ...row, assistantId: previous } : row,
          ),
        );
        setError(err instanceof Error ? err.message : t.roomAssistantChangeFailed);
      }
    },
    [activeSessionId, activeRow, paneSummary, panePolicy.post, t, workspaceId],
  );

  /** Which mid-turn path a send takes while a turn is live (D3). */
  const midTurnRoute = midTurnPath(panePolicy);
  /**
   * May a send right now join THIS client's running turn instead of starting
   * one? A personal chat hands it over and holds it until taken; a room saves
   * it as a post first and hands an addressed one over too (chat-parity §6).
   */
  const canQueueMidTurn = midTurnRoute !== "none" && (chat.state.isStreaming || reattachedTurnLive);
  /**
   * Live voice interaction belongs to a personal chat: an open one whose
   * policy says nobody else reads it, or a fresh pane that will create one
   * (the view only decides what a fresh pane creates).
   */
  const voiceInteractionHere = activeSessionId
    ? panePolicy !== PENDING_POLICY && !panePolicy.post
    : view === "personal";

  // The full-page surface uses the SAME attachment lanes as the dock:
  // transient cache upload for ordinary files and storage-only recording
  // staging for video / recording-length audio. Processing follows only after
  // the chat clarifies purpose and the user explicitly agrees.
  const recordingUpload = useRecordingUpload(
    workspaceId,
    activeAssistant?.id ?? "",
  );
  const [pendingRecordings, setPendingRecordings] = useState<StagedRecording[]>([]);
  // Chips live in the conversation's tray beside the registry, so they survive
  // leaving /chat (chat-app.md -> "Conversation attachment trays"). A fresh
  // pane has one stable tray per view; an adopted session reads its own.
  const trayPartFor = (sessionId: string | null, forView: ChatView) =>
    sessionId ? { sessionId } : { provisional: provisionalConversationKey("page", `fresh:${forView}`) };
  const attachmentTray = conversationAttachmentTray(workspaceId, trayPartFor(activeSessionId ?? sessionIdRef.current, view));
  const att = useFileAttachments(
    () => sessionIdRef.current ?? undefined,
    {
      tray: attachmentTray,
      getUploadContext: () => {
        if (sessionIdRef.current || view !== "personal") return undefined;
        if (!activeAssistant) throw new Error(t.errorGeneric);
        const assistantId = activeAssistant.id;
        const channelId = freshChannelIdRef.current ??= crypto.randomUUID();
        return {
          fields: {
            workspaceId,
            assistantId,
            channelId,
            appOrigin: APP_ORIGIN,
            // Explicit null means company-wide, not assistant-default scope.
            contextGroupId: pickedContextGroupId ?? "null",
            contextProjectId: pickedContextProjectId ?? "null",
          },
          onSessionReady: (id: string) => {
            if (freshChannelIdRef.current !== channelId) return;
            // Adopt before routing so hydration does NOT clear the draft/tray;
            // the fresh pane's tray becomes the session's.
            moveConversationAttachments(workspaceId, trayPartFor(null, "personal"), { sessionId: id });
            sessionIdRef.current = id;
            hydratedRef.current = id;
            sessionAssistantRef.current.set(id, assistantId);
            selectSession(id, "personal", true);
            dispatchChatSessionsRefresh(workspaceId);
          },
        };
      },
      onRouteMedia: activeAssistant
        ? async (files) => {
            for (const file of files) {
              const staged = await recordingUpload.stage(file);
              if (staged) setPendingRecordings((current) => [...current, staged]);
            }
          }
        : undefined,
    },
  );
  // The tray is keyed by workspace and view, so a change shows that tray.
  useEffect(() => {
    freshChannelIdRef.current = null;
  }, [workspaceId, view]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const drop = useFileDrop((files) => void att.upload(files), {
    disabled: !!pendingQuestion || recordingUpload.busy,
  });

  // ── Shared sessions ─────────────────────────────────────────────────
  // The rail itself lives in the sidebar panel; the surface still needs the
  // shared list to know whether the OPEN thread is shared (the header badge
  // and the live-read subscription hang off that). Both lists are the cached
  // ones from `useChatSessionsData` above; the panel's rename / delete and
  // this surface's own writes patch the cache and dispatch the refresh
  // signal, which marks the keys stale - no listener or refetch lives here.
  // `reloadShared` is the forced revalidation of the shared list (rows stay
  // painted), kept under its old name for the room stream's settle path.
  const reloadShared = refreshShared;

  // ── Hydrate the open thread ─────────────────────────────────────────
  /** Map persisted rows into transcript messages. Assistant rows restore
   *  their `tool_use` blocks as a done-status receipt (re-narrated from each
   *  call's input, no timings — same as the dock's history restore). */
  const mapTranscriptRows = useCallback((rows: DocSessionMessage[], coalesce = true): SurfaceMessage[] => {
    // Each call's outcome lives on the tool_result carrier row the transcript
    // never renders — index them once so a failed call restores as `retried`.
    const outcomes = collectToolResults(rows);
    const pageWrites = collectPageWrites(rows);
    const persistedRows: SurfaceMessage[] = rows
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) => {
        const parsedUser =
          r.role === "user" ? parseMessageAttachments(r.content) : null;
        const { toolsUsed, activityNotes } =
          r.role === "assistant"
            ? restoreAssistantActivity(r.content, outcomes, tChat.toolNarration, r.id)
            : { toolsUsed: [], activityNotes: [] };
        const documents =
          r.role === "assistant" ? extractPresentedDocuments(r.content) : [];
        const pageLinks =
          r.role === "assistant" ? pageLinksForRow(r.content, pageWrites) : [];
        return {
          id: r.id,
          role: r.role as "user" | "assistant",
          text: r.available === false ? t.displayHistory.unavailableMessage : parsedUser?.text ?? extractMessageText(r.content),
          ...(r.available === false ? { historyUnavailable: true } : {}),
          timestamp: new Date(r.timestamp),
          ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
          ...(activityNotes.length > 0 ? { activityNotes } : {}),
          ...(documents.length > 0 ? { documents } : {}),
          ...(pageLinks.length > 0 ? { pageLinks } : {}),
          ...(r.attachments && r.attachments.length > 0
            ? { fileAttachments: r.attachments }
            : {}),
          ...(parsedUser && parsedUser.attachments.length > 0
            ? { userAttachments: parsedUser.attachments }
            : {}),
          ...(r.senderName ? { senderName: r.senderName } : {}),
          ...(r.publishedSenderName != null ? { publishedSenderName: r.publishedSenderName } : {}),
          // The stored quote is a text snapshot, so a restored reply renders
          // WHAT was quoted with no id, role or author to go with it.
          ...(r.replyToText ? { replyTo: { text: r.replyToText } } : {}),
          // Attribution the edit affordance reads: a teammate's post is not
          // this viewer's to rewrite.
          ...(r.senderUserId ? { senderUserId: r.senderUserId } : {}),
          ...(r.senderAssistantId ? { senderAssistantId: r.senderAssistantId } : {}),
        };
      })
      .filter(
        (m) =>
          m.text.length > 0 ||
          (m.toolsUsed?.length ?? 0) > 0 ||
          (m.userAttachments?.length ?? 0) > 0 ||
          (m.fileAttachments?.length ?? 0) > 0 ||
          (m.documents?.length ?? 0) > 0 ||
          (m.pageLinks?.length ?? 0) > 0,
      );
    return coalesce ? coalesceTranscriptReplies(persistedRows) : persistedRows;
  }, [tChat.toolNarration, t.displayHistory.unavailableMessage]);

  /** Load a thread's persisted transcript into the reducer through the
   *  per-session `chat-transcript:` cache key. `force` is the refetch the
   *  live-read path runs when a teammate's turn lands (the SSE payload is a
   *  SIGNAL, never the data). Each refresh supersedes the previous request,
   *  so a settle read cannot join an older hydrate request. A failed fetch
   *  leaves the already-painted cache and reducer alone. */
  const loadTranscript = useCallback(
    async (sessionId: string, options?: { force?: boolean }) => {
      const epoch = sessionEpochRef.current;
      // The conversation's own direct POST owns its optimistic transcript.
      if (sessionIdRef.current !== sessionId || stream.inFlight()) return;
      const request = ++transcriptRequestRef.current;
      transcriptAbortRef.current?.abort();
      const controller = new AbortController();
      transcriptAbortRef.current = controller;
      // A send supersedes history without changing the selected session
      // (`supersedeHistoryRead`): it bumps the request and aborts this read,
      // so even a transport that resolves after abort cannot erase the prompt.
      // Fetch outside the cache loader: it publishes before returning, which
      // would let a superseded force refresh overwrite a newer cached turn.
      // Publish to the shared cache only after the ownership checks pass.
      try {
        const persisted = await fetchChatTranscript(sessionId, { ...options, signal: controller.signal, onCached: cached => {
          if (sessionEpochRef.current === epoch && sessionIdRef.current === sessionId
            && transcriptRequestRef.current === request && !controller.signal.aborted && !stream.inFlight()) {
            const rows = mapTranscriptRows(cached);
            writeTranscriptCache(sessionId, rows); chat.loadMessages(rows); setTranscriptCold(false);
          }
        } });
        if (
          sessionEpochRef.current !== epoch ||
          sessionIdRef.current !== sessionId ||
          transcriptRequestRef.current !== request || controller.signal.aborted ||
          stream.inFlight()
        ) return;
        const rows = mapTranscriptRows(persisted);
        writeTranscriptCache(sessionId, rows);
        chat.loadMessages(rows);
        setHistoryRecoverySessionId(null);
        return rows;
      } catch (error) {
        if (sessionEpochRef.current === epoch && sessionIdRef.current === sessionId
          && transcriptRequestRef.current === request && !controller.signal.aborted) {
          // Transient failures preserve the painted history. Actual access
          // denial must clear protected content instead of retaining it.
          const denied = isAuthoritativeRosterDenial(error);
          if (denied) {
            evictTranscriptCache(sessionId);
            chat.loadMessages([]);
          }
          // A transient failure while the conversation is re-attaching (the
          // connection dropped) shows only the reconnecting line; the banner
          // it would raise is cleared once the re-attach succeeds.
          if (denied) setError(t.historyUnavailable);
          else if (stoppedTurnRef.current) {
            // After a confirmed Stop the read is a transient failure of that
            // read, never the turn's outcome: keep the stopped line and the
            // painted partial reply, and let the conversation retry it with
            // its backoff as a further `historyEpoch` bump (M5D-2).
            controllerRef.current?.reportHistoryFailure();
          } else if (!reattachPendingRef.current) {
            transientErrorRef.current = true;
            setError(t.errorGeneric);
          }
          setHistoryRecoverySessionId(isSessionHistoryUnavailable(error) ? sessionId : null);
        }
        return undefined;
      } finally {
        if (sessionEpochRef.current === epoch && sessionIdRef.current === sessionId
          && transcriptRequestRef.current === request && !controller.signal.aborted) {
          transcriptAbortRef.current = null;
          setTranscriptCold(false);
        }
      }
    },
    // `chat.loadMessages` and `stream.inFlight` read the bound conversation live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapTranscriptRows, t.errorGeneric, t.historyUnavailable],
  );

  /** A send supersedes a slow history read of the same chat: release the cold
   *  placeholder at once and cancel the read, so it cannot erase the prompt. */
  const supersedeHistoryRead = useCallback(() => {
    transcriptRequestRef.current += 1;
    transcriptAbortRef.current?.abort();
    transcriptAbortRef.current = null;
    setTranscriptCold(false);
  }, []);

  /** True from a switch onto a session with NO cached transcript until its
   *  fetch settles: the transcript pane paints the skeleton rather than the
   *  previous thread's rows or a premature "ask anything" (N4). */
  const [transcriptCold, setTranscriptCold] = useState(false);

  // Write-through (N1): every reducer change on the open session - the
  // optimistic user row, a turn streaming in, a teammate's post - lands on
  // the session's cache key, so a revisit paints them before the refetch.
  // Check both the hydration ref and the rendered reducer identity: a layout
  // switch may flush the outgoing render's passive effects before rerendering.
  useEffect(() => {
    if (!activeSessionId || hydratedRef.current !== activeSessionId || chat.state.sessionId !== activeSessionId) return;
    const messages = chat.state.messages as SurfaceMessage[];
    if (messages.length === 0) return;
    writeTranscriptCache(activeSessionId, messages);
  }, [activeSessionId, chat.state.sessionId, chat.state.messages]);

  useLayoutEffect(() => {
    if (activeSessionId === hydratedRef.current) return;
    transcriptRequestRef.current += 1;
    transcriptAbortRef.current?.abort();
    transcriptAbortRef.current = null;
    sessionEpochRef.current += 1;
    setStartingShared(false);
    setHistoryRecoverySessionId(null);
    // Thread switches arrive from the sidebar panel via the URL. The turn of
    // the chat being left keeps running in its own conversation entry (the
    // registry holds it above this surface), so nothing is aborted or
    // stopped here; returning to it shows that turn live again.
    resetEventLog();
    resetRemoteLog();
    // Each chat keeps its own attachment tray; the one being left stays there.
    setError(null);
    // The side pane is per chat (T6): switching chats shows that chat's pane.
    // A quote points at a row in the thread being left.
    setReplyTo(null);
    setSelectionQuote(null);
    freshChannelIdRef.current = null;
    hydratedRef.current = activeSessionId;
    sessionIdRef.current = activeSessionId;
    if (!activeSessionId) {
      // Back on a fresh pane: a new provisional conversation, and the
      // assistant pick is per chat, so it resets to the primary default
      // rather than sticking as a preference.
      setFreshPaneKey(crypto.randomUUID());
      setTranscriptCold(false);
      setPickedAssistantId(handoffAssistantRef.current);
      return;
    }
    // A conversation the registry still holds (its turn kept running while
    // another chat was open) already paints its own transcript. Otherwise
    // paint what the cache holds for THIS session synchronously (its own last
    // transcript, never the previous thread's), then revalidate. A cold
    // session shows the transcript skeleton until the fetch settles. A
    // personal session's hydrate probe (reload or restart mid-turn) belongs
    // to the conversation's attach.
    const bound = controllerRef.current;
    const holding = bound?.getSessionId() === activeSessionId && bound.getSnapshot().transcript.messages.length > 0;
    const cached = holding ? null : readCachedTranscript<SurfaceMessage>(activeSessionId);
    if (!holding) chat.loadMessages(cached ?? []);
    setTranscriptCold(!holding && !cached);
    // The request owns cold-state completion. An effect dependency update
    // must not cancel that completion while keeping the same selected chat.
    void loadTranscript(activeSessionId);
    // `chat.*` reads the bound conversation through its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, loadTranscript, resetEventLog, resetRemoteLog]);

  // ── Live room follow (T13) ──────────────────────────────────────────
  // Every open viewer of a room holds ONE persistent follow subscription,
  // owned by the conversation (`setRoom` below): teammate posts fan in live,
  // a teammate's turn paints through the SAME feed pipeline the sender uses,
  // suspended turns surface, and settle refetches the persisted transcript
  // (events are signals, never data). The conversation suppresses this
  // client's own turn while its direct POST paints it.
  /** Bumped by the room stream's `pins_changed` signal — Work Bench
   *  refetches through its own loader (signals, never data). */
  const [localPinsEpoch, setPinsEpoch] = useState(0);
  const bumpPins = useCallback(() => setPinsEpoch((n) => n + 1), []);
  const pinsEpoch = localPinsEpoch + (convo?.room.pinsEpoch ?? 0);
  /** Pinned tabs are the chat's pins (D7): restored first, synced on `pins_changed`. */
  const panePins = useChatPanePins({
    workspaceId,
    sessionId: activeSessionId,
    enabled: panePolicy.pins,
    refreshKey: pinsEpoch,
    onChanged: bumpPins,
  });
  /**
   * Open something in THIS chat's side pane (D9), keyed by the session the
   * send or stream belongs to right now (a fresh pane's first turn adopts
   * its id mid-stream), never by a render-time closure. Expands the pane and
   * focuses the tab (D8); nothing here ever collapses it.
   */
  const openInChatPane = useCallback(
    (ref: PaneRef, options?: OpenOptions) => {
      updateChatPane(
        workspaceId,
        sessionIdRef.current,
        (state) => openInPane(state, ref, options),
      );
    },
    [workspaceId],
  );

  // ── The browser in the side pane (chat-parity T7, D8, D10) ─────────
  // Desktop: the shell tells us which tabs Brian opened; each opens in its
  // own chat's pane (keyed by the chat it belongs to, not the open one).
  // It also says where those tabs go, so pinning one saves that URL (D7).
  useEffect(
    () =>
      subscribeBrowserPane((event) => {
        const chatKey = event.chatKey ?? sessionIdRef.current;
        updateChatPane(
          workspaceId,
          chatKey,
          (state) =>
            event.type === "tab-updated"
              ? refreshPaneRef(state, { kind: "browser", browserId: event.browserId, url: event.url, title: event.title })
              : openInPane(state, { kind: "browser", browserId: event.browserId, url: event.url }),
        );
      }),
    [workspaceId],
  );
  /** Chats whose cloud browser this mount already opened as a tab. */
  const computerTabsRef = useRef<Set<string>>(new Set());
  /**
   * Web: a browser tool step starts in this chat's turn. If the browse runs in
   * a cloud browser (or there is no desktop pane to host a local one), open
   * its Take-Over frame as a `browser` tab of this chat's pane.
   */
  const openComputerTab = useCallback(
    (sessionId: string) => {
      if (computerTabsRef.current.has(sessionId)) return;
      computerTabsRef.current.add(sessionId);
      void getComputerTask(sessionId)
        .then((task) => {
          if (!task || (task.backend === "local" && desktopBrowserPane())) {
            computerTabsRef.current.delete(sessionId);
            return;
          }
          updateChatPane(
            workspaceId,
            sessionId,
            (state) =>
              openInPane(state, {
                kind: "browser",
                browserId: `computer:${sessionId}`,
                url: null,
                title: task.injectedSite,
              }),
          );
        })
        .catch(() => computerTabsRef.current.delete(sessionId));
    },
    [workspaceId],
  );

  /** Re-probe `GET /pending` for the open chat through its conversation:
   *  a suspended question or a restored tool confirmation is presented there
   *  (deduped against the live card), and the external confirmations land in
   *  its `pendingInput` (kept on an indeterminate read, replaced on a
   *  definitive one). A probe for a chat no longer open does nothing. */
  const refreshPendingInput = useCallback((sessionId: string) => {
    const owner = controllerRef.current;
    if (sessionIdRef.current !== sessionId || !owner || owner.getSessionId() !== sessionId) return;
    void owner.refreshPendingInput();
  }, []);

  // External approvals delivered into this chat restore as confirmation cards
  // via GET /pending. Re-probe when the workspace approval signal fires.
  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<ApprovalsRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      const sessionId = sessionIdRef.current;
      if (sessionId) refreshPendingInput(sessionId);
    };
    window.addEventListener(APPROVALS_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(APPROVALS_REFRESH_EVENT, onRefresh);
  }, [workspaceId, refreshPendingInput]);

  // Opening a chat reads it: stamp a room's unread watermark (T7). A room
  // probes pending input on open (a room found suspended surfaces its answer
  // panel at once; any member with read access may answer, D8); a personal
  // chat's conversation runs that probe in its hydrate attach and publishes
  // the external confirmations from the same response.
  useEffect(() => {
    if (!activeSessionId || panePolicy === PENDING_POLICY) return;
    if (panePolicy.post) markRoomSeen(workspaceId, activeSessionId);
    if (panePolicy.presence) refreshPendingInput(activeSessionId);
  }, [activeSessionId, panePolicy, refreshPendingInput, workspaceId]);
  /** External confirmations delivered into this chat, from the conversation's
   *  pending-input probe (the hydrate attach or a re-probe). */
  const pendingInput = convo?.pendingInput ?? null;
  const externalRequests = pendingInput && pendingInput.sessionId === activeSessionId
    ? { workspaceId, sessionId: pendingInput.sessionId, items: [...pendingInput.externalConfirmations] }
    : null;

  // The conversation asks for authorized history to be re-read (a teammate's
  // post, a settled or recovered turn, an uncertain queued input). This page
  // owns that read: its cache, cold skeleton and access-denial handling.
  const historyEpoch = convo?.historyEpoch ?? 0;
  const seenHistoryEpochRef = useRef<{ controller: ConversationController; epoch: number } | null>(null);
  useEffect(() => {
    const seen = seenHistoryEpochRef.current;
    if (!controller) return;
    seenHistoryEpochRef.current = { controller, epoch: historyEpoch };
    if (!seen || seen.controller !== controller || seen.epoch === historyEpoch) return;
    const sessionId = controller.getSessionId();
    if (sessionId && sessionId === sessionIdRef.current) void loadTranscript(sessionId, { force: true });
  }, [controller, historyEpoch, loadTranscript]);

  // A successful re-attach (`reattachEpoch`) ends the outage, so a transient
  // failure banner this page raised during it no longer applies.
  const reattachEpoch = convo?.reattachEpoch ?? 0;
  const seenReattachRef = useRef<{ controller: ConversationController | null; epoch: number }>({ controller: null, epoch: 0 });
  useEffect(() => {
    const seen = seenReattachRef.current;
    seenReattachRef.current = { controller, epoch: reattachEpoch };
    if (seen.controller !== controller || seen.epoch === reattachEpoch || !transientErrorRef.current) return;
    transientErrorRef.current = false;
    setError((current) => (current === t.errorGeneric ? null : current));
  }, [controller, reattachEpoch, t.errorGeneric]);

  // A Stop failure explains one attempt on a running turn; once the turn has
  // ended the line is stale (the notice is operation-local).
  const runLive = convo?.run.phase === "running" || convo?.run.phase === "suspended";
  const stopFailureShown = conversationNotices.some((notice) => notice.code === "stopTurnFailed");
  useEffect(() => {
    if (controller && stopFailureShown && !runLive && !remoteActive && !transcript.isStreaming) controller.dismissNotice("stopTurnFailed");
  }, [controller, stopFailureShown, runLive, remoteActive, transcript.isStreaming]);

  // Text whose delivery became uncertain (a queued input whose stream died)
  // comes back to the composer. It is never sent again automatically.
  const unsentCount = convo?.unsent.length ?? 0;
  useEffect(() => {
    if (!controller || unsentCount === 0) return;
    const texts = controller.takeUnsent();
    if (texts.length) setInput((current) => [current.trim() ? current : "", ...texts].filter(Boolean).join("\n\n"));
  }, [controller, unsentCount, setInput]);

  // The rail's live marker: this tab observes the open chat while its turn
  // streams, its mirror runs, or a room's follow stream is held.
  const observingTurn = !!activeSessionId && (transcript.isStreaming || remoteActive || panePolicy.presence);
  useEffect(() => {
    if (!observingTurn || !activeSessionId) return;
    const observer = createChatStreamObserver(workspaceId);
    observer.observe(activeSessionId);
    return () => observer.release();
  }, [observingTurn, activeSessionId, workspaceId]);

  // ── Typing beacon (rooms) ───────────────────────────────────────────
  // Tell the bus while this member composes: a throttled `true` beacon keeps
  // the flag alive against the server's decay sweep, and the off-beacon fires
  // when the draft empties (send included), goes idle, or the room closes.
  const typingBeaconRef = useRef<{ active: boolean; sentAt: number }>({
    active: false,
    sentAt: 0,
  });
  const typingIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendTypingBeacon = useCallback(
    (sessionId: string, isTyping: boolean) => {
      typingBeaconRef.current = {
        active: isTyping,
        sentAt: isTyping ? Date.now() : 0,
      };
      void postSessionTyping(sessionId, isTyping);
    },
    [],
  );

  // Desktop: the chat whose turn is live owns a task's new browser tabs.
  const turnLiveHere = chat.state.isStreaming || remoteActive;
  useEffect(() => {
    if (turnLiveHere && activeSessionId) reportTurnChat(activeSessionId);
  }, [turnLiveHere, activeSessionId]);

  /** Typing only matters with another human present (D2). */
  const typingActive = typingPresenceActive(panePolicy, paneHumanCount);
  useEffect(() => {
    if (!typingActive || !activeSessionId) return;
    const sessionId = activeSessionId;
    if (input.trim().length === 0) {
      if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
      if (typingBeaconRef.current.active) sendTypingBeacon(sessionId, false);
      return;
    }
    if (
      !typingBeaconRef.current.active ||
      Date.now() - typingBeaconRef.current.sentAt > TYPING_BEACON_REFRESH_MS
    ) {
      sendTypingBeacon(sessionId, true);
    }
    if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
    typingIdleTimerRef.current = setTimeout(() => {
      if (typingBeaconRef.current.active) sendTypingBeacon(sessionId, false);
    }, TYPING_IDLE_OFF_MS);
  }, [input, typingActive, activeSessionId, sendTypingBeacon]);

  // Leaving the room (thread switch, view change, unmount) clears the flag
  // for teammates immediately rather than waiting for the server sweep.
  useEffect(() => {
    if (!typingActive || !activeSessionId) return;
    const sessionId = activeSessionId;
    return () => {
      if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
      if (typingBeaconRef.current.active) sendTypingBeacon(sessionId, false);
    };
  }, [typingActive, activeSessionId, sendTypingBeacon]);

  // Follow new content only while the reader has chosen the bottom. Refreshes
  // and typing beacons must never pull someone away from an older message.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (scrolledSessionRef.current !== activeSessionId) {
      scrolledSessionRef.current = activeSessionId;
      followTranscriptRef.current = true;
    }
    if (followTranscriptRef.current) el.scrollTop = el.scrollHeight;
  }, [
    activeSessionId,
    chat.state.messages,
    chat.state.streamingText,
    streamingEvents,
    toolTimeline,
    remoteText,
    remoteEvents,
    remoteResearchPhase,
    roomTypers,
  ]);

  const resetPane = useCallback(() => {
    sessionEpochRef.current += 1;
    setStartingShared(false);
    hydratedRef.current = null;
    sessionIdRef.current = null;
    freshChannelIdRef.current = null;
    setError(null);
    setInput("");
    // A new chat is a new provisional conversation. A turn still running in
    // the chat being left keeps running in its own entry.
    setFreshPaneKey(crypto.randomUUID());
    resetFreshChatPane(workspaceId);
    att.clear();
    resetEventLog();
    resetRemoteLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.clear, resetEventLog, resetRemoteLog, workspaceId]);

  const startNewChat = useCallback(() => {
    resetPane();
    setPickedContextGroupId(null);
    setPickedContextProjectId(null);
    selectSession(null, "personal");
  }, [resetPane, selectSession]);

  /**
   * Start a shared thread. An EXPLICIT create, not a flag on the first turn:
   * the thread has to be listable by teammates from the moment it is started,
   * otherwise "I made us a chat" points at nothing until the first message.
   */
  const startNewWorkspaceChat = useCallback(async () => {
    if (startingShared) return;
    if(activeSessionId||view!=="workspace"){resetPane();selectSession(null,"workspace");return;}
    const admitted=creationContext.snapshot();
    if(!admitted){setError(t.newWorkspaceChatFailed);return;}
    setStartingShared(true);
    try {
      // The room binds the assistant picked in the fresh pane's composer
      // chip (default: the workspace primary). Per-room for its lifetime.
      const created = await createWorkspaceSession(
        workspaceId,
        pickedAssistantId ?? undefined,
        {
          contextGroupId: admitted.contextGroupId,
          contextProjectId: admitted.contextProjectId,
          expectedPolicyRevision:admitted.expectedPolicyRevision,
        },
      );
      if(!creationContext.isCurrent())return;
      resetPane();
      cacheCreatedChatSession(workspaceId, created, "workspace");
      hydratedRef.current = created.id;
      sessionIdRef.current = created.id;
      if (created.assistantId) {
        sessionAssistantRef.current.set(created.id, created.assistantId);
      }
      selectSession(created.id, "workspace");
      dispatchChatSessionsRefresh(workspaceId);
    } catch {
      creationContext.fail();
      setError(t.newWorkspaceChatFailed);
    } finally {
      setStartingShared(false);
    }
  }, [activeSessionId, view, creationContext, pickedAssistantId, pickedContextGroupId, pickedContextProjectId, resetPane, selectSession, startingShared, t, workspaceId]);

  /**
   * Stop the running turn: the one Stop entry point (composer and Work Bench,
   * direct and mirrored turns alike). The conversation sends the
   * compare-and-set `POST /api/chat/stop` first, keeps reading the direct
   * stream while it is pending, and aborts locally only on confirmation
   * (chat-app.md → "Stopping a turn"). A failure shows `stopTurnFailed` and
   * leaves the run as it was; a mirrored turn settles on `turn_completed`.
   */
  const stopRunningTurn = useCallback(() => {
    const owner = controllerRef.current;
    if (!owner) return;
    setStopRequestedHere(owner);
    void owner.stop().then((outcome) => {
      // Only a confirmed Stop is this viewer's; a failed or revoked one is not.
      if (outcome !== "stopped") setStopRequestedHere((current) => (current === owner ? null : current));
    });
  }, []);

  const copyResetRef = useRef<number | null>(null);
  const handleCopy = useCallback((messageId: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedMessageId(messageId);
    if (copyResetRef.current != null) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => setCopiedMessageId(null), 1500);
  }, []);

  // ── Replying to a message ───────────────────────────────────────────
  //
  // The pending quote lives in the shared reducer's `replyTo` slot, so the
  // composer chip and the optimistic bubble read one value. A ref mirrors it
  // for `send`, which must not take the whole `chat` object as a dependency.

  const [pendingReply, setReplyTo] = useState<ReplyTo | null>(null);
  const pendingReplyRef = useRef<ReplyTo | null>(null);
  useEffect(() => {
    pendingReplyRef.current = pendingReply ?? null;
  }, [pendingReply]);

  /** Focus the composer so the quote is followed by typing, not by a click.
   *  The mention hook's container IS the composer box element. */
  const composerBoxRef = mentions.containerRef;
  const focusComposer = useCallback(() => {
    composerBoxRef.current?.querySelector("textarea")?.focus();
  }, [composerBoxRef]);

  /**
   * The user's selection, if it lies entirely inside this row. Read at click
   * time rather than tracked: the hover bar's Reply must quote whatever is
   * selected right now, and clicking the button does not disturb the
   * selection (the pill and the bar both `preventDefault` their mousedown).
   */
  const selectionInMessage = useCallback((messageId: string): string | null => {
    if (typeof window === "undefined") return null;
    const row = scrollRef.current?.querySelector(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    return selectionTextWithin(row, window.getSelection());
  }, []);

  /** `authorName` is resolved by the caller: the roster lookup lives in render
   *  scope, next to the transcript that already needs it for group headers. */
  const startReply = useCallback(
    (
      message: SurfaceMessage,
      opts?: { selection?: string | null; authorName?: string | null },
    ) => {
      const target = buildReplyTarget({
        message,
        selection: opts?.selection ?? selectionInMessage(message.id),
        authorName: opts?.authorName,
      });
      if (!target) return;
      setReplyTo(target);
      setSelectionQuote(null);
      window.getSelection()?.removeAllRanges();
      focusComposer();
    },
    [focusComposer, selectionInMessage, setReplyTo],
  );

  /**
   * Offer the floating pill when a selection gesture settles on text inside
   * ONE message. Bound to the gesture's END (`pointerup` / `keyup`, scheduled
   * on the next frame) rather than to every `selectionchange`, because the
   * latter fires per character while a drag is still moving, and a pill that
   * jumps under a moving cursor is unusable. `pointerup` rather than `mouseup`
   * because browsers synthesise no `mouseup` for a long-press selection, so
   * the pill never appeared on a phone; `selectionchange` is listened to only
   * for the collapse, which dismisses the pill at once (the
   * `guest-selection-comment.tsx` shape).
   */
  const handleTranscriptSelectionSettled = useCallback(() => {
    if (typeof window === "undefined") return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionQuote(null);
      return;
    }
    const rows = scrollRef.current?.querySelectorAll("[data-message-id]");
    if (!rows) return;
    for (const row of Array.from(rows)) {
      const text = selectionTextWithin(row, selection);
      if (!text) continue;
      const messageId = row.getAttribute("data-message-id");
      if (!messageId) continue;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      // A degenerate rect means the range has no rendered box to anchor to.
      if (rect.width === 0 && rect.height === 0) break;
      setSelectionQuote({
        messageId,
        text,
        top: rect.top,
        left: rect.left + rect.width / 2,
      });
      return;
    }
    setSelectionQuote(null);
  }, []);

  // Bind the selection gesture's end on the document and scope it to the
  // transcript container by target: the container mounts and unmounts with
  // the hero / transcript swap, so a listener on the element itself would
  // need re-binding on every swap; a document listener does not.
  useEffect(() => {
    if (typeof document === "undefined") return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        handleTranscriptSelectionSettled();
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      const root = scrollRef.current;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
      schedule();
    };
    const onKeyUp = () => {
      if (!scrollRef.current) return;
      schedule();
    };
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setSelectionQuote(null);
    };
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [handleTranscriptSelectionSettled]);

  // ── Send ────────────────────────────────────────────────────────────
  // ── Frame observer: the presentation half of each frame ────────────
  // The conversation applies every frame to the turn; this page reacts to
  // the ones that touch the surface around it (URL adoption, the side pane,
  // goals, research, the rail) and keeps the chronological feed. Direct
  // frames come from this page's sends (or a queue flush the conversation
  // started for it); follow frames from the open chat's follow stream.
  /** The page's own send being painted, for frames that need its context. */
  const sendContextRef = useRef<PageSendContext | null>(null);
  /** What the follow stream showed since its last settle: `done` owes a
   *  refetch only after `running` with no `turn_completed`. */
  const followSeenRef = useRef({ running: false, completed: false });
  const observePageFrame = (frame: ClassifiedTurnFrame, replay: boolean) => {
    // A replay rebuilds only the chronological feed; side effects happened.
    if (replay && !FEED_FRAMES.has(frame.event)) return;
    const { event, payload } = frame;
    const sessionId = sessionIdRef.current;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    if (frame.stream === "direct") {
      const sending = sendContextRef.current;
      switch (event) {
        case "title_update":
          // Titles may arrive after the durable reply has settled. Read the
          // authorized rail projection instead of trusting title bytes here.
          if (payload.sessionId === (sending?.owningSessionId ?? sessionId)) dispatchChatSessionsRefresh(workspaceId);
          break;
        case "session": {
          const id = text(payload.sessionId);
          // A late `session` frame never adopts the turn into a chat the user
          // has since selected (the turn keeps its own conversation entry).
          if (!id || !sending || sending.owningSessionId || sessionEpochRef.current !== sending.epoch) break;
          // The fresh pane's first turn minted this chat. Adopt it BEFORE the
          // URL write: `hydratedRef` is what stops the hydrate effect from
          // re-fetching this thread and wiping the reply streaming into it.
          sending.owningSessionId = id;
          sending.localSend.adopt(id);
          sessionIdRef.current = id;
          hydratedRef.current = id;
          // The next turn resolves this thread to the SAME assistant before
          // the rail refetch lands.
          sessionAssistantRef.current.set(id, sending.assistantId);
          // The fresh pane (a document this first turn presented) moves onto
          // the session it just minted (T6).
          adoptFreshChatPane(workspaceId, id);
          selectSession(id);
          // Paint the real session immediately; title/status reconcile in the background.
          cacheCreatedChatSession(workspaceId, {
            id, title: sending.text.slice(0, 120) || t.newChat,
            channelId: sending.channelId ?? id, transport: "web", appOrigin: "chat",
            lastActive: new Date().toISOString(), assistantId: sending.assistantId,
            contextGroupId: sending.contextGroupId, contextProjectId: sending.contextProjectId,
            status: "running", humanCount: 1,
          }, "personal");
          dispatchChatSessionsRefresh(workspaceId);
          break;
        }
        case "goal_accepted": {
          const notice = goalAcceptedNoticeFromPayload(payload);
          if (notice) {
            setAcceptedGoal(notice);
            // The arming just persisted server-side: pull the session's goals
            // so the inline pursuit card mounts (the payload is a signal).
            if (sessionGoalsForRef.current === notice.sessionId) void reloadSessionGoals(notice.sessionId);
          }
          break;
        }
        case "user_message_saved":
          if (sending) sending.inputSaved = true;
          break;
        case "input_applied":
          // The running turn took a queued message: the conversation closes
          // the segment before it, and the feed starts a fresh one.
          resetEventLog();
          break;
        case "reasoning": {
          // Verbatim model thinking, coalesced into one advancing line in the
          // chronological log until a step closes it (build-events.ts).
          const delta = text(payload.text);
          if (!delta) break;
          turnReasoningRef.current += delta;
          const next = appendReasoning(eventLogRef.current, turnReasoningRef.current, mintEventId);
          if (next !== eventLogRef.current) {
            eventLogRef.current = next;
            setStreamingEvents(next.events);
          }
          break;
        }
        case "tool_start": {
          const id = text(payload.id);
          const name = text(payload.name);
          if (!id || !name) break;
          // Brian started browsing: show the browser in this chat's pane.
          const owner = sending?.owningSessionId ?? sessionId;
          if (!replay && isBrowserToolName(name) && owner) openComputerTab(owner);
          // Re-emits keep the existing row.
          if (eventToolIdsRef.current.has(id)) break;
          eventToolIdsRef.current.add(id);
          eventLogRef.current = appendStep(
            eventLogRef.current,
            describeToolFromInput(name, {}, tChat.toolNarration).description,
            mintEventId,
            { toolId: id },
          );
          setStreamingEvents(eventLogRef.current.events);
          break;
        }
        case "tool_dropped": {
          // The engine stripped this call from the persisted turn: retract
          // the phantom step so the live UI matches what was saved.
          const id = text(payload.id);
          if (!id) break;
          eventToolIdsRef.current.delete(id);
          eventedToolIdsRef.current.delete(id);
          eventLogRef.current = removeToolSteps(eventLogRef.current, id);
          setStreamingEvents(eventLogRef.current.events);
          break;
        }
        case "tool_input": {
          const id = text(payload.id);
          if (!id || eventedToolIdsRef.current.has(id)) break;
          const toolInput = payload.input && typeof payload.input === "object" ? (payload.input as Record<string, unknown>) : {};
          const narration = describeToolFromInput(text(payload.name), toolInput, tChat.toolNarration);
          if (!narration) break;
          eventedToolIdsRef.current.add(id);
          eventLogRef.current = updateStepText(eventLogRef.current, id, narration.description, narration.url);
          setStreamingEvents(eventLogRef.current.events);
          break;
        }
        case "research_saved": {
          // The research turn settled into a saved/partial/failed activity
          // (features/research.md -> "UI"): its card renders under the reply.
          const status = payload.status;
          if (text(payload.activityId) && (status === "saved" || status === "partial" || status === "failed")) announceResearchChanged();
          break;
        }
        case "page_created": {
          // Brian created a Page: it opens as a tab and the pane expands
          // (D8), and the hoisted sidebar provider reloads so it shows in the
          // Pages tree. No navigation: Chat stays the surface.
          const newPageId = text(payload.pageId);
          if (!newPageId) break;
          openInChatPane({ kind: "page", pageId: newPageId });
          window.dispatchEvent(new CustomEvent("doc:draft-created", { detail: { viewId: newPageId, action: "created" } }));
          break;
        }
        case "document_payload": {
          // Brian presenting a document opens it as a tab and expands the
          // pane (D8). Its ending never collapses the pane.
          const document = parsePresentedDocumentPayload(payload);
          if (document) openInChatPane({ kind: "document", document });
          break;
        }
        case "research_quota":
          setResearchQuota({
            used: typeof payload.used === "number" ? payload.used : 0,
            quota: typeof payload.quota === "number" ? payload.quota : 0,
            isPaid: payload.isPaid === true,
          });
          break;
        case "research_quota_exhausted":
          setResearchExhausted(true);
          setResearchMode(false);
          setResearchQuota({
            used: typeof payload.used === "number" ? payload.used : 0,
            quota: typeof payload.quota === "number" ? payload.quota : 0,
            isPaid: false,
          });
          break;
        case "mention_unreachable": {
          // D-H4: members named in the text who fail this room's clearance.
          // The turn/post already happened; never an error.
          const list = Array.isArray(payload.unreachable)
            ? (payload.unreachable as unknown[]).filter(
                (row): row is UnreachableMention =>
                  !!row && typeof row === "object" &&
                  typeof (row as UnreachableMention).id === "string" &&
                  typeof (row as UnreachableMention).name === "string",
              )
            : [];
          if (list.length > 0) setUnreachableNote(list);
          break;
        }
        case "notice":
          if (payload.code === "assistant_clearance_below_conversation") {
            const id = text(payload.assistantId);
            clearanceNamesRef.current = {
              ...clearanceNamesRef.current,
              skipped: text(payload.assistantName) || assistants.find((assistant) => assistant.id === id)?.name || null,
            };
          }
          break;
        case "error":
          if (payload.code === "assistant_clearance_below_conversation") {
            // The refused request is this send's first member (or its only one).
            clearanceNamesRef.current = {
              ...clearanceNamesRef.current,
              rejected: assistants.find((assistant) => assistant.id === sending?.assistantId)?.name ?? null,
            };
          }
          if (sending) {
            sending.localSend.release();
            if (!sending.inputSaved) sending.rollbackRecency();
          }
          if (payload.code === "research_quota_exhausted") {
            setResearchExhausted(true);
            setResearchMode(false);
          }
          break;
      }
      return;
    }
    if (!sessionId) return;
    const turnId = typeof payload.turnId === "string" ? payload.turnId : controllerRef.current?.getSnapshot().turnId ?? null;
    switch (event) {
      case "status": {
        const working = payload.status === "running";
        if (working) followSeenRef.current.running = true;
        // A GET opened just before this page's POST may carry a stale `idle`
        // frame after the optimistic start signal. Never let it erase live
        // direct ownership; a returning page trusts the server both ways.
        if (working || !stream.inFlight()) dispatchChatSessionActivity({ workspaceId, sessionId, turnId, working });
        break;
      }
      case "turn_started":
        followSeenRef.current.running = true;
        if (!replay) dispatchChatSessionActivity({ workspaceId, sessionId, turnId, working: true });
        resetRemoteLog();
        break;
      case "user_message_saved":
        // A teammate's post: the conversation asks for the history re-read.
        markRoomSeen(workspaceId, sessionId);
        break;
      case "snapshot": {
        followSeenRef.current.running = true;
        const reasoning = text(payload.reasoning);
        if (!reasoning) break;
        const next = appendReasoning(remoteLogRef.current, reasoning, mintRemoteId);
        if (next !== remoteLogRef.current) {
          remoteLogRef.current = next;
          setRemoteEvents(next.events);
        }
        break;
      }
      case "activity": {
        followSeenRef.current.running = true;
        const kind = text(payload.event);
        const id = text(payload.id);
        if (kind === "tool_start" && id && text(payload.name) && !remoteToolIdsRef.current.has(id)) {
          remoteToolIdsRef.current.add(id);
          remoteLogRef.current = appendStep(
            remoteLogRef.current,
            describeToolFromInput(text(payload.name), {}, tChat.toolNarration).description,
            mintRemoteId,
            { toolId: id },
          );
          setRemoteEvents(remoteLogRef.current.events);
        } else if (kind === "tool_input" && id && !remoteNarratedRef.current.has(id)) {
          const toolInput = payload.input && typeof payload.input === "object" ? (payload.input as Record<string, unknown>) : {};
          const narration = describeToolFromInput(text(payload.name), toolInput, tChat.toolNarration);
          if (!narration) break;
          remoteNarratedRef.current.add(id);
          remoteLogRef.current = updateStepText(remoteLogRef.current, id, narration.description, narration.url);
          setRemoteEvents(remoteLogRef.current.events);
        } else if (kind === "tool_dropped" && id) {
          remoteToolIdsRef.current.delete(id);
          remoteLogRef.current = removeToolSteps(remoteLogRef.current, id);
          setRemoteEvents(remoteLogRef.current.events);
        }
        break;
      }
      case "assistant_changed": {
        // The room's default voice is shared state: a teammate who moved it
        // must not leave everyone else asking the assistant that is no longer
        // there. Applied unconditionally, including our own echo, because the
        // server's value is the authoritative one.
        const nextId = text(payload.assistantId);
        if (!nextId) break;
        sessionAssistantRef.current.set(sessionId, nextId);
        patchSharedChatSessions(workspaceId, (rows) =>
          rows.map((row) => (row.id === sessionId ? { ...row, assistantId: nextId } : row)),
        );
        break;
      }
      case "turn_completed": {
        // A late completion of an older turn settles nothing here.
        const current = controllerRef.current?.getSnapshot().turnId ?? null;
        if (typeof payload.turnId === "string" && current && payload.turnId !== current) break;
        followSeenRef.current.completed = true;
        dispatchChatSessionActivity({ workspaceId, sessionId, turnId, working: false });
        resetRemoteLog();
        void reloadShared();
        dispatchChatSessionsRefresh(workspaceId);
        if (panePolicy.post) markRoomSeen(workspaceId, sessionId);
        refreshPendingInput(sessionId);
        break;
      }
      case "done": {
        // Reconnect mode only (a room never sends `done`): the server closes
        // once there is nothing left to attach to. The hydrate probe on an
        // idle chat (`status` then `done`) owes nothing.
        const seen = followSeenRef.current;
        followSeenRef.current = { running: false, completed: false };
        resetRemoteLog();
        if (!seen.running) break;
        if (!seen.completed) {
          dispatchChatSessionsRefresh(workspaceId);
          refreshPendingInput(sessionId);
        }
        break;
      }
    }
  };
  pageFrameRef.current = (frame) => observePageFrame(frame, false);
  replayFrameRef.current = (frame) => observePageFrame(frame, true);
  // Returning to a chat whose turn kept running while another was open: the
  // conversation kept a bounded build log of that turn, so the feed is
  // rebuilt from it and then continues from the observer.
  useLayoutEffect(() => {
    if (!controller) return;
    resetEventLog();
    resetRemoteLog();
    for (const frame of controller.getBuildLog().frames) replayFrameRef.current(frame);
  }, [controller, resetEventLog, resetRemoteLog]);

  /** Clear the conversation's error lines; a new action moves past them. */
  const dismissErrorNotices = useCallback(() => {
    const owner = controllerRef.current;
    for (const code of ["error", "stopTurnFailed", "confirmNotAllowed", "reconnectFailed"] as const) owner?.dismissNotice(code);
  }, []);
  /**
   * A silent room post (T2): send = post, instantly, for every member — one
   * durable row, no turn, no busy gate. The optimistic bubble stays; the
   * follow stream's refetch reconciles it against the stored row. Callable
   * while this client's own turn streams: posting is free in a room (D3).
   */
  const postToRoom = useCallback(
    async (
      targetId: string,
      text: string,
      reply: typeof pendingReplyRef.current,
      usesComposerTray: boolean,
    ): Promise<boolean> => {
      const sendEpoch = sessionEpochRef.current;
      const ownsPost = () =>
        sessionEpochRef.current === sendEpoch && sessionIdRef.current === targetId;
      chat.appendMessage({
        id: `local-${Date.now()}`,
        role: "user",
        text,
        timestamp: new Date(),
        ...(reply ? { replyTo: reply } : {}),
      });
      setInput("");
      setReplyTo(null);
      if (usesComposerTray) att.detach();
      setError(null);
      dismissErrorNotices();
      markRoomSeen(workspaceId, targetId);
      const rollbackRecency = promoteChatSession(workspaceId, targetId, activeContextSession?.contextProjectId);
      try {
        const posted = await postRoomMessage(
          targetId,
          text,
          reply ? { text: reply.text } : undefined,
        );
        // D-H4 — the message still posted; this is a heads-up, not an error.
        if (ownsPost() && posted.unreachableMentions.length > 0) {
          setUnreachableNote(posted.unreachableMentions);
        }
      } catch {
        rollbackRecency();
        if (ownsPost()) setError(t.postFailed);
      }
      return true;
    },
    [activeContextSession?.contextProjectId, att.detach, chat, setReplyTo, t.postFailed, workspaceId],
  );
  // Resolves TRUE once the message was dispatched (turn started / room post
  // landed), FALSE when a disqualifier dropped it: the dock's `sendMessage`
  // contract, which the recorder's voice-clip hand-off relies on: a `false`
  // keeps the clip (failure notice + spool) instead of silently dropping it.
  // The turn itself is the conversation's (`controller.send`); this decides
  // the address, the endpoint, the request extras and the surface around it.
  const send = useCallback(async (override?: {
    text?: string;
    fileIds?: string[];
    /** Recording ids for this turn instead of the composer tray (a handoff). */
    attachedRecordingIds?: string[];
    /** Research mode for this turn, ahead of the toggle's state settling. */
    researchMode?: boolean;
    truncateFromMessageId?: string;
    forceAddress?: boolean;
    /** An EDIT, not a replay: read the mentions out of the new text. A retry
     *  replays a message that already chose its responders. */
    resolveMentions?: boolean;
    /** Cmd/Ctrl+Enter during a room turn this pane does not stream (D3). */
    steer?: boolean;
  }) => {
    if (sessionIdRef.current && historyRecoverySessionId === sessionIdRef.current) return false;
    // Both views wait for the creation context (T5): a fresh pane binds its
    // Team/Project from the one hero picker before its first send.
    if(!sessionIdRef.current&&!creationContext.snapshot()){setError(view==="workspace"?t.newWorkspaceChatFailed:t.errorGeneric);return false;}
    const sendEpoch = sessionEpochRef.current;
    let owningSessionId = sessionIdRef.current;
    const ownsSend = () =>
      sessionEpochRef.current === sendEpoch && sessionIdRef.current === owningSessionId;
    const trimmed = (override?.text ?? input).trim();
    const usesComposerTray = override?.fileIds === undefined;
    const turnFileIds = override?.fileIds ?? att.fileIds();
    const turnRecordingIds =
      override?.attachedRecordingIds ??
      (usesComposerTray
        ? pendingRecordings.map((recording) => recording.recordingId)
        : []);
    const turnResearchMode = override?.researchMode ?? researchMode;
    // Snapshot the interlocutor at send time: the turn belongs to it even
    // if the resolution inputs shift while the reply streams.
    const interlocutor = activeAssistant;
    // The pending quote, snapshotted the same way. A replay (retry / edit)
    // re-sends a message that already chose its referent, so it never picks
    // up whatever quote happens to be sitting in the composer now.
    const reply = override?.truncateFromMessageId ? null : pendingReplyRef.current;
    if (
      (!trimmed && turnFileIds.length === 0 && turnRecordingIds.length === 0) ||
      !interlocutor ||
      stream.inFlight() ||
      (usesComposerTray && att.uploading) ||
      (usesComposerTray && recordingUpload.busy) ||
      pendingQuestion
    ) {
      return false;
    }

    // The address decision (multiplayer chat D1/T3, chat-parity D2): in a
    // conversation that posts and has more than one human, send = POST unless
    // this message ADDRESSES the assistant (typed @mention or the armed Ask
    // affordance); with one human every send is addressed. The server
    // re-validates either way (it alone counts the humans), so this only
    // picks the endpoint.
    // Multi-assistant conversations (T9b, chat-parity D1): every distinct `@Name` answers, in the
    // order written. A retry replays a message that already chose its
    // responders, so it stays single-assistant — a replay must not duplicate a
    // previously completed response group. An EDIT is the opposite case:
    // adding the `@Name` that was forgotten is the whole reason to edit, so
    // the new text is read fresh.
    // Resolved over the MERGED roster in one pass (T-H5/D-H2), then narrowed
    // to `WorkspaceAssistantSummary` rows: an overlapping name (an assistant
    // "Jane" and a member "Jane Doe") must resolve identically here and on
    // the server's `resolveRoomMentions`, which only a single pass over the
    // full roster can guarantee — see `partitionRoomMentions`'s doc comment.
    const mentioned =
      panePolicy.multiVoice && (!override?.truncateFromMessageId || override.resolveMentions)
        ? partitionRoomMentions(trimmed, mentionTargets)
            .assistants.map((entry) => assistants.find((a) => a.id === entry.id))
            .filter((a): a is WorkspaceAssistantSummary => !!a)
        : [];
    // Replying to an assistant asks THAT assistant, not the room's bound one.
    // A room can hold several, and quoting B's answer to ask a follow-up
    // question about it, only to have A answer, reads as the wrong assistant
    // barging in. An explicit `@mention` still wins — it names its responder.
    const repliedAssistant =
      panePolicy.multiVoice && reply?.role === "assistant" && reply.assistantId
        ? assistants.find((a) => a.id === reply.assistantId)
        : undefined;
    const targets =
      mentioned.length > 0 ? mentioned : [repliedAssistant ?? interlocutor];
    // Room posts are text-only. A file-bearing send must address the
    // assistant so the files reach `/api/chat` instead of being silently
    // discarded by the durable-post path.
    //
    // A reply to an ASSISTANT message is an address signal too, and it must be
    // computed identically here and on the server (`detectRoomAddress` reads
    // the quoted row's role): the client picks the ENDPOINT, so a client that
    // thought this was a silent post would send it somewhere the server never
    // gets to reconsider it, and the reply would go unanswered.
    const explicitAddress =
      askArmed ||
      isSlashCommandShaped(trimmed) ||
      mentioned.length > 0 ||
      reply?.role === "assistant" ||
      turnFileIds.length > 0 ||
      turnRecordingIds.length > 0 ||
      turnResearchMode ||
      override?.forceAddress === true;
    const addressed = isAddressedSend({
      policy: panePolicy,
      humanCount: paneHumanCount,
      explicit: explicitAddress,
    });
    setAskArmed(false);
    // Research is per message, like the Ask affordance above: a deep-research
    // turn takes minutes and research quota, so the toggle must never carry
    // silently into the next, ordinary question. Every send consumes it,
    // including an explicit override (handoff, onboarding seed, replay).
    setResearchMode(false);
    mentions.reset();
    // D-H4 — never survives past the message that produced it.
    setUnreachableNote([]);

    // First send in a fresh Workspace pane: create the shared thread FIRST
    // (the explicit-create API: the thread is listable by teammates from
    // this moment), then stream this message into it. Without this a
    // session-less send would mint a PERSONAL session while the UI says
    // Workspace. The create happens before the optimistic paint so a
    // failure leaves the draft in the box instead of a stranded bubble.
    if (view === "workspace" && !sessionIdRef.current) {
      if (startingShared) return false;
      setStartingShared(true);
      const creatingFeedback = beginChatSendFeedback(workspaceId, null);
      try {
        // Bind the room to the hero's picked interlocutor (default primary).
        const admitted=creationContext.snapshot();
        if(!admitted)return false;
        const created = await createWorkspaceSession(workspaceId, interlocutor.id, {
          contextGroupId: admitted.contextGroupId,
          contextProjectId: admitted.contextProjectId,
          expectedPolicyRevision:admitted.expectedPolicyRevision,
        });
        if (!ownsSend()||!creationContext.isCurrent()) return false;
        owningSessionId = created.id;
        sessionIdRef.current = created.id;
        hydratedRef.current = created.id;
        cacheCreatedChatSession(workspaceId, created, "workspace");
        sessionAssistantRef.current.set(created.id, interlocutor.id);
        selectSession(created.id, "workspace");
        dispatchChatSessionsRefresh(workspaceId);
      } catch {
        creationContext.fail();
        if (ownsSend()) setError(t.newWorkspaceChatFailed);
        return false;
      } finally {
        creatingFeedback.release();
        if (ownsSend()) setStartingShared(false);
      }
    }

    // A silent room post (T2): only a conversation that posts, with another
    // human in it, carries an unaddressed message.
    if (panePolicy.post && !addressed && sessionIdRef.current) {
      return postToRoom(sessionIdRef.current, trimmed, reply, usesComposerTray);
    }

    // "New chat" mints a fresh channel id (the §107 spec). The chat route's
    // sticky-channel fallback reunites every later turn of this conversation
    // on the row that first turn creates, even if the `session` event is
    // dropped — so we never fragment one chat across several rail rows.
    const channelId = sessionIdRef.current
      ? undefined
      : (freshChannelIdRef.current ??= crypto.randomUUID());

    const owner = conversationFor(owningSessionId);
    if (!owner) {
      setError(t.errorGeneric);
      return false;
    }
    followTranscriptRef.current = true;
    const userAttachments: MessageAttachmentRef[] = usesComposerTray
      ? readyAttachments(att.attachments).map((attachment) => ({
          id: attachment.fileId!,
          name: attachment.fileName,
          mime: attachment.mimeType,
          ...(attachment.previewUrl ? { dataUrl: attachment.previewUrl } : {}),
        }))
      : [];
    // The optimistic bubble carries the quote and the attachment previews;
    // the conversation keeps them across the server re-key. A recorder voice
    // clip (files-only, no chip) renders the voice-note marker instead of a
    // blank bubble; the wire text stays `trimmed`.
    const userMessage: Record<string, unknown> = {
      ...(userAttachments.length > 0 ? { userAttachments } : {}),
      ...(reply ? { replyTo: reply } : {}),
      ...(!trimmed && !usesComposerTray && turnFileIds.length > 0 ? { voiceNote: true } : {}),
    };
    // A send supersedes a slow read of this chat's history.
    supersedeHistoryRead();
    setError(null);
    dismissErrorNotices();
    setStopRequestedHere(null);
    resetEventLog();
    const targetIds = targets.map((assistant) => assistant.id);
    const directSessionId = owningSessionId;
    if (directSessionId) dispatchChatSessionActivity({ workspaceId, sessionId: directSessionId, working: true });
    const localSend = beginChatSendFeedback(workspaceId, directSessionId);
    const promoted = directSessionId ? promoteChatSession(workspaceId, directSessionId, activeContextSession?.contextProjectId) : null;
    let rolledBack = false;
    const sending: PageSendContext = {
      epoch: sessionEpochRef.current,
      owningSessionId: directSessionId, text: trimmed, assistantId: targetIds[0], channelId,
      contextGroupId: pickedContextGroupId, contextProjectId: pickedContextProjectId,
      inputSaved: false, localSend,
      rollbackRecency: () => { if (!rolledBack && promoted) { rolledBack = true; promoted(); } },
    };
    sendContextRef.current = sending;
    // Composer text and chips clear only once the server accepted the turn
    // (`session` or `user_message_saved`); a pre-acceptance failure leaves
    // them in the composer. Never cleared over what the user typed since.
    const clearDraft = setInput;
    let sourceMessageId: string | null = null;
    let result: ConversationSendResult;
    try {
      result = await owner.send({
        presentationId: presentationIdRef.current!,
        text: trimmed,
        fileIds: turnFileIds,
        recordingIds: turnRecordingIds,
        assistantId: targetIds[0],
        // Multi-assistant response group: one visible human message, then one
        // serialized turn per named assistant over the same saved row.
        ...(targetIds.length > 1 ? { responseGroup: targetIds } : {}),
        ...(override?.truncateFromMessageId ? { override: { truncateFromMessageId: override.truncateFromMessageId } } : {}),
        userMessage,
        bodyExtras: {
          appOrigin: APP_ORIGIN,
          // The picked tier rides every turn; the server clamps to plan.
          model,
          ...(turnResearchMode ? { mode: "research" as const } : {}),
          // The quote rides EVERY turn of a response group: the row is
          // persisted once, but each assistant needs the same referent. In a
          // room it is also an address signal (`detectRoomAddress`).
          ...(reply?.id ? { replyTo: { id: reply.id, text: reply.text } } : {}),
          // The Ask affordance marks address intent (T3); the server decides,
          // counting the humans itself (D2), so only an explicit address asks.
          ...(panePolicy.post && explicitAddress ? { ask: true } : {}),
          // A room turn is already live (a teammate's, or ours re-attached):
          // the message is saved first and ALSO handed to that turn when it
          // addresses its assistant (chat-parity D3, §6).
          ...(panePolicy.post && remoteActive && addressed
            ? { midTurn: true, ...(override?.steer ? { steer: true } : {}) }
            : {}),
          ...(!owningSessionId
            ? { contextGroupId: pickedContextGroupId, contextProjectId: pickedContextProjectId }
            : {}),
          ...(channelId ? { channelId } : {}),
        },
        onAccepted: (userMessageId) => {
          if (userMessageId) sourceMessageId ??= userMessageId;
          clearDraft((current) => (current.trim() === trimmed ? "" : current));
          setReplyTo((current) => (current === reply ? null : current));
          if (usesComposerTray) {
            att.detach();
            setPendingRecordings([]);
          }
        },
        onUserMessageSaved: (id) => {
          sending.inputSaved = true;
          sourceMessageId ??= id;
        },
        onRejected: () => {
          // Refused before anything was saved (a rejected mention, a busy
          // room): the text and quote go back to the composer if acceptance
          // had already cleared them, and the recency promotion is undone.
          sending.rollbackRecency();
          clearDraft((current) => (current.trim() ? current : trimmed));
          setReplyTo((current) => current ?? reply);
        },
      });
    } finally {
      if (sendContextRef.current === sending) sendContextRef.current = null;
    }
    if (result === "busy" || result === "empty" || result === "invalid" || result === "disposed") {
      // Nothing was dispatched: a turn still runs in this chat (re-attached,
      // or started by another presentation), or the identity changed.
      localSend.release();
      sending.rollbackRecency();
      dispatchChatSessionsRefresh(workspaceId);
      // A send is never a silent no-op: hand plain text to the running turn
      // the same way a mid-turn send does, otherwise say why nothing went.
      if (result === "busy") {
        const taken = midTurnRoute === "client_queue" && usesComposerTray && turnFileIds.length === 0 &&
          turnRecordingIds.length === 0 && !!trimmed &&
          owner.queue(trimmed, override?.steer === true, { assistantId: targetIds[0] });
        if (taken) {
          clearDraft((current) => (current.trim() === trimmed ? "" : current));
          setReplyTo((current) => (current === reply ? null : current));
          return true;
        }
        setError(t.sendWhileTurnRunning);
      }
      return false;
    }
    if (result === "completed" || result === "queued") localSend.complete(owner.getSnapshot().turnId);
    else localSend.release();
    if (result === "failed" && !sending.inputSaved) sending.rollbackRecency();
    const settledSessionId = sending.owningSessionId;
    if (settledSessionId && result !== "disconnected") {
      dispatchChatSessionActivity({ workspaceId, sessionId: settledSessionId, turnId: owner.getSnapshot().turnId, working: false });
    }
    if (!ownsSend() && sessionIdRef.current !== settledSessionId) return false;
    owningSessionId = settledSessionId;
    if (result === "completed" && panePolicy.post && settledSessionId) markRoomSeen(workspaceId, settledSessionId);
    if (result === "completed") void reloadShared();
    // The turn may have auto-titled the thread; a failed one is reconciled
    // from persisted status rather than declared idle.
    dispatchChatSessionsRefresh(workspaceId);
    // Reconcile once after the whole serialized group, not after each member:
    // this makes persisted sender attribution authoritative without letting
    // an earlier fetch erase a later assistant's live/final row. It also
    // catches teammate posts and restores older history when this send
    // superseded a cold read, including in a personal chat.
    if (sourceMessageId && settledSessionId && sessionIdRef.current === settledSessionId) {
      await loadTranscript(settledSessionId, { force: true });
    }
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyRecoverySessionId, creationContext, input, activeAssistant, activeSessionId, activeContextSession?.contextProjectId, panePolicy, paneHumanCount, remoteActive, postToRoom, askArmed, model, researchMode, view, workspaceId, pickedContextGroupId, pickedContextProjectId, reloadShared, selectSession, startingShared, stream, t, att.attachments, att.uploading, att.fileIds, att.detach, pendingQuestion, pendingRecordings, recordingUpload.status, assistants, mentions.reset, setReplyTo, conversationFor, supersedeHistoryRead, dismissErrorNotices, resetEventLog, loadTranscript]);

  // While this full-page surface is mounted it IS the visible chat, so a
  // short capture's voice turn must land in the open thread here — never in
  // the hidden dock chat (the skill-rail / Feed-panel recipe). The target is
  // read at hand-off time only, so re-registering as `send` recomputes is
  // harmless.
  useEffect(
    () =>
      registerDockRecorderChatTarget({
        sendVoiceClip: (fileId) => send({ text: "", fileIds: [fileId] }),
        getSessionId: () => sessionIdRef.current ?? undefined,
        ...(voiceInteractionHere ? { ensureInteractionSession: async () => {
          if (sessionIdRef.current) return sessionIdRef.current;
          if (!activeAssistant) throw new Error(t.errorGeneric);
          const epoch = sessionEpochRef.current;
          const assistantId = activeAssistant.id;
          const channelId = freshChannelIdRef.current ??= crypto.randomUUID();
          const response = await authFetch(`${API_URL}/api/sessions/personal`, {
            signal: AbortSignal.timeout(5_000),
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId, assistantId, channelId, contextGroupId: pickedContextGroupId, contextProjectId: pickedContextProjectId }),
          });
          if (!response.ok) throw new Error(t.errorGeneric);
          const { session: created } = await response.json();
          if (sessionEpochRef.current !== epoch) throw new Error("Chat changed");
          if (sessionIdRef.current) return sessionIdRef.current;
          sessionIdRef.current = created.id;
          hydratedRef.current = created.id;
          sessionAssistantRef.current.set(created.id, assistantId);
          selectSession(created.id, "personal", true);
          dispatchChatSessionsRefresh(workspaceId);
          return created.id as string;
        } } : {}),
      }),
    [send, voiceInteractionHere, activeAssistant, workspaceId, pickedContextGroupId, pickedContextProjectId, selectSession, t.errorGeneric],
  );

  /** The Ask toggle and chord: only where a plain send would post (D2). */
  const askVisible = askAffordanceVisible(panePolicy, paneHumanCount);
  /** A room turn this pane does not stream (a teammate's, or a re-attached
   *  one): an addressed send joins it rather than queueing a follow-up (D3). */
  const roomTurnLive =
    !chat.state.isStreaming && remoteActive && midTurnRoute === "room_inbox";

  /**
   * A send while THIS client's turn streams (chat-parity D3, §6). A personal
   * chat hands the message to the running turn and holds it until taken. A
   * room posts it first: an unaddressed message is just a post; an addressed
   * one is also handed to the running turn, held here only for its tray
   * (`serverHeld`), since the server owns its fallback (the room's follow-up
   * turn). A steer is always addressed.
   */
  const sendDuringTurn = useCallback(
    (steer: boolean): boolean => {
      const text = input.trim();
      if (!text) return false;
      // The conversation holds a personal chat's message until the running
      // turn takes it; an uncertain one comes back to the composer, never resent.
      if (midTurnRoute === "client_queue") {
        return controllerRef.current?.queue(text, steer, { assistantId: activeAssistant?.id ?? null }) ?? false;
      }
      if (midTurnRoute !== "room_inbox") return false;
      const sessionId = sessionIdRef.current;
      if (!sessionId) return false;
      const reply = pendingReplyRef.current;
      const mentioned = partitionRoomMentions(text, mentionTargets)
        .assistants.map((entry) => assistants.find((a) => a.id === entry.id))
        .filter((a): a is WorkspaceAssistantSummary => !!a);
      const replied =
        reply?.role === "assistant" && reply.assistantId
          ? assistants.find((a) => a.id === reply.assistantId)
          : undefined;
      const explicit =
        steer || askArmed || mentioned.length > 0 || reply?.role === "assistant" ||
        isSlashCommandShaped(text);
      setAskArmed(false);
      mentions.reset();
      setUnreachableNote([]);
      if (!isAddressedSend({ policy: panePolicy, humanCount: paneHumanCount, explicit })) {
        void postToRoom(sessionId, text, reply, false);
        return true;
      }
      const target = mentioned[0] ?? replied ?? activeAssistant;
      const queued = controllerRef.current?.queue(text, steer, {
        serverHeld: true,
        assistantId: target?.id ?? null,
        bodyExtras: {
          ask: true,
          ...(reply?.id ? { replyTo: { id: reply.id, text: reply.text } } : {}),
        },
      }) ?? false;
      if (queued) setReplyTo(null);
      return queued;
    },
    [activeAssistant, askArmed, assistants, input, mentionTargets, mentions.reset, midTurnRoute, paneHumanCount, panePolicy, postToRoom, setReplyTo],
  );

  const captureComposerDraft = ():RecoverableChatDraft|null => {
    if (!input.trim() && !att.hasReady && pendingRecordings.length===0) return null;
    return {id:crypto.randomUUID(),text:input,sessionId:activeSessionId,assistantId:activeAssistant?.id??null,
      contextProjectId:pickedContextProjectId,contextGroupId:pickedContextGroupId,view,attachments:att.attachments.filter(chip=>chip.status==='done'),recordings:pendingRecordings,researchMode};
  };
  useChatHandoff({
    workspaceId,assistantsLoaded,blocked:att.uploading||recordingUpload.busy,
    activeSessionId,activeAssistantId:activeAssistant?.id??null,view,
    prepare(handoff) {
      const draft=captureComposerDraft();if(draft)updateRecoveryDrafts([...recoveryDrafts,draft]);
      handoffAssistantRef.current=handoff.assistantId;
      resetPane();setPendingRecordings([]);setReplyTo(null);pendingReplyRef.current=null;setSelectionQuote(null);
      setPickedContextGroupId(null);setPickedContextProjectId(handoff.contextProjectId??null);setResearchMode(handoff.researchMode??false);setAskArmed(false);
      setPickedAssistantId(handoff.assistantId);seededRef.current=null;setRestoring(null);
      router.replace(personalChatHandoffPath(workspaceId,handoff.assistantId,handoff.requestId),{scroll:false});
    },
    async validateAssistant(id) {
      return (await listWorkspaceAssistants(workspaceId)).some(assistant=>assistant.id===id) && assistants.some(assistant=>assistant.id===id);
    },
    async send(handoff) {
      handoffAssistantRef.current=null;
      if(handoff.draftOnly){setInput(handoff.text);return true;}
      return send({text:handoff.text,fileIds:handoff.fileIds??[],attachedRecordingIds:handoff.attachedRecordingIds??[],researchMode:handoff.researchMode??false});
    },
    preserveUnsent(handoff) {
      if(!meId)return;
      const drafts=readChatDrafts(workspaceId,meId),id=handoff.requestId??crypto.randomUUID();
      if(!drafts.some(draft=>draft.id===id))writeChatDrafts(workspaceId,meId,[...drafts,{id,text:handoff.text,sessionId:null,
        assistantId:handoff.assistantId,contextProjectId:handoff.contextProjectId,view:'personal',attachments:[],recordings:[],researchMode:!!handoff.researchMode}]);
    },
    prefill(handoff) {
      if (input.trim()) {
        updateRecoveryDrafts([...recoveryDrafts,{id:handoff.requestId??crypto.randomUUID(),text:handoff.text,sessionId:null,
          assistantId:handoff.assistantId,contextProjectId:handoff.contextProjectId,view:'personal',attachments:[],recordings:[],researchMode:!!handoff.researchMode}]);
      } else setInput(handoff.text);
      setError(searchCopy.assistantUnavailable);
    },
  });
  const restoreComposerDraft = (draft:RecoverableChatDraft) => {
    if(att.uploading||recordingUpload.busy)return;
    const current=captureComposerDraft();
    updateRecoveryDrafts([...recoveryDrafts.filter(row=>row.id!==draft.id),...(current?[current]:[])]);
    handoffAssistantRef.current=draft.assistantId;
    resetPane();setPendingRecordings(draft.recordings);att.restore(draft.attachments,conversationAttachmentTray(workspaceId,trayPartFor(draft.sessionId,draft.view)));setInput(draft.text);
    setResearchMode(draft.researchMode);setReplyTo(null);pendingReplyRef.current=null;setSelectionQuote(null);
    setPickedAssistantId(draft.assistantId);selectSession(draft.sessionId,draft.view);
    if(!draft.sessionId){setPickedContextProjectId(draft.contextProjectId??null);setPickedContextGroupId(draft.contextGroupId??null);}
  };

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

  // ── Editing a sent message ──────────────────────────────────────────
  //
  // The repair this exists for: a room message that reads correctly but
  // addresses nobody. Adding `@Name` to it must not mean retyping it.

  // The hook's own callback, not the hook object: `editMentions` is a fresh
  // object every render, and these callbacks are effect dependencies.
  const resetEditMentions = editMentions.reset;

  const startEdit = useCallback(
    (message: SurfaceMessage) => {
      setEditingMessageId(message.id);
      setEditingText(message.text);
      // A message that already ends in a mention opens settled, not mid-query.
      resetEditMentions(message.text);
    },
    [resetEditMentions],
  );

  const cancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditingText("");
    resetEditMentions();
  }, [resetEditMentions]);

  const saveEdit = useCallback(
    async (messageId: string) => {
      if (stream.inFlight()) return;
      const messages = chat.state.messages as SurfaceMessage[];
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return;
      const original = messages[index];
      const next = editingText.trim();
      if (!next || next === original.text) {
        cancelEdit();
        return;
      }
      // D-H4 — a stale note from a previous send/edit must not survive an
      // edit that turns out to name nobody unreachable.
      setUnreachableNote([]);
      const dispatch = resolveEditDispatch({
        // Only a conversation that posts keeps an unanswered edit a post.
        isRoom: panePolicy.post,
        newText: next,
        roster: mentionTargets,
        answered: messages[index + 1]?.role === "assistant",
      });
      cancelEdit();

      if (dispatch === "turn") {
        // Destroy-and-regenerate: drop this row and everything after locally,
        // and let the server truncate from the same anchor and rebuild.
        chat.loadMessages(messages.slice(0, index));
        await send({
          text: next,
          truncateFromMessageId: messageId,
          forceAddress: true,
          resolveMentions: true,
        });
        return;
      }

      // A silent post that stays silent: rewrite the stored row, run no turn.
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      chat.loadMessages(
        messages.map((message, position) =>
          position === index ? { ...message, text: next } : message,
        ),
      );
      try {
        const edited = await editRoomMessage(sessionId, messageId, next);
        // D-H4 — the edit still saved; this is a heads-up, not an error.
        if (edited.unreachableMentions.length > 0) {
          setUnreachableNote(edited.unreachableMentions);
        }
      } catch {
        setError(t.editFailed);
        // The optimistic rewrite has to go back — the room still holds the
        // original text and every other member is still reading it.
        await loadTranscript(sessionId, { force: true });
      }
    },
    [
      activeSessionId,
      panePolicy.post,
      cancelEdit,
      chat,
      editingText,
      loadTranscript,
      mentionTargets,
      send,
      stream,
      t,
      view,
    ],
  );

  // A moving transcript invalidates the row under the editor: a teammate's
  // post, a landing reply, or switching threads all mean the anchor may be
  // gone. Close rather than save into the wrong place.
  useEffect(() => {
    if (!editingMessageId) return;
    const stillThere = (chat.state.messages as SurfaceMessage[]).some(
      (message) => message.id === editingMessageId,
    );
    if (!stillThere) cancelEdit();
  }, [chat.state.messages, editingMessageId, cancelEdit]);

  useEffect(() => {
    cancelEdit();
  }, [activeSessionId, cancelEdit]);

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
  const workBenchResearchPhase = chat.state.isStreaming
    ? researchPhase
    : remoteActive
      ? remoteResearchPhase
      : null;
  const workBenchCurrentStep = workBenchWaiting
    ? pendingQuestion?.question ?? tChat.thinking
    : workBenchRunningTool?.description ??
      (chat.state.isStreaming && chat.state.streamingText
        ? tChat.activity.writing
        : remoteActive && remoteText
          ? tChat.activity.writing
          : workBenchResearchPhase
            ? tChat.researchStatus[workBenchResearchPhase]
            : tChat.thinking);
  const workBenchAssistant = resolveWorkBenchAssistant({
    roster: assistants,
    fallback: activeAssistant,
    localActive: chat.state.isStreaming,
    localAssistantId: convo?.liveAssistantId ?? null,
    remoteActive,
    remoteAssistantId,
    waitingForInput: workBenchWaiting,
  });

  /**
   * When this client last saw the running turn do anything — a tool step, a
   * reasoning line, reply text — across BOTH the direct stream and the room
   * mirror. Seeded when the turn goes active so a turn that emits nothing at
   * all still ages visibly.
   *
   * Deliberately a different question from the server's lease: the lease says
   * the turn's process is alive, this says the user can see it working. A turn
   * suspended on a tool confirmation is alive with no progress, and conflating
   * the two would either kill healthy turns or hide dead ones.
   */
  const [lastProgressAt, setLastProgressAt] = useState<number | null>(null);
  useEffect(() => {
    if (!workBenchTurnActive) {
      setLastProgressAt(null);
      return;
    }
    setLastProgressAt(Date.now());
  }, [
    workBenchTurnActive,
    chat.state.streamingText,
    toolTimeline.length,
    remoteText,
    remoteEvents.length,
    remoteTools.length,
    remoteResearchPhase,
  ]);

  /** A conversation without a whole-life follow stream re-attaches per turn;
   *  keep the composer's Stop while that re-attached mirror carries a turn
   *  this tab lost its direct stream to (the Live card's Stop is there too).
   *  The Work Bench Stop (T5 recovery) is the same entry point: the server
   *  decides whether it aborts a live turn or reclaims a stalled lease, and
   *  every viewer gets a `turn_completed` carrying the reason. */
  const mirrorStopAvailable =
    !panePolicy.presence &&
    remoteActive &&
    !!activeSessionId;

  const displayTimeline = useMemo(() => (chat.state.messages as SurfaceMessage[]).map((message, canonicalIndex) => ({
    historicalDisplayOnly: message.historyUnavailable === true, message, canonicalIndex,
    row: { id: message.id, role: message.role, timestamp: Number.isNaN(message.timestamp.getTime()) ? "" : message.timestamp.toISOString(), sequence: canonicalIndex + 1,
      available: false, text: null },
  })), [chat.state.messages]);
  // Group the visible conversation, including owner-readable historical replies.
  // Canonical indexes still address only actionable/currently admitted messages.
  const transcriptMeta = useMemo(() => computeTranscriptRowMeta(displayTimeline.map(entry =>
    entry.historicalDisplayOnly ? { role: entry.row.role, timestamp: new Date(entry.row.timestamp) } : entry.message)),
    [displayTimeline]);

  /** The typing indicator's line: one named typist, two named, or several. */
  const typingLabel = useMemo(() => {
    if (roomTypers.length === 0) return null;
    const names = roomTypers
      .map((v) => v.name)
      .filter((n): n is string => !!n);
    if (roomTypers.length === 1) {
      return names[0]
        ? format(t.typingOne, { name: names[0] })
        : t.typingSomeone;
    }
    if (roomTypers.length === 2 && names.length === 2) {
      return format(t.typingTwo, { a: names[0], b: names[1] });
    }
    return t.typingMany;
  }, [roomTypers, t]);

  /** The answering assistant's display name for a reply-group header. */
  const assistantNameFor = (senderAssistantId?: string | null, publishedSenderName?: string | null) =>
    publishedSenderName != null ? publishedSenderName || publishedAssistantLabel : ((senderAssistantId
      ? assistants.find((x) => x.id === senderAssistantId)
      : undefined) ?? activeAssistant)?.name ?? null;

  /** The reply avatar for a given ANSWERING assistant (multi-assistant
   *  rooms, T9) — falls back to the thread's bound assistant. */
  const avatarFor = (senderAssistantId?: string | null, publishedSenderName?: string | null) => {
    if (publishedSenderName != null) return (
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
        <Sparkles className="size-3.5" aria-hidden />
      </div>
    );
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

  /** Display label for the author of a quoted row. */
  const quoteAuthorFor = (message: SurfaceMessage): string | null =>
    message.role === "user"
      ? message.senderName ?? t.replyAuthorYou
      : assistantNameFor(message.senderAssistantId, message.publishedSenderName);

  /**
   * The quote above a message that replied to something.
   *
   * Restored quotes carry text and nothing else (the stored field is a
   * snapshot, not a link), so this renders no author line and no jump
   * affordance — it says what was quoted, which is what the reader needs to
   * follow the thread.
   */
  const quotedBlock = (reply: ReplyTo, alignEnd: boolean) => (
    <div
      className={cn(
        "max-w-[85%] border-l-2 border-border/80 pl-2",
        alignEnd && "self-end",
      )}
    >
      <p className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">
        {condenseQuote(reply.text)}
      </p>
    </div>
  );

  const messageActions = (
    messageId: string,
    text: string,
    alignEnd: boolean,
    onRetry?: () => void,
    onEdit?: () => void,
    onReply?: () => void,
    /** Assistant rows only: jump to the Brain's Audit section on this turn
     *  (which tools ran, which entries were retrieved, lit on the graph). */
    onAudit?: () => void,
  ) => (
    <div
      // Always visible on a phone (responsive contract M2): a finger has no
      // hover, and Retry / Edit / Reply / Audit had no touch path. Desktop
      // keeps the hover reveal.
      className={cn(
        "flex items-center gap-1 pt-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100",
        alignEnd ? "-mr-1" : "-ml-1",
      )}
    >
      {onReply ? (
        <button
          type="button"
          // Keep the selection alive: the mousedown that focuses a button
          // would otherwise collapse it, and the selection IS the quote.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onReply}
          aria-label={t.reply}
          title={t.reply}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-7 md:w-7"
        >
          <Reply className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => handleCopy(messageId, text)}
        aria-label={copiedMessageId === messageId ? tChat.copied : tChat.copy}
        title={copiedMessageId === messageId ? tChat.copied : tChat.copy}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-7 md:w-7"
      >
        {copiedMessageId === messageId ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          aria-label={t.editMessage}
          title={t.editMessage}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-7 md:w-7"
        >
          <Pencil className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          aria-label={tChat.retry}
          title={tChat.retry}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-7 md:w-7"
        >
          <RotateCw className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {onAudit ? (
        <button
          type="button"
          onClick={onAudit}
          aria-label={t.auditTurn}
          title={t.auditTurn}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-7 md:w-7"
        >
          <Route className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );

  /** The inline editor that replaces a user bubble while it is being edited.
   *  The same composite box, the same `@` autocomplete and the same mention
   *  chips as the composer — adding the mention that was forgotten is the
   *  reason this affordance exists, so it cannot be a plainer field. */
  const messageEditor = (messageId: string) => (
    <div
      ref={editMentions.containerRef}
      className="relative w-full max-w-[85%]"
    >
      <MentionAutocompleteList
        mentions={editMentions}
        className="bottom-full right-0 mb-1"
      />
      <div
        className={cn(
          "rounded-2xl rounded-br-md border border-border bg-background shadow-sm",
          "focus-within:border-ring [&_:focus-visible]:shadow-none",
        )}
      >
      {draftStorageFailed && <p role="status" className="text-xs text-muted-foreground">{draftWarning}</p>}
      <ChatComposer
          value={editingText}
          onChange={setEditingText}
          onKeyDown={(event) => {
            editMentions.handleKeyDown(event);
            if (event.defaultPrevented) return;
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          onSend={() => void saveEdit(messageId)}
          highlightRanges={editMentions.highlightRanges}
          inputWrapClassName="order-1 col-span-2 min-w-0"
          rowClassName="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 px-2 pb-2"
          textareaClassName={cn(
            "w-full max-h-[min(240px,30dvh,var(--chat-input-max-height,240px))] min-w-0 resize-none overflow-y-auto",
            "bg-transparent px-1.5 pt-3 pb-2 text-[16px] leading-6 outline-none md:pt-4",
            "placeholder:text-muted-foreground focus-visible:shadow-none",
          )}
          placeholder={t.composerPlaceholder}
          sendLabel={
            <>
              <Check className="size-4" aria-hidden />
              <span className="sr-only">{t.editSave}</span>
            </>
          }
          sendButtonClassName={cn(
            "order-3 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            "bg-action text-action-foreground transition-colors hover:bg-action/90",
            "focus-visible:shadow-none disabled:pointer-events-none disabled:opacity-40",
          )}
          slotPostInput={
            <button
              type="button"
              onClick={cancelEdit}
              aria-label={t.editCancel}
              title={t.editCancel}
              className="order-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:shadow-none"
            >
              <X className="size-4" aria-hidden />
            </button>
          }
        />
      </div>
      <p className="mt-1 px-1 text-right text-[11px] text-muted-foreground">
        {panePolicy.post ? t.editHintRoom : t.editHint}
      </p>
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
  const visibleViewportRef = useChatVisibleViewport();

  const askControl = askVisible && activeAssistant && (
    <button
      type="button"
      onClick={() => setAskArmed((v) => !v)}
      aria-pressed={askArmed}
      // The chord rides the accessible name too: the printed chip is
      // `aria-hidden` (it is a rendering of the same fact), so this
      // is the only place a screen reader hears it.
      aria-label={`${format(t.askLabel, {
        name: activeAssistant.name,
      })} · ${format(t.askShortcutHint, {
        keys: accelEnterLabel(),
      })}`}
      // The chord lives ON the control it replaces — the toggle is
      // where someone looks when they are tired of reaching for it.
      // Printed beside the label rather than left to the tooltip: a
      // hover-only hint is found by the pointer users who need it
      // least. The tooltip keeps the fuller sentence.
      title={`${t.askArmedAria} · ${format(t.askShortcutHint, {
        keys: accelEnterLabel(),
      })}`}
      className={cn(
        "flex min-h-8 min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:shadow-none max-md:min-h-11",
        askArmed
          ? "bg-primary/15 text-primary ring-1 ring-primary/30"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <AtSign className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        {format(t.askLabel, { name: activeAssistant.name })}
      </span>
      {/* `shrink-0` beside the label's `truncate` keeps the control
          row one line as the group narrows: the name gives way, the
          chord does not. Dropped below `sm`, where the row has no
          width to spare and the tooltip still carries it. */}
      <kbd
        aria-hidden
        className={cn(
          "hidden shrink-0 font-sans text-[10px] font-normal sm:inline",
          askArmed ? "text-primary/70" : "text-muted-foreground/70",
        )}
      >
        {accelEnterLabel()}
      </kbd>
    </button>
  );

  /** Interlocutor control, rendered INSIDE the composer box (bottom-left):
   *  a NEW personal chat picks its assistant here and the session sticks to
   *  it (sessions are assistant-bound; the server rejects a mismatched
   *  send). An open PERSONAL thread shows its bound assistant as a static
   *  label — never a mid-thread switch. A fresh Workspace pane picks the
   *  assistant the new ROOM will bind, and an OPEN room keeps the picker:
   *  the binding is the room's default voice, not a fence, and every member
   *  who can post may move it (`PATCH /api/sessions/:id/assistant`). A
   *  single-assistant workspace degrades to the static label. */
  const interlocutorControl =
    activeAssistant &&
    (!att.uploading && isAssistantPickerLive({
      rosterSize: assistants.length,
    }) ? (
      <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
        <PopoverTrigger
          className="flex size-11 shrink-0 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:shadow-none @[560px]/chat-reading:h-9 @[560px]/chat-reading:w-auto @[560px]/chat-reading:max-w-48 @[560px]/chat-reading:min-w-9 @[560px]/chat-reading:shrink @[560px]/chat-reading:px-2"
          data-chat-assistant-control
          title={activeAssistant.name}
          aria-label={`${tChat.switchAssistant}: ${activeAssistant.name}`}
        >
          <AssistantAvatar
            id={activeAssistant.id}
            name={activeAssistant.name}
            iconSeed={activeAssistant.iconSeed ?? undefined}
            size="xs"
          />
          <span className="hidden min-w-0 truncate @[560px]/chat-reading:inline">{activeAssistant.name}</span>
          <ChevronDown
            className="hidden size-3.5 shrink-0 text-muted-foreground @[560px]/chat-reading:block"
            aria-hidden
          />
        </PopoverTrigger>
        <PopoverContent
          side="top"
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
                void pickAssistant(a.id);
                setSwitcherOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors max-md:min-h-11",
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
              <span className="min-w-0 flex-1 break-words">{a.name}</span>
              {a.id === activeAssistant.id ? (
                <Check className="size-4 shrink-0 text-primary" aria-hidden />
              ) : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    ) : (
      <div data-chat-assistant-control title={activeAssistant.name} aria-label={activeAssistant.name} className="flex size-11 shrink-0 items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground @[560px]/chat-reading:h-9 @[560px]/chat-reading:w-auto @[560px]/chat-reading:max-w-48 @[560px]/chat-reading:min-w-9 @[560px]/chat-reading:shrink @[560px]/chat-reading:px-2">
        <AssistantAvatar
          id={activeAssistant.id}
          name={activeAssistant.name}
          iconSeed={activeAssistant.iconSeed ?? undefined}
          size="xs"
        />
        <span className="hidden min-w-0 truncate @[560px]/chat-reading:inline">{activeAssistant.name}</span>
      </div>
    ));

  /**
   * Resolve a pending write confirmation: the conversation posts
   * `/api/chat/confirm` for a live card and the canonical approval response
   * for a restored one. In a room the SERVER gates who may act: the turn's
   * addresser or a workspace admin (T11/D8); a 403 surfaces as the quiet
   * not-allowed note, never a broken card.
   */
  /** Cards this viewer was refused on (403): a teammate who may not act
   *  keeps seeing the card, without Approve/Deny, until it is resolved. */
  const [refusedConfirmations, setRefusedConfirmations] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const resolveConfirmation = useCallback(
    async (toolCallId: string, action: "approve" | "deny", comment?: string) => {
      const outcome = await controllerRef.current?.respondConfirmation(toolCallId, action, comment);
      if (outcome === "resolved") requestApprovalsRefresh(workspaceId);
      if (outcome === "forbidden") setRefusedConfirmations((current) => new Set([...current, toolCallId]));
    },
    [workspaceId],
  );

  /** The composer, styled as the app's composite-control box (globals.css
   *  contract): ONE bordered box carrying the focus ring via `focus-within`,
   *  every inner focusable opting out of the global ring. Textarea on top;
   *  a control row beneath with the interlocutor control left and an icon Send
   *  (Stop while streaming) right. Rendered in the hero (centered) or the
   *  bottom bar — same node either way. */
  const composerBox = (
    <>
      {/* The shared recorder status stays next to the composer at every
          width. Its controller survives welcome/thread and route changes. */}
      {dockRecorder ? (
        <>
          <DockRecorderRecovery rec={dockRecorder} className="mb-1.5" />
          <DockRecorderNotice rec={dockRecorder} className="mb-1.5 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11" />
          <DockRecorderStrip rec={dockRecorder} className="mb-1.5" />
        </>
      ) : null}
    <div
      ref={mentions.containerRef}
      data-brian-chat-composer
      className={cn(
        "relative rounded-[20px] border border-border/80 bg-background shadow-sm md:rounded-3xl md:shadow-[0_3px_18px_-8px_rgba(0,0,0,0.18)]",
        "[&_:focus-visible]:shadow-none",
        styles.composerFrame,
      )}
    >
      {/* Mention autocomplete — the merged roster (T-H4/T-H5): the workspace
          assistants plus this room's clearance-passing members. Rendered
          above the box so it never shifts the composer. */}
      <MentionAutocompleteList
        mentions={mentions}
        className="bottom-full left-2 mb-1"
      />
      {/* Slash-command menu — same anchor box, mutually exclusive query. */}
      <SlashCommandMenuList
        commands={slashCommands}
        className="bottom-full left-2 mb-1"
      />
      {recoveryDrafts.length>0 && <details className="border-b p-2 text-sm">
        <summary className="min-h-8 max-md:min-h-11 cursor-pointer py-3">{searchCopy.savedDrafts}</summary>
        {recoveryDrafts.map(draft=><button key={draft.id} type="button" disabled={att.uploading||recordingUpload.busy}
          onClick={()=>restoreComposerDraft(draft)} className="flex min-h-8 max-md:min-h-11 w-full items-center gap-2 rounded px-2 text-left hover:bg-muted">
          <span className="shrink-0">{searchCopy.restoreDraft}</span><span className="truncate">{draft.text||searchCopy.attachmentDraft}</span>
        </button>)}
      </details>}
      <ChatComposer
        appearance="app"
        sendButtonTone={canQueueMidTurn && chat.state.replyPhase === "generating" ? "secondary" : "primary"}
        value={input}
        onChange={setInput}
        onKeyDown={(event) => {
          slashCommands.handleKeyDown(event);
          if (event.defaultPrevented) return;
          mentions.handleKeyDown(event);
          if (event.defaultPrevented) return;
          // Escape drops the quote before it drops anything else — the
          // autocomplete above already consumed the key if it was open.
          if (event.key === "Escape" && pendingReply) {
            event.preventDefault();
            setReplyTo(null);
          }
        }}
        highlightRanges={[
          ...slashCommands.highlightRanges,
          ...mentions.highlightRanges,
        ]}
        inputWrapClassName="col-span-4 col-start-1 row-start-1 min-w-0"
        // While a turn streams, Send QUEUES into the running turn and
        // Cmd/Ctrl+Enter steers, in every Chat conversation (D3). In a room the
        // message is a post first: an unaddressed one just posts, an addressed
        // one is also handed to the running turn.
        // See docs/architecture/engine/mid-turn-input.md.
        onSend={() =>
          canQueueMidTurn && sendDuringTurn(false)
            ? setInput("")
            : void send()
        }
        onSteer={
          canQueueMidTurn
            ? () => {
                if (sendDuringTurn(true)) setInput("");
              }
            : roomTurnLive
              ? () => void send({ forceAddress: true, steer: true })
              : undefined
        }
        // Cmd/Ctrl+Enter = send AND ask where a plain send would only post (a
        // room with more than one human), so addressing the assistant never
        // costs a trip to the pointer. While a turn is live the steer above
        // wins (the composer's intent resolver) and a steer is addressed too.
        // With one human every send is addressed already, so it stays unwired.
        onAsk={
          askVisible && activeAssistant
            ? () => void send({ forceAddress: true })
            : undefined
        }
        // Drafting needs no authority read; only dispatch waits for context.
        disabled={!!pendingQuestion}
        // Mid-turn sends are text-only: an attachment needs the full pre-turn
        // pipeline, which belongs to a turn of its own. Staged chips stay
        // visible and ride the next turn.
        sendDisabled={
          (!activeSessionId && !creationContext.ready) ||
          (activeSessionId !== null && historyRecoverySessionId === activeSessionId) ||
          (chat.state.isStreaming && !canQueueMidTurn) ||
          (canQueueMidTurn && (att.hasReady || pendingRecordings.length > 0)) ||
          !activeAssistant ||
          att.uploading ||
          recordingUpload.busy
        }
        allowEmptySend={att.hasReady || pendingRecordings.length > 0}
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
            <ArrowUp className="size-[18px] shrink-0" aria-hidden />
            <span className="sr-only">{t.send}</span>
          </>
        }
        // The two trailing tracks keep Send + Stop together (D3). Narrow
        // panes use one icon-led toolbar; CSS
        // placement keeps controls mounted while the pane is resized.
        rowClassName="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-0.5 gap-y-1 px-2 pb-2 @[560px]/chat-reading:gap-x-1 @[560px]/chat-reading:gap-y-2 @[560px]/chat-reading:px-3 @[560px]/chat-reading:pb-3"
        // Layout (grid placement) lives on `inputWrapClassName` above so the
        // mention-chip mirror shares this box exactly; only the typography and
        // padding the two layers must agree on stay here.
        textareaClassName={cn(
          "w-full max-h-[min(240px,30dvh,var(--chat-input-max-height,240px))] min-w-0 resize-none overflow-y-auto",
          "bg-transparent px-1.5 pt-3 pb-2 text-[16px] leading-6 outline-none @[560px]/chat-reading:pt-4",
          "placeholder:text-muted-foreground focus-visible:shadow-none",
        )}
        slotAttachments={
          <>
            {/* The composer receipt yields to the inline pursuit card once the
                session-goals fetch lands (one stream, one surface); it still
                covers the gap between the SSE signal and that fetch. */}
            {acceptedGoal?.sessionId === activeSessionId &&
            !sessionGoals.some((goal) => goal.id === acceptedGoal.goalId) ? (
              <GoalAcknowledgement
                notice={acceptedGoal}
                workspaceId={workspaceId}
                labels={{
                  accepted: t.goalAcceptedLabel,
                  executing: t.goalAcceptedStatus,
                  done: t.goalAcceptedDone,
                  blocked: t.goalAcceptedBlocked,
                  abandoned: t.goalAcceptedAbandoned,
                  open: t.goalAcceptedOpen,
                  dismiss: t.goalAcceptedDismiss,
                }}
                onDismiss={() => setAcceptedGoal(null)}
                className="mx-3 mt-2.5"
              />
            ) : null}
            <SlashCommandIndicator
              commands={slashCommands}
              className="mx-3 mt-2.5"
            />
            {/* The pending quote, above the field it belongs to. Dismissible,
                because arming a reply and then deciding to say something
                unrelated must not cost a page of scrolling to undo. */}
            {pendingReply ? (
              <div className="flex items-start gap-2 px-3 pt-2.5">
                <div className="min-w-0 flex-1 border-l-2 border-primary/60 pl-2">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {pendingReply.authorName
                      ? t.replyingTo.replace("{name}", pendingReply.authorName)
                      : t.replyingToMessage}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {condenseQuote(pendingReply.text)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setReplyTo(null)}
                  aria-label={t.replyCancel}
                  title={t.replyCancel}
                  className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
            ) : null}
            <AttachmentChips
              attachments={att.attachments}
              onRemove={att.remove}
              className="px-3 pt-2.5"
            />
            {pendingRecordings.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                {pendingRecordings.map((recording) => (
                  <span
                    key={recording.recordingId}
                    className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    <span aria-hidden>◉</span>
                    {tRecordings.chatStagedChip.replace("{name}", recording.title)}
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
              status={recordingUpload.status}
              uploadProgress={recordingUpload.uploadProgress}
              message={recordingUpload.message}
              className="px-1"
            />
          </>
        }
        slotPreInput={
          <>
          {/* Stable controls share one line; compact panes omit assistant names
              and rehost secondary actions in Add without moving the recorder. */}
          <div data-chat-composer-settings className="col-start-2 row-start-2 flex min-w-0 items-center justify-end gap-1">
            {interlocutorControl}
            {/* Tier picker (Standard / Pro / Max) — the shared presentational
                control; without research/metered props it renders just the
                Select. Sits beside the assistant picker in the control row. */}
            <ComposerControls
              model={model}
              pickerLabel={tChat.effortLabel}
              onModelChange={setModel}
              plan={workspacePlan}
              researchMode={researchMode}
              onResearchModeChange={setResearchMode}
              researchQuota={researchQuota}
              researchExhausted={researchExhausted}
              selectSide="top"
              className={cn(styles.effortControl, "min-w-0 shrink gap-0 [&_[data-slot=select-trigger]]:min-h-11 [&_[data-slot=select-trigger]]:min-w-11 [&_[data-slot=select-trigger]]:max-w-full [&_[data-slot=select-trigger]]:px-2 [&_[data-slot=select-trigger]]:text-xs [&_[data-slot=select-trigger]>span]:truncate [&_[data-slot=select-trigger]>svg]:hidden @[560px]/chat-reading:[&_[data-slot=select-trigger]]:min-h-9 @[560px]/chat-reading:[&_[data-slot=select-trigger]>svg]:block")}
            />
          </div>
          <div data-chat-composer-actions className="col-start-1 row-start-2 flex min-w-0 items-center gap-0.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={recordingUpload.busy}
              className="hidden"
              onChange={(event) => {
                if (!recordingUpload.busy && event.target.files) void att.upload(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!!pendingQuestion || recordingUpload.busy}
              aria-label={tAttach.attach}
              title={tAttach.attach}
              className="hidden size-9 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:shadow-none @[560px]/chat-reading:inline-flex"
            >
              <Plus className="size-5" aria-hidden />
            </button>
            <Popover open={composerAddOpen} onOpenChange={setComposerAddOpen}>
              <PopoverTrigger
                aria-label={tChat.addToChat}
                title={tChat.addToChat}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-foreground/80 hover:bg-muted disabled:pointer-events-none disabled:opacity-50 @[560px]/chat-reading:hidden"
                disabled={!!pendingQuestion || recordingUpload.busy}
              >
                <Plus className="size-[18px]" aria-hidden />
              </PopoverTrigger>
              <PopoverContent data-chat-add-menu side="top" align="start" className="w-64 gap-2 rounded-xl p-2">
                <button type="button" onClick={() => { setComposerAddOpen(false); fileInputRef.current?.click(); }} className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted max-md:min-h-11">
                  <Plus className="size-4" aria-hidden />{tAttach.attach}
                </button>
                {askControl}
                {dockRecorder && <div className="border-t px-2 pt-3">
                  <DockRecorderOptions rec={dockRecorder} disabled={dockRecorder.active || dockRecorder.phase.kind !== "idle" || recordingUpload.busy} />
                </div>}
              </PopoverContent>
            </Popover>
            {/* One recorder beside Add at every width. A latched capture
                uses the shared strip above the composer. */}
            {dockRecorder ? (<div data-chat-recorder className="flex [&>*]:min-h-11 [&_button]:min-h-11 [&_button]:min-w-11 @[560px]/chat-reading:[&>*]:min-h-9 @[560px]/chat-reading:[&_button]:min-h-9 @[560px]/chat-reading:[&_button]:min-w-0 [&_[data-recorder-options-trigger]]:hidden @[560px]/chat-reading:[&_[data-recorder-options-trigger]]:inline-flex">
              <DockRecorderButton
                rec={dockRecorder}
                disabled={!!pendingQuestion || recordingUpload.busy}
              />
            </div>) : null}
            {/* The Ask affordance (D1/T3) — only where a plain send would
                post: a room with more than one human (chat-parity D2).
                Arming this (or typing an @mention) makes the next send
                address the assistant. Hidden while the user is the only
                human, where every send is already addressed. */}
            <div className="hidden min-w-0 max-w-40 @[560px]/chat-reading:block">{askControl}</div>
          </div>
          </>
        }
        // Send stays visible while a turn streams IF this send can join it —
        // muted, because it queues into a turn rather than starting one. In a
        // room (no queueing) it still gives way to Stop.
        sendButtonClassName={cn(
          "col-start-3 row-start-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full @[560px]/chat-reading:size-9",
          "transition-colors focus-visible:shadow-none",
          styles.actionTarget,
          canQueueMidTurn && chat.state.replyPhase === "generating" ? styles.secondaryAction : styles.primaryAction,
          "disabled:opacity-40 disabled:pointer-events-none",
          canQueueMidTurn && chat.state.replyPhase === "generating"
            ? "bg-muted text-foreground/80 hover:bg-muted/80"
            : "bg-foreground text-background hover:bg-foreground/85",
          chat.state.isStreaming && !canQueueMidTurn && "hidden",
        )}
        slotPostInput={
          (chat.state.isStreaming && (chat.state.replyPhase === "generating" || !canQueueMidTurn))
            || (mirrorStopAvailable && remoteReplyPhase === "generating") ? (
            <button
              type="button"
              data-brian-chat-action="stop"
              onClick={stopRunningTurn}
              aria-label={tChat.abort}
              title={tChat.abort}
              className={cn(
                "col-start-4 row-start-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full @[560px]/chat-reading:size-9",
                "bg-muted text-foreground/80 transition-colors hover:bg-muted/80 hover:text-destructive",
                "focus-visible:shadow-none",
                styles.actionTarget,
                styles.secondaryAction,
              )}
            >
              <Square className="size-3.5 fill-current" aria-hidden />
            </button>
          ) : null
        }
      />
    </div>
    </>
  );

  return (
    <PaneLinkProvider openInPane={openInChatPane}>
    <div
      ref={visibleViewportRef}
      data-chat-surface
      className="@container/chat-reading relative flex h-full max-h-[var(--chat-visible-height,100%)] min-h-0 flex-col bg-background"
      {...drop.dropProps}
    >
      <FileDropOverlay active={drop.isDragging} />
      <OperatorTopbar
        app="chat"
        identityControl={<ChatAudienceMenu heading view={view} onSelect={mode => selectSession(null, mode)} />}
        centerVisibility="when-sidebar-unavailable"
        center={<ChatAudienceMenu view={view} onSelect={mode => selectSession(null, mode)} />}
        right={
          <div className="flex items-center gap-1">
          <ConversationVisibilityControl key={activeContextSession?.id} session={activeContextSession} workspaceId={workspaceId} />
          {/* Attention (chat-app.md -> "Attention"): work that needs this person, narrowed to this chat's Project or session. */}
          <ApprovalReviewAttention
            workspaceId={workspaceId}
            sessionId={activeSessionId ?? null}
            projectId={activeContextSession?.contextProjectId ?? null}
            openRequestId={searchParams?.get("attention") ?? null}
          />
          {!heroMode && <ChatSidePaneToggle pane={pane} />}
          <button
            type="button"
            onClick={
              view === "workspace"
                ? () => void startNewWorkspaceChat()
                : startNewChat
            }
            disabled={startingShared}
            aria-label={view === "workspace" ? t.newWorkspaceChat : t.newChat}
            title={view === "workspace" ? t.newWorkspaceChat : t.newChat}
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 md:min-h-8 md:min-w-8"
          >
            <Plus className="size-3.5" aria-hidden />
            <span className="hidden lg:inline">{view === "workspace" ? t.newWorkspaceChat : t.newChat}</span>
          </button>
          </div>
        }
      />

      <ChatRetainedHistoryNotice sessionId={activeSessionId ?? null} listSyncedAt={retainedSyncedAt} onExpire={() => chat.loadMessages([])} />

      {/* ── Hero / transcript + composer ──────────────────────────── */}
      {heroMode ? (
        // Fresh pane: the new-chat hero — ONE skeleton for both views
        // (brand, question, bottom composer), so switching the toggle
        // reads as changing the audience, not changing apps. Workspace adds
        // the shared-audience explainer, and its first send creates the
        // shared thread before streaming into it (see `send`).
        <section data-chat-welcome className="chat-welcome flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto px-3 @[560px]/chat-reading:px-6">
          <div data-chat-welcome-layout className={cn("flex w-full max-w-[52rem] flex-col", styles.welcomeLayout)}>
            <div data-chat-greeting className={cn("flex flex-col items-center text-center", styles.welcomeGreeting)}>
              <svg data-chat-welcome-icon aria-hidden="true" focusable="false" viewBox="0 0 56 56" width={76} height={76} className={styles.welcomeIcon}>
                {/* Preserve Brian's seven-column pixel silhouette. */}
                <g fill="currentColor">
                  {[[2, 3, 4], [1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5], [2, 4]].flatMap((columns, row) =>
                    columns.map((column) => <rect key={`${row}-${column}`} x={column * 8 + 0.25} y={row * 8 + 4.25} width="7.5" height="7.5" />),
                  )}
                </g>
                <g className={styles.welcomeFace}>
                  <g className={styles.welcomeEyes}>
                    <rect x="18" y="21" width="4" height="4" />
                    <rect x="34" y="21" width="4" height="4" />
                  </g>
                </g>
              </svg>
              <h2 className="max-w-[22rem] text-balance text-[24px] font-medium leading-[1.3] tracking-tight text-foreground md:max-w-xl md:text-[28px]">
                {view === "workspace" ? t.workspaceHeroTitle : t.heroTitle}
              </h2>
            </div>
            <div data-chat-welcome-composer className={cn("w-full shrink-0 pb-[max(0.5rem,env(safe-area-inset-bottom))] @[560px]/chat-reading:pb-6", styles.welcomeComposer)}>
              <ChatContextBar context={creationContext} disabled={att.uploading} />
              {composerBox}
              {shownError && <p role="alert" className="mt-3 rounded-xl bg-destructive/10 px-4 py-2 text-sm text-destructive">{shownError}</p>}
            </div>
          </div>
        </section>
      ) : (
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* Full view keeps the transcript and unsent composer draft mounted. */}
      <section
        style={pane.state.open && pane.state.fullView ? { display: "none" } : undefined}
        className="@container/chat-reading flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <div
          ref={scrollRef}
          data-chat-transcript
          // The pill is anchored to a viewport rect, so scrolling would strand
          // it over the wrong text. Dismiss rather than chase.
          onScroll={(event) => {
            const el = event.currentTarget;
            followTranscriptRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
            if (selectionQuote) setSelectionQuote(null);
          }}
          className="min-h-0 flex-1 overflow-y-auto px-3 pt-4 pb-6 @[560px]/chat-reading:px-6 @[560px]/chat-reading:pt-6"
        >
          <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-6">
            {activeSessionId && activeContextSession ? <ClientDeliveryOversight key={activeSessionId}
              workspaceId={workspaceId} chatId={activeSessionId} hideWhileLoading
              scope={activeContextSession.contextProjectId ? {kind:"project",id:activeContextSession.contextProjectId}
                : activeContextSession.contextGroupId ? {kind:"department",id:activeContextSession.contextGroupId} : {kind:"personal"}}
              onDraft={draft=>{setInput(draft);requestAnimationFrame(focusComposer)}}/> : null}
            {/* In-chat pursuit: the always-visible strip while any session
                goal is still being worked; click jumps to the inline card. */}
            <GoalPursuitSticky
              goals={sessionGoals}
              statuses={goalLiveStatuses}
              onJump={jumpToGoalCard}
              className="-mx-1"
            />
            {activeContextSession && (activeContextSession.contextGroupId || activeContextSession.contextProjectId) ? (
              <ContextScopeChips
                teamId={activeContextSession.contextGroupId ?? null}
                projectId={activeContextSession.contextProjectId ?? null}
                teams={contextTeams}
                projects={contextProjects}
              />
            ) : null}
            {dockRecorder?.interactionChatSessionId && dockRecorder.interactionChatSessionId === activeSessionId && dockRecorder.interactionStatus !== "idle" && (
              <div className="space-y-2 rounded-lg border p-3">
                <p role={dockRecorder.interactionStatus === "gap" ? "alert" : "status"} className="text-sm">
                  {dockRecorder.interactionStatus === "gap" ? interactionT.error : interactionT.listening}
                </p>
                {dockRecorder.interactionCaptureId && <LiveInteractionQuestionControls key={dockRecorder.interactionCaptureId} captureId={dockRecorder.interactionCaptureId} />}
                <button type="button" className="min-h-8 max-sm:min-h-11 text-sm underline" onClick={() => dockRecorder.setInteractionEnabled(false)}>{interactionT.stop}</button>
              </div>
            )}
            {voiceInteractionHere && <LiveInteractionJobs
              recordingSessionId={dockRecorder?.interactionCaptureId ? dockRecorder.interactionChatSessionId : null}
              recordingCaptureId={dockRecorder?.interactionCaptureId}
              workspaceId={workspaceId}
              sessionId={activeSessionId}
              messageIds={new Set(chat.state.messages.map((message) => message.id))}
              onCanonical={(sid, rows, ids) => {
                if (sessionIdRef.current !== sid) return;
                // Per-job additions only: never hydrate over a typed stream.
                for (const message of canonicalInteractionAdditions(chat.state.messages, mapTranscriptRows(rows, false), ids)) {
                  chat.appendMessage(message);
                }
              }}
            />}
            {displayTimeline.length === 0 &&
              !(activeSessionId && historyRecoverySessionId === activeSessionId) &&
              !chat.state.isStreaming &&
              !remoteActive &&
              (transcriptCold ? (
                // A switch onto a session with no cached transcript: the
                // pane's own geometry in placeholder blocks, never the
                // previous thread's rows and never a sentence (N4).
                <div aria-hidden className="flex flex-col gap-5 py-2" data-testid="chat-transcript-skeleton">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className={cn("flex gap-3", i % 2 === 0 ? "" : "flex-row-reverse")}
                    >
                      <Skeleton className="size-7 shrink-0 rounded-full" />
                      <div className={cn("flex-1 space-y-2", i % 2 === 0 ? "max-w-[85%]" : "max-w-[60%]")}>
                        <Skeleton className="h-3.5 w-full" />
                        <Skeleton className="h-3.5" style={{ width: `${45 + ((i * 23) % 40)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-20 text-center text-sm text-muted-foreground">
                  {panePolicy.post ? t.sharedTranscriptEmpty : t.transcriptEmpty}
                </p>
              ))}
            {displayTimeline.map((entry, displayIndex) => {
              const meta = transcriptMeta[displayIndex];
              if (entry.historicalDisplayOnly) return <Fragment key={`display-${entry.row.id}`}>
                {meta?.daySeparator && <div className="flex items-center justify-center" role="separator">
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {formatTranscriptDayLabel(meta.daySeparator, new Date(), locale, { today: t.dayToday, yesterday: t.dayYesterday })}
                  </span>
                </div>}
                <ChatDisplayHistoryRow row={entry.row} meta={meta} avatar={avatarFor(null)}
                  authorName={entry.row.role === "assistant" ? assistantNameFor(null) ?? undefined : undefined} />
              </Fragment>;
              const { message: m, canonicalIndex: messageIndex } = entry;
              const timeKnown = !Number.isNaN(m.timestamp.getTime());
              // Day separator — a centered chip whenever the local calendar
              // day turns over, the group-chat timeline anchor.
              const daySeparator =
                meta?.daySeparator && timeKnown ? (
                  <div className="flex items-center justify-center" role="separator">
                    <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {formatTranscriptDayLabel(meta.daySeparator, new Date(), locale, {
                        today: t.dayToday,
                        yesterday: t.dayYesterday,
                      })}
                    </span>
                  </div>
                ) : null;
              const timeChip = timeKnown ? (
                <time
                  dateTime={m.timestamp.toISOString()}
                  title={m.timestamp.toLocaleString(locale)}
                >
                  {formatTranscriptTime(m.timestamp, locale)}
                </time>
              ) : null;
              // In-chat pursuit cards anchored after this message (the turn
              // whose tool call armed each goal).
              const goalCardsHere = goalPlacement.afterMessage.get(m.id);
              const goalCardsBlock = goalCardsHere?.length
                ? goalCardsHere.map((goal) => (
                    <GoalPursuitCard
                      key={`goal-${goal.id}`}
                      goal={goal}
                      workspaceId={workspaceId}
                      liveStatus={goalLiveStatuses[goal.id] ?? null}
                      onStatusChange={handleGoalStatusChange}
                    />
                  ))
                : null;
              // A sent slash command renders as the system action it was, not
              // a plain sentence — roster-backed exactly like the composer
              // indicator; an unknown `/word` stays an ordinary bubble.
              const sentCommand =
                m.role === "user" && m.text && slashCommands.roster
                  ? sentSlashCommandOf(m.text, slashCommands.roster)
                  : null;
              return m.role === "user" ? (
                <Fragment key={m.id}>
                  {daySeparator}
                <div
                  data-message-id={m.id}
                  className={cn(
                    "group flex flex-col items-end",
                    // A same-sender burst tightens under the group's one
                    // header (the container's gap-5 pulled back to ~6px).
                    !meta?.startsGroup && "-mt-3.5",
                  )}
                >
                  {/* Group header — sender attribution (shared threads) and
                      the message time, once per burst rather than per bubble. */}
                  {meta?.startsGroup && (m.senderName || timeChip) && (
                    <span className="mb-0.5 flex items-baseline gap-1.5 px-1 text-xs text-muted-foreground">
                      {m.senderName && (
                        <span className="font-medium">{m.senderName}</span>
                      )}
                      {timeChip}
                    </span>
                  )}
                  {/* What this message replied to, above the bubble it
                      belongs to — the quote is context for the sentence
                      under it, so it reads top-down like every other
                      messaging app. */}
                  {m.replyTo && editingMessageId !== m.id
                    ? quotedBlock(m.replyTo, true)
                    : null}
                  {/* Neutral Notion-style bubble — the dock's `--secondary`
                      surface, NOT a saturated primary fill (white-on-blue
                      missed WCAG AA; the brand blue stays on small accents). */}
                  {editingMessageId === m.id ? (
                    messageEditor(m.id)
                  ) : sentCommand ? (
                    <div
                      aria-label={format(t.slashSentAria, {
                        slug: sentCommand.command.slug,
                      })}
                      className="max-w-[85%] rounded-2xl rounded-br-md border border-primary/25 bg-primary/[0.07] px-3.5 py-2 text-[16px] @[560px]/chat-reading:text-[15px] leading-[1.5] [overflow-wrap:anywhere] whitespace-pre-wrap shadow-sm"
                    >
                      <span className="mr-1.5 inline-flex translate-y-[1px] items-center gap-1">
                        <Sparkles
                          className="size-3.5 text-primary"
                          aria-hidden
                        />
                        <code className="rounded bg-primary/15 px-1 py-0.5 text-[13px] font-semibold text-primary">
                          /{sentCommand.command.slug}
                        </code>
                      </span>
                      {sentCommand.args ? (
                        <span className="text-secondary-foreground">
                          {sentCommand.args}
                        </span>
                      ) : null}
                    </div>
                  ) : m.text || (m as { voiceNote?: boolean }).voiceNote ? (
                    <div data-brian-chat-user className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[16px] @[560px]/chat-reading:text-[15px] leading-[1.5] [overflow-wrap:anywhere] whitespace-pre-wrap text-secondary-foreground shadow-sm">
                      {/* A recorder voice clip's bubble says so rather than staying blank. */}
                      {m.text || t.voiceNote}
                    </div>
                  ) : null}
                  {m.userAttachments?.length ? (
                    <div className="w-full max-w-[280px]">
                      <MessageAttachments attachments={m.userAttachments} workspaceId={workspaceId} />
                    </div>
                  ) : null}
                  {m.text && editingMessageId !== m.id
                    ? messageActions(
                        m.id,
                        m.text,
                        true,
                        m.userAttachments?.length
                          ? undefined
                          : () => retryUserMessage(m.id),
                        canEditUserMessage({
                          messages: chat.state.messages as SurfaceMessage[],
                          index: messageIndex,
                          viewerUserId: meId,
                          busy: chat.state.isStreaming || remoteActive,
                        })
                          ? () => startEdit(m)
                          : undefined,
                        canReplyToMessage(m)
                          ? () =>
                              startReply(m, { authorName: quoteAuthorFor(m) })
                          : undefined,
                      )
                    : null}
                </div>
                {goalCardsBlock}
                </Fragment>
              ) : (
                <Fragment key={m.id}>
                  {daySeparator}
                <div
                  data-message-id={m.id}
                  className={cn(
                    "group flex gap-2.5",
                    !meta?.startsGroup && "-mt-3.5",
                  )}
                >
                  {avatarFor(m.senderAssistantId, m.publishedSenderName)}
                  <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
                    {/* Group header — the answering assistant's name (every
                        Chat conversation, where several assistants may
                        speak, D1) + time. */}
                    {meta?.startsGroup && timeChip && (
                      <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                        {(panePolicy.multiVoice || m.publishedSenderName != null) && assistantNameFor(m.senderAssistantId, m.publishedSenderName) && (
                          <span className="font-medium">
                            {assistantNameFor(m.senderAssistantId, m.publishedSenderName)}
                          </span>
                        )}
                        {timeChip}
                      </span>
                    )}
                    {m.replyTo ? quotedBlock(m.replyTo, false) : null}
                    {m.toolsUsed?.length ? (
                      <ChatActivitySummary
                        tools={m.toolsUsed}
                        notes={m.activityNotes}
                        reasoning={m.activityReasoning}
                        durationMs={m.activityDurationMs}
                      />
                    ) : null}
                    {m.text ? (
                      <div data-brian-chat-answer className={MARKDOWN_CLS}>
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
                        onOpen={(document) => openInChatPane({ kind: "document", document })}
                      />
                    ))}
                    {m.pageLinks?.map((pageId) => (
                      <ChatPageLinkCard
                        key={pageId}
                        pageId={pageId}
                        onOpen={(id) => openInChatPane({ kind: "page", pageId: id })}
                      />
                    ))}
                    {(() => {
                      const research = m.research ?? (sessionResearch.get(m.id)
                        ? { activityId: sessionResearch.get(m.id)!.id, status: sessionResearch.get(m.id)!.status } : null);
                      return research ? (
                        <ChatResearchCard
                          status={research.status}
                          onOpen={() => openInChatPane({ kind: "research", activityId: research.activityId })}
                        />
                      ) : null;
                    })()}
                    {m.text
                      ? messageActions(
                          m.id,
                          m.text,
                          false,
                          (chat.state.messages as SurfaceMessage[])[messageIndex - 1]
                            ?.userAttachments?.length
                            ? undefined
                            : () => retryAssistantMessage(m.id),
                          undefined,
                          canReplyToMessage(m)
                            ? () =>
                                startReply(m, { authorName: quoteAuthorFor(m) })
                            : undefined,
                          activeSessionId
                            ? () =>
                                router.push(
                                  auditTurnUrl(
                                    "",
                                    workspaceId,
                                    activeSessionId,
                                    // A live-streamed reply carries a synthetic
                                    // client id until the next reload; only a
                                    // persisted row id can address a turn, so
                                    // the audit page falls back to the newest
                                    // turn (which the live reply is) otherwise.
                                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.id)
                                      ? m.id
                                      : null,
                                  ),
                                )
                            : undefined,
                        )
                      : null}
                  </div>
                </div>
                {goalCardsBlock}
                </Fragment>
              );
            })}
            {/* In-chat pursuit cards newer than every persisted message (the
                arming turn is still streaming). */}
            {goalPlacement.trailing.map((goal) => (
              <GoalPursuitCard
                key={`goal-${goal.id}`}
                goal={goal}
                workspaceId={workspaceId}
                liveStatus={goalLiveStatuses[goal.id] ?? null}
                onStatusChange={handleGoalStatusChange}
              />
            ))}
            {/* Live turn — the dock's activity feed (shimmer status +
                reasoning/tool steps) above the streaming reply + caret. */}
            {chat.state.isStreaming && (
              <div className="flex gap-2.5">
                {avatarFor(convo?.liveAssistantId ?? null)}
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <ChatActivityFeed
                    events={streamingEvents}
                    tools={toolTimeline}
                    replyStreaming={chat.state.streamingText.length > 0}
                    replyPhase={chat.state.replyPhase}
                    researchPhase={researchPhase}
                    startedAt={turnStartedAt}
                  />
                  {chat.state.streamingText ? (
                    <div data-brian-chat-answer className={MARKDOWN_CLS}>
                      <ChatMarkdown
                        text={chat.state.streamingText}
                        components={CHAT_MARKDOWN_COMPONENTS}
                        remarkPlugins={REMARK_PLUGINS}
                      />
                      {chat.state.replyPhase === "generating" && (
                        <span
                          aria-hidden
                          className="ml-0.5 inline-block h-[16px] w-[2px] rounded-full bg-foreground align-text-bottom animate-pulse"
                        />
                      )}
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
            {/* Messages handed to the running turn, not yet taken by it.
                See docs/architecture/engine/mid-turn-input.md. */}
            <QueuedInputs
              inputs={queuedInputs}
              dict={tChat.queue}
              onSteer={(inputId) => void controllerRef.current?.steer(inputId)}
            />
            {/* A followed turn, including our own after returning to Chat,
                relayed off the per-session event bus
                through the SAME feed pipeline the sender uses (T13): the
                shimmer feed (reasoning + tool steps) above the live snapshot
                text. When the turn settles the PERSISTED transcript is
                refetched — the snapshot is never kept. */}
            {remoteActive && !chat.state.isStreaming && (
              <div className="flex gap-2.5">
                {avatarFor(remoteAssistantId)}
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <ChatActivityFeed
                    events={remoteEvents}
                    tools={remoteTools}
                    replyStreaming={remoteText.length > 0}
                    replyPhase={remoteReplyPhase}
                    researchPhase={remoteResearchPhase}
                    startedAt={remoteStartedAt}
                  />
                  {remoteText ? (
                    <div data-brian-chat-answer className={MARKDOWN_CLS}>
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
            {externalRequests?.workspaceId === workspaceId && externalRequests.sessionId === activeSessionId && externalRequests.items.map((request) => (
              <ExternalActionConfirmation
                key={`${workspaceId}:${activeSessionId}:${request.approvalId}`}
                workspaceId={workspaceId}
                request={request}
                onResolved={() => refreshPendingInput(activeSessionId!)}
              />
            ))}
            {chat.state.pendingConfirmations
              .filter((c) => c.status === "pending" || c.status === "approving")
              .map((c) => (
                <ChatConfirmationCard
                  key={c.toolCallId}
                  confirmation={c}
                  // Refused for this viewer: the turn's addresser or an admin
                  // decides; the card says so instead of offering buttons.
                  actions={refusedConfirmations.has(c.toolCallId)
                    ? <p role="status" data-confirm-not-allowed className="text-xs text-muted-foreground">{t.confirmNotAllowed}</p>
                    : undefined}
                  approveLabel={tChat.confirmationApprove}
                  denyLabel={tChat.confirmationDeny}
                  approvingLabel={tChat.confirmationApproving}
                  onApprove={(toolCallId) => void resolveConfirmation(toolCallId, "approve")}
                  onDeny={(toolCallId, comment) =>
                    void resolveConfirmation(toolCallId, "deny", comment)
                  }
                />
              ))}
            {/* A suspended askQuestion — any member with read access may
                answer, attributed (D8); Answer/Cancel are the reader-gated
                session routes. */}
            {workspaceId && activeSessionId && <RoutineChatPickup workspaceId={workspaceId} sessionId={activeSessionId} />}
            {pendingQuestion && pendingQuestion.sessionId === activeSessionId && (
              <PendingQuestionPanel
                sessionId={pendingQuestion.sessionId}
                approvalId={pendingQuestion.approvalId}
                dict={tChat.pendingQuestion}
                // The panel posted the answer or cancel itself: the conversation
                // resolves the interaction and follows the resumed turn.
                onAnswered={() => void controllerRef.current?.questionSettled(pendingQuestion.approvalId)}
                onCancelled={() => void controllerRef.current?.questionSettled(pendingQuestion.approvalId)}
              />
            )}
            {/* How this turn was served, when it was not served the way the
                workspace normally serves turns. Never an error. */}
            {turnNotice && (
              <p
                role="status"
                className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              >
                {turnNotice}
              </p>
            )}
            {/* Quiet queue notice (T5) — a mention landed mid-turn; the
                follow-up turn is armed. Never an error. */}
            {queuedNotice && (
              <p className="px-1 text-xs text-muted-foreground">{t.queuedNotice}</p>
            )}
            {/* D-H4 — a named member who fails this room's clearance. The
                message still posted/saved; this only tells the sender who
                was not notified. Never an error: no preview text reached
                anyone 403'd on the room, which is exactly the point. */}
            {unreachableNote.length > 0 && (
              <p
                role="status"
                className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              >
                {format(t.mentionUnreachableNote, {
                  names: unreachableNote.map((m) => m.name).join(", "),
                })}
              </p>
            )}
            {/* Why the last turn ended, when it ended for a reason nobody in
                this tab asked for. Not an error: the room is unblocked and
                nothing was lost, which is exactly what the line says. */}
            {turnEndNotice && (
              <p
                role="status"
                className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              >
                {turnEndNotice}
              </p>
            )}
            {/* The direct stream died under a turn that is still running;
                the mirror above is carrying it. Not an error: nothing was
                lost, the reply lands in the transcript when it finishes. */}
            {reconnectNotice && (
              <p
                role="status"
                className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              >
                {t.turnReconnecting}
              </p>
            )}
            {/* Typing indicator — teammates mid-composition, off the follow
                stream's presence events. The classic three-dot bubble; dots
                hold still under reduced motion. */}
            {typingLabel && (
              <div
                className="flex items-center gap-2"
                role="status"
                aria-live="polite"
              >
                <span className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-secondary px-3 py-2.5 shadow-sm">
                  {[0, 160, 320].map((delay) => (
                    <span
                      key={delay}
                      aria-hidden
                      className="size-1.5 rounded-full bg-muted-foreground/70 motion-safe:animate-bounce"
                      style={{
                        animationDelay: `${delay}ms`,
                        animationDuration: "1.1s",
                      }}
                    />
                  ))}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {typingLabel}
                </span>
              </div>
            )}
            {shownError && !(activeSessionId && historyRecoverySessionId === activeSessionId) && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {shownError}
              </div>
            )}
            {activeSessionId && historyRecoverySessionId === activeSessionId && !transcriptCold && (
              <ChatLegacyHistory key={`${workspaceId}:${activeSessionId}`} workspaceId={workspaceId} sessionId={activeSessionId} fallback={t.historyUnavailable}>
                <ChatRecoveryAction
                  key={`${workspaceId}:${activeSessionId}`} workspaceId={workspaceId} sessionId={activeSessionId}
                  onRecovered={(result) => {
                    if (sessionIdRef.current !== activeSessionId || result.workspaceId !== workspaceId) return;
                    resetPane();
                    cacheCreatedChatSession(workspaceId, {
                      id: result.sessionId, assistantId: result.assistantId, channelId: result.channelId,
                      title: t.newChat, lastActive: result.lastActive, status: result.status,
                      contextGroupId: result.contextGroupId, contextProjectId: result.contextProjectId,
                      appOrigin: "chat", transport: "web", policy: result.policy, humanCount: 1,
                      recoveredFromSessionId: activeSessionId,
                    }, "personal");
                    sessionAssistantRef.current.set(result.sessionId, result.assistantId);
                    selectSession(result.sessionId, "personal");
                    dispatchChatSessionsRefresh(workspaceId);
                  }}
                />
              </ChatLegacyHistory>
            )}
            {(activeRow?.recoveredFromSessionId ?? paneSummary?.recoveredFromSessionId) && (
              <div className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
                {t.recovery.notice}{" "}
                <button type="button" className="min-h-8 max-sm:min-h-11 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  onClick={() => selectSession((activeRow?.recoveredFromSessionId ?? paneSummary?.recoveredFromSessionId)!, "personal")}>
                  {t.recovery.openOriginal}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Quote-this-selection pill. Anchored to the selection's viewport
            rect (hence `fixed`), centered above it and nudged clear of the
            text — the affordance appears where the user is looking rather
            than in the row's hover bar, which is a pointer trip away and
            costs the selection to reach. */}
        {selectionQuote
          ? (() => {
              const quoted = (chat.state.messages as SurfaceMessage[]).find(
                (message) => message.id === selectionQuote.messageId,
              );
              if (!quoted || !canReplyToMessage(quoted)) return null;
              return (
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    startReply(quoted, {
                      selection: selectionQuote.text,
                      authorName: quoteAuthorFor(quoted),
                    })
                  }
                  style={{
                    top: Math.max(8, selectionQuote.top - 40),
                    left: selectionQuote.left,
                  }}
                  className={cn(
                    "fixed z-50 -translate-x-1/2 inline-flex items-center gap-1.5",
                    "rounded-lg border border-border bg-popover px-2.5 py-1.5",
                    "text-xs font-medium text-popover-foreground shadow-md",
                    "transition-colors hover:bg-muted",
                  )}
                >
                  <Reply className="size-3.5" aria-hidden />
                  {t.replyToSelection}
                </button>
              );
            })()
          : null}

        {/* Composer bar — the same bottom-aligned composite box as the welcome. */}
        {!(activeSessionId && historyRecoverySessionId === activeSessionId) && <div data-chat-composer-dock className="shrink-0 bg-gradient-to-t from-background from-80% to-transparent px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 @[560px]/chat-reading:px-6 @[560px]/chat-reading:pb-6 @[560px]/chat-reading:pt-3">
          <div className="mx-auto w-full max-w-[52rem]">{composerBox}</div>
        </div>}
      </section>
      <ChatSidePane
        workspaceId={workspaceId}
        chatKey={activeSessionId}
        pane={pane}
        pins={panePins}
        renderTab={(ref) =>
          ref.kind === "work" ? (
            panePolicy.pins && activeSessionId ? (
              <ChatContextPins
                sessionId={activeSessionId}
                workspaceId={workspaceId}
                refreshKey={pinsEpoch}
                shared={panePolicy.post}
                startedByName={activeStartedByName}
                assistant={workBenchAssistant}
                turnActive={workBenchTurnActive}
                waitingForInput={workBenchWaiting}
                currentStep={workBenchCurrentStep}
                tools={workBenchTools}
                lastProgressAt={workBenchTurnActive ? lastProgressAt : null}
                onStopTurn={stopRunningTurn}
                onPinsChanged={bumpPins}
              />
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">{t.sidePane.workEmpty}</p>
            )
          ) : undefined
        }
      />
      </div>
      )}
    </div>
    </PaneLinkProvider>
  );
}
