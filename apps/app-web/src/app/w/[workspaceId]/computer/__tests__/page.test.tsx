// @vitest-environment jsdom
/**
 * [COMP:app-web/browsers-surface] Browsers index empty state.
 *
 * With no live session, this route must teach both entry paths: ask the
 * assistant to browse, or open Browser profiles to connect the user's Chrome.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openWorkspaceSettings = vi.fn();
vi.mock("@/components/settings-modal/settings-modal", () => ({
  openWorkspaceSettings: (...args: unknown[]) => openWorkspaceSettings(...args),
}));

vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("@/lib/api/computer", () => ({
  listActiveComputerTasks: vi.fn(),
  mostRecentComputerTask: vi.fn(),
}));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    computer: {
      sessions: {
        selectTitle: "Watch a live browser",
        selectHint: "Ask your assistant to browse.",
        connectTitle: "Use your own Chrome",
        connectHint: "Install the extension and pair My Browser.",
        installAction: "Install extension",
        connectAction: "Pair in Browser profiles",
      },
    },
  }),
}));

import { BrowsersEmptyState } from "../page";

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
  it("explains how to connect My Browser when no session is live", async () => {
    await mount();

    expect(container?.textContent).toContain("Use your own Chrome");
    expect(container?.textContent).toContain("Install the extension and pair My Browser.");
    expect(container?.textContent).toContain("Install extension");
    expect(container?.textContent).toContain("Pair in Browser profiles");
  });

  it("links directly to the browser extension install destination", async () => {
    await mount();
    const install = container?.querySelector("a");

    expect(install?.getAttribute("href")).toContain("chromewebstore.google.com");
    expect(install?.getAttribute("target")).toBe("_blank");
    expect(install?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("opens Browser profiles from the connection action", async () => {
    await mount();
    const button = container?.querySelector("button");
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(openWorkspaceSettings).toHaveBeenCalledWith("ws-browser-profiles");
  });
});
