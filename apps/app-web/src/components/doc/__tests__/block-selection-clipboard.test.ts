// @vitest-environment jsdom
/**
 * [COMP:app-web/block-selection-clipboard] Cut and copy a block area selection.
 *
 * A `NodeRangeSelection` has no DOM range (the area-select gesture clears it),
 * so the browser never fires copy/cut and Command+X did nothing. The shortcut
 * writes a ProseMirror slice and, on cut, deletes the range only after that
 * write succeeds. Paste uses the editor's normal paste path.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { NodeRangeSelection } from "@tiptap/extension-node-range";
import { browserDocExtensions } from "../doc-schema";
import {
  BlockSelectionClipboard,
  copyBlockSelection,
  writeBlockClipboard,
  type BlockClipboardPayload,
} from "../block-selection-clipboard";

// jsdom's Range has no client rects. ProseMirror scrolls the paste caret into
// view through them, and the missing method rejects the otherwise-successful
// paste as an uncaught exception.
const originRect = {
  x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
  toJSON() { return {}; },
};
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [originRect] as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => originRect as unknown as DOMRect;
}

let editor: Editor | null = null;
const originalExec = document.execCommand;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.execCommand = originalExec;
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

function mount(content: unknown[], editable = true): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({
    element,
    editable,
    extensions: browserDocExtensions(),
    content: { type: "doc", content: content as never },
  });
  return editor;
}

const PAGE = [
  {
    type: "heading",
    attrs: { level: 2, blockId: "revenue" },
    content: [{ type: "text", text: "Revenue Target" }],
  },
  {
    type: "table",
    attrs: { blockId: "targets" },
    content: [
      {
        type: "tableRow",
        content: [
          {
            type: "tableCell",
            content: [{ type: "paragraph", content: [{ type: "text", text: "150k" }] }],
          },
        ],
      },
    ],
  },
  {
    type: "paragraph",
    attrs: { blockId: "ops" },
    content: [{ type: "text", text: "Operations Target" }],
  },
];

/** Select the first two top-level blocks, the same positions the area gesture uses. */
function selectFirstTwo(ed: Editor): void {
  const at = ed.state.doc.resolve(0);
  const from = at.posAtIndex(0);
  const to = at.posAtIndex(2);
  ed.view.dispatch(
    ed.state.tr.setSelection(NodeRangeSelection.create(ed.state.doc, from + 1, to - 1)),
  );
}

function pressMod(ed: Editor, key: string): boolean {
  const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    metaKey: mac,
    ctrlKey: !mac,
  });
  return !!ed.view.someProp("handleKeyDown", (handle) => handle(ed.view, event));
}

/** Make `execCommand("copy")` emit a copy event whose clipboard the writer can fill. */
function stubCopyCommand(): Record<string, string> {
  const stored: Record<string, string> = {};
  document.execCommand = ((command: string) => {
    if (command !== "copy") return originalExec?.call(document, command) ?? false;
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        setData(type: string, value: string) {
          stored[type] = value;
        },
        getData(type: string) {
          return stored[type] ?? "";
        },
        clearData() {
          for (const key of Object.keys(stored)) delete stored[key];
        },
      },
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  }) as typeof document.execCommand;
  return stored;
}

function pasteHtml(ed: Editor, html: string, text: string): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/html" ? html : type === "text/plain" ? text : ""),
      types: ["text/html", "text/plain"],
      files: [],
    },
  });
  ed.view.dom.dispatchEvent(event);
}

function blockIds(ed: Editor): string[] {
  const ids: string[] = [];
  ed.state.doc.forEach((node) => {
    if (typeof node.attrs.blockId === "string") ids.push(node.attrs.blockId);
  });
  return ids;
}

describe("[COMP:app-web/block-selection-clipboard] block area cut and copy", () => {
  it("is wired into the editor with Mod-c and Mod-x", () => {
    expect(browserDocExtensions().some((ext) => ext.name === "blockSelectionClipboard")).toBe(true);
    const shortcuts = BlockSelectionClipboard.config.addKeyboardShortcuts?.call(
      BlockSelectionClipboard as never,
    );
    expect(Object.keys(shortcuts ?? {})).toEqual(["Mod-c", "Mod-x"]);
  });

  it("leaves a text selection to the browser", () => {
    const ed = mount(PAGE);
    ed.commands.setTextSelection(2);
    let called = false;
    expect(copyBlockSelection(ed, true, () => {
      called = true;
      return true;
    })).toBe(false);
    expect(called).toBe(false);
    expect(ed.state.doc.textContent).toContain("Revenue Target");
  });

  it("does not cut a read-only page", () => {
    const ed = mount(PAGE, false);
    selectFirstTwo(ed);
    expect(copyBlockSelection(ed, true, () => true)).toBe(false);
    expect(ed.state.doc.textContent).toContain("Revenue Target");
    expect(ed.state.doc.textContent).toContain("150k");
  });

  it("does not delete the selection when the clipboard write fails", () => {
    const ed = mount(PAGE);
    selectFirstTwo(ed);
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    expect(copyBlockSelection(ed, true, () => false)).toBe(false);
    expect(ed.state.doc.textContent).toContain("Revenue Target");
    expect(ed.state.doc.textContent).toContain("150k");
  });

  it("cuts the selected blocks with Mod-x and pastes them after the surviving paragraph", () => {
    const ed = mount(PAGE);
    selectFirstTwo(ed);
    const stored = stubCopyCommand();
    expect(pressMod(ed, "x")).toBe(true);
    expect(ed.state.doc.textContent).toBe("Operations Target");
    expect(stored["text/html"]).toContain("data-pm-slice");
    expect(stored["text/plain"]).toContain("Revenue Target");
    expect(stored["text/plain"]).toContain("150k");

    ed.commands.focus("end");
    pasteHtml(ed, stored["text/html"]!, stored["text/plain"]!);
    const text = ed.state.doc.textContent;
    expect(text).toContain("Operations Target");
    expect(text).toContain("Revenue Target");
    expect(text).toContain("150k");
    expect(text.indexOf("Operations Target")).toBeLessThan(text.indexOf("Revenue Target"));
    const kinds: string[] = [];
    ed.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds[0]).toBe("paragraph");
    expect(kinds).toContain("heading");
    expect(kinds).toContain("table");
    expect(blockIds(ed)).toContain("revenue");
    expect(blockIds(ed)).toContain("targets");
  });

  it("copies without removing the blocks, and the paste gets fresh block ids", () => {
    const ed = mount(PAGE);
    selectFirstTwo(ed);
    let payload: BlockClipboardPayload | null = null;
    expect(copyBlockSelection(ed, false, (next) => {
      payload = next;
      return true;
    })).toBe(true);
    expect(ed.state.doc.textContent).toContain("Revenue Target");
    expect(payload!.html).toContain("data-pm-slice");
    expect(payload!.html).not.toContain("revenue");

    ed.commands.focus("end");
    pasteHtml(ed, payload!.html, payload!.text);
    const matches = ed.state.doc.textContent.match(/Revenue Target/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(blockIds(ed).filter((id) => id === "revenue")).toHaveLength(1);
    expect(blockIds(ed).filter((id) => id === "targets")).toHaveLength(1);
    const kinds: string[] = [];
    ed.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds.filter((kind) => kind === "table")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "heading")).toHaveLength(2);
  });

  it("clears a selection of every block and leaves one empty paragraph", () => {
    const ed = mount(PAGE);
    const size = ed.state.doc.content.size;
    ed.view.dispatch(
      ed.state.tr.setSelection(NodeRangeSelection.create(ed.state.doc, 1, size - 1)),
    );
    expect(copyBlockSelection(ed, true, () => true)).toBe(true);
    expect(ed.state.doc.childCount).toBe(1);
    expect(ed.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(ed.state.doc.textContent).toBe("");
  });

  it("writes the ProseMirror slice from a copy event", () => {
    const stored = stubCopyCommand();
    expect(writeBlockClipboard({ html: "<p data-pm-slice=\"0 0 []\">Revenue Target</p>", text: "Revenue Target" })).toBe(true);
    expect(stored["text/html"]).toContain("data-pm-slice");
    expect(stored["text/plain"]).toBe("Revenue Target");
  });
});
