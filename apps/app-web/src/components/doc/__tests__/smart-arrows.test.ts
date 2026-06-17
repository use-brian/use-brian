// @vitest-environment jsdom
/**
 * [COMP:app-web/smart-arrows] Notion-style smart-arrow input rules.
 *
 * Exercised against a real mounted editor with the full
 * `browserDocExtensions()` so the input rule actually installs and fires
 * through ProseMirror's input-rule plugin. Input rules only run on real text
 * input (not programmatic `insertContent`), so the test drives the editor's
 * `handleTextInput` prop the way a keystroke would: it places the cursor after
 * the opening character and feeds the closing one. The guarantees: typing the
 * close of `->` / `<-` rewrites the pair to `→` / `←` in place, and the rule is
 * inert inside a code block (code stays literal).
 */

import { describe, expect, it, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { browserDocExtensions } from "../doc-schema";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** Mount an editor whose single block holds `text`, cursor at the end. */
function mount(blockType: "paragraph" | "codeBlock", text: string): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: browserDocExtensions(),
    content: {
      type: "doc",
      content: [{ type: blockType, content: [{ type: "text", text }] }],
    },
  });
  editor.commands.focus("end");
  return editor;
}

/** Simulate typing `char` at the cursor — the path a real keystroke takes
 *  through the input-rule plugin. Returns whether a rule handled the input. */
function typeChar(ed: Editor, char: string): boolean {
  const pos = ed.state.selection.from;
  // `handleTextInput(view, from, to, text, deflt)` — the input-rule plugin
  // ignores `deflt` (it builds its own transaction), but the prop type wants
  // the default-insert thunk, so supply the no-op-equivalent one.
  return (
    ed.view.someProp("handleTextInput", (handler) =>
      handler(ed.view, pos, pos, char, () => ed.state.tr.insertText(char, pos, pos)),
    ) ?? false
  );
}

describe("[COMP:app-web/smart-arrows] arrow input rules", () => {
  it("rewrites `->` to `→`", () => {
    const ed = mount("paragraph", "-");
    expect(typeChar(ed, ">")).toBe(true);
    expect(ed.getText()).toBe("→");
  });

  it("rewrites `<-` to `←`", () => {
    const ed = mount("paragraph", "<");
    expect(typeChar(ed, "-")).toBe(true);
    expect(ed.getText()).toBe("←");
  });

  it("rewrites `->` mid-sentence, leaving surrounding text intact", () => {
    const ed = mount("paragraph", "yes-");
    expect(typeChar(ed, ">")).toBe(true);
    expect(ed.getText()).toBe("yes→");
  });

  it("does not fire on a bare `>` with no preceding `-`", () => {
    const ed = mount("paragraph", "a");
    expect(typeChar(ed, ">")).toBe(false);
    expect(ed.getText()).toBe("a"); // `>` insertion is left to the default handler
  });

  it("stays literal inside a code block (no conversion)", () => {
    const ed = mount("codeBlock", "-");
    expect(typeChar(ed, ">")).toBe(false);
    expect(ed.getText()).not.toContain("→");
  });
});
