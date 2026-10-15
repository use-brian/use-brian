// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  homeLandingPath,
  localDayKey,
  markSuggestedShown,
  readSuggestedLanding,
  shouldAutoOpenSuggested,
  suggestedTransitionTarget,
  workEntryPath,
} from "../suggested-landing";

describe("[COMP:app-web/home-suggested] landing cadence", () => {
  beforeEach(() => window.localStorage.clear());

  it("opens on the first Home landing and once on a new local day", () => {
    const morning = new Date(2026, 7, 21, 9);
    expect(localDayKey(morning)).toBe("2026-08-21");
    expect(shouldAutoOpenSuggested(null, 0, morning)).toBe(true);

    markSuggestedShown("ws-1", 2, morning);
    expect(homeLandingPath("ws-1", "/w/ws-1/tasks", 2, morning)).toBe(
      "/w/ws-1/tasks",
    );
    expect(
      homeLandingPath(
        "ws-1",
        "/w/ws-1/tasks",
        2,
        new Date(2026, 7, 22, 8),
      ),
    ).toBe(workEntryPath("ws-1"));
  });

  it("reopens after three net-new approvals, but not after one or two", () => {
    const now = new Date(2026, 7, 21, 12);
    markSuggestedShown("ws-1", 4, now);

    expect(homeLandingPath("ws-1", "/w/ws-1/chat", 6, now)).toBe(
      "/w/ws-1/chat",
    );
    expect(homeLandingPath("ws-1", "/w/ws-1/tasks", 7, now)).toBe(
      workEntryPath("ws-1"),
    );
    // The interruption now lands in the Chat work entry, never the old briefing.
    expect(workEntryPath("ws-1")).toBe("/w/ws-1/chat");
  });

  it("scopes state by workspace and ignores corrupt storage", () => {
    const now = new Date(2026, 7, 21, 12);
    markSuggestedShown("ws-1", 3, now);
    expect(readSuggestedLanding("ws-1")).toEqual({
      shownDay: "2026-08-21",
      approvalWatermark: 3,
    });
    expect(readSuggestedLanding("ws-2")).toBeNull();

    window.localStorage.setItem("doc:suggested-landing:ws-2", "not-json");
    expect(readSuggestedLanding("ws-2")).toBeNull();
  });
});

describe("[COMP:app-web/home-suggested] retired Suggested links transition safely", () => {
  const base = { workspaceId: "ws-1", pathname: "/w/ws-1/p", pageAddressed: false };
  it("sends a bare briefing link to the Chat work entry", () => {
    expect(suggestedTransitionTarget({ ...base, search: "suggested=1" })).toBe("/w/ws-1/chat");
  });
  it("keeps an addressed Page and every other parameter, dropping only the flag", () => {
    expect(suggestedTransitionTarget({ ...base, pathname: "/w/ws-1/p/page-9", pageAddressed: true, search: "suggested=1&block=b2" }))
      .toBe("/w/ws-1/p/page-9?block=b2");
    expect(suggestedTransitionTarget({ ...base, pathname: "/w/ws-1/p/page-9", pageAddressed: true, search: "suggested=1" }))
      .toBe("/w/ws-1/p/page-9");
  });
  it("leaves every URL without the flag alone (panels, documents, tasks)", () => {
    expect(suggestedTransitionTarget({ ...base, search: "panel=approvals" })).toBeNull();
    expect(suggestedTransitionTarget({ ...base, pathname: "/w/ws-1/p/page-9", pageAddressed: true, search: "" })).toBeNull();
    expect(suggestedTransitionTarget({ ...base, search: "suggested=0" })).toBeNull();
  });
});

