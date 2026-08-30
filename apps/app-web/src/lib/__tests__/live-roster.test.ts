/**
 * Live roster + watch-pane pure cores.
 * Component tags: [COMP:app-web/live-app] (grouping, watchability) and
 * [COMP:app-web/live-watch-pane] (stream reducer + close rules).
 */
import { describe, it, expect } from "vitest";
import type { LiveSessionItem, LiveWorkflowRunItem } from "@/lib/api/live";
import {
  canFocusLiveItem,
  canWatch,
  focusedLiveItem,
  groupRosterItems,
  initialWatchState,
  reduceWatchEvent,
  liveItemHref,
  liveItemKey,
  liveItemTitle,
  shouldHoldWatchStream,
  WATCH_FEED_CAP,
} from "@/lib/live-roster";

function session(overrides: Partial<LiveSessionItem> = {}): LiveSessionItem {
  return {
    kind: "session",
    tier: "full",
    id: "s-1",
    assistantId: "a-1",
    assistantName: "Brian",
    ownerUserId: "u-1",
    ownerName: "Owner",
    channelType: "web",
    state: "working",
    startedAt: "2026-08-29T11:00:00.000Z",
    lastActiveAt: "2026-08-29T12:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<LiveWorkflowRunItem> = {}): LiveWorkflowRunItem {
  return {
    kind: "workflow_run",
    id: "r-1",
    workflowId: "wf-1",
    workflowName: "Daily digest",
    assistantId: null,
    assistantName: null,
    trigger: "scheduled",
    state: "working",
    startedAt: "2026-08-29T11:30:00.000Z",
    lastActiveAt: "2026-08-29T12:01:00.000Z",
    ...overrides,
  };
}

describe("[COMP:app-web/live-app] roster grouping + watchability", () => {
  it("splits settled rows into Just finished, newest activity first, kinds interleaved", () => {
    const items = [
      session({ id: "old", lastActiveAt: "2026-08-29T11:50:00.000Z" }),
      run(),
      session({ id: "done", state: "settled" }),
    ];
    const groups = groupRosterItems(items);
    expect(groups.working.map((i) => i.id)).toEqual(["r-1", "old"]);
    expect(groups.finished.map((i) => i.id)).toEqual(["done"]);
  });

  it("only full-tier sessions open the watch pane (D7: one stream, §6.1: presence has no affordance)", () => {
    expect(canWatch(session())).toBe(true);
    expect(canWatch(session({ tier: "presence" }))).toBe(false);
    expect(canWatch(run())).toBe(false);
  });

  it("rejects presence-only rows as detail targets, including deep links", () => {
    expect(canFocusLiveItem(session())).toBe(true);
    expect(canFocusLiveItem(session({ tier: "presence" }))).toBe(false);
    expect(canFocusLiveItem(run())).toBe(true);
  });

  it("keeps sidebar focus and the detail pane on one URL-addressed key", () => {
    const item = session({ id: "session/one", title: "Quarterly research" });
    expect(liveItemKey(item)).toBe("session:session/one");
    expect(liveItemHref("ws-1", item)).toBe(
      "/w/ws-1/live?focus=session%3Asession%2Fone",
    );
    expect(focusedLiveItem([item], liveItemKey(item))).toBe(item);
    expect(focusedLiveItem([item], "session:missing")).toBeNull();
    expect(liveItemTitle(item)).toBe("Quarterly research");
    expect(liveItemTitle(run())).toBe("Daily digest");
  });
});

describe("[COMP:app-web/live-watch-pane] stream reducer", () => {
  it("snapshot REPLACES text — full reply-so-far, never appended deltas", () => {
    let state = initialWatchState();
    state = reduceWatchEvent(state, { event: "snapshot", data: { text: "Hello", activity: null } });
    state = reduceWatchEvent(state, { event: "snapshot", data: { text: "Hello world", activity: null } });
    expect(state.text).toBe("Hello world");
  });

  it("activity feed appends and stays capped", () => {
    let state = initialWatchState();
    for (let i = 0; i < WATCH_FEED_CAP + 5; i++) {
      state = reduceWatchEvent(state, {
        event: "activity",
        data: { event: "tool_start", name: `tool-${i}` },
      });
    }
    expect(state.feed).toHaveLength(WATCH_FEED_CAP);
    expect(state.feed[state.feed.length - 1].name).toBe(`tool-${WATCH_FEED_CAP + 4}`);
  });

  it("turn_completed records the reason; done closes the stream state", () => {
    let state = initialWatchState();
    state = reduceWatchEvent(state, {
      event: "turn_completed",
      data: { reason: "stalled_reclaimed" },
    });
    expect(state.ended).toBe(true);
    expect(state.endReason).toBe("stalled_reclaimed");
    expect(state.closed).toBe(false);
    state = reduceWatchEvent(state, { event: "done", data: {} });
    expect(state.closed).toBe(true);
  });

  it("unknown frames are ignored — a newer relay vocabulary never breaks the pane", () => {
    const state = initialWatchState();
    expect(reduceWatchEvent(state, { event: "presence", data: { viewers: [] } })).toEqual(state);
  });

  it("close rules (§5.1): defocus, presence focus, hidden tab, and done all release the stream", () => {
    const focused = session();
    expect(shouldHoldWatchStream({ focused, hidden: false, closed: false })).toBe(true);
    expect(shouldHoldWatchStream({ focused: null, hidden: false, closed: false })).toBe(false);
    expect(
      shouldHoldWatchStream({ focused: session({ tier: "presence" }), hidden: false, closed: false }),
    ).toBe(false);
    expect(shouldHoldWatchStream({ focused, hidden: true, closed: false })).toBe(false);
    expect(shouldHoldWatchStream({ focused, hidden: false, closed: true })).toBe(false);
  });
});
