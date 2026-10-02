// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { LiveRecordingPage } from "@/lib/api/recordings";
import { useLiveRecordingPage } from "../use-live-recording-page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ stream: vi.fn(), start: vi.fn(), confirm: vi.fn(), list: vi.fn(), push: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/lib/recordings/live-transcript-events", () => ({ dispatchLiveTranscriptWindow: mocks.dispatch }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => ({ recorder: { liveMeetingNotesFolder: "New page in Meeting notes folder (default)", meetingNotesFolderName: "Meeting notes" } }) }));
vi.mock("@/lib/api/recordings", () => ({ startLiveRecordingPage: mocks.start, streamLiveRecordingWindow: mocks.stream }));

vi.mock("@/lib/api/views", () => ({ listViews: mocks.list }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: mocks.confirm }));

describe("[COMP:app-web/live-recording-page] default destination", () => {
  it("preselects the folder and creates nothing until the user confirms", async () => {
    let hook!: ReturnType<typeof useLiveRecordingPage>;
    function Harness() { hook = useLiveRecordingPage("workspace-1", "assistant-1"); return null; }
    const root = createRoot(document.createElement("div"));
    mocks.list.mockResolvedValue([]);
    mocks.start.mockResolvedValue({ pageId: "page-1" });
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    try {
      await act(async () => root.render(<Harness />));
      expect(await hook.prepare()).toBeNull();
      expect(mocks.start).not.toHaveBeenCalled();
      const dialog = mocks.confirm.mock.calls[0][0];
      expect(dialog.content.props.initial).toBe("meeting-notes");
      await hook.prepare();
      expect(mocks.start).toHaveBeenCalledWith({
        workspaceId: "workspace-1", destination: "meeting-notes", folderName: "Meeting notes",
      });
      expect(mocks.push).toHaveBeenCalled();
      mocks.push.mockClear(); mocks.confirm.mockResolvedValueOnce(true);
      expect(await hook.prepare(false)).toEqual({ pageId: "page-1" });
      expect(mocks.push).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      vi.clearAllMocks();
    }
  });
});

describe("[COMP:app-web/live-recording-page] overlapping session windows", () => {
  it("appends normal pane text immediately even if interaction reports a gap", async () => {
    let hook!: ReturnType<typeof useLiveRecordingPage>;
    function Harness() { hook = useLiveRecordingPage("w", "a"); return null; }
    const root = createRoot(document.createElement("div"));
    const onInteractionGap = vi.fn();
    const page: LiveRecordingPage = { pageId: "p", sessionId: "s", title: "Meeting", notesHeadingId: "n", markerBlockId: "m", interactionCaptureId: "capture", onInteractionGap };
    try {
      await act(async () => root.render(<Harness />));
      mocks.stream.mockResolvedValue({ transcript: "normal context", interactionError: true });
      await hook.streamWindow({ blob: new Blob(["audio"]), mime: "audio/webm", startMs: 0, endMs: 30_000, discontinuity: true, interactionSource: "mixed" }, page);
      expect(onInteractionGap).toHaveBeenCalledOnce();
      expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ pageId: "p", lines: [{ speaker: null, text: "normal context" }] }));
      expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ discontinuity: true, interactionSource: "mixed" }));
    } finally {
      act(() => root.unmount()); vi.clearAllMocks(); mocks.stream.mockReset();
    }
  });
  it("keeps destinations and missed-window counts session-scoped while old work drains", async () => {
    let hook!: ReturnType<typeof useLiveRecordingPage>;
    function Harness() { hook = useLiveRecordingPage("workspace-1", "assistant-1"); return null; }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      const [a, b]: LiveRecordingPage[] = ["a", "b"].map((id) => ({
        pageId: `page-${id}`, sessionId: `session-${id}`, title: "Meeting", notesHeadingId: "heading", markerBlockId: "marker",
      }));
      const window = { blob: new Blob(["audio"]), mime: "audio/webm", startMs: 0, endMs: 30_000 };
      mocks.stream.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ duplicate: true });
      await hook.streamWindow(window, a);
      await hook.streamWindow(window, b);
      await hook.streamWindow(window, a);
      await hook.streamWindow(window, a);
      expect(mocks.stream.mock.calls.map(([input]) => [input.page.sessionId, input.missedWindows])).toEqual([
        ["session-a", 0], ["session-b", 0], ["session-a", 1], ["session-a", 0],
      ]);
    } finally {
      act(() => root.unmount());
      mocks.stream.mockReset();
    }
  });
});
