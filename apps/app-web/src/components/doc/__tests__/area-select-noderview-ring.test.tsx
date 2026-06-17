// @vitest-environment jsdom
/**
 * [COMP:app-web/block-area-select] Area-select node-view ring — DOM contract.
 *
 * Pins the reason the `globals.css` ring-suppression rules exist (jsdom doesn't
 * apply CSS, so this asserts the class MECHANISM, not computed styles). When an
 * area (NodeRange) select covers a toggle that contains a nested toggle, the
 * `@tiptap/react` node-view machinery stamps `.ProseMirror-selectednode` (the
 * single-node selection ring) on EVERY node-view inside the range — the outer
 * toggle (on top of its `.ProseMirror-selectednoderange` band) AND the nested
 * toggle (which carries no band of its own). A plain paragraph in the same range
 * is NOT a node-view, so it never gets the ring. That asymmetry is exactly what
 * made a selected toggle look different from other blocks and boxed the nested
 * toggle; the CSS strips the ring on/inside a range select. If a Tiptap upgrade
 * renames the class, this test fails before the silent CSS no-op ships.
 */

import { describe, expect, it, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { NodeRangeSelection } from "@tiptap/extension-node-range";
import { browserDocExtensions } from "../doc-schema";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let activeRoot: Root | null = null;
let activeHost: HTMLElement | null = null;
afterEach(() => {
  activeRoot?.unmount();
  activeRoot = null;
  activeHost?.remove();
  activeHost = null;
});

describe("[COMP:app-web/block-area-select] area-select node-view ring", () => {
  it("tags node-view blocks (toggle) with selectednode in a range; plain text escapes", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let editorRef: Editor | null = null;
    function Test() {
      const editor = useEditor({
        immediatelyRender: false,
        extensions: browserDocExtensions(),
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "before" }] },
            {
              type: "toggle",
              attrs: { open: true },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "toggle" }] },
                {
                  type: "toggle",
                  attrs: { open: true },
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "sub toggle" }] },
                    { type: "paragraph", content: [{ type: "text", text: "c" }] },
                  ],
                },
              ],
            },
          ],
        },
      });
      editorRef = editor ?? null;
      return editor
        ? createElement(EditorContent, { editor, className: "doc-collab-editor" })
        : null;
    }
    const root = createRoot(host);
    activeRoot = root;
    activeHost = host;
    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          dict: en,
          locale: "en",
          children: createElement(Test),
        } as never),
      );
    });
    // Wait for the React node-views to mount.
    for (let i = 0; i < 100; i++) {
      if (host.querySelector(".doc-toggle .doc-toggle")) break;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }

    const ed = editorRef!;
    // Area-select a range covering the "before" paragraph + the outer toggle.
    await act(async () => {
      const to = ed.state.doc.content.size;
      const sel = NodeRangeSelection.create(ed.state.doc, 1, to - 1);
      ed.view.dispatch(ed.state.tr.setSelection(sel as never));
    });

    // Both toggles (outer + nested) are node-views → they get the ring class.
    // (The ring lands on Tiptap's node-view wrapper, which holds `.doc-toggle`.)
    const ringed = Array.from(host.querySelectorAll(".ProseMirror-selectednode"));
    expect(ringed.length).toBe(2);
    expect(ringed.every((el) => el.querySelector(".doc-toggle") !== null)).toBe(true);
    // The nested toggle is ringed even though it carries no band of its own.
    expect(ringed.some((el) => (el.textContent ?? "").startsWith("sub toggle"))).toBe(true);
    // A plain paragraph in the same range is NOT a node-view → no ring.
    const before = Array.from(host.querySelectorAll("p")).find(
      (el) => el.textContent === "before",
    );
    expect(before).toBeTruthy();
    expect(before!.closest(".ProseMirror-selectednode")).toBeNull();
  });
});
