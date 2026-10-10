// @vitest-environment jsdom
/**
 * [COMP:app-web/chat-link-routing] Every Chat link opens in the side pane
 * (chat-parity D9), and the dock, which has no pane, keeps its links (T12).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { PaneRef } from "@/lib/chat-pane-tabs";
import {
  ChatPaneLink,
  mimeFromName,
  PaneLinkProvider,
  PaneUrlAnchor,
  paneRefForHref,
  paneRefForPin,
} from "../chat-link-routing";
import { ChatCitationList } from "@/components/chrome/chat-activity";
import { ChatFileAttachments } from "@/components/chrome/chat-file-attachment";
import { MessageAttachments } from "@/components/doc/message-attachment-card";

vi.mock("@/lib/use-doc-media", () => ({
  useDocMedia: () => ({ url: null, mimeType: null, loading: false, error: null }),
  useFileCacheMedia: () => ({ url: null, mimeType: null, loading: false, error: null }),
  useDocMediaDownload: () => vi.fn(async () => {}),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: ReactNode, openInPane?: (ref: PaneRef) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const tree = (
    <I18nProvider locale="en" dict={en as unknown as Dictionary}>
      {openInPane ? <PaneLinkProvider openInPane={openInPane}>{node}</PaneLinkProvider> : node}
    </I18nProvider>
  );
  act(() => root!.render(tree));
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("[COMP:app-web/chat-link-routing] every link kind calls openInPane", () => {
  it("markdown links: an in-app page opens a page tab, a web link a url tab", () => {
    const open = vi.fn();
    const el = render(
      <>
        <ChatPaneLink href="/w/ws-1/p/11111111-2222-3333-4444-555555555555">Plan</ChatPaneLink>
        <ChatPaneLink href="https://example.com/spec">Spec</ChatPaneLink>
        <ChatPaneLink href="mailto:ana@example.com">Mail</ChatPaneLink>
      </>,
      open,
    );
    const anchors = el.querySelectorAll("a");
    click(anchors[0]);
    click(anchors[1]);
    expect(open).toHaveBeenNthCalledWith(1, { kind: "page", pageId: "11111111-2222-3333-4444-555555555555" });
    expect(open).toHaveBeenNthCalledWith(2, { kind: "url", url: "https://example.com/spec" });
    // A mailto has no pane form: a plain link, never routed.
    expect(anchors[2]!.getAttribute("data-pane-link")).toBeNull();
    expect(Array.from(anchors).some((a) => a.getAttribute("target") === "_blank")).toBe(false);
  });

  it("citations open a url tab named after the source", () => {
    const open = vi.fn();
    const el = render(
      <ChatCitationList citations={[{ url: "https://news.example/a", title: "Rates rise" }]} label="Sources" />,
      open,
    );
    click(el.querySelector('a[data-pane-link="url"]'));
    expect(open).toHaveBeenCalledWith({ kind: "url", url: "https://news.example/a", title: "Rates rise" });
  });

  it("tool-step URLs open a url tab", () => {
    const open = vi.fn();
    const el = render(<PaneUrlAnchor url="https://site.example/page">Visited site.example</PaneUrlAnchor>, open);
    click(el.querySelector("a"));
    expect(open).toHaveBeenCalledWith({ kind: "url", url: "https://site.example/page" });
    // The shared activity chrome routes both its citations and its steps.
    const activity = readFileSync(join(process.cwd(), "src/components/chrome/chat-activity.tsx"), "utf8");
    expect(activity.match(/<PaneUrlAnchor/g)).toHaveLength(2);
    expect(activity).not.toContain('target="_blank"');
  });

  it("assistant file chips open a file tab instead of downloading", () => {
    const open = vi.fn();
    const el = render(
      <ChatFileAttachments
        attachments={[{
          fileId: "f-1", workspaceId: "ws-1", path: "/reports/q3.pdf", name: "q3.pdf",
          mime: "application/pdf", sizeBytes: 1200,
        }]}
      />,
      open,
    );
    click(el.querySelector("button"));
    expect(open).toHaveBeenCalledWith({
      kind: "file", fileId: "f-1", name: "q3.pdf", mime: "application/pdf", source: "durable",
    });
  });

  it("user attachments open a file tab instead of a modal", () => {
    const open = vi.fn();
    const el = render(
      <MessageAttachments
        attachments={[{ id: "c-1", name: "shot.png", mime: "image/png", dataUrl: "data:image/png;base64,AAAA" }]}
        workspaceId="ws-1"
      />,
      open,
    );
    click(el.querySelector('button[data-pane-link="file"]'));
    expect(open).toHaveBeenCalledWith({
      kind: "file", fileId: "c-1", name: "shot.png", mime: "image/png",
      dataUrl: "data:image/png;base64,AAAA", source: "cache",
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("page cards, a created page and reply links are wired to the pane on the Chat surface", () => {
    const surface = readFileSync(join(process.cwd(), "src/components/chat-app/chat-surface.tsx"), "utf8");
    expect(surface).toContain('onOpen={(id) => openInChatPane({ kind: "page", pageId: id })}');
    expect(surface).toContain('openInChatPane({ kind: "page", pageId: newPageId });');
    expect(surface).toContain("const CHAT_MARKDOWN_COMPONENTS = { pre: ChatCodeBlock, a: ChatPaneLink };");
    expect(surface).toContain("<PaneLinkProvider openInPane={openInChatPane}>");
    // Nothing in the transcript opens a new browser tab or navigates to a page.
    expect(surface).not.toContain('target="_blank"');
    expect(surface).not.toMatch(/router\.push\(docPagePath/);
  });

  it("maps hrefs and pins to pane references", () => {
    expect(paneRefForHref("/p/11111111-2222-3333-4444-555555555555")).toEqual({
      kind: "page", pageId: "11111111-2222-3333-4444-555555555555",
    });
    expect(paneRefForHref("ftp://example.com")).toBeNull();
    expect(paneRefForPin({ kind: "file", refId: "f-9", url: null, label: "deck.pptx" })).toEqual({
      kind: "file", fileId: "f-9", name: "deck.pptx", mime: mimeFromName("deck.pptx"), source: "durable",
    });
    expect(paneRefForPin({ kind: "task", refId: "t-1", url: null, label: "Ship it" })).toBeNull();
    expect(mimeFromName("Q3 Report.PDF")).toBe("application/pdf");
  });
});

describe("[COMP:app-web/chat-link-routing] the dock keeps its links (T12)", () => {
  it("without a pane, citations still open a new browser tab", () => {
    const el = render(
      <ChatCitationList citations={[{ url: "https://news.example/a", title: "Rates rise" }]} label="Sources" />,
    );
    const anchor = el.querySelector("a");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("data-pane-link")).toBeNull();
  });
});
