/**
 * One conversation's client owner: send, follow, Stop, approval and recovery
 * orchestration over `createChatControllerCoordinator`. Presentations (the
 * full page, every dock instance) attach to it; it outlives their unmount
 * inside the scoped conversation registry.
 *
 * Contract: docs/architecture/features/chat-app.md → "Shared client controller
 * ownership", "Stopping a turn" (Stop ordering decision) and "Disconnect is
 * not a stop" (one reconnect policy). [COMP:app-web/conversation-controller]
 */
import {
  DOCK_TURN_TRANSCRIPT,
  FULL_PAGE_TURN_TRANSCRIPT,
  armsAnswerReset,
  buildTurnTranscriptMessage,
  chatReducer,
  createSSEBuffer,
  initialChatState,
  initialTurnTranscript,
  parseSSEStream,
  reduceTurnTranscriptFrame,
  runStream,
  turnTranscriptReducer,
  type AuthFetch,
  type ChatAction,
  type ChatControllerIdentity,
  type ChatInteractionState,
  type ChatRunState,
  type ChatState,
  type Message,
  type PendingConfirmation,
  type TurnFrameAdapter,
  type TurnTranscriptProfile,
  type TurnTranscriptState,
} from "@use-brian/chat-ui";
import { z } from "zod";
import { feedChatTargetSchema } from "@use-brian/shared";
import { createVisibilityGate } from "@/lib/workspace-events";
import type { DocSessionMessage } from "@/lib/api/sessions";
import type { ExternalActionConfirmation } from "@/lib/api/pending-questions";
import { createChatControllerCoordinator } from "./use-chat-controller";
import { classifyTurnFrame, flushesPaint, type ClassifiedTurnFrame } from "./turn-frames";

export type ConversationScope = { apiOrigin: string; viewerId: string; workspaceId: string };

export type PresentationProfile = "page" | "dock";

export type PresentationCapabilities = {
  profile: PresentationProfile;
  /** Surface-effect and presentation-local frames of turns this presentation started. */
  onSurfaceEffect?: (frame: ClassifiedTurnFrame) => void;
  describeTool?: TurnFrameAdapter["describeTool"];
  pageIdsFromToolResult?: TurnFrameAdapter["pageIdsFromToolResult"];
  parseDocument?: TurnFrameAdapter["parseDocument"];
  /** Localized mapping of authorized history rows; enables history loading and attach seeding. */
  mapHistoryRows?: (rows: DocSessionMessage[]) => Message[];
  /** Each validated frame once (direct: originator; follow: latest presentation). */
  onFrame?: (frame: ClassifiedTurnFrame) => void;
  /** False skips the hydrate attach's pending-input probe. */
  pendingProbe?: boolean;
  /** Detaching last ends a follow with no direct stream here and frees the entry. */
  releaseOnDetach?: boolean;
  /** What leftover queued text becomes at the end of a turn (default `send`). */
  queueDrain?: "send" | "return";
};

/** Typed codes only. Copy stays in presentations and their dictionaries. */
export type ConversationNotice =
  | { code: "reconnecting" }
  | { code: "reconnectFailed"; cause: "budget" | "rejected"; status?: number }
  | { code: "turnEnd"; reason: string; stoppedByName: string | null; senderUserId: string | null }
  | { code: "servedBy"; assistantId: string }
  | { code: "queued" }
  | { code: "error"; errorCode: string; customEndpoint?: boolean; message?: string; sharedChat?: boolean }
  | { code: "turnNotice"; notice: string; message?: string }
  | { code: "stopTurnFailed" }
  | { code: "confirmNotAllowed" };

export type ConversationQueuedInput = {
  readonly inputId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly steer: boolean;
  /** The side POST failed or the stream carrying its acknowledgement died. */
  readonly uncertain: boolean;
  /** A room post the server saved and owns: never drained or resent. */
  readonly serverHeld?: boolean;
};

export type ConversationMirror = {
  active: boolean;
  text: string;
  reasoning: string;
  replyPhase: "generating" | "saving" | "finishing";
  assistantId: string | null;
  startedAt: number | null;
  activity: TurnTranscriptState;
  /** Who started the mirrored turn, when the server says. */
  senderUserId: string | null;
  researchPhase: ResearchPhase | null;
};

export type ResearchPhase = "detected" | "starting" | "parallel";

export type ConversationReconnect = { attempt: number; nextAt: number | null; budgetEndsAt: number | null };

export type ConversationQuestion = {
  approvalId: string;
  question: string;
  expiresAt: string | null;
  sessionId: string;
};

export type ConversationState = {
  scope: ConversationScope;
  identity: ChatControllerIdentity;
  run: ChatRunState & { stopRequested: boolean; reconnect: ConversationReconnect };
  turnId: string | null;
  transcript: ChatState;
  activity: TurnTranscriptState;
  mirror: ConversationMirror;
  interaction: ChatInteractionState & { pendingConfirmations: PendingConfirmation[] };
  queued: readonly ConversationQueuedInput[];
  /** Text whose delivery is uncertain, handed back instead of being resent. */
  unsent: readonly string[];
  notices: readonly ConversationNotice[];
  room: { typers: readonly { userId: string; name: string | null }[]; pinsEpoch: number; assistantId: string | null };
  /** Bumped whenever authorized history should be re-read. */
  historyEpoch: number;
  /** Latest direct-stream research phase of the current turn. */
  researchPhase: ResearchPhase | null;
  /** The opening hydrate probe has not answered its first status yet. */
  hydrating: boolean;
  /** A turn is running or suspended, direct or re-attached: route input to `queue()`. */
  turnLive: boolean;
  /** Bumped on every successful re-attach; hosts clear their transient banners. */
  reattachEpoch: number;
  /** The pending question, independent of any approval card shown with it. */
  question: ConversationQuestion | null;
  /** The assistant the live turn answers as (direct member, else the mirror's). */
  liveAssistantId: string | null;
  /** The last pending-input read's external requests, for its session. */
  pendingInput: { sessionId: string; externalConfirmations: readonly ExternalActionConfirmation[] } | null;
  presentations: number;
  disposed: boolean;
};

export type PendingInputProbe = {
  pending: { approvalId: string; question: string | null; expiresAt: string | null } | null;
  toolConfirmation: PendingConfirmation | null;
  /**
   * Independent human requests from the same read (never suspend a turn).
   * Undefined means the read could not tell (a transient failure): the
   * previous list is kept rather than shown as empty.
   */
  externalConfirmations?: readonly ExternalActionConfirmation[];
};

/** Build-log bound: a running turn cannot grow client memory without limit. */
export const BUILD_LOG_LIMIT = 1_000;

export type ConversationTransport = {
  authFetch: AuthFetch;
  apiUrl: string;
  readStatus: (sessionId: string) => Promise<{ status: string; turnId: string | null; turnEndReason?: string | null }>;
  stopTurn: (sessionId: string, turnId: string | null | undefined) => Promise<{ stopped: boolean }>;
  confirmLive: (input: { sessionId: string; toolCallId: string; decision: "allow" | "always_allow" | "deny"; comment?: string }) => Promise<{ ok: boolean; status: number }>;
  respondRestored: (approvalId: string, decision: "approved" | "rejected", comment?: string, options?: { grantAlways?: boolean }) => Promise<{ ok: boolean; status?: number }>;
  fetchPending: (sessionId: string) => Promise<PendingInputProbe>;
  answerQuestion: (sessionId: string, approvalId: string, answer: string) => Promise<{ ok: boolean }>;
  cancelQuestion: (sessionId: string, approvalId: string) => Promise<{ ok: boolean }>;
  /** Already-mapped history (tests, hosts with their own mapping). */
  loadHistory?: (sessionId: string, signal: AbortSignal) => Promise<Message[]>;
  /** Authorized raw history rows, mapped by the presentation's `mapHistoryRows`. */
  fetchHistoryRows?: (sessionId: string, signal: AbortSignal, onCached?: (rows: DocSessionMessage[]) => void) => Promise<DocSessionMessage[]>;
  withdrawRetainedHistory?: (scope: ConversationScope, sessionId: string) => Promise<void>;
};

export type ConversationScheduler = {
  requestFrame: (callback: () => void) => unknown;
  cancelFrame: (handle: unknown) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Epoch clock. */
  now: () => number;
  /** Monotonic clock for step durations. */
  monotonic: () => number;
};

export type ReconnectPolicy = {
  baseMs: number;
  maxMs: number;
  /** The dock's historical budget. */
  budgetMs: number;
  /** The deployment's server turn cap, when known; the shorter one wins. */
  serverTurnCapMs?: number;
};

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = { baseMs: 3_000, maxMs: 30_000, budgetMs: 35 * 60_000 };
/**
 * The server's bound on holding a resume follow open for an enqueued resume
 * (`RESUME_FOLLOW_LIMIT_MS`); presentations use it for their waiting state.
 * The controller does not re-probe: see askquestion-suspend-resume.md.
 */
export const RESUME_ATTACH_WINDOW_MS = 120_000;
/** History reads after a confirmed Stop retry this many times. */
const HISTORY_RETRY_ATTEMPTS = 4;
/** Transport errors a successful re-attach supersedes. */
const TRANSIENT_ERRORS = /^(stream_failed|stream_interrupted|stream_error|http_5\d\d)$/;
/** Paint fallback when animation frames are throttled (hidden tab). */
const PAINT_FALLBACK_MS = 100;

/** The only request fields a presentation may add to a turn. */
export const conversationBodyExtrasSchema = z.object({
  appOrigin: z.string(),
  model: z.string(),
  mode: z.literal("research"),
  meteredAccepted: z.boolean(),
  meteredProfileId: z.string(),
  meteredToolRounds: z.number(),
  docViewId: z.string(),
  docAnchorBlockId: z.string(),
  viewingSkillRowId: z.string(),
  viewingBrainEntry: z.record(z.unknown()),
  docActiveThemeId: z.string(),
  timezone: z.string(),
  roomResponseGroup: z.object({ assistantIds: z.array(z.string()), sourceMessageId: z.string().optional() }),
  ask: z.boolean(),
  midTurn: z.boolean(),
  steer: z.boolean(),
  replyTo: z.object({ id: z.string().optional(), text: z.string() }),
  contextGroupId: z.string().nullable(),
  contextProjectId: z.string().nullable(),
  channelId: z.string(),
  /** Feed turns: the target the chat is anchored to. */
  feedTarget: feedChatTargetSchema,
  /** Office turns: the sender's selection (the server's `SelectionSchema`). */
  officeSelection: z.object({ targetIds: z.array(z.string().uuid()).max(50) }).strict(),
  sessionAudience: z.literal("personal"),
  /** KB turns: the chat route's private scope anchor (an id or `manual`). */
  kbSourceId: z.string().min(1),
}).partial().strict();

export type ConversationBodyExtras = z.infer<typeof conversationBodyExtrasSchema>;

export type ConversationSendInput = {
  presentationId: string;
  text: string;
  fileIds?: string[];
  recordingIds?: string[];
  bodyExtras?: ConversationBodyExtras;
  assistantId?: string | null;
  override?: { truncateFromMessageId?: string };
  /** Host-widened fields on the optimistic user bubble (for example `userAttachments`). */
  userMessage?: Record<string, unknown>;
  /**
   * Assistant ids of a serialized multi-assistant response group. The first
   * member owns the user row, files and truncate; later members continue
   * from its saved user message id.
   */
  responseGroup?: string[];
  /** The server accepted the turn (`session` or `user_message_saved`): clear the composer. */
  onAccepted?: (userMessageId: string | null) => void;
  /** The persisted id of this send's user row. */
  onUserMessageSaved?: (userMessageId: string) => void;
  /** Failure before acceptance: restore the composer text and chips. */
  onRejected?: () => void;
};

export type ConversationSendResult =
  | "completed" | "disconnected" | "failed" | "stopped" | "superseded" | "queued"
  | "busy" | "empty" | "invalid" | "disposed";

export type ConversationControllerOptions = {
  scope: ConversationScope;
  sessionId: string | null;
  room?: boolean;
  transport: ConversationTransport;
  scheduler?: Partial<ConversationScheduler>;
  reconnect?: Partial<ReconnectPolicy>;
  /** Registry re-key hook for a provisional entry adopting its session. */
  onSessionAdopted?: (sessionId: string) => void;
  /** Any published change (the registry's eviction check). */
  onChange?: () => void;
};

export type ConversationController = ReturnType<typeof createConversationController>;

const ACTIVE = new Set(["running", "suspended"]);

function defaultScheduler(): ConversationScheduler {
  const raf = typeof requestAnimationFrame === "function";
  return {
    requestFrame: (callback) => raf ? requestAnimationFrame(() => callback()) : setTimeout(callback, 16),
    cancelFrame: (handle) => raf ? cancelAnimationFrame(handle as number) : clearTimeout(handle as ReturnType<typeof setTimeout>),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    monotonic: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  };
}

/** A non-2xx, non-event-stream answer: a refusal, never a disconnect. */
export class ChatHttpRefusal extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Wrap a fetch so a refusal before any frame throws `ChatHttpRefusal`. */
function refusingFetch(fetcher: AuthFetch): AuthFetch {
  return async (input, init) => {
    const res = await fetcher(input, init);
    if (res.ok || (res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { code?: unknown; error?: unknown };
      if (typeof body.code === "string" && body.code) code = body.code;
    } catch { /* non-JSON body keeps the status code */ }
    throw new ChatHttpRefusal(res.status, code);
  };
}

const emptyMirror = (): ConversationMirror => ({
  active: false, text: "", reasoning: "", replyPhase: "generating", assistantId: null, startedAt: null,
  activity: initialTurnTranscript, senderUserId: null, researchPhase: null,
});

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Plain text of a persisted row's content (string or text blocks). */
function rowText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text"
    ? String((block as { text?: unknown }).text ?? "") : "")).join("").trim();
}

function confirmationFrom(payload: Record<string, unknown>, sessionId: string): PendingConfirmation {
  return {
    toolCallId: str(payload.toolCallId) ?? "",
    approvalId: str(payload.approvalId),
    toolName: str(payload.toolName) ?? "",
    displayName: str(payload.displayName),
    input: payload.input && typeof payload.input === "object" ? (payload.input as Record<string, unknown>) : {},
    description: str(payload.description),
    displayLines: Array.isArray(payload.displayLines) ? (payload.displayLines as string[]) : undefined,
    ...(payload.allowPersistentApproval === true ? { allowPersistentApproval: true } : {}),
    sessionId,
    status: "pending",
  };
}

type DirectRun = {
  identity: ChatControllerIdentity;
  abort: AbortController;
  sessionId: string | null;
  originator: string;
  profile: TurnTranscriptProfile;
  assistantId: string | null;
  localUserId: string;
  accepted: boolean;
  closed: boolean;
  stopped: boolean;
  failed: boolean;
  /** The server refused this send (HTTP refusal or `turn_in_flight`). */
  refused: { code: string; message?: string; notice?: Extract<ConversationNotice, { code: "error" }> } | null;
  /** An error that arrived while Stop was pending (or `turn_stopped`): Stop decides. */
  heldError: Extract<ConversationNotice, { code: "error" }> | null;
  /** The server ended this turn as stopped. */
  stoppedByServer: boolean;
  stoppedByName?: string | null;
  askedQuestion: boolean;
  continuation: boolean;
  userMessageId: string | null;
  onAccepted?: (userMessageId: string | null) => void;
  onRejected?: () => void;
  onUserMessageSaved?: (userMessageId: string) => void;
  result: ConversationSendResult;
};

type FollowReason = "hydrate" | "reconnect" | "resume" | "room";

type Follow = {
  identity: ChatControllerIdentity;
  sessionId: string;
  reason: FollowReason;
  abort: AbortController | null;
  timer: unknown;
  attempt: number;
  budgetEndsAt: number | null;
  sawRunning: boolean;
  sawTurnCompleted: boolean;
  ended: boolean;
  /** A resume follow keeps reopening until it sees a turn run, up to this time. */
  resumeUntil: number | null;
  /** Owner that was waiting for the answered approval, never the resumed owner. */
  resumeAfterTurnId: string | null;
};

export function createConversationController(options: ConversationControllerOptions) {
  const scheduler: ConversationScheduler = { ...defaultScheduler(), ...options.scheduler };
  const policy: ReconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, ...options.reconnect };
  const budgetMs = Math.min(policy.budgetMs, policy.serverTurnCapMs ?? Number.POSITIVE_INFINITY);
  const { transport, scope } = options;
  let room = options.room === true;

  let sessionId = options.sessionId;
  const coordinator = createChatControllerCoordinator(() => sessionId);
  let disposed = false;
  let transcript: ChatState = chatReducer(initialChatState, { type: "session/set", sessionId });
  let activity: TurnTranscriptState = initialTurnTranscript;
  let mirror = emptyMirror();
  let queued: ConversationQueuedInput[] = [];
  let unsent: string[] = [];
  let notices: ConversationNotice[] = [];
  let roomState: ConversationState["room"] = { typers: [], pinsEpoch: 0, assistantId: null };
  let historyEpoch = 0;
  let historyAccessRevocation = 0;
  let pendingReadEpoch = 0;
  let pendingRead: Promise<void> | null = null;
  let researchPhase: ResearchPhase | null = null;
  /** The hydrate follow has not answered its first status yet. */
  let hydrating = false;
  let reattachEpoch = 0;
  let historyRetryAttempt = 0;
  /** The turn a shown `turnEnd` notice describes; a later running turn clears it. */
  let turnEndTurnId: string | null = null;
  /** The last turn this controller finalized from its own direct stream. */
  let committedTurnId: string | null = null;
  let pendingInput: ConversationState["pendingInput"] = null;
  let buildLog: ClassifiedTurnFrame[] = [];
  let buildLogDropped = 0;
  let stopRequested = false;
  let stopPromise: Promise<"stopped" | "alreadyEnded" | "failed" | "revoked" | "none"> | null = null;
  let reconnect: ConversationReconnect = { attempt: 0, nextAt: null, budgetEndsAt: null };
  let direct: DirectRun | null = null;
  let follow: Follow | null = null;
  let hydrated = false;
  let group: { stopped: boolean } | null = null;
  let seeded = false;
  let localSeq = 0;
  let attachSeq = 0;
  let historyAbort: AbortController | null = null;
  let cacheRevalidationPending = false;
  let roomStopTimer: unknown = null;
  // ── Visibility release and release-on-detach (WP-E) ──
  const hidden = new Set<string>();
  let releasedFollow: { reason: FollowReason; budgetEndsAt: number | null } | null = null;
  let releasedOnDetach = false;
  let detachReleaseTimer: unknown = null;
  const presentations = new Map<string, { capabilities: PresentationCapabilities; seq: number }>();
  const queueExtras = new Map<string, {
    extras: ConversationBodyExtras; assistantId: string | null; drain?: "send" | "return"; presentationId?: string;
    /** For deterministic reconciliation of an uncertain entry. */
    queuedAt?: number; knownIds?: ReadonlySet<string>;
  }>();
  const listeners = new Set<() => void>();

  const compose = (): ConversationState => {
    const core = coordinator.getSnapshot();
    return {
      scope,
      identity: core.run.identity,
      run: { ...core.run, stopRequested, reconnect },
      turnId: coordinator.getTurnId(),
      transcript,
      activity,
      mirror,
      interaction: { ...core.interaction, pendingConfirmations: transcript.pendingConfirmations },
      queued,
      unsent,
      notices,
      room: roomState,
      historyEpoch,
      researchPhase,
      hydrating,
      turnLive: ACTIVE.has(core.run.phase),
      reattachEpoch,
      question: (() => {
        const pending = coordinator.getSnapshot().interaction.pending;
        return pending?.kind === "question" ? (pending.payload as ConversationQuestion) : null;
      })(),
      liveAssistantId: direct && !direct.closed ? direct.assistantId : mirror.active ? mirror.assistantId : null,
      pendingInput,
      presentations: presentations.size,
      disposed,
    };
  };
  let snapshot = compose();

  // ── Publication and paint batching ─────────────────────────────────────
  let frameHandle: unknown = null;
  let fallbackHandle: unknown = null;
  const cancelPaint = () => {
    if (frameHandle !== null) scheduler.cancelFrame(frameHandle);
    if (fallbackHandle !== null) scheduler.clearTimeout(fallbackHandle);
    frameHandle = fallbackHandle = null;
  };
  const publishNow = () => {
    cancelPaint();
    snapshot = compose();
    for (const listener of [...listeners]) listener();
    options.onChange?.();
    if (cacheRevalidationPending && !disposed && !(direct && !direct.closed) && !ACTIVE.has(phase()) && !(follow && follow.reason !== "hydrate" && follow.reason !== "room")) {
      cacheRevalidationPending = false;
      // Reconcile through the existing history owner after live optimistic work ends.
      queueMicrotask(() => {
        if (disposed) return;
        if (direct && !direct.closed || ACTIVE.has(phase()) || follow && follow.reason !== "hydrate" && follow.reason !== "room") { cacheRevalidationPending = true; return; }
        void reloadHistory();
      });
    }
  };
  /** Coalesce text, reasoning and snapshot frames into one paint. */
  const schedulePaint = () => {
    if (frameHandle !== null || disposed) return;
    frameHandle = scheduler.requestFrame(publishNow);
    fallbackHandle = scheduler.setTimeout(publishNow, PAINT_FALLBACK_MS);
  };
  /** Before any terminal, save, error, interaction or Stop transition. */
  const flushPaint = () => { if (frameHandle !== null) publishNow(); };
  coordinator.subscribe(() => { if (!disposed) publishNow(); });

  const dispatch = (action: ChatAction) => { transcript = chatReducer(transcript, action); };
  const addNotice = (notice: ConversationNotice) => {
    notices = [...notices.filter((item) => item.code !== notice.code), notice];
  };
  const clearNotice = (...codes: ConversationNotice["code"][]) => {
    if (notices.some((item) => codes.includes(item.code))) notices = notices.filter((item) => !codes.includes(item.code));
  };
  const phase = () => coordinator.getSnapshot().run.phase;

  // ── Presentations ──────────────────────────────────────────────────────
  const latestPresentation = () => {
    let latest: { id: string; capabilities: PresentationCapabilities; seq: number } | null = null;
    for (const [id, entry] of presentations) if (!latest || entry.seq > latest.seq) latest = { id, ...entry };
    return latest;
  };
  const profileOf = (presentationId: string | null): PresentationProfile =>
    (presentationId && presentations.get(presentationId)?.capabilities.profile) || latestPresentation()?.capabilities.profile || "page";
  const adapterFor = (presentationId: string | null, profile: TurnTranscriptProfile): TurnFrameAdapter => {
    const capabilities = (presentationId && presentations.get(presentationId)?.capabilities) || latestPresentation()?.capabilities;
    return {
      collect: profile.collect,
      now: scheduler.monotonic,
      describeTool: capabilities?.describeTool,
      pageIdsFromToolResult: capabilities?.pageIdsFromToolResult,
      parseDocument: capabilities?.parseDocument,
    };
  };
  /** Exactly once, to the originating presentation or the latest attached one. */
  const dispatchEffect = (originator: string, frame: ClassifiedTurnFrame) => {
    const target = presentations.get(originator) ?? latestPresentation();
    try { target?.capabilities.onSurfaceEffect?.(frame); } catch { /* a presentation's effect cannot break the stream */ }
  };
  const resetBuildLog = () => { buildLog = []; buildLogDropped = 0; };
  const observeFrame = (originator: string | null, frame: ClassifiedTurnFrame) => {
    buildLog.push(frame);
    if (buildLog.length > BUILD_LOG_LIMIT) { buildLog.splice(0, buildLog.length - BUILD_LOG_LIMIT); buildLogDropped++; }
    // Direct frames belong to the presentation that sent; follow frames are
    // shared conversation state, so every observer receives them.
    const targets = frame.stream === "direct"
      ? [((originator ? presentations.get(originator) : undefined) ?? latestPresentation())]
      : [...presentations.values()];
    for (const target of targets) {
      try { target?.capabilities.onFrame?.(frame); } catch { /* observers cannot break the stream */ }
    }
  };
  /**
   * History precedence: a presentation without a mapper owns its history
   * (it reloads on `historyEpoch`), so the controller maps rows only when
   * every attached presentation declares a mapper, using the latest one's.
   */
  const historyMapper = () => {
    if (!presentations.size || [...presentations.values()].some((entry) => !entry.capabilities.mapHistoryRows)) return undefined;
    return latestPresentation()?.capabilities.mapHistoryRows;
  };

  // ── Queue ──────────────────────────────────────────────────────────────
  const takeQueued = (inputId: string, owner: string | null): ConversationQueuedInput | null => {
    const entry = queued.find((item) => item.inputId === inputId && item.sessionId === owner);
    if (!entry) return null;
    queued = queued.filter((item) => item !== entry);
    return entry;
  };
  const markUncertain = (owner: string | null) => {
    queued = queued.map((item) => (item.sessionId === owner && !item.serverHeld ? { ...item, uncertain: true } : item));
  };
  /** Once per run generation: certain entries become one ordinary turn. */
  const drainQueue = (owner: string | null) => {
    if (!owner) return;
    // Server-held room posts leave the tray; the server owns their fallback.
    const entries = queued.filter((item) => item.sessionId === owner && !item.serverHeld);
    queued = queued.filter((item) => item.sessionId !== owner);
    const uncertain = entries.filter((item) => item.uncertain);
    // Each entry keeps the drain policy of the presentation that queued it.
    const contexts = new Map(entries.map((item) => [item.inputId, queueExtras.get(item.inputId)]));
    for (const item of entries) queueExtras.delete(item.inputId);
    const returned = entries.filter((item) => !item.uncertain && contexts.get(item.inputId)?.drain === "return");
    if (returned.length) unsent = [...unsent, ...returned.map((item) => item.text)];
    const certain = entries.filter((item) => !item.uncertain && contexts.get(item.inputId)?.drain !== "return");
    // The fallback turn keeps the entries' context; later entries win.
    let bodyExtras: ConversationBodyExtras = {};
    let assistantId: string | null = null;
    let queuedBy: string | undefined;
    for (const item of certain) {
      const context = contexts.get(item.inputId);
      if (!context) continue;
      bodyExtras = { ...bodyExtras, ...context.extras };
      assistantId = context.assistantId ?? assistantId;
      queuedBy = context.presentationId ?? queuedBy;
    }
    const { midTurn: _midTurn, steer: _steer, ...turnExtras } = bodyExtras;
    if (uncertain.length) {
      historyEpoch++;
      if (transport.fetchHistoryRows) void reconcileUncertain(owner, uncertain.map((item) => ({ item, context: contexts.get(item.inputId) })));
      else { unsent = [...unsent, ...uncertain.map((item) => item.text)]; void reloadHistory(); }
    }
    if (!certain.length) return;
    const queuedByEntry = queuedBy ? presentations.get(queuedBy) : undefined;
    const originator = queuedBy && queuedByEntry ? { id: queuedBy, ...queuedByEntry } : latestPresentation();
    if (!originator) { unsent = [...unsent, ...certain.map((item) => item.text)]; return; }
    const generation = coordinator.getSnapshot().run.identity.generation;
    scheduler.setTimeout(() => {
      // Ownership is rechecked after the deferral; a switched or disposed
      // conversation keeps the text as unsent rather than sending it elsewhere.
      if (disposed || sessionId !== owner || coordinator.getSnapshot().run.identity.generation !== generation) {
        if (!disposed) { unsent = [...unsent, ...certain.map((item) => item.text)]; publishNow(); }
        return;
      }
      void send({ presentationId: originator.id, text: certain.map((item) => item.text).join("\n\n"), bodyExtras: turnExtras, ...(assistantId ? { assistantId } : {}) });
    }, 0);
  };

  /**
   * Uncertain queued text returns as unsent only if authorized history shows
   * the server did not apply it: a user row with the same text written after
   * the entry was queued (and not already shown then) means it was applied.
   */
  async function reconcileUncertain(owner: string, pending: Array<{ item: ConversationQueuedInput; context?: { queuedAt?: number; knownIds?: ReadonlySet<string> } }>) {
    let rows: DocSessionMessage[] | null = null;
    try { rows = await transport.fetchHistoryRows!(owner, new AbortController().signal); } catch { rows = null; }
    if (disposed) return;
    const used = new Set<string>();
    const returned = pending.filter(({ item, context }) => {
      if (!rows) return true; // a failed read keeps the text: losing it is worse
      const match = rows.find((row) => row.role === "user" && !used.has(row.id)
        && !context?.knownIds?.has(row.id)
        && (context?.queuedAt === undefined || Date.parse(row.timestamp) >= context.queuedAt - 60_000)
        && rowText(row.content) === item.text);
      if (match) { used.add(match.id); return false; }
      return true;
    }).map(({ item }) => item.text);
    if (returned.length) unsent = [...unsent, ...returned];
    void reloadHistory();
    publishNow();
  }

  // ── Direct stream ──────────────────────────────────────────────────────
  const owns = (run: DirectRun) => !disposed && direct === run && coordinator.isCurrent(run.identity);
  const accept = (run: DirectRun) => {
    if (run.accepted) return;
    run.accepted = true;
    try { run.onAccepted?.(run.userMessageId); } catch { /* presentation callback */ }
  };
  const resetActivity = (profile: TurnTranscriptProfile) => {
    // Page resets lose t0 (its builder history); the dock restarts it.
    activity = turnTranscriptReducer(activity, {
      type: "reset", startedAt: profile === DOCK_TURN_TRANSCRIPT ? scheduler.now() : null,
    });
  };
  const applyQueuedInput = (run: DirectRun, inputId: string, messageId: string) => {
    const entry = takeQueued(inputId, run.sessionId);
    if (!entry) return;
    const segment = buildTurnTranscriptMessage(activity, { ...run.profile, assistantId: run.assistantId }, scheduler.now());
    if (segment) dispatch({ type: "message/append", message: segment });
    dispatch({ type: "stream/reset" });
    resetActivity(run.profile);
    dispatch({ type: "message/append", message: { id: messageId, role: "user", text: entry.text, timestamp: new Date(scheduler.now()) } });
  };

  const handleDirectFrame = (run: DirectRun, frame: ClassifiedTurnFrame) => {
    if (!owns(run)) {
      // A taken input is durable even when this stream no longer owns the view.
      if (frame.event === "input_applied" && typeof frame.payload.inputId === "string") takeQueued(frame.payload.inputId, run.sessionId);
      return;
    }
    if (frame.class === "ignorable") return;
    if (flushesPaint(frame)) flushPaint();
    observeFrame(run.originator, frame);
    const { payload, event } = frame;
    if (event === "session" && coordinator.bindTurn(run.identity, payload.turnId)) {
      // Bound: a pending Stop waiter now has its exact owner.
    }
    switch (event) {
      case "session": {
        const id = str(payload.sessionId);
        if (id && !run.sessionId) {
          // Adopt before changing the selection the coordinator reads.
          if (coordinator.adoptSession(run.identity, id)) run.identity = { ...run.identity, sessionId: id };
          run.sessionId = id;
          sessionId = id;
          dispatch({ type: "session/set", sessionId: id });
          options.onSessionAdopted?.(id);
        }
        if (run.sessionId) accept(run);
        break;
      }
      case "user_message_saved": {
        const id = String(payload.id);
        if (!run.continuation) {
          dispatch({ type: "message/rekey", messageId: run.localUserId, id });
          run.userMessageId ??= id;
          try { run.onUserMessageSaved?.(id); } catch { /* presentation callback */ }
        }
        accept(run);
        break;
      }
      case "input_applied":
        applyQueuedInput(run, String(payload.inputId), str(payload.messageId) ?? `queued-${String(payload.inputId)}`);
        break;
      case "assistant_message_saved":
        activity = reduceTurnTranscriptFrame(activity, event, payload, adapterFor(run.originator, run.profile), run.profile);
        dispatch({ type: "stream/saved" });
        break;
      case "reply_text_complete":
        dispatch({ type: "stream/text-complete" });
        break;
      case "text_delta": {
        activity = reduceTurnTranscriptFrame(activity, event, payload, adapterFor(run.originator, run.profile), run.profile);
        const delta = str(payload.text);
        if (delta) dispatch({ type: "stream/append", text: delta });
        schedulePaint();
        return;
      }
      case "reasoning":
        activity = reduceTurnTranscriptFrame(activity, event, payload, adapterFor(run.originator, run.profile), run.profile);
        schedulePaint();
        return;
      case "status": {
        const phase = payload.phase === "research_detected" ? "detected"
          : payload.phase === "research_starting" ? "starting"
          : payload.phase === "research_parallel" ? "parallel" : null;
        if (phase) researchPhase = phase;
        break;
      }
      case "tool_confirmation_required": {
        // askQuestion is answered in its own panel (restored by the pending
        // probe when the turn ends), never as an approve/deny card.
        if (payload.toolName === "askQuestion") { run.askedQuestion = true; break; }
        const confirmation = confirmationFrom(payload, run.sessionId ?? "");
        coordinator.presentInteraction(run.identity, {
          kind: "tool-confirmation", approvalId: confirmation.approvalId ?? `tool:${confirmation.toolCallId}`,
          toolCallId: confirmation.toolCallId, source: "live", status: "pending", payload: confirmation,
        });
        dispatch({ type: "confirmation/add", confirmation });
        break;
      }
      case "done":
        // M5Q-12: Stop landed during admission; the server ends the stream stopped.
        if (payload.stopped === true) {
          run.stoppedByServer = true;
          run.stoppedByName = str(payload.stoppedByName) ?? null;
        }
        break;
      case "posted":
        run.failed = true;
        dispatch({ type: "stream/abort" });
        resetActivity(run.profile);
        break;
      case "queued":
      case "input_queued":
        addNotice({ code: "queued" });
        break;
      case "notice":
        addNotice({ code: "turnNotice", notice: String(payload.code), ...(typeof payload.message === "string" ? { message: payload.message } : {}) });
        break;
      case "error": {
        if (payload.code === "pending_question_exists" && typeof payload.approvalId === "string" && run.sessionId) {
          coordinator.presentInteraction(run.identity, {
            kind: "question", approvalId: payload.approvalId, source: "live", status: "pending",
            payload: { approvalId: payload.approvalId, question: str(payload.question) ?? "", expiresAt: str(payload.expiresAt) ?? null, sessionId: run.sessionId } satisfies ConversationQuestion,
          });
          break;
        }
        const message = str(payload.message) ?? str(payload.error);
        const notice: Extract<ConversationNotice, { code: "error" }> = {
          code: "error", errorCode: str(payload.code) ?? "stream_error",
          ...(payload.customEndpoint === true ? { customEndpoint: true } : {}),
          ...(payload.sharedChat === true ? { sharedChat: true } : {}),
          ...(message ? { message } : {}),
        };
        // A stop is never reported as a failure: while Stop is pending the
        // error is held for Stop to decide, and `turn_stopped` is the stop.
        if (payload.code === "turn_stopped" || stopPromise) {
          run.heldError = payload.code === "turn_stopped" ? null : notice;
          run.stoppedByServer = true;
          break;
        }
        // Before acceptance and before any user row is saved, an error rejects
        // the send (the text returns to the composer) instead of failing a turn.
        if (payload.code === "turn_in_flight" || (!run.accepted && run.userMessageId === null && !run.continuation)) {
          run.refused = { code: notice.errorCode, ...(message ? { message } : {}), notice };
        }
        run.failed = true;
        addNotice(notice);
        break;
      }
      default: {
        if (frame.class === "activity" || event === "page_created" || event === "view_payload") {
          const before = activity;
          if (event === "tool_start" && payload.name === "askQuestion") run.askedQuestion = true;
          activity = reduceTurnTranscriptFrame(activity, event, payload, adapterFor(run.originator, run.profile), run.profile);
          if (armsAnswerReset(before, activity)) dispatch({ type: "stream/reset" });
          if (event === "tool_result" && payload.isError === true) {
            const confirmation = transcript.pendingConfirmations.find((item) => item.toolCallId === payload.id);
            if (confirmation?.status === "approved") {
              dispatch({ type: "confirmation/update", toolCallId: confirmation.toolCallId, patch: { status: "failed", ...(typeof payload.errorMessage === "string" ? { result: payload.errorMessage } : {}) } });
            }
          }
        }
        if (frame.class === "surface-effect" || frame.class === "presentation") dispatchEffect(run.originator, frame);
        break;
      }
    }
    publishNow();
  };

  /** The turn ended as stopped: keep the partial reply as the stopped reply. */
  const settleStopped = (run: DirectRun, byViewer: boolean) => {
    const stoppedTurnId = coordinator.getTurnId();
    run.closed = true;
    run.stopped = true;
    run.result = "stopped";
    const message = buildTurnTranscriptMessage(activity, { ...run.profile, assistantId: run.assistantId }, scheduler.now());
    dispatch(message ? { type: "stream/finalize", finalMessage: message } : { type: "stream/abort" });
    activity = turnTranscriptReducer(activity, { type: "reset", startedAt: null });
    clearConfirmations(run.identity);
    coordinator.cancel(run.identity);
    // The stopped line: this viewer's own Stop reads "you"; a server-side stop is neutral.
    addNotice({ code: "turnEnd", reason: "stopped_by_user", stoppedByName: byViewer ? null : run.stoppedByName ?? null, senderUserId: byViewer ? scope.viewerId : null });
    turnEndTurnId = stoppedTurnId;
    if (coordinator.claimExit(run.identity)) drainQueue(run.sessionId);
    // The saved partial replaces the local one; a failed read is transient and retried.
    historyEpoch++;
    historyRetryAttempt = 0;
    void reloadHistory(HISTORY_RETRY_ATTEMPTS);
    publishNow();
  };

  /** Fail a send the server did not accept: hand the text back, open no follow. */
  const rejectBeforeAcceptance = (run: DirectRun, errorCode: string, message?: string, notice?: Extract<ConversationNotice, { code: "error" }>) => {
    run.closed = true;
    run.result = "failed";
    coordinator.fail(run.identity, errorCode);
    dispatch({ type: "stream/abort" });
    if (!run.continuation) dispatch({ type: "message/remove", messageId: run.localUserId });
    activity = turnTranscriptReducer(activity, { type: "reset", startedAt: null });
    addNotice(notice ?? { code: "error", errorCode, ...(message ? { message } : {}) });
    try { run.onRejected?.(); } catch { /* presentation callback */ }
    if (coordinator.claimExit(run.identity)) drainQueue(run.sessionId);
    publishNow();
  };

  /** A server-reported resolution (possibly a teammate's) settles the card. */
  const settleConfirmation = (identity: ChatControllerIdentity, toolCallId: string, decision: unknown) => {
    const existing = transcript.pendingConfirmations.find((item) => item.toolCallId === toolCallId);
    if (!existing) {
      // M5Q-18: a viewer that holds the live card only as a restored
      // placeholder (`approval:<id>`) settles that card; the pending probe
      // restores only the current turn's one card.
      const denied = decision === "deny" || decision === "always_deny";
      for (const card of transcript.pendingConfirmations) {
        if (!card.restored || (card.status !== "pending" && card.status !== "approving")) continue;
        coordinator.resolveInteraction(identity, card.approvalId ?? `tool:${card.toolCallId}`);
        dispatch({ type: "confirmation/update", toolCallId: card.toolCallId, patch: { status: denied ? "denied" : "approved" } });
      }
      return;
    }
    coordinator.resolveInteraction(identity, existing?.approvalId ?? `tool:${toolCallId}`);
    if (existing && (existing.status === "pending" || existing.status === "approving")) {
      const denied = decision === "deny" || decision === "always_deny";
      dispatch({ type: "confirmation/update", toolCallId, patch: { status: denied ? "denied" : "approved" } });
    }
  };
  /** Completion ends any approve/deny card; a suspended question survives. */
  const clearConfirmations = (identity: ChatControllerIdentity) => {
    pendingReadEpoch++;
    const pending = coordinator.getSnapshot().interaction.pending;
    if (pending?.kind === "tool-confirmation") coordinator.resolveInteraction(identity, pending.approvalId);
    dispatch({ type: "confirmation/clear" });
  };

  const finalizeDirect = (run: DirectRun) => {
    committedTurnId = coordinator.getTurnId();
    const message = buildTurnTranscriptMessage(activity, { ...run.profile, assistantId: run.assistantId }, scheduler.now());
    dispatch(message ? { type: "stream/finalize", finalMessage: message } : { type: "stream/abort" });
    activity = turnTranscriptReducer(activity, { type: "reset", startedAt: null });
    clearConfirmations(run.identity);
    clearNotice("queued");
    coordinator.complete(run.identity);
    if (coordinator.claimExit(run.identity)) drainQueue(run.sessionId);
    if (run.askedQuestion && run.sessionId) void refreshPending(run.sessionId, run.identity);
  };

  /** The turn is still running server-side: paint the mirror and follow. */
  const enterDisconnect = (run: DirectRun) => {
    run.closed = true;
    run.result = "disconnected";
    coordinator.disconnect(run.identity);
    markUncertain(run.sessionId);
    mirror = { ...emptyMirror(), active: true, text: activity.text, assistantId: run.assistantId, startedAt: activity.startedAt };
    dispatch({ type: "stream/abort" });
    activity = turnTranscriptReducer(activity, { type: "reset", startedAt: null });
    clearNotice("queued");
    if (!run.sessionId) {
      run.result = "failed";
      coordinator.fail(run.identity, "stream_interrupted");
      addNotice({ code: "error", errorCode: "stream_interrupted" });
      if (coordinator.claimExit(run.identity)) drainQueue(run.sessionId);
      publishNow();
      return;
    }
    publishNow();
    startFollow("reconnect");
  };

  /** Serialized response-group continuation shared by every member turn. */
  type TurnPlan = {
    input: ConversationSendInput;
    text: string;
    extras: ConversationBodyExtras;
    assistantId: string | null;
    index: number;
    groupIds: string[] | null;
    sourceMessageId: string | null;
  };

  async function send(input: ConversationSendInput): Promise<ConversationSendResult> {
    if (disposed) return "disposed";
    const text = input.text.trim();
    const fileIds = input.fileIds ?? [];
    const recordingIds = input.recordingIds ?? [];
    if (!text && !fileIds.length && !recordingIds.length) return "empty";
    const extras = conversationBodyExtrasSchema.safeParse(input.bodyExtras ?? {});
    if (!extras.success) return "invalid";
    const directLive = direct !== null && !direct.closed && owns(direct);
    // An addressed room message during a teammate's followed turn is saved
    // first and handed to that turn (chat-parity D3); it is not a new turn.
    if (room && ACTIVE.has(phase()) && !directLive && extras.data.midTurn === true && sessionId) {
      return postRoomMidTurn(input, text, extras.data);
    }
    if (ACTIVE.has(phase()) || directLive) return "busy";
    const groupIds = input.responseGroup && input.responseGroup.length > 1 ? input.responseGroup : null;
    group = { stopped: false };
    const currentGroup = group;
    let sourceMessageId: string | null = null;
    let result: ConversationSendResult = "completed";
    const members = groupIds ?? [input.assistantId ?? null];
    let skipped = false;
    for (const [index, assistantId] of members.entries()) {
      if (disposed || currentGroup.stopped || group !== currentGroup) { skipped = index > 0 && currentGroup.stopped; break; }
      if (index > 0 && !sourceMessageId) break;
      const turn = await runTurn({ input, text, extras: extras.data, assistantId, index, groupIds, sourceMessageId });
      result = turn.result;
      sourceMessageId ??= turn.userMessageId;
      if (result !== "completed" || turn.askedQuestion) break;
    }
    if (groupIds && sourceMessageId && !disposed) { historyEpoch++; void reloadHistory(); }
    return skipped && result === "completed" ? "stopped" : result;
  }

  async function runTurn(plan: TurnPlan): Promise<{ result: ConversationSendResult; userMessageId: string | null; askedQuestion: boolean }> {
    const { input, text, index } = plan;
    const continuation = index > 0;
    const fileIds = continuation ? [] : input.fileIds ?? [];
    const recordingIds = continuation ? [] : input.recordingIds ?? [];
    flushPaint();
    const profile = profileOf(input.presentationId) === "dock" ? DOCK_TURN_TRANSCRIPT : FULL_PAGE_TURN_TRANSCRIPT;
    const identity = coordinator.begin(sessionId);
    const run: DirectRun = {
      identity, abort: new AbortController(), sessionId, originator: input.presentationId, profile,
      assistantId: plan.assistantId, localUserId: `local-${++localSeq}`, accepted: continuation, closed: false,
      stopped: false, failed: false, refused: null, heldError: null, stoppedByServer: false, askedQuestion: false, continuation, userMessageId: continuation ? plan.sourceMessageId : null,
      onAccepted: continuation ? undefined : input.onAccepted,
      onRejected: continuation ? undefined : input.onRejected,
      onUserMessageSaved: continuation ? undefined : input.onUserMessageSaved,
      result: "completed",
    };
    direct = run;
    coordinator.registerCleanup(identity, () => {
      run.abort.abort();
      if (direct === run) direct = null;
    });
    mirror = emptyMirror();
    resetBuildLog();
    clearNotice("error", "turnEnd", "reconnectFailed", "reconnecting", "stopTurnFailed", "queued");
    researchPhase = null;
    if (!continuation) {
      dispatch({ type: "message/append", message: { ...(input.userMessage ?? {}), id: run.localUserId, role: "user", text, timestamp: new Date(scheduler.now()) } as Message });
    }
    dispatch({ type: "stream/start" });
    activity = turnTranscriptReducer(activity, { type: "reset", startedAt: scheduler.now() });
    if (room && presentations.size) restartRoomFollow();
    publishNow();
    const body = {
      message: text,
      workspaceId: scope.workspaceId,
      ...(run.assistantId ? { assistantId: run.assistantId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(fileIds.length ? { fileIds } : {}),
      ...(recordingIds.length ? { attachedRecordingIds: recordingIds } : {}),
      // First member only: a second truncate would delete the first reply.
      ...(!continuation && input.override?.truncateFromMessageId ? { truncateFromMessageId: input.override.truncateFromMessageId } : {}),
      ...plan.extras,
      ...(plan.groupIds
        ? { roomResponseGroup: { assistantIds: plan.groupIds, ...(plan.sourceMessageId ? { sourceMessageId: plan.sourceMessageId } : {}) } }
        : {}),
    };
    let refusal: ChatHttpRefusal | null = null;
    const fetchTurn = refusingFetch(transport.authFetch);
    await runStream({
      url: `${transport.apiUrl}/api/chat`,
      body,
      authFetch: async (input, init) => {
        try { return await fetchTurn(input, init); } catch (error) {
          if (error instanceof ChatHttpRefusal) refusal = error;
          throw error;
        }
      },
      onEvent: (event) => handleDirectFrame(run, classifyTurnFrame("direct", event.event, event.data)),
      onDone: async (info) => {
        if (!owns(run) || run.closed) return;
        flushPaint();
        if (run.refused) {
          // Another turn owns the session: hand the text back, then watch the winner.
          const owner = run.sessionId;
          rejectBeforeAcceptance(run, run.refused.code, run.refused.message, run.refused.notice);
          if (owner && run.refused.code === "turn_in_flight") followTurn();
          return;
        }
        if (run.stoppedByServer) { settleStopped(run, stopPromise !== null); return; }
        const owner = run.sessionId;
        const admitted = owner !== null && await coordinator.receiveTurnEvent(
          run.identity, info.event ?? "done", { turnId: info.turnId }, () => transport.readStatus(owner), true,
        );
        if (!owns(run) || run.closed) return;
        if (!admitted) { enterDisconnect(run); return; }
        run.closed = true;
        run.result = run.failed ? "failed" : "completed";
        finalizeDirect(run);
        publishNow();
      },
      onDisconnect: () => { if (owns(run) && !run.closed) { flushPaint(); enterDisconnect(run); } },
      onError: () => {
        if (!owns(run) || run.closed) return;
        flushPaint();
        const refused = refusal as ChatHttpRefusal | null;
        // A refusal before any frame is definitive: no follow, no reconcile.
        if (refused) { rejectBeforeAcceptance(run, refused.code); return; }
        // Accepted work is reconciled, never resent: the follow stream (and its
        // status read) tells whether the turn is still running or finished.
        if (run.accepted && run.sessionId) { enterDisconnect(run); return; }
        rejectBeforeAcceptance(run, "stream_failed");
      },
    }, run.abort.signal);
    const result: ConversationSendResult = run.stopped ? "stopped" : disposed ? "disposed"
      : direct !== run && !run.closed ? "superseded" : run.result;
    return { result, userMessageId: run.userMessageId, askedQuestion: run.askedQuestion };
  }

  /** Room post handed to a teammate's running turn; server-held, never resent. */
  async function postRoomMidTurn(input: ConversationSendInput, text: string, extras: ConversationBodyExtras): Promise<ConversationSendResult> {
    const owner = sessionId!;
    const localId = `local-${++localSeq}`;
    const inputId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID() : `input-${scheduler.now()}-${++localSeq}`;
    dispatch({ type: "message/append", message: { ...(input.userMessage ?? {}), id: localId, role: "user", text, timestamp: new Date(scheduler.now()) } as Message });
    const addressed = extras.ask === true || !!input.assistantId;
    if (addressed) queued = [...queued, { inputId, sessionId: owner, text, steer: extras.steer === true, uncertain: false, serverHeld: true }];
    publishNow();
    let accepted = false;
    let failed = false;
    let noticed = false;
    await runStream({
      url: `${transport.apiUrl}/api/chat`,
      authFetch: refusingFetch(transport.authFetch),
      body: { message: text, workspaceId: scope.workspaceId, sessionId: owner, inputId, ...(input.assistantId ? { assistantId: input.assistantId } : {}), ...extras },
      onEvent: (event) => {
        const frame = classifyTurnFrame("direct", event.event, event.data);
        if (disposed || frame.class === "ignorable") return;
        if (frame.event === "user_message_saved" || frame.event === "input_queued" || frame.event === "queued") {
          if (frame.event === "user_message_saved") {
            dispatch({ type: "message/rekey", messageId: localId, id: String(frame.payload.id) });
            try { input.onUserMessageSaved?.(String(frame.payload.id)); } catch { /* presentation callback */ }
          }
          if (frame.event !== "user_message_saved") addNotice({ code: "queued" });
          if (!accepted) { accepted = true; try { input.onAccepted?.(frame.event === "user_message_saved" ? String(frame.payload.id) : null); } catch { /* presentation callback */ } }
          publishNow();
        } else if (frame.event === "error") {
          failed = true;
          noticed = true;
          const message = str(frame.payload.message) ?? str(frame.payload.error);
          addNotice({ code: "error", errorCode: str(frame.payload.code) ?? "stream_error", ...(message ? { message } : {}) });
          publishNow();
        }
      },
      onDone: () => undefined,
      onError: (error) => {
        failed = true;
        if (error instanceof ChatHttpRefusal && !noticed) { noticed = true; addNotice({ code: "error", errorCode: error.code }); }
      },
    }, new AbortController().signal);
    if (disposed) return "disposed";
    if (!accepted) {
      dispatch({ type: "message/remove", messageId: localId });
      queued = queued.filter((item) => item.inputId !== inputId);
      if (!noticed) addNotice({ code: "error", errorCode: failed ? "stream_failed" : "not_accepted" });
      try { input.onRejected?.(); } catch { /* presentation callback */ }
      publishNow();
      return "failed";
    }
    return "queued";
  }

  // ── Follow stream: one reconnect policy ───────────────────────────────
  const ownsFollow = (current: Follow) => !disposed && follow === current && !current.ended && coordinator.isCurrent(current.identity);
  const STRENGTH: Record<FollowReason, number> = { hydrate: 0, room: 1, resume: 2, reconnect: 3 };

  const endFollow = (current: Follow) => {
    if (current.reason === "hydrate") hydrating = false;
    current.ended = true;
    current.abort?.abort();
    if (current.timer !== null) scheduler.clearTimeout(current.timer);
    current.timer = null;
    if (follow === current) follow = null;
    reconnect = { attempt: 0, nextAt: null, budgetEndsAt: null };
  };

  function startFollow(reason: FollowReason) {
    if (disposed || !sessionId) return;
    releasedFollow = null;
    const now = scheduler.now();
    if (follow && !follow.ended) {
      if (STRENGTH[reason] > STRENGTH[follow.reason]) follow.reason = reason;
      if (reason === "reconnect" && follow.budgetEndsAt === null) follow.budgetEndsAt = now + budgetMs;
      if (reason === "resume" && follow.budgetEndsAt === null) follow.budgetEndsAt = now + budgetMs;
      if (reason === "resume") {
        // The resumed turn has not been seen yet: a turn this follow watched
        // before the approval (the dead one) does not count (M5Q-21).
        follow.resumeUntil = now + RESUME_ATTACH_WINDOW_MS;
        follow.resumeAfterTurnId = coordinator.getTurnId();
        follow.sawRunning = false;
        follow.sawTurnCompleted = false;
      }
      if (reason === "reconnect") { coordinator.reconnect(follow.identity); addNotice({ code: "reconnecting" }); publishNow(); }
      return;
    }
    const current: Follow = {
      identity: coordinator.capture(), sessionId, reason, abort: null, timer: null, attempt: 0,
      budgetEndsAt: reason === "room" ? null : now + budgetMs,
      sawRunning: false, sawTurnCompleted: false, ended: false,
      resumeUntil: reason === "resume" ? now + RESUME_ATTACH_WINDOW_MS : null,
      resumeAfterTurnId: reason === "resume" ? coordinator.getTurnId() : null,
    };
    follow = current;
    if (reason === "hydrate") hydrating = true;
    coordinator.registerCleanup(current.identity, () => endFollow(current));
    if (reason === "reconnect") {
      coordinator.reconnect(current.identity);
      addNotice({ code: "reconnecting" });
      reconnect = { attempt: 0, nextAt: null, budgetEndsAt: current.budgetEndsAt };
      publishNow();
    }
    void openFollow(current);
  }

  function restartRoomFollow() {
    if (follow) endFollow(follow);
    startFollow("room");
  }

  const giveUp = (current: Follow, cause: "budget" | "rejected", status?: number) => {
    const turnActive = ACTIVE.has(phase()) || current.reason === "reconnect" || mirror.active;
    endFollow(current);
    mirror = emptyMirror();
    clearNotice("reconnecting");
    if (turnActive || cause === "budget") {
      addNotice({ code: "reconnectFailed", cause, ...(status !== undefined ? { status } : {}) });
      coordinator.fail(current.identity, cause === "budget" ? "reconnect_failed" : "follow_rejected");
    }
    publishNow();
  };

  const scheduleReopen = (current: Follow) => {
    if (!ownsFollow(current)) return;
    current.abort = null;
    current.attempt++;
    const delay = Math.min(policy.maxMs, policy.baseMs * 2 ** (current.attempt - 1));
    const nextAt = scheduler.now() + delay;
    if (current.budgetEndsAt !== null && nextAt > current.budgetEndsAt) { giveUp(current, "budget"); return; }
    reconnect = { attempt: current.attempt, nextAt, budgetEndsAt: current.budgetEndsAt };
    current.timer = scheduler.setTimeout(() => {
      current.timer = null;
      if (ownsFollow(current)) void openFollow(current);
    }, delay);
    publishNow();
  };

  async function openFollow(current: Follow) {
    const controller = new AbortController();
    current.abort = controller;
    let response: Response;
    try {
      response = await transport.authFetch(`${transport.apiUrl}/api/sessions/${encodeURIComponent(current.sessionId)}/stream`, { signal: controller.signal });
    } catch {
      if (!controller.signal.aborted) scheduleReopen(current);
      return;
    }
    if (!ownsFollow(current) || controller.signal.aborted) return;
    if (!response.ok || !response.body) {
      // A definitive rejection keeps its authority; it is not an outage.
      if ([401, 403, 404].includes(response.status)) withdrawFollowAccess(current, response.status);
      else scheduleReopen(current);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const buffer = createSSEBuffer();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !ownsFollow(current)) break;
        for (const event of parseSSEStream(decoder.decode(value, { stream: true }), buffer)) {
          if (!ownsFollow(current)) break;
          await handleFollowFrame(current, classifyTurnFrame("follow", event.event, event.data));
        }
      }
    } catch {
      // Transport loss: reopen below unless detached or ended.
    }
    if (ownsFollow(current) && !controller.signal.aborted && current.abort === controller) scheduleReopen(current);
  }

  const completeFromFollow = (current: Follow) => {
    mirror = emptyMirror();
    // An idle probe that never saw the turn must not wipe the card the same
    // open restored (a turn waiting on approval in the durable path).
    if (current.sawRunning || current.sawTurnCompleted || current.reason === "reconnect") clearConfirmations(current.identity);
    clearNotice("reconnecting");
    if (ACTIVE.has(phase())) coordinator.complete(current.identity);
    if (coordinator.claimExit(current.identity)) drainQueue(current.sessionId);
  };

  const ownCommitted = (payload: Record<string, unknown>) =>
    typeof payload.turnId === "string" && payload.turnId === committedTurnId;

  function withdrawFollowAccess(current: Follow, status: number) {
    giveUp(current, "rejected", status);
    historyAccessRevocation++;
    pendingInput = null;
    const pending = coordinator.getSnapshot().interaction.pending;
    if (pending?.kind === "question") coordinator.resolveInteraction(current.identity, pending.approvalId);
    clearConfirmations(current.identity);
    invalidateRetainedHistory();
    void transport.withdrawRetainedHistory?.(scope, current.sessionId).catch(() => {});
  }

  async function handleFollowFrame(current: Follow, frame: ClassifiedTurnFrame) {
    if (frame.class === "ignorable") return;
    if (frame.event === "access_denied") { withdrawFollowAccess(current, 403); return; }
    if (flushesPaint(frame)) flushPaint();
    const { event, payload } = frame;
    if (event === "status" && current.reason === "hydrate") hydrating = false;
    // Own echo: while this renderer's direct POST paints the exact room turn,
    // its mirrored copy is suppressed unless a teammate sent it.
    const sender = str(payload.senderUserId) ?? null;
    const ownsExactPost = direct !== null && !direct.closed && owns(direct) && direct.sessionId === current.sessionId;
    const acceptsMirror = !ownsExactPost || (sender !== null && sender !== scope.viewerId);
    const mirrored = event === "turn_started" || event === "snapshot" || event === "activity";
    if (["status", "turn_started", "snapshot", "activity", "turn_completed", "done"].includes(event)) {
      const previousTurn = coordinator.getTurnId();
      const admitted = await coordinator.receiveTurnEvent(current.identity, event, payload, () => transport.readStatus(current.sessionId), false, !ownsExactPost);
      if (!ownsFollow(current)) return;
      if (!admitted) {
        const obsoleteResumeOwner = current.resumeAfterTurnId !== null && payload.turnId === current.resumeAfterTurnId && !current.sawRunning;
        if ((event === "turn_completed" || event === "done") && !ownCommitted(payload) && !ownsExactPost && !obsoleteResumeOwner) { historyEpoch++; void reloadHistory(); publishNow(); }
        return;
      }
      if (event === "status" && payload.status !== "running" && typeof payload.turnId === "string"
        && (previousTurn !== null && payload.turnId !== previousTurn || current.resumeAfterTurnId !== null && payload.turnId !== current.resumeAfterTurnId)
        && !ownsExactPost) {
        // A different idle receipt may belong to a turn that ended during
        // disconnection. Reveal its saved history, but an opaque turn ID
        // cannot establish that this is the pending resumed turn.
        mirror = emptyMirror();
        if (!current.sawRunning && current.resumeUntil !== null && scheduler.now() < current.resumeUntil) {
          if (!ownCommitted(payload)) { historyEpoch++; void reloadHistory(); }
          publishNow();
          return;
        }
        current.sawTurnCompleted = true;
        const reason = str(payload.turnEndReason);
        if (reason && reason !== "completed" && reason !== "publication_recovered") {
          addNotice({ code: "turnEnd", reason, stoppedByName: str(payload.stoppedByName) ?? null, senderUserId: sender ?? mirror.senderUserId });
          turnEndTurnId = payload.turnId;
        } else { clearNotice("turnEnd"); turnEndTurnId = null; }
        completeFromFollow(current);
        endFollow(current);
        if (!ownCommitted(payload)) { historyEpoch++; void reloadHistory(); }
        publishNow();
        return;
      }
    }
    // M5Q-19: a later turn running supersedes the previous turn's end notice.
    if ((event === "turn_started" || (event === "status" && payload.status === "running")) && notices.some((notice) => notice.code === "turnEnd")) {
      const running = str(payload.turnId) ?? null;
      if (running !== null && running !== turnEndTurnId) { clearNotice("turnEnd"); turnEndTurnId = null; }
    }
    // Observed only once admitted for this turn, and never as an own echo.
    if (!mirrored || acceptsMirror) {
      if (event === "turn_started" && !ownsExactPost) resetBuildLog();
      observeFrame(direct?.originator ?? null, frame);
    }
    switch (event) {
      case "status": {
        if (payload.status === "running") {
          current.sawRunning = true;
          coordinator.connected(current.identity);
          if (current.reason !== "room") {
            // A successful re-attach clears transient transport errors.
            reattachEpoch++;
            notices = notices.filter((notice) => notice.code !== "error" || !TRANSIENT_ERRORS.test(notice.errorCode));
          }
          if (ownsExactPost) break;
          // Keep the earliest known start: a direct start recorded before a
          // disconnect must not be replaced by a later lease start.
          const serverStart = typeof payload.startedAt === "number" && Number.isFinite(payload.startedAt) && payload.startedAt > 0
            ? Math.min(payload.startedAt, scheduler.now()) : null;
          const startedAt = serverStart === null ? mirror.startedAt ?? scheduler.now()
            : mirror.startedAt === null ? serverStart : Math.min(mirror.startedAt, serverStart);
          mirror = { ...mirror, active: true, startedAt };
        } else if (payload.status === "timeout" || payload.turnEndReason === "timeout" || payload.turnEndReason === "stalled_reclaimed" || payload.status === "failed") {
          addNotice({ code: "turnEnd", reason: str(payload.turnEndReason) ?? str(payload.status) ?? "failed", stoppedByName: null, senderUserId: sender ?? mirror.senderUserId });
          turnEndTurnId = str(payload.turnId) ?? coordinator.getTurnId();
        }
        break;
      }
      case "user_message_saved":
        historyEpoch++;
        break;
      case "turn_started":
        current.sawRunning = true;
        if (!acceptsMirror) break;
        mirror = {
          ...mirror, active: true, assistantId: str(payload.assistantId) ?? mirror.assistantId,
          startedAt: mirror.startedAt ?? scheduler.now(), senderUserId: sender ?? mirror.senderUserId,
        };
        break;
      case "snapshot": {
        if (!acceptsMirror) break;
        const replyPhase = payload.replyPhase === "saving" || payload.replyPhase === "finishing" ? payload.replyPhase : "generating";
        mirror = {
          ...mirror, active: true, text: str(payload.text) ?? "", reasoning: str(payload.reasoning) ?? mirror.reasoning,
          replyPhase, assistantId: str(payload.assistantId) ?? mirror.assistantId,
          senderUserId: sender ?? mirror.senderUserId,
        };
        schedulePaint();
        return;
      }
      case "activity": {
        if (!acceptsMirror) break;
        const inner = String(payload.event);
        if (inner === "input_applied" && typeof payload.inputId === "string") {
          const entry = takeQueued(payload.inputId, current.sessionId);
          const messageId = str(payload.messageId) ?? `queued-${payload.inputId}`;
          if (entry && !transcript.messages.some((item) => item.id === messageId)) {
            dispatch({ type: "message/append", message: { id: messageId, role: "user", text: entry.text, timestamp: new Date(scheduler.now()) } });
          }
        } else if (inner === "reply_text_complete") {
          mirror = { ...mirror, replyPhase: "saving" };
        } else if (inner === "assistant_message_saved") {
          mirror = { ...mirror, replyPhase: "finishing" };
        } else if (inner === "status") {
          const phase = payload.phase === "research_detected" ? "detected"
            : payload.phase === "research_starting" ? "starting"
            : payload.phase === "research_parallel" ? "parallel" : null;
          if (phase) mirror = { ...mirror, active: true, researchPhase: phase };
        } else if (inner === "tool_confirmation_required" && payload.toolName === "askQuestion") {
          // The question arrives through pending input, not as a card.
        } else if (inner === "tool_confirmation_required" && typeof payload.toolCallId === "string") {
          const confirmation = confirmationFrom(payload, current.sessionId);
          coordinator.presentInteraction(current.identity, {
            kind: "tool-confirmation", approvalId: confirmation.approvalId ?? `tool:${confirmation.toolCallId}`,
            toolCallId: confirmation.toolCallId, source: "live", status: "pending", payload: confirmation,
          });
          dispatch({ type: "confirmation/add", confirmation });
        } else if (inner === "tool_confirmation_resolved" && typeof payload.toolCallId === "string") {
          settleConfirmation(current.identity, payload.toolCallId, payload.decision);
        } else {
          const profile = profileOf(null) === "dock" ? DOCK_TURN_TRANSCRIPT : FULL_PAGE_TURN_TRANSCRIPT;
          mirror = { ...mirror, active: true, activity: reduceTurnTranscriptFrame(mirror.activity, inner, payload, adapterFor(null, profile), profile) };
        }
        break;
      }
      case "pins_changed":
        roomState = { ...roomState, pinsEpoch: roomState.pinsEpoch + 1 };
        break;
      case "assistant_message_saved":
        // A committed reply row; history reloads at `turn_completed`.
        if (acceptsMirror && mirror.active) mirror = { ...mirror, replyPhase: "finishing" };
        break;
      case "assistant_changed":
        roomState = { ...roomState, assistantId: str(payload.assistantId) ?? null };
        break;
      case "presence": {
        const viewers = Array.isArray(payload.viewers) ? payload.viewers : [];
        roomState = {
          ...roomState,
          typers: viewers.flatMap((viewer) => {
            const row = viewer && typeof viewer === "object" ? (viewer as Record<string, unknown>) : {};
            const typing = row.isTyping === true || row.typing === true;
            return typing && typeof row.userId === "string" && row.userId !== scope.viewerId
              ? [{ userId: row.userId, name: str(row.name) ?? null }] : [];
          }),
        };
        break;
      }
      case "turn_completed": {
        if (current.resumeAfterTurnId !== null && payload.turnId === current.resumeAfterTurnId && !current.sawRunning) {
          // The answered owner's reclaim is not completion of its queued resume.
          mirror = emptyMirror();
          publishNow();
          return;
        }
        current.sawTurnCompleted = true;
        const reason = str(payload.reason);
        if (reason && reason !== "completed" && reason !== "publication_recovered") {
          addNotice({ code: "turnEnd", reason, stoppedByName: str(payload.stoppedByName) ?? null, senderUserId: sender ?? mirror.senderUserId });
          turnEndTurnId = str(payload.turnId) ?? coordinator.getTurnId();
        }
        completeFromFollow(current);
        // The own direct turn's rows were committed through the direct stream.
        if (!ownCommitted(payload)) { historyEpoch++; void reloadHistory(); }
        break;
      }
      case "done": {
        if (current.reason === "room") break;
        pendingReadEpoch++;
        // M5Q-21: a resume follow that has not seen a turn run yet (the dead
        // turn's reclaim, or an idle answer before the server holds) reopens
        // inside its window so the later resumed turn is still followed.
        if (!current.sawRunning && current.resumeUntil !== null && scheduler.now() < current.resumeUntil) {
          current.abort?.abort();
          current.abort = null;
          scheduleReopen(current);
          return;
        }
        // The server holds a resume follow open until the resumed owner starts
        // (or its 120 s bound); a resume that ends unseen still reloads once.
        const owesHistory = (current.reason === "reconnect" || current.reason === "resume" || current.sawRunning) && !current.sawTurnCompleted;
        const reconnected = current.reason === "reconnect";
        endFollow(current);
        completeFromFollow(current);
        if (owesHistory) { historyEpoch++; void reloadHistory(); }
        if (reconnected) void refreshPending(current.sessionId, current.identity);
        break;
      }
    }
    publishNow();
  }

  // ── Pending input, approvals and questions ────────────────────────────
  function presentQuestionFor(identity: ChatControllerIdentity, question: ConversationQuestion, source: "live" | "restored") {
    return coordinator.presentInteraction(identity, {
      kind: "question", approvalId: question.approvalId, source, status: "pending", payload: question,
    });
  }
  function presentConfirmationFor(identity: ChatControllerIdentity, confirmation: PendingConfirmation, source: "live" | "restored") {
    // A pending question keeps the single interaction slot; the approval card
    // still shows from `transcript.pendingConfirmations` and resolves alone.
    const slot = coordinator.getSnapshot().interaction.pending;
    if (source === "restored" && slot?.kind === "question") {
      if (!coordinator.isCurrent(identity)) return false;
      dispatch({ type: "confirmation/add", confirmation: { ...confirmation, restored: true } });
      return true;
    }
    const admitted = coordinator.presentInteraction(identity, {
      kind: "tool-confirmation", approvalId: confirmation.approvalId ?? `tool:${confirmation.toolCallId}`,
      toolCallId: confirmation.toolCallId, source, status: "pending", payload: confirmation,
    });
    if (admitted) dispatch({ type: "confirmation/add", confirmation: source === "restored" ? { ...confirmation, restored: true } : confirmation });
    return admitted;
  }
  function refreshPending(owner: string, identity: ChatControllerIdentity): Promise<void> {
    // Every presentation, reconnect and approval signal shares one read. A
    // transient failure is not an empty result and never clears mounted input.
    if (pendingRead) return pendingRead;
    if (disposed || sessionId !== owner || !coordinator.isCurrent(identity)) return Promise.resolve();
    const revocation = historyAccessRevocation;
    const epoch = pendingReadEpoch;
    const shownBefore = coordinator.getSnapshot().interaction.pending;
    const confirmationsBefore = transcript.pendingConfirmations;
    const operation = (async () => {
      let probe: PendingInputProbe;
      try { probe = await transport.fetchPending(owner); } catch { return; }
      if (disposed || historyAccessRevocation !== revocation || pendingReadEpoch !== epoch
        || !coordinator.isCurrent(identity) || sessionId !== owner) return;
      if (probe.externalConfirmations) pendingInput = { sessionId: owner, externalConfirmations: probe.externalConfirmations };
      const current = coordinator.getSnapshot().interaction.pending;
      // Only retire the exact snapshot this read observed. A newer live card
      // or an in-flight human response must not be erased by an old read.
      if (shownBefore?.kind === "question" && current === shownBefore
        && probe.pending?.approvalId !== shownBefore.approvalId) {
        coordinator.resolveInteraction(identity, shownBefore.approvalId);
      }
      for (const previous of confirmationsBefore) {
        const shown = transcript.pendingConfirmations.find(item => item.toolCallId === previous.toolCallId);
        const incoming = probe.toolConfirmation;
        const same = incoming && (incoming.toolCallId === previous.toolCallId
          || !!incoming.approvalId && incoming.approvalId === previous.approvalId);
        if (shown !== previous || shown.status !== "pending" || same) continue;
        coordinator.resolveInteraction(identity, previous.approvalId ?? `tool:${previous.toolCallId}`);
        dispatch({ type: "confirmation/remove", toolCallId: previous.toolCallId });
      }
      if (probe.pending) {
        presentQuestionFor(identity, { approvalId: probe.pending.approvalId, question: probe.pending.question ?? "", expiresAt: probe.pending.expiresAt, sessionId: owner }, "restored");
      }
      const latest = coordinator.getSnapshot().interaction.pending;
      if (probe.toolConfirmation && (!latest || latest === shownBefore
        || latest.approvalId === probe.toolConfirmation.approvalId
        || latest.toolCallId === probe.toolConfirmation.toolCallId
        || latest.kind === "question" && latest.approvalId === probe.pending?.approvalId)) {
        presentConfirmationFor(identity, probe.toolConfirmation, "restored");
      }
      publishNow();
    })();
    const tracked = operation.finally(() => { if (pendingRead === tracked) pendingRead = null; });
    pendingRead = tracked;
    return tracked;
  }

  async function respondConfirmation(toolCallId: string, decision: "approve" | "always_allow" | "deny", comment?: string): Promise<"resolved" | "forbidden" | "failed" | "invalid" | "none"> {
    if (disposed) return "none";
    const confirmation = transcript.pendingConfirmations.find((item) => item.toolCallId === toolCallId);
    // A persistent grant needs the server's capability on this card.
    if (decision === "always_allow" && confirmation?.allowPersistentApproval !== true) return "invalid";
    const owner = confirmation?.sessionId || sessionId;
    if (!owner) return "none";
    flushPaint();
    const identity = coordinator.capture();
    const approvalId = confirmation?.approvalId ?? `tool:${toolCallId}`;
    coordinator.beginResponse(identity, approvalId);
    dispatch({ type: "confirmation/update", toolCallId, patch: { status: decision === "deny" ? "denied" : "approving" } });
    publishNow();
    let ok = false;
    let forbidden = false;
    try {
      if (confirmation?.restored && confirmation.approvalId) {
        const result = await transport.respondRestored(
          confirmation.approvalId, decision === "deny" ? "rejected" : "approved", comment,
          ...(decision === "always_allow" ? [{ grantAlways: true }] : []),
        );
        ok = result.ok;
        // A teammate who is not the assigned approver (M5Q-18).
        forbidden = !result.ok && result.status === 403;
      } else {
        const live = decision === "approve" ? "allow" : decision;
        const result = await transport.confirmLive({ sessionId: owner, toolCallId, decision: live, ...(decision === "deny" && comment ? { comment } : {}) });
        ok = result.ok;
        forbidden = result.status === 403;
      }
    } catch { ok = false; }
    if (disposed || !coordinator.isCurrent(identity)) return "failed";
    if (ok) {
      coordinator.resolveInteraction(identity, approvalId);
      dispatch({ type: "confirmation/update", toolCallId, patch: { status: decision === "deny" ? "denied" : "approved" } });
      // A restored (durable) approval resumes server-side: follow that turn.
      if (confirmation?.restored) {
        if (room) followTurn();
        else if (!(direct !== null && !direct.closed && owns(direct))) startFollow("resume");
      }
    } else {
      coordinator.responseFailed(identity, approvalId, forbidden ? "confirmNotAllowed" : undefined);
      dispatch({ type: "confirmation/update", toolCallId, patch: { status: "pending" } });
      if (forbidden) addNotice({ code: "confirmNotAllowed" });
    }
    publishNow();
    return ok ? "resolved" : forbidden ? "forbidden" : "failed";
  }

  async function settleQuestion(kind: "answer" | "cancel", answer = ""): Promise<"resolved" | "failed" | "none"> {
    const pending = coordinator.getSnapshot().interaction.pending;
    if (disposed || !pending || pending.kind !== "question") return "none";
    const question = pending.payload as ConversationQuestion;
    const owner = question.sessionId || sessionId;
    if (!owner) return "none";
    const identity = coordinator.capture();
    coordinator.beginResponse(identity, pending.approvalId);
    let ok = false;
    try {
      ok = (kind === "answer"
        ? await transport.answerQuestion(owner, pending.approvalId, answer)
        : await transport.cancelQuestion(owner, pending.approvalId)).ok;
    } catch { ok = false; }
    if (disposed || !coordinator.isCurrent(identity)) return "failed";
    if (!ok) { coordinator.responseFailed(identity, pending.approvalId); publishNow(); return "failed"; }
    return questionSettled(pending.approvalId) ? "resolved" : "failed";
  }

  /**
   * A panel already performed the answer or cancel POST: resolve the
   * interaction and follow the resumed turn, without a second POST.
   */
  function questionSettled(approvalId: string): boolean {
    const pending = coordinator.getSnapshot().interaction.pending;
    if (disposed || !sessionId || (pending && (pending.kind !== "question" || pending.approvalId !== approvalId))) return false;
    if (pending) coordinator.resolveInteraction(coordinator.capture(), approvalId);
    publishNow();
    // The resumed turn arrives on the follow stream, not on a message poll.
    startFollow("resume");
    return true;
  }

  // ── Stop: compare-and-set first, abort locally only on confirmation ───
  function stop(): Promise<"stopped" | "alreadyEnded" | "failed" | "revoked" | "none"> {
    if (disposed) return Promise.resolve("none");
    if (stopPromise) return stopPromise;
    if (!ACTIVE.has(phase()) && !mirror.active) return Promise.resolve("none");
    flushPaint();
    stopRequested = true;
    // Stop applies to the remaining members of a response group too.
    const stoppingGroup = group;
    if (stoppingGroup) stoppingGroup.stopped = true;
    clearNotice("stopTurnFailed");
    publishNow();
    const stoppingRun = direct;
    const fail = (ticketCurrent: boolean) => {
      if (ticketCurrent && !disposed) addNotice({ code: "stopTurnFailed" });
      // Stop did not happen: an error held while it was pending is real.
      if (stoppingRun?.heldError && !disposed) { addNotice(stoppingRun.heldError); stoppingRun.heldError = null; }
      return "failed" as const;
    };
    stopPromise = (async () => {
      const stopIdentity = coordinator.capture();
      let ticket;
      try { ticket = await coordinator.captureStopTarget(); } catch { return fail(coordinator.isCurrent(stopIdentity)); }
      if (!ticket || !coordinator.isCurrentTurn(ticket)) return "revoked" as const;
      const owner = sessionId;
      if (!owner) return "revoked" as const;
      let turnId = ticket.turnId;
      if (!turnId) {
        try { turnId = (await transport.readStatus(owner)).turnId; } catch { return fail(coordinator.isCurrentTurn(ticket)); }
        if (!coordinator.isCurrentTurn(ticket)) return "revoked" as const;
      }
      let result: { stopped: boolean };
      try { result = await transport.stopTurn(owner, turnId); } catch { return fail(coordinator.isCurrentTurn(ticket)); }
      if (disposed || !coordinator.isCurrentTurn(ticket)) return "revoked" as const;
      // The turn had already ended; its own stream settles it.
      if (!result.stopped) return "alreadyEnded" as const;
      flushPaint();
      const run = direct;
      if (run) run.heldError = null; // the confirmed stop is the outcome
      if (run && owns(run) && !run.closed) {
        run.abort.abort();
        settleStopped(run, true);
      }
      // A mirrored turn settles on the follow stream's `turn_completed`.
      return "stopped" as const;
    })().then((outcome) => {
      if (outcome === "failed" && stoppingGroup) stoppingGroup.stopped = false;
      return outcome;
    }).finally(() => {
      stopPromise = null;
      stopRequested = false;
      if (!disposed) publishNow();
    });
    return stopPromise;
  }

  // ── Queue, retry, edit, history ───────────────────────────────────────
  function queue(text: string, steer: boolean, opts: { bodyExtras?: ConversationBodyExtras; assistantId?: string | null; serverHeld?: boolean; presentationId?: string } = {}): boolean {
    const trimmed = text.trim();
    const owner = sessionId;
    if (disposed || !trimmed || !owner || !ACTIVE.has(phase())) return false;
    const parsed = conversationBodyExtrasSchema.safeParse(opts.bodyExtras ?? {});
    if (!parsed.success) return false;
    const assistantId = opts.assistantId ?? null;
    const inputId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID() : `input-${scheduler.now()}-${++localSeq}`;
    const entry: ConversationQueuedInput = { inputId, sessionId: owner, text: trimmed, steer, uncertain: false, ...(opts.serverHeld ? { serverHeld: true } : {}) };
    queued = [...queued, entry];
    // The drain policy belongs to the presentation that queued, fixed now.
    const queueing = (opts.presentationId ? presentations.get(opts.presentationId) : undefined) ?? latestPresentation();
    queueExtras.set(inputId, {
      extras: parsed.data, assistantId, drain: queueing?.capabilities.queueDrain ?? "send",
      queuedAt: scheduler.now(), knownIds: new Set(transcript.messages.map((message) => message.id)),
      ...(opts.presentationId && presentations.has(opts.presentationId) ? { presentationId: opts.presentationId } : {}),
    });
    publishNow();
    postSide(entry, queueExtras.get(inputId));
    return true;
  }

  /** Side POST for a queued input; never touches the direct stream. */
  function postSide(entry: ConversationQueuedInput, context: { extras: ConversationBodyExtras; assistantId: string | null } = { extras: {}, assistantId: null }) {
    const extras = { ...context.extras, ...(context.assistantId ? { assistantId: context.assistantId } : {}) };
    let acknowledged = false;
    void runStream({
      url: `${transport.apiUrl}/api/chat`,
      authFetch: refusingFetch(transport.authFetch),
      body: { message: entry.text, sessionId: entry.sessionId, midTurn: true, steer: entry.steer, inputId: entry.inputId, workspaceId: scope.workspaceId, ...extras },
      onEvent: (event) => { if (event.event === "input_queued" || event.event === "session") acknowledged = true; },
      onDone: () => undefined,
      onError: () => {
        if (acknowledged || disposed) return;
        queued = queued.map((item) => (item.inputId === entry.inputId ? { ...item, uncertain: true } : item));
        publishNow();
      },
    }, new AbortController().signal);
  }

  /** Escalate a queued input: same `inputId`, `steer: true`; the inbox upgrades it. */
  function steer(inputId: string): boolean {
    const entry = queued.find((item) => item.inputId === inputId);
    if (disposed || !entry || entry.steer || entry.serverHeld || entry.sessionId !== sessionId || !ACTIVE.has(phase())) return false;
    queued = queued.map((item) => (item === entry ? { ...item, steer: true } : item));
    publishNow();
    postSide({ ...entry, steer: true }, queueExtras.get(inputId));
    return true;
  }

  function retry(input: Omit<ConversationSendInput, "text" | "override"> & { userMessageId: string }) {
    const message = transcript.messages.find((item) => item.id === input.userMessageId && item.role === "user");
    if (!message) return Promise.resolve<ConversationSendResult>("invalid");
    return edit({ ...input, messageId: input.userMessageId, text: message.text });
  }

  function edit(input: Omit<ConversationSendInput, "override"> & { messageId: string }) {
    const index = transcript.messages.findIndex((item) => item.id === input.messageId);
    if (index < 0 || ACTIVE.has(phase())) return Promise.resolve<ConversationSendResult>(index < 0 ? "invalid" : "busy");
    dispatch({ type: "messages/load", messages: transcript.messages.slice(0, index) });
    return send({ ...input, override: { truncateFromMessageId: input.messageId } });
  }

  async function reloadHistory(retries = 0, attempt = 0) {
    const owner = sessionId;
    const mapper = historyMapper();
    const load = transport.loadHistory
      ?? (transport.fetchHistoryRows && mapper
        ? async (id: string, signal: AbortSignal) => mapper(await transport.fetchHistoryRows!(id, signal, rows => {
          if (!disposed && !signal.aborted && sessionId === id) {
            dispatch({ type: "messages/load", messages: mapper(rows) });
            publishNow();
          }
        }))
        : null);
    if (disposed || !owner || !load) return;
    historyAbort?.abort();
    const controller = new AbortController();
    historyAbort = controller;
    const identity = coordinator.capture();
    try {
      const messages = await load(owner, controller.signal);
      if (disposed || controller.signal.aborted || sessionId !== owner || !coordinator.isCurrent(identity)) return;
      dispatch({ type: "messages/load", messages });
      publishNow();
    } catch (error) {
      // Authorized history stays as painted; a retryable read backs off.
      const status = error && typeof error === "object" ? (error as { status?: number }).status : undefined;
      if (!disposed && !controller.signal.aborted && sessionId === owner && (status === 401 || status === 403 || status === 404)) {
        dispatch({ type: "messages/load", messages: [] });
        publishNow();
        return;
      }
      if (retries > 0 && !disposed && !controller.signal.aborted && sessionId === owner) {
        scheduler.setTimeout(() => {
          if (!disposed && historyAbort === controller && sessionId === owner) void reloadHistory(retries - 1, attempt + 1);
        }, Math.min(policy.maxMs, policy.baseMs * 2 ** attempt));
      }
    }
  }

  function invalidateRetainedHistory() {
    if (disposed) return;
    if (direct && !direct.closed || ACTIVE.has(phase()) || follow && follow.reason !== "hydrate" && follow.reason !== "room") {
      cacheRevalidationPending = true;
    } else {
      historyAbort?.abort();
      dispatch({ type: "messages/load", messages: [] });
    }
    publishNow();
  }

  /**
   * A presentation that owns history reports its read failed: retry it with
   * the reconnect backoff as a further `historyEpoch` bump, never an error.
   */
  function reportHistoryFailure() {
    if (disposed || historyRetryAttempt >= HISTORY_RETRY_ATTEMPTS) return;
    const delay = Math.min(policy.maxMs, policy.baseMs * 2 ** historyRetryAttempt);
    historyRetryAttempt++;
    scheduler.setTimeout(() => {
      if (disposed) return;
      historyEpoch++;
      publishNow();
    }, delay);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  /** Every presentation hidden for the grace period: release the follow's transport only. */
  const releaseFollowTransport = () => {
    if (disposed || !follow) return;
    releasedFollow = { reason: follow.reason, budgetEndsAt: follow.budgetEndsAt };
    endFollow(follow);
    publishNow();
  };
  /** Visible again: reopen the released follow inside its remaining budget. */
  const resumeReleasedFollow = () => {
    const released = releasedFollow;
    if (disposed || !released || follow) return;
    releasedFollow = null;
    if (released.budgetEndsAt !== null && scheduler.now() >= released.budgetEndsAt) return;
    startFollow(released.reason);
    const reopened = follow as Follow | null;
    if (reopened) reopened.budgetEndsAt = released.budgetEndsAt;
  };
  const visibility = createVisibilityGate({
    connect: resumeReleasedFollow,
    disconnect: releaseFollowTransport,
    setTimer: (fn, ms) => scheduler.setTimeout(fn, ms),
    clearTimer: (handle) => scheduler.clearTimeout(handle),
  });
  const updateVisibility = () => {
    if (!presentations.size) { visibility.dispose(); return; }
    visibility.onVisibility([...presentations.keys()].some((id) => !hidden.has(id)) ? "visible" : "hidden");
  };
  /**
   * Follow the session's running turn on demand (a refused send, or a host
   * that learns the session is running). False when a stream is already live.
   */
  function followTurn(): boolean {
    if (disposed || !sessionId || (direct !== null && !direct.closed && owns(direct)) || (follow && !follow.ended)) return false;
    startFollow(room ? "room" : "hydrate");
    return follow !== null;
  }

  function setVisible(presentationId: string, visible: boolean) {
    if (disposed || !presentations.has(presentationId)) return;
    if (visible) hidden.delete(presentationId); else hidden.add(presentationId);
    updateVisibility();
  }

  function attach(presentationId: string, capabilities: PresentationCapabilities): () => void {
    if (disposed) return () => {};
    presentations.set(presentationId, { capabilities, seq: ++attachSeq });
    if (roomStopTimer !== null) { scheduler.clearTimeout(roomStopTimer); roomStopTimer = null; }
    if (detachReleaseTimer !== null) { scheduler.clearTimeout(detachReleaseTimer); detachReleaseTimer = null; }
    if (releasedOnDetach) {
      // A released entry that is attached again before eviction re-hydrates.
      releasedOnDetach = false;
      hydrated = false;
    }
    if (room) {
      if (!follow) startFollow("room");
    } else if (sessionId && !hydrated && !direct && !follow) {
      // One hydrate probe: a reload or restart mid-turn re-attaches, and a
      // question or confirmation pending at reload is restored.
      hydrated = true;
      startFollow("hydrate");
      if (capabilities.pendingProbe !== false) void refreshPending(sessionId, coordinator.capture());
    }
    // A presentation that maps history seeds an empty thread once.
    if (sessionId && historyMapper() && !seeded && transcript.messages.length === 0 && !direct) {
      seeded = true;
      void reloadHistory();
    }
    updateVisibility();
    publishNow();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      detach(presentationId);
    };
  }

  function detach(presentationId: string) {
    const leaving = presentations.get(presentationId)?.capabilities;
    if (!presentations.delete(presentationId) || disposed) return;
    hidden.delete(presentationId);
    updateVisibility();
    if (presentations.size === 0 && leaving?.releaseOnDetach) {
      // Deferred like the room stop, so a StrictMode replay keeps its stream.
      detachReleaseTimer = scheduler.setTimeout(() => {
        detachReleaseTimer = null;
        if (disposed || presentations.size > 0 || (direct !== null && !direct.closed)) return;
        if (follow) endFollow(follow);
        releasedFollow = null;
        releasedOnDetach = true;
        publishNow();
      }, 0);
    }
    if (room && presentations.size === 0) {
      // Deferred so a StrictMode setup replay keeps the same stream.
      roomStopTimer = scheduler.setTimeout(() => {
        roomStopTimer = null;
        if (!disposed && presentations.size === 0 && follow?.reason === "room") { endFollow(follow); publishNow(); }
      }, 0);
    }
    publishNow();
  }

  /** Identity or local-data change: abort transport (never Stop) and drop state. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelPaint();
    if (roomStopTimer !== null) scheduler.clearTimeout(roomStopTimer);
    if (detachReleaseTimer !== null) scheduler.clearTimeout(detachReleaseTimer);
    visibility.dispose();
    direct?.abort.abort();
    direct = null;
    if (follow) endFollow(follow);
    historyAbort?.abort();
    coordinator.teardown();
    transcript = initialChatState;
    activity = initialTurnTranscript;
    mirror = emptyMirror();
    queued = [];
    unsent = [];
    notices = [];
    pendingInput = null;
    presentations.clear();
    snapshot = compose();
    for (const listener of [...listeners]) listener();
    listeners.clear();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    attach,
    detach,
    send,
    queue,
    stop,
    respondConfirmation,
    answerQuestion: (answer: string) => settleQuestion("answer", answer),
    cancelQuestion: () => settleQuestion("cancel"),
    steer,
    retry,
    edit,
    questionSettled,
    refreshPendingInput: () => (sessionId ? refreshPending(sessionId, coordinator.capture()) : Promise.resolve()),
    /** Present input a host already fetched (restored, or live from its own frame). */
    presentQuestion: (question: ConversationQuestion, source: "live" | "restored" = "restored") => {
      if (disposed) return false;
      const admitted = presentQuestionFor(coordinator.capture(), question, source);
      publishNow();
      return admitted;
    },
    presentConfirmation: (confirmation: PendingConfirmation, source: "live" | "restored" = "restored") => {
      if (disposed) return false;
      const admitted = presentConfirmationFor(coordinator.capture(), confirmation, source);
      publishNow();
      return admitted;
    },
    /** Install rows a host already holds (authorized history it loaded itself). */
    loadMessages: (messages: Message[]) => {
      if (disposed) return;
      dispatch({ type: "messages/load", messages });
      publishNow();
    },
    /** Append a canonical row (for example a voice-job result); same id replaces. */
    appendMessage: (message: Message) => {
      if (disposed) return;
      dispatch(transcript.messages.some((item) => item.id === message.id)
        ? { type: "message/replace", messageId: message.id, message }
        : { type: "message/append", message });
      publishNow();
    },
    invalidateRetainedHistory,
    revalidateIdleHistory() {
      if (disposed || !sessionId || direct && !direct.closed || ACTIVE.has(phase())) return;
      historyEpoch++;
      publishNow();
      void reloadHistory();
    },
    reloadHistory: async () => { historyEpoch++; publishNow(); await reloadHistory(); },
    dismissNotice: (code: ConversationNotice["code"]) => { clearNotice(code); publishNow(); },
    /** Hand back text whose delivery was uncertain; the presentation restores it. */
    takeUnsent: (): string[] => { const taken = unsent; unsent = []; if (taken.length) publishNow(); return taken; },
    /** Connectivity restored: reopen a waiting follow stream now. */
    notifyOnline() {
      const current = follow;
      if (!current || current.timer === null || !ownsFollow(current)) return;
      scheduler.clearTimeout(current.timer);
      current.timer = null;
      void openFollow(current);
    },
    getSessionId: () => sessionId,
    /** The current turn's observed frames, oldest first, plus how many were dropped. */
    getBuildLog: (): { frames: readonly ClassifiedTurnFrame[]; dropped: number } => ({ frames: [...buildLog], dropped: buildLogDropped }),
    isRoom: () => room,
    /** Presentation visibility; all hidden for 60 s releases the follow transport. */
    setVisible,
    followTurn,
    reportHistoryFailure,
    /** The session policy changed: start or stop the whole-life room follow. */
    setRoom(next: boolean) {
      if (disposed || next === room) return;
      room = next;
      if (room) {
        if (presentations.size && (!follow || follow.reason === "hydrate")) restartRoomFollow();
      } else if (follow?.reason === "room") {
        endFollow(follow);
      }
      publishNow();
    },
    presentationCount: () => presentations.size,
    /** A direct stream or a followed running turn this entry must keep alive. */
    hasLiveTurn: () => !disposed && !(releasedOnDetach && !(direct !== null && !direct.closed)) && ((direct !== null && !direct.closed) || (follow !== null && follow.reason !== "hydrate" && follow.reason !== "room") || ACTIVE.has(phase())),
    isDisposed: () => disposed,
    dispose,
  };
}
