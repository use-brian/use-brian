// @vitest-environment jsdom
/** [COMP:app-web/recording-chrome] Processing-status polling. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingSummary } from "@/lib/api/recordings";
import { resetSurfaceCache } from "@/lib/surface-cache";
import { useRecordingSummary } from "../use-recording-summary";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ getRecording: vi.fn() }));
vi.mock("@/lib/api/recordings", () => ({
  getRecording: (...args: unknown[]) => mocks.getRecording(...args),
}));

function summary(status: RecordingSummary["status"]): RecordingSummary {
  return {
    recordingId: "recording-1",
    title: "Recording",
    fileName: "recording.webm",
    kind: "meeting",
    status,
    mime: "audio/webm",
    durationMs: 60_000,
    bytes: 1_000,
    occurredAt: "2026-09-10T00:00:00.000Z",
    truncated: false,
    lastError: null,
    hasTranscript: status === "processed",
    transcriptFileId: status === "processed" ? "transcript-1" : null,
    participants: [],
  };
}

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useRecordingSummary>;

function Harness() {
  current = useRecordingSummary("workspace-1", "recording-1", {
    trackProcessing: true,
  });
  return null;
}

describe("[COMP:app-web/recording-chrome] processing tracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSurfaceCache();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetSurfaceCache();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("polls queued work until the server reports a terminal status", async () => {
    mocks.getRecording
      .mockResolvedValueOnce(summary("queued"))
      .mockResolvedValue(summary("processed"));

    await act(async () => root.render(<Harness />));
    expect(current.summary?.status).toBe("queued");

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.getRecording).toHaveBeenCalledTimes(2);
    expect(current.summary?.status).toBe("processed");

    // Processing polling (every 10s) has stopped. Only the content lease's
    // authority renewal (every 15s: at 15s and 30s) still reads; a hook still
    // polling would have made six calls by now.
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(mocks.getRecording).toHaveBeenCalledTimes(4);
    expect(current.summary?.status).toBe("processed");
  });

  it("retries a transient cold-read failure while tracking processing", async () => {
    mocks.getRecording
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(summary("processing"));

    await act(async () => root.render(<Harness />));
    expect(current.error).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.getRecording).toHaveBeenCalledTimes(2);
    expect(current.summary?.status).toBe("processing");
  });
});
