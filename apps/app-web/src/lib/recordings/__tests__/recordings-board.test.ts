/**
 * [COMP:app-web/recordings-board] — the recordings panel's pure logic.
 *
 * app-web's vitest is node-only (no component-render harness), so the panel
 * stays thin over these and the behaviours that matter are asserted here.
 */

import { describe, expect, it } from "vitest";
import type { RecordingSummary } from "@/lib/api/recordings";
import {
  dayBucket,
  formatBytes,
  formatDuration,
  groupByDay,
  hasInFlight,
  isInFlight,
  isOpenable,
  matchesStatusFilter,
  recordingTitle,
  statusFilterToQuery,
} from "../recordings-board";

function rec(over: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    recordingId: "r-1",
    title: null,
    fileName: "call.m4a",
    kind: "meeting",
    status: "processed",
    mime: "audio/mp4",
    durationMs: 5_735_000,
    bytes: 48_000_000,
    occurredAt: "2026-07-17T09:00:00.000Z",
    truncated: false,
    lastError: null,
    hasTranscript: true,
    transcriptFileId: "f-1",
    participants: [],
    ...over,
  };
}

describe("[COMP:app-web/recordings-board] isOpenable", () => {
  it("opens only a processed recording", () => {
    // The detail page IS a player plus a transcript, and both are empty until
    // processing finishes — routing there early looks like a broken page.
    expect(isOpenable(rec({ status: "processed" }))).toBe(true);
    for (const status of ["awaiting_upload", "queued", "processing", "failed"] as const) {
      expect(isOpenable(rec({ status })), status).toBe(false);
    }
  });
});

describe("[COMP:app-web/recordings-board] polling", () => {
  it("treats queued and processing as in flight, nothing else", () => {
    expect(isInFlight(rec({ status: "queued" }))).toBe(true);
    expect(isInFlight(rec({ status: "processing" }))).toBe(true);
    expect(isInFlight(rec({ status: "processed" }))).toBe(false);
    expect(isInFlight(rec({ status: "failed" }))).toBe(false);
  });

  it("polls while any row is moving and stops when none is", () => {
    // A worker transcribes in the background, so a queued row becomes openable
    // with no user action. An idle board must not be a heartbeat.
    expect(hasInFlight([rec({ status: "processed" }), rec({ status: "queued" })])).toBe(true);
    expect(hasInFlight([rec({ status: "processed" }), rec({ status: "failed" })])).toBe(false);
    expect(hasInFlight([])).toBe(false);
  });
});

describe("[COMP:app-web/recordings-board] formatDuration", () => {
  it("drops the hour segment for a short memo", () => {
    // NOT formatStamp: that renders a CITATION (always H:MM:SS so it parses
    // back). "0:01:30" for a 90-second memo in a list reads as a bug.
    expect(formatDuration(90_000)).toBe("1:30");
    expect(formatDuration(5_000)).toBe("0:05");
  });

  it("keeps hours for a long meeting", () => {
    expect(formatDuration(5_735_000)).toBe("1:35:35");
  });

  it("renders nothing when the duration is unknown", () => {
    // A recording that never got probed must show no chip, not "0:00".
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
  });
});

describe("[COMP:app-web/recordings-board] formatBytes", () => {
  it("scales the unit to the size", () => {
    expect(formatBytes(48_000_000)).toBe("48 MB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(2_400_000_000)).toBe("2.4 GB");
  });

  it("renders nothing when the size is unknown", () => {
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(0)).toBe("");
  });
});

describe("[COMP:app-web/recordings-board] recordingTitle", () => {
  it("prefers the title, then the file name, then the fallback", () => {
    expect(recordingTitle(rec({ title: "Q3 pricing" }), "Untitled")).toBe("Q3 pricing");
    expect(recordingTitle(rec({ title: null, fileName: "call.m4a" }), "Untitled")).toBe("call.m4a");
    expect(recordingTitle(rec({ title: null, fileName: null }), "Untitled")).toBe("Untitled");
  });

  it("treats a whitespace-only title as absent", () => {
    expect(recordingTitle(rec({ title: "   ", fileName: "call.m4a" }), "Untitled")).toBe("call.m4a");
  });
});

describe("[COMP:app-web/recordings-board] dayBucket", () => {
  const now = new Date(2026, 6, 17, 14, 0, 0); // local 2026-07-17 14:00

  it("buckets by the viewer's local day, not by elapsed hours", () => {
    // 23:30 last night is YESTERDAY even though it is under 24h ago — "today"
    // means the viewer's calendar day, which is what they are asking.
    expect(dayBucket(new Date(2026, 6, 16, 23, 30).toISOString(), now)).toBe("yesterday");
    expect(dayBucket(new Date(2026, 6, 17, 0, 5).toISOString(), now)).toBe("today");
  });

  it("buckets anything older as earlier", () => {
    expect(dayBucket(new Date(2026, 6, 15, 12, 0).toISOString(), now)).toBe("earlier");
  });

  it("buckets a future timestamp as today rather than dropping the row", () => {
    // Clock skew must not make a recording invisible.
    expect(dayBucket(new Date(2026, 6, 18, 9, 0).toISOString(), now)).toBe("today");
  });

  it("survives an unparseable timestamp", () => {
    expect(dayBucket("not-a-date", now)).toBe("earlier");
  });
});

describe("[COMP:app-web/recordings-board] groupByDay", () => {
  const now = new Date(2026, 6, 17, 14, 0, 0);
  const today = rec({ recordingId: "a", occurredAt: new Date(2026, 6, 17, 9).toISOString() });
  const yesterday = rec({ recordingId: "b", occurredAt: new Date(2026, 6, 16, 9).toISOString() });
  const older = rec({ recordingId: "c", occurredAt: new Date(2026, 6, 1, 9).toISOString() });

  it("orders buckets newest-first and drops empty ones", () => {
    expect(groupByDay([today, older], now).map((g) => g.bucket)).toEqual(["today", "earlier"]);
    expect(groupByDay([yesterday], now).map((g) => g.bucket)).toEqual(["yesterday"]);
    expect(groupByDay([], now)).toEqual([]);
  });

  it("preserves the server's order within a bucket", () => {
    // The route sorts; this only partitions. Re-sorting would be a second
    // opinion that could disagree with the order rows were paged in.
    const first = rec({ recordingId: "x", occurredAt: new Date(2026, 6, 17, 8).toISOString() });
    const second = rec({ recordingId: "y", occurredAt: new Date(2026, 6, 17, 11).toISOString() });
    const group = groupByDay([first, second], now)[0];
    expect(group.recordings.map((r) => r.recordingId)).toEqual(["x", "y"]);
  });

  it("keeps every row across buckets", () => {
    const all = groupByDay([today, yesterday, older], now).flatMap((g) => g.recordings);
    expect(all).toHaveLength(3);
  });
});

describe("[COMP:app-web/recordings-board] status filter", () => {
  it("sends a server-side status only when the route can express it", () => {
    expect(statusFilterToQuery("all")).toBeUndefined();
    expect(statusFilterToQuery("processed")).toBe("processed");
    expect(statusFilterToQuery("failed")).toBe("failed");
    // "In progress" means queued OR processing; the route takes one status, so
    // it narrows client-side instead of sending half the answer.
    expect(statusFilterToQuery("processing")).toBeUndefined();
  });

  it("narrows in-progress to queued AND processing client-side", () => {
    expect(matchesStatusFilter(rec({ status: "queued" }), "processing")).toBe(true);
    expect(matchesStatusFilter(rec({ status: "processing" }), "processing")).toBe(true);
    expect(matchesStatusFilter(rec({ status: "processed" }), "processing")).toBe(false);
  });

  it("matches everything under the all filter", () => {
    for (const status of ["awaiting_upload", "queued", "processed", "failed"] as const) {
      expect(matchesStatusFilter(rec({ status }), "all"), status).toBe(true);
    }
  });

  it("matches exactly for the terminal filters", () => {
    expect(matchesStatusFilter(rec({ status: "processed" }), "processed")).toBe(true);
    expect(matchesStatusFilter(rec({ status: "failed" }), "processed")).toBe(false);
    expect(matchesStatusFilter(rec({ status: "failed" }), "failed")).toBe(true);
  });
});
