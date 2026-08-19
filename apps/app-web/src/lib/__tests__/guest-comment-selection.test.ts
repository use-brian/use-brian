// @vitest-environment jsdom
/**
 * [COMP:app-web/guest-comment-selection] DOM selection → guest comment draft.
 * The public renderer tags block roots with `data-block-id`; a selection maps
 * to the block it STARTS in and its quote is clipped to that block, since the
 * renderers re-anchor by searching the quote inside that one block's text.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  GUEST_QUOTE_MAX_CHARS,
  blockElementAt,
  draftFromSelection,
  draftRects,
} from "../guest-comment-selection";

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  return document.getElementById("root")!;
}

/** Select from (node, offset) to (node, offset) and return the live Selection. */
function select(start: Node, so: number, end: Node, eo: number): Selection {
  const range = document.createRange();
  range.setStart(start, so);
  range.setEnd(end, eo);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

beforeEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe("[COMP:app-web/guest-comment-selection] blockElementAt", () => {
  it("walks up from a text node to the nearest data-block-id root", () => {
    const root = mount('<p data-block-id="p1"><span>hi <b>there</b></span></p>');
    const b = root.querySelector("b")!.firstChild!;
    expect(blockElementAt(b)?.getAttribute("data-block-id")).toBe("p1");
  });

  it("returns null outside any block or for an empty id", () => {
    const root = mount('<p data-block-id="">x</p><p>y</p>');
    expect(blockElementAt(root.querySelectorAll("p")[0].firstChild)).toBeNull();
    expect(blockElementAt(root.querySelectorAll("p")[1].firstChild)).toBeNull();
    expect(blockElementAt(null)).toBeNull();
  });
});

describe("[COMP:app-web/guest-comment-selection] draftFromSelection", () => {
  it("returns the start block's id and the selected text as the quote", () => {
    const root = mount('<p data-block-id="p1">The first claim. The second claim.</p>');
    const t = root.querySelector("p")!.firstChild!;
    const d = draftFromSelection(select(t, 21, t, 33), root);
    expect(d?.anchorBlockId).toBe("p1");
    expect(d?.quote).toBe("second claim");
  });

  it("clips a selection that runs into the next block to the START block's text", () => {
    const root = mount(
      '<p data-block-id="p1">alpha beta</p><p data-block-id="p2">gamma delta</p>',
    );
    const [p1, p2] = Array.from(root.querySelectorAll("p"));
    const d = draftFromSelection(select(p1.firstChild!, 6, p2.firstChild!, 5), root);
    expect(d?.anchorBlockId).toBe("p1");
    expect(d?.quote).toBe("beta");
    expect(d?.range.toString()).toBe("beta");
  });

  it("returns null for a collapsed selection, one outside the root, or one not in a block", () => {
    const root = mount('<p data-block-id="p1">text</p><p>loose</p>');
    const t = root.querySelector("p")!.firstChild!;
    expect(draftFromSelection(select(t, 1, t, 1), root)).toBeNull();
    expect(draftFromSelection(null, root)).toBeNull();
    const loose = root.querySelectorAll("p")[1].firstChild!;
    expect(draftFromSelection(select(loose, 0, loose, 3), root)).toBeNull();
    // Outside the root entirely.
    const other = document.createElement("p");
    other.textContent = "elsewhere";
    document.body.appendChild(other);
    expect(draftFromSelection(select(other.firstChild!, 0, other.firstChild!, 4), root)).toBeNull();
  });

  it("returns null for a whitespace-only selection and caps the quote length", () => {
    const long = "x".repeat(GUEST_QUOTE_MAX_CHARS + 50);
    const root = mount(`<p data-block-id="p1">   </p><p data-block-id="p2">${long}</p>`);
    const [ws, lp] = Array.from(root.querySelectorAll("p"));
    expect(draftFromSelection(select(ws.firstChild!, 0, ws.firstChild!, 3), root)).toBeNull();
    const d = draftFromSelection(select(lp.firstChild!, 0, lp.firstChild!, long.length), root);
    expect(d?.quote.length).toBe(GUEST_QUOTE_MAX_CHARS);
  });
});

describe("[COMP:app-web/guest-comment-selection] draftRects", () => {
  it("translates client rects into the container's space and merges same-line fragments, dropping empties", () => {
    const root = mount('<p data-block-id="p1">ab</p>');
    const range = document.createRange();
    range.selectNodeContents(root.querySelector("p")!);
    // jsdom has no layout: stub the rects.
    const rects = [
      { top: 110, left: 20, width: 30, height: 20 },
      { top: 110, left: 50, width: 10, height: 20 }, // same line → merged
      { top: 140, left: 20, width: 0, height: 20 }, // empty → dropped
      { top: 140, left: 20, width: 40, height: 20 },
    ] as unknown as DOMRectList;
    range.getClientRects = () => rects;
    root.getBoundingClientRect = () =>
      ({ top: 100, left: 10, width: 500, height: 500, right: 510, bottom: 600, x: 10, y: 100, toJSON() {} }) as DOMRect;
    expect(draftRects(range, root)).toEqual([
      { top: 10, left: 10, width: 40, height: 20 },
      { top: 40, left: 10, width: 40, height: 20 },
    ]);
  });
});
