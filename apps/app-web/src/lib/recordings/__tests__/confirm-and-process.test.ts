import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  estimateRecording: vi.fn(),
  processRecording: vi.fn(),
  listCustomPageTemplates: vi.fn(),
  createCustomPageTemplate: vi.fn(),
  listViews: vi.fn(),
  getWorkspaceDefaultBlueprint: vi.fn(),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: mocks.confirmDialog }));
vi.mock("@/lib/api/recordings", () => ({
  estimateRecording: mocks.estimateRecording,
  processRecording: mocks.processRecording,
}));
vi.mock("@/lib/api/views", () => ({
  listCustomPageTemplates: mocks.listCustomPageTemplates,
  createCustomPageTemplate: mocks.createCustomPageTemplate,
  listViews: mocks.listViews,
}));
vi.mock("@/lib/api/workspaces", () => ({
  getWorkspaceDefaultBlueprint: mocks.getWorkspaceDefaultBlueprint,
}));

import { confirmAndProcessRecording } from "../confirm-and-process";
import { en } from "@/lib/i18n/dictionaries/en";

const t = en;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.estimateRecording.mockResolvedValue({
    recordingId: "rec-1",
    durationMs: 604_587,
    durationSeconds: 605,
    surchargeCredits: 4,
  });
  mocks.listCustomPageTemplates.mockResolvedValue([]);
  mocks.listViews.mockResolvedValue([]);
  mocks.getWorkspaceDefaultBlueprint.mockResolvedValue(null);
  mocks.processRecording.mockResolvedValue({ recordingId: "rec-1", status: "queued", jobId: "job-1" });
  mocks.confirmDialog.mockResolvedValue(true);
});

const input = { workspaceId: "ws-1", recordingId: "rec-1", t };

describe("[COMP:recordings/confirm-and-process] recording pre-flight", () => {
  it.each([null, "blueprint-1"])("automatically queues a capture with default %s without a popup", async (blueprint) => {
    mocks.getWorkspaceDefaultBlueprint.mockResolvedValue({ defaultRecordingBlueprintId: blueprint });
    const stages: string[] = [];
    const out = await confirmAndProcessRecording({ ...input, automatic: true, onStage: (stage) => stages.push(stage) });
    expect(out.outcome).toBe("queued");
    expect(stages).toEqual(["estimate", "process"]);
    expect(mocks.estimateRecording).toHaveBeenCalledWith("rec-1");
    expect(mocks.processRecording).toHaveBeenCalledWith("rec-1", blueprint ?? undefined, null, undefined);
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
    expect(mocks.listCustomPageTemplates).not.toHaveBeenCalled();
    expect(mocks.listViews).not.toHaveBeenCalled();
    expect(mocks.createCustomPageTemplate).not.toHaveBeenCalled();
  });

  it("automatically finalizes a pinned assembled meeting without creating a second brief", async () => {
    mocks.getWorkspaceDefaultBlueprint.mockResolvedValue({ defaultRecordingBlueprintId: "blueprint-1" });
    await confirmAndProcessRecording({ ...input, automatic: true, pinnedPage: true, assembled: true });
    expect(mocks.processRecording).toHaveBeenCalledWith("rec-1", undefined, null, undefined);
    expect(mocks.getWorkspaceDefaultBlueprint).not.toHaveBeenCalled();
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
  });

  it("transcribes without a blueprint if workspace defaults are unavailable", async () => {
    mocks.getWorkspaceDefaultBlueprint.mockRejectedValue(new Error("unavailable"));
    await confirmAndProcessRecording({ ...input, automatic: true });
    expect(mocks.processRecording).toHaveBeenCalledWith("rec-1", undefined, null, undefined);
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
  });

  it("does not enqueue when automatic pre-flight fails", async () => {
    mocks.estimateRecording.mockRejectedValueOnce(new Error("duration unavailable"));
    await expect(confirmAndProcessRecording({ ...input, automatic: true })).rejects.toThrow("duration unavailable");
    expect(mocks.processRecording).not.toHaveBeenCalled();
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
  });

  it("never bypasses the duplicate guard or opens a popup in automatic mode", async () => {
    mocks.processRecording.mockRejectedValueOnce(new Error("already processed"));
    await expect(confirmAndProcessRecording({ ...input, automatic: true, alreadyProcessed: true })).rejects.toThrow("already processed");
    expect(mocks.processRecording).toHaveBeenCalledWith("rec-1", undefined, null, undefined);
    expect(mocks.processRecording).toHaveBeenCalledOnce();
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
  });

  it("estimates BEFORE confirming, and only processes after the user agrees", async () => {
    const out = await confirmAndProcessRecording(input);
    expect(out).toEqual({
      outcome: "queued",
      result: { recordingId: "rec-1", status: "queued", jobId: "job-1" },
    });
    // The cost quote has to come from the server, not from a client guess.
    expect(mocks.estimateRecording).toHaveBeenCalledWith("rec-1");
    const description = mocks.confirmDialog.mock.calls[0]![0].description as string;
    expect(description).toContain("10");
    expect(description).toContain("4");
    expect(mocks.processRecording).toHaveBeenCalled();
  });

  it("spends nothing when the user cancels", async () => {
    mocks.confirmDialog.mockResolvedValue(false);
    const out = await confirmAndProcessRecording(input);
    expect(out).toEqual({ outcome: "cancelled" });
    expect(mocks.processRecording).not.toHaveBeenCalled();
  });

  // The server's duplicate guard may only be cleared by a surface that actually
  // warned; sending confirm without the warning would make the guard a formality.
  it("warns about duplicates and sends confirm only for an already-processed recording", async () => {
    await confirmAndProcessRecording({ ...input, alreadyProcessed: true });
    expect(mocks.confirmDialog.mock.calls[0]![0].description).toContain(
      t.recordings.confirmAlreadyProcessed,
    );
    expect(mocks.processRecording).toHaveBeenCalledWith("rec-1", undefined, null, { confirm: true });
  });

  it("does not send confirm for a first run", async () => {
    await confirmAndProcessRecording(input);
    expect(mocks.processRecording).toHaveBeenCalledWith("rec-1", undefined, null, undefined);
  });

  it("names frame analysis for video so the confirm describes everything that runs", async () => {
    await confirmAndProcessRecording({ ...input, isVideo: true });
    expect(mocks.confirmDialog.mock.calls[0]![0].description).toContain(
      t.recordings.confirmVideoNote,
    );
  });

  // A roster / default / destination outage must degrade the picker, never block
  // a transcription the user is trying to start.
  it("still confirms when the blueprint roster and destinations fail to load", async () => {
    mocks.listCustomPageTemplates.mockRejectedValue(new Error("down"));
    mocks.listViews.mockRejectedValue(new Error("down"));
    mocks.getWorkspaceDefaultBlueprint.mockRejectedValue(new Error("down"));
    const out = await confirmAndProcessRecording(input);
    expect(out.outcome).toBe("queued");
  });
});
