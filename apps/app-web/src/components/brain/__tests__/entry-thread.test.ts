import { describe, expect, it } from "vitest";
import { buildEntryPreamble, reduceToolEvent } from "../entry-thread";
import type { ToolUsed } from "@sidanclaw/chat-ui";

describe("[COMP:app-web/brain-entry-thread] tool timeline reducer", () => {
  const running: ToolUsed[] = [{ id: "t1", name: "searchKnowledge", status: "running" }];

  it("adds a tool once on tool_start and dedups re-emits", () => {
    const next = reduceToolEvent([], "tool_start", { id: "t1", name: "searchKnowledge" });
    expect(next).toEqual(running);
    expect(reduceToolEvent(running, "tool_start", { id: "t1", name: "searchKnowledge" })).toBeNull();
  });

  it("marks done or retried on tool_result", () => {
    expect(reduceToolEvent(running, "tool_result", { id: "t1" })).toEqual([
      { id: "t1", name: "searchKnowledge", status: "done" },
    ]);
    expect(reduceToolEvent(running, "tool_result", { id: "t1", isError: true })).toEqual([
      { id: "t1", name: "searchKnowledge", status: "retried" },
    ]);
  });

  it("removes a retracted tool on tool_dropped", () => {
    expect(reduceToolEvent(running, "tool_dropped", { id: "t1" })).toEqual([]);
  });

  it("ignores unknown events, missing ids, and unknown tool ids", () => {
    expect(reduceToolEvent(running, "text_delta", { id: "t1" })).toBeNull();
    expect(reduceToolEvent(running, "tool_start", { name: "x" })).toBeNull();
    expect(reduceToolEvent(running, "tool_result", { id: "nope" })).toBeNull();
    expect(reduceToolEvent(running, "tool_dropped", { id: "nope" })).toBeNull();
  });
});

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
});
