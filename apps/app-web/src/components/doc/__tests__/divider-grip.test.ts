import { describe, it, expect } from "vitest";
import { gripReferenceRect, gripVerticalOffset, GRIP_HEIGHT } from "../block-drag-handle";

/**
 * Divider drag-handle anchoring. The collaborative editor renders the divider as
 * a bare `<hr>` (StarterKit horizontalRule), styled (globals.css) as a 1px rule
 * centred in a padded box so the hover drag handle has a real row to grab. Unlike
 * a text block, an `<hr>` has no first text line, so the vertical centring —
 * `gripVerticalOffset`, fed to tippy's `offset` — special-cases it: it centres the
 * grip on the element's vertical MIDDLE (where the rule sits), and is the one case
 * allowed to go NEGATIVE (a rule shorter than the 24px grip pulls the grip up onto
 * it). The horizontal anchor (`gripReferenceRect`) is the hr's own box. The fake
 * `<hr>` deliberately has no `getComputedStyle`; both functions take an HR-only
 * path that never reads it (so this also proves the HR branch is taken). Pure, so
 * it unit-tests without a mounted editor.
 */

function fakeHr(rect: Partial<DOMRect>): HTMLElement {
  const full = {
    left: 100,
    top: 200,
    right: 500,
    bottom: 217,
    width: 400,
    height: 17,
    ...rect,
  };
  return {
    tagName: "HR",
    getBoundingClientRect: () => full as DOMRect,
    closest: () => null,
  } as unknown as HTMLElement;
}

describe("[COMP:app-web/block-drag-handle] divider grip anchor", () => {
  it("centres the grip on the <hr>'s vertical middle (the rule), even above the box top", () => {
    const hr = fakeHr({ top: 200, height: 17 });
    // `left-start` anchors the grip's top to the hr box top (200); the offset adds
    // half the grip then the (possibly negative) skidding, landing the grip's
    // centre on the rule at 200 + 17/2 = 208.5 — independent of the grip height.
    const gripCentre = 200 + GRIP_HEIGHT / 2 + gripVerticalOffset(hr);
    expect(gripCentre).toBe(208.5);
  });

  it("anchors to the <hr>'s own left edge when it is not inside a list", () => {
    const r = gripReferenceRect(fakeHr({ left: 120 }));
    expect(r.left).toBe(120);
    expect(r.x).toBe(120);
  });
});
