// @vitest-environment jsdom
/** [COMP:app-web/recording-detail] navigation and lifecycle through the shared chrome. */
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { dispatchRecordingParticipantsUpdated } from "@/lib/recordings/recording-events";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { recordingDetailCacheKey } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const getRecording = vi.fn();
const updateRecordingParticipants = vi.fn();
const promptDialog = vi.fn();
let recordingId = "rec-1";
let search = "";
vi.mock("@/lib/api/recordings", () => ({
  getRecording: (...args: unknown[]) => getRecording(...args),
  updateRecordingParticipants: (...args: unknown[]) => updateRecordingParticipants(...args),
}));
vi.mock("@/components/ui/prompt-dialog", () => ({
  promptDialog: (...args: unknown[]) => promptDialog(...args),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "ws-1", recordingId }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/lib/recordings/recording-player-context", () => ({
  RecordingPlayerProvider: ({ children, recordingId }: { children: React.ReactNode; recordingId: string | null }) => (
    <div data-player-recording={recordingId}>{children}</div>
  ),
  useRecordingPlayer: () => ({ seekTo: vi.fn(), recordingId: "rec-1", transcriptFocus: null }),
  RecordingVideoStage: () => <div data-testid="video-stage" />,
}));
vi.mock("@/components/recordings/recording-player-bar", () => ({
  RecordingPlayerBar: () => <div data-testid="player" />,
}));
vi.mock("@/components/recordings/transcript-pane", () => ({
  TranscriptPane: ({ participants, onRenameSpeaker }: {
    participants: { speaker: string; name?: string }[];
    onRenameSpeaker: (speaker: string) => void;
  }) => <div data-testid="transcript">
    {participants.map((p) => <span key={p.speaker}>{p.name ?? p.speaker}</span>)}
    <button onClick={() => onRenameSpeaker("Speaker 1")}>Rename speaker</button>
  </div>,
}));
vi.mock("@/components/recordings/action-items-rail", () => ({
  ActionItemsRail: () => <div data-testid="actions" />,
}));
vi.mock("@/components/context/reclassify-context-dialog", () => ({
  ReclassifyContextButton: () => <div data-testid="context-scope" />,
}));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));

import RecordingDetailPage from "../page";
const REC = {
  recordingId: "rec-1", title: "Team call", fileName: "call.m4a",
  status: "processed", durationMs: 51_252, truncated: false, lastError: null,
  participants: [{ speaker: "Speaker 1", name: "Alex Example" }],
};
let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => root.render(<RecordingDetailPage />));
}
async function poll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetSurfaceCache();
  getRecording.mockReset().mockResolvedValue(REC);
  recordingId = "rec-1";
  search = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("[COMP:app-web/recording-detail] recording detail route", () => {
  it("keeps a warmed recording painted while a stale revalidation is pending", async () => {
    const key = recordingDetailCacheKey("ws-1", "rec-1");
    await loadSurfaceCache(key, async () => REC);
    markSurfaceCacheStale(key);
    getRecording.mockReturnValue(new Promise(() => {}));

    await render();

    expect(container.querySelector("h1")?.textContent).toBe("Team call");
    expect(container.querySelector('[data-testid="player"]')).toBeTruthy();
    expect(container.textContent).not.toContain(en.recordings.panelLoading);
    expect(getRecording).toHaveBeenCalledTimes(1);
  });

  it("opens the transcript and participant names without a self-link", async () => {
    await render();
    expect(container.querySelector('[data-testid="player"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="actions"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="transcript"]')).toBeTruthy();
    expect(container.textContent).toContain("Alex Example");
    expect(container.textContent).not.toContain(en.recordings.chromeOpenRecording);
    await poll();
    expect(getRecording).toHaveBeenCalledTimes(1);
  });

  it("links to the recordings board and originating workspace page", async () => {
    search = "page=page-1";
    await render();
    expect(container.querySelector(`a[href="/w/ws-1/p?panel=recordings"]`)).toBeTruthy();
    expect(container.querySelector(`a[href="/w/ws-1/p/page-1"]`)?.textContent).toBe(en.common.back);
  });

  it("keeps an ingest-only recording accessible by its filename", async () => {
    getRecording.mockResolvedValue({ ...REC, title: null });
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("call.m4a");
    expect(container.querySelector('[data-testid="transcript"]')).toBeTruthy();
  });

  it("keeps navigation available for a missing recording", async () => {
    getRecording.mockRejectedValue(new Error("404"));
    await render();
    expect(container.textContent).toContain(en.recordings.detailNotFound);
    expect(container.querySelector('[data-testid="player"]')).toBeFalsy();
    expect(container.querySelector('a[href="/w/ws-1/p?panel=recordings"]')).toBeTruthy();
  });

  it.each(["queued", "processing"])("refreshes %s into a complete view without empty final sections", async (status) => {
    getRecording.mockResolvedValueOnce({ ...REC, status });
    await render();
    expect(container.textContent).toContain(en.recordings.statusProcessingTitle);
    expect(container.querySelector('[data-testid="player"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="actions"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="transcript"]')).toBeFalsy();
    await poll();
    expect(container.querySelector('[data-testid="actions"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="transcript"]')).toBeTruthy();
    await poll();
    // Processing polling stopped after the complete view; the third read is the
    // content lease's 15-second authority renewal, not another status poll.
    expect(getRecording).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-testid="transcript"]')).toBeTruthy();
  });

  it("waits for uploaded media before offering playback", async () => {
    getRecording.mockResolvedValueOnce({ ...REC, status: "awaiting_upload", durationMs: null });
    await render();
    expect(container.querySelector('[data-testid="player"]')).toBeFalsy();
    expect(container.querySelector('[data-player-recording]')).toBeFalsy();
    await poll();
    expect(container.querySelector('[data-player-recording="rec-1"]')).toBeTruthy();
  });

  it("retains processing state and retries after a transient poll error", async () => {
    getRecording.mockResolvedValueOnce({ ...REC, status: "processing" }).mockRejectedValueOnce(new Error("offline"));
    await render();
    await poll();
    expect(container.textContent).toContain(en.recordings.statusProcessingTitle);
    expect(container.querySelector('[data-testid="transcript"]')).toBeFalsy();
    await poll();
    expect(container.querySelector('[data-testid="transcript"]')).toBeTruthy();
  });

  it("shows failure details while preserving playable audio", async () => {
    getRecording.mockResolvedValue({ ...REC, status: "failed", lastError: "Provider unavailable" });
    await render();
    expect(container.textContent).toContain("Provider unavailable");
    expect(container.querySelector('[data-testid="player"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="actions"]')).toBeFalsy();
  });

  it("preserves the partial-transcript warning", async () => {
    getRecording.mockResolvedValue({ ...REC, truncated: true });
    await render();
    expect(container.textContent).toContain(en.recordings.detailTruncated);
  });

  it("renames speakers through the canonical write and re-reads participant metadata", async () => {
    await render();
    promptDialog.mockResolvedValue("Taylor Example");
    updateRecordingParticipants.mockResolvedValue(undefined);
    getRecording.mockResolvedValue({ ...REC, participants: [{ speaker: "Speaker 1", name: "Taylor Example" }] });
    await act(async () => { (container.querySelector('[data-testid="transcript"] button') as HTMLButtonElement).click(); });
    expect(updateRecordingParticipants).toHaveBeenCalledWith("rec-1", [{ speaker: "Speaker 1", name: "Taylor Example" }]);
    expect(container.textContent).toContain("Taylor Example");
  });

  it("refreshes participant names after Brian's assignment event", async () => {
    await render();
    getRecording.mockResolvedValue({ ...REC, participants: [{ speaker: "Speaker 1", name: "Taylor Example" }] });
    await act(async () => dispatchRecordingParticipantsUpdated({ recordingId: "rec-1" }));
    expect(container.textContent).toContain("Taylor Example");
  });

  it("ignores late responses when switching recordings", async () => {
    let resolveFirst!: (value: typeof REC) => void;
    getRecording.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    await render();
    recordingId = "rec-2";
    getRecording.mockResolvedValue({ ...REC, recordingId, title: "Second call" });
    await render();
    await act(async () => resolveFirst(REC));
    expect(container.querySelector("h1")?.textContent).toBe("Second call");
  });

  it("clears a previous missing state on navigation", async () => {
    getRecording.mockRejectedValueOnce(new Error("404"));
    await render();
    recordingId = "rec-2";
    await render();
    expect(container.textContent).not.toContain(en.recordings.detailNotFound);
    expect(container.querySelector('[data-testid="transcript"]')).toBeTruthy();
  });
});
