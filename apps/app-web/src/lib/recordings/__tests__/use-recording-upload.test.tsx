// @vitest-environment jsdom
/**
 * [COMP:web/recording-upload] Recording operation ownership.
 *
 * Composer controls disable on the rendered busy state, while this hook guard
 * closes the smaller same-tick window before React can paint that state.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  startRecordingUpload: vi.fn(),
  estimateRecording: vi.fn(),
  finalizeLiveRecording: vi.fn(),
}));
vi.mock("../confirm-and-process", () => ({
  confirmAndProcessRecording: vi.fn(async () => ({ outcome: "cancelled" })),
}));

vi.mock("@/lib/api/recordings", () => ({
  startRecordingUpload: api.startRecordingUpload,
  estimateRecording: api.estimateRecording,
  processRecording: vi.fn(),
  linkLiveRecordingPage: vi.fn(async () => {}),
  finalizeLiveRecording: api.finalizeLiveRecording,
  recordingMimeForFile: (file: File) => file.type || "audio/webm",
  RecordingApiError: class RecordingApiError extends Error {
    code?: string;
    status = 0;
  },
}));

vi.mock("@/lib/api/views", () => ({
  listCustomPageTemplates: vi.fn(),
  createCustomPageTemplate: vi.fn(),
  listViews: vi.fn(),
  setPageLinkedRecording: vi.fn(),
}));
vi.mock("@/lib/api/workspaces", () => ({ getWorkspaceDefaultBlueprint: vi.fn() }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
vi.mock("@/components/recordings/recording-confirm-picker", () => ({
  RecordingConfirmPicker: () => null,
  DESTINATION_ROOT: "__root__",
}));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    recordings: {
      staged: "Recording attached.",
      tooLong: "Too long.",
      cannotReadDuration: "Cannot read duration.",
      failed: "Upload failed.",
      uploadFailed: "Storage upload failed.",
      uploadPrepareFailed: "Admission failed.",
      uploadCompleteFailed: "Completion failed.",
      serverSetupRequired: "Configure server ffmpeg; keep the local recording.",
      uploadInProgress: "Another recording is still being prepared.",
    },
  }),
}));

import { RecordingApiError } from "@/lib/api/recordings";
import { useRecordingUpload } from "../use-recording-upload";

type HookValue = ReturnType<typeof useRecordingUpload>;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookValue | null = null;
let capture: HookValue;

function Harness() {
  latest = useRecordingUpload("workspace-1", "assistant-1");
  capture = useRecordingUpload("workspace-1", "assistant-1");
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  latest = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness />));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
});

describe("[COMP:web/recording-upload] operation ownership", () => {
  it("preserves the fallback server prerequisite error and returns failure for local retention", async () => {
    api.startRecordingUpload.mockRejectedValueOnce(Object.assign(new RecordingApiError("admission", 500), { code: "recording_upload_prepare_failed" }));
    api.finalizeLiveRecording.mockRejectedValueOnce(Object.assign(new RecordingApiError("ffmpeg unavailable", 503), { code: "recording_media_tools_unavailable" }));
    await act(async () => {
      expect(await capture.run(new File(["audio"], "recording.webm"), { liveSessionId: "live" })).toEqual({
        outcome: "failed", message: "Configure server ffmpeg; keep the local recording.",
      });
    });
    expect(capture.status).toBe("error");
    expect(capture.result).toBeNull();
    expect(api.estimateRecording).not.toHaveBeenCalled();
  });

  it.each(["recording_upload_prepare_failed", "recording_upload_complete_failed"])("uses stage-aware attachment copy for %s", async (code) => {
    api.startRecordingUpload.mockRejectedValueOnce(Object.assign(new RecordingApiError("API failed", 500), { code }));
    await act(async () => { expect(await latest!.stage(new File(["audio"], "recording.webm"))).toBeNull(); });
    expect(latest!.message).toBe(code.includes("prepare") ? "Admission failed." : "Completion failed.");
    expect(api.estimateRecording).not.toHaveBeenCalled();
  });

  it("uploads the full file without waiting for live transcription", async () => {
    api.startRecordingUpload.mockResolvedValueOnce({ recordingId: "full-recording" });
    const pendingWindows = new Promise<void>(() => {});
    await act(async () => {
      const result = await capture.run(new File(["audio"], "recording.webm"), {
        existingPageId: "page", liveSessionId: "live", liveWindowsDone: pendingWindows,
      });
      expect(result.outcome).toBe("cancelled"); // reached confirmation, despite pending windows
    });
    expect(api.startRecordingUpload).toHaveBeenCalledOnce();
    expect(api.finalizeLiveRecording).not.toHaveBeenCalled();
  });

  it("waits for final windows only when a failed full upload needs window assembly", async () => {
    api.startRecordingUpload.mockRejectedValueOnce(new Error("upload offline"));
    api.finalizeLiveRecording.mockResolvedValueOnce({ recordingId: "assembled" });
    let finishWindows!: () => void;
    const liveWindowsDone = new Promise<void>((resolve) => { finishWindows = resolve; });
    let saving!: ReturnType<HookValue["run"]>;
    await act(async () => {
      saving = capture.run(new File(["audio"], "recording.webm"), {
        liveSessionId: "live", liveWindowsDone,
      });
    });
    expect(api.startRecordingUpload).toHaveBeenCalledOnce();
    expect(api.finalizeLiveRecording).not.toHaveBeenCalled();
    await act(async () => { finishWindows(); await saving; });
    expect(api.finalizeLiveRecording).toHaveBeenCalledWith({ workspaceId: "workspace-1", assistantId: "assistant-1", sessionId: "live" });
  });

  it("allows chat attachments while an independent recorder save is uploading", async () => {
    let failUpload!: (error: Error) => void;
    api.startRecordingUpload.mockImplementationOnce(() => new Promise((_resolve, reject) => { failUpload = reject; }));
    api.startRecordingUpload.mockResolvedValueOnce({ recordingId: "attachment-1" });
    api.estimateRecording.mockResolvedValue({ durationSeconds: 180, surchargeCredits: 1 });
    let saving!: ReturnType<HookValue["run"]>;
    await act(async () => { saving = capture.run(new File(["capture"], "recording.webm", { type: "audio/webm" })); });
    expect(capture.busy).toBe(true);
    expect(latest!.busy).toBe(false);
    await act(async () => { await latest!.stage(new File(["attachment"], "attachment.webm", { type: "audio/webm" })); });
    expect(latest!.status).toBe("done");
    expect(capture.status).toBe("uploading");
    await act(async () => { failUpload(new Error("offline")); await saving; });
    expect(latest!.status).toBe("done");
  });

  it("rejects an overlapping stage without replacing the active upload state", async () => {
    let resolveUpload!: (value: { recordingId: string }) => void;
    api.startRecordingUpload.mockImplementationOnce(
      () =>
        new Promise<{ recordingId: string }>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    api.estimateRecording.mockResolvedValue({ durationSeconds: 180, surchargeCredits: 1 });

    const firstFile = new File(["first"], "first.m4a", { type: "audio/x-m4a" });
    const secondFile = new File(["second"], "second.m4a", { type: "audio/x-m4a" });
    let first!: Promise<Awaited<ReturnType<HookValue["stage"]>>>;
    let second!: Promise<Awaited<ReturnType<HookValue["stage"]>>>;

    await act(async () => {
      first = latest!.stage(firstFile);
      second = latest!.stage(secondFile);
    });

    await expect(second).resolves.toBeNull();
    expect(api.startRecordingUpload).toHaveBeenCalledTimes(1);
    expect(latest!.status).toBe("uploading");
    expect(latest!.message).toBe("");

    await act(async () => {
      resolveUpload({ recordingId: "recording-1" });
      await first;
    });

    expect(latest!.status).toBe("done");
    expect(latest!.message).toBe("Recording attached.");
    expect(api.estimateRecording).toHaveBeenCalledWith("recording-1");
  });
});
