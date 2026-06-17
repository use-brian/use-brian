import { describe, it, expect } from "vitest";
import { placeAnchoredPanel, scrollMovesAnchor } from "../comment-thread-popover";

/**
 * [COMP:app-web/comment-thread-popover] placement math.
 *
 * The thread popover is anchored to the clicked comment highlight/badge and
 * must never spill off the top or bottom of the viewport — when there isn't
 * room it flips to the roomier side and compresses to an internal scroll. The
 * bug this guards against: a hardcoded height estimate flipped the box above
 * the anchor and clipped its top off-screen.
 */
describe("[COMP:app-web/comment-thread-popover] placeAnchoredPanel", () => {
  const VW = 1280;
  const VH = 800;
  const rect = (top: number, bottom: number, left = 200) =>
    ({ top, bottom, left }) as Pick<DOMRect, "top" | "bottom" | "left">;

  it("places below the anchor when there is comfortable room", () => {
    const pos = placeAnchoredPanel(rect(100, 120), VW, VH);
    expect(pos.top).toBe(128); // bottom (120) + GAP (8)
    expect(pos.bottom).toBeUndefined();
  });

  it("flips above when below is cramped and above is roomier", () => {
    // Anchor near the bottom: little room below, lots above.
    const pos = placeAnchoredPanel(rect(740, 760), VW, VH);
    expect(pos.top).toBeUndefined();
    // Bottom edge pinned just above the anchor's top: vh - top + GAP.
    expect(pos.bottom).toBe(VH - 740 + 8);
  });

  it("never lets the panel exceed the room on its chosen side (compress)", () => {
    // Below-placement: maxHeight must fit between the anchor and the viewport
    // bottom margin, so top + maxHeight stays on-screen.
    const below = placeAnchoredPanel(rect(100, 120), VW, VH);
    expect(below.top! + below.maxHeight).toBeLessThanOrEqual(VH);

    // Above-placement: the box grows upward from `bottom`; its top edge
    // (vh - bottom - maxHeight) must stay >= 0.
    const above = placeAnchoredPanel(rect(740, 760), VW, VH);
    expect(VH - above.bottom! - above.maxHeight).toBeGreaterThanOrEqual(0);
  });

  it("compresses on a short viewport instead of overflowing", () => {
    const shortVh = 360;
    const pos = placeAnchoredPanel(rect(40, 60), VW, shortVh);
    expect(pos.top).toBe(68);
    // maxHeight is bounded by the space below, never the full content height.
    expect(pos.maxHeight).toBeLessThanOrEqual(shortVh - 60 - 8 - 8 + 1);
    expect(pos.top! + pos.maxHeight).toBeLessThanOrEqual(shortVh);
  });

  it("clamps left so a wide panel stays inside the right edge", () => {
    // Anchor hugging the right edge — left must pull back by PANEL_WIDTH + margin.
    const pos = placeAnchoredPanel(rect(100, 120, VW - 10), VW, VH);
    expect(pos.left).toBeLessThanOrEqual(VW);
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });

  it("keeps a usable minimum height in an extremely short window", () => {
    const pos = placeAnchoredPanel(rect(10, 20), VW, 120);
    expect(pos.maxHeight).toBeGreaterThanOrEqual(160);
  });

  // The doc top bar + breadcrumb (≈88px) are fixed above the scrolling
  // content; the body-portaled panel must never grow up into them.
  describe("topInset (page chrome)", () => {
    const CHROME = 88;

    it("never flips above into the chrome — top edge stays at/below the inset", () => {
      // Anchor near the bottom → flips above; without an inset its top would
      // reach the plain 8px margin, overlapping the top bar.
      const pos = placeAnchoredPanel(rect(740, 760), VW, VH, CHROME);
      expect(pos.top).toBeUndefined();
      const topEdge = VH - pos.bottom! - pos.maxHeight;
      expect(topEdge).toBeGreaterThanOrEqual(CHROME);
    });

    it("keeps the below-placement top edge clear of the chrome when the anchor scrolls under it", () => {
      // Anchor partly tucked under the chrome (bottom at 40, inset at 88).
      const pos = placeAnchoredPanel(rect(20, 40), VW, VH, CHROME);
      expect(pos.top).toBe(CHROME);
      expect(pos.top! + pos.maxHeight).toBeLessThanOrEqual(VH);
    });

    it("matches the no-chrome behavior when the inset is below the anchor", () => {
      // Comfortable room below and the anchor sits well under the chrome →
      // the inset is inert and placement is identical to topInset=0.
      const withInset = placeAnchoredPanel(rect(300, 320), VW, VH, CHROME);
      const without = placeAnchoredPanel(rect(300, 320), VW, VH);
      expect(withInset).toEqual(without);
    });

    // The regression behind the cut-off-at-top bug: an unanchored thread is
    // anchored to the whole editor element, whose rect spans (and overflows)
    // the viewport. The old `max(MIN_HEIGHT, spaceAbove)` floor then forced a
    // 160px box pinned above the editor top, shoving its top above the chrome
    // and off the top of the screen.
    it("fills the band under the chrome when the anchor spans the viewport (unanchored thread)", () => {
      // Editor-wrap anchor: top just under the chrome, bottom far past vh.
      const pos = placeAnchoredPanel(rect(120, VH + 600), VW, VH, CHROME);
      expect(pos.top).toBe(CHROME); // pinned under the chrome, not above it
      expect(pos.bottom).toBeUndefined();
      expect(pos.top!).toBeGreaterThanOrEqual(CHROME);
      expect(pos.top! + pos.maxHeight).toBeLessThanOrEqual(VH);
    });

    it("never lets the MIN_HEIGHT floor push the top above the chrome", () => {
      // Sweep anchors so that one side or the other is cramped below MIN_HEIGHT;
      // in every case the rendered top edge must stay at/below the chrome.
      for (let top = -50; top < VH; top += 17) {
        const pos = placeAnchoredPanel(rect(top, top + 20), VW, VH, CHROME);
        const topEdge =
          pos.top !== undefined ? pos.top : VH - pos.bottom! - pos.maxHeight;
        expect(topEdge).toBeGreaterThanOrEqual(CHROME - 0.001);
      }
    });
  });
});

/**
 * [COMP:app-web/comment-thread-popover] scrollMovesAnchor.
 *
 * The streaming-flicker guard: the panel's capture-phase scroll listener must
 * reposition only when an ancestor (the page) scrolls — never when the thread
 * list scrolls INSIDE the panel. The bug this guards against: the message list
 * auto-following a streaming reply set its `scrollTop` on every SSE token, the
 * capture listener caught each one and recomputed placement, and the box
 * flipped below↔above ~3x/sec.
 */
describe("[COMP:app-web/comment-thread-popover] scrollMovesAnchor", () => {
  // A fake panel whose `contains` reports membership for one known inner node —
  // enough to exercise the rule without a DOM.
  const inner = {} as Node;
  const outside = {} as Node;
  const panel = { contains: (n: Node) => n === inner } as unknown as HTMLElement;

  it("ignores a scroll that originates inside the panel (streaming auto-follow)", () => {
    expect(scrollMovesAnchor(inner, panel)).toBe(false);
  });

  it("repositions on a scroll outside the panel (an ancestor / page scroll)", () => {
    expect(scrollMovesAnchor(outside, panel)).toBe(true);
  });

  it("repositions before the panel mounts, or when the event has no target", () => {
    expect(scrollMovesAnchor(inner, null)).toBe(true);
    expect(scrollMovesAnchor(null, panel)).toBe(true);
  });
});
