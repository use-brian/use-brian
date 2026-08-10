/** [COMP:app-web/feed-media] */

import { describe, expect, it } from "vitest";
import {
  canPublishMedia,
  connectionPublishesMedia,
  mediaCapFor,
} from "@/lib/feed-media";

describe("[COMP:app-web/feed-media] Per-platform media rules", () => {
  it("caps attachments at what the target actually accepts", () => {
    expect(mediaCapFor("twitter")).toBe(4);
    expect(mediaCapFor("linkedin")).toBe(1);
    expect(mediaCapFor("threads")).toBe(10);
  });

  it("knows which platforms can publish media at all", () => {
    expect(canPublishMedia("threads")).toBe(true);
    expect(canPublishMedia("twitter")).toBe(true);
    expect(canPublishMedia("instagram")).toBe(false);
    expect(canPublishMedia("linkedin")).toBe(false);
  });

  it("separates platform support from THIS connection's grant", () => {
    // Only X makes these diverge: it supports media, but a connection made
    // before the media.write scope was requested does not carry the grant,
    // and scopes are not retroactive.
    expect(connectionPublishesMedia("twitter", true)).toBe(true);
    expect(connectionPublishesMedia("twitter", false)).toBe(false);
    // A platform that cannot publish stays false however the flag reads.
    expect(connectionPublishesMedia("instagram", true)).toBe(false);
  });

  it("treats an unspecified grant as the platform default, not a failure", () => {
    // An older API response without the field must not silently downgrade a
    // Threads post to manual delivery.
    expect(connectionPublishesMedia("threads", undefined)).toBe(true);
    expect(connectionPublishesMedia("instagram", undefined)).toBe(false);
  });
});
