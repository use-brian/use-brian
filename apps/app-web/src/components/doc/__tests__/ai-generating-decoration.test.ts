/**
 * [COMP:app-web/ai-generating-decoration] In-flow "Generating…" widget.
 *
 * app-web's vitest is node-only, so we exercise the pure `anchorWidgetPos`
 * placement (the widget DOM + the meta-toggled plugin are an e2e concern). The
 * contract: the widget sits just after the matching top-level block, and no
 * position resolves for a missing/cleared anchor. Docs built via the shared
 * `@sidanclaw/doc-model` schema, matching `comment-decorations.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { docSchema } from "@sidanclaw/doc-model";
import { anchorWidgetPos } from "../ai-generating-decoration";

const schema = docSchema();

function doc() {
  return schema.node("doc", null, [
    schema.node("paragraph", { blockId: "blk-a" }, [schema.text("first")]),
    schema.node("paragraph", { blockId: "blk-b" }, [schema.text("second")]),
  ]);
}

describe("[COMP:app-web/ai-generating-decoration] anchorWidgetPos", () => {
  it("returns null for a null anchor (indicator off)", () => {
    expect(anchorWidgetPos(doc(), null)).toBeNull();
  });

  it("returns null when the anchor block is gone (mid-churn / cleared)", () => {
    expect(anchorWidgetPos(doc(), "does-not-exist")).toBeNull();
  });

  it("places the widget just after the matching block", () => {
    const d = doc();
    // First paragraph spans positions 0..7 ("first" = 5 chars + 2 boundary
    // tokens), so the position right after it is its end offset.
    const firstEnd = d.child(0).nodeSize;
    expect(anchorWidgetPos(d, "blk-a")).toBe(firstEnd);
  });

  it("anchors to the correct block when several are present", () => {
    const d = doc();
    const expected = d.child(0).nodeSize + d.child(1).nodeSize;
    expect(anchorWidgetPos(d, "blk-b")).toBe(expected);
  });
});
