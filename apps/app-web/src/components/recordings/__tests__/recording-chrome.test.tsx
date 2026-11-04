// @vitest-environment jsdom
/** [COMP:app-web/recording-chrome] canonical participant invalidation. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/recordings/confirm-and-process", () => ({ confirmAndProcessRecording: vi.fn() }));
const getRecording = vi.fn();
vi.mock("@/lib/api/recordings", () => ({
  getRecording: (...args: unknown[]) => getRecording(...args),
  updateRecordingParticipants: vi.fn(),
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/recordings/recording-player-context", () => ({
  useRecordingPlayer: () => ({ transcriptFocus: null, clearTranscriptFocus: vi.fn() }),
  RecordingVideoStage: () => <div data-testid="video-stage" />,
}));
vi.mock("../recording-player-bar", () => ({ RecordingPlayerBar: () => <div data-testid="player" /> }));
vi.mock("../transcript-pane", () => ({ TranscriptPane: () => <div data-testid="transcript" /> }));
vi.mock("../action-items-rail", () => ({ ActionItemsRail: () => <div data-testid="action-items" /> }));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    recordings: {
      actionItemsTitle: "Action items",
      processTranscribe: "Transcribe", processRetry: "Retry transcription",
      detailTranscript: "Transcript",
      chromeOpenRecording: "Open recording",
      citationCardClose: "Close",
      linkUnlink: "Unlink",
      statusAwaitingUploadTitle: "Recording attached",
      statusAwaitingUploadBody: "Processing has not started.",
      statusStagedTitle: "Ready to play",
      statusStagedBody: "The upload is complete. Add timestamps or ask Brian to transcribe it.",
      statusProcessingTitle: "Processing this recording",
      statusProcessingBody: "Transcription is in progress.",
      statusFailedTitle: "Processing failed",
      statusFailedBody: "Try processing again.",
    },
  }),
}));

import { RecordingChrome } from "../recording-chrome";
import { dispatchRecordingParticipantsUpdated } from "@/lib/recordings/recording-events";
import { resetSurfaceCache } from "@/lib/surface-cache";

const SUMMARY = {
  recordingId: "rec-1",
  title: "Meeting",
  fileName: "meeting.webm",
  kind: "meeting",
  status: "processed",
  mime: "audio/webm",
  durationMs: 10_000,
  bytes: 100,
  occurredAt: "2026-08-25T00:00:00.000Z",
  truncated: false,
  lastError: null,
  hasTranscript: true,
  transcriptFileId: "file-1",
  participants: [],
};

describe("[COMP:app-web/recording-chrome] participant refresh", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    resetSurfaceCache();
    getRecording.mockReset().mockResolvedValue(SUMMARY);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<RecordingChrome recordingId="rec-1" workspaceId="ws-1" title="Meeting" pageId="page-1" />);
    });
  }

  it.each(["awaiting_upload", "queued", "processing", "failed"])(
    "plays a stored video while status is %s without claiming a finished transcript",
    async (status) => {
      getRecording.mockResolvedValue({
        ...SUMMARY, status, mime: "video/webm", hasTranscript: false, transcriptFileId: null,
      });
      await mount();
      expect(container!.querySelector('[data-testid="video-stage"]')).not.toBeNull();
      expect(container!.querySelector('[data-testid="player"]')).not.toBeNull();
      expect(container!.querySelector('[data-testid="action-items"]')).toBeNull();
      expect(container!.querySelector('[data-testid="transcript"]')).toBeNull();
      const action = [...container!.querySelectorAll("button")].find(button => /^(Transcribe|Retry transcription)$/.test(button.textContent ?? ""));
      expect(Boolean(action)).toBe(status === "awaiting_upload" || status === "failed");
      if (status === "awaiting_upload") {
        expect(container!.textContent).toContain("The upload is complete.");
      }
    },
  );

  it.each(["processing", "processed"])("keeps the originating page on the %s recording link", async (status) => {
    getRecording.mockResolvedValue({ ...SUMMARY, status });
    await mount();
    expect(container!.querySelector("a")?.getAttribute("href")).toBe("/w/ws-1/recordings/rec-1?page=page-1");
  });

  it("does not show a player before the upload is proven", async () => {
    getRecording.mockResolvedValue({ ...SUMMARY, status: "awaiting_upload", durationMs: null });
    await mount();
    expect(container!.querySelector('[data-testid="player"]')).toBeNull();
    expect(container!.textContent).toContain("Processing has not started.");
  });

  it("preserves independent playback when the recording metadata read fails", async () => {
    getRecording.mockRejectedValue(new Error("Metadata unavailable"));
    await mount();
    expect(container!.querySelector('[data-testid="player"]')).not.toBeNull();
  });

  it("re-fetches only when Brian updated this mounted recording", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RecordingChrome
          recordingId="rec-1"
          workspaceId="ws-1"
          title="Meeting"
        />,
      );
    });
    expect(getRecording).toHaveBeenCalledTimes(1);

    await act(async () => {
      dispatchRecordingParticipantsUpdated({ recordingId: "rec-other" });
    });
    expect(getRecording).toHaveBeenCalledTimes(1);

    await act(async () => {
      dispatchRecordingParticipantsUpdated({ recordingId: "rec-1", pageId: "page-1" });
      await Promise.resolve();
    });
    expect(getRecording).toHaveBeenCalledTimes(2);
  });
});
