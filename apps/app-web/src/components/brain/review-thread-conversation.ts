"use client";
/**
 * The Brain review threads (entry Ask thread, entry Edit thread, the memory
 * "Ask about this" drawer) as presentations of the shared conversation
 * controller (M5 WP-E).
 *
 * Each thread mints its own server session first (`brain_inspection` or
 * `brain_edit`, bound server-side to one row), so the controller entry is
 * keyed by that session from the first turn. Send, the mid-turn queue, Stop
 * (compare-and-set first), approvals, reconnect and history reload are the
 * controller's; this module only binds a minted session to its entry, sends
 * once the presentation is attached, and maps the snapshot to the threads'
 * compact view. Profile: `DOCK_TURN_TRANSCRIPT` (the side-panel preset; the
 * committed reply keeps the server row id).
 *
 * Contract: docs/architecture/brain/corrections.md → "Entry assistant
 * threads on the shared controller (M5)", and
 * docs/architecture/features/chat-app.md → "Shared client controller
 * ownership". [COMP:app-web/review-thread-conversation]
 */
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import type { Message, ToolUsed } from "@use-brian/chat-ui";
import { extractMessageText, fetchSessionMessages, type DocSessionMessage } from "@/lib/api/sessions";
import type {
  ConversationController,
  ConversationNotice,
  ConversationSendInput,
  ConversationSendResult,
  ConversationState,
  PresentationCapabilities,
} from "@/lib/chat/conversation-controller";
import type { ClassifiedTurnFrame } from "@/lib/chat/turn-frames";
import { provisionalConversationKey, type ConversationRegistry } from "@/lib/chat/conversation-registry";
import { useConversation } from "@/lib/chat/use-conversation";

export type ReviewThreadKind = "entry-thread" | "entry-edit-thread" | "inspection-drawer";

/** The marker that ends every review preamble; the user's words follow it. */
const REVIEW_PREAMBLE_END = "[User asks]\n";

/**
 * The visible text of a review-thread user turn. The first message carries a
 * model-facing context block (`[Entry review context]`, `[Memory review
 * context]`) ending at `[User asks]`; the bubble shows only the question.
 */
export function stripReviewPreamble(text: string): string {
  if (!/^\[[A-Za-z ]+ review context\]\n/.test(text)) return text;
  const end = text.indexOf(REVIEW_PREAMBLE_END);
  return end < 0 ? text : text.slice(end + REVIEW_PREAMBLE_END.length);
}

/** Authorized history rows as plain thread turns (user and assistant text only). */
export function mapReviewHistoryRows(rows: DocSessionMessage[]): Message[] {
  return rows.flatMap((row): Message[] => {
    if (row.role !== "user" && row.role !== "assistant") return [];
    const text = extractMessageText(row.content);
    if (!text.trim()) return [];
    return [{ id: row.id, role: row.role, text, timestamp: new Date(row.timestamp) }];
  });
}

const ACTIVE = new Set(["running", "suspended"]);

type ReviewThreadView = {
  /** A direct turn or a re-attached (mirrored) turn is running. */
  busy: boolean;
  messages: Message[];
  /** The live answer segment (direct stream, else the mirror's snapshot). */
  streamingText: string;
  /** The live turn's tool steps. */
  liveTools: ToolUsed[];
  /** Last reasoning line, for the thinking indicator (never the answer). */
  reasoningTail: string;
};

/** Pure view of one snapshot. */
export function reviewThreadView(state: ConversationState | null): ReviewThreadView {
  if (!state) return { busy: false, messages: [], streamingText: "", liveTools: [], reasoningTail: "" };
  const direct = state.transcript.isStreaming;
  const mirrored = !direct && state.mirror.active;
  const reasoning = direct ? state.activity.reasoning : mirrored ? state.mirror.reasoning : "";
  const lines = reasoning.split("\n").filter(Boolean);
  return {
    busy: direct || mirrored || ACTIVE.has(state.run.phase),
    messages: state.transcript.messages,
    streamingText: direct ? state.transcript.streamingText : mirrored ? state.mirror.text : "",
    liveTools: direct ? state.activity.tools : mirrored ? state.mirror.activity.tools : [],
    reasoningTail: (lines[lines.length - 1] ?? "").slice(-160),
  };
}

/** The notice a thread shows inline: an error or Stop failure, newest last. */
export function latestNotice(state: ConversationState | null, codes: readonly ConversationNotice["code"][]): ConversationNotice | null {
  if (!state) return null;
  for (let index = state.notices.length - 1; index >= 0; index--) {
    const notice = state.notices[index]!;
    if (codes.includes(notice.code)) return notice;
  }
  return null;
}

type PendingSend = {
  sessionId: string;
  input: Omit<ConversationSendInput, "presentationId">;
  resolve: (result: ConversationSendResult) => void;
};

/**
 * Bind a review thread to its session's controller entry. `sessionId` is the
 * minted session (null until the first send mints it). `sendBound` sends once
 * the entry for that session is attached, so the first turn already runs on
 * the session-keyed entry with this presentation's profile.
 */
export function useReviewConversation(params: {
  workspaceId: string;
  sessionId: string | null;
  kind: ReviewThreadKind;
  onSurfaceEffect?: (frame: ClassifiedTurnFrame) => void;
  /** Uncertain queued text handed back (never resent). */
  onUnsent?: (texts: string[]) => void;
  /** Tests inject a registry over fake transports. */
  registry?: ConversationRegistry;
}): {
  controller: ConversationController | null;
  state: ConversationState | null;
  sendBound: (sessionId: string, input: Omit<ConversationSendInput, "presentationId">) => Promise<ConversationSendResult>;
  /** The entry bound now (an async send outlives the render that started it). */
  currentController: () => ConversationController | null;
} {
  const presentationId = useId();
  const clientId = useId();
  const effectRef = useRef(params.onSurfaceEffect);
  effectRef.current = params.onSurfaceEffect;
  const capabilities = useMemo<PresentationCapabilities>(
    () => ({
      profile: "dock",
      onSurfaceEffect: (frame) => effectRef.current?.(frame),
      // A fresh row-bound session has nothing pending to restore.
      pendingProbe: false,
    }),
    [],
  );
  const { controller, value: state } = useConversation(
    {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      provisionalKey: provisionalConversationKey(params.kind, clientId),
      presentationId,
      capabilities,
      ...(params.registry ? { registry: params.registry } : {}),
    },
    (snapshot) => snapshot,
  );

  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const currentController = useCallback(() => controllerRef.current, []);
  const pendingRef = useRef<PendingSend | null>(null);
  const flushPending = useCallback((current: ConversationController | null) => {
    const pending = pendingRef.current;
    if (!pending || !current || current.getSessionId() !== pending.sessionId) return;
    pendingRef.current = null;
    void current.send({ ...pending.input, presentationId }).then(pending.resolve, () => pending.resolve("failed"));
  }, [presentationId]);
  // The attach (a layout effect) has run by now, so the turn starts on the
  // attached entry with this presentation's profile and effect handler.
  useEffect(() => { flushPending(controller); }, [controller, flushPending]);
  // An unmount before the entry bound drops the send; nothing was posted.
  useEffect(() => () => {
    pendingRef.current?.resolve("disposed");
    pendingRef.current = null;
  }, []);

  const sendBound = useCallback(
    (sessionId: string, input: Omit<ConversationSendInput, "presentationId">) =>
      new Promise<ConversationSendResult>((resolve) => {
        pendingRef.current?.resolve("superseded");
        pendingRef.current = { sessionId, input, resolve };
        flushPending(controller);
      }),
    [controller, flushPending],
  );

  // The presentation owns its history (no `mapHistoryRows`): re-read the
  // authorized rows whenever the controller says history should be re-read
  // (a re-attached turn landed, or queued text became uncertain).
  const historyEpoch = state?.historyEpoch ?? 0;
  const boundSession = state?.transcript.sessionId ?? null;
  useEffect(() => {
    if (!controller || historyEpoch === 0 || !boundSession) return;
    const abort = new AbortController();
    void fetchSessionMessages(boundSession, { signal: abort.signal, strict: true })
      .then((rows) => {
        if (!abort.signal.aborted && controller.getSessionId() === boundSession) controller.loadMessages(mapReviewHistoryRows(rows));
      })
      .catch(() => { /* the painted thread stays as it was */ });
    return () => abort.abort();
  }, [controller, historyEpoch, boundSession]);

  const unsentCount = state?.unsent.length ?? 0;
  const unsentRef = useRef(params.onUnsent);
  unsentRef.current = params.onUnsent;
  useEffect(() => {
    if (!controller || unsentCount === 0) return;
    const texts = controller.takeUnsent();
    if (texts.length) unsentRef.current?.(texts);
  }, [controller, unsentCount]);

  return { controller, state, sendBound, currentController };
}
