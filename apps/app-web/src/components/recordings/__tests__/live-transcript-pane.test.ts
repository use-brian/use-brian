import { describe, expect, it } from "vitest";
import { mergeLiveWindows } from "../live-transcript-pane";
import type { LiveTranscriptWindowRow } from "@/lib/api/recordings";

function win(chunkId: string, offsetMs: number, text = "hi"): LiveTranscriptWindowRow {
  return {
    chunkId,
    offsetMs,
    durationMs: 30_000,
    missedBefore: 0,
    lines: [{ speaker: null, text }],
  };
}

describe("[COMP:app-web/live-transcript-pane] mergeLiveWindows", () => {
  it("dedupes by chunkId and keeps capture order", () => {
    const merged = mergeLiveWindows(
      [win("a", 0), win("c", 60_000)],
      [win("b", 30_000), win("a", 0, "replaced")],
    );
    expect(merged.map((w) => w.chunkId)).toEqual(["a", "b", "c"]);
    // A poll row for a chunk the event already delivered wins (server truth).
    expect(merged[0].lines[0].text).toBe("replaced");
  });

  it("is stable when either side is empty", () => {
    expect(mergeLiveWindows([], [win("a", 0)])).toHaveLength(1);
    expect(mergeLiveWindows([win("a", 0)], [])).toHaveLength(1);
  });
});
