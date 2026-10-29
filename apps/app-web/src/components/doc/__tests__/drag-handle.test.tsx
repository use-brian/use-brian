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
import { skillBodySchemaExtensions } from "@/lib/skill-markdown";

vi.mock("tippy.js", () => ({
  default: () => ({
    setProps() {},
    show() {},
    hide() {},
    destroy() {},
    state: { isVisible: false },
  }),
}));
// The menu only mounts on click / long-press and portals to the body; stub it
// with a marker so the tests stay on the grip contract (no menu import chain)
// while still proving WHEN it mounts.
vi.mock("../block-action-menu", () => ({
  BlockActionMenu: () => <div data-block-menu="" />,
}));

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

function mountEditor(extensions = browserDocExtensions()): Editor {
  editorEl = document.createElement("div");
  document.body.appendChild(editorEl);
  return new Editor({
    element: editorEl,
    extensions,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
  });
}

function render(ed: Editor | null, opts: { pageContext?: boolean } = { pageContext: true }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <DocDragHandle
          editor={ed}
          {...(opts.pageContext ? { workspaceId: "w1", pageId: "p1" } : {})}
        />
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

  it("mounts on the skill body editor's md schema without page context", () => {
    // The skill body editor reuses this handle over its md-restricted
    // non-collab schema and passes NO workspaceId/pageId (the menu's
    // Copy-link row gates on them). The grip must still build — the plugin's
    // Yjs remap paths no-op without a y-sync plugin state.
    editor = mountEditor([...skillBodySchemaExtensions]);
    render(editor, { pageContext: false });
    const grip = document.querySelector(".doc-drag-handle") as HTMLElement | null;
    expect(grip).not.toBeNull();
    expect(grip!.draggable).toBe(true);
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

  it("themes the REAL prosemirror dropcursor class to neutral interaction ink", () => {
    expect(css).toMatch(
      /\.prosemirror-dropcursor-block[\s\S]{0,200}background-color:[^;]*var\(--interaction\)/,
    );
  });

  it("tames the selected-block default outline into a soft fill", () => {
    expect(css).toMatch(
      /\.ProseMirror-selectednode\s*\{[\s\S]{0,200}outline:\s*none/,
    );
  });
});

/**
 * Touch path (responsive contract M2 / M9). A finger never hovers, so the
 * block menu needs a non-hover entry: a still long-press on a block latches
 * it as the target, reveals the grip and opens the menu. jsdom has no layout,
 * so the point→position resolution (`posAtCoords`) and the layout-box gate
 * (`getBoundingClientRect`) are stubbed; the contract under test is the
 * timing (hold = open, travel = scroll) and the wiring into the menu.
 */
describe("[COMP:app-web/drag-handle] long-press opens the block menu", () => {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = rect;
    vi.useRealTimers();
  });

  function touch(type: string, x: number, y: number): Event {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "touches", {
      value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
    });
    return ev;
  }

  function mountTouchable() {
    vi.useFakeTimers();
    editor = mountEditor();
    // Layout stubs: every block has a box, and the finger lands in the first
    // paragraph (pos 1 is inside "hi").
    HTMLElement.prototype.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 24, width: 200, height: 24, x: 0, y: 0, toJSON() {} }) as DOMRect;
    editor.view.posAtCoords = () => ({ pos: 1, inside: 0 });
    render(editor);
  }

  it("holds still past LONG_PRESS_MS: the grip reveals on the block and the menu opens", () => {
    mountTouchable();
    const dom = editor!.view.dom;
    act(() => {
      dom.dispatchEvent(touch("touchstart", 20, 10));
    });
    expect(document.querySelector("[data-block-menu]")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(449);
    });
    expect(document.querySelector("[data-block-menu]")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.querySelector("[data-block-menu]")).not.toBeNull();
    const grip = document.querySelector(".doc-drag-handle") as HTMLElement;
    expect(grip.style.visibility).toBe("visible");
  });

  it("a finger that travels past the slop is a scroll, not a press", () => {
    mountTouchable();
    const dom = editor!.view.dom;
    act(() => {
      dom.dispatchEvent(touch("touchstart", 20, 10));
      dom.dispatchEvent(touch("touchmove", 20, 40));
      vi.advanceTimersByTime(600);
    });
    expect(document.querySelector("[data-block-menu]")).toBeNull();
  });

  it("lifting the finger before the hold cancels it", () => {
    mountTouchable();
    const dom = editor!.view.dom;
    act(() => {
      dom.dispatchEvent(touch("touchstart", 20, 10));
      vi.advanceTimersByTime(200);
      dom.dispatchEvent(touch("touchend", 20, 10));
      vi.advanceTimersByTime(600);
    });
    expect(document.querySelector("[data-block-menu]")).toBeNull();
  });
});
