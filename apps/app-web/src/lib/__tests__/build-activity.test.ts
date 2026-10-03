/**
 * [COMP:app-web/build-activity] The live build-activity bus. The doc dock
 * publishes its in-flight turn (tool timeline, streaming text, reasoning,
 * event log); the inline Space-for-AI generating widget subscribes. A plain
 * module, unit-tested directly.
 */

import { describe, expect, it } from "vitest";
import {
  publishBuildActivity,
  subscribeBuildActivity,
  type BuildActivity,
} from "@/lib/build-activity";

describe("[COMP:app-web/build-activity] Activity bus", () => {
  it("delivers the latest value to a new subscriber, then live updates", () => {
    const seen: BuildActivity[] = [];
    publishBuildActivity({ isStreaming: true, tools: [], text: "hello", reasoning: "", events: [], error: null });
    const unsub = subscribeBuildActivity((a) => seen.push(a));
    // Immediate replay of the latest value.
    expect(seen.at(-1)).toEqual({ isStreaming: true, tools: [], text: "hello", reasoning: "", events: [], error: null });

    publishBuildActivity({
      isStreaming: true,
      tools: [{ id: "t1", name: "patchPage", status: "running", description: "Updating the page" }],
      text: "hello world",
      reasoning: "",
      events: [],
      error: null,
    });
    expect(seen.at(-1)?.tools[0]?.description).toBe("Updating the page");
    expect(seen.at(-1)?.text).toBe("hello world");

    unsub();
    publishBuildActivity({ isStreaming: false, tools: [], text: "", reasoning: "", events: [], error: null });
    // No further deliveries after unsubscribe.
    expect(seen.at(-1)?.text).toBe("hello world");
  });

  it("includes reasoning field in published activity", () => {
    const seen: BuildActivity[] = [];
    const unsub = subscribeBuildActivity((a) => seen.push(a));
    publishBuildActivity({ isStreaming: true, tools: [], text: "", reasoning: "Let me think about this…", events: [], error: null });
    expect(seen.at(-1)?.reasoning).toBe("Let me think about this…");
    unsub();
  });

  it("publishes per-op opLines for patchPage tool entries", () => {
    const seen: BuildActivity[] = [];
    const unsub = subscribeBuildActivity((a) => seen.push(a));
    publishBuildActivity({
      isStreaming: true,
      tools: [{
        id: "t2",
        name: "patchPage",
        status: "running",
        description: "Writing content",
        // ToolUsedWithOps shape — opLines is an optional extension
        ...(({ opLines: ["Adding heading \"Overview\"", "Writing a paragraph"] } as Record<string, unknown>)),
      }],
      text: "",
      reasoning: "",
      events: [],
      error: null,
    });
    const tool = seen.at(-1)?.tools[0] as (typeof seen[0]["tools"][0]) & { opLines?: string[] };
    expect(tool?.opLines).toEqual(["Adding heading \"Overview\"", "Writing a paragraph"]);
    unsub();
  });
});
