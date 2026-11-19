import { describe, expect, it } from "vitest";
import {
  buildEntryPreamble,
  partitionToolChips,
  TOOL_CHIP_COLLAPSE_THRESHOLD,
} from "../entry-thread";
import type { ToolUsed } from "@use-brian/chat-ui";

// The tool timeline (dedup start, done/retried result, dropped removal) is the
// shared turn transcript's since M5 WP-E: `reduceToolEvent` was deleted and its
// cases run through the controller in entry-thread-presentation.test.tsx.

describe("[COMP:app-web/brain-entry-thread] entry thread preamble", () => {
  it("carries the entry summary and ends ready for the user's question", () => {
    const p = buildEntryPreamble("Ship the beta", null);
    expect(p).toContain("Summary: Ship the beta");
    expect(p).toContain("[Entry review context]");
    expect(p.endsWith("[User asks]\n")).toBe(true);
  });

  it("includes the detail line only when a detail exists", () => {
    expect(buildEntryPreamble("S", "Body text")).toContain("Detail: Body text");
    expect(buildEntryPreamble("S", null)).not.toContain("Detail:");
    expect(buildEntryPreamble("S", "")).not.toContain("Detail:");
  });

  it("pins the read-only contract so the model never offers to edit", () => {
    const p = buildEntryPreamble("S", null);
    expect(p).toContain("read-only");
    expect(p).toContain("The user edits directly on the page");
  });

  it("primes timestamps, folding Last updated when equal to Created", () => {
    const both = buildEntryPreamble("S", null, {
      createdAt: "2026-07-13T07:58:52Z",
      updatedAt: "2026-07-14T10:00:00Z",
    });
    expect(both).toContain("Created: 2026-07-13T07:58:52Z");
    expect(both).toContain("Last updated: 2026-07-14T10:00:00Z");
    const same = buildEntryPreamble("S", null, {
      createdAt: "2026-07-13T07:58:52Z",
      updatedAt: "2026-07-13T07:58:52Z",
    });
    expect(same).toContain("Created: 2026-07-13T07:58:52Z");
    expect(same).not.toContain("Last updated");
  });

  it("primes the origin clue when known, asserts none-recorded on null, stays silent when unfetched", () => {
    const known = buildEntryPreamble("S", null, {
      originLine: "Extracted from a Slack conversation on 7/13/2026",
    });
    expect(known).toContain(
      "Source (already shown on the page): Extracted from a Slack conversation",
    );

    const none = buildEntryPreamble("S", null, { originLine: null });
    expect(none).toContain("Source: none recorded");
    expect(none).toContain("say that plainly instead of searching");

    const unfetched = buildEntryPreamble("S", null, {
      createdAt: "2026-07-13T07:58:52Z",
    });
    expect(unfetched).not.toContain("Source");
  });
});

describe("[COMP:app-web/brain-entry-thread] tool chip fold", () => {
  const mk = (n: number, running: number): ToolUsed[] =>
    Array.from({ length: n }, (_, i): ToolUsed => ({
      id: `t${i}`,
      name: "search",
      status: i < n - running ? "done" : "running",
    }));

  it("renders every chip at or under the threshold", () => {
    const tools = mk(TOOL_CHIP_COLLAPSE_THRESHOLD, 1);
    expect(
      partitionToolChips(tools, { streaming: true, expanded: false }),
    ).toEqual({ visible: tools, foldedCount: 0 });
  });

  it("folds finished tools while streaming but keeps running ones visible", () => {
    const tools = mk(16, 2);
    const { visible, foldedCount } = partitionToolChips(tools, {
      streaming: true,
      expanded: false,
    });
    expect(visible).toHaveLength(2);
    expect(visible.every((t) => t.status === "running")).toBe(true);
    expect(foldedCount).toBe(14);
  });

  it("folds everything once the turn settles", () => {
    const tools = mk(16, 0);
    expect(
      partitionToolChips(tools, { streaming: false, expanded: false }),
    ).toEqual({ visible: [], foldedCount: 16 });
  });

  it("expanded shows the full list with a stable folded count", () => {
    const tools = mk(16, 0);
    const { visible, foldedCount } = partitionToolChips(tools, {
      streaming: false,
      expanded: true,
    });
    expect(visible).toHaveLength(16);
    expect(foldedCount).toBe(16);
  });
});
