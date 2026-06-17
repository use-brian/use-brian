import { describe, it, expect } from "vitest";
import {
  railHasRoom,
  stackCards,
  clipUnderChrome,
  RAIL_WIDTH,
  RAIL_GAP,
  RAIL_EDGE_MARGIN,
} from "../comment-rail";

/**
 * [COMP:app-web/comment-rail] geometry + stacking.
 *
 * The rail docks just right of the page column. The shell reserves a right
 * gutter (shifting content left) when a page has inline comments, so the
 * column's right edge moves left and a card fits past it; `railHasRoom` is the
 * gate (else the on-content overlay takes over). `stackCards` keeps cards from
 * overlapping when their anchored lines sit close together.
 */
describe("[COMP:app-web/comment-rail] railHasRoom", () => {
  const need = RAIL_GAP + RAIL_WIDTH + RAIL_EDGE_MARGIN;

  it("is true once the column's right edge clears a card + gaps", () => {
    expect(railHasRoom(820, 820 + need)).toBe(true);
    expect(railHasRoom(820, 820 + need - 1)).toBe(false);
  });

  it("is true when content is shifted left (gutter reserved)", () => {
    // Wide viewport, content shifted left so its right edge sits at 1200.
    expect(railHasRoom(1200, 1920)).toBe(true);
  });

  it("is false when a centered column ends too close to the edge", () => {
    // Centered 720 column on 1280 → right edge ~1000; no gutter reserved.
    expect(railHasRoom(1000, 1280)).toBe(false);
  });
});

describe("[COMP:app-web/comment-rail] stackCards", () => {
  it("leaves well-separated cards at their anchor tops", () => {
    const out = stackCards(
      [
        { threadId: "a", anchorTop: 100, height: 80 },
        { threadId: "b", anchorTop: 400, height: 80 },
      ],
      12,
    );
    expect(out.get("a")).toBe(100);
    expect(out.get("b")).toBe(400);
  });

  it("pushes a colliding card below the previous card + gap", () => {
    const out = stackCards(
      [
        { threadId: "a", anchorTop: 100, height: 80 },
        { threadId: "b", anchorTop: 120, height: 80 }, // would overlap a
      ],
      12,
    );
    expect(out.get("a")).toBe(100);
    expect(out.get("b")).toBe(100 + 80 + 12); // 192
  });

  it("cascades multiple collisions", () => {
    const out = stackCards(
      [
        { threadId: "a", anchorTop: 100, height: 50 },
        { threadId: "b", anchorTop: 110, height: 50 },
        { threadId: "c", anchorTop: 120, height: 50 },
      ],
      10,
    );
    expect(out.get("a")).toBe(100);
    expect(out.get("b")).toBe(160);
    expect(out.get("c")).toBe(220);
  });

  it("is order-stable regardless of input order (sorted by anchor top)", () => {
    const out = stackCards(
      [
        { threadId: "b", anchorTop: 120, height: 80 },
        { threadId: "a", anchorTop: 100, height: 80 },
      ],
      12,
    );
    expect(out.get("a")).toBe(100);
    expect(out.get("b")).toBe(192);
  });

  it("returns an empty map for no cards", () => {
    expect(stackCards([], 12).size).toBe(0);
  });
});

/**
 * [COMP:app-web/comment-rail] slide-under-chrome clip.
 *
 * The rail is fixed + body-portaled, so a collapsed card tracking a line that
 * scrolls up into the top bar would paint OVER it. Instead the card is clipped
 * at the chrome's bottom edge (`safeTop` = `chromeBottom()`), so the slice
 * behind the bars is hidden and the card appears to slide UNDER them.
 */
describe("[COMP:app-web/comment-rail] clipUnderChrome", () => {
  it("clips nothing while the card sits at or below the chrome", () => {
    expect(clipUnderChrome(120, 88)).toBe(0);
    expect(clipUnderChrome(88, 88)).toBe(0);
  });

  it("clips exactly the slice that has slid up behind the chrome", () => {
    expect(clipUnderChrome(60, 88)).toBe(28); // 28px of the top hidden
    expect(clipUnderChrome(-16, 88)).toBe(104); // a full collapsed card under
  });
});
