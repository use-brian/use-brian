/**
 * [COMP:app-web/comment-quote-anchor] Quote re-anchoring — the pure half of a
 * markless comment's (anchorBlockId, quote) anchor. Guest range comments from
 * the public page carry no `comment` mark, so both renderers find the quote in
 * the block text and paint exactly that run; a vanished quote falls back.
 */

import { describe, expect, it } from "vitest";
import {
  anchorThreadsInRichText,
  findQuoteRange,
  markQuoteRange,
  plainTextOf,
  richTextHasThreadMark,
  type QuoteTipNode,
} from "../comment-quote-anchor";

const text = (t: string, marks?: QuoteTipNode["marks"]): QuoteTipNode =>
  marks ? { type: "text", text: t, marks } : { type: "text", text: t };
const para = (...content: QuoteTipNode[]): QuoteTipNode => ({ type: "paragraph", content });

describe("[COMP:app-web/comment-quote-anchor] findQuoteRange", () => {
  it("finds an exact substring", () => {
    expect(findQuoteRange("The first claim. The second.", "second")).toEqual({ start: 21, end: 27 });
  });

  it("returns null for an empty / missing / absent quote", () => {
    expect(findQuoteRange("abc", null)).toBeNull();
    expect(findQuoteRange("abc", "")).toBeNull();
    expect(findQuoteRange("abc", "   ")).toBeNull();
    expect(findQuoteRange("abc", "zzz")).toBeNull();
    expect(findQuoteRange("", "abc")).toBeNull();
  });

  it("matches across whitespace differences (a DOM Range.toString vs JSON text) and maps back to original offsets", () => {
    // The rendered text had a line break the JSON spells as two spaces.
    const src = "alpha  beta\n\tgamma delta";
    const r = findQuoteRange(src, "beta gamma");
    expect(r).not.toBeNull();
    expect(src.slice(r!.start, r!.end)).toBe("beta\n\tgamma");
  });

  it("trims the quote before matching", () => {
    expect(findQuoteRange("hello world", "  world ")).toEqual({ start: 6, end: 11 });
  });
});

describe("[COMP:app-web/comment-quote-anchor] markQuoteRange", () => {
  it("splits a text node so only the in-range part carries the comment mark", () => {
    const out = markQuoteRange([para(text("alpha beta gamma"))], { start: 6, end: 10 }, "th");
    const p = out[0];
    expect(p.content?.map((n) => n.text)).toEqual(["alpha ", "beta", " gamma"]);
    expect(p.content?.[1].marks).toEqual([{ type: "comment", attrs: { threadId: "th" } }]);
    expect(p.content?.[0].marks).toBeUndefined();
    expect(p.content?.[2].marks).toBeUndefined();
  });

  it("keeps existing marks on the marked slice and spans several text nodes", () => {
    const bold = [{ type: "bold" }];
    const out = markQuoteRange(
      [para(text("ab"), text("cd", bold), text("ef"))],
      { start: 1, end: 5 }, // "bcde"
      "th",
    );
    const nodes = out[0].content!;
    expect(nodes.map((n) => n.text)).toEqual(["a", "b", "cd", "e", "f"]);
    expect(nodes[1].marks?.map((m) => m.type)).toEqual(["comment"]);
    expect(nodes[2].marks?.map((m) => m.type)).toEqual(["bold", "comment"]);
    expect(nodes[3].marks?.map((m) => m.type)).toEqual(["comment"]);
    expect(nodes[4].marks).toBeUndefined();
    // Text is preserved exactly.
    expect(plainTextOf(out)).toBe("abcdef");
  });

  it("walks nested containers (a list item's paragraph) with document-order offsets", () => {
    const li: QuoteTipNode = { type: "listItem", content: [para(text("one ")), para(text("two"))] };
    const out = markQuoteRange([li], { start: 4, end: 7 }, "th");
    const second = out[0].content![1];
    expect(second.content![0]).toEqual({
      type: "text",
      text: "two",
      marks: [{ type: "comment", attrs: { threadId: "th" } }],
    });
    // First paragraph untouched (shared by reference is fine; content equal).
    expect(out[0].content![0].content![0].marks).toBeUndefined();
  });

  it("returns the input unchanged for an empty range", () => {
    const src = [para(text("x"))];
    expect(markQuoteRange(src, { start: 2, end: 2 }, "th")).toEqual(src);
  });
});

describe("[COMP:app-web/comment-quote-anchor] richTextHasThreadMark", () => {
  it("detects a comment mark for the thread anywhere in the tree, and not another thread's", () => {
    const nodes = [para(text("a"), text("b", [{ type: "comment", attrs: { threadId: "t1" } }]))];
    expect(richTextHasThreadMark(nodes, "t1")).toBe(true);
    expect(richTextHasThreadMark(nodes, "t2")).toBe(false);
    expect(richTextHasThreadMark(undefined, "t1")).toBe(false);
  });
});

describe("[COMP:app-web/comment-quote-anchor] anchorThreadsInRichText", () => {
  it("injects a mark for a markless thread whose quote is found, and reports the rest as unplaced", () => {
    const { nodes, unplaced } = anchorThreadsInRichText([para(text("alpha beta gamma"))], [
      { threadId: "found", quote: "beta" },
      { threadId: "gone", quote: "omega" },
      { threadId: "noquote", quote: null },
    ]);
    expect(richTextHasThreadMark(nodes, "found")).toBe(true);
    expect(unplaced.map((a) => a.threadId)).toEqual(["gone", "noquote"]);
  });

  it("leaves a thread whose mark is already present alone (no second anchor)", () => {
    const src = [para(text("pre "), text("marked", [{ type: "comment", attrs: { threadId: "t" } }]))];
    const { nodes, unplaced } = anchorThreadsInRichText(src, [{ threadId: "t", quote: "pre" }]);
    expect(unplaced).toEqual([]);
    // "pre " is still unmarked — the existing mark anchors the thread.
    expect(nodes[0].content![0].marks).toBeUndefined();
  });

  it("places two threads on one block at their own quotes", () => {
    const { nodes } = anchorThreadsInRichText([para(text("alpha beta gamma"))], [
      { threadId: "a", quote: "alpha" },
      { threadId: "g", quote: "gamma" },
    ]);
    const runs = nodes[0].content!;
    expect(runs.map((n) => [n.text, n.marks?.[0]?.attrs?.threadId])).toEqual([
      ["alpha", "a"],
      [" beta ", undefined],
      ["gamma", "g"],
    ]);
  });

  it("returns the nodes untouched with no anchors", () => {
    const src = [para(text("x"))];
    expect(anchorThreadsInRichText(src, [])).toEqual({ nodes: src, unplaced: [] });
  });
});
