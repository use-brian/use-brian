// @vitest-environment jsdom
/**
 * [COMP:app-web/chat-context-pins] Work Bench chrome contract.
 *
 * app-web's default Vitest environment is node-only. An SSR pass is enough
 * for the static contract here: the persistent collapsed rail, resizable
 * expanded split-pane section, compact graphic hierarchy, inline Add menu,
 * and durable file-drop-to-pin path. Pointer resizing and live pin fan-in
 * remain browser QA.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listSessionPins = vi.fn().mockResolvedValue([]);
const addSessionPin = vi.fn().mockResolvedValue(undefined);
const storeFiles = vi.fn().mockResolvedValue([]);
const reingestStoredFile = vi.fn().mockResolvedValue({ status: "queued", jobId: "job-1" });
const confirmDialog = vi.fn().mockResolvedValue(true);
const fetchWorkerRunSummary = vi.fn().mockResolvedValue({
  total: 0,
  running: 0,
  completed: 0,
  failed: 0,
  stopped: 0,
  active: [],
});
vi.mock("@/lib/api/session-pins", () => ({
  listSessionPins: (...args: unknown[]) => listSessionPins(...args),
  addSessionPin: (...args: unknown[]) => addSessionPin(...args),
  removeSessionPin: vi.fn(),
}));
vi.mock("@/lib/api/ingest", () => ({
  MAX_INGEST_FILE_BYTES: 30 * 1024 * 1024,
  MAX_STORED_FILE_BYTES: 1024 * 1024 * 1024,
  LARGE_FILE_CONFIRM_BYTES: 100 * 1024 * 1024,
  storeFiles: (...args: unknown[]) => storeFiles(...args),
  reingestStoredFile: (...args: unknown[]) => reingestStoredFile(...args),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialog(...args),
}));
vi.mock("@/lib/api/views", () => ({
  listViews: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/api/tasks", () => ({
  fetchWorkspaceTasks: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/api/crm", () => ({
  fetchWorkspaceCrm: vi.fn().mockResolvedValue({
    contacts: [],
    companies: [],
    deals: [],
  }),
}));
vi.mock("@/lib/api/pending-questions", () => ({
  EMPTY_WORKER_RUN_SUMMARY: {
    total: 0,
    running: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
    active: [],
  },
  fetchWorkerRunSummary: (...args: unknown[]) =>
    fetchWorkerRunSummary(...args),
}));

import { ChatContextPins } from "../chat-context-pins";

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

describe("[COMP:app-web/chat-context-pins] Work Bench section", () => {
  beforeEach(() => {
    listSessionPins.mockReset().mockResolvedValue([]);
    addSessionPin.mockReset().mockResolvedValue(undefined);
    storeFiles.mockReset().mockResolvedValue([]);
    reingestStoredFile.mockReset().mockResolvedValue({ status: "queued", jobId: "job-1" });
    confirmDialog.mockReset().mockResolvedValue(true);
    fetchWorkerRunSummary.mockReset().mockResolvedValue({
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
      stopped: 0,
      active: [],
    });
  });

  it("collapses to a persistent icon-only rail with an accessible expand control", () => {
    const html = wrap(
      <ChatContextPins
        sessionId="session-1"
        workspaceId="workspace-1"
        refreshKey={0}
        startedByName="Ada"
        expanded={false}
        onExpandedChange={() => {}}
      />,
    );

    expect(html).toContain("Work Bench");
    expect(html).toContain("Captured to the company brain");
    expect(html).toMatch(/<aside[^>]*id="chat-work-bench"/);
    expect(html).toContain("w-11");
    expect(html).not.toContain("shadow-");
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toMatch(/aria-controls="chat-work-bench-content"/);
    expect(html).toMatch(/aria-label="Expand Work Bench\. Captured to the company brain"/);
    expect(html).not.toContain("Shared with workspace");
  });

  it("restores the section when the collapsed rail icon is clicked", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onExpandedChange = vi.fn();

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded={false}
            onExpandedChange={onExpandedChange}
          />
        </I18nProvider>,
      );
    });

    const expand = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Expand Work Bench"]',
    );
    expect(expand).toBeTruthy();
    await act(async () => expand!.click());
    expect(onExpandedChange).toHaveBeenCalledWith(true);

    act(() => root.unmount());
    container.remove();
  });

  it("collapses the expanded section from its header control", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onExpandedChange = vi.fn();

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded
            onExpandedChange={onExpandedChange}
          />
        </I18nProvider>,
      );
    });

    const collapse = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse Work Bench"]',
    );
    expect(collapse).toBeTruthy();
    await act(async () => collapse!.click());
    expect(onExpandedChange).toHaveBeenCalledWith(false);

    act(() => root.unmount());
    container.remove();
  });

  it("uses a compact icon-led hierarchy inside the flat resizable right section", () => {
    const html = wrap(
      <ChatContextPins
        sessionId="session-1"
        workspaceId="workspace-1"
        refreshKey={0}
        startedByName="Ada"
        expanded
        onExpandedChange={() => {}}
      />,
    );

    expect(html).toMatch(/<aside[^>]*id="chat-work-bench"/);
    expect(html).toContain('aria-label="Room status"');
    expect(html).toContain('aria-label="Shared with workspace"');
    expect(html).toContain('title="Started by Ada"');
    expect(html).toContain('aria-label="Captured to the company brain"');
    expect(html).toContain(">Live<");
    expect(html).toContain(">Idle<");
    expect(html).toContain(">Pins<");
    expect(html).toContain("Drop files");
    expect(html).toContain("Browse");
    expect(html).not.toContain("Keep the room&#x27;s working context close at hand.");
    expect(html).not.toContain("Live tasks and progress will appear here.");
    expect(html).not.toContain("Nothing is pinned yet");
    expect(html).not.toContain("shadow-");
    expect(html).toMatch(/aria-label="Collapse Work Bench"/);
    expect(html).toMatch(/role="separator"/);
    expect(html).toMatch(/aria-orientation="vertical"/);
  });

  it("shows the lead and delegated assistants with truthful live step progress", async () => {
    fetchWorkerRunSummary.mockResolvedValue({
      total: 4,
      running: 2,
      completed: 1,
      failed: 1,
      stopped: 0,
      active: [
        { workerId: "worker-pricing", description: "Checking competitor pricing" },
        { workerId: "worker-voice", description: "Reviewing customer interviews" },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-live"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            assistant={{ id: "lead", name: "Brian", iconSeed: 7 }}
            turnActive
            currentStep="Synthesizing the launch plan"
            tools={[
              { id: "lead-done", status: "done", description: "Read the brief" },
              { id: "lead-running", status: "running", description: "Draft the plan" },
              {
                id: "worker-running",
                status: "running",
                description: "Comparing annual plans",
                workerId: "worker-pricing",
              },
            ]}
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    expect(fetchWorkerRunSummary).toHaveBeenCalledWith("session-live");
    expect(container.textContent).toContain("3 active");
    expect(container.textContent).toContain("Brian");
    expect(container.textContent).toContain("Synthesizing the launch plan");
    expect(container.textContent).toContain("1 completed · 1 running");
    expect(container.textContent).toContain("Supporting assistant 1");
    expect(container.textContent).toContain("Comparing annual plans");
    expect(container.textContent).toContain("Supporting assistant 2");
    expect(container.textContent).toContain("Reviewing customer interviews");

    act(() => root.unmount());
    container.remove();
  });

  it("starts with the inline Add menu collapsed and accessibly wired", () => {
    const html = wrap(
      <ChatContextPins
        sessionId="session-1"
        workspaceId="workspace-1"
        refreshKey={0}
        startedByName={null}
        expanded
        onExpandedChange={() => {}}
      />,
    );

    expect(html).toMatch(/aria-controls="chat-work-bench-add-menu"/);
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).not.toContain('id="chat-work-bench-add-menu"');
    expect(html).toContain("Drop files");
  });

  it("expands the Add menu in place inside the drawer", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName={null}
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim().startsWith("Add"),
    );
    expect(add).toBeTruthy();
    await act(async () => add!.click());

    expect(add?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("#chat-work-bench-add-menu")).toBeTruthy();
    expect(
      container.querySelector('[aria-label="Pin to this room"]'),
    ).toBeTruthy();
    expect(container.querySelector('button[aria-label="File"]')).toBeTruthy();
    expect(container.textContent).toContain("Drop files");

    act(() => root.unmount());
    container.remove();
  });

  it("stores a dropped file, pins its returned id, then queues the brain save", async () => {
    storeFiles.mockResolvedValue([
      { fileName: "launch-brief.txt", ok: true, fileId: "file-durable-1" },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    const file = new File(["launch notes"], "launch-brief.txt", {
      type: "text/plain",
      lastModified: 1,
    });
    const pinsSection = container.querySelector<HTMLElement>(
      'section[aria-label="Pinned context"]',
    );
    expect(pinsSection).toBeTruthy();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });

    await act(async () => {
      pinsSection!.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(drop.defaultPrevented).toBe(true);
    expect(storeFiles).toHaveBeenCalledWith(
      "workspace-1",
      [file],
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(addSessionPin).toHaveBeenCalledWith("session-1", {
      kind: "file",
      refId: "file-durable-1",
    });
    // Dropping on Pins is consent to save to the brain: the stored file is
    // queued through the stored-file ingest lane after the pin exists.
    expect(reingestStoredFile).toHaveBeenCalledWith("workspace-1", "file-durable-1");
    expect(listSessionPins).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    container.remove();
  });

  it("accepts a batch beyond five files — there is no batch-count cap", async () => {
    const files = Array.from({ length: 7 }, (_, i) =>
      new File([`notes ${i}`], `brief-${i}.txt`, { type: "text/plain", lastModified: i + 1 }),
    );
    storeFiles.mockResolvedValue(
      files.map((file, i) => ({ fileName: file.name, ok: true, fileId: `file-${i}` })),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    const pinsSection = container.querySelector<HTMLElement>(
      'section[aria-label="Pinned context"]',
    );
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files, types: ["Files"] },
    });
    await act(async () => {
      pinsSection!.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(storeFiles).toHaveBeenCalledWith(
      "workspace-1",
      files,
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(addSessionPin).toHaveBeenCalledTimes(7);
    expect(container.textContent).not.toContain("Choose up to 5 files.");

    act(() => root.unmount());
    container.remove();
  });

  it("skips the brain save for pinned audio — the recording pipeline owns media", async () => {
    storeFiles.mockResolvedValue([
      { fileName: "voice-note.mp3", ok: true, fileId: "file-audio-1" },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    const file = new File(["audio"], "voice-note.mp3", {
      type: "audio/mpeg",
      lastModified: 3,
    });
    const pinsSection = container.querySelector<HTMLElement>(
      'section[aria-label="Pinned context"]',
    );
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });
    await act(async () => {
      pinsSection!.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(addSessionPin).toHaveBeenCalledWith("session-1", {
      kind: "file",
      refId: "file-audio-1",
    });
    expect(reingestStoredFile).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it("keeps the pin and shows an honest error row when the brain save fails", async () => {
    storeFiles.mockResolvedValue([
      { fileName: "launch-brief.txt", ok: true, fileId: "file-durable-1" },
    ]);
    reingestStoredFile.mockRejectedValue(new Error("ingest exploded"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    const file = new File(["launch notes"], "launch-brief.txt", {
      type: "text/plain",
      lastModified: 1,
    });
    const pinsSection = container.querySelector<HTMLElement>(
      'section[aria-label="Pinned context"]',
    );
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });
    await act(async () => {
      pinsSection!.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(addSessionPin).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "Pinned, but saving to the brain failed.",
    );

    act(() => root.unmount());
    container.remove();
  });

  it("grows a filter input once the pin list reaches 8 rows, and filters by label", async () => {
    const pinRow = (i: number, label: string) => ({
      id: `pin-${i}`,
      kind: "task" as const,
      refId: `00000000-0000-4000-8000-00000000000${i}`,
      url: null,
      text: null,
      label,
      position: i,
      addedByUserId: "u-1",
      addedByAssistantId: null,
      addedByName: "Ada",
      createdAt: new Date().toISOString(),
    });
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => pinRow(i, `Launch step ${i}`)),
      pinRow(7, "Quarterly pricing review"),
    ];
    listSessionPins.mockResolvedValue(rows);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    const filter = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search pins"]',
    );
    expect(filter).toBeTruthy();
    expect(container.textContent).toContain("Quarterly pricing review");
    expect(container.textContent).toContain("Launch step 0");

    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(filter!, "pricing");
      filter!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.textContent).toContain("Quarterly pricing review");
    expect(container.textContent).not.toContain("Launch step 0");

    act(() => root.unmount());
    container.remove();
  });

  it("shows no filter input below 8 pins", async () => {
    listSessionPins.mockResolvedValue([
      {
        id: "pin-1",
        kind: "task",
        refId: "00000000-0000-4000-8000-000000000001",
        url: null,
        text: null,
        label: "Only pin",
        position: 1,
        addedByUserId: "u-1",
        addedByAssistantId: null,
        addedByName: "Ada",
        createdAt: new Date().toISOString(),
      },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    expect(
      container.querySelector('input[aria-label="Search pins"]'),
    ).toBeNull();
    expect(container.textContent).toContain("Only pin");

    act(() => root.unmount());
    container.remove();
  });

  it("shows byte progress as a determinate per-file progress bar", async () => {
    let finishUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    storeFiles.mockImplementation(async (...args: unknown[]) => {
      const files = args[1] as File[];
      const options = args[2] as {
        onProgress: (file: File, uploadedBytes: number, totalBytes: number) => void;
      };
      options.onProgress(files[0], 1, 4);
      await uploadGate;
      return [{ fileName: files[0].name, ok: true, fileId: "file-progress" }];
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    const file = new File(["data"], "launch-brief.txt", {
      type: "text/plain",
      lastModified: 1,
    });
    const pinsSection = container.querySelector<HTMLElement>(
      'section[aria-label="Pinned context"]',
    );
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });

    await act(async () => {
      pinsSection!.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const progressBar = container.querySelector<HTMLElement>(
      '[role="progressbar"][aria-label="launch-brief.txt"]',
    );
    expect(progressBar).toBeTruthy();
    expect(progressBar?.getAttribute("aria-valuemin")).toBe("0");
    expect(progressBar?.getAttribute("aria-valuemax")).toBe("100");
    expect(progressBar?.getAttribute("aria-valuenow")).toBe("25");
    expect(progressBar?.getAttribute("aria-valuetext")).toBe("Uploading 25%");
    expect(progressBar?.firstElementChild?.getAttribute("style")).toContain(
      "width: 25%",
    );
    expect(container.textContent).toContain("25%");

    await act(async () => {
      finishUpload();
      await uploadGate;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => root.unmount());
    container.remove();
  });

  it("asks before starting a file upload above 100 MB and cancellation creates no upload", async () => {
    confirmDialog.mockResolvedValue(false);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    const file = new File(["pdf"], "catalog.pdf", {
      type: "application/pdf",
      lastModified: 2,
    });
    Object.defineProperty(file, "size", { value: 101 * 1024 * 1024 });
    const pinsSection = container.querySelector<HTMLElement>(
      'section[aria-label="Pinned context"]',
    );
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });
    await act(async () => {
      pinsSection!.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "Upload a large file?",
      description: expect.stringContaining("catalog.pdf is 101.0 MB"),
    }));
    expect(storeFiles).not.toHaveBeenCalled();
    expect(addSessionPin).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it("rejects an oversized dropped file before durable storage and explains the 1 GB limit", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ChatContextPins
            sessionId="session-1"
            workspaceId="workspace-1"
            refreshKey={0}
            startedByName="Ada"
            expanded
            onExpandedChange={() => {}}
          />
        </I18nProvider>,
      );
    });

    const file = new File(["pdf"], "price-list.pdf", {
      type: "application/pdf",
      lastModified: 2,
    });
    Object.defineProperty(file, "size", { value: 1024 * 1024 * 1024 + 1 });
    const pinsSection = container.querySelector<HTMLElement>(
      'section[aria-label="Pinned context"]',
    );
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });

    await act(async () => {
      pinsSection!.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(storeFiles).not.toHaveBeenCalled();
    expect(addSessionPin).not.toHaveBeenCalled();
    expect(container.textContent).toContain("price-list.pdf");
    expect(container.textContent).toContain(
      "That file is too large to pin (max 1 GB).",
    );

    act(() => root.unmount());
    container.remove();
  });
});

/**
 * The human half of turn recovery (2026-08-08). The automatic half is the
 * server-side lease; this is the control a member reaches for when a room has
 * been showing "Working" and they have no way to tell a live turn from a dead
 * one. The card must therefore offer Stop whenever a turn is running, not only
 * once some client-side heuristic has decided it looks stuck — the server is
 * what distinguishes abort-a-live-turn from reclaim-a-dead-lease.
 */
describe("[COMP:app-web/work-bench-stop] Live card stop control", () => {
  const baseProps = {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    refreshKey: 0,
    startedByName: null,
    expanded: true,
    onExpandedChange: () => {},
    assistant: { id: "a-1", name: "Brian" },
  };

  it("offers Stop as soon as a turn is active, without waiting for a stall", () => {
    const html = wrap(
      <ChatContextPins
        {...baseProps}
        turnActive
        currentStep="Thinking..."
        lastProgressAt={Date.now()}
        onStopTurn={() => {}}
      />,
    );

    expect(html).toContain("Stop");
    expect(html).toContain("Working");
  });

  it("omits Stop when nothing is running — there is no turn to stop", () => {
    const html = wrap(
      <ChatContextPins {...baseProps} turnActive={false} onStopTurn={() => {}} />,
    );

    expect(html).toContain("Idle");
    expect(html).not.toContain(">Stop<");
  });

  it("omits Stop when the surface passes no handler", () => {
    const html = wrap(
      <ChatContextPins
        {...baseProps}
        turnActive
        currentStep="Thinking..."
        lastProgressAt={Date.now()}
      />,
    );

    expect(html).toContain("Working");
    expect(html).not.toContain(">Stop<");
  });

  it("ages a turn that is running but showing nothing", () => {
    const html = wrap(
      <ChatContextPins
        {...baseProps}
        turnActive
        currentStep="Thinking..."
        lastProgressAt={Date.now() - 4 * 60_000}
        onStopTurn={() => {}}
      />,
    );

    // "Working" alone is what left a room guessing for half an hour.
    expect(html).toContain("No progress for 4m");
  });

  it("stays quiet under a minute — a normal turn must not look broken", () => {
    const html = wrap(
      <ChatContextPins
        {...baseProps}
        turnActive
        currentStep="Thinking..."
        lastProgressAt={Date.now() - 20_000}
        onStopTurn={() => {}}
      />,
    );

    expect(html).not.toContain("No progress");
  });
});
