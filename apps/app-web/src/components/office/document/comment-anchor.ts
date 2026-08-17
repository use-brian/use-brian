/** Yjs-relative Document selection anchors and visual resolution. [COMP:app-web/office-comments] */
import type { Editor } from "@tiptap/react";
import type { OfficeRichTextRun } from "@use-brian/office-model";
import * as Y from "yjs";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";

export type DocumentCommentAnchor = {
  kind: "text_range";
  targetIds: string[];
  range: { from: number; to: number };
  relative: { from: Record<string, unknown>; to: Record<string, unknown> };
};

export type DocumentSuggestionRange = {
  targetId: string;
  from: number;
  to: number;
  text: string;
  style: OfficeRichTextRun["style"];
  href?: string;
};

const DEFAULT_STYLE: OfficeRichTextRun["style"] = {
  fontFamily: "Arial",
  fontSizePt: 11,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: "#111111",
};

function stableTarget(editor: Editor): string | null {
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const id = $from.node(depth).attrs.id;
    if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) return id;
  }
  return null;
}

function stableTextTarget(editor: Editor, position: "from" | "to"): { id: string; start: number } | null {
  const resolved = position === "from" ? editor.state.selection.$from : editor.state.selection.$to;
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const id = resolved.node(depth).attrs.id;
    if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) && resolved.node(depth).isTextblock) {
      return { id, start: resolved.start(depth) };
    }
  }
  return null;
}

export function captureDocumentSuggestionRange(editor: Editor): DocumentSuggestionRange | null {
  const { from, to } = editor.state.selection;
  const startTarget = stableTextTarget(editor, "from");
  const endTarget = stableTextTarget(editor, "to");
  if (from === to || !startTarget || !endTarget || startTarget.id !== endTarget.id) return null;
  const officeRun = editor.state.selection.$from.marks().find((mark) => mark.type.name === "officeRun");
  const style = officeRun?.attrs.style;
  const href = officeRun?.attrs.href;
  return {
    targetId: startTarget.id,
    from: from - startTarget.start,
    to: to - startTarget.start,
    text: editor.state.doc.textBetween(from, to),
    style: style && typeof style === "object" ? style as OfficeRichTextRun["style"] : DEFAULT_STYLE,
    ...(typeof href === "string" ? { href } : {}),
  };
}

export function captureDocumentCommentAnchor(editor: Editor): DocumentCommentAnchor | null {
  const { from, to } = editor.state.selection;
  const targetId = stableTarget(editor);
  const yState = ySyncPluginKey.getState(editor.state);
  if (!targetId || from === to || !yState) return null;
  const relativeFrom = absolutePositionToRelativePosition(from, yState.type, yState.binding.mapping);
  const relativeTo = absolutePositionToRelativePosition(to, yState.type, yState.binding.mapping);
  return {
    kind: "text_range",
    targetIds: [targetId],
    range: { from, to },
    relative: { from: Y.relativePositionToJSON(relativeFrom), to: Y.relativePositionToJSON(relativeTo) },
  };
}

export function resolveDocumentCommentAnchor(editor: Editor, anchor: { range?: { from: number; to: number }; relative?: { from: Record<string, unknown>; to: Record<string, unknown> } }): { from: number; to: number } | null {
  const yState = ySyncPluginKey.getState(editor.state);
  if (yState && anchor.relative) {
    const from = relativePositionToAbsolutePosition(yState.doc, yState.type, Y.createRelativePositionFromJSON(anchor.relative.from), yState.binding.mapping);
    const to = relativePositionToAbsolutePosition(yState.doc, yState.type, Y.createRelativePositionFromJSON(anchor.relative.to), yState.binding.mapping);
    if (from != null && to != null && from <= to) return { from, to };
  }
  if (anchor.range && anchor.range.from <= anchor.range.to && anchor.range.to <= editor.state.doc.content.size) return anchor.range;
  return null;
}
