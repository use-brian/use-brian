/**
 * Chat-dock suppression signal.
 *
 * Every workspace surface shares ONE floating assistant dock (the
 * `<FloatingChat>` mounted once by `WorkspaceChrome`), and the repo rule is
 * "two docks never coexist on one surface". The skill editor page and the
 * skill creator's doc stage embed their OWN skill-iteration chat rail — while
 * either is on screen the floating dock must hide.
 *
 * The editor is a route (`/brain/skills/[skillRowId]`) but the creator is
 * STATE inside `/brain` (the Brain page's `skillCreatorOpen`), so a pathname
 * gate can't cover both — instead this is a plain module-level counter store
 * (the `route-progress.ts` recipe: no React, no `next/*`, unit-tests in
 * plain Node) that any embedded chat host bumps while mounted.
 * `WorkspaceChrome` subscribes via {@link useChatDockSuppressed} and HIDES the
 * dock (via `display:none`, keeping it MOUNTED so a streaming turn survives)
 * while the count is non-zero.
 *
 * Counter (not a boolean) so overlapping holders — a takeover transition, a
 * second suppressing view — can't flicker the dock back early; it returns
 * when the LAST holder releases.
 *
 * [COMP:app-web/chat-dock-suppress]
 */

import { useSyncExternalStore } from "react";

type Listener = () => void;

let holders = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const chatDockSuppression = {
  /**
   * Take a suppression hold. Returns the release function — call it exactly
   * once (an effect cleanup); extra calls on the same hold are no-ops.
   */
  suppress(): () => void {
    holders += 1;
    if (holders === 1) emit();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders = Math.max(0, holders - 1);
      if (holders === 0) emit();
    };
  },
  /** Current flag — the `useSyncExternalStore` snapshot. */
  getSnapshot(): boolean {
    return holders > 0;
  },
  /** Server snapshot — never suppressed during SSR. */
  getServerSnapshot(): boolean {
    return false;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Whether the shared floating dock should currently stay unmounted. */
export function useChatDockSuppressed(): boolean {
  return useSyncExternalStore(
    chatDockSuppression.subscribe,
    chatDockSuppression.getSnapshot,
    chatDockSuppression.getServerSnapshot,
  );
}
