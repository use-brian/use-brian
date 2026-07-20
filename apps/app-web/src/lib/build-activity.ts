/**
 * Tiny pub-sub for the doc chat's *live build activity* — the tool
 * timeline + streaming reply text of the in-flight turn. The floating chat
 * publishes its activity here; the page-body drafting indicator
 * (`page-build-indicator.tsx`) subscribes and renders it in detail.
 *
 * Why a bus instead of threading the activity through `doc-shell` as
 * props: the streaming text changes on *every token*, and the shell is a
 * heavy tree (sidebar + top bar + the Tiptap editor). Routing per-token
 * updates through the shell would re-render all of that. The bus lets the
 * small indicator subtree subscribe directly, so only it re-paints as the
 * build streams — the shell stays still. The shell still owns *whether* the
 * indicator is shown (the building-page lifecycle); the bus only carries
 * *what* it shows.
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
   * `reasoning` SSE event. Distinct from `text` — shown dimmer/smaller in
   * the build indicator so the user can watch the model think without it
   * competing with the final reply text.
   */
  reasoning: string;
  /**
   * The turn's **chronological** event log — reasoning runs + build steps
   * interleaved in SSE arrival order (see `lib/build-events.ts`). Drives the
   * inline Space-for-AI generating widget's rolling feed
   * (`ai-generating-decoration.ts`), which paints the tail of this list. The
   * page-body `PageBuildIndicator` ignores it (it renders `tools`/`text`/
   * `reasoning` in dedicated sections instead).
   */
  events: BuildEvent[];
};

const EMPTY: BuildActivity = {
  isStreaming: false,
  tools: [],
  text: "",
  reasoning: "",
  events: [],
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
