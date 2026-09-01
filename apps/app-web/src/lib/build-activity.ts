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
  /**
   * The turn's terminal failure, or null. A landing build runs with the dock
   * COLLAPSED (doc.md -> the page is the show), so an `error` SSE frame has no
   * visible consumer: on 2026-09-01 a build refused before it streamed a byte
   * left the page saying "drafting" until a silent 60s timeout wiped the
   * banner, and the user was never told anything. `isStreaming` cannot carry
   * that — a turn that dies BEFORE streaming never flips it — so failure is
   * its own field, and the shell clears the indicator on it.
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

/**
 * What the page-body build indicator should do with one activity update,
 * given whether this build has been seen streaming yet.
 *
 * Pure, so the three-way decision is unit-testable without mounting the shell
 * (the same stance as `applyUploadResult` / `partitionUpload`). It exists
 * because the two-branch version could not end a build that FAILED before it
 * streamed: `isStreaming` never went true, so the "stopped after streaming"
 * branch never fired and the banner hung until a silent 60s timeout — the
 * 2026-09-01 doc-dock refusal, where the user was told nothing at all.
 *
 * - `fail` — the turn reported a terminal error. Always wins, streamed or not:
 *   an error after partial output still means the build did not finish.
 * - `start` — first stream tick; latch it so a later stop can end the build.
 * - `end` — stopped after having streamed: the ordinary happy path.
 * - `wait` — a pre-stream tick. NOT an end: clearing here would drop the
 *   banner the instant it was raised.
 *
 * `error` must be CLEARED before a new turn publishes, or the next build fails
 * on the previous one's message. The dock does that in `sendMessage`, which
 * calls `setError(null)` in the same batch as `stream/start` — before any
 * publish can carry the new turn. Keep that ordering if you touch it.
 */
export function buildIndicatorTransition(
  activity: Pick<BuildActivity, 'isStreaming' | 'error'>,
  hasStreamed: boolean,
): 'fail' | 'start' | 'end' | 'wait' {
  if (activity.error) return 'fail'
  if (activity.isStreaming) return 'start'
  return hasStreamed ? 'end' : 'wait'
}
