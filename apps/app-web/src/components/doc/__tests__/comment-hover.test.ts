/**
 * [COMP:app-web/comment-hover] Linked-hover toggle rule.
 *
 * vitest in app-web is node-only (no jsdom), so this pins the pure decision
 * — which tagged elements light up for a given hovered thread — rather than the
 * DOM event glue in `installCommentThreadHover`.
 */
import { describe, it, expect } from "vitest";
import { isThreadLit, THREAD_HOVER_CLASS } from "../comment-hover";

describe("[COMP:app-web/comment-hover] isThreadLit", () => {
  it("lights an element whose thread matches the hovered thread", () => {
    expect(isThreadLit("thr-1", "thr-1")).toBe(true);
  });

  it("does not light an element of a different thread", () => {
    expect(isThreadLit("thr-2", "thr-1")).toBe(false);
  });

  it("lights nothing when no thread is hovered", () => {
    // Mousing onto blank page clears the hover → every element goes dark,
    // including the one that was lit.
    expect(isThreadLit("thr-1", null)).toBe(false);
    expect(isThreadLit(null, null)).toBe(false);
  });

  it("never lights an untagged element even if a thread is hovered", () => {
    expect(isThreadLit(null, "thr-1")).toBe(false);
  });

  it("exposes the swatch class the controller toggles", () => {
    expect(THREAD_HOVER_CLASS).toBe("is-thread-hover");
  });
});
