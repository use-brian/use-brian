import { describe, it, expect } from "vitest";
import { docSchema } from "@use-brian/doc-model";
import {
  buildDecorations,
  findStaleCommentMarkRanges,
  resolvedMarkThreadIds,
  type DecorationThread,
} from "../comment-decorations";

// Two plain blocks, no comment marks — isolates the AI-anchor source (which
// comes from the threads list, not the doc).
function plainDoc() {
  const schema = docSchema();
  return schema.node("doc", null, [
    schema.node("paragraph", { blockId: "blk-ai" }, [schema.text("ai target")]),
    schema.node("paragraph", { blockId: "blk-other" }, [schema.text("other")]),
  ]);
}

// A block whose text carries a human `comment` mark — isolates the
// human-range source (painted from the doc, independent of the threads list).
function markedDoc() {
  const schema = docSchema();
  return schema.node("doc", null, [
    schema.node("paragraph", { blockId: "blk-h" }, [
      schema.text("hello", [schema.marks.comment.create({ threadId: "thr-h" })]),
    ]),
  ]);
}

// An atom `embed` (chart) + a plain paragraph. The embed has no inner text, so
// it can only be commented on via a WHOLE-block anchor (`human_block` /
// `ai_block`) — never a `comment` mark. Mirrors the real chart-comment case.
function embedDoc() {
  const schema = docSchema();
  return schema.node("doc", null, [
    schema.node("embed", {
      blockId: "blk-chart",
      block: JSON.stringify({ kind: "chart", id: "blk-chart" }),
    }),
    schema.node("paragraph", { blockId: "blk-other" }, [schema.text("other")]),
  ]);
}

// The `class` attr of every non-widget decoration in the set (widgets — the
// gutter badge — carry no `attrs.class`, so they drop out). Lets a test assert
// WHICH highlight kind was painted (inline text swatch vs whole-block tint),
// not just the count.
function highlightClasses(set: ReturnType<typeof buildDecorations>): string[] {
  return set
    .find()
    .map((d) => (d as unknown as { type?: { attrs?: { class?: string } } }).type?.attrs?.class)
    .filter((c): c is string => typeof c === "string");
}

// Count the gutter-badge WIDGET decorations — the speech-bubble icons. They're
// the decorations with no `attrs.class` (only inline/node highlights carry one),
// so they're exactly what `highlightClasses` drops.
function badgeWidgetCount(set: ReturnType<typeof buildDecorations>): number {
  return set.find().length - highlightClasses(set).length;
}

// One comment thread whose `comment` mark spans a HEADING and the paragraph
// below it — the user selected across both blocks, then commented. This is the
// "two icons for one comment" bug: each block carries a run of the same mark.
function threadSpanningTwoBlocksDoc() {
  const schema = docSchema();
  const mark = () => schema.marks.comment.create({ threadId: "thr-span" });
  return schema.node("doc", null, [
    schema.node("heading", { blockId: "blk-head", level: 2 }, [
      schema.text("Agent Profiles", [mark()]),
    ]),
    schema.node("paragraph", { blockId: "blk-para" }, [
      schema.text("Define the operational parameters", [mark()]),
    ]),
  ]);
}

// Two DISTINCT threads commenting on the SAME paragraph — the case where the
// badge count legitimately reads "2". Guards against a fix that over-dedupes.
function twoThreadsOneBlockDoc() {
  const schema = docSchema();
  return schema.node("doc", null, [
    schema.node("paragraph", { blockId: "blk-shared" }, [
      schema.text("first", [schema.marks.comment.create({ threadId: "thr-1" })]),
      schema.text(" plain "),
      schema.text("second", [schema.marks.comment.create({ threadId: "thr-2" })]),
    ]),
  ]);
}

describe("[COMP:app-web/comment-decorations] buildDecorations", () => {
  it("paints nothing for a doc with no marks and no AI threads", () => {
    expect(buildDecorations(plainDoc(), []).find().length).toBe(0);
  });

  it("paints an inline text highlight + one gutter badge for an AI block anchor on a text block", () => {
    // A block WITH text highlights the text itself (the same warm inline swatch
    // as a human range), NOT a full-width whole-block tint — see Image-#4 spec.
    const threads: DecorationThread[] = [
      { id: "thr-ai", anchorKind: "ai_block", anchorBlockId: "blk-ai" },
    ];
    const set = buildDecorations(plainDoc(), threads);
    expect(set.find().length).toBe(2); // inline highlight + badge widget
    expect(highlightClasses(set)).toEqual(["doc-comment-hl"]);
  });

  it("ignores an AI thread whose anchor block is gone (orphaned → no decoration)", () => {
    const threads: DecorationThread[] = [
      { id: "thr-x", anchorKind: "ai_block", anchorBlockId: "does-not-exist" },
    ];
    expect(buildDecorations(plainDoc(), threads).find().length).toBe(0);
  });

  it("keeps the whole-block tint + badge for a human_block anchor on a textless atom embed", () => {
    // A person commenting on a chart (no text to mark) anchors the whole block:
    // with no inline content to paint, it falls back to the whole-block tint.
    const threads: DecorationThread[] = [
      { id: "thr-hb", anchorKind: "human_block", anchorBlockId: "blk-chart" },
    ];
    const set = buildDecorations(embedDoc(), threads);
    expect(set.find().length).toBe(2); // block tint + badge widget
    expect(highlightClasses(set)).toEqual(["doc-comment-block-hl"]);
  });

  it("treats human_block like ai_block on a text block (inline text highlight + badge)", () => {
    const threads: DecorationThread[] = [
      { id: "thr-hb", anchorKind: "human_block", anchorBlockId: "blk-ai" },
    ];
    const set = buildDecorations(plainDoc(), threads);
    expect(set.find().length).toBe(2);
    expect(highlightClasses(set)).toEqual(["doc-comment-hl"]);
  });

  it("paints a human comment mark from the doc (inline highlight + badge) regardless of the threads list", () => {
    // The mark is self-describing; the threads list drives only AI anchors.
    expect(buildDecorations(markedDoc(), []).find().length).toBe(2);
  });

  it("mints ONE gutter badge for a thread whose mark spans two blocks", () => {
    // The reported bug: a comment selected across a heading + the paragraph
    // below painted a "1" badge next to EACH block. A single conversation must
    // get a single badge — attributed to the first block (doc order) — while
    // both blocks still get their inline highlight run.
    const set = buildDecorations(threadSpanningTwoBlocksDoc(), []);
    expect(highlightClasses(set)).toEqual(["doc-comment-hl", "doc-comment-hl"]);
    expect(badgeWidgetCount(set)).toBe(1);
  });

  it("aggregates two distinct threads on one block into a single badge", () => {
    // The badge is per-block (Notion-style): two separate conversations on one
    // paragraph paint two inline highlight runs but share ONE gutter badge whose
    // count is the distinct-thread total (2). The dedup is per-thread, so the
    // mark splitting into runs never inflates that count past the thread total.
    const set = buildDecorations(twoThreadsOneBlockDoc(), []);
    expect(highlightClasses(set)).toEqual(["doc-comment-hl", "doc-comment-hl"]);
    expect(badgeWidgetCount(set)).toBe(1);
  });

  it("paints a transient draft highlight (no badge) from the draft range", () => {
    // A draft is a single inline decoration over the range — no thread, so no
    // gutter badge. This is the not-yet-committed comment highlight that never
    // becomes a `comment` mark unless the user sends.
    const decos = buildDecorations(plainDoc(), [], { from: 1, to: 5 });
    expect(decos.find().length).toBe(1);
  });

  it("draws no draft decoration for an empty or inverted range", () => {
    expect(buildDecorations(plainDoc(), [], { from: 3, to: 3 }).find().length).toBe(0);
    expect(buildDecorations(plainDoc(), [], { from: 5, to: 2 }).find().length).toBe(0);
  });

  it("layers a draft highlight on top of existing thread decorations", () => {
    const threads: DecorationThread[] = [
      { id: "thr-ai", anchorKind: "ai_block", anchorBlockId: "blk-ai" },
    ];
    // 2 (block tint + badge) + 1 (draft) = 3.
    expect(buildDecorations(plainDoc(), threads, { from: 1, to: 4 }).find().length).toBe(3);
  });
});

// Two paragraphs, each carrying a `comment` mark for a different thread — built
// from one schema instance so the mark types match `findStaleCommentMarkRanges`.
function twoMarkedDoc() {
  const schema = docSchema();
  const doc = schema.node("doc", null, [
    schema.node("paragraph", { blockId: "blk-a" }, [
      schema.text("alpha", [schema.marks.comment.create({ threadId: "thr-stale" })]),
    ]),
    schema.node("paragraph", { blockId: "blk-b" }, [
      schema.text("beta", [schema.marks.comment.create({ threadId: "thr-live" })]),
    ]),
  ]);
  return { doc, markType: schema.marks.comment };
}

describe("[COMP:app-web/comment-decorations] findStaleCommentMarkRanges", () => {
  it("returns the range of each comment-mark run whose threadId is stale", () => {
    const { doc, markType } = twoMarkedDoc();
    const ranges = findStaleCommentMarkRanges(doc, new Set(["thr-stale"]), markType);
    // "alpha" sits at positions 1..6 (doc > paragraph > text); only it matches.
    expect(ranges).toEqual([{ from: 1, to: 6 }]);
  });

  it("returns nothing for an empty stale set (the common no-op load)", () => {
    const { doc, markType } = twoMarkedDoc();
    expect(findStaleCommentMarkRanges(doc, new Set(), markType)).toEqual([]);
  });

  it("ignores a stale id with no matching mark in the doc", () => {
    const { doc, markType } = twoMarkedDoc();
    expect(findStaleCommentMarkRanges(doc, new Set(["thr-ghost"]), markType)).toEqual([]);
  });

  it("collects every stale run while leaving live marks untouched", () => {
    const { doc, markType } = twoMarkedDoc();
    const ranges = findStaleCommentMarkRanges(
      doc,
      new Set(["thr-stale", "thr-live"]),
      markType,
    );
    expect(ranges).toHaveLength(2);
  });
});

describe("[COMP:app-web/comment-decorations] resolvedMarkThreadIds", () => {
  const T = "2026-06-11T00:00:00.000Z";

  it("selects a resolved human_range thread (it carries a stranded mark)", () => {
    const ids = resolvedMarkThreadIds([
      { id: "thr-r", anchorKind: "human_range", resolvedAt: T },
    ]);
    expect([...ids]).toEqual(["thr-r"]);
  });

  it("ignores an OPEN human_range thread (its highlight must stay)", () => {
    const ids = resolvedMarkThreadIds([
      { id: "thr-open", anchorKind: "human_range", resolvedAt: null },
    ]);
    expect(ids.size).toBe(0);
  });

  it("excludes resolved block-anchored threads (no mark to strip; tint is list-derived)", () => {
    // The whole point of the human_range gate: an ai_block / human_block tint
    // already vanishes when the thread leaves the open list, so sweeping it
    // would be dead work — and there is no `comment` mark to find anyway.
    const ids = resolvedMarkThreadIds([
      { id: "thr-ai", anchorKind: "ai_block", resolvedAt: T },
      { id: "thr-hb", anchorKind: "human_block", resolvedAt: T },
    ]);
    expect(ids.size).toBe(0);
  });

  it("returns only the resolved human_range ids from a mixed page", () => {
    const ids = resolvedMarkThreadIds([
      { id: "open-range", anchorKind: "human_range", resolvedAt: null },
      { id: "resolved-range", anchorKind: "human_range", resolvedAt: T },
      { id: "resolved-ai", anchorKind: "ai_block", resolvedAt: T },
    ]);
    expect([...ids]).toEqual(["resolved-range"]);
  });
});
