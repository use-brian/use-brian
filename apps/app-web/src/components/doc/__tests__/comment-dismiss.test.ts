// @vitest-environment jsdom
/**
 * [COMP:app-web/comment-dismiss] isInsideComposerPopup.
 *
 * The single seam every doc comment surface's outside-click dismiss handler
 * routes its portaled-popup exclusion through (the band, the overlay popover,
 * the rail, the new-comment draft popover). Guards the regression where the
 * model-tier Select popup was excluded in some copies but not others, so
 * switching tiers from a block-anchored comment collapsed the card and dropped
 * the pick: a click on the `<body>`-portaled mention list OR model Select must
 * read as "inside the composer", a click anywhere else must read as outside.
 */
import { describe, it, expect, afterEach } from "vitest";
import { isInsideComposerPopup } from "../../../lib/comment-dismiss";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("[COMP:app-web/comment-dismiss] isInsideComposerPopup", () => {
  it("treats a click on a model-tier Select item (and its child nodes) as inside", () => {
    // Mirrors the base-ui Select portal: the popup carries data-slot, rows are
    // role=option inside a role=listbox, and the visible label is a child span.
    const host = mount(`
      <div data-slot="select-content">
        <div role="listbox">
          <div role="option" id="pro"><span id="label">Pro</span></div>
        </div>
      </div>
    `);
    expect(isInsideComposerPopup(host.querySelector("#label"))).toBe(true);
    expect(isInsideComposerPopup(host.querySelector("#pro"))).toBe(true);
    expect(isInsideComposerPopup(host.querySelector("[data-slot='select-content']"))).toBe(true);
  });

  it("treats a click in the @-mention popup as inside", () => {
    const host = mount(`<div data-mention-popup><button id="m">Ada</button></div>`);
    expect(isInsideComposerPopup(host.querySelector("#m"))).toBe(true);
  });

  it("treats a role=option row with no data-slot ancestor as inside (fallback)", () => {
    const host = mount(`<div role="option" id="bare">Standard</div>`);
    expect(isInsideComposerPopup(host.querySelector("#bare"))).toBe(true);
  });

  it("treats a genuine outside element as outside", () => {
    const host = mount(`<div id="elsewhere">page body</div>`);
    expect(isInsideComposerPopup(host.querySelector("#elsewhere"))).toBe(false);
  });

  it("is false for a null target", () => {
    expect(isInsideComposerPopup(null)).toBe(false);
  });
});
