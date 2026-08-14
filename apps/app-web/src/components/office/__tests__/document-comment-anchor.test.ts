// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { TextSelection } from "@tiptap/pm/state";
import * as Y from "yjs";
import { applyOfficeUpdate, encodeOfficeState, getDocumentFragment, snapshotToYDoc } from "@use-brian/office-model";
import { documentFixture } from "./editor-fixtures";
import { officeDocumentEditorExtensions } from "../document/editor-schema";
import { captureDocumentCommentAnchor, resolveDocumentCommentAnchor } from "../document/comment-anchor";
import { updateDocumentReviewDecorations } from "../document/comment-decorations";
import { uid } from "./editor-fixtures";

describe("[COMP:app-web/office-comments] Document range anchors", () => {
  it("keeps a selected text range attached after a collaborator inserts before it", () => {
    const source = snapshotToYDoc(documentFixture());
    const peer = new Y.Doc(); applyOfficeUpdate(peer, encodeOfficeState(source));
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(source) })] });
    let start = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "paragraph" && node.textContent === "Body copy") start = pos + 1; });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start, start + 4)));
    const anchor = captureDocumentCommentAnchor(editor);
    expect(anchor).not.toBeNull();

    const section = getDocumentFragment(peer).get(0) as Y.XmlElement;
    const body = section.get(1) as Y.XmlElement;
    const paragraph = body.get(1) as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText;
    peer.transact(() => text.insert(0, "New "), "manual");
    applyOfficeUpdate(source, encodeOfficeState(peer));
    const resolved = resolveDocumentCommentAnchor(editor, anchor!);
    expect(resolved).not.toBeNull();
    expect(editor.state.doc.textBetween(resolved!.from, resolved!.to)).toBe("Body");
    editor.destroy(); source.destroy(); peer.destroy();
  });

  it("renders open comment and suggestion ranges in the document surface", () => {
    const source = snapshotToYDoc(documentFixture());
    const editor = new Editor({ extensions: [...officeDocumentEditorExtensions(), Collaboration.configure({ fragment: getDocumentFragment(source) })] });
    let start = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "paragraph" && node.attrs.id === uid(12)) start = pos + 1; });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start, start + 4)));
    const anchor = captureDocumentCommentAnchor(editor)!;
    updateDocumentReviewDecorations(editor, [{ id: uid(90), artifactVersionId: uid(91), anchorKind: "text_range", anchor, status: "open", messages: [] }], [{
      id: uid(92), artifactId: documentFixture().artifactId, baseVersionId: uid(91), proposedByType: "user", commandBatch: {
        commandId: uid(93), artifactId: documentFixture().artifactId, baseVersion: 1, actor: { type: "user", id: uid(94) }, origin: "manual", kind: "replaceTextRange", targetId: uid(12), from: 5, to: 9, preimageHash: "a".repeat(64), runs: [],
      }, affectedObjectIds: [uid(12)], status: "open", createdAt: "2026-08-13T00:00:00.000Z",
    }]);
    expect(editor.view.dom.querySelector(`[data-office-comment-id="${uid(90)}"]`)?.textContent).toBe("Body");
    expect(editor.view.dom.querySelector(`[data-office-suggestion-id="${uid(92)}"]`)?.textContent).toBe("copy");
    editor.destroy(); source.destroy();
  });
});
