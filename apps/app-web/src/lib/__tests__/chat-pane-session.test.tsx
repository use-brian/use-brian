// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adoptFreshChatPane,
  readChatPane,
  resetChatPaneSession,
  resetFreshChatPane,
  updateChatPane,
  useChatPane,
  type ChatPane,
} from "../chat-pane-session";
import { openInPane, tabRef, activeTab, type PaneRef } from "../chat-pane-tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = (id: string): PaneRef => ({
  kind: "document",
  document: { id, title: id, content: "body", format: "text" },
});

let root: Root;
let host: HTMLDivElement;
let latest: ChatPane;
function Harness({ sessionId }: { sessionId: string | null }) {
  latest = useChatPane("ws", sessionId, () => true);
  return null;
}
function mount(sessionId: string | null) {
  host = document.createElement("div");
  root = createRoot(host);
  act(() => root.render(createElement(Harness, { sessionId })));
}
function unmount() {
  act(() => root.unmount());
}

beforeEach(() => resetChatPaneSession());
afterEach(() => {
  try { unmount(); } catch { /* already unmounted */ }
});

describe("[COMP:app-web/chat-pane-session] the pane stays with each chat", () => {
  it("D7/D8: tabs, the active tab and the open state survive an unmount and remount", () => {
    mount("chat-a");
    act(() => latest.open(doc("brief")));
    act(() => latest.open(doc("notes")));
    const before = latest.state;
    unmount();
    // Leaving /chat unmounts the surface; coming back restores the pane.
    mount("chat-a");
    expect(latest.state).toBe(before);
    expect(latest.state.open).toBe(true);
    expect(latest.state.tabs).toHaveLength(3);
    expect(tabRef(activeTab(latest.state))).toEqual(doc("notes"));
  });

  it("keeps each chat's pane apart, and remembers each one's open state", () => {
    mount("chat-a");
    act(() => latest.open(doc("a-only")));
    act(() => latest.setOpen(false));
    unmount();
    mount("chat-b");
    expect(latest.state.tabs).toHaveLength(1);
    expect(latest.state.open).toBe(true);
    unmount();
    mount("chat-a");
    expect(latest.state.open).toBe(false);
    expect(latest.state.tabs).toHaveLength(2);
  });

  it("a turn ending never collapses the pane: no path but the user's close does", () => {
    mount("chat-a");
    // Brian presents a document mid-turn: it opens and expands.
    act(() => {
      updateChatPane("ws", "chat-a", (state) => openInPane(state, doc("presented")));
    });
    expect(latest.state.open).toBe(true);
    // The turn ends: the surface does nothing to the pane, so it stays open.
    unmount();
    mount("chat-a");
    expect(latest.state.open).toBe(true);
    // The surface's only collapse is the pane's own close control.
    // jsdom has no file: import.meta.url; vitest runs from the app-web package.
    const surface = readFileSync(join(process.cwd(), "src/components/chat-app/chat-surface.tsx"), "utf8");
    expect(surface).not.toMatch(/setOpen\(false\)|setPaneOpen\(/);
    // Pane state never lives in a ChatSurface useState (T6 tripwire).
    expect(surface).not.toMatch(/useState<DocumentAttachment/);
    expect(surface).not.toContain("workBenchExpanded");
  });

  it("T6: a fresh pane re-keys onto the session its first send mints", () => {
    mount(null);
    act(() => latest.open(doc("first-turn")));
    unmount();
    adoptFreshChatPane("ws", "minted");
    expect(readChatPane("ws", null)).toBeNull();
    expect(readChatPane("ws", "minted")?.tabs).toHaveLength(2);
    // A new chat afterwards starts empty.
    updateChatPane("ws", null, (state) => openInPane(state, doc("stale")));
    resetFreshChatPane("ws");
    expect(readChatPane("ws", null)).toBeNull();
  });
});
