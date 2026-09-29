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
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

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
  let destroyed = false;
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
    if (!destroyed && identity.sessionId === sessionId) return identity;
    cleanGeneration(identity.generation);
    identity = { sessionId, generation: identity.generation + 1 };
    if (destroyed) return identity;
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
    if (destroyed) return false;
    syncSelection();
    return sameChatControllerIdentity(identity, candidate);
  };

  const begin = (sessionId = getSelectedSessionId()): ChatControllerIdentity => {
    if (destroyed) return identity;
    cleanGeneration(identity.generation);
    identity = { sessionId, generation: identity.generation + 1 };
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
    publish({ run, interaction });
    return true;
  };

  const applyRun = (
    type: "suspend" | "disconnect" | "reconnect" | "connected" | "complete" | "cancel" | "fail",
    candidate: ChatControllerIdentity,
    error?: string,
  ) => {
    if (!isCurrent(candidate)) return false;
    const run = type === "fail"
      ? chatRunReducer(snapshot.run, { type, identity: candidate, ...(error ? { error } : {}) })
      : chatRunReducer(snapshot.run, { type, identity: candidate });
    publish({ ...snapshot, run });
    return true;
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

  const teardown = () => {
    if (destroyed) return;
    destroyed = true;
    cleanGeneration(identity.generation);
    identity = { sessionId: null, generation: identity.generation + 1 };
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
    teardown,
  };
}

export function useChatController(
  getSelectedSessionId: () => string | null,
): ChatControllerCoordinator & { state: ChatControllerSnapshot } {
  const selectionRef = useRef(getSelectedSessionId);
  selectionRef.current = getSelectedSessionId;
  const controllerRef = useRef<ChatControllerCoordinator | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createChatControllerCoordinator(
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
    controller.capture();
  });
  useEffect(() => () => controller.teardown(), [controller]);

  const bound = controller as ChatControllerCoordinator & {
    state: ChatControllerSnapshot;
  };
  bound.state = state;
  return bound;
}
