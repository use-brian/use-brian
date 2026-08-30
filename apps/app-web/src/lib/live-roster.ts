/**
 * Live roster + watch-pane pure cores (docs/architecture/features/live-work.md
 * §5.1 / §8) — IO-free so vitest exercises them without a DOM or a socket,
 * mirroring `workspace-events.ts`'s routing/fold cores.
 *
 *   - `groupRosterItems`: the two §8 roster groups — *Working now* (sessions
 *     and runs interleaved, newest activity first) and *Just finished* (the
 *     server's 30-minute settled window).
 *   - focus helpers: the URL-addressed `focus=<kind>:<id>` contract shared by
 *     the persistent sidebar and the content pane.
 *   - `canWatch`: which rows open the watch pane. ONE stream, full-tier
 *     sessions only — presence rows have no affordance at all (§6.1), and
 *     run rows deep-link to the run detail instead of opening a second
 *     renderer for run state (§5.3).
 *   - `reduceWatchEvent`: the `GET /api/sessions/:id/stream` frame reducer.
 *     `snapshot` REPLACES text (full reply-so-far, never deltas — a viewer
 *     joining mid-turn has no missed-prefix gap); `turn_completed` + `done`
 *     end the watch; the stream must then be closed, not reopened (§5.1 —
 *     personal-session streams do not reopen on idle).
 *
 * [COMP:app-web/live-app] / [COMP:app-web/live-watch-pane]
 */

import type { LiveWorkItem } from "@/lib/api/live";

export type RosterGroups = {
  working: LiveWorkItem[];
  finished: LiveWorkItem[];
};

export type LiveRosterSummary = {
  working: number;
  waiting: number;
  stalled: number;
  settled: number;
  active: number;
};

/** Newest activity first inside each group; settled rows go to `finished`. */
export function groupRosterItems(items: LiveWorkItem[]): RosterGroups {
  const byNewest = (a: LiveWorkItem, b: LiveWorkItem) =>
    a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0;
  return {
    working: items.filter((i) => i.state !== "settled").sort(byNewest),
    finished: items.filter((i) => i.state === "settled").sort(byNewest),
  };
}

/** Exact state counts for the roster-backed visual overview (never fake data). */
export function summarizeRosterItems(items: LiveWorkItem[]): LiveRosterSummary {
  const summary: LiveRosterSummary = {
    working: 0,
    waiting: 0,
    stalled: 0,
    settled: 0,
    active: 0,
  };
  for (const item of items) {
    summary[item.state] += 1;
    if (item.state !== "settled") summary.active += 1;
  }
  return summary;
}

/** Query parameter carrying the focused roster row. */
export const LIVE_FOCUS_PARAM = "focus";

/** Stable key used by the roster, URL, and detail lookup. */
export function liveItemKey(item: LiveWorkItem): string {
  return `${item.kind}:${item.id}`;
}

/** A selected row's canonical Live URL. */
export function liveItemHref(workspaceId: string, item: LiveWorkItem): string {
  return `/w/${workspaceId}/live?${LIVE_FOCUS_PARAM}=${encodeURIComponent(liveItemKey(item))}`;
}

/** Resolve only a row the tiered roster actually shipped to this caller. */
export function focusedLiveItem(
  items: LiveWorkItem[],
  focus: string | null | undefined,
): LiveWorkItem | null {
  if (!focus) return null;
  return items.find((item) => liveItemKey(item) === focus) ?? null;
}

/** One title rule for the sidebar and the top bar. */
export function liveItemTitle(item: LiveWorkItem): string {
  return item.kind === "workflow_run"
    ? item.workflowName
    : (item.title ?? item.assistantName);
}

/**
 * Whether focusing this row opens the watch pane's session stream. Full-tier
 * sessions only: presence rows are cards without an open affordance (D4 /
 * §6.1), and workflow-run rows render the compact run embed + "Open run"
 * deep link (§5.3), never a session stream of their own (D7: exactly ONE
 * watch stream, for the focused item).
 */
export function canWatch(item: LiveWorkItem): boolean {
  return item.kind === "session" && item.tier === "full";
}

/** Presence-only rows are visible context, never selectable detail targets. */
export function canFocusLiveItem(item: LiveWorkItem): boolean {
  return item.kind === "workflow_run" || canWatch(item);
}

// ── Watch stream reducer ────────────────────────────────────────────

export type WatchActivityEntry = {
  event: string;
  name?: string;
  message?: string;
  isError?: boolean;
};

export type WatchState = {
  /** Full reply-so-far from the latest snapshot. */
  text: string;
  /** Raw running-tool name from the snapshot (client maps to a label). */
  activity: string | null;
  /** Live reasoning tail (rooms/background lanes attribute it). */
  reasoning: string;
  /** Trailing discrete activity feed, newest last, capped. */
  feed: WatchActivityEntry[];
  /** Set when the turn ended; `reason` explains a non-ordinary ending. */
  ended: boolean;
  endReason: string | null;
  /** The relay wrote `done` — the stream is over; do not reopen (§5.1). */
  closed: boolean;
};

export const WATCH_FEED_CAP = 30;

export function initialWatchState(): WatchState {
  return {
    text: "",
    activity: null,
    reasoning: "",
    feed: [],
    ended: false,
    endReason: null,
    closed: false,
  };
}

/**
 * Fold one relay frame (`status` | `snapshot` | `activity` |
 * `turn_completed` | `done`) into the watch state. Unknown frames are
 * ignored — the relay may grow vocabulary an older client never heard of.
 */
export function reduceWatchEvent(
  state: WatchState,
  frame: { event: string; data: Record<string, unknown> },
): WatchState {
  switch (frame.event) {
    case "snapshot": {
      return {
        ...state,
        text: typeof frame.data.text === "string" ? frame.data.text : state.text,
        activity:
          frame.data.activity === null || typeof frame.data.activity === "string"
            ? (frame.data.activity as string | null)
            : state.activity,
        reasoning:
          typeof frame.data.reasoning === "string" ? frame.data.reasoning : state.reasoning,
      };
    }
    case "activity": {
      const entry: WatchActivityEntry = {
        event: typeof frame.data.event === "string" ? frame.data.event : "unknown",
        ...(typeof frame.data.name === "string" ? { name: frame.data.name } : {}),
        ...(typeof frame.data.message === "string" ? { message: frame.data.message } : {}),
        ...(typeof frame.data.isError === "boolean" ? { isError: frame.data.isError } : {}),
      };
      return { ...state, feed: [...state.feed, entry].slice(-WATCH_FEED_CAP) };
    }
    case "turn_completed":
      return {
        ...state,
        ended: true,
        endReason: typeof frame.data.reason === "string" ? frame.data.reason : null,
      };
    case "done":
      return { ...state, closed: true };
    default:
      return state;
  }
}

/**
 * §5.1 close rules for the ONE watch stream: hold it only while a watchable
 * row is focused, the tab is visible, and the relay has not said `done`.
 * Every false here must abort the in-flight fetch.
 */
export function shouldHoldWatchStream(params: {
  focused: LiveWorkItem | null;
  hidden: boolean;
  closed: boolean;
}): boolean {
  if (!params.focused || !canWatch(params.focused)) return false;
  if (params.hidden) return false;
  return !params.closed;
}
