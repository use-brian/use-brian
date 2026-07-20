/**
 * Doc-shell → chrome-dock relay for the page-collab signal.
 *
 * The assistant chat dock is now mounted ONCE in `WorkspaceChrome` (the
 * persistent workspace layout) so a turn keeps streaming when the user
 * switches tabs — see workspace-chrome.tsx and
 * docs/architecture/features/doc.md → "One dock, every surface". The dock
 * therefore lives ABOVE `DocShell` in the tree, but it still needs one
 * doc-page-only signal that only `DocShell` can compute: the
 * `othersRun` soft double-text guard (the assistant run another member
 * started on the page currently open — `useAssistantRun(collab.provider)`).
 *
 * Context can't carry it: `DocShell` is rendered into `WorkspaceChrome`'s
 * `{children}` slot, so it is a DESCENDANT of the dock, not an ancestor —
 * data only flows down. A module-level pub/sub store flips the direction:
 * `DocShell` publishes the current page's run state, the chrome dock
 * subscribes. Mirrors the `chat-dock-suppress.ts` / `route-progress.ts`
 * recipe (no React, no `next/*`, plain-Node unit-testable).
 *
 * `DocShell` clears the value to `null` on unmount (leaving `/p`), so a
 * stale run banner never lingers on a non-doc surface — and the dock gates
 * the banner on being on a doc page anyway.
 *
 * [COMP:app-web/doc-chat-relay]
 */

import { useSyncExternalStore } from "react";
import type { AssistantRunState } from "@use-brian/doc-model";

type Listener = () => void;

let othersRun: AssistantRunState | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const docChatRelay = {
  /**
   * Publish the page-collab run state. `DocShell` calls this whenever its
   * `othersRun` derivation changes, and with `null` on unmount. A no-op when
   * the value is unchanged so subscribers don't re-render on every tick.
   */
  setOthersRun(next: AssistantRunState | null): void {
    if (othersRun === next) return;
    othersRun = next;
    emit();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): AssistantRunState | null {
    return othersRun;
  },
  /** SSR / first paint: never warn before the doc shell has reported. */
  getServerSnapshot(): AssistantRunState | null {
    return null;
  },
};

/**
 * The chrome dock reads the open doc page's "another member is running"
 * state, published by `DocShell`. `null` off `/p` or when idle.
 */
export function useDocChatOthersRun(): AssistantRunState | null {
  return useSyncExternalStore(
    docChatRelay.subscribe,
    docChatRelay.getSnapshot,
    docChatRelay.getServerSnapshot,
  );
}
