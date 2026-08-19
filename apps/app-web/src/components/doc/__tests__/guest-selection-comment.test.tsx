// @vitest-environment jsdom
/**
 * [COMP:app-web/guest-selection-comment] Select-to-comment on the public page:
 * the pill + composer placement math (pure), and the mounted component's
 * resting state (nothing rendered until a selection exists).
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRef } from "react";

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    sharedPage: {
      comments: {
        selectionAction: "Comment",
        selectionAria: "Comment on the selected text",
        composerAria: "New comment",
        cancel: "Cancel",
        namePlaceholder: "Your name",
        placeholder: "Add a comment",
        post: "Post",
        posting: "Posting…",
        heading: "Comments",
      },
    },
  }),
}));

import {
  GuestSelectionComment,
  bubblePositionFor,
  composerPositionFor,
} from "../guest-selection-comment";

const rects = [
  { top: 100, left: 40, width: 200, height: 24 },
  { top: 124, left: 0, width: 120, height: 24 },
];

describe("[COMP:app-web/guest-selection-comment] placement", () => {
  it("puts the pill above the first highlighted line, left-aligned and clamped inside the container", () => {
    expect(bubblePositionFor(rects, 800)).toEqual({ top: 60, left: 40 });
    // Near the top edge → clamps to 0 rather than going negative.
    expect(bubblePositionFor([{ top: 10, left: 5, width: 50, height: 20 }], 800)?.top).toBe(0);
    // Narrow container → the pill's left is clamped so it stays inside.
    expect(bubblePositionFor([{ top: 100, left: 790, width: 10, height: 20 }], 800)?.left).toBe(680);
    expect(bubblePositionFor([], 800)).toBeNull();
  });

  it("puts the composer under the last highlighted line, sized to the container", () => {
    expect(composerPositionFor(rects, 800)).toEqual({ top: 156, left: 40, width: 360 });
    // A phone-width container shrinks the card and pins it to the left edge.
    expect(composerPositionFor(rects, 320)).toEqual({ top: 156, left: 0, width: 320 });
    expect(composerPositionFor([], 800)).toBeNull();
  });
});

describe("[COMP:app-web/guest-selection-comment] resting render", () => {
  it("renders nothing until the guest selects text (no pill, no composer, no swatch)", () => {
    const html = renderToString(
      <GuestSelectionComment
        source={{ kind: "published", pageId: "p1" }}
        identityKey="published:p1"
        containerRef={createRef<HTMLDivElement>()}
      />,
    );
    expect(html).toBe("");
  });
});
