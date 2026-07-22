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
    expect(FEED_PLATFORMS).toEqual(["instagram", "threads", "twitter", "xhs"]);
    expect(FEED_CONNECTABLE_PLATFORMS).toEqual(["threads", "twitter"]);
    expect(isFeedPlatform("threads")).toBe(true);
    expect(isFeedPlatform("instagram")).toBe(true);
    expect(isFeedPlatform("xhs")).toBe(true);
    expect(isFeedPlatform("mastodon")).toBe(false);
    expect(isFeedPlatform(null)).toBe(false);
    expect(isFeedPlatform(undefined)).toBe(false);
    expect(isConnectableFeedPlatform("twitter")).toBe(true);
    expect(isConnectableFeedPlatform("instagram")).toBe(false);
    expect(isConnectableFeedPlatform("xhs")).toBe(false);
  });

  it("keeps Create rows and platform rows in separate groups", () => {
    const createGroup = FEED_GROUPS.find((g) => !g.perPlatform);
    const platformGroup = FEED_GROUPS.find((g) => g.perPlatform);
    expect(createGroup?.key).toBe("create");
    expect(createGroup?.sections.map((s) => s.key)).toEqual([
      "home",
      "voice",
      "drafts",
      "inbox",
      "ready",
    ]);
    expect(platformGroup?.key).toBe("platforms");
    expect(platformGroup?.sections.map((s) => s.key)).toEqual([
      "insights",
      "inspiration",
      "connection",
      "policy",
      "settings",
    ]);
  });

  it("builds feed routes for team and platform scopes", () => {
    expect(feedPath("w1")).toBe("/w/w1/feed");
    expect(feedPath("w1", { segment: "inbox" })).toBe("/w/w1/feed/inbox");
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
    expect(feedPlatformFromPathname("/w/w1/feed/inbox")).toBeNull();
    expect(feedPlatformFromPathname("/w/w1/feed")).toBeNull();
    expect(feedPlatformFromPathname("/w/w1/brain")).toBeNull();
    expect(feedPlatformFromPathname(null)).toBeNull();
  });

  it("classifies feed sections from pathnames", () => {
    expect(feedSectionFromPathname("/w/w1/feed")).toBe("home");
    expect(feedSectionFromPathname("/w/w1/feed/")).toBe("home");
    expect(feedSectionFromPathname("/w/w1/feed/inbox")).toBe("inbox");
    expect(feedSectionFromPathname("/w/w1/feed/voice")).toBe("voice");
    expect(feedSectionFromPathname("/w/w1/feed/drafts")).toBe("drafts");
    expect(feedSectionFromPathname("/w/w1/feed/ready")).toBe("ready");
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
