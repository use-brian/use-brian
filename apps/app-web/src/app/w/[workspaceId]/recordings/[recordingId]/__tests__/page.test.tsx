// @vitest-environment jsdom
/**
 * [COMP:app-web/recording-detail] — the standalone recording route.
 *
 * It is a thin composition of the chrome's tested parts, so what is worth
 * asserting here is the composition itself: that it is NOT a second
 * implementation of the player (two copies would drift), that it survives a
 * recording that does not exist, and that it still shows the transcript and
 * action items for a recording with no brief page — which is the only reason
 * this route exists at all, since synthesis is opt-in on `blueprintSlug`.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getRecording = vi.fn();
vi.mock("@/lib/api/recordings", () => ({
  getRecording: (...a: unknown[]) => getRecording(...a),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "ws-1", recordingId: "rec-1" }),
}));

vi.mock("@/lib/recordings/recording-player-context", () => ({
  RecordingPlayerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useRecordingPlayer: () => ({ seekTo: vi.fn(), recordingId: "rec-1" }),
}));

// The shared pieces are asserted by [COMP:app-web/recording-chrome]; here we
// only care that the route mounts THOSE rather than its own copies.
vi.mock("@/components/recordings/recording-player-bar", () => ({
  RecordingPlayerBar: () => <div data-testid="player" />,
}));
vi.mock("@/components/recordings/transcript-pane", () => ({
  TranscriptPane: () => <div data-testid="transcript" />,
}));
vi.mock("@/components/recordings/action-items-rail", () => ({
  ActionItemsRail: () => <div data-testid="actions" />,
}));
vi.mock("@/components/recordings/recording-chrome", () => ({
  HashSeek: () => null,
}));

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    recordings: {
      detailBack: "Back",
      detailNotFound: "That recording does not exist, or you do not have access to it.",
      detailTranscript: "Transcript",
      detailTruncated: "Only part of this recording could be transcribed.",
      detailStatusQueued: "Queued for transcription",
      detailStatusProcessing: "Transcribing...",
      detailStatusFailed: "Transcription failed",
      actionItemsTitle: "Action items",
    },
  }),
}));

import RecordingDetailPage from "../page";

const REC = {
  recordingId: "rec-1",
  title: "Client call",
  fileName: "call.m4a",
  status: "processed" as const,
  durationMs: 51_252,
  truncated: false,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<RecordingDetailPage />));
}

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/recording-detail] recording detail route", () => {
  it("composes the SHARED player, action items and transcript", async () => {
    getRecording.mockResolvedValue(REC);
    await mount();
    // A second implementation of any of these would drift from the brief
    // page's chrome — that is why they are mocked module-level here.
    expect(container?.querySelector('[data-testid="player"]')).toBeTruthy();
    expect(container?.querySelector('[data-testid="actions"]')).toBeTruthy();
    expect(container?.querySelector('[data-testid="transcript"]')).toBeTruthy();
  });

  it("renders the transcript + action items for a recording with NO brief", async () => {
    // The whole reason the route exists: an ingest-only upload (no
    // `blueprintSlug`) produces no doc page, so this is its only home.
    getRecording.mockResolvedValue({ ...REC, title: null });
    await mount();
    expect(container?.querySelector('[data-testid="transcript"]')).toBeTruthy();
    expect(container?.textContent).toContain("Action items");
  });

  it("shows a not-found rather than a broken player when the recording is gone", async () => {
    getRecording.mockRejectedValue(new Error("404"));
    await mount();
    expect(container?.textContent).toContain("does not exist");
    expect(container?.querySelector('[data-testid="player"]')).toBeFalsy();
  });

  it("says the recording is still transcribing instead of offering an empty player", async () => {
    getRecording.mockResolvedValue({ ...REC, status: "processing", durationMs: null });
    await mount();
    expect(container?.textContent).toContain("Transcribing");
  });
});
