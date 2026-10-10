// @vitest-environment jsdom
/**
 * [COMP:app-web/chat-side-pane] The `url` and `page` tab bodies
 * (chat-parity T9, T10).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

const preview = vi.hoisted(() => ({ fetchLinkPreview: vi.fn() }));
vi.mock("@/lib/api/link-preview", () => preview);
vi.mock("@/lib/collab/use-collab-provider", () => ({ useCollabProvider: (id: string) => ({ id }) }));
vi.mock("@/components/doc/collab-page-editor", () => ({
  CollabPageEditor: ({ viewId, canEdit }: { viewId: string; canEdit?: boolean }) => (
    <div data-testid="editor" data-view={viewId} data-editable={String(!!canEdit)} />
  ),
}));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "u-1", name: "Ana" }) }));

import { PanePageBody, PaneUrlBody } from "../chat-pane-bodies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}>{node}</I18nProvider>);
  });
}
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  preview.fetchLinkPreview.mockReset();
});

describe("[COMP:app-web/chat-side-pane] url and page tab bodies", () => {
  it("T9: frames a page that allows it, in a sandbox", async () => {
    preview.fetchLinkPreview.mockResolvedValue({ url: "https://ok.example", title: "OK", embeddable: true });
    await render(<PaneUrlBody url="https://ok.example" />);
    const frame = host.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("https://ok.example");
    expect(frame?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  });

  it("T9: a page that refuses framing gets a link card with Open in browser", async () => {
    preview.fetchLinkPreview.mockResolvedValue({
      url: "https://locked.example/doc", title: "Locked doc", siteName: "Locked", embeddable: false,
    });
    await render(<PaneUrlBody url="https://locked.example/doc" />);
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("Locked doc");
    expect(host.textContent).toContain(en.chatApp.sidePane.urlNotEmbeddable);
    const out = host.querySelector("a");
    expect(out?.textContent).toContain(en.chatApp.sidePane.openInBrowser);
    expect(out?.getAttribute("target")).toBe("_blank");
  });

  it("T9: an unreadable link still offers the card (never an empty frame)", async () => {
    preview.fetchLinkPreview.mockResolvedValue(null);
    await render(<PaneUrlBody url="https://down.example" title="Down" />);
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("Down");
  });

  it("T10: a page tab is the collaborative editor, editable in place", async () => {
    await render(<PanePageBody pageId="page-7" />);
    const editor = host.querySelector('[data-testid="editor"]');
    expect(editor?.getAttribute("data-view")).toBe("page-7");
    expect(editor?.getAttribute("data-editable")).toBe("true");
  });
});
