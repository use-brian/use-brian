/**
 * [COMP:app-web/doc-placeholder] Empty-line placeholder text resolver.
 *
 * app-web's vitest is node-only, so we exercise the pure
 * `placeholderTextFor` mapping rather than the Tiptap decoration plugin
 * (that's an e2e concern). The contract: the AI hint shows on empty
 * paragraphs, a quieter cue on empty headings, nothing elsewhere.
 */

import { describe, expect, it } from "vitest";
import { docSchema } from "@use-brian/doc-model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { placeholderTextFor, emptyToggleSummaryRanges } from "../doc-placeholder";

const TEXT = {
  aiHint: "Press 'space' for AI or '/' for commands",
  heading: "Heading",
};

const schema = docSchema();
const toggle = (...children: PMNode[]): PMNode =>
  schema.nodes.toggle.create({ open: true }, children);
const para = (text?: string): PMNode =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);

describe("[COMP:app-web/doc-placeholder] placeholderTextFor", () => {
  it("shows the AI hint on an empty paragraph", () => {
    expect(placeholderTextFor("paragraph", TEXT)).toBe(TEXT.aiHint);
  });

  it("shows the heading cue on an empty heading", () => {
    expect(placeholderTextFor("heading", TEXT)).toBe(TEXT.heading);
  });

  it("shows nothing on lists / quotes / callouts / code", () => {
    for (const type of ["bulletList", "listItem", "blockquote", "callout", "codeBlock", "toggle"]) {
      expect(placeholderTextFor(type, TEXT)).toBe("");
    }
  });
});

describe("[COMP:app-web/doc-placeholder] emptyToggleSummaryRanges", () => {
  it("flags an empty toggle summary line", () => {
    const doc = schema.nodes.doc.create(null, [toggle(para())]);
    expect(emptyToggleSummaryRanges(doc)).toHaveLength(1);
  });

  it("ignores a toggle summary that has text", () => {
    const doc = schema.nodes.doc.create(null, [toggle(para("hi"))]);
    expect(emptyToggleSummaryRanges(doc)).toEqual([]);
  });

  it("ignores empty paragraphs outside a toggle", () => {
    const doc = schema.nodes.doc.create(null, [para(), para("x")]);
    expect(emptyToggleSummaryRanges(doc)).toEqual([]);
  });

  it("ignores an empty body line that is not the summary (first child)", () => {
    const doc = schema.nodes.doc.create(null, [toggle(para("title"), para())]);
    expect(emptyToggleSummaryRanges(doc)).toEqual([]);
  });

  it("flags only the empty text summary in a nested toggle (not the wrapping toggle)", () => {
    // Outer summary is a nested toggle (no empty text line of its own); only
    // the inner toggle's empty paragraph summary is flagged.
    const doc = schema.nodes.doc.create(null, [toggle(toggle(para()))]);
    expect(emptyToggleSummaryRanges(doc)).toHaveLength(1);
  });
});
