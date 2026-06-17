// @vitest-environment jsdom
/**
 * [COMP:app-web/share-dialog] Mobile comment drawer (public share view).
 *
 * On the read-only share page the margin rail covers `xl+`; below `xl` it's
 * hidden and tapping a highlighted comment in the text opens a bottom-sheet
 * drawer (Notion mobile style) showing that one thread. Two pieces are unit-
 * tested here:
 *   - `commentThreadIdAt` — the tap → thread lookup (nearest
 *     `[data-comment-thread]` ancestor of the tapped node), the core new logic.
 *   - `MobileCommentDrawer` — SSR of the open/closed sheet (slide state +
 *     dialog role + the thread body), via the exported component.
 */

import { describe, expect, it } from "vitest";
import { type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { PublicComment } from "@/lib/api/public-share";
import { commentThreadIdAt, MobileCommentDrawer } from "../public-page-view";

const dict = en as unknown as Dictionary;

function wrap(node: ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

const thread = (over: Partial<PublicComment> = {}): PublicComment => ({
  threadId: "th-1",
  anchorBlockId: "b1",
  quote: "the anchored quote",
  messages: [{ author: "Ana", avatar: null, body: "Looks good to me", createdAt: "2026-06-11T00:00:00Z" }],
  ...over,
});

describe("[COMP:app-web/share-dialog] commentThreadIdAt", () => {
  function frag(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root;
  }

  it("returns the thread id of the nearest highlighted ancestor", () => {
    const root = frag(
      '<p>before <span data-comment-thread="t1" class="doc-comment-hl"><em id="inner">word</em></span> after</p>',
    );
    expect(commentThreadIdAt(root.querySelector("#inner"))).toBe("t1");
    // The highlight span itself is also a match (closest includes self).
    expect(commentThreadIdAt(root.querySelector("[data-comment-thread]"))).toBe("t1");
  });

  it("returns null when the tap missed every highlight", () => {
    const root = frag("<p id='plain'>no comments here</p>");
    expect(commentThreadIdAt(root.querySelector("#plain"))).toBeNull();
  });

  it("returns null for an empty thread id and a non-Element target", () => {
    const root = frag('<span data-comment-thread="" id="empty">x</span>');
    expect(commentThreadIdAt(root.querySelector("#empty"))).toBeNull();
    expect(commentThreadIdAt(document.createTextNode("x"))).toBeNull();
    expect(commentThreadIdAt(null)).toBeNull();
  });
});

describe("[COMP:app-web/share-dialog] MobileCommentDrawer", () => {
  it("renders the tapped thread, open, as a dialog sheet slid into view", () => {
    const html = wrap(<MobileCommentDrawer thread={thread()} onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    // Open → the sheet is translated in (not parked off-screen below).
    expect(html).toContain("translate-y-0");
    expect(html).not.toContain("translate-y-full");
    // The thread's content renders inside the sheet.
    expect(html).toContain("Looks good to me");
    expect(html).toContain("the anchored quote");
    expect(html).toContain("Ana");
  });

  it("parks the sheet off-screen and hides it when closed (no thread)", () => {
    const html = wrap(<MobileCommentDrawer thread={null} onClose={() => {}} />);
    // Closed → slid below the viewport edge + backdrop non-interactive.
    expect(html).toContain("translate-y-full");
    expect(html).toContain("pointer-events-none");
    // The wrapper is xl:hidden (rail covers wide screens) and aria-hidden.
    expect(html).toContain("xl:hidden");
    expect(html).toContain('aria-hidden="true"');
  });
});
