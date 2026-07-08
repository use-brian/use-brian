/**
 * Chip-input parsing helpers for the event trigger's `EventMatch`
 * editor. Component tag: [COMP:app-web/workflow] (ported from apps/web at the helper-copy deletion).
 *
 * Spec: docs/plans/company-brain/workflow-builder.md → Event trigger UI.
 */

import { describe, expect, it } from "vitest"
import {
  appendChip,
  MATCH_CAPS,
  parseChipInput,
  removeChipAt,
} from "../workflow-match"

describe("[COMP:app-web/workflow] match chip input", () => {
  it("splits comma + newline separated values", () => {
    const result = parseChipInput("alpha, beta\ngamma", "keywords")
    expect(result).toEqual(["alpha", "beta", "gamma"])
  })

  it("trims whitespace and drops empties", () => {
    expect(parseChipInput("  foo  ,, , bar  ", "keywords")).toEqual([
      "foo",
      "bar",
    ])
  })

  it("dedupes while preserving order", () => {
    expect(
      parseChipInput("alpha, beta, alpha, gamma, beta", "keywords"),
    ).toEqual(["alpha", "beta", "gamma"])
  })

  it("clamps to the field cap", () => {
    const many = Array.from(
      { length: MATCH_CAPS.keywords + 5 },
      (_, i) => `tag-${i}`,
    ).join(",")
    expect(parseChipInput(many, "keywords")).toHaveLength(MATCH_CAPS.keywords)
  })

  it("returns the same array reference on a no-op append", () => {
    const a = ["alpha"]
    expect(appendChip(a, "alpha", "keywords")).toBe(a) // duplicate
    expect(appendChip(a, "  ", "keywords")).toBe(a) // empty
  })

  it("rejects appends past the cap", () => {
    const full = Array.from({ length: MATCH_CAPS.keywords }, (_, i) => `k-${i}`)
    expect(appendChip(full, "extra", "keywords")).toBe(full)
  })

  it("removes by index", () => {
    expect(removeChipAt(["a", "b", "c"], 1)).toEqual(["a", "c"])
    expect(removeChipAt(["a", "b"], 5)).toEqual(["a", "b"])
  })
})
