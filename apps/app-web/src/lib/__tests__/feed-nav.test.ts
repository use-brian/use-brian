import { describe, expect, it } from "vitest";
import {
  FEED_CONNECTABLE_PLATFORMS,
  FEED_GROUPS,
  FEED_PLATFORMS,
  defaultFeedPlatform,
  feedPath,
  feedPlatformFromPathname,
  feedSectionFromPathname,
  getFeedPlatformPick,
  isConnectableFeedPlatform,
  isFeedPlatform,
  setFeedPlatformPick,
} from "@/lib/feed-nav";

describe("[COMP:app-web/feed-nav] feed navigation config", () => {
  it("supports exactly the Create split's target + connectable platforms", () => {
    // linkedin joined as a manual-publish target (feed-import-account.md D4/D10).
    expect(FEED_PLATFORMS).toEqual([
      "instagram",
      "threads",
      "twitter",
      "xhs",
      "linkedin",
    ]);
    expect(FEED_CONNECTABLE_PLATFORMS).toEqual(["threads", "twitter"]);
    expect(isFeedPlatform("threads")).toBe(true);
    expect(isFeedPlatform("instagram")).toBe(true);
    expect(isFeedPlatform("xhs")).toBe(true);
    expect(isFeedPlatform("linkedin")).toBe(true);
    expect(isFeedPlatform("mastodon")).toBe(false);
    expect(isFeedPlatform(null)).toBe(false);
    expect(isFeedPlatform(undefined)).toBe(false);
    expect(isConnectableFeedPlatform("twitter")).toBe(true);
    expect(isConnectableFeedPlatform("instagram")).toBe(false);
    expect(isConnectableFeedPlatform("xhs")).toBe(false);
    expect(isConnectableFeedPlatform("linkedin")).toBe(false);
  });

  // Platform-led (feed-revamp.md §8a, D13): Company sits above a platform
  // switcher, and everything under it inherits that platform.
  it("orders the groups company -> platform -> hosted platforms", () => {
    expect(FEED_GROUPS.map((g) => g.key)).toEqual([
      "company",
      "platform",
      "platforms",
    ]);
    expect(FEED_GROUPS[0].perPlatform).toBe(false);
    expect(FEED_GROUPS[0].sections.map((s) => s.key)).toEqual(["voice", "plan"]);
    expect(FEED_GROUPS[1].perPlatform).toBe(true);
    expect(FEED_GROUPS[1].sections.map((s) => s.key)).toEqual(["platformVoice"]);
    expect(FEED_GROUPS[2].sections.map((s) => s.key)).toEqual([
      "insights",
      "inspiration",
      "connection",
      "policy",
      "settings",
    ]);
  });

  it("builds feed routes for team and platform scopes", () => {
    expect(feedPath("w1")).toBe("/w/w1/feed");
    expect(feedPath("w1", { segment: "posts" })).toBe("/w/w1/feed/posts");
    expect(feedPath("w1", { platform: "threads" })).toBe("/w/w1/feed/threads");
    expect(feedPath("w1", { platform: "twitter", segment: "insights" })).toBe(
      "/w/w1/feed/twitter/insights",
    );
  });

  it("reads the active platform off a pathname (team rows have none)", () => {
    expect(feedPlatformFromPathname("/w/w1/feed/threads/insights")).toBe(
      "threads",
    );
    expect(feedPlatformFromPathname("/w/w1/feed/twitter")).toBe("twitter");
    expect(feedPlatformFromPathname("/w/w1/feed/posts")).toBeNull();
    expect(feedPlatformFromPathname("/w/w1/feed")).toBeNull();
    expect(feedPlatformFromPathname("/w/w1/brain")).toBeNull();
    expect(feedPlatformFromPathname(null)).toBeNull();
  });

  it("classifies feed sections from pathnames", () => {
    // Plan owns the bare index (feed-revamp.md D5).
    expect(feedSectionFromPathname("/w/w1/feed")).toBe("plan");
    expect(feedSectionFromPathname("/w/w1/feed/")).toBe("plan");
    expect(feedSectionFromPathname("/w/w1/feed/voice")).toBe("voice");
    // A platform's own voice is its own section key, so the sidebar can light
    // the right row for `/feed/threads/voice` vs company `/feed/voice`.
    expect(feedSectionFromPathname("/w/w1/feed/threads/voice")).toBe(
      "platformVoice",
    );
    // Posts is a route, not a nav row: the list lives in the sidebar (D14).
    expect(feedSectionFromPathname("/w/w1/feed/posts")).toBeNull();
    expect(feedSectionFromPathname("/w/w1/feed/threads/posts")).toBeNull();
    // The merged routes are redirect-only now, so they classify as unknown
    // rather than lighting a sidebar row that no longer exists (D6).
    expect(feedSectionFromPathname("/w/w1/feed/drafts")).toBeNull();
    expect(feedSectionFromPathname("/w/w1/feed/inbox")).toBeNull();
    expect(feedSectionFromPathname("/w/w1/feed/ready")).toBeNull();
    expect(feedSectionFromPathname("/w/w1/feed/threads/insights")).toBe(
      "insights",
    );
    expect(feedSectionFromPathname("/w/w1/feed/xhs/connection")).toBe(
      "connection",
    );
    expect(feedSectionFromPathname("/w/w1/feed/threads/settings/members")).toBe(
      "settings",
    );
  });

  it("returns null for unknown segments and non-feed paths", () => {
    // A bare platform root has no section (pages live under a segment).
    expect(feedSectionFromPathname("/w/w1/feed/threads")).toBeNull();
    expect(feedSectionFromPathname("/w/w1/feed/unknown")).toBeNull();
    expect(feedSectionFromPathname("/w/w1/feed/threads/unknown")).toBeNull();
    expect(feedSectionFromPathname("/w/w1/studio/connectors")).toBeNull();
    expect(feedSectionFromPathname(null)).toBeNull();
    expect(feedSectionFromPathname(undefined)).toBeNull();
  });

  // Platform pick (guided first-run, feed-create-split.md D14) — the
  // per-workspace localStorage default read by the Drafts/Voice pages.
  it("stores and recalls the platform pick per workspace, validating entries", () => {
    localStorage.clear();
    expect(getFeedPlatformPick("w1")).toEqual([]);
    setFeedPlatformPick("w1", ["xhs", "instagram"]);
    expect(getFeedPlatformPick("w1")).toEqual(["xhs", "instagram"]);
    // Scoped per workspace.
    expect(getFeedPlatformPick("w2")).toEqual([]);
    // Junk in storage (schema drift, tampering) is filtered, never thrown.
    localStorage.setItem(
      "feed:platform-pick:w3",
      JSON.stringify(["mastodon", "threads", 42]),
    );
    expect(getFeedPlatformPick("w3")).toEqual(["threads"]);
    localStorage.setItem("feed:platform-pick:w4", "not json");
    expect(getFeedPlatformPick("w4")).toEqual([]);
  });

  it("defaultFeedPlatform: pick wins, then first connected, then Instagram", () => {
    localStorage.clear();
    expect(defaultFeedPlatform("w1", [])).toBe("instagram");
    expect(defaultFeedPlatform("w1", ["twitter"])).toBe("twitter");
    setFeedPlatformPick("w1", ["xhs"]);
    expect(defaultFeedPlatform("w1", ["twitter"])).toBe("xhs");
  });
});
