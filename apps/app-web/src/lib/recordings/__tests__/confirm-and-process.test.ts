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
