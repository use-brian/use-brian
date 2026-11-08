// @vitest-environment jsdom
/**
 * [COMP:doc-model/schema] `> ` creates a toggle and does not join it.
 *
 * Tiptap's wrapping input rule joins a new wrapper into the previous sibling
 * of the same type. That continues a quote, and it swallows a toggle: typing
 * `> ` on the empty line after a toggle deletes the marker and nests the line
 * into the previous body. The toggle rule refuses that join. Driven through a
 * mounted editor because input rules only run on real text input.
 */

import { describe, expect, it, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { docExtensions } from "@use-brian/doc-model";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function mount(content: Record<string, unknown>): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: docExtensions(),
    content,
  });
  editor.commands.focus("end");
  return editor;
}

/** Simulate typing `char` at the cursor, the path a keystroke takes. */
function typeChar(ed: Editor, char: string): boolean {
  const pos = ed.state.selection.from;
  return (
    ed.view.someProp("handleTextInput", (handler) =>
      handler(ed.view, pos, pos, char, () => ed.state.tr.insertText(char, pos, pos)),
    ) ?? false
  );
}

/** Block shape without attrs other than a toggle's open flag. */
function outline(node: PMNode): unknown {
  if (node.isText) return node.text;
  const content: unknown[] = [];
  node.forEach((child) => content.push(outline(child)));
  if (node.type.name === "toggle") {
    return { type: "toggle", open: node.attrs.open, content };
  }
  return { type: node.type.name, content };
}

const summary = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("[COMP:doc-model/schema] toggle markdown trigger", () => {
  it("turns a lone `> ` into an open toggle", () => {
    const ed = mount({
      type: "doc",
      content: [summary(">")],
    });
    expect(typeChar(ed, " ")).toBe(true);
    expect(outline(ed.state.doc)).toEqual({
      type: "doc",
      content: [
        { type: "toggle", open: true, content: [{ type: "paragraph", content: [] }] },
      ],
    });
  });

  it("creates a sibling toggle after an existing one instead of nesting the line", () => {
    const ed = mount({
      type: "doc",
      content: [
        {
          type: "toggle",
          attrs: { open: true },
          content: [
            summary("Existing"),
            {
              type: "bulletList",
              content: [
                { type: "listItem", content: [summary("Start with the brief")] },
              ],
            },
          ],
        },
        summary(">"),
      ],
    });
    expect(typeChar(ed, " ")).toBe(true);
    expect(outline(ed.state.doc)).toEqual({
      type: "doc",
      content: [
        {
          type: "toggle",
          open: true,
          content: [
            { type: "paragraph", content: ["Existing"] },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [{ type: "paragraph", content: ["Start with the brief"] }],
                },
              ],
            },
          ],
        },
        { type: "toggle", open: true, content: [{ type: "paragraph", content: [] }] },
      ],
    });
  });

  it("still creates a nested toggle when `> ` is typed inside a toggle body", () => {
    const ed = mount({
      type: "doc",
      content: [
        {
          type: "toggle",
          attrs: { open: true },
          content: [summary("Parent"), summary(">")],
        },
      ],
    });
    expect(typeChar(ed, " ")).toBe(true);
    expect(outline(ed.state.doc)).toEqual({
      type: "doc",
      content: [
        {
          type: "toggle",
          open: true,
          content: [
            { type: "paragraph", content: ["Parent"] },
            { type: "toggle", open: true, content: [{ type: "paragraph", content: [] }] },
          ],
        },
      ],
    });
  });

  it("still joins a following `| ` into the previous quote", () => {
    const ed = mount({
      type: "doc",
      content: [
        { type: "blockquote", content: [summary("Said")] },
        summary("|"),
      ],
    });
    expect(typeChar(ed, " ")).toBe(true);
    expect(outline(ed.state.doc)).toEqual({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: ["Said"] },
            { type: "paragraph", content: [] },
          ],
        },
      ],
    });
  });
});
