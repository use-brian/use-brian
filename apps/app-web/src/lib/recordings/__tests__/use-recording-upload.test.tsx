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
}));

vi.mock("@/lib/api/recordings", () => ({
  startRecordingUpload: api.startRecordingUpload,
  estimateRecording: api.estimateRecording,
  processRecording: vi.fn(),
  linkLiveRecordingPage: vi.fn(),
  finalizeLiveRecording: vi.fn(),
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
      uploadInProgress: "Another recording is still being prepared.",
    },
  }),
}));

import { useRecordingUpload } from "../use-recording-upload";

type HookValue = ReturnType<typeof useRecordingUpload>;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookValue | null = null;

function Harness() {
  latest = useRecordingUpload("workspace-1", "assistant-1");
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
