// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { getDocumentFragment, snapshotToYDoc, yDocToSnapshot } from "@use-brian/office-model";
import { officeDocumentEditorExtensions } from "../document/editor-schema";
import { findDocumentText, replaceDocumentText } from "../document/editor-actions";
import { documentFixture } from "./editor-fixtures";
import * as Y from "yjs";

function typeText(editor: Editor, text: string) {
  const { from, to } = editor.state.selection;
  const handled = editor.view.someProp("handleTextInput", handler => handler(editor.view, from, to, text, () => editor.state.tr.insertText(text, from, to)));
  if (!handled) editor.view.dispatch(editor.state.tr.insertText(text, from, to));
}
function peerSnapshot(doc: Y.Doc) {
  const peer = new Y.Doc();
  try { Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc)); return yDocToSnapshot(peer); }
  finally { peer.destroy(); }
}

function setup() {
  const snapshot = documentFixture();
  const table = snapshot.sections[0].nodes.find(node => node.kind === "table");
  if (table?.kind !== "table") throw new Error("table required");
  const cell = table.rows[0].cells[0];
  const doc = snapshotToYDoc(snapshot);
  const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
  let start = 0;
  editor.state.doc.descendants((node, position) => { if (node.type.name === "officeTableCellText" && node.attrs.id === cell.id) start = position + 1; });
  return { snapshot, cell, doc, editor, start };
}

describe("[COMP:app-web/office-document-editor] canonical run preservation", () => {
  it.each(["start", "middle", "end"] as const)("keeps inserted text canonical after native Enter at the cell %s", boundary => {
    const { editor, doc, cell, start } = setup();
    try {
      editor.commands.setTextSelection(start + (boundary === "end" ? cell.runs[0].text.length : boundary === "middle" ? 2 : 0));
      editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      typeText(editor, "Typed");
      expect(() => yDocToSnapshot(doc)).not.toThrow();
      const result = yDocToSnapshot(doc);
      const edited = result.family === "document" ? result.sections[0].nodes.find(node => node.kind === "table") : undefined;
      expect(edited?.kind === "table" && edited.rows[0].cells[0].runs.every(run => run.style.fontFamily === cell.runs[0].style.fontFamily)).toBe(true);
      if (edited?.kind !== "table") throw new Error("table required");
      const runs = edited.rows[0].cells[0].runs;
      expect(new Set(runs.map(run => run.id)).size).toBe(runs.length);
      expect(runs.find(run => run.text.includes("Typed"))?.id).not.toBe(cell.runs[0].id);
      expect(peerSnapshot(doc)).toEqual(result);
    } finally { editor.destroy(); doc.destroy(); }
  });

  it.each(["selection", "find", "replace"] as const)("retains cell typography after clearing via %s and typing", mode => {
    const { editor, doc, cell, start } = setup();
    try {
      if (mode === "selection") {
        editor.commands.setTextSelection({ from: start, to: start + cell.runs[0].text.length });
        editor.commands.deleteSelection();
      } else {
        if (mode === "find") findDocumentText(editor, "Cell", 1);
        expect(replaceDocumentText(editor, "Cell", "", true)).toBe(1);
        editor.commands.setTextSelection(start);
      }
      typeText(editor, "New");
      expect(() => yDocToSnapshot(doc)).not.toThrow();
      const result = yDocToSnapshot(doc);
      const edited = result.family === "document" ? result.sections[0].nodes.find(node => node.kind === "table") : undefined;
      expect(edited?.kind === "table" && edited.rows[0].cells[0].runs[0].style).toEqual(cell.runs[0].style);
      expect(edited?.kind === "table" && edited.rows[0].cells[0].runs[0].id).not.toBe(cell.runs[0].id);
      expect(peerSnapshot(doc)).toEqual(result);
    } finally { editor.destroy(); doc.destroy(); }
  });

  it.each(["Replacement", "Venue A /\nVenue B"])("persists replacement or pasted full-cell text (%s)", value => {
    const { editor, doc, cell, start } = setup();
    try {
      if (value === "Replacement") expect(replaceDocumentText(editor, "Cell", value, true)).toBe(1);
      else {
        replaceDocumentText(editor, "Cell", "", true);
        editor.commands.setTextSelection(start);
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? value : "", types: ["text/plain"], files: [] } });
        editor.view.dom.dispatchEvent(paste);
      }
      const result = peerSnapshot(doc);
      const table = result.family === "document" ? result.sections[0].nodes.find(node => node.kind === "table") : undefined;
      expect(table?.kind === "table" && table.rows[0].cells[0].runs.map(run => run.text).join("")).toBe(value);
      expect(table?.kind === "table" && table.rows[0].cells[0].runs[0].style).toEqual(cell.runs[0].style);
    } finally { editor.destroy(); doc.destroy(); }
  });

  it.each(["Pasted replacement", "First line\nSecond line"])("keeps direct plain-text paste in its selected cell (%s)", value => {
    const { editor, doc, cell, start } = setup();
    try {
      editor.commands.setTextSelection({ from: start, to: start + cell.runs[0].text.length });
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? value : "", types: ["text/plain"], files: [] } });
      editor.view.dom.dispatchEvent(paste);
      const result = peerSnapshot(doc);
      const table = result.family === "document" ? result.sections[0].nodes.find(node => node.kind === "table") : undefined;
      expect(table?.kind === "table" && table.rows[0].cells[0].runs.map(run => run.text).join("")).toBe(value);
      expect(table?.kind === "table" && table.rows[0].cells[0].runs[0].style).toEqual(cell.runs[0].style);
    } finally { editor.destroy(); doc.destroy(); }
  });

  it("keeps HTML clipboard text in its selected cell with destination typography", () => {
    const { editor, doc, cell, start } = setup();
    try {
      editor.commands.setTextSelection({ from: start, to: start + cell.runs[0].text.length });
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      const html = '<p data-office-table-cell-text="true"><span data-office-run="true" style="font-family:Times New Roman;font-size:24pt">500</span></p>';
      Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? "500" : type === "text/html" ? html : "", types: ["text/plain", "text/html"], files: [] } });
      editor.view.dom.dispatchEvent(paste);
      const result = peerSnapshot(doc);
      const table = result.family === "document" ? result.sections[0].nodes.find(node => node.kind === "table") : undefined;
      expect(table?.kind === "table" && table.rows[0].cells[0].runs.map(run => run.text).join("")).toBe("500");
      expect(table?.kind === "table" && table.rows[0].cells[0].runs[0].style).toEqual(cell.runs[0].style);
    } finally { editor.destroy(); doc.destroy(); }
  });

  it("persists DOM composition input into an emptied cell with its original typography", async () => {
    const { editor, doc, cell, start } = setup();
    // jsdom has no range geometry; input and DOM parsing remain real.
    editor.view.setProps({ handleScrollToSelection: () => true });
    document.body.appendChild(editor.view.dom);
    try {
      replaceDocumentText(editor, "Cell", "", true);
      editor.commands.setTextSelection(start);
      const paragraph = editor.view.dom.querySelector("td p")!;
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      paragraph.textContent = "入力";
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 2); range.collapse(true);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      editor.view.dom.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "入力", isComposing: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "入力" }));
      await new Promise(resolve => setTimeout(resolve, 25));
      const result = peerSnapshot(doc);
      const table = result.family === "document" ? result.sections[0].nodes.find(node => node.kind === "table") : undefined;
      expect(table?.kind === "table" && table.rows[0].cells[0].runs.map(run => run.text).join("")).toBe("入力");
      expect(table?.kind === "table" && table.rows[0].cells[0].runs[0].style).toEqual(cell.runs[0].style);
    } finally { editor.view.dom.remove(); editor.destroy(); doc.destroy(); }
  });

  it("leaves unmarked remote text rejected by the strict persistence decoder", () => {
    const { editor, doc, cell } = setup();
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      let paragraph: Y.XmlElement | undefined;
      const find = (node: Y.XmlFragment | Y.XmlElement) => node.toArray().forEach(child => {
        if (!(child instanceof Y.XmlElement)) return;
        if (child.nodeName === "officeTableCellText" && child.getAttribute("id") === cell.id) paragraph = child;
        find(child);
      });
      find(getDocumentFragment(peer));
      if (!paragraph) throw new Error("cell paragraph required");
      peer.transact(() => {
        paragraph!.delete(0, paragraph!.length);
        const text = new Y.XmlText(); text.insert(0, "Unmarked remote input");
        paragraph!.insert(0, [text]);
      });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
      expect(() => yDocToSnapshot(doc)).toThrow("exactly one officeRun mark");
    } finally { editor.destroy(); peer.destroy(); doc.destroy(); }
  });
});
