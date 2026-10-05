import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { RecordingApiError } from "@/lib/api/recordings";
import {
  __resetIntakeQueueForTests,
  __setIntakeDepsForTests,
  canReviewIntakeItem,
  clearFinishedIntake,
  dismissIntakeItem,
  enqueueIntake,
  getIntakeItems,
  isIntakeTrayExpanded,
  reviewIntakeItem,
  setIntakeTrayExpanded,
  type IntakeKind,
} from "../intake-queue";
import type { IntakeDeps } from "../run-intake";

vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getValidAccessToken: vi.fn(),
}));
vi.mock("@/lib/desktop-auth-source", () => ({
  usesGatewayCredentials: vi.fn(() => false),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

const kindOf = (file: File): IntakeKind =>
  file.type.startsWith("video/") || file.type.startsWith("audio/")
    ? "media"
    : file.name.endsWith(".zip")
      ? "linkedin"
      : "file";

/** A resolvable promise the test settles by hand, so ordering is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The queue is what lets the "Add files" modal close while a recording is
 * still uploading: it owns every request, keeps the row alive across
 * navigation, and stops a media file at Ready to review instead of popping
 * the cost confirm into whatever the user is doing by then.
 */
describe("[COMP:app-web/brain-intake-queue] intake queue", () => {
  let deps: { [K in keyof IntakeDeps]: ReturnType<typeof vi.fn> };
  let clock: number;

  beforeEach(() => {
    clock = 1_000;
    deps = {
      ingestFiles: vi.fn(),
      storeFiles: vi.fn(),
      reingestStoredFile: vi.fn(),
      ingestLinkedInArchive: vi.fn(),
      getIngestJobStatus: vi.fn(),
      startRecordingUpload: vi.fn(),
      estimateRecording: vi.fn(),
      confirmAndProcessRecording: vi.fn(),
      // Polling sleeps resolve immediately; the deadline is driven by `now`.
      sleep: vi.fn(async () => {
        clock += 3_000;
      }),
      now: vi.fn(() => clock),
    };
    __setIntakeDepsForTests(deps as unknown as IntakeDeps);
    __resetIntakeQueueForTests();
  });

  afterEach(() => {
    __setIntakeDepsForTests(null);
    __resetIntakeQueueForTests();
  });

  const doc = (name = "notes.md") => new File(["x"], name, { type: "text/markdown" });
  const video = (name = "meeting.mp4") => new File(["x"], name, { type: "video/mp4" });

  it("stops a recording at Ready to review after upload + estimate, and never opens the confirm on its own", async () => {
    const upload = deferred<{ recordingId: string }>();
    deps.startRecordingUpload.mockImplementation(
      async ({ onProgress }: { onProgress?: (p: number) => void }) => {
        onProgress?.(0.43);
        return upload.promise;
      },
    );
    deps.estimateRecording.mockResolvedValue({
      recordingId: "rec-1",
      durationMs: 4_310_677,
      durationSeconds: 4311,
      surchargeCredits: 0,
    });

    const [item] = enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [video()],
      kind: kindOf,
      t: en,
    });
    await flush();
    let row = getIntakeItems("ws-1")[0];
    expect(row.id).toBe(item.id);
    expect(row.status).toBe("uploading");
    expect(row.progress).toBe(0.43);
    // Enqueueing expands the tray: the rows reappear where the wait now lives.
    expect(isIntakeTrayExpanded("ws-1")).toBe(true);

    upload.resolve({ recordingId: "rec-1" });
    await flush();
    row = getIntakeItems("ws-1")[0];
    expect(row.status).toBe("awaiting_review");
    expect(row.recordingId).toBe("rec-1");
    expect(row.durationSeconds).toBe(4311);
    expect(deps.confirmAndProcessRecording).not.toHaveBeenCalled();
    expect(canReviewIntakeItem(row)).toBe(true);
  });

  it("Review opens the confirm for the staged recording; cancel keeps it staged and never re-uploads", async () => {
    deps.startRecordingUpload.mockResolvedValue({ recordingId: "rec-1" });
    deps.estimateRecording.mockResolvedValue({
      recordingId: "rec-1",
      durationMs: 60_000,
      durationSeconds: 60,
      surchargeCredits: 0,
    });
    const [item] = enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [video()],
      kind: kindOf,
      t: en,
    });
    await flush();
    expect(getIntakeItems("ws-1")[0].status).toBe("awaiting_review");

    deps.confirmAndProcessRecording.mockResolvedValueOnce({ outcome: "cancelled" });
    await reviewIntakeItem(item.id, en);
    expect(deps.confirmAndProcessRecording).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", recordingId: "rec-1", isVideo: true }),
    );
    expect(getIntakeItems("ws-1")[0].status).toBe("awaiting_review");
    expect(deps.startRecordingUpload).toHaveBeenCalledTimes(1);

    deps.confirmAndProcessRecording.mockResolvedValueOnce({
      outcome: "queued",
      result: { recordingId: "rec-1", status: "queued", jobId: "job-1" },
    });
    await reviewIntakeItem(item.id, en);
    expect(getIntakeItems("ws-1")[0].status).toBe("done");
    expect(deps.startRecordingUpload).toHaveBeenCalledTimes(1);
  });

  it("a failed enqueue keeps the staged recording reviewable instead of costing the upload", async () => {
    deps.startRecordingUpload.mockResolvedValue({ recordingId: "rec-1" });
    deps.estimateRecording.mockResolvedValue({
      recordingId: "rec-1",
      durationMs: 60_000,
      durationSeconds: 60,
      surchargeCredits: 0,
    });
    const [item] = enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [video()],
      kind: kindOf,
      t: en,
    });
    await flush();
    deps.confirmAndProcessRecording.mockImplementation(async (input: { onStage?: (s: "estimate" | "process") => void }) => {
      input.onStage?.("process");
      throw new RecordingApiError("worker unavailable", 503, "worker_unavailable");
    });
    await reviewIntakeItem(item.id, en);
    const row = getIntakeItems("ws-1")[0];
    expect(row.status).toBe("error");
    expect(row.error).toContain(en.recordings.processFailed);
    expect(row.error).toContain("worker unavailable");
    expect(row.recordingId).toBe("rec-1");
    expect(canReviewIntakeItem(row)).toBe(true);
  });

  it("uploads media one at a time and names the estimate failure on the row", async () => {
    const first = deferred<{ recordingId: string }>();
    deps.startRecordingUpload
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ recordingId: "rec-2" });
    deps.estimateRecording
      .mockRejectedValueOnce(new RecordingApiError("too long", 413, "too_long"))
      .mockResolvedValueOnce({
        recordingId: "rec-2",
        durationMs: 1_000,
        durationSeconds: 1,
        surchargeCredits: 0,
      });
    enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [video("a.mp4"), video("b.mp4")],
      kind: kindOf,
      t: en,
    });
    await flush();
    let [a, b] = getIntakeItems("ws-1");
    expect(a.status).toBe("uploading");
    expect(b.status).toBe("queued");
    expect(deps.startRecordingUpload).toHaveBeenCalledTimes(1);

    first.resolve({ recordingId: "rec-1" });
    await flush();
    [a, b] = getIntakeItems("ws-1");
    expect(a.status).toBe("error");
    expect(a.error).toBe(en.recordings.tooLong);
    expect(b.status).toBe("awaiting_review");
    expect(deps.startRecordingUpload).toHaveBeenCalledTimes(2);
  });

  it("refuses media without an assistant before any request", async () => {
    enqueueIntake({
      workspaceId: "ws-1",
      assistantId: null,
      files: [video()],
      kind: kindOf,
      t: en,
    });
    await flush();
    const [row] = getIntakeItems("ws-1");
    expect(row.status).toBe("error");
    expect(row.error).toBe(en.docPage.suggested.ingestMediaNeedsAssistant);
    expect(deps.startRecordingUpload).not.toHaveBeenCalled();
  });

  it("sends ordinary files in one pass and watches a queued job to done", async () => {
    deps.ingestFiles.mockResolvedValue([
      { fileName: "notes.md", ok: true, status: "queued", jobId: "job-1" },
      { fileName: "brief.pdf", ok: true, status: "stored" },
    ]);
    deps.getIngestJobStatus
      .mockResolvedValueOnce(null) // unreadable poll: still analyzing
      .mockResolvedValueOnce({ status: "processing" })
      .mockResolvedValueOnce({ status: "done" });
    enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [doc("notes.md"), doc("brief.pdf")],
      kind: kindOf,
      t: en,
    });
    await flush();
    expect(deps.ingestFiles).toHaveBeenCalledTimes(1);
    let [notes, brief] = getIntakeItems("ws-1");
    expect(brief.status).toBe("done");
    expect(["analyzing", "done"]).toContain(notes.status);
    for (let i = 0; i < 6 && getIntakeItems("ws-1")[0].status !== "done"; i += 1) await flush();
    [notes] = getIntakeItems("ws-1");
    expect(notes.status).toBe("done");
    expect(deps.getIngestJobStatus).toHaveBeenCalledTimes(3);
  });

  it("shows a sentence, not the worker's raw error, when a queued job fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.ingestFiles.mockResolvedValue([{ fileName: "deck.pptx", ok: true, status: "queued", jobId: "job-2" }]);
    deps.getIngestJobStatus.mockResolvedValue({ status: "failed", error: "recording_intake_provenance_required" });
    enqueueIntake({ workspaceId: "ws-1", assistantId: "assistant-1", files: [doc("deck.pptx")], kind: kindOf, t: en });
    for (let i = 0; i < 6 && getIntakeItems("ws-1")[0].status !== "error"; i += 1) await flush();
    const [row] = getIntakeItems("ws-1");
    expect(row.status).toBe("error");
    expect(row.error).toBe(en.docPage.suggested.ingestAnalysisFailed);
  });

  /** Allocating tens of MB per case is pointless; stub `size` on a 1-byte File. */
  const sized = (name: string, bytes: number): File => {
    const file = new File([new Uint8Array(1)], name, { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: bytes });
    return file;
  };

  it("routes a file past the multipart ceiling through the chunked store lane with byte progress, then the stored-file ingest", async () => {
    const big = sized("deck.pdf", 65_790_453);
    deps.storeFiles.mockImplementation(
      async (_ws: string, files: File[], opts: { onProgress?: (f: File, u: number, t: number) => void }) => {
        opts.onProgress?.(files[0], 8 * 1024 * 1024, files[0].size);
        return [{ fileName: "deck.pdf", ok: true, fileId: "file-9", status: "stored" }];
      },
    );
    deps.reingestStoredFile.mockResolvedValue({ status: "queued", jobId: "job-9" });
    deps.getIngestJobStatus.mockResolvedValue({ status: "done" });
    deps.ingestFiles.mockResolvedValue([{ fileName: "notes.md", ok: true, status: "stored" }]);
    enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [big, doc("notes.md")],
      kind: kindOf,
      t: en,
    });
    await flush();
    expect(deps.ingestFiles).toHaveBeenCalledWith("ws-1", [expect.objectContaining({ name: "notes.md" })]);
    expect(deps.storeFiles).toHaveBeenCalledWith("ws-1", [big], expect.any(Object));
    expect(deps.reingestStoredFile).toHaveBeenCalledWith("ws-1", "file-9");
    for (let i = 0; i < 6 && getIntakeItems("ws-1")[0].status !== "done"; i += 1) await flush();
    const [row, small] = getIntakeItems("ws-1");
    expect(row.status).toBe("done");
    expect(row.result?.status).toBe("queued");
    expect(small.status).toBe("done");
  });

  it("ends a file past the parse ceiling at stored-only, never at added", async () => {
    deps.storeFiles.mockResolvedValue([{ fileName: "dump.csv", ok: true, fileId: "file-9", status: "stored" }]);
    deps.reingestStoredFile.mockResolvedValue({
      status: "stored_only",
      reason: "too_large_to_parse",
      detail: "too large to analyze",
    });
    enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [sized("dump.csv", 2 * 1024 * 1024 * 1024)],
      kind: kindOf,
      t: en,
    });
    await flush();
    const [row] = getIntakeItems("ws-1");
    expect(row.status).toBe("done");
    expect(row.storedOnly).toBe(true);
    expect(row.result?.status).toBe("stored");
    expect(deps.getIngestJobStatus).not.toHaveBeenCalled();
  });

  it("treats an already-ingested or in-flight stored file as added, not failed", async () => {
    deps.storeFiles.mockResolvedValue([{ fileName: "deck.pdf", ok: true, fileId: "file-9", status: "stored" }]);
    deps.reingestStoredFile.mockResolvedValue({
      status: "requires_confirmation",
      fileName: "deck.pdf",
      sizeBytes: 1,
      detail: "already in the brain",
    });
    enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [sized("deck.pdf", 65_790_453)],
      kind: kindOf,
      t: en,
    });
    await flush();
    const [row] = getIntakeItems("ws-1");
    expect(row.status).toBe("done");
    expect(row.result?.status).toBe("queued");
  });

  it("reports a transport failure as unreachable, never as the browser's wording", async () => {
    deps.ingestFiles.mockRejectedValue(new TypeError("Failed to fetch"));
    enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [doc()],
      kind: kindOf,
      t: en,
    });
    await flush();
    const [row] = getIntakeItems("ws-1");
    expect(row.status).toBe("error");
    expect(row.error).toBe(en.docPage.suggested.ingestUnreachable);
    expect(row.error).not.toContain("Failed to fetch");
  });

  it("routes a lone ZIP to the LinkedIn importer", async () => {
    deps.ingestLinkedInArchive.mockResolvedValue({
      fileName: "linkedin.zip",
      ok: true,
      linkedinImport: { runId: "run-1", status: "pending", rows: 0 },
    });
    enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [new File(["x"], "linkedin.zip", { type: "application/zip" })],
      kind: kindOf,
      t: en,
    });
    await flush();
    expect(deps.ingestLinkedInArchive).toHaveBeenCalledTimes(1);
    expect(deps.ingestFiles).not.toHaveBeenCalled();
    expect(getIntakeItems("ws-1")[0].status).toBe("done");
  });

  it("keeps rows per workspace, dismisses only terminal rows, and clears the finished ones", async () => {
    const upload = deferred<{ recordingId: string }>();
    deps.startRecordingUpload.mockReturnValue(upload.promise);
    deps.ingestFiles.mockResolvedValue([{ fileName: "notes.md", ok: true, status: "stored" }]);
    const [media] = enqueueIntake({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [video()],
      kind: kindOf,
      t: en,
    });
    const [other] = enqueueIntake({
      workspaceId: "ws-2",
      assistantId: "assistant-1",
      files: [doc()],
      kind: kindOf,
      t: en,
    });
    await flush();
    expect(getIntakeItems("ws-1").map((i) => i.id)).toEqual([media.id]);
    expect(getIntakeItems("ws-2").map((i) => i.id)).toEqual([other.id]);

    dismissIntakeItem(media.id); // in flight: stays
    expect(getIntakeItems("ws-1")).toHaveLength(1);
    dismissIntakeItem(other.id); // done: goes
    expect(getIntakeItems("ws-2")).toHaveLength(0);

    upload.resolve({ recordingId: "rec-1" });
    deps.estimateRecording.mockResolvedValue({
      recordingId: "rec-1",
      durationMs: 1_000,
      durationSeconds: 1,
      surchargeCredits: 0,
    });
    await flush();
    clearFinishedIntake("ws-1"); // awaiting_review is not finished
    expect(getIntakeItems("ws-1")).toHaveLength(1);

    setIntakeTrayExpanded("ws-1", false);
    expect(isIntakeTrayExpanded("ws-1")).toBe(false);
  });
});
