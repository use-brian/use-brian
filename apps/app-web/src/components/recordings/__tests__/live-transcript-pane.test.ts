import { describe, expect, it } from "vitest";
import { adoptLinkedRecording, isPinnedToEnd, mergeLiveWindows } from "../live-transcript-pane";
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

/**
 * Follow-the-tail is decided from scroll GEOMETRY on every scroll, whatever
 * produced it: the old `onWheel` hook covered a mouse and nothing else, so a
 * phone reader who dragged up to re-read was yanked back to the tail on the
 * next window (every few seconds during a capture).
 */
describe("[COMP:app-web/live-transcript-pane] isPinnedToEnd", () => {
  it("is pinned at the very end and within the threshold of it", () => {
    expect(isPinnedToEnd({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 })).toBe(true);
    expect(isPinnedToEnd({ scrollHeight: 1000, scrollTop: 661, clientHeight: 300 })).toBe(true);
  });

  it("un-pins once the reader has scrolled up past the threshold (touch, wheel or keyboard alike)", () => {
    expect(isPinnedToEnd({ scrollHeight: 1000, scrollTop: 660, clientHeight: 300 })).toBe(false);
    expect(isPinnedToEnd({ scrollHeight: 1000, scrollTop: 0, clientHeight: 300 })).toBe(false);
  });

  it("treats a box that does not scroll yet as pinned, so the first windows follow", () => {
    expect(isPinnedToEnd({ scrollHeight: 200, scrollTop: 0, clientHeight: 300 })).toBe(true);
  });

  it("honours a custom threshold", () => {
    expect(isPinnedToEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 300 }, 120)).toBe(true);
    expect(isPinnedToEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 300 }, 100)).toBe(false);
  });
});

describe("[COMP:app-web/live-transcript-pane] adoptLinkedRecording", () => {
  const page = { id: "page-1", linkedRecordingId: null as string | null };

  it("switches an open page to a recording linked after it loaded", () => {
    expect(adoptLinkedRecording(page, "page-1", "rec-1")).toEqual({ id: "page-1", linkedRecordingId: "rec-1" });
  });

  it("leaves other pages, missing views and existing links untouched", () => {
    expect(adoptLinkedRecording(page, "page-2", "rec-1")).toBe(page);
    expect(adoptLinkedRecording(null, "page-1", "rec-1")).toBeNull();
    const linked = { id: "page-1", linkedRecordingId: "rec-0" };
    expect(adoptLinkedRecording(linked, "page-1", "rec-1")).toBe(linked);
  });
});
