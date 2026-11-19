"use client";

import {
  chatInteractionReducer,
  chatRunReducer,
  initialChatInteractionState,
  initialChatRunState,
  sameChatControllerIdentity,
  type ChatControllerIdentity,
  type ChatInteraction,
  type ChatInteractionState,
  type ChatRunState,
} from "@use-brian/chat-ui";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { conversationRegistry, type ConversationRegistry } from "./conversation-registry";

export type ChatControllerSnapshot = {
  run: ChatRunState;
  interaction: ChatInteractionState;
};

export type ChatControllerCoordinator = ReturnType<typeof createChatControllerCoordinator>;

/**
 * Application binding for the framework-neutral chat-ui controllers.
 * Authentication, streams, pending probes and host rendering stay outside;
 * this owns only identity-safe transitions and teardown. [COMP:app-web/chat-controller]
 */
export function createChatControllerCoordinator(
  getSelectedSessionId: () => string | null,
) {
  let identity: ChatControllerIdentity = {
    sessionId: getSelectedSessionId(),
    generation: 1,
  };
  let snapshot: ChatControllerSnapshot = {
    run: chatRunReducer(initialChatRunState, { type: "visit", identity }),
    interaction: chatInteractionReducer(initialChatInteractionState, {
      type: "visit",
      identity,
    }),
  };
  let turnId: string | null = null;
  let turnRevision = 0;
  let pendingStart = false;
  type StopTarget = { identity: ChatControllerIdentity; turnId: string | null; revision: number };
  const stopWaiters = new Set<{ resolve: (target: StopTarget | null) => void; reject: (error: Error) => void }>();
  const settleStopWaiters = (unavailable = false) => {
    for (const waiter of stopWaiters) {
      if (unavailable) waiter.reject(new Error("The original turn start is unavailable"));
      else waiter.resolve(null);
    }
    stopWaiters.clear();
  };
  const deliverStopTarget = () => {
    if (!turnId || !identity.sessionId) return;
    for (const waiter of stopWaiters) waiter.resolve({ identity, turnId, revision: turnRevision });
    stopWaiters.clear();
  };
  const resetTurn = (pending = false) => {
    settleStopWaiters();
    turnId = null;
    pendingStart = pending;
    turnRevision++;
  };
  let destroyed = false;
  let attached = true;
  let attachment = 0;
  const listeners = new Set<() => void>();
  const cleanups = new Map<number, Set<() => void>>();
  const claimedExits = new Set<number>();

  const publish = (next: ChatControllerSnapshot) => {
    if (next.run === snapshot.run && next.interaction === snapshot.interaction) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const cleanGeneration = (generation: number) => {
    const registered = cleanups.get(generation);
    cleanups.delete(generation);
    if (!registered) return;
    for (const cleanup of registered) cleanup();
  };

  const selectSession = (sessionId: string | null): ChatControllerIdentity => {
    if (destroyed || !attached || identity.sessionId === sessionId) return identity;
    const previous = identity;
    const next = { sessionId, generation: identity.generation + 1 };
    identity = next;
    resetTurn();
    cleanGeneration(previous.generation);
    if (destroyed || !attached || identity !== next) return identity;
    publish({
      run: chatRunReducer(snapshot.run, { type: "visit", identity }),
      interaction: chatInteractionReducer(snapshot.interaction, {
        type: "visit",
        identity,
      }),
    });
    return identity;
  };

  const syncSelection = () => selectSession(getSelectedSessionId());

  const isCurrent = (candidate: ChatControllerIdentity): boolean => {
    if (destroyed || !attached) return false;
    syncSelection();
    return sameChatControllerIdentity(identity, candidate);
  };

  const begin = (sessionId = getSelectedSessionId()): ChatControllerIdentity => {
    if (destroyed || !attached) return identity;
    const previous = identity;
    const next = { sessionId, generation: identity.generation + 1 };
    identity = next;
    resetTurn(true);
    cleanGeneration(previous.generation);
    if (destroyed || !attached || identity !== next) return identity;
    let run = chatRunReducer(snapshot.run, { type: "visit", identity });
    run = chatRunReducer(run, { type: "begin", identity });
    publish({
      run,
      interaction: chatInteractionReducer(snapshot.interaction, {
        type: "visit",
        identity,
      }),
    });
    return identity;
  };

  const adoptSession = (candidate: ChatControllerIdentity, sessionId: string) => {
    if (!isCurrent(candidate) || identity.sessionId !== null) return false;
    const adopted = { ...identity, sessionId };
    const run = chatRunReducer(snapshot.run, {
      type: "adopt-session",
      identity: candidate,
      sessionId,
    });
    const interaction = chatInteractionReducer(snapshot.interaction, {
      type: "adopt-session",
      identity: candidate,
      sessionId,
    });
    identity = adopted;
    deliverStopTarget();
    publish({ run, interaction });
    return true;
  };

  const applyRun = (
    type: "suspend" | "disconnect" | "reconnect" | "connected" | "complete" | "cancel" | "fail",
    candidate: ChatControllerIdentity,
    error?: string,
  ) => {
    if (!isCurrent(candidate)) return false;
    if (["disconnect", "fail", "complete", "cancel"].includes(type)) settleStopWaiters(true);
    // The original POST can no longer bind its start: a disconnected, failed or
    // cancelled request leaves the slot for a follow to adopt the real owner.
    if ((type === "disconnect" || type === "fail" || type === "cancel") && pendingStart) { pendingStart = false; turnRevision++; }
    const run = type === "fail"
      ? chatRunReducer(snapshot.run, { type, identity: candidate, ...(error ? { error } : {}) })
      : chatRunReducer(snapshot.run, { type, identity: candidate });
    publish({ ...snapshot, run });
    return true;
  };

  const publicTurnId = (value: unknown): string | null =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;

  // Only the captured POST may bind an unconfirmed local start. A room frame
  // cannot win a race merely by arriving after another room frame.
  const bindTurn = (candidate: ChatControllerIdentity, value: unknown) => {
    const next = publicTurnId(value);
    if (!isCurrent(candidate) || !next || (turnId !== null && turnId !== next)) return false;
    if (turnId !== next) { turnId = next; turnRevision++; }
    pendingStart = false;
    deliverStopTarget();
    return true;
  };

  const captureTurn = () => ({ identity: syncSelection(), turnId, revision: turnRevision });
  const isCurrentTurn = (ticket: ReturnType<typeof captureTurn>) =>
    isCurrent(ticket.identity) && ticket.revision === turnRevision && ticket.turnId === turnId;

  const receiveTurnEvent = async (
    candidate: ChatControllerIdentity,
    event: string,
    payload: Record<string, unknown>,
    readStatus: () => Promise<{ status: string; turnId: string | null; turnEndReason?: string | null }>,
    direct = false,
    catchUpTerminal = false,
  ): Promise<boolean> => {
    if (!isCurrent(candidate)) return false;
    const incoming = publicTurnId(payload.turnId);
    if (payload.turnId !== null && payload.turnId !== undefined && incoming === null) return false;
    if (direct && incoming && bindTurn(candidate, incoming)) return true;
    const admit = () => {
      if (event === "turn_completed") applyRun("complete", candidate);
      return true;
    };
    // Status reads and starts can be reordered. A completed owner cannot be
    // restarted by one of its buffered snapshots or activities.
    const terminalPhase = ["completed", "cancelled", "failed"].includes(snapshot.run.phase);
    if (event !== "status" && event !== "turn_started" && !terminalPhase && incoming && incoming === turnId) return admit();
    if (direct && incoming && turnId !== null) return false;
    const revision = turnRevision;
    let current;
    try { current = await readStatus(); } catch { return false; }
    if (!isCurrent(candidate) || revision !== turnRevision) return false;
    const actual = publicTurnId(current.turnId);
    // A POST whose owner is not known yet must receive its own source-bound
    // start. An old idle read or the previous owner's running status cannot
    // take that provisional slot away.
    if (pendingStart) {
      if (!direct || current.status === "running" || !["turn_completed", "done", "reply_complete", "error"].includes(event)) return false;
      pendingStart = false;
    }
    if (current.status === "running") {
      if (actual !== turnId) {
        turnId = actual;
        turnRevision++;
        claimedExits.delete(identity.generation);
        publish({
          run: chatRunReducer(snapshot.run, { type: "begin", identity }),
          interaction: { identity, pending: null },
        });
      }
      if (event === "status") {
        if (incoming !== actual) delete payload.startedAt;
        Object.assign(payload, current);
        return true;
      }
      return (incoming !== null ? incoming === actual : actual === null) &&
        !["turn_completed", "done", "reply_complete", "error"].includes(event);
    }
    if (actual !== null && turnId !== null && actual !== turnId) {
      // A fast resumed turn may have committed between follow connections.
      // Only a fresh status for that exact owner, with no owned direct POST,
      // may replace an obsolete bound owner. Buffered terminal events cannot.
      if (!catchUpTerminal || event !== "status" || incoming !== actual) return false;
      turnId = actual;
      turnRevision++;
      claimedExits.delete(identity.generation);
      Object.assign(payload, current);
      applyRun("complete", candidate);
      return true;
    }
    if (incoming !== null && actual !== incoming) return false;
    if (turnId === null && actual !== null) { turnId = actual; turnRevision++; }
    if (event === "status") Object.assign(payload, current);
    return (event === "status" || ["turn_completed", "done", "reply_complete", "error"].includes(event)) && admit();
  };

  const presentInteraction = <T,>(
    candidate: ChatControllerIdentity,
    interaction: ChatInteraction<T>,
  ) => {
    if (!isCurrent(candidate)) return false;
    publish({
      run: chatRunReducer(snapshot.run, { type: "suspend", identity: candidate }),
      interaction: chatInteractionReducer(snapshot.interaction, {
        type: "present",
        identity: candidate,
        interaction,
      }),
    });
    return true;
  };

  const applyInteraction = (
    type: "respond" | "response-failed" | "resolved",
    candidate: ChatControllerIdentity,
    approvalId: string,
    error?: string,
  ) => {
    if (!isCurrent(candidate)) return false;
    const interaction = type === "response-failed"
      ? chatInteractionReducer(snapshot.interaction, {
          type,
          identity: candidate,
          approvalId,
          ...(error ? { error } : {}),
        })
      : chatInteractionReducer(snapshot.interaction, {
          type,
          identity: candidate,
          approvalId,
        });
    publish({ ...snapshot, interaction });
    return true;
  };

  const registerCleanup = (
    candidate: ChatControllerIdentity,
    cleanup: () => void,
  ) => {
    if (!isCurrent(candidate)) {
      cleanup();
      return () => {};
    }
    const registered = cleanups.get(candidate.generation) ?? new Set<() => void>();
    registered.add(cleanup);
    cleanups.set(candidate.generation, registered);
    return () => registered.delete(cleanup);
  };

  const claimExit = (candidate: ChatControllerIdentity): boolean => {
    if (!isCurrent(candidate) || claimedExits.has(candidate.generation)) return false;
    claimedExits.add(candidate.generation);
    return true;
  };

  // React can detach and then replay setup without permanently destroying the
  // coordinator. A lease prevents an older cleanup from detaching a newer setup.
  const attach = () => {
    if (destroyed) return () => {};
    const lease = ++attachment;
    if (!attached) {
      attached = true;
      identity = { sessionId: getSelectedSessionId(), generation: identity.generation + 1 };
      resetTurn();
      publish({
        run: chatRunReducer(snapshot.run, { type: "visit", identity }),
        interaction: chatInteractionReducer(snapshot.interaction, { type: "visit", identity }),
      });
    }
    return () => {
      if (destroyed || !attached || lease !== attachment) return;
      attached = false;
      const previous = identity.generation;
      identity = { sessionId: null, generation: previous + 1 };
      resetTurn();
      // Revocation precedes callbacks: abort may synchronously emit late work.
      cleanGeneration(previous);
    };
  };

  const teardown = () => {
    if (destroyed) return;
    destroyed = true;
    attached = false;
    const previous = identity.generation;
    identity = { sessionId: null, generation: previous + 1 };
    resetTurn();
    cleanGeneration(previous);
    listeners.clear();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    capture: syncSelection,
    selectSession,
    begin,
    adoptSession,
    bindTurn,
    receiveTurnEvent,
    getTurnId: () => turnId,
    captureTurn,
    // An optimistic POST has no public owner yet. Stop waits for that POST's
    // source-bound start; a latest-status read cannot identify its work.
    captureStopTarget: (): Promise<StopTarget | null> => {
      const target = captureTurn();
      if (!pendingStart) return Promise.resolve(target);
      return new Promise((resolve, reject) => stopWaiters.add({ resolve, reject }));
    },
    isCurrentTurn,
    isCurrent,
    suspend: (candidate: ChatControllerIdentity) => applyRun("suspend", candidate),
    disconnect: (candidate: ChatControllerIdentity) => applyRun("disconnect", candidate),
    reconnect: (candidate: ChatControllerIdentity) => applyRun("reconnect", candidate),
    connected: (candidate: ChatControllerIdentity) => applyRun("connected", candidate),
    complete: (candidate: ChatControllerIdentity) => applyRun("complete", candidate),
    cancel: (candidate: ChatControllerIdentity) => applyRun("cancel", candidate),
    fail: (candidate: ChatControllerIdentity, error?: string) => applyRun("fail", candidate, error),
    presentInteraction,
    beginResponse: (candidate: ChatControllerIdentity, approvalId: string) =>
      applyInteraction("respond", candidate, approvalId),
    responseFailed: (candidate: ChatControllerIdentity, approvalId: string, error?: string) =>
      applyInteraction("response-failed", candidate, approvalId, error),
    resolveInteraction: (candidate: ChatControllerIdentity, approvalId: string) =>
      applyInteraction("resolved", candidate, approvalId),
    registerCleanup,
    claimExit,
    attach,
    teardown,
  };
}

/**
 * Unchanged public API for hosts not yet migrated to `useConversation`.
 * The coordinator is created and retained through this renderer's
 * conversation registry, with the mounting component's lifetime as before.
 */
export function useChatController(
  getSelectedSessionId: () => string | null,
  registry: ConversationRegistry = conversationRegistry(),
): ChatControllerCoordinator & { state: ChatControllerSnapshot } {
  const selectionRef = useRef(getSelectedSessionId);
  selectionRef.current = getSelectedSessionId;
  const controllerRef = useRef<ChatControllerCoordinator | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = registry.createPresentationCoordinator(
      () => selectionRef.current(),
    );
  }
  const controller = controllerRef.current;
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useLayoutEffect(() => {
    const release = registry.retainPresentationCoordinator(controller);
    const detach = controller.attach();
    return () => { detach(); release(); };
  }, [controller, registry]);
  useLayoutEffect(() => {
    controller.capture();
  });

  const bound = controller as ChatControllerCoordinator & {
    state: ChatControllerSnapshot;
  };
  bound.state = state;
  return bound;
}
