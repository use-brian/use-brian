// @vitest-environment jsdom
/** [COMP:app-web/recording-chrome] canonical participant invalidation. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getRecording = vi.fn();
vi.mock("@/lib/api/recordings", () => ({
  getRecording: (...args: unknown[]) => getRecording(...args),
  updateRecordingParticipants: vi.fn(),
}));
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => <>{children}</> }));
vi.mock("@/lib/recordings/recording-player-context", () => ({
  useRecordingPlayer: () => ({ transcriptFocus: null, clearTranscriptFocus: vi.fn() }),
  RecordingVideoStage: () => <div />,
}));
vi.mock("../recording-player-bar", () => ({ RecordingPlayerBar: () => <div /> }));
vi.mock("../transcript-pane", () => ({ TranscriptPane: () => <div /> }));
vi.mock("../action-items-rail", () => ({ ActionItemsRail: () => <div /> }));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    recordings: {
      actionItemsTitle: "Action items",
      detailTranscript: "Transcript",
      chromeOpenRecording: "Open recording",
      citationCardClose: "Close",
      linkUnlink: "Unlink",
    },
  }),
}));

import { RecordingChrome } from "../recording-chrome";
import { dispatchRecordingParticipantsUpdated } from "@/lib/recordings/recording-events";

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
    getRecording.mockReset().mockResolvedValue(SUMMARY);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
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
