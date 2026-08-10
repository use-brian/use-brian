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

vi.mock("@/components/computer/browser-profiles-section", () => ({
  BrowserProfilesSection: () => <div>Profile management</div>,
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
  it("owns Profile management instead of redirecting into Settings", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <BrowsersIndexPage params={Promise.resolve({ workspaceId: "ws-1" })} />,
      ),
    );

    expect(container.textContent).toContain("Profile management");
    expect(container.querySelector("#browser-profiles")).not.toBeNull();
  });

  it("explains how to connect My Browser when no session is live", async () => {
    await mount();

    expect(container?.textContent).toContain("Use your own Chrome");
    expect(container?.textContent).toContain("Install the extension and pair My Browser.");
    expect(container?.textContent).toContain("Install extension");
    expect(container?.textContent).toContain("Pair in Browser profiles");
  });

  it("keeps the getting-started content in one centered column", async () => {
    await mount();

    const emptyState = container?.firstElementChild;
    const connectCard = emptyState?.children[2];

    expect(emptyState?.classList.contains("items-center")).toBe(true);
    expect(connectCard?.classList.contains("mt-4")).toBe(true);
    expect(connectCard?.classList.contains("w-full")).toBe(true);
    expect(connectCard?.classList.contains("max-w-sm")).toBe(true);
  });

  it("links directly to the browser extension install destination", async () => {
    await mount();
    const install = container?.querySelector("a");

    expect(install?.getAttribute("href")).toContain("chromewebstore.google.com");
    expect(install?.getAttribute("target")).toBe("_blank");
    expect(install?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("links to Browser profiles inside the Browsers mini app", async () => {
    await mount();
    const links = [...(container?.querySelectorAll("a") ?? [])];
    const profiles = links.find((link) => link.textContent === "Pair in Browser profiles");
    expect(profiles?.getAttribute("href")).toBe("#browser-profiles");
  });
});
