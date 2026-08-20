// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  homeLandingPath,
  localDayKey,
  markSuggestedShown,
  readSuggestedLanding,
  shouldAutoOpenSuggested,
  suggestedPath,
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
    ).toBe(suggestedPath("ws-1"));
  });

  it("reopens after three net-new approvals, but not after one or two", () => {
    const now = new Date(2026, 7, 21, 12);
    markSuggestedShown("ws-1", 4, now);

    expect(homeLandingPath("ws-1", "/w/ws-1/chat", 6, now)).toBe(
      "/w/ws-1/chat",
    );
    expect(homeLandingPath("ws-1", "/w/ws-1/chat", 7, now)).toBe(
      suggestedPath("ws-1"),
    );
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
