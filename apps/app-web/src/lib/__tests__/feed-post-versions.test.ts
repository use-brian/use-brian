import { describe, expect, it } from "vitest";
import {
  buildVersions,
  counterState,
  isPostFormatForPlatform,
  parseFeedPostBriefSeed,
  platformLimit,
  postFormatsForPlatform,
  resolveSelectedVersion,
  xWeightedLength,
  type ProposedDraft,
} from "@/lib/feed-post-versions";

const proposals: ProposedDraft[] = [
  { index: 2, text: "Warm take.", label: "warm" },
  { index: 1, text: "Punchy take.", label: "punchy" },
];

describe("[COMP:app-web/feed-post-versions] post version model", () => {
  it("lists the assistant's proposals in index order", () => {
    const versions = buildVersions({ proposals, ownText: null, savedText: null });
    expect(versions.map((v) => v.id)).toEqual(["p1", "p2"]);
    expect(versions[0].label).toBe("punchy");
    expect(versions.every((v) => v.origin === "assistant")).toBe(true);
  });

  // The whole point of D17: an edit must not overwrite what the model wrote.
  it("appends the operator's fork last, keeping the originals", () => {
    const versions = buildVersions({
      proposals,
      ownText: "My own take.",
      savedText: null,
    });
    expect(versions.map((v) => v.id)).toEqual(["p1", "p2", "mine"]);
    expect(versions[2].origin).toBe("operator");
    expect(versions[0].text).toBe("Punchy take.");
  });

  it("suppresses a fork that is byte-identical to a proposal", () => {
    const versions = buildVersions({
      proposals,
      ownText: "  Punchy take.  ",
      savedText: null,
    });
    expect(versions.map((v) => v.id)).toEqual(["p1", "p2"]);
  });

  it("seeds the fork from a saved draft when the operator has not typed", () => {
    const versions = buildVersions({
      proposals: [],
      ownText: null,
      savedText: "Committed copy.",
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ id: "mine", text: "Committed copy." });
  });

  it("ignores an empty fork", () => {
    expect(
      buildVersions({ proposals, ownText: "   ", savedText: null }),
    ).toHaveLength(2);
  });

  it("prefers an explicit selection, then the operator's own work", () => {
    const versions = buildVersions({
      proposals,
      ownText: "Mine.",
      savedText: null,
    });
    expect(resolveSelectedVersion(versions, "p1")?.id).toBe("p1");
    // No selection: the operator's fork outranks a suggestion.
    expect(resolveSelectedVersion(versions, null)?.id).toBe("mine");
    // A stale selection (that version is gone) falls back rather than blanking.
    expect(resolveSelectedVersion(versions, "p9")?.id).toBe("mine");
    expect(resolveSelectedVersion([], "p1")).toBeNull();
  });

  it("falls back to the last proposal when there is no fork", () => {
    const versions = buildVersions({ proposals, ownText: null, savedText: null });
    expect(resolveSelectedVersion(versions, null)?.id).toBe("p2");
  });

  it("knows each platform's copy limit", () => {
    expect(platformLimit("twitter")).toBe(280);
    expect(platformLimit("threads")).toBe(500);
    expect(platformLimit("linkedin")).toBe(3000);
    expect(platformLimit("mastodon")).toBeNull();
  });

  it("exposes only API-shaped formats for each platform", () => {
    expect(postFormatsForPlatform("twitter")).toEqual(["post", "thread"]);
    expect(postFormatsForPlatform("linkedin")).toEqual(["post", "article"]);
    expect(postFormatsForPlatform("threads")).toEqual(["post"]);
    expect(isPostFormatForPlatform("twitter", "article")).toBe(false);
    expect(isPostFormatForPlatform("linkedin", "article")).toBe(true);
  });

  it("restores format and private brief from the seeded first message", () => {
    expect(
      parseFeedPostBriefSeed(
        "Create an article link for LinkedIn.\n\nPrivate brief (not published):\nExplain the launch to operators.",
      ),
    ).toEqual({
      format: "article",
      brief: "Explain the launch to operators.",
    });
    expect(parseFeedPostBriefSeed("Create a thread for X.")).toEqual({
      format: "thread",
      brief: "",
    });
    expect(parseFeedPostBriefSeed("ordinary user message")).toBeNull();
  });

  it("uses X weighted characters, including t.co URL length", () => {
    expect(xWeightedLength("abc")).toBe(3);
    expect(xWeightedLength("🎉🎉")).toBe(4);
    expect(xWeightedLength("漢字")).toBe(4);
    expect(xWeightedLength("Read https://example.com/a/very/long/path now")).toBe(32);
    expect(counterState("🎉🎉", "twitter").count).toBe(4);
  });

  it("flags over and near the limit", () => {
    expect(counterState("x".repeat(281), "twitter")).toMatchObject({
      over: true,
      near: false,
    });
    expect(counterState("x".repeat(275), "twitter")).toMatchObject({
      over: false,
      near: true,
    });
    expect(counterState("x".repeat(10), "twitter")).toMatchObject({
      over: false,
      near: false,
    });
    // No known limit: never over, never near.
    expect(counterState("x".repeat(9_000), "mastodon")).toMatchObject({
      limit: null,
      over: false,
      near: false,
    });
  });
});
