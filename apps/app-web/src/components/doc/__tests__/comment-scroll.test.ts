/**
 * [COMP:app-web/comment-scroll] Stick-to-bottom predicate for the comment
 * thread message list — the pure half of the auto-scroll-to-newest-reply fix.
 * app-web vitest is node-only, so the effect wiring in comment-thread-body
 * isn't exercised here; this locks the geometry decision it depends on.
 */

import { describe, expect, it } from "vitest";
import {
  distanceFromBottom,
  pinnedToBottom,
  PIN_THRESHOLD_PX,
} from "../comment-scroll";

describe("[COMP:app-web/comment-scroll] pinnedToBottom", () => {
  it("is pinned when parked exactly at the bottom", () => {
    expect(pinnedToBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
  });

  it("stays pinned within the slack threshold (sub-pixel / bottom padding)", () => {
    // 30px of remaining scroll < 40px threshold → still following.
    expect(
      pinnedToBottom({ scrollHeight: 1000, scrollTop: 570, clientHeight: 400 }),
    ).toBe(true);
  });

  it("releases the pin once the reader scrolls up past the threshold", () => {
    // 200px above the bottom → reading history, don't yank them down.
    expect(
      pinnedToBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 400 }),
    ).toBe(false);
  });

  it("is trivially pinned when content is shorter than the viewport", () => {
    expect(pinnedToBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 400 })).toBe(true);
  });

  it("clamps a negative distance (overscroll) to zero → pinned", () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 400 })).toBe(0);
    expect(pinnedToBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 400 })).toBe(true);
  });

  it("honours a caller-supplied threshold", () => {
    const m = { scrollHeight: 1000, scrollTop: 540, clientHeight: 400 }; // 60px from bottom
    expect(pinnedToBottom(m)).toBe(false); // default 40px
    expect(pinnedToBottom(m, 80)).toBe(true);
  });

  it("exposes the default threshold it ships with", () => {
    expect(PIN_THRESHOLD_PX).toBe(40);
  });
});
