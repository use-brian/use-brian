// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { documentFixture } from "./editor-fixtures";
import { DocumentEditor } from "../document-editor";
import { snapshotToYDoc, yDocToSnapshot } from "@use-brian/office-model";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { getDocumentFragment } from "@use-brian/office-model";
import { officeDocumentEditorExtensions } from "../document/editor-schema";
import { toggleDocumentRunStyle } from "../document-editor";
import { TextSelection } from "@tiptap/pm/state";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("[COMP:app-web/office-document-editor] Document editor interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let doc: Y.Doc;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    doc = snapshotToYDoc(documentFixture());
  });

  afterEach(() => {
    act(() => root.unmount());
    doc.destroy();
    container.remove();
  });

  function mount(role: "view" | "comment" | "edit" = "edit", suggestMode = false) {
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><DocumentEditor snapshot={documentFixture()} baseVersion={1} role={role} suggestMode={suggestMode} doc={doc} synced onCommand={vi.fn()} /></I18nProvider>));
  }

  function editorElement(): HTMLElement {
    const element = container.querySelector<HTMLElement>(".ProseMirror");
    if (!element) throw new Error("structured editor required");
    return element;
  }

  it("mutates the shared fragment directly and never emits updateText while typing", () => {
    mount();
    const editor = editorElement();
    expect(editor.textContent).toContain("Mixed format");

    act(() => {
      editor.focus();
      document.execCommand?.("insertText", false, "X");
      editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "X" }));
    });

    expect(container.querySelector("textarea[data-office-text-input]")).toBeNull();
    expect(container.querySelector('[data-office-structured-editor="true"]')).not.toBeNull();
    expect(doc.getMap("commands").size).toBe(0);
  });

  it("formats only the selected ProseMirror range through the fragment", () => {
    const tiptap = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(doc) })] });
    let from = -1;
    tiptap.state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph" && node.attrs.id?.endsWith("000012")) { from = position + 1; return false; }
      return true;
    });
    expect(from).toBeGreaterThan(0);
    tiptap.view.dispatch(tiptap.state.tr.setSelection(TextSelection.create(tiptap.state.doc, from, from + 4)));
    toggleDocumentRunStyle(tiptap, "bold");

    const snapshot = yDocToSnapshot(doc);
    if (snapshot.family !== "document") throw new Error("document required");
    const paragraph = snapshot.sections[0].nodes.find((node) => node.kind === "paragraph" && node.id.endsWith("000012"));
    expect(paragraph?.kind === "paragraph" && paragraph.runs.some((run) => run.style.bold)).toBe(true);
    expect(paragraph?.kind === "paragraph" && paragraph.runs.map((run) => [run.text, run.style.bold])).toEqual([["Body", true], [" copy", false]]);
    tiptap.destroy();
  });

  it("keeps Viewer and Commenter-Suggesting content read-only", () => {
    mount("comment", true);
    expect(editorElement().getAttribute("contenteditable")).toBe("false");
    expect(container.querySelector(`button[aria-label="${en.office.bold}"]`)?.hasAttribute("disabled")).toBe(true);
  });

  it("keeps composition and structured paste on the ProseMirror input path", () => {
    mount();
    const editor = editorElement();
    const before = doc.getMap("commands").size;
    act(() => {
      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      editor.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "入力" }));
      editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "入力" }));
      const paste = new Event("paste", { bubbles: true }) as Event & { clipboardData: { getData(type: string): string; types: string[]; files: FileList } };
      Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? "Pasted\r\ntext" : "", types: ["text/plain"], files: [] } });
      editor.dispatchEvent(paste);
    });
    expect(doc.getMap("commands").size).toBe(before);
    expect(container.querySelector("textarea")).toBeNull();
  });
});
