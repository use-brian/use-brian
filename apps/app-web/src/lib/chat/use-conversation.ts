"use client";
/**
 * Presentation hook over the conversation registry: acquire the scoped entry,
 * attach this presentation (StrictMode-safe), and read slices of the
 * immutable snapshot through `useSyncExternalStore` selectors.
 * [COMP:app-web/conversation-controller]
 */
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { currentOfflineWriteAuthority } from "@/lib/offline/application-write-authority";
import type { ConversationController, ConversationState, PresentationCapabilities } from "./conversation-controller";
import { conversationRegistry, type ConversationRegistry } from "./conversation-registry";

export type UseConversationParams = {
  workspaceId: string;
  /** The session once known; otherwise the provisional key is used. */
  sessionId: string | null;
  provisionalKey: string;
  presentationId: string;
  capabilities: PresentationCapabilities;
  room?: boolean;
  registry?: ConversationRegistry;
};

const noop = () => () => {};

export function useConversation<T>(
  params: UseConversationParams,
  selector: (state: ConversationState) => T,
): { controller: ConversationController | null; value: T | null } {
  const registry = params.registry ?? conversationRegistry();
  const authority = currentOfflineWriteAuthority(params.workspaceId);
  const scope = authority ? { apiOrigin: authority.apiOrigin, viewerId: authority.viewerId, workspaceId: authority.workspaceId } : null;
  // Idempotent by key, so a StrictMode double render reuses one entry.
  const controller = scope
    ? registry.acquire(scope, params.sessionId ? { sessionId: params.sessionId } : { provisional: params.provisionalKey }, { room: params.room })
    : null;

  const capabilitiesRef = useRef(params.capabilities);
  capabilitiesRef.current = params.capabilities;
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cache = useRef<{ snapshot: ConversationState | null; value: T | null }>({ snapshot: null, value: null });

  useLayoutEffect(() => {
    if (!controller) return;
    // A stable proxy so capability changes need no reattach.
    const proxy: PresentationCapabilities = {
      get profile() { return capabilitiesRef.current.profile; },
      onSurfaceEffect: (frame) => capabilitiesRef.current.onSurfaceEffect?.(frame),
      describeTool: (name, input) => capabilitiesRef.current.describeTool?.(name, input),
      pageIdsFromToolResult: (name, output, isError) => capabilitiesRef.current.pageIdsFromToolResult?.(name, output, isError) ?? [],
      parseDocument: (payload) => capabilitiesRef.current.parseDocument?.(payload) ?? null,
      // Getters: the controller checks presence (seeding, observing) at call time.
      get mapHistoryRows() { return capabilitiesRef.current.mapHistoryRows; },
      get onFrame() { return capabilitiesRef.current.onFrame; },
      get pendingProbe() { return capabilitiesRef.current.pendingProbe; },
      get releaseOnDetach() { return capabilitiesRef.current.releaseOnDetach; },
      get queueDrain() { return capabilitiesRef.current.queueDrain; },
    };
    return registry.attach(controller, params.presentationId, proxy);
  }, [controller, registry, params.presentationId]);

  // A room policy that lands after the entry exists is applied outside render.
  useLayoutEffect(() => {
    if (controller && params.room !== undefined) controller.setRoom(params.room);
  }, [controller, params.room]);

  const getValue = useCallback((): T | null => {
    if (!controller) return null;
    const snapshot = controller.getSnapshot();
    if (cache.current.snapshot !== snapshot) cache.current = { snapshot, value: selectorRef.current(snapshot) };
    return cache.current.value;
  }, [controller]);
  const value = useSyncExternalStore(controller ? controller.subscribe : noop, getValue, getValue);
  return { controller, value };
}
