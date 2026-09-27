// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

// Durable refs return authenticated bytes; legacy file_cache refs retain
// the separately signed preview lane. No real network is used.
const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import { BlockImage } from "../block-image";
import { BlockFile } from "../block-file";

/** Image and file blocks render authorized bytes as object URLs.
 * [COMP:app-web/image-embed]
 */
describe("[COMP:app-web/image-embed] Durable image/file embed render", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockAuthFetch.mockReset();
    vi.stubGlobal("URL", class extends URL {static createObjectURL=()=>"blob:fixture"; static revokeObjectURL=vi.fn();});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    container.remove();
  });

  function mount(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <I18nProvider locale="en" dict={en}>
          {node}
        </I18nProvider>,
      ),
    );
  }

  const wsRef = {
    bucket: "workspace_files",
    path: "wf_1",
    mimeType: "image/png",
    sizeBytes: 4,
    name: "shot.png",
  };

  it("renders the picker affordance when the image block has no ref yet", () => {
    mount(
      <BlockImage
        block={{ kind: "image", id: "b1", ref: null }}
        blockId="b1"
        workspaceId="ws_1"
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(en.docPage.mediaBlock.uploadImage);
  });

  it("renders an image at a local object URL after an authorized byte read", async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      blob: async () => new Blob(["fixture"], {type:"image/png"}),
    });
    mount(
      <BlockImage
        block={{ kind: "image", id: "b1", ref: wsRef }}
        blockId="b1"
        workspaceId="ws_1"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // The Bearer-only endpoint is fetched with authentication, never used as src.
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/doc-files/ws_1/wf_1?redirect=0"),
      {cache:"no-store"},
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("blob:fixture");
  });

  it("renders a download link at a local object URL for a file block", async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      blob: async () => new Blob(["fixture"], {type:"application/pdf"}),
    });
    mount(
      <BlockFile
        block={{
          kind: "file",
          id: "f1",
          ref: { ...wsRef, path: "wf_2", mimeType: "application/pdf", name: "spec.pdf" },
        }}
        blockId="f1"
        workspaceId="ws_1"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("blob:fixture");
    expect(anchor?.hasAttribute("download")).toBe(true);
    expect(container.textContent).toContain("spec.pdf");
  });

  it("resolves a legacy file_cache image ref through the signed preview-URL mint", async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "/api/files/fc_1/preview?sig=signed-token" }),
    });
    mount(
      <BlockImage
        block={{
          kind: "image",
          id: "b1",
          ref: {
            bucket: "file_cache",
            path: "fc_1",
            mimeType: "image/png",
            sizeBytes: 4,
            name: "legacy.png",
          },
        }}
        blockId="b1"
        workspaceId="ws_1"
      />,
    );
    // Let the async mint round-trip settle, then flush React effects.
    await act(async () => {
      await Promise.resolve();
    });
    // Minted against the correct id + workspace.
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/files/fc_1/preview-url?workspaceId=ws_1"),
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("/api/files/fc_1/preview?sig=signed-token");
  });
});
