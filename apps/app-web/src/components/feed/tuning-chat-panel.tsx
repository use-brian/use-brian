"use client";

/**
 * Feed chat panel — evolved from
 * `apps/feed-web/src/components/tuning-chat-panel.tsx`
 * (docs/plans/feed-web-consolidation.md §7.3): the chat surface where the
 * operator directs planning, ideation, writing, and voice work, with session
 * resume (`channelId='tuning'`), the shared dock recorder, copy/retry, and a
 * model-tier picker gated by the workspace plan. Research is assessed
 * automatically for eligible assistants.
 *
 * Since M5 WP-E the rail is a `page`-profile presentation of the shared
 * conversation controller (`useConversation`): the controller owns the direct
 * POST, follow/re-attach, Stop, approvals, pending questions, the mid-turn
 * queue and history loading (`mapFeedTranscript`). The rail keeps the sticky
 * channel lookup, its request fields (`feedTarget`, `replyTo`, `channelId`,
 * `model`, research `mode`), Retry provenance, and the live bubble folded from
 * the frame observer by `feed-chat-stream.ts`
 * (docs/architecture/feed/draft-collaboration.md → "Feed chat streaming").
 *
 * Port deltas (disposition rules §6):
 *   - Session resume rides `fetchFeedSessionIdByChannel` (feed SDK); history
 *     goes through `extractMessageText` (sessions SDK), which also collapses
 *     `<attached_file>` wrappers to a tidy name on resume.
 *   - Plan gating rides `getUsage()` (`@/lib/api/usage`).
 *   - No manual Research toggle; legacy explicit seeds retain quota handling.
 *   - All copy via `useT().feedPage.tuningChat`.
 *
 * [COMP:app-web/feed-tuning-chat]
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChatMarkdown,
  initialChatState,
  type Message,
  type MessageAttachment,
  type ReplyTo,
} from "@use-brian/chat-ui";
import { useConversation } from "@/lib/chat/use-conversation";
import { provisionalConversationKey } from "@/lib/chat/conversation-registry";
import type {
  ConversationBodyExtras,
  ConversationController,
  ConversationNotice,
  ConversationState,
  PresentationCapabilities,
} from "@/lib/chat/conversation-controller";
import type { ClassifiedTurnFrame } from "@/lib/chat/turn-frames";
import { cn } from "@/lib/utils";
import { QueuedInputs } from "@/components/ui/queued-inputs";
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
import { fetchFeedSessionIdByChannel } from "@/lib/api/feed";
import { parsePresentedDocumentPayload } from "@/lib/api/sessions";
import { getUsage } from "@/lib/api/usage";
import { AssistantAvatar } from "@/components/assistant-avatar";
import {
  DockRecorderButton,
  DockRecorderNotice,
  DockRecorderRecovery,
  DockRecorderStrip,
} from "@/components/chrome/dock-recorder";
import type { DockRecorderApi } from "@/lib/recorder/use-dock-recorder";
import { registerDockRecorderChatTarget } from "@/lib/recorder/dock-recorder-bridge";
import { useFloatingRecorderClearance } from "@/lib/recorder/floating-recorder-slot";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { buildReplyTarget, canReplyToMessage, condenseQuote, selectionTextWithin } from "@/components/chat-app/message-reply";
import { ChevronDownIcon, Reply, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  describeToolFromInput,
  type NarrationDict,
} from "@/lib/tool-narration";

import { newFeedChatTurn, foldFeedChatEvent, mapFeedTranscript, type FeedChatTurn } from "@/lib/feed-chat-stream";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
import { ChatActivityFeed, ChatActivitySummary, ChatCitationList } from "@/components/chrome/chat-activity";
import { ChatFileAttachments } from "@/components/chrome/chat-file-attachment";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import { PendingQuestionPanel } from "@/components/chrome/pending-question-panel";
import { ChatDocumentCard } from "@/components/chat-app/chat-document-viewer";
import { AttachmentChips } from "@/components/doc/attachment-chips";
import { MessageAttachments } from "@/components/doc/message-attachment-card";
import {
  imageFilesFromClipboard,
  readyAttachments,
  useFileAttachments,
} from "@/lib/use-file-attachments";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import type { DocumentAttachment } from "@use-brian/chat-ui";

const ACTIVE_RUN_PHASES = new Set(["running", "suspended"]);
const selectConversation = (state: ConversationState) => state;

/**
 * The default sticky channel: one tuning conversation per (assistant,
 * operator). The Plan surface overrides it with `"plan"` so the marketing
 * plan gets its own thread — and, because that session is created with
 * `mode='plan'`, its own `proposePlan` cardboard tool (feed-revamp.md D9).
 * Mixing the two in one thread would put a month of scheduling context in
 * front of every voice question.
 */
const TUNING_CHANNEL_ID = "tuning";

/** Persisted across sessions so the operator's model choice sticks. */
const MODEL_STORAGE_KEY = "feed-chat-model";
type ModelTier = "standard" | "pro" | "max";


export type TuningToolActivity = {
  id: string;
  name: string;
  description: string;
  status: "running" | "done" | "retried";
};

export type TuningChatActivity = {
  isStreaming: boolean;
  streamingText: string;
  /** Safe, user-facing status or input-aware tool narration. */
  activeLabel: string | null;
};

/**
 * Reduce the SSE tool lifecycle into the current turn's calls so the
 * collapsed Feed launcher can retain the newest useful narration until the
 * turn finishes. Returning null means the event was malformed or a duplicate.
 */
export function reduceTuningToolActivity(
  current: readonly TuningToolActivity[],
  event: string,
  payload: Record<string, unknown>,
  narration: NarrationDict,
): TuningToolActivity[] | null {
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) return null;

  if (event === "tool_start") {
    const name = typeof payload.name === "string" ? payload.name : "";
    if (!name || current.some((tool) => tool.id === id)) return null;
    return [
      ...current,
      {
        id,
        name,
        description: describeToolFromInput(name, {}, narration).description,
        status: "running",
      },
    ];
  }

  if (event === "tool_input") {
    const existing = current.find((tool) => tool.id === id);
    if (!existing) return null;
    const name =
      typeof payload.name === "string" && payload.name
        ? payload.name
        : existing.name;
    const input =
      payload.input && typeof payload.input === "object"
        ? (payload.input as Record<string, unknown>)
        : {};
    const description = describeToolFromInput(
      name,
      input,
      narration,
    ).description;
    return current.map((tool) =>
      tool.id === id ? { ...tool, name, description } : tool,
    );
  }

  if (event === "tool_result") {
    if (!current.some((tool) => tool.id === id)) return null;
    return current.map((tool) =>
      tool.id === id
        ? { ...tool, status: payload.isError === true ? "retried" : "done" }
        : tool,
    );
  }

  if (event === "tool_dropped") {
    if (!current.some((tool) => tool.id === id)) return null;
    return current.filter((tool) => tool.id !== id);
  }

  return null;
}

/**
 * The only request fields the Feed rail adds to a turn (the controller's typed
 * `bodyExtras`): the draft target, a quoted reply, the sticky channel when no
 * fixed session is bound, the model tier and legacy research mode.
 */
export function feedRequestFields(input: {
  feedTarget?: import('@use-brian/shared').FeedChatTarget;
  reply?: ReplyTo | null;
  fixedSessionId?: string;
  channelId: string;
  model: string;
  researchMode: boolean;
}): ConversationBodyExtras {
  return {
    ...(input.feedTarget ? { feedTarget: input.feedTarget } : {}),
    ...(input.reply?.id ? { replyTo: { id: input.reply.id, text: input.reply.text } } : {}),
    ...(input.fixedSessionId ? {} : { channelId: input.channelId }),
    model: input.model,
    ...(input.researchMode ? { mode: "research" as const } : {}),
  };
}

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
     * The assistant's stored avatar seed (`FeedProfile.assistant.iconSeed`).
     * Optional — `AssistantAvatar` falls back to an id-derived seed, the same
     * fallback the global dock uses, so identity visuals stay in sync.
     */
    iconSeed?: number;
    /**
     * Active workspace — used to resolve the plan (model-tier gating) and
     * the research quota via `GET /api/usage`. Omit to disable gating.
     */
    workspaceId?: string;
    /** Optional helper line under the suggestion banner. */
    headline?: string;
    /** Suggested starter prompts shown in the empty state. */
    suggestions?: string[];
    /** Post-bound refine rails replace the generic voice-memory empty copy. */
    emptyTitle?: string;
    emptyBody?: string;
    emptySuggestionsLabel?: string;
    /** When provided, the header renders a collapse button (floating shell). */
    onClose?: () => void;
    /** Sticky channel to resume. Defaults to the tuning conversation. */
    channelId?: string;
    /** Hard-lock sending while the host provisions a required fixed session. */
    ready?: boolean;
    /**
     * Resume THIS session instead of looking one up by channel. The post
     * editor hosts a per-post refine chat, which is a session id, not a
     * sticky channel (feed-revamp.md D15).
     */
    sessionId?: string;
    feedTarget?: import('@use-brian/shared').FeedChatTarget;
    feedSelection?: import('@use-brian/shared').FeedAnchor;
    onClearFeedSelection?: () => void;
    /** Fired when a turn finishes, so a host can re-read what it produced. */
    onTurnComplete?: () => void;
    /** Mirror safe live activity into the collapsed floating launcher. */
    onActivityChange?: (activity: TuningChatActivity) => void;
    /** Override the panel's name. The post editor hosts a REFINE chat, not
     *  the voice-tuning chat, and the header is the only thing that says so. */
    title?: string;
    /** Override the composer placeholder for the same reason. */
    composerPlaceholder?: string;
    /**
     * Render the `budget_exhausted` plan gate. It is a billing state, not a
     * stream crash, so the host owns its presentation (D18); without this the
     * message falls through to the generic error strip.
     */
    renderPlanGate?: (message: string) => React.ReactNode;
    /** The one app-wide live recorder, rehosted by the Feed replacement dock. */
    dockRecorder?: DockRecorderApi;
    /** Route short recorder captures into this visible tuning session. */
    ownsDockRecorderTarget?: boolean;
    /**
     * Inline rail chrome: the host aside draws the border, so drop the
     * floating window's rounding/border/shadow. Default is the floating
     * shell's chrome (the Feed dock).
     */
    docked?: boolean;
  }
>(function TuningChatPanel(props, ref) {
  const {
    assistantId,
    assistantName,
    iconSeed,
    workspaceId,
    headline,
    suggestions,
    emptyTitle,
    emptyBody,
    emptySuggestionsLabel,
    onClose,
    channelId = TUNING_CHANNEL_ID,
    ready = true,
    sessionId: fixedSessionId,
    onTurnComplete,
    onActivityChange,
    renderPlanGate,
    title: titleOverride,
    composerPlaceholder,
    dockRecorder,
    ownsDockRecorderTarget = false,
    docked = false,
  } = props;

  const t = useT().feedPage.tuningChat;
  const tChat = useT().chat;
  const tGoal = useT().chatApp;
  const tc = useT().feedCollaboration;
  const tQueue = useT().chat.queue;
  // A docked rail's composer sits in the bottom-right corner at `lg`+, where
  // the floating record button rests (WorkspaceChrome's FloatingRecorderHost).
  // Registering it lifts that button above Send; the inline record control
  // then only renders below `lg` so a screen never shows two.
  const composerFooterRef = useRef<HTMLDivElement>(null);
  useFloatingRecorderClearance(composerFooterRef, docked);
  const inlineRecorderClass = docked ? "lg:hidden" : undefined;
  // A retry must reproduce the original scope, never the current editor state.
  // Hydrated Feed messages do not carry that reference, so only locally known
  // requests can be replayed directly; Reply remains available for older rows.
  const sentTargetsRef = useRef(new Map<string, import('@use-brian/shared').FeedChatTarget | undefined>());
  const [input, setInput] = useState("");
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  // Presentation-side fold of the live turn (feed-chat-stream.ts), fed by the
  // controller's frame observer so the live bubble renders as before.
  const [turn, setTurn] = useState(newFeedChatTurn);
  const turnRef = useRef(turn);
  const updateTurn = useCallback((next: FeedChatTurn) => { turnRef.current = next; setTurn(next); }, []);
  const [openDocument, setOpenDocument] = useState<DocumentAttachment | null>(null);
  const followBottomRef = useRef(true);
  const slashContainerRef = useRef<HTMLDivElement | null>(null);
  const slashCommands = useSlashCommands({
    enabled: true,
    workspaceId: workspaceId ?? null,
    value: input,
    onChange: setInput,
    containerRef: slashContainerRef,
  });
  /** Errors the rail owns (lookup, approval); turn errors are controller notices. */
  const [localError, setLocalError] = useState<string | null>(null);
  const [acceptedGoal, setAcceptedGoal] =
    useState<GoalAcceptedNotice | null>(null);
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
  // Legacy research seed compatibility. A seed can set `mode: 'research'`, which
  // the server turns into coordinator + max-tier model + a higher turn
  // ceiling, gated by the workspace's free-research quota. A quota frame
  // trips `researchExhausted` when the server denies a turn.
  const [researchMode, setResearchMode] = useState(false);
  const [researchExhausted, setResearchExhausted] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // ── The conversation (M5: this rail is a presentation) ────────────────
  // Sticky channel lookup: a fixed session, the channel's existing session,
  // or none yet (the first send creates it through `channelId`).
  const lookupKey = `${assistantId}\u0000${channelId}\u0000${fixedSessionId ?? ""}\u0000${workspaceId ?? ""}`;
  const [lookup, setLookup] = useState<{ key: string; sessionId: string | null; done: boolean }>(() => ({
    key: lookupKey, sessionId: fixedSessionId ?? null, done: false,
  }));
  const lookupCurrent = lookup.key === lookupKey;
  const initialized = lookupCurrent && lookup.done;
  // A provisional entry re-keys to its session on the `session` frame. Until
  // the lookup state catches up, read the adopted id from the entry this rail
  // already holds, so the same render keeps the same controller.
  const boundRef = useRef<{ key: string; controller: ConversationController | null }>({ key: "", controller: null });
  const knownSessionId = fixedSessionId ?? (lookupCurrent ? lookup.sessionId : null);
  const adoptedSessionId = !knownSessionId && boundRef.current.key === lookupKey && boundRef.current.controller && !boundRef.current.controller.isDisposed()
    ? boundRef.current.controller.getSessionId() : null;
  const surfaceEffectRef = useRef<(frame: ClassifiedTurnFrame) => void>(() => {});
  const frameObserverRef = useRef<(frame: ClassifiedTurnFrame) => void>(() => {});
  const narrationRef = useRef(tChat.toolNarration);
  narrationRef.current = tChat.toolNarration;
  const capabilities = useMemo<PresentationCapabilities>(() => ({
    profile: "page",
    onSurfaceEffect: (frame) => surfaceEffectRef.current(frame),
    onFrame: (frame) => frameObserverRef.current(frame),
    describeTool: (name, toolInput) => describeToolFromInput(name, toolInput, narrationRef.current),
    parseDocument: (payload) => parsePresentedDocumentPayload(payload),
    mapHistoryRows: (rows) => mapFeedTranscript(rows, narrationRef.current),
  }), []);
  const presentationId = useId();
  const { controller, value: conversation } = useConversation(
    {
      workspaceId: workspaceId ?? "",
      sessionId: knownSessionId ?? adoptedSessionId,
      provisionalKey: provisionalConversationKey("feed", `${assistantId}:${channelId}`),
      presentationId,
      capabilities,
    },
    selectConversation,
  );
  boundRef.current = { key: lookupKey, controller };
  const transcript = conversation?.transcript ?? initialChatState;
  const sessionId = fixedSessionId ?? transcript.sessionId ?? knownSessionId ?? adoptedSessionId;
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  const mirror = conversation?.mirror ?? null;
  const directLive = transcript.isStreaming;
  const isStreaming = directLive || !!mirror?.active;
  const runActive = ACTIVE_RUN_PHASES.has(conversation?.run.phase ?? "idle");
  const busy = isStreaming || runActive;
  const notices = conversation?.notices ?? [];
  const reconnecting = notices.some((notice) => notice.code === "reconnecting");
  const recoveryFailed = notices.some((notice) => notice.code === "reconnectFailed");
  // A pending question has its own snapshot field, so a restored approval card
  // (in `pendingConfirmations`) shows beside it.
  const pendingQuestion = conversation?.question ?? null;
  // The opening probe is still asking whether a turn already runs: hold the
  // composer (typed text stays) rather than racing that turn.
  const hydrating = conversation?.hydrating ?? false;
  const att = useFileAttachments(
    () => fixedSessionId ?? sessionIdRef.current ?? undefined,
  );
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

  // Bind the conversation before sending. A changed channel, assistant or
  // fixed session is another conversation: drop this rail's local state and
  // look the new one up; a late lookup for the old key never lands.
  useEffect(() => {
    let current = true;
    setLookup({ key: lookupKey, sessionId: fixedSessionId ?? null, done: false });
    setReplyTo(null);
    sentTargetsRef.current.clear();
    setOpenDocument(null);
    att.clear();
    setLocalError(null);
    setAcceptedGoal(null);
    setStatusMessage(null);
    updateTurn(newFeedChatTurn());
    void (async () => {
      try {
        const sid = fixedSessionId ?? (await fetchFeedSessionIdByChannel(assistantId, channelId));
        if (current) setLookup({ key: lookupKey, sessionId: sid ?? null, done: true });
      } catch {
        if (current) { setLocalError(t.streamFailed); setLookup({ key: lookupKey, sessionId: fixedSessionId ?? null, done: true }); }
      }
    })();
    return () => { current = false; };
    // Dictionary changes do not restart a conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (el && followBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [transcript.messages, isStreaming, turn.visibleText, turn.log.events, turn.documents, turn.fileAttachments]);

  // Frames of this rail's turns (direct) and of a followed turn (a reconnect,
  // a reload mid-turn, a resumed question): fold them into the live bubble.
  frameObserverRef.current = (frame) => {
    const { event, payload } = frame;
    if (frame.stream === "direct") {
      if (event === "session" && typeof payload.sessionId === "string" && boundRef.current.key === lookupKey) {
        const adopted = payload.sessionId;
        setLookup((current) => current.key === lookupKey && !current.sessionId ? { ...current, sessionId: adopted } : current);
        return;
      }
      if (event === "status" && typeof payload.message === "string") setStatusMessage(payload.message);
      updateTurn(foldFeedChatEvent(turnRef.current, event, payload, narrationRef.current));
      return;
    }
    if (event === "turn_started") { updateTurn(newFeedChatTurn()); return; }
    if (event === "snapshot") updateTurn(foldFeedChatEvent(turnRef.current, event, payload, narrationRef.current));
    else if (event === "activity") updateTurn(foldFeedChatEvent(turnRef.current, String(payload.event), payload, narrationRef.current));
  };
  surfaceEffectRef.current = (frame) => {
    if (frame.event === "goal_accepted") setAcceptedGoal(goalAcceptedNoticeFromPayload(frame.payload));
    else if (frame.event === "research_quota_exhausted") { setResearchExhausted(true); setResearchMode(false); }
  };

  // Turn errors arrive as typed notices; copy stays here.
  const errorNotice = notices.find((notice): notice is Extract<ConversationNotice, { code: "error" }> => notice.code === "error") ?? null;
  useEffect(() => {
    if (errorNotice?.errorCode === "research_quota_exhausted") { setResearchExhausted(true); setResearchMode(false); }
  }, [errorNotice]);
  const turnNotice = notices.find((notice): notice is Extract<ConversationNotice, { code: "turnNotice" }> => notice.code === "turnNotice") ?? null;
  const knownNotices: Record<string, string> = {
    custom_model_image_fallback: tChat.noticeCustomModelImageFallback,
    custom_model_endpoint_fallback: tChat.noticeCustomModelEndpointFallback,
    budget_downgraded: tChat.noticeBudgetDowngraded,
  };
  const notice = notices.some((item) => item.code === "queued") ? tGoal.queuedNotice
    : turnNotice ? knownNotices[turnNotice.notice] ?? turnNotice.message ?? null : null;
  const errorCode = errorNotice?.errorCode ?? null;
  const error = recoveryFailed ? tChat.turnReconnectFailed
    : errorNotice ? errorNotice.message ?? (errorNotice.errorCode === "stream_interrupted" ? tChat.turnReconnectFailed : errorNotice.errorCode === "stream_failed" || errorNotice.errorCode === "not_accepted" ? t.streamFailed : t.streamError)
    : notices.some((item) => item.code === "stopTurnFailed") ? t.streamFailed
    : notices.some((item) => item.code === "confirmNotAllowed") ? tGoal.confirmNotAllowed
    : localError;

  // Text whose delivery is uncertain comes back to the composer; it is
  // never resent automatically (offline contract point 7).
  const unsentCount = conversation?.unsent.length ?? 0;
  useEffect(() => {
    if (!controller || unsentCount === 0) return;
    const texts = controller.takeUnsent();
    if (texts.length === 0) return;
    const restored = texts.join("\n\n");
    setInput((current) => (current.trim() ? `${current}\n\n${restored}` : restored));
  }, [controller, unsentCount]);

  // A turn that settled (its own, followed, or stopped) lets the host
  // re-read what it produced.
  const settledPhase = conversation?.run.phase ?? "idle";
  const wasActiveRef = useRef(false);
  const onTurnCompleteRef = useRef(onTurnComplete);
  onTurnCompleteRef.current = onTurnComplete;
  useEffect(() => {
    const active = busy;
    if (wasActiveRef.current && !active && (settledPhase === "completed" || settledPhase === "cancelled")) {
      setStatusMessage(null);
      onTurnCompleteRef.current?.();
    }
    wasActiveRef.current = active;
  }, [busy, settledPhase]);

  const detachRef = useRef(att.detach);
  detachRef.current = att.detach;
  const sendMessage = useCallback(
    async (text: string, fileIds: string[], localAttachments?: MessageAttachment[], reply?: ReplyTo | null, attachSelection = false) => {
      if (!controller || !ready || !initialized) return false;
      const trimmed = text.trim();
      if (!trimmed && fileIds.length === 0) return false;
      followBottomRef.current = true;
      const attachments = localAttachments ?? fileIds.map(id => ({ id, fileName: t.voiceNote, mimeType: "audio/webm" }));
      const selectedPassage = attachSelection ? props.feedSelection : undefined;
      const feedTarget = props.feedTarget && { ...props.feedTarget, ...(selectedPassage ? { target: selectedPassage.target, revision: selectedPassage.sourceRevision } : {}) };
      if (reply && attachSelection) setReplyTo(null);
      if (selectedPassage) props.onClearFeedSelection?.();
      setInput(""); setLocalError(null); setAcceptedGoal(null); setStatusMessage(null);
      updateTurn(newFeedChatTurn());
      const result = await controller.send({
        presentationId,
        text: trimmed,
        fileIds,
        assistantId,
        bodyExtras: requestFields(feedTarget, reply),
        userMessage: { ...(reply ? { replyTo: reply } : {}), ...(attachments.length ? { attachments } : {}) },
        onAccepted: () => { if (localAttachments) detachRef.current(); },
        onUserMessageSaved: (id) => sentTargetsRef.current.set(id, feedTarget),
        // Failure before acceptance: the text returns to the composer.
        onRejected: () => setInput((current) => current || trimmed),
      });
      if (result === "invalid" || result === "busy") { setInput((current) => current || trimmed); setLocalError(t.streamFailed); return false; }
      return true;
    },
    // Request fields read current props; the controller owns transport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, assistantId, initialized, model, researchMode, t, updateTurn, ready, props.feedTarget, props.feedSelection, props.onClearFeedSelection, fixedSessionId, channelId, presentationId],
  );

  const requestFields = (feedTarget: import('@use-brian/shared').FeedChatTarget | undefined, reply: ReplyTo | null | undefined) =>
    feedRequestFields({ feedTarget, reply, fixedSessionId, channelId, model, researchMode });

  const resolveConfirmation = async (toolCallId: string, decision: "approve" | "always_allow" | "deny", comment?: string) => {
    const confirmation = transcript.pendingConfirmations.find(item => item.toolCallId === toolCallId);
    if (!controller || !confirmation || confirmation.status !== "pending") return;
    const outcome = await controller.respondConfirmation(toolCallId, decision, comment);
    if (outcome === "resolved") { if (workspaceId) requestApprovalsRefresh(workspaceId); }
    else if (outcome === "failed") setLocalError(tGoal.confirmNotAllowed);
  };

  const retryRecovery = () => {
    if (!controller) return;
    controller.dismissNotice("reconnectFailed");
    void controller.reloadHistory();
    void controller.refreshPendingInput();
  };

  const onSend = useCallback(async (steer = false) => {
    if (!controller || !ready || !initialized || recoveryFailed || hydrating) return;
    const fileIds = att.fileIds();
    if ((!input.trim() && fileIds.length === 0) || att.uploading) return;
    // A turn is already running: hand this to it rather than starting a
    // second one. Attachments remain staged for the next ordinary turn because
    // the mid-turn queue is deliberately text-only.
    if (busy) {
      if (fileIds.length > 0 || replyTo || props.feedSelection) return;
      if (controller.queue(input, steer, { bodyExtras: { model }, assistantId, presentationId })) setInput("");
      return;
    }
    const localAttachments = readyAttachments(att.attachments).map(a => ({
      id: a.fileId!, fileName: a.fileName, mimeType: a.mimeType,
      ...(a.previewUrl ? { localPreviewUrl: a.previewUrl } : {}),
    }));
    await sendMessage(input, fileIds, localAttachments, replyTo, true);
  }, [controller, att.attachments, att.fileIds, att.uploading, busy, hydrating, initialized, input, model, assistantId, presentationId, ready, recoveryFailed, sendMessage, replyTo, props.feedSelection]);

  // Feed hides the global chat chrome but keeps its recorder controller alive.
  // While this floating tuning panel owns the replacement dock, short captures
  // must land in this visible sticky session instead of the hidden global chat.
  const replyToRef = useRef(replyTo);
  replyToRef.current = replyTo;
  useEffect(() => {
    if (!ownsDockRecorderTarget) return;
    return registerDockRecorderChatTarget({
      sendVoiceClip: (fileId) => sendMessage("", [fileId], undefined, replyToRef.current, true),
      getSessionId: () => sessionIdRef.current ?? undefined,
    });
  }, [ownsDockRecorderTarget, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      slashCommands.handleKeyDown(e);
      if (e.defaultPrevented) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void onSend();
      }
    },
    [onSend, slashCommands],
  );

  const handleCopy = useCallback(async (messageId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId((id) => (id === messageId ? null : id)), 1500);
    } catch { /* clipboard blocked */ }
  }, []);

  const retrySource = (messageId: string) => {
    const msgs = transcript.messages;
    const index = msgs.findIndex(message => message.id === messageId);
    const message = msgs[index];
    const source = message?.role === "user" ? message : msgs[index - 1];
    if (!source || source.role !== "user" || source.attachments?.length || source.fileAttachments?.length) return null;
    if (source.replyTo && !source.replyTo.id) return null;
    if (props.feedTarget && !sentTargetsRef.current.has(source.id)) return null;
    return source;
  };
  const handleRetry = (messageId: string) => {
    if (!controller || busy || !ready || !initialized) return;
    const source = retrySource(messageId);
    if (!source) return;
    // The original target and quote, never the current editor state.
    const target = sentTargetsRef.current.get(source.id);
    setLocalError(null); setAcceptedGoal(null); setStatusMessage(null);
    updateTurn(newFeedChatTurn());
    followBottomRef.current = true;
    void controller.edit({
      presentationId,
      messageId: source.id,
      text: source.text,
      assistantId,
      bodyExtras: requestFields(target, source.replyTo),
      ...(source.replyTo ? { userMessage: { replyTo: source.replyTo } } : {}),
      onUserMessageSaved: (id) => sentTargetsRef.current.set(id, target),
    });
  };

  const handleReply = (message: Message, container: HTMLElement | null) => {
    const target = buildReplyTarget({ message, selection: selectionTextWithin(container, window.getSelection()), authorName: message.role === "assistant" ? assistantName : tGoal.replyAuthorYou });
    if (!target) return;
    setReplyTo(target);
    inputRef.current?.focus();
  };
  const quotedMessage = (reply: ReplyTo | undefined) => reply ? <blockquote className="mb-1 border-l-2 border-primary/50 pl-2 text-xs text-muted-foreground" data-feed-reply-quote>{condenseQuote(reply.text)}</blockquote> : null;
  const messages = transcript.messages;
  const streamingText = isStreaming ? turn.visibleText : "";
  const liveTool = turn.tools.find(tool => tool.status === "running") ?? turn.tools.at(-1);
  const activity = useMemo<TuningChatActivity>(
    () =>
      isStreaming
        ? {
            isStreaming: true,
            streamingText,
            activeLabel: liveTool?.description ?? null,
          }
        : { isStreaming: false, streamingText: "", activeLabel: null },
    [liveTool?.description, isStreaming, streamingText],
  );
  const onActivityChangeRef = useRef(onActivityChange);
  useEffect(() => {
    onActivityChangeRef.current = onActivityChange;
  }, [onActivityChange]);
  useEffect(() => {
    onActivityChangeRef.current?.(activity);
  }, [activity]);
  const lastAssistantIdx = [...messages].reverse().findIndex((m) => m.role === "assistant");
  const lastAssistantId = lastAssistantIdx >= 0 ? messages[messages.length - 1 - lastAssistantIdx].id : null;
  const showEmpty = messages.length === 0 && !isStreaming;

  return (
    <div
      aria-busy={!ready}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden",
        docked
          ? "bg-background"
          : "rounded-xl border border-border bg-popover shadow-2xl",
      )}
    >
      <div className="relative shrink-0 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="relative shrink-0" aria-hidden>
            <AssistantAvatar
              id={assistantId}
              name={assistantName}
              iconSeed={iconSeed}
              size="sm"
            />
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-card" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight">
                {titleOverride ?? t.title}
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
              className="shrink-0 inline-flex h-11 w-11 sm:h-7 sm:w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <ChevronDownIcon />
            </button>
          ) : null}
        </div>
      </div>

      <div ref={containerRef}
        onScroll={() => { const el = containerRef.current; if (el) followBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="flex-1 min-h-0 overflow-y-auto">
        {/* A docked rail pads by the floating recorder's reserve while the
            button is lifted above its composer, so the newest message
            scrolls clear of it. */}
        <div className={cn("px-4 pt-4 space-y-5", docked ? "pb-[calc(1rem+var(--floating-recorder-reserve,0px))]" : "pb-4")}>
          {showEmpty ? (
            <EmptyState
              suggestions={suggestions}
              title={emptyTitle}
              body={emptyBody}
              suggestionsLabel={emptySuggestionsLabel}
              onPick={(s) => {
              setInput(s);
              requestAnimationFrame(() => inputRef.current?.focus());
              }}
            />
          ) : null}

          {messages.map((msg) => {
            const isLastAssistant = msg.id === lastAssistantId;
            if (msg.role === "user") {
              return (
                <div key={msg.id} className="flex justify-end group" data-feed-message>
                  <div className="max-w-[85%] space-y-1">
                    {quotedMessage(msg.replyTo)}
                    {msg.text && (
                      <div className="inline-block max-w-full rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[14px] leading-[1.5] text-secondary-foreground shadow-sm whitespace-pre-wrap break-words">
                        {msg.text}
                      </div>
                    )}
                    {msg.attachments?.length ? <MessageAttachments workspaceId={workspaceId} attachments={msg.attachments.map(file => ({ id: file.id, name: file.fileName, mime: file.mimeType, ...(file.localPreviewUrl ? { dataUrl: file.localPreviewUrl } : {}) }))} /> : null}
                    <div className="flex items-center gap-0.5 justify-end opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity -mr-1">
                      <span onMouseDown={event => event.preventDefault()}>{canReplyToMessage(msg) ? <ActionButton tooltip={tGoal.reply} onClick={(event) => handleReply(msg, event.currentTarget.closest("[data-feed-message]"))}><Reply className="size-3.5" aria-hidden /></ActionButton> : null}</span>
                      <ActionButton tooltip={copiedMessageId === msg.id ? t.copied : t.copy} onClick={() => void handleCopy(msg.id, msg.text)}>
                        {copiedMessageId === msg.id ? <CheckIcon /> : <CopyIcon />}
                      </ActionButton>
                      {!isStreaming && retrySource(msg.id) && (
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
              <div key={msg.id} className="flex gap-2.5 group" data-feed-message>
                <span className="mt-0.5 shrink-0" aria-hidden>
                  <AssistantAvatar
                    id={assistantId}
                    name={assistantName}
                    iconSeed={iconSeed}
                    size="sm"
                  />
                </span>
                <div className="flex-1 min-w-0 text-[14px] leading-[1.6] text-foreground break-words pt-0.5 space-y-1.5">
                  {quotedMessage(msg.replyTo)}
                  <ChatActivitySummary tools={msg.toolsUsed ?? []} durationMs={msg.activityDurationMs} />
                  {msg.text && (
                    <div className="chat-markdown prose prose-sm dark:prose-invert max-w-none">
                      <ChatMarkdown text={msg.text} />
                    </div>
                  )}
                  {msg.fileAttachments?.length ? <ChatFileAttachments attachments={msg.fileAttachments} /> : null}
                  {msg.citations?.length ? <ChatCitationList citations={msg.citations} label={tChat.citationLabel} /> : null}
                  {msg.documents?.map(document => <ChatDocumentCard key={document.id} document={document} onOpen={setOpenDocument} />)}
                  <div className="flex items-center gap-0.5 -ml-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <span onMouseDown={event => event.preventDefault()}>{canReplyToMessage(msg) ? <ActionButton tooltip={tGoal.reply} onClick={(event) => handleReply(msg, event.currentTarget.closest("[data-feed-message]"))}><Reply className="size-3.5" aria-hidden /></ActionButton> : null}</span>
                      <ActionButton tooltip={copiedMessageId === msg.id ? t.copied : t.copy} onClick={() => void handleCopy(msg.id, msg.text)}>
                      {copiedMessageId === msg.id ? <CheckIcon /> : <CopyIcon />}
                    </ActionButton>
                    {isLastAssistant && !isStreaming && retrySource(msg.id) && (
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
              <span className="mt-0.5 shrink-0" aria-hidden>
                <AssistantAvatar
                  id={assistantId}
                  name={assistantName}
                  iconSeed={iconSeed}
                  size="sm"
                />
              </span>
              <div className="flex-1 min-w-0 pt-0.5 space-y-2">
                <ChatActivityFeed events={turn.log.events} tools={turn.tools} replyStreaming={!!streamingText} replyPhase={turn.replyPhase} researchPhase={turn.researchPhase} startedAt={turn.startedAt} />
                {streamingText ? (
                  <div className="text-[14px] leading-[1.6] text-foreground break-words chat-markdown prose prose-sm dark:prose-invert max-w-none">
                    <ChatMarkdown text={streamingText} />
                    {turn.replyPhase === "generating" && <span aria-hidden className="inline-block w-[2px] h-[16px] bg-foreground rounded-full animate-pulse ml-0.5 align-text-bottom" />}
                  </div>
                ) : !turn.log.events.length && !turn.tools.length ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                    <span className="flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: "300ms" }} />
                    </span>
                    {statusMessage ?? t.thinking}
                  </div>
                ) : null}
                {turn.fileAttachments.length ? <ChatFileAttachments attachments={turn.fileAttachments} /> : null}
                {turn.citations.length ? <ChatCitationList citations={turn.citations} label={tChat.citationLabel} /> : null}
                {turn.documents.map(document => <ChatDocumentCard key={document.id} document={document} onOpen={setOpenDocument} />)}
              </div>
            </div>
          )}
          {reconnecting ? <p role="status" className="text-xs text-muted-foreground">{tChat.turnReconnecting}</p> : null}
          {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
          {transcript.pendingConfirmations.filter(c => c.status === "pending" || c.status === "approving").map(confirmation => (
            <ChatConfirmationCard key={confirmation.toolCallId} confirmation={confirmation}
              approveLabel={tChat.confirmationApprove} denyLabel={tChat.confirmationDeny} approvingLabel={tChat.confirmationApproving}
              onAlwaysAllow={id => void resolveConfirmation(id, "always_allow")}
              onApprove={id => void resolveConfirmation(id, "approve")} onDeny={(id, comment) => void resolveConfirmation(id, "deny", comment)} />
          ))}
          {pendingQuestion ? <PendingQuestionPanel sessionId={pendingQuestion.sessionId} approvalId={pendingQuestion.approvalId} dict={tChat.pendingQuestion}
            onAnswered={() => { controller?.questionSettled(pendingQuestion.approvalId); }}
            onCancelled={() => { controller?.questionSettled(pendingQuestion.approvalId); }} /> : null}
          {/* Messages handed to the running turn, not yet taken by it.
              See docs/architecture/engine/mid-turn-input.md. */}
          <QueuedInputs
            inputs={conversation?.queued ? [...conversation.queued] : []}
            dict={tQueue}
            onSteer={(inputId) => void controller?.steer(inputId)}
          />

          {error && errorCode === "budget_exhausted" && renderPlanGate ? (
            renderPlanGate(error)
          ) : error ? (
            <div className="rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
              {error}
              {recoveryFailed && sessionId ? <Button size="sm" variant="outline" className="mt-2" onClick={retryRecovery}>{t.retry}</Button> : null}
            </div>
          ) : null}
        </div>
      </div>

      <div ref={composerFooterRef} className="shrink-0 border-t border-border/60 bg-card/60 backdrop-blur-sm px-3 pt-2.5 pb-3">
        {dockRecorder ? (
          <>
            <DockRecorderRecovery rec={dockRecorder} className={cn("mb-1.5", inlineRecorderClass)} />
            <DockRecorderNotice rec={dockRecorder} className={cn("mb-1.5", inlineRecorderClass)} />
            <DockRecorderStrip rec={dockRecorder} className={cn("mb-1.5", inlineRecorderClass)} />
          </>
        ) : null}

        <div
          ref={slashContainerRef}
          className="relative rounded-xl border border-border/70 bg-background/60 shadow-sm focus-within:border-primary/50 transition-all [&_:focus-visible]:shadow-none"
        >
          <SlashCommandMenuList
            commands={slashCommands}
            className="bottom-full left-0 mb-1"
          />
          {workspaceId &&
          acceptedGoal?.sessionId ===
            sessionId ? (
            <GoalAcknowledgement
              notice={acceptedGoal}
              workspaceId={workspaceId}
              labels={{
                accepted: tGoal.goalAcceptedLabel,
                executing: tGoal.goalAcceptedStatus,
                done: tGoal.goalAcceptedDone,
                blocked: tGoal.goalAcceptedBlocked,
                abandoned: tGoal.goalAcceptedAbandoned,
                open: tGoal.goalAcceptedOpen,
                dismiss: tGoal.goalAcceptedDismiss,
              }}
              onDismiss={() => setAcceptedGoal(null)}
              className="mx-2.5 mt-2.5"
            />
          ) : null}
          <SlashCommandIndicator
            commands={slashCommands}
            className="mx-2.5 mt-2.5"
          />
          {replyTo ? <div className="mx-2.5 mt-2.5 flex items-start gap-2" data-feed-reply-context>
            <div className="min-w-0 flex-1 border-l-2 border-primary/60 pl-2"><p className="text-xs font-medium text-muted-foreground">{tGoal.replyingToMessage}</p><p className="truncate text-xs text-muted-foreground">{condenseQuote(replyTo.text)}</p></div>
            <Button type="button" variant="ghost" size="icon" className="size-11 md:size-8 shrink-0" aria-label={tGoal.replyCancel} onClick={() => setReplyTo(null)}><X className="size-3.5" aria-hidden /></Button>
          </div> : null}
          {props.feedSelection ? <div className="mx-2.5 mt-2.5 flex items-start gap-2 rounded-md bg-muted/40 p-2" data-feed-selection-attachment>
            <div className="min-w-0 flex-1"><p className="text-xs font-medium">{tc.selection}</p><blockquote className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">{props.feedSelection.quote || tc.post}</blockquote></div>
            <Button type="button" variant="ghost" size="icon" className="size-11 md:size-8 shrink-0" aria-label={tc.post} onClick={props.onClearFeedSelection}><X className="size-3.5" aria-hidden /></Button>
          </div> : null}
          <AttachmentChips
            attachments={att.attachments}
            onRemove={att.remove}
            className="mx-2.5 mt-2.5"
          />
          <div className="px-3.5 pt-2.5">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                const images = imageFilesFromClipboard(e.clipboardData);
                if (images.length === 0) return;
                e.preventDefault();
                void att.upload(images);
              }}
              // Typeable while the reply streams — `onSend` no-ops on
              // a running turn (it queues instead), so Enter can't double-send; the message
              // list carries the thinking indicator.
              placeholder={composerPlaceholder ?? t.composerPlaceholder}
              disabled={!ready}
              rows={1}
              className="w-full bg-transparent text-[16px] md:text-[14px] text-foreground placeholder:text-muted-foreground/60 resize-none outline-none focus-visible:shadow-none min-h-[24px] max-h-[140px] py-0.5 leading-relaxed"
              style={{ fieldSizing: "content" } as React.CSSProperties}
            />
          </div>
          <div className="flex flex-wrap items-center gap-0.5 px-2 pb-2 pt-1 md:flex-nowrap">
            {dockRecorder ? <DockRecorderButton rec={dockRecorder} className={cn(inlineRecorderClass, "h-11 md:h-9 [&>button]:min-w-11 md:[&>button]:min-w-0")} /> : null}
            {/* A desktop rail can be narrower than a phone. Phone controls may
                wrap to preserve touch targets; desktop controls compress into
                one row so the tier picker and Send are never orphaned below. */}
            <div className="ml-auto flex min-w-0 max-w-full items-center justify-end gap-1.5">
              <Select value={model} onValueChange={(v) => { if (v) setModel(v as ModelTier); }}>
                <SelectTrigger
                  size="sm"
                  aria-label={tChat.modelLabel}
                  className="min-h-11 md:min-h-0 min-w-0 text-[16px] md:text-xs gap-1.5 bg-muted/50 hover:bg-muted border-transparent"
                >
                  <span className="min-w-0 truncate">{model === "pro" ? t.modelPro : model === "max" ? t.modelMax : t.modelStandard}</span>
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
              {isStreaming && (
                <button
                  // One Stop: the controller's compare-and-set request for
                  // the turn it started or follows; a failure is a notice.
                  onClick={() => { void controller?.stop(); }}
                  className="inline-flex size-11 items-center justify-center rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0 md:size-8"
                  title={t.stop}
                >
                  <StopIcon />
                </button>
              )}
              {/* Send stays live during a turn — it QUEUES into the running one
                  (muted to mark the difference). See mid-turn-input.md. */}
              <button
                onClick={() => void onSend()}
                disabled={!ready || !initialized || recoveryFailed || hydrating || att.uploading || (busy && !isStreaming) || (isStreaming && (att.hasReady || !!replyTo || !!props.feedSelection)) || (!input.trim() && !att.hasReady)}
                className={cn(
                  "inline-flex size-11 items-center justify-center rounded-xl transition-colors shadow-sm shrink-0 md:size-8",
                  "disabled:opacity-30 disabled:cursor-not-allowed",
                  isStreaming
                    ? "bg-muted text-foreground/80 hover:bg-muted/80"
                    : "bg-action text-action-foreground hover:bg-action/90",
                )}
                title={isStreaming ? tQueue.send : t.send}
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </div>
      </div>
      <Dialog.Root open={!!openDocument} onOpenChange={open => { if (!open) setOpenDocument(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/35" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-[101] max-h-[85dvh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-xl">
          <div className="mb-4 flex items-center justify-between gap-3"><Dialog.Title className="text-base font-semibold">{openDocument?.title}</Dialog.Title>
            <Dialog.Close render={<Button variant="ghost" size="sm" className="min-h-11 md:min-h-8" />}>{tGoal.documentViewer.close}</Dialog.Close>
          </div>
          {openDocument ? <div className="chat-markdown prose prose-sm dark:prose-invert max-w-none break-words">{openDocument.format === "markdown" ? <ChatMarkdown text={openDocument.content} /> : <pre className="whitespace-pre-wrap break-words font-sans">{openDocument.content}</pre>}</div> : null}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
});

function EmptyState({
  suggestions,
  title,
  body,
  suggestionsLabel,
  onPick,
}: {
  suggestions?: string[];
  title?: string;
  body?: string;
  suggestionsLabel?: string;
  onPick: (s: string) => void;
}) {
  const t = useT().feedPage;
  const items = suggestions && suggestions.length > 0
    ? suggestions
    : [t.tuningChat.suggestion1, t.tuningChat.suggestion2, t.tuningChat.suggestion3];
  return (
    <div className="space-y-3 animate-fade-in">
      <div className="rounded-xl border border-border/60 bg-card p-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <SparkIcon />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium leading-snug">
              {title ?? t.tuningChat.emptyTitle}
            </p>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {body ?? t.tuningChat.emptyBody}
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="px-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {suggestionsLabel ?? t.tuningChat.trySuggestions}
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

function ActionButton({
  tooltip,
  onClick,
  children,
}: {
  tooltip: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <div className="relative group/btn">
      <button
        onClick={onClick}
        aria-label={tooltip}
        className="flex items-center justify-center w-9 h-9 md:w-7 md:h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        {children}
      </button>
      {/* A hover tooltip is a desktop affordance: hidden entirely on touch
          (the button carries its own `aria-label` via `title`), revealed on
          hover at `md+` (responsive contract M2). */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 bg-foreground text-background text-[11px] font-medium rounded-md whitespace-nowrap hidden md:block md:opacity-0 md:group-hover/btn:opacity-100 pointer-events-none transition-opacity shadow-lg">
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
