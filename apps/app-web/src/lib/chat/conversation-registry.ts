/**
 * Scoped owner of client conversations, kept above surface unmount.
 *
 * Key: the write-authority prefix `{ apiOrigin, viewerId, workspaceId }` plus
 * a conversation part (the session id, or a provisional
 * `new:<presentation>:<clientId>` key). A `session` frame re-keys a
 * provisional entry; two existing entries are never merged. Identity changes
 * dispose every differing entry (transport aborted, never a Stop request).
 *
 * Contract: docs/architecture/features/chat-app.md → "Shared client controller
 * ownership". [COMP:app-web/conversation-registry]
 */
import { CHAT_SESSIONS_REFRESH_EVENT, type ChatCacheFenceSignal } from "@/lib/chat-session-events";
import { chatHistoryScope, evictChatHistory, retainedChatHistoryIsCurrent } from "@/lib/offline/chat-history-cache";
import { LIVE_REFRESH_EVENT, type LiveRefreshDetail } from "@/lib/workspace-events";
import { authFetch } from "@/lib/auth-fetch";
import { fetchSessionMessages, readChatTurnStatus, stopTurn } from "@/lib/api/sessions";
import { respondByKind } from "@/lib/api/approvals";
import {
  cancelPendingQuestion,
  fetchPendingSessionInput,
  submitAnswer,
  toRestoredConfirmation,
} from "@/lib/api/pending-questions";
import { clearChatDraftMemory } from "@/lib/chat-draft-recovery";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import * as userModule from "@/lib/user";
import * as desktopAuthModule from "@/lib/desktop-auth-source";
import {
  createConversationController,
  type ConversationController,
  type ConversationControllerOptions,
  type ConversationScope,
  type ConversationTransport,
  type PresentationCapabilities,
} from "./conversation-controller";
import { createChatControllerCoordinator, type ChatControllerCoordinator } from "./use-chat-controller";

export type ConversationPart = { sessionId: string } | { provisional: string };

export const DEFAULT_LIVE_DETACHED_CAP = 4;

export type ConversationRegistryOptions = {
  createController: (init: Pick<ConversationControllerOptions, "scope" | "sessionId" | "room" | "onSessionAdopted" | "onChange">) => ConversationController;
  /** Detached entries allowed to keep a running turn's stream. */
  liveCap?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  /** The renderer's current identity; null when signed out. */
  currentIdentity?: () => { viewerId: string; apiOrigin: string } | null;
};

type Entry = {
  key: string;
  scope: ConversationScope;
  controller: ConversationController;
  lastUsed: number;
};

/** Provisional key for a conversation that has no server session yet. */
export function provisionalConversationKey(presentation: string, clientId: string): string {
  return `new:${presentation}:${clientId}`;
}

const scopeKey = (scope: ConversationScope) => JSON.stringify([scope.apiOrigin, scope.viewerId, scope.workspaceId]);
const entryKey = (scope: ConversationScope, part: ConversationPart) =>
  `${scopeKey(scope)}|${"sessionId" in part ? `s:${part.sessionId}` : `p:${part.provisional}`}`;

export function createConversationRegistry(options: ConversationRegistryOptions) {
  const entries = new Map<string, Entry>();
  const byController = new Map<ConversationController, Entry>();
  const presentationCoordinators = new Set<ChatControllerCoordinator>();
  const later = options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cap = options.liveCap ?? DEFAULT_LIVE_DETACHED_CAP;
  let clock = 0;
  let evictionPending = false;

  /** Former provisional keys of re-keyed entries, until the entry is disposed. */
  const aliases = new Map<string, Entry>();
  const resolve = (key: string) => entries.get(key) ?? aliases.get(key);
  const remove = (entry: Entry) => {
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    for (const [alias, target] of aliases) if (target === entry) aliases.delete(alias);
    byController.delete(entry.controller);
  };
  const disposeEntry = (entry: Entry) => {
    remove(entry);
    entry.controller.dispose();
  };

  /** Idle detached entries go; live detached ones are bounded, LRU first. */
  const evict = () => {
    evictionPending = false;
    const detached = [...byController.values()].filter((entry) => entry.controller.presentationCount() === 0);
    const live: Entry[] = [];
    for (const entry of detached) {
      if (entry.controller.hasLiveTurn()) live.push(entry);
      else disposeEntry(entry);
    }
    live.sort((a, b) => a.lastUsed - b.lastUsed);
    while (live.length > cap) disposeEntry(live.shift()!);
  };
  // Deferred so a StrictMode setup/cleanup/setup replay reattaches first.
  const scheduleEviction = () => {
    if (evictionPending) return;
    evictionPending = true;
    later(evict, 0);
  };

  const rekey = (entry: Entry, sessionId: string) => {
    const target = entryKey(entry.scope, { sessionId });
    const existing = entries.get(target);
    if (existing && existing !== entry) return; // never merge two controllers
    if (entries.get(entry.key) === entry) {
      entries.delete(entry.key);
      // A presentation still rendering with the provisional key keeps
      // reaching the same controller until it learns the session id.
      aliases.set(entry.key, entry);
    }
    entry.key = target;
    entries.set(target, entry);
  };

  function acquire(scope: ConversationScope, part: ConversationPart, init: { room?: boolean } = {}): ConversationController {
    const key = entryKey(scope, part);
    const found = resolve(key);
    if (found && !found.controller.isDisposed()) {
      found.lastUsed = ++clock;
      // An existing entry is never changed here: `acquire` runs during render.
      // Presentations apply a later room policy with `setRoom` from an effect.
      return found.controller;
    }
    let entry: Entry | undefined;
    const controller = options.createController({
      scope,
      sessionId: "sessionId" in part ? part.sessionId : null,
      room: init.room,
      onSessionAdopted: (sessionId) => { if (entry) rekey(entry, sessionId); },
      onChange: () => { if (entry && controller.presentationCount() === 0) scheduleEviction(); },
    });
    entry = { key, scope, controller, lastUsed: ++clock };
    entries.set(key, entry);
    byController.set(controller, entry);
    // An abandoned render that never attaches must not leak an entry.
    scheduleEviction();
    return controller;
  }

  function attach(controller: ConversationController, presentationId: string, capabilities: PresentationCapabilities) {
    const entry = byController.get(controller);
    if (!entry) return () => {};
    entry.lastUsed = ++clock;
    const detach = controller.attach(presentationId, capabilities);
    return () => {
      detach();
      scheduleEviction();
    };
  }

  function disposeWhere(predicate: (scope: ConversationScope) => boolean): number {
    let count = 0;
    for (const entry of [...byController.values()]) {
      if (!predicate(entry.scope)) continue;
      disposeEntry(entry);
      count++;
    }
    return count;
  }

  /** Dispose every entry that does not belong to the current identity. */
  function reconcileIdentity(): number {
    const identity = options.currentIdentity?.() ?? null;
    const disposed = disposeWhere((scope) => !identity || scope.viewerId !== identity.viewerId || scope.apiOrigin !== identity.apiOrigin);
    if (disposed) clearChatDraftMemory();
    return disposed;
  }

  return {
    acquire,
    attach,
    lookup: (scope: ConversationScope, part: ConversationPart) => resolve(entryKey(scope, part))?.controller ?? null,
    disposeWhere,
    disposeAll: () => disposeWhere(() => true),
    reconcileIdentity,
    async reconcileCacheFence(signal: ChatCacheFenceSignal) {
      for (const entry of byController.values()) {
        if (entry.scope.apiOrigin !== signal.apiOrigin || entry.scope.viewerId !== signal.viewerId || entry.scope.workspaceId !== signal.workspaceId) continue;
        const id = entry.controller.getSessionId();
        if (!id || signal.sessionId && signal.sessionId !== id || await retainedChatHistoryIsCurrent({ ...signal, applicationId: "native" }, id)) continue;
        if (byController.get(entry.controller) === entry && !entry.controller.isDisposed() && entry.controller.getSessionId() === id)
          entry.controller.invalidateRetainedHistory();
      }
    },
    revalidateSessionReads({ workspaceId, rowId }: LiveRefreshDetail) {
      for (const entry of byController.values()) {
        const id = entry.controller.getSessionId();
        if (entry.scope.workspaceId === workspaceId && id && (!rowId || rowId === id) && entry.controller.getSnapshot().presentations > 0)
          entry.controller.revalidateIdleHistory();
      }
    },
    notifyOnline: () => { for (const entry of byController.values()) entry.controller.notifyOnline(); },
    size: () => byController.size,
    evictNow: evict,
    /**
     * Presentation-owned coordinators of hosts not yet migrated (WP-B/WP-C).
     * Their lifetime is the mounting component's, exactly as before M5;
     * identity disposal does not touch them.
     */
    createPresentationCoordinator: (getSelectedSessionId: () => string | null) => createChatControllerCoordinator(getSelectedSessionId),
    retainPresentationCoordinator(coordinator: ChatControllerCoordinator) {
      presentationCoordinators.add(coordinator);
      return () => { presentationCoordinators.delete(coordinator); };
    },
    presentationCoordinatorCount: () => presentationCoordinators.size,
  };
}

export type ConversationRegistry = ReturnType<typeof createConversationRegistry>;

/** Subscribe a registry to every identity and connectivity signal. */
export function installConversationIdentityHooks(registry: ConversationRegistry, sources: {
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  onSessionRestored?: (callback: () => void) => () => void;
  subscribeUser?: (listener: () => void) => () => void;
} = {}): () => void {
  const target = sources.target ?? (typeof window !== "undefined" ? window : undefined);
  const cleared = () => { registry.disposeAll(); clearChatDraftMemory(); };
  const online = () => registry.notifyOnline();
  const fence = (event: Event) => {
    const signal = (event as CustomEvent<{ cacheFence?: ChatCacheFenceSignal }>).detail?.cacheFence;
    if (signal) void registry.reconcileCacheFence(signal);
  };
  const live = (event: Event) => {
    const detail = (event as CustomEvent<LiveRefreshDetail>).detail;
    if (detail?.workspaceId && !detail.rowId) registry.revalidateSessionReads(detail);
  };
  const reconcile = () => { registry.reconcileIdentity(); };
  target?.addEventListener("brian:local-data-cleared", cleared);
  target?.addEventListener("online", online);
  target?.addEventListener(CHAT_SESSIONS_REFRESH_EVENT, fence);
  target?.addEventListener(LIVE_REFRESH_EVENT, live);
  const stopRestored = sources.onSessionRestored?.(reconcile);
  const stopUser = sources.subscribeUser?.(reconcile);
  return () => {
    target?.removeEventListener("brian:local-data-cleared", cleared);
    target?.removeEventListener("online", online);
    target?.removeEventListener(CHAT_SESSIONS_REFRESH_EVENT, fence);
    target?.removeEventListener(LIVE_REFRESH_EVENT, live);
    stopRestored?.();
    stopUser?.();
  };
}

const apiOrigin = () => (publicRuntimeConfig().apiUrl ?? "http://localhost:4000").replace(/\/$/, "");

export function createDefaultConversationTransport(): ConversationTransport {
  return {
    authFetch: (url, init) => authFetch(String(url), init),
    apiUrl: apiOrigin(),
    readStatus: readChatTurnStatus,
    stopTurn: (sessionId, turnId) => stopTurn(sessionId, turnId),
    async confirmLive({ sessionId, toolCallId, decision, comment }) {
      const res = await authFetch(`${apiOrigin()}/api/chat/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, toolCallId, decision, ...(comment ? { comment } : {}) }),
      });
      return { ok: res.ok, status: res.status };
    },
    respondRestored: (approvalId, decision, comment, options) =>
      respondByKind({ id: approvalId, kind: "tool_invocation" }, decision, comment, options?.grantAlways ? { grantAlways: true } : undefined)
        .then((result) => ({ ok: result.ok, ...(!result.ok && "status" in result && typeof result.status === "number" ? { status: result.status } : {}) })),
    async fetchPending(sessionId) {
      const { pending, toolConfirmation, externalConfirmations } = await fetchPendingSessionInput(sessionId);
      return {
        // Undefined (a transient failure) keeps the previous list.
        ...(externalConfirmations ? { externalConfirmations } : {}),
        pending: pending ? { approvalId: pending.approvalId, question: pending.question, expiresAt: pending.expiresAt } : null,
        toolConfirmation: toolConfirmation ? toRestoredConfirmation(toolConfirmation, sessionId) : null,
      };
    },
    answerQuestion: (sessionId, approvalId, answer) => submitAnswer(sessionId, approvalId, answer).then((result) => ({ ok: result.ok })),
    cancelQuestion: (sessionId, approvalId) => cancelPendingQuestion(sessionId, approvalId),
    // Raw authorized rows; each presentation maps them with its localized
    // narration (`mapHistoryRows`), so history loads in production.
    fetchHistoryRows: (sessionId, signal, onCached) => fetchSessionMessages(sessionId, { signal, strict: true, onCached }),
    withdrawRetainedHistory: (scope, sessionId) =>
      evictChatHistory(chatHistoryScope(sessionId, { ...scope, applicationId: "native" }), sessionId, true),
  };
}

/**
 * An identity source a host (or a host's test mock) does not provide reads as
 * "no identity signal" rather than failing the registry.
 */
function optional<T>(read: () => T): T | undefined {
  try { return read(); } catch { return undefined; }
}

let shared: ConversationRegistry | null = null;

/** This renderer's registry. A desktop chat window is a separate realm with its own. */
export function conversationRegistry(): ConversationRegistry {
  if (shared) return shared;
  const transport = createDefaultConversationTransport();
  shared = createConversationRegistry({
    createController: (init) => createConversationController({ ...init, transport }),
    currentIdentity: () => {
      const viewerId = optional(() => userModule.getUserInfo())?.id;
      return viewerId ? { viewerId, apiOrigin: apiOrigin() } : null;
    },
  });
  if (typeof window !== "undefined") {
    const bridge = optional(() => desktopAuthModule.desktopBridge());
    const subscribe = optional(() => userModule.subscribeUserInfo);
    installConversationIdentityHooks(shared, {
      onSessionRestored: bridge?.onSessionRestored?.bind(bridge),
      subscribeUser: typeof subscribe === "function" ? (listener) => subscribe(() => listener()) : undefined,
    });
  }
  return shared;
}
