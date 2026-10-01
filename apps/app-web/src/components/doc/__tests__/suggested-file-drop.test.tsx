// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getValidAccessToken: vi.fn(),
}));
vi.mock("@/lib/desktop-auth-source", () => ({
  usesGatewayCredentials: vi.fn(() => false),
}));
const queueHarness = vi.hoisted(() => ({ enqueueIntake: vi.fn() }));
vi.mock("@/lib/brain-intake/intake-queue", () => ({
  enqueueIntake: queueHarness.enqueueIntake,
}));
const confirmHarness = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: confirmHarness.confirmDialog,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SuggestedFileDrop } from "../suggested-file-drop";

/**
 * Staging rules for the shared "Add files to your brain" block. Both cases are
 * failures a user could not previously see: an oversized file died at the edge
 * with `TypeError: Failed to fetch` (2026-08-29, a 62.7 MB .docx), and the
 * sixth file of a drop was discarded by a `.slice()` with no chip at all.
 *
 * Mounted with raw `createRoot` + `act` (app-web has no @testing-library).
 */
describe("[COMP:app-web/home-file-drop] SuggestedFileDrop staging", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    queueHarness.enqueueIntake.mockReset();
    confirmHarness.confirmDialog.mockReset();
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  /** Allocating tens of MB per case is pointless; stub `size` on a 1-byte File. */
  const sized = (name: string, bytes: number): File => {
    const file = new File([new Uint8Array(1)], name, { type: "text/plain" });
    Object.defineProperty(file, "size", { value: bytes });
    return file;
  };

  function mountWith(files: File[], assistantId?: string): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <I18nProvider locale="en" dict={en}>
          <SuggestedFileDrop workspaceId="ws-1" assistantId={assistantId} />
        </I18nProvider>,
      );
    });
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return host;
  }

  it("names the 10 GB cap on an oversized file and keeps the rest of the batch", () => {
    const dom = mountWith([
      sized("archive.pdf", 12 * 1024 * 1024 * 1024),
      sized("notes.md", 84_964),
    ]);
    expect(dom.textContent).toContain("12.0 GB");
    expect(dom.textContent).toContain("10.0 GB");
    // The small file is still staged, not collateral damage.
    expect(dom.textContent).toContain("notes.md");
    expect(dom.textContent).not.toContain("Failed to fetch");
  });

  // 2026-10-01: a 62.7 MB .docx used to be refused with "the limit is 30 MB";
  // the intake queue now takes it through the chunked lane, so the modal
  // stages it like any other file.
  it("accepts a file past the 30 MB multipart ceiling and hands it to the queue", async () => {
    const big = sized("guide.docx", 65_790_453);
    const dom = mountWith([big]);
    expect(dom.textContent).toContain("guide.docx");
    expect(dom.textContent).not.toContain("Too large");
    await clickAdd(dom);
    expect(confirmHarness.confirmDialog).not.toHaveBeenCalled();
    expect(queueHarness.enqueueIntake).toHaveBeenCalledTimes(1);
    expect(queueHarness.enqueueIntake.mock.calls[0][0].files).toEqual([big]);
  });

  it("confirms a file above 100 MB before enqueueing it, and keeps a declined one staged", async () => {
    const huge = sized("video-export.pdf", 150 * 1024 * 1024);
    const dom = mountWith([huge]);
    confirmHarness.confirmDialog.mockResolvedValueOnce(false);
    await clickAdd(dom);
    expect(confirmHarness.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("150.0 MB") }),
    );
    expect(queueHarness.enqueueIntake).not.toHaveBeenCalled();
    expect(dom.textContent).toContain("video-export.pdf");

    confirmHarness.confirmDialog.mockResolvedValueOnce(true);
    await clickAdd(dom);
    expect(queueHarness.enqueueIntake).toHaveBeenCalledTimes(1);
  });

  it("tells the user about files past the per-drop cap instead of dropping them", () => {
    const dom = mountWith(
      Array.from({ length: 7 }, (_, i) => sized(`file-${i}.md`, 1_000)),
    );
    // Every file the user chose is accounted for on screen.
    for (let i = 0; i < 7; i += 1) {
      expect(dom.textContent).toContain(`file-${i}.md`);
    }
    expect(dom.textContent).toContain("Only 5 files at a time");
  });

  const clickAdd = async (dom: HTMLElement) => {
    const add = [...dom.querySelectorAll("button")].find(
      (button) => button.textContent === "Add to brain",
    );
    await act(async () => {
      add?.click();
    });
  };

  // The modal is for choosing, never for waiting: "Add to brain" hands the
  // batch to the intake queue (the bottom-bar tray owns the wait) and the
  // review empties, so a five-minute recording upload never blocks the app.
  it("hands a large video to the intake queue as media, off the document size cap, and empties the review", async () => {
    const video = new File([new Uint8Array(1)], "planning.mov", { type: "" });
    Object.defineProperty(video, "size", { value: 65_790_453 });

    const dom = mountWith([video], "assistant-1");
    expect(dom.textContent).toContain("planning.mov");
    expect(dom.textContent).not.toContain("30.0 MB");

    await clickAdd(dom);

    expect(queueHarness.enqueueIntake).toHaveBeenCalledTimes(1);
    const call = queueHarness.enqueueIntake.mock.calls[0][0];
    expect(call.workspaceId).toBe("ws-1");
    expect(call.assistantId).toBe("assistant-1");
    expect(call.files).toEqual([video]);
    expect(call.kind(video)).toBe("media");
    expect(dom.textContent).not.toContain("planning.mov");
  });

  it("keeps a ZIP mixed with other files in the review instead of sending anything", async () => {
    const dom = mountWith([
      new File([new Uint8Array(1)], "linkedin.zip", { type: "application/zip" }),
      sized("notes.md", 1_000),
    ]);
    await clickAdd(dom);
    expect(queueHarness.enqueueIntake).not.toHaveBeenCalled();
    expect(dom.textContent).toContain("Add a LinkedIn ZIP by itself");
    expect(dom.textContent).toContain("notes.md");
  });

  it("refuses media without an assistant before enqueueing, and still sends the documents", async () => {
    const video = new File([new Uint8Array(1)], "memo.m4a", { type: "audio/mp4" });
    const dom = mountWith([video, sized("notes.md", 1_000)]);
    await clickAdd(dom);
    expect(queueHarness.enqueueIntake).toHaveBeenCalledTimes(1);
    expect(queueHarness.enqueueIntake.mock.calls[0][0].files.map((f: File) => f.name)).toEqual([
      "notes.md",
    ]);
    expect(dom.textContent).toContain("memo.m4a");
    expect(dom.textContent).toContain("Add an assistant before ingesting audio or video.");
  });
});
