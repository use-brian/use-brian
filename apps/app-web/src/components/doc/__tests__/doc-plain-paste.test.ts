// @vitest-environment jsdom
/**
 * [COMP:app-web/doc-plain-paste] Paste without formatting (Shift+Cmd/Ctrl+V).
 *
 * The shortcut reads the clipboard text and inserts it through
 * `view.pasteText`, which strips formatting AND markdown (the editor's
 * markdown-paste conversion fires only on a real paste event, which this never
 * triggers) while staying context-aware — newlines go literal inside a code
 * block, paragraphs elsewhere. Exercised against a real mounted editor with the
 * full `browserDocExtensions()`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { browserDocExtensions } from "../doc-schema";
import { DocPlainPaste, pastePlain } from "../doc-plain-paste";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

function mount(block: "paragraph" | "codeBlock", text = ""): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: browserDocExtensions(),
    content: {
      type: "doc",
      content: [{ type: block, ...(text ? { content: [{ type: "text", text }] } : {}) }],
    },
  });
  editor.commands.focus("end");
  return editor;
}

function setClipboard(text: string) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: async () => text },
  });
}

/** Flush pending microtasks (the async clipboard read + insert). */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("[COMP:app-web/doc-plain-paste] Paste without formatting", () => {
  it("is wired into the browser extension set with a Shift-Mod-v shortcut", () => {
    const exts = browserDocExtensions();
    expect(exts.some((e) => e.name === "docPlainPaste")).toBe(true);
    const shortcuts = DocPlainPaste.config.addKeyboardShortcuts?.call(
      DocPlainPaste as never,
    );
    expect(Object.keys(shortcuts ?? {})).toContain("Shift-Mod-v");
  });

  it("returns false (leaving the browser's default paste) when clipboard read is unavailable", () => {
    const ed = mount("paragraph");
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    expect(pastePlain(ed)).toBe(false);
  });

  it("reads the clipboard and inserts the RAW text via view.pasteText (no markdown/HTML parse)", async () => {
    // `pasteText` is ProseMirror's plain-text insert: it never runs the editor's
    // markdown-paste conversion (that fires only on a real paste event) nor HTML
    // parsing. Asserting the call is the meaningful unit boundary — pasteText's
    // own plain + code-context behaviour is ProseMirror's contract, not ours.
    const ed = mount("paragraph");
    setClipboard("# not a heading\n- not a list");
    const spy = vi.spyOn(ed.view, "pasteText");
    expect(pastePlain(ed)).toBe(true);
    await flush();
    expect(spy).toHaveBeenCalledWith("# not a heading\n- not a list");
  });

  it("does not call pasteText when the clipboard is empty", async () => {
    const ed = mount("paragraph");
    setClipboard("");
    const spy = vi.spyOn(ed.view, "pasteText");
    expect(pastePlain(ed)).toBe(true);
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });
});
