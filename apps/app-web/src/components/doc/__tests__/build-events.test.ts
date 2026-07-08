/**
 * [COMP:app-web/build-events] Inline generating-feed event log.
 *
 * The IO-free core that turns the SSE stream into the chronological
 * `BuildEvent[]` the inline "Generating…" widget rolls through. We assert the
 * ordering contract (reasoning coalesces into one advancing line until a step
 * closes it; steps interleave in arrival order) and the tail windowing.
 */

import { describe, expect, it } from "vitest";
import {
  appendReasoning,
  appendStep,
  EMPTY_LOG,
  lastNonEmptyLine,
  removeToolSteps,
  updateStepText,
  windowEvents,
  type EventLog,
} from "../../../lib/build-events";

/** Deterministic id minter for tests — mirrors the per-turn counter. */
function minter() {
  let n = 0;
  return () => `ev-${n++}`;
}

describe("[COMP:app-web/build-events] lastNonEmptyLine", () => {
  it("returns the last non-blank line of a multi-line run", () => {
    expect(lastNonEmptyLine("first\nsecond\nthird")).toBe("third");
  });

  it("skips trailing blank lines (still-streaming token boundary)", () => {
    expect(lastNonEmptyLine("planning the page\n\n")).toBe("planning the page");
  });

  it("trims surrounding whitespace", () => {
    expect(lastNonEmptyLine("  indented thought  ")).toBe("indented thought");
  });

  it("returns empty string for an all-blank run", () => {
    expect(lastNonEmptyLine("\n  \n")).toBe("");
  });
});

describe("[COMP:app-web/build-events] appendReasoning", () => {
  it("opens one reasoning event and advances its text in place", () => {
    const mint = minter();
    let log: EventLog = EMPTY_LOG;
    log = appendReasoning(log, "Thinking about", mint);
    log = appendReasoning(log, "Thinking about the structure", mint);
    expect(log.events).toEqual([
      { id: "ev-0", kind: "reasoning", text: "Thinking about the structure" },
    ]);
    expect(log.openReasoningId).toBe("ev-0");
  });

  it("advances to the latest line as the run grows", () => {
    const mint = minter();
    let log: EventLog = EMPTY_LOG;
    log = appendReasoning(log, "line one", mint);
    log = appendReasoning(log, "line one\nline two", mint);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]!.text).toBe("line two");
  });

  it("is a no-op for a blank run (no empty row)", () => {
    const log = appendReasoning(EMPTY_LOG, "  \n", minter());
    expect(log).toBe(EMPTY_LOG);
  });

  it("returns the same object when the trailing line is unchanged", () => {
    const mint = minter();
    const first = appendReasoning(EMPTY_LOG, "steady", mint);
    const second = appendReasoning(first, "steady", mint);
    expect(second).toBe(first);
  });
});

describe("[COMP:app-web/build-events] appendStep + interleaving", () => {
  it("appends a step and closes the open reasoning run", () => {
    const mint = minter();
    let log: EventLog = EMPTY_LOG;
    log = appendReasoning(log, "deciding the outline", mint);
    log = appendStep(log, 'Adding heading "Overview"', mint);
    expect(log.openReasoningId).toBeNull();
    expect(log.events.map((e) => e.kind)).toEqual(["reasoning", "step"]);
  });

  it("a reasoning burst after a step opens a fresh row (true stream order)", () => {
    const mint = minter();
    let log: EventLog = EMPTY_LOG;
    log = appendReasoning(log, "first thought", mint);
    log = appendStep(log, "Inserting a data table", mint);
    log = appendReasoning(log, "second thought", mint);
    expect(log.events).toEqual([
      { id: "ev-0", kind: "reasoning", text: "first thought" },
      { id: "ev-1", kind: "step", text: "Inserting a data table" },
      { id: "ev-2", kind: "reasoning", text: "second thought" },
    ]);
  });

  it("ignores a blank step line", () => {
    const log = appendStep(EMPTY_LOG, "   ", minter());
    expect(log).toBe(EMPTY_LOG);
  });
});

describe("[COMP:app-web/build-events] windowEvents", () => {
  const events = Array.from({ length: 6 }, (_, i) => ({
    id: `ev-${i}`,
    kind: "step" as const,
    text: `step ${i}`,
  }));

  it("returns the newest `max` events in render order (oldest first)", () => {
    expect(windowEvents(events, 3).map((e) => e.id)).toEqual([
      "ev-3",
      "ev-4",
      "ev-5",
    ]);
  });

  it("returns all events when fewer than the window", () => {
    expect(windowEvents(events.slice(0, 2), 5)).toHaveLength(2);
  });

  it("returns empty for a non-positive window or empty log", () => {
    expect(windowEvents(events, 0)).toEqual([]);
    expect(windowEvents([], 4)).toEqual([]);
  });
});

describe("[COMP:app-web/build-events] step metadata + retraction", () => {
  it("carries toolId/url metadata on step events", () => {
    const log = appendStep(EMPTY_LOG, "Reading example.com", minter(), {
      toolId: "t1",
      url: "https://example.com",
    });
    expect(log.events[0]).toMatchObject({
      kind: "step",
      toolId: "t1",
      url: "https://example.com",
    });
  });

  it("updateStepText rewrites the tool's latest step row in place", () => {
    const mint = minter();
    let log = appendStep(EMPTY_LOG, "Running webSearch", mint, { toolId: "t1" });
    log = updateStepText(log, "t1", 'Searching "middle mile"');
    expect(log.events).toHaveLength(1);
    expect(log.events[0]!.text).toBe('Searching "middle mile"');
  });

  it("updateStepText is a no-op for an unknown tool or unchanged text", () => {
    const mint = minter();
    const log = appendStep(EMPTY_LOG, "Running webSearch", mint, { toolId: "t1" });
    expect(updateStepText(log, "t2", "other")).toBe(log);
    expect(updateStepText(log, "t1", "Running webSearch")).toBe(log);
  });

  it("removeToolSteps retracts every row for a dropped tool, keeping reasoning", () => {
    const mint = minter();
    let log = appendReasoning(EMPTY_LOG, "planning", mint);
    log = appendStep(log, "Asking a question", mint, { toolId: "t1" });
    log = appendStep(log, "Follow-up line", mint, { toolId: "t1" });
    log = removeToolSteps(log, "t1");
    expect(log.events).toHaveLength(1);
    expect(log.events[0]!.kind).toBe("reasoning");
  });
});
