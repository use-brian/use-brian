// @vitest-environment jsdom
/**
 * [COMP:app-web/drag-handle] Drag handle — reorder (drag) + block menu (click).
 *
 * The grip is a **vanilla DOM element** the plugin owns (not a React node — see
 * the module note: a React-rendered grip the plugin relocated desynced React and
 * crashed sibling reconciliation with `insertBefore`). So the contract is
 * exercised with a real editor mounted in jsdom: `DocDragHandle`'s effect
 * builds the grip, the plugin parents it under the editor DOM, and we assert the
 * grip's affordances. `tippy.js` is stubbed (positioning is irrelevant here and
 * jsdom has no layout) and the action menu is stubbed (it portals on click).
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { browserDocExtensions } from "../doc-schema";

vi.mock("tippy.js", () => ({
  default: () => ({
    setProps() {},
    show() {},
    hide() {},
    destroy() {},
    state: { isVisible: false },
  }),
}));
// The menu only mounts on click and portals to the body; stub it so the test
// stays on the grip contract without its import chain.
vi.mock("../block-action-menu", () => ({ BlockActionMenu: () => null }));

import { DocDragHandle } from "../drag-handle";

const dict = en as unknown as Dictionary;

let root: Root | null = null;
let host: HTMLElement | null = null;
let editor: Editor | null = null;
let editorEl: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  host?.remove();
  host = null;
  editorEl?.remove();
  editorEl = null;
});

function mountEditor(): Editor {
  editorEl = document.createElement("div");
  document.body.appendChild(editorEl);
  return new Editor({
    element: editorEl,
    extensions: browserDocExtensions(),
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
  });
}

function render(ed: Editor | null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <DocDragHandle editor={ed} workspaceId="w1" pageId="p1" />
      </I18nProvider>,
    );
  });
}

describe("[COMP:app-web/drag-handle] DocDragHandle", () => {
  it("registers no grip until the editor instance exists", () => {
    // `useEditor` is null on the first paint (immediatelyRender: false), and
    // read-only viewers never mount it — the guard must hold for both.
    render(null);
    expect(document.querySelector(".doc-drag-handle")).toBeNull();
  });

  it("builds a vanilla grip (aria + svg, draggable) parented under the editor", () => {
    editor = mountEditor();
    render(editor);
    const grip = document.querySelector(".doc-drag-handle") as HTMLElement | null;
    expect(grip).not.toBeNull();
    expect(grip!.getAttribute("aria-label")).toBe("Block options");
    // Inline GripVertical SVG — the visible ⋮⋮ affordance.
    expect(grip!.querySelector("svg")).not.toBeNull();
    // HTML5-draggable so a press-drag reorders the block.
    expect(grip!.draggable).toBe(true);
    // It is NOT inside the React host tree — it lives under the editor DOM, so
    // React never tries to reconcile it (the insertBefore-crash guard).
    expect(host!.contains(grip)).toBe(false);
  });
});

// The drop-indicator + selected-block visuals are CSS-only (the Dropcursor
// element only exists mid-drag, so there's no DOM to assert in SSR). Guard the
// load-bearing class CONTRACT instead: prosemirror-dropcursor classes its bar
// `.prosemirror-dropcursor-block` / `-inline` — an earlier `.ProseMirror-
// dropcursor` selector never matched, so the bar was an unthemed 1px hairline.
describe("[COMP:app-web/drag-handle] Drop-indicator styling", () => {
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/globals.css"),
    "utf8",
  );

  it("themes the REAL prosemirror dropcursor class to --primary", () => {
    expect(css).toMatch(
      /\.prosemirror-dropcursor-block[\s\S]{0,200}background-color:[^;]*var\(--primary\)/,
    );
  });

  it("tames the selected-block default outline into a soft fill", () => {
    expect(css).toMatch(
      /\.ProseMirror-selectednode\s*\{[\s\S]{0,200}outline:\s*none/,
    );
  });
});
