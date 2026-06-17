// @vitest-environment jsdom
/**
 * [COMP:app-web/block-area-select] Area-select gesture SCOPING.
 *
 * The drag-to-area-select gesture attaches a capture-phase `mousedown` listener
 * to the editor's scroll pane (`findScrollPane`). Two ways the gesture used to
 * leak onto overlays floating over the page (e.g. the bottom-right chat panel),
 * so a drag meant to select chat text rubber-banded the page beneath it:
 *
 *   1. `findScrollPane` gated on `scrollHeight > clientHeight`. At editor-init
 *      the doc hasn't grown past one viewport yet, so it found no scrolling
 *      ancestor and fell through to `document.scrollingElement` — pinning the
 *      listener to the WHOLE document for the page's lifetime. We now match on
 *      the overflow STYLE alone, so the editor's scroll container is found
 *      regardless of current height, scoping the listener to the editor.
 *
 *   2. `isInteractiveTarget` is the press-time bail. It now also skips presses
 *      inside an overlay (chat panel/drawer tagged `data-area-select-ignore`, or
 *      a portaled menu/dialog/listbox) — the safety net for the degenerate layout
 *      where no scroll ancestor exists and the listener lands wide.
 *
 * jsdom computes no layout (`scrollHeight`/`clientHeight` are 0), so the OLD
 * gate would always fall through here — exactly the regression these pins guard.
 */

import { describe, expect, it, afterEach } from "vitest";
import { findScrollPane, isInteractiveTarget } from "../block-area-select";

afterEach(() => {
  document.body.replaceChildren();
});

/** Build the doc DOM shape: scroll pane → centered column → ProseMirror. */
function mountEditorTree(opts: { scrollPaneOverflow: boolean }) {
  const scroll = document.createElement("div");
  if (opts.scrollPaneOverflow) scroll.style.overflowY = "auto";
  const col = document.createElement("div"); // .doc-page-content — no overflow
  const pm = document.createElement("div"); // .ProseMirror (view.dom)
  col.appendChild(pm);
  scroll.appendChild(col);
  document.body.appendChild(scroll);
  return { scroll, col, pm };
}

describe("[COMP:app-web/block-area-select] area-select scoping", () => {
  it("findScrollPane returns the overflow-y ancestor even when it does not currently scroll", () => {
    // jsdom reports scrollHeight === clientHeight === 0; the old gate failed here.
    const { scroll, pm } = mountEditorTree({ scrollPaneOverflow: true });
    expect(findScrollPane(pm)).toBe(scroll);
  });

  it("findScrollPane never escapes to the document scroller (gesture stays editor-scoped)", () => {
    // No overflow ancestor at all → fall back to the editor itself, NOT
    // document.scrollingElement. A document-wide listener is what let a drag in
    // the floating chat (a document descendant) rubber-band the page.
    const { pm } = mountEditorTree({ scrollPaneOverflow: false });
    const pane = findScrollPane(pm);
    expect(pane).toBe(pm);
    expect(pane).not.toBe(document.scrollingElement);
    expect(pane).not.toBe(document.body);
  });

  it("findScrollPane picks the NEAREST scrolling ancestor", () => {
    const { scroll, col, pm } = mountEditorTree({ scrollPaneOverflow: true });
    col.style.overflowY = "scroll"; // an inner scroller wins over the outer one
    expect(findScrollPane(pm)).toBe(col);
    expect(findScrollPane(pm)).not.toBe(scroll);
  });

  it("isInteractiveTarget bails on the chat panel (data-area-select-ignore)", () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-area-select-ignore", "");
    const messageText = document.createElement("p");
    panel.appendChild(messageText);
    document.body.appendChild(panel);
    expect(isInteractiveTarget(messageText)).toBe(true);
  });

  it("isInteractiveTarget bails on comment-thread text (data-area-select-ignore body)", () => {
    // The page-comments band hosts CommentThreadBody in a `role="region"` wrapper
    // (not `role="dialog"`), so without the body's own tag a drag to highlight a
    // comment used to start a page rubber-band instead of selecting the text.
    const body = document.createElement("div");
    body.setAttribute("data-area-select-ignore", "");
    const commentText = document.createElement("p"); // .chat-markdown row
    body.appendChild(commentText);
    document.body.appendChild(body);
    expect(isInteractiveTarget(commentText)).toBe(true);
  });

  it("isInteractiveTarget bails inside portaled menus / dialogs / listboxes", () => {
    for (const role of ["dialog", "menu", "listbox"]) {
      const overlay = document.createElement("div");
      overlay.setAttribute("role", role);
      const inner = document.createElement("span");
      overlay.appendChild(inner);
      document.body.appendChild(overlay);
      expect(isInteractiveTarget(inner)).toBe(true);
    }
  });

  it("isInteractiveTarget leaves plain editor text to the gesture", () => {
    const { pm } = mountEditorTree({ scrollPaneOverflow: true });
    const para = document.createElement("p");
    pm.appendChild(para);
    expect(isInteractiveTarget(para)).toBe(false);
  });
});
