import { describe, it, expect } from "vitest";
import { placeRailCards, RAIL_CARD_GAP } from "@/lib/comment-rail-layout";

/**
 * [COMP:app-web/comment-rail-layout] share-view comment rail stacking.
 *
 * `placeRailCards` positions each card at its anchored text, pushing it down so
 * it never overlaps the card above. The regression this guards: long comments
 * were covered by the next card because the layout used a too-short height
 * *estimate* instead of the real measured height. These cases pin that a tall
 * measured card reserves its full vertical space.
 */
describe("[COMP:app-web/comment-rail-layout] placeRailCards", () => {
  it("anchors a card at its text position when there's room above", () => {
    const placed = placeRailCards(
      [
        { threadId: "a", anchor: 0, estimatedHeight: 50 },
        { threadId: "b", anchor: 400, estimatedHeight: 50 },
      ],
      {},
    );
    expect(placed).toEqual([
      { threadId: "a", top: 0 },
      { threadId: "b", top: 400 },
    ]);
  });

  it("pushes a clustered card down by the previous card's height + gap", () => {
    const placed = placeRailCards(
      [
        { threadId: "a", anchor: 0, estimatedHeight: 50 },
        { threadId: "b", anchor: 10, estimatedHeight: 50 }, // anchored just below a
      ],
      { a: 80, b: 50 }, // a is measured taller than its anchor gap
    );
    // a sits at its anchor (0); b can't start before a's bottom (80) + gap (12).
    expect(placed[0]).toEqual({ threadId: "a", top: 0 });
    expect(placed[1]).toEqual({ threadId: "b", top: 80 + RAIL_CARD_GAP });
  });

  it("a long (tall) card reserves real space so the next card clears it", () => {
    // This is the bug: with the old `44 + messages*26` estimate the second card
    // would have started at ~70px and overlapped a 300px-tall first card.
    const placed = placeRailCards(
      [
        { threadId: "long", anchor: 0, estimatedHeight: 70 },
        { threadId: "next", anchor: 30, estimatedHeight: 70 },
      ],
      { long: 300, next: 70 },
    );
    expect(placed[1].top).toBe(300 + RAIL_CARD_GAP);
    expect(placed[1].top).toBeGreaterThanOrEqual(placed[0].top + 300);
  });

  it("falls back to the estimate before a card is measured", () => {
    const placed = placeRailCards(
      [
        { threadId: "a", anchor: 0, estimatedHeight: 100 },
        { threadId: "b", anchor: 0, estimatedHeight: 100 },
      ],
      {}, // nothing measured yet
    );
    expect(placed[1].top).toBe(100 + RAIL_CARD_GAP);
  });

  it("stacks un-anchored cards (anchor null) from the running cursor", () => {
    const placed = placeRailCards(
      [
        { threadId: "anchored", anchor: 0, estimatedHeight: 50 },
        { threadId: "page", anchor: null, estimatedHeight: 50 },
      ],
      { anchored: 60, page: 40 },
    );
    expect(placed[0]).toEqual({ threadId: "anchored", top: 0 });
    expect(placed[1]).toEqual({ threadId: "page", top: 60 + RAIL_CARD_GAP });
  });

  it("preserves input order in the output", () => {
    const placed = placeRailCards(
      [
        { threadId: "x", anchor: 0, estimatedHeight: 50 },
        { threadId: "y", anchor: 200, estimatedHeight: 50 },
        { threadId: "z", anchor: 500, estimatedHeight: 50 },
      ],
      {},
    );
    expect(placed.map((p) => p.threadId)).toEqual(["x", "y", "z"]);
  });
});
