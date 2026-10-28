"use client";

/**
 * Per-chat home for the Chat side pane (chat-parity D7, D8, T6).
 *
 * **Why outside React.** Chat-page `useState` dies whenever the user leaves
 * `/chat` (the surface unmounts on every operator-app switch), and a pane
 * that forgot its tabs, or collapsed, every time the user glanced at a page
 * would break D8 ("nothing collapses it automatically"). So the pane lives
 * in a module-level map keyed by `(workspaceId, sessionId)`: the tabs, their
 * order, the active tab, open state and full-view state survive moving between
 * surfaces and switching chats, and are lost on a hard reload (open tabs are
 * local; durable tabs are pins, D7). The same session scope as
 * `doc-tabs-session.ts`.
 *
 * A fresh pane (no session id yet) keys as `fresh` and re-keys onto the
 * session the first send mints (`adoptFreshChatPane`), so a document Brian
 * presented during that first turn stays open.
 *
 * Spec: docs/architecture/features/chat-app.md -> "Side pane".
 *
 * [COMP:app-web/chat-pane-session]
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  activatePaneTab,
  closePaneTab,
  initPane,
  openInPane,
  setPaneOpen,
  setPaneFullView,
  setPaneTabPin,
  stepPaneTab,
  updatePaneTabRef,
  type ChatPaneState,
  type OpenOptions,
  type PaneRef,
} from "./chat-pane-tabs";

const FRESH = "fresh";
const panes = new Map<string, ChatPaneState>();
const listeners = new Set<() => void>();

function chatPaneKey(workspaceId: string, sessionId: string | null): string {
  return `${workspaceId}:${sessionId ?? FRESH}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** The stored pane for a chat, or null when it has never been shown. */
export function readChatPane(workspaceId: string, sessionId: string | null): ChatPaneState | null {
  return panes.get(chatPaneKey(workspaceId, sessionId)) ?? null;
}

/** Read the chat's pane, seeding it once (closed by default). */
function ensureChatPane(
  workspaceId: string,
  sessionId: string | null,
  seedOpen: boolean,
): ChatPaneState {
  const key = chatPaneKey(workspaceId, sessionId);
  let state = panes.get(key);
  if (!state) {
    state = initPane(seedOpen);
    panes.set(key, state);
  }
  return state;
}

/** Apply a transition to a chat's pane and tell every subscriber. */
export function updateChatPane(
  workspaceId: string,
  sessionId: string | null,
  transition: (state: ChatPaneState) => ChatPaneState,
  seedOpen = false,
): ChatPaneState {
  const key = chatPaneKey(workspaceId, sessionId);
  const current = ensureChatPane(workspaceId, sessionId, seedOpen);
  const next = transition(current);
  if (next !== current) {
    panes.set(key, next);
    notify();
  }
  return next;
}

/**
 * The first send of a fresh pane minted a session: carry the fresh pane over
 * to it (unless that session already has one) and clear the fresh slot, so
 * the next new chat starts empty.
 */
export function adoptFreshChatPane(workspaceId: string, sessionId: string): void {
  const freshKey = chatPaneKey(workspaceId, null);
  const fresh = panes.get(freshKey);
  if (!fresh) return;
  panes.delete(freshKey);
  const target = chatPaneKey(workspaceId, sessionId);
  if (!panes.has(target)) panes.set(target, fresh);
  notify();
}

/** A new chat starts with an empty pane: forget the fresh slot. */
export function resetFreshChatPane(workspaceId: string): void {
  if (panes.delete(chatPaneKey(workspaceId, null))) notify();
}

/** Test-only: forget every chat's pane. */
export function resetChatPaneSession(): void {
  panes.clear();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type ChatPane = {
  state: ChatPaneState;
  /** Open (or focus) a reference; expands the pane unless told otherwise. */
  open: (ref: PaneRef, options?: OpenOptions) => void;
  activate: (key: string) => void;
  close: (key: string) => void;
  /** Expand or collapse. Only a user action collapses (D8). */
  setOpen: (open: boolean) => void;
  /** Enter or exit full view without changing the active tab or split width. */
  setFullView: (fullView: boolean) => void;
  step: (delta: -1 | 1) => void;
  setPin: (key: string, pinId: string | null) => void;
  update: (key: string, ref: PaneRef) => void;
};

/**
 * The open chat's pane. Every component reading the same chat sees the same
 * state, and it outlives the component: unmount and remount restore it.
 */
export function useChatPane(
  workspaceId: string,
  sessionId: string | null,
  seedOpen: () => boolean = () => false,
): ChatPane {
  const getSnapshot = useCallback(
    () => ensureChatPane(workspaceId, sessionId, seedOpen()),
    // `seedOpen` is read once per chat, when its pane is first seeded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, sessionId],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    const apply = (transition: (s: ChatPaneState) => ChatPaneState) =>
      void updateChatPane(workspaceId, sessionId, transition, seedOpen());
    return {
      state,
      open: (ref, options) => apply((s) => openInPane(s, ref, options)),
      activate: (key) => apply((s) => activatePaneTab(s, key)),
      close: (key) => apply((s) => closePaneTab(s, key)),
      setOpen: (open) => apply((s) => setPaneOpen(s, open)),
      setFullView: (fullView) => apply((s) => setPaneFullView(s, fullView)),
      step: (delta) => apply((s) => stepPaneTab(s, delta)),
      setPin: (key, pinId) => apply((s) => setPaneTabPin(s, key, pinId)),
      update: (key, ref) => apply((s) => updatePaneTabRef(s, key, ref)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, workspaceId, sessionId]);
}
