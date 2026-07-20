/**
 * [COMP:app-web/timecode-decoration] Clickable `[H:MM:SS]` citations.
 *
 * app-web's vitest is node-only, so this exercises the pure `findTimecodes`
 * scan against a real ProseMirror doc built from the shared
 * `@use-brian/doc-model` schema (matching `ai-generating-decoration.test.ts`);
 * the click interception is an e2e concern.
 *
 * The contract that matters: a citation is TEXT the model wrote, found by the
 * SAME parser that wrote it, and an impossible stamp is left alone.
 */

import { describe, expect, it } from "vitest";
import { docSchema } from "@use-brian/doc-model";
import { findTimecodes } from "../timecode-decoration";

const schema = docSchema();

function docOf(...paragraphs: string[]) {
  return schema.node(
    "doc",
    null,
    paragraphs.map((text, i) =>
      schema.node("paragraph", { blockId: `blk-${i}` }, text ? [schema.text(text)] : []),
    ),
  );
}

describe("[COMP:app-web/timecode-decoration] findTimecodes", () => {
  it("finds a citation mid-sentence — how the model actually writes them", () => {
    const hits = findTimecodes(docOf("They pushed back on pricing [0:47:21] before the demo."));
    expect(hits).toHaveLength(1);
    expect(hits[0].ms).toBe(2_841_000);
    expect(hits[0].text).toBe("[0:47:21]");
  });

  it("finds every citation in a bullet-heavy brief", () => {
    const hits = findTimecodes(
      docOf("Decision at [0:12:00].", "Another at [1:12:04].", "And [0:00:00] at the start."),
    );
    expect(hits.map((h) => h.ms)).toEqual([720_000, 4_324_000, 0]);
  });

  it("accepts the MM:SS short form", () => {
    expect(findTimecodes(docOf("around [47:21]"))[0].ms).toBe(2_841_000);
  });

  it("IGNORES an impossible stamp instead of seeking to a moment that never existed", () => {
    // `[00:85]` is not 85 seconds — it is the model inventing a citation. The
    // synthesis prompt warns about exactly this; linking it would take the user
    // somewhere that does not exist.
    expect(findTimecodes(docOf("bogus [00:85] here"))).toHaveLength(0);
    expect(findTimecodes(docOf("also [0:99:00]"))).toHaveLength(0);
  });

  it("ignores prose that merely looks bracketed", () => {
    expect(findTimecodes(docOf("[not a stamp] and [TODO]"))).toHaveLength(0);
  });

  it("returns positions that select exactly the citation text", () => {
    const d = docOf("pricing [0:47:21] done");
    const [hit] = findTimecodes(d);
    // The decoration must wrap the stamp and nothing else — an off-by-one here
    // would swallow a neighbouring character into the link.
    expect(d.textBetween(hit.from, hit.to)).toBe("[0:47:21]");
  });

  it("handles several citations in ONE paragraph without drifting", () => {
    const d = docOf("Ship in Q3 [0:47:21]. Defer billing [1:12:04].");
    const hits = findTimecodes(d);
    expect(hits).toHaveLength(2);
    for (const h of hits) expect(d.textBetween(h.from, h.to)).toBe(h.text);
  });

  it("finds citations beside CJK text (the motivating content)", () => {
    const d = docOf("我哋傾咗個價錢 [0:47:21] 之後再講。");
    const [hit] = findTimecodes(d);
    expect(hit.ms).toBe(2_841_000);
    expect(d.textBetween(hit.from, hit.to)).toBe("[0:47:21]");
  });

  it("is empty for a doc with no citations, and for an empty doc", () => {
    expect(findTimecodes(docOf("no stamps at all"))).toHaveLength(0);
    expect(findTimecodes(docOf(""))).toHaveLength(0);
  });

  it("does not leak regex lastIndex between scans", () => {
    // The scanner is a module-level global regex; a stale lastIndex would make
    // the second call silently miss the first citation.
    const d = docOf("first [0:00:10]");
    expect(findTimecodes(d)).toHaveLength(1);
    expect(findTimecodes(d)).toHaveLength(1);
  });
});
