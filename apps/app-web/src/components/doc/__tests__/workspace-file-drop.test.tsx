// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

const authHarness = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: authHarness.authFetch,
  getValidAccessToken: vi.fn(),
}));
vi.mock("@/lib/desktop-auth-source", () => ({
  usesGatewayCredentials: vi.fn(() => false),
}));
const queueHarness = vi.hoisted(() => ({ enqueueIntake: vi.fn() }));
vi.mock("@/lib/brain-intake/intake-queue", () => ({
  enqueueIntake: queueHarness.enqueueIntake,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { WorkspaceFileDropBoundary, WorkspaceFileIntakeButton } from "../workspace-file-drop";

/**
 * [COMP:app-web/workspace-file-drop] The workspace shell catches neutral file
 * drops for review while a marked contextual drop surface keeps ownership.
 */
describe("[COMP:app-web/workspace-file-drop] WorkspaceFileDropBoundary", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    authHarness.authFetch.mockReset();
    queueHarness.enqueueIntake.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function mount({ offline = false }: { offline?: boolean } = {}) {
    root = createRoot(host!);
    act(() => {
      root!.render(
        <I18nProvider locale="en" dict={en}>
          <WorkspaceFileDropBoundary
            workspaceId="ws-1"
            assistantId="assistant-1"
            offline={offline}
          >
            <WorkspaceFileIntakeButton disabled={offline} />
            <div id="neutral-surface">Workspace surface</div>
            <div id="contextual-drop" data-file-drop-owner="true">
              Chat attachment surface
            </div>
          </WorkspaceFileDropBoundary>
        </I18nProvider>,
      );
    });
  }

  function dispatchDrop(target: Element, files: File[], types = ["Files"]) {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files, types },
      configurable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function button(label: string) {
    return [...document.body.querySelectorAll("button")].find(
      (el) => el.getAttribute("aria-label") === label || el.textContent === label,
    )!;
  }

  function pickFiles(files: File[]) {
    const input = document.body.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  }

  it("opens a picker review from the toolbar and stages files until explicitly added", async () => {
    mount();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    act(() => button("Add files").click());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Drop files here");

    const file = new File(["notes"], "planning-notes.md", { type: "text/markdown" });
    pickFiles([file]);
    expect(document.body.textContent).toContain("planning-notes.md");
    expect(authHarness.authFetch).not.toHaveBeenCalled();
    expect(queueHarness.enqueueIntake).not.toHaveBeenCalled();

    // "Add to brain" hands the batch to the intake queue and closes the
    // review: the wait lives in the bottom-bar tray, never in the modal.
    await act(async () => button("Add to brain").click());
    expect(queueHarness.enqueueIntake).toHaveBeenCalledTimes(1);
    expect(queueHarness.enqueueIntake.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws-1",
      assistantId: "assistant-1",
      files: [file],
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  // The recording cost + blueprint confirm is the global confirmDialog: a
  // body-portaled z-50 AlertDialog that lands above its caller by DOM order
  // alone. A review dialog raised above that layer hides the confirm behind
  // its own backdrop, so every audio/video drop hangs on "Checking
  // recording..." with nothing to click (2026-09-05 to 2026-09-30, z-[70]).
  it("keeps the review dialog on the shared modal layer so the recording confirm can land above it", () => {
    mount();
    act(() => button("Add files").click());
    const popup = document.body.querySelector('[role="dialog"]')!;
    expect(popup).not.toBeNull();
    const backdrop = popup.parentElement!.querySelector('[data-open]:not([role="dialog"])');
    for (const el of [popup, backdrop]) {
      expect(el).not.toBeNull();
      expect(el!.className).toContain("z-50");
      expect(el!.className).not.toMatch(/z-\[\d+\]/);
    }
  });

  it("dismisses a dropped batch without uploading and opens a fresh picker review", async () => {
    mount();
    dispatchDrop(host!.querySelector("#neutral-surface")!, [new File(["notes"], "discarded.md")]);
    await act(async () => button("Close file intake").click());
    act(() => button("Add files").click());
    expect(document.body.textContent).not.toContain("discarded.md");
    expect(document.body.textContent).toContain("Drop files here");
    expect(authHarness.authFetch).not.toHaveBeenCalled();
  });

  it("can always be closed: the review never owns an in-flight request", async () => {
    mount();
    act(() => button("Add files").click());
    pickFiles([new File(["notes"], "planning-notes.md")]);
    expect(button("Close file intake").disabled).toBe(false);
    act(() => button("Close file intake").click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(queueHarness.enqueueIntake).not.toHaveBeenCalled();
  });

  it("stages a neutral workspace drop for review without uploading", () => {
    mount();
    const file = new File(["notes"], "planning-notes.md", { type: "text/markdown" });
    const event = dispatchDrop(host!.querySelector("#neutral-surface")!, [file]);

    expect(event.defaultPrevented).toBe(true);
    expect(document.body.textContent).toContain("Add files to your brain");
    expect(document.body.textContent).toContain("planning-notes.md");
    expect(authHarness.authFetch).not.toHaveBeenCalled();
  });

  it("lets a marked contextual file workflow override the fallback", () => {
    mount();
    const file = new File(["notes"], "chat-notes.md", { type: "text/markdown" });
    const event = dispatchDrop(host!.querySelector("#contextual-drop")!, [file]);

    expect(event.defaultPrevented).toBe(false);
    expect(document.body.textContent).not.toContain("chat-notes.md");
    expect(authHarness.authFetch).not.toHaveBeenCalled();
  });

  it("keeps an offline drop staged until the workspace reconnects", () => {
    mount({ offline: true });
    expect(button("Add files").disabled).toBe(true);
    const file = new File(["notes"], "offline-notes.md", { type: "text/markdown" });
    dispatchDrop(host!.querySelector("#neutral-surface")!, [file]);

    expect(document.body.textContent).toContain("offline-notes.md");
    expect(document.body.textContent).toContain("after you reconnect");
    const addButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Add to brain",
    );
    expect(addButton?.disabled).toBe(true);
  });

  it("ignores non-file application drags", () => {
    mount();
    const event = dispatchDrop(host!.querySelector("#neutral-surface")!, [], ["text/plain"]);

    expect(event.defaultPrevented).toBe(false);
    expect(document.body.textContent).not.toContain("Add files to your brain");
  });
});
