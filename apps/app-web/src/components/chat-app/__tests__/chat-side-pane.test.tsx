// @vitest-environment jsdom
/**
 * [COMP:app-web/chat-side-pane] The Chat side pane shell and its built-in
 * `document` / `file` tab bodies (chat-parity D4-D6, T10, T11).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { resetChatPaneSession, useChatPane, type ChatPane } from "@/lib/chat-pane-session";
import type { PaneRef } from "@/lib/chat-pane-tabs";
import { ChatSidePane, ChatSidePaneToggle } from "../chat-side-pane";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../chat-pane-bodies", () => ({
  PanePageBody: ({ pageId }: { pageId: string }) => <div data-testid="page-body">{pageId}</div>,
  PaneUrlBody: ({ url }: { url: string }) => <div data-testid="url-body">{url}</div>,
}));

vi.mock("@/lib/use-doc-media", () => ({
  useDocMedia: () => ({ url: null, mimeType: null, loading: false, error: null }),
  useFileCacheMedia: () => ({ url: null, mimeType: null, loading: true, error: null }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let pane: ChatPane;

function Harness({ work }: { work: string }) {
  pane = useChatPane("ws", "chat-1", () => true);
  return (
    <>
      <ChatSidePaneToggle pane={pane} />
      <ChatSidePane
        workspaceId="ws"
        pane={pane}
        renderTab={(ref) => (ref.kind === "work" ? <p data-testid="work">{work}</p> : undefined)}
      />
    </>
  );
}

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <Harness work="Live work and pins" />
      </I18nProvider>,
    ),
  );
}

const tabs = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const docRef: PaneRef = {
  kind: "document",
  document: { id: "d1", title: "Brief.md", content: "# Plan", format: "markdown" },
};

beforeEach(() => {
  resetChatPaneSession();
  mount();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("[COMP:app-web/chat-side-pane] one right pane with tabs", () => {
  it("D6: shows the fixed Work tab first, focused, with no close control", () => {
    expect(tabs().map((tab) => tab.textContent)).toEqual(["Work"]);
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="work"]')?.textContent).toBe("Live work and pins");
    expect(host.querySelector('button[aria-label="Close Work"]')).toBeNull();
  });

  it("D5: renders a document tab's body and closes the tab back to Work", () => {
    act(() => pane.open(docRef));
    expect(tabs().map((tab) => tab.textContent)).toEqual(["Work", "Brief.md"]);
    expect(host.querySelector('[data-pane-kind="document"]')).not.toBeNull();
    expect(host.querySelector('[data-document-format="markdown"]')).not.toBeNull();
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close Brief.md"]');
    act(() => close!.click());
    expect(tabs()).toHaveLength(1);
    expect(host.querySelector('[data-testid="work"]')).not.toBeNull();
  });

  it("T10: a file tab renders the inline preview body, not a modal", () => {
    act(() =>
      pane.open({ kind: "file", fileId: "f1", name: "Deck.pdf", mime: "application/pdf", source: "cache" }),
    );
    expect(host.querySelector('[data-pane-kind="file"]')).not.toBeNull();
    expect(host.querySelector('[data-file-preview="pdf"]')).not.toBeNull();
    expect(host.textContent).toContain(en.attachments.preparing);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("D8/T11: only the close control collapses it; the header toggle reopens it with its count", () => {
    act(() => pane.open(docRef));
    expect(host.querySelector("[data-pane-toggle]")).toBeNull();
    const closePane = host.querySelector<HTMLButtonElement>(`button[aria-label="${en.chatApp.sidePane.closePane}"]`);
    act(() => closePane!.click());
    expect(host.querySelector("#chat-side-pane")).toBeNull();
    const toggle = host.querySelector<HTMLButtonElement>("[data-pane-toggle]");
    expect(toggle?.getAttribute("aria-label")).toBe("Open side pane, 1 tabs");
    act(() => toggle!.click());
    expect(host.querySelector("#chat-side-pane")).not.toBeNull();
    expect(pane.state.tabs).toHaveLength(2);
  });

  it("is a resizable split beside the transcript, and a full-screen overlay on phones", () => {
    const aside = host.querySelector("#chat-side-pane")!;
    expect(aside.querySelector('[role="separator"]')).not.toBeNull();
    expect(aside.className).toContain("max-sm:absolute");
    expect(aside.className).toContain("max-sm:inset-0");
  });

  it("T10/T9: page and url tabs render their bodies, with the only explicit ways out", () => {
    act(() => pane.open({ kind: "page", pageId: "page-7", title: "Launch plan" }));
    expect(host.querySelector('[data-testid="page-body"]')?.textContent).toBe("page-7");
    const full = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === en.chatApp.sidePane.openFullPage);
    act(() => full!.click());
    expect(router.push).toHaveBeenCalledWith("/w/ws/p/page-7");

    act(() => pane.open({ kind: "url", url: "https://example.com/spec" }));
    expect(host.querySelector('[data-testid="url-body"]')?.textContent).toBe("https://example.com/spec");
    const out = Array.from(host.querySelectorAll("a")).find((a) => a.textContent === en.chatApp.sidePane.openInBrowser);
    expect(out?.getAttribute("href")).toBe("https://example.com/spec");
    expect(out?.getAttribute("target")).toBe("_blank");
  });
});
