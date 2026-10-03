/**
 * Tiny pub-sub for the doc chat's *live build activity* — the tool
 * timeline + streaming reply text of the in-flight turn. The floating chat
 * publishes its activity here; the inline Space-for-AI generating widget
 * (`ai-generating-decoration.ts`) and the editor's generating-block lifecycle
 * (`collab-page-editor.tsx`) subscribe.
 *
 * Why a bus instead of threading the activity through `doc-shell` as
 * props: the streaming text changes on *every token*, and the shell is a
 * heavy tree (sidebar + top bar + the Tiptap editor). Routing per-token
 * updates through the shell would re-render all of that. The bus lets the
 * small widget subscribe directly, so only it re-paints as the turn
 * streams — the shell stays still.
 *
 * One latest-value store, last-writer-wins. Both mounted chat surfaces
 * (desktop dock + mobile drawer) publish, but only the one running the turn
 * streams, so there's no contention in practice.
 *
 * [COMP:app-web/build-activity]
 */

import type { ToolUsed } from "@use-brian/chat-ui";
import type { BuildEvent } from "@/lib/build-events";

export type BuildActivity = {
  /** Whether a turn is currently streaming. */
  isStreaming: boolean;
  /** The turn's tool timeline (start → done), in order. */
  tools: ToolUsed[];
  /** The assistant's streaming reply text so far. */
  text: string;
  /**
   * The model's verbatim reasoning ("thinking") streamed live via the
   * `reasoning` SSE event. Distinct from `text`, so a subscriber can show the
   * model thinking without it competing with the final reply text.
   */
  reasoning: string;
  /**
   * The turn's **chronological** event log — reasoning runs + build steps
   * interleaved in SSE arrival order (see `lib/build-events.ts`). Drives the
   * inline Space-for-AI generating widget's rolling feed
   * (`ai-generating-decoration.ts`), which paints the tail of this list.
   */
  events: BuildEvent[];
  /**
   * The turn's terminal failure, or null. A turn seeded with the dock
   * collapsed (the inline Space-for-AI box) has no visible consumer for an
   * `error` SSE frame, and `isStreaming` cannot carry it: a turn that dies
   * BEFORE streaming never flips it. So failure is its own field.
   */
  error: string | null;
};

const EMPTY: BuildActivity = {
  isStreaming: false,
  tools: [],
  text: "",
  reasoning: "",
  events: [],
  error: null,
};

type Listener = (activity: BuildActivity) => void;

const listeners = new Set<Listener>();
let latest: BuildActivity = EMPTY;

/** Publish the current activity to every subscriber. */
export function publishBuildActivity(activity: BuildActivity): void {
  latest = activity;
  for (const listener of listeners) listener(activity);
}

/**
 * Subscribe to activity updates. Fires immediately with the latest value,
 * then on every publish. Returns an unsubscribe fn.
 */
export function subscribeBuildActivity(listener: Listener): () => void {
  listener(latest);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
