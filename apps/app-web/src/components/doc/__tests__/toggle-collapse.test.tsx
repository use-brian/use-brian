// @vitest-environment jsdom
/**
 * [COMP:app-web/toggle-view] Toggle collapse — real-editor DOM contract.
 *
 * Mounts the live `@tiptap/react` editor (the only way to see the actual
 * node-view DOM) and asserts the collapse CSS selectors target the right
 * elements. This guards a bug that shipped twice: `@tiptap/react` wraps a
 * node-view's content in an internal `[data-node-view-content-react]` div, so
 * the toggle's child blocks are GRANDCHILDREN of `.doc-toggle-content`, not
 * direct children. A `.doc-toggle-content > *:not(:first-child)` selector
 * therefore matched nothing and the body never collapsed; the working selector
 * pierces the wrapper with `> * > *:not(:first-child)` (see globals.css).
 *
 * jsdom doesn't apply globals.css, so we can't read computed `display`; instead
 * we run the exact selector via `querySelectorAll` and assert it matches the
 * body block (and not the summary) — a direct test of selector correctness.
 */

import { describe, expect, it, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEditor, EditorContent } from "@tiptap/react";
import { browserDocExtensions } from "../doc-schema";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

// Opt into React's act() environment so the editor + node-view mount flush
// synchronously without the "not configured to support act" warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The selectors must stay byte-identical to globals.css `.doc-toggle`.
const INDENT_SELECTOR =
  ".doc-toggle-content > * > *:not(:first-child)";
const COLLAPSE_SELECTOR =
  '.doc-toggle[data-open="false"] .doc-toggle-content > * > *:not(:first-child)';

let activeRoot: Root | null = null;
let activeHost: HTMLElement | null = null;

afterEach(() => {
  activeRoot?.unmount();
  activeRoot = null;
  activeHost?.remove();
  activeHost = null;
});

async function mountToggle(open: boolean, summary?: object): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  function Test() {
    const editor = useEditor({
      immediatelyRender: false,
      extensions: browserDocExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "toggle",
            attrs: { open },
            content: [
              summary ?? { type: "paragraph", content: [{ type: "text", text: "sdsa" }] },
              { type: "paragraph", content: [{ type: "text", text: "adas" }] },
            ],
          },
        ],
      },
    });
    return editor
      ? createElement(EditorContent, { editor, className: "doc-collab-editor" })
      : null;
  }
  const root = createRoot(host);
  activeRoot = root;
  activeHost = host;
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        { dict: en, locale: "en", children: createElement(Test) } as never,
      ),
    );
  });
  // The React node-view mounts asynchronously after the editor is ready. Poll
  // (rather than a fixed delay) so the test is deterministic, not racy: wait
  // until the toggle's body block has actually rendered into the DOM.
  for (let i = 0; i < 100; i++) {
    if (host.querySelector(".doc-toggle-content > * > *")) break;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  return host;
}

describe("[COMP:app-web/toggle-view] Toggle collapse selector", () => {
  it("renders the @tiptap/react content wrapper (grandchild structure)", async () => {
    const host = await mountToggle(true);
    const content = host.querySelector(".doc-toggle-content");
    expect(content).not.toBeNull();
    // The body blocks are NOT direct children — there's a wrapper in between.
    const wrapper = content!.querySelector(":scope > *");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelectorAll(":scope > p")).toHaveLength(2);
  });

  it("the collapse selector matches the body block, not the summary, when closed", async () => {
    const host = await mountToggle(false);
    const matched = host.querySelectorAll(COLLAPSE_SELECTOR);
    expect(matched).toHaveLength(1);
    expect(matched[0].textContent).toBe("adas");
    // The summary is never targeted.
    expect(Array.from(matched).some((el) => el.textContent === "sdsa")).toBe(false);
  });

  it("the collapse selector matches nothing while open (body stays visible)", async () => {
    const host = await mountToggle(true);
    expect(host.querySelectorAll(COLLAPSE_SELECTOR)).toHaveLength(0);
    // …but the indentation selector (no data-open gate) still nests the body.
    const indented = host.querySelectorAll(INDENT_SELECTOR);
    expect(indented).toHaveLength(1);
    expect(indented[0].textContent).toBe("adas");
  });

  it("clicking the chevron flips data-open and brings the body under the collapse selector", async () => {
    const host = await mountToggle(true);
    const wrapper = host.querySelector(".doc-toggle")!;
    const chevron = host.querySelector(".doc-toggle-chevron") as HTMLElement;
    expect(wrapper.getAttribute("data-open")).toBe("true");
    expect(host.querySelectorAll(COLLAPSE_SELECTOR)).toHaveLength(0);

    // Click the disclosure — the React onClick flips `open` via updateAttributes.
    await act(async () => {
      chevron.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(host.querySelector(".doc-toggle")!.getAttribute("data-open")).toBe("false");
    // Now collapsed: the body block is what the collapse rule (display:none) hits.
    const collapsed = host.querySelectorAll(COLLAPSE_SELECTOR);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].textContent).toBe("adas");
  });

  it("stamps data-summary with the summary's block kind (drives chevron centering)", async () => {
    // Paragraph summary → "p".
    const paraHost = await mountToggle(true);
    expect(paraHost.querySelector(".doc-toggle")!.getAttribute("data-summary")).toBe("p");
    afterEachCleanup();

    // Heading summary → "h1" (so the chevron centers on the taller line).
    const headHost = await mountToggle(true, {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "sdsa" }],
    });
    expect(headHost.querySelector(".doc-toggle")!.getAttribute("data-summary")).toBe("h1");
  });
});

/** Tear down the active root between two mounts in one test. */
function afterEachCleanup() {
  activeRoot?.unmount();
  activeRoot = null;
  activeHost?.remove();
  activeHost = null;
}
