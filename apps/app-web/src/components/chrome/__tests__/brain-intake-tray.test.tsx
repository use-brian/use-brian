// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import {
  __resetIntakeQueueForTests,
  __setIntakeDepsForTests,
  enqueueIntake,
  getIntakeItems,
  updateIntakeItem,
  type IntakeKind,
} from "@/lib/brain-intake/intake-queue";
import type { IntakeDeps } from "@/lib/brain-intake/run-intake";

vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getValidAccessToken: vi.fn(),
}));
vi.mock("@/lib/desktop-auth-source", () => ({
  usesGatewayCredentials: vi.fn(() => false),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { BrainIntakeTray, summarizeIntake } from "../brain-intake-tray";

const kindOf = (file: File): IntakeKind => (file.type.startsWith("video/") ? "media" : "file");
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

/**
 * The chip + tray in the workspace footer: one phrase for the queue, a
 * non-modal panel for the rows, and the Review button that is the ONLY thing
 * that opens a recording's cost confirm.
 */
describe("[COMP:app-web/brain-intake-tray] BrainIntakeTray", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let deps: { [K in keyof IntakeDeps]: ReturnType<typeof vi.fn> };
  let pendingUpload: { resolve: (v: { recordingId: string }) => void } | null = null;

  beforeEach(() => {
    deps = {
      ingestFiles: vi.fn(),
      storeFiles: vi.fn(),
      reingestStoredFile: vi.fn(),
      ingestLinkedInArchive: vi.fn(),
      getIngestJobStatus: vi.fn(),
      startRecordingUpload: vi.fn(
        ({ onProgress }: { onProgress?: (p: number) => void }) =>
          new Promise<{ recordingId: string }>((resolve) => {
            onProgress?.(0.43);
            pendingUpload = { resolve };
          }),
      ),
      estimateRecording: vi.fn(async () => ({
        recordingId: "rec-1",
        durationMs: 4_310_677,
        durationSeconds: 4311,
        surchargeCredits: 0,
      })),
      confirmAndProcessRecording: vi.fn(),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => 0),
    };
    __setIntakeDepsForTests(deps as unknown as IntakeDeps);
    __resetIntakeQueueForTests();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <I18nProvider locale="en" dict={en}>
          <div className="relative">
            <BrainIntakeTray workspaceId="ws-1" />
          </div>
        </I18nProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    pendingUpload = null;
    __setIntakeDepsForTests(null);
    __resetIntakeQueueForTests();
  });

  const chip = () => host!.querySelector("[data-brain-intake-chip]") as HTMLButtonElement | null;
  const tray = () => host!.querySelector("[data-brain-intake-tray]") as HTMLElement | null;
  const button = (label: string) =>
    [...host!.querySelectorAll("button")].find(
      (el) => el.getAttribute("aria-label") === label || el.textContent === label,
    )!;

  it("renders nothing until a batch is enqueued, then a chip with the upload progress and an expanded tray", async () => {
    expect(chip()).toBeNull();
    act(() => {
      enqueueIntake({
        workspaceId: "ws-1",
        assistantId: "assistant-1",
        files: [new File(["x"], "泛微 Recording.mp4", { type: "video/mp4" })],
        kind: kindOf,
        t: en,
      });
    });
    await flush();
    expect(chip()!.textContent).toContain("Adding 1 file 43%");
    expect(chip()!.getAttribute("aria-expanded")).toBe("true");
    expect(tray()).not.toBeNull();
    expect(tray()!.textContent).toContain("泛微 Recording.mp4");
    expect(tray()!.textContent).toContain("Uploading 43%");
    expect(tray()!.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("43");
    // Only the row inside the tray is a live region; the sync footer's is not ours.
    expect(host!.querySelector('[aria-live]')).toBeNull();
  });

  it("stops at Ready to review and opens the confirm only from the Review button", async () => {
    act(() => {
      enqueueIntake({
        workspaceId: "ws-1",
        assistantId: "assistant-1",
        files: [new File(["x"], "meeting.mp4", { type: "video/mp4" })],
        kind: kindOf,
        t: en,
      });
    });
    await flush();
    act(() => pendingUpload!.resolve({ recordingId: "rec-1" }));
    await flush();
    await flush();
    expect(chip()!.textContent).toContain("1 needs your review");
    expect(tray()!.textContent).toContain("Ready to review: 72 min");
    expect(deps.confirmAndProcessRecording).not.toHaveBeenCalled();

    deps.confirmAndProcessRecording.mockResolvedValueOnce({
      outcome: "queued",
      result: { recordingId: "rec-1", status: "queued", jobId: "job-1" },
    });
    await act(async () => button("Review").click());
    await flush();
    expect(deps.confirmAndProcessRecording).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: "rec-1", workspaceId: "ws-1" }),
    );
    expect(tray()!.textContent).toContain("Queued for transcription");
    expect(chip()!.textContent).toContain("1 added to brain");
  });

  it("collapses and re-expands from the chip, dismisses a finished row, and clears the finished ones", async () => {
    deps.ingestFiles.mockResolvedValue([
      { fileName: "a.md", ok: true, status: "stored" },
      { fileName: "b.md", ok: false, error: "Unsupported file type" },
    ]);
    act(() => {
      enqueueIntake({
        workspaceId: "ws-1",
        assistantId: "assistant-1",
        files: [
          new File(["x"], "a.md", { type: "text/markdown" }),
          new File(["x"], "b.md", { type: "text/markdown" }),
        ],
        kind: kindOf,
        t: en,
      });
    });
    await flush();
    expect(chip()!.textContent).toContain("1 failed");
    expect(tray()!.textContent).toContain("Unsupported file type");
    expect(tray()!.textContent).toContain("Stored");

    act(() => chip()!.click());
    expect(tray()).toBeNull();
    expect(chip()!.getAttribute("aria-expanded")).toBe("false");
    act(() => chip()!.click());
    expect(tray()).not.toBeNull();

    const dismiss = [...tray()!.querySelectorAll('button[aria-label="Dismiss"]')];
    expect(dismiss).toHaveLength(2);
    act(() => (dismiss[1] as HTMLButtonElement).click());
    expect(getIntakeItems("ws-1")).toHaveLength(1);
    expect(chip()!.textContent).toContain("1 added to brain");

    act(() => button("Clear finished").click());
    expect(getIntakeItems("ws-1")).toHaveLength(0);
    expect(chip()).toBeNull();
  });

  it("summarises in priority order: review, then in flight, then failed, then done", () => {
    const base = {
      workspaceId: "ws-1",
      assistantId: "a",
      file: new File(["x"], "f"),
      kind: "file" as const,
      progress: null,
    };
    const t = en.intakeTray;
    expect(
      summarizeIntake(
        [
          { ...base, id: "1", status: "awaiting_review" },
          { ...base, id: "2", status: "uploading", progress: 0.5 },
          { ...base, id: "3", status: "error" },
        ],
        t,
      ),
    ).toMatchObject({ label: "1 needs your review", tone: "review" });
    expect(
      summarizeIntake(
        [
          { ...base, id: "2", status: "uploading", progress: 0.5 },
          { ...base, id: "4", status: "analyzing" },
          { ...base, id: "3", status: "error" },
        ],
        t,
      ),
    ).toMatchObject({ label: "Adding 2 files 50%", tone: "neutral", busy: true });
    expect(
      summarizeIntake([{ ...base, id: "3", status: "error" }, { ...base, id: "5", status: "done" }], t),
    ).toMatchObject({ label: "1 failed", tone: "failed" });
    expect(summarizeIntake([{ ...base, id: "5", status: "done" }], t)).toMatchObject({
      label: "1 added to brain",
      tone: "done",
    });
  });

  it("says a stored-only file is not in the brain", async () => {
    deps.ingestFiles.mockResolvedValue([{ fileName: "dump.csv", ok: true, status: "stored" }]);
    act(() => {
      enqueueIntake({
        workspaceId: "ws-1",
        assistantId: "assistant-1",
        files: [new File(["x"], "dump.csv", { type: "text/csv" })],
        kind: kindOf,
        t: en,
      });
    });
    await flush();
    const [row] = getIntakeItems("ws-1");
    act(() => updateIntakeItem(row.id, { storedOnly: true }));
    expect(tray()!.textContent).toContain("Too large to analyze");
    expect(tray()!.textContent).not.toContain("Added to brain");
  });

  it("offers Review again on a failed enqueue whose recording is still staged", async () => {
    act(() => {
      enqueueIntake({
        workspaceId: "ws-1",
        assistantId: "assistant-1",
        files: [new File(["x"], "meeting.mp4", { type: "video/mp4" })],
        kind: kindOf,
        t: en,
      });
    });
    await flush();
    const [row] = getIntakeItems("ws-1");
    act(() => updateIntakeItem(row.id, { status: "error", error: "Boom", recordingId: "rec-1" }));
    expect(tray()!.textContent).toContain("Review again");
    expect(tray()!.textContent).toContain("Boom");
  });
});
