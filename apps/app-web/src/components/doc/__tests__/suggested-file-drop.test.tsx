// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SuggestedFileDrop } from "../suggested-file-drop";

/**
 * Staging rules for the Home "Add files to your brain" block. Both cases are
 * failures a user could not previously see: an oversized file died at the edge
 * with `TypeError: Failed to fetch` (2026-08-29, a 62.7 MB .docx), and the
 * sixth file of a drop was discarded by a `.slice()` with no chip at all.
 *
 * Mounted with raw `createRoot` + `act` (app-web has no @testing-library).
 */
describe("[COMP:app-web/home-file-drop] SuggestedFileDrop staging", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

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

  function mountWith(files: File[]): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <I18nProvider locale="en" dict={en}>
          <SuggestedFileDrop workspaceId="ws-1" />
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

  it("names the size cap on an oversized file and keeps the rest of the batch", () => {
    const dom = mountWith([
      sized("guide.docx", 65_790_453),
      sized("notes.md", 84_964),
    ]);
    expect(dom.textContent).toContain("62.7 MB");
    expect(dom.textContent).toContain("30.0 MB");
    // The small file is still staged, not collateral damage.
    expect(dom.textContent).toContain("notes.md");
    expect(dom.textContent).not.toContain("Failed to fetch");
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
});
