// @vitest-environment jsdom
/**
 * [COMP:app-web/browsers-surface] Browsers index empty state.
 *
 * Profile management has its own top-bar mode; this route stays a focused
 * live-browser canvas when no session is selected.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    computer: {
      sessions: {
        selectTitle: "Watch a live browser",
        selectHint: "Ask your assistant to browse.",
      },
    },
  }),
}));

import BrowsersIndexPage, { BrowsersEmptyState } from "../page";

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<BrowsersEmptyState />));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("[COMP:app-web/browsers-surface] Browsers index empty state", () => {
  it("renders the live-browser landing state without profile management", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<BrowsersIndexPage />));

    expect(container.textContent).toContain("Watch a live browser");
    expect(container.textContent).not.toContain("Profile management");
  });

  it("explains how to select or wait for a live session", async () => {
    await mount();

    expect(container?.textContent).toContain("Watch a live browser");
    expect(container?.textContent).toContain("Ask your assistant to browse.");
    expect(container?.querySelector("a")).toBeNull();
  });

  it("centers the empty live canvas", async () => {
    await mount();

    const emptyState = container?.firstElementChild;
    expect(emptyState?.classList.contains("items-center")).toBe(true);
    expect(emptyState?.classList.contains("justify-center")).toBe(true);
    expect(emptyState?.classList.contains("h-full")).toBe(true);
  });
});
