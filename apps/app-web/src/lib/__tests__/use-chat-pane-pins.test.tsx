// @vitest-environment jsdom
/**
 * [COMP:app-web/chat-pane-pins] Pins as durable tabs (chat-parity D7): the
 * chat's pins restore as pinned tabs, "Pin tab" writes the matching
 * `session_pins` row, unpinning deletes it, and `pins_changed` reconciles.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listSessionPins: vi.fn(),
  addSessionPin: vi.fn(),
  removeSessionPin: vi.fn(),
}));
vi.mock("@/lib/api/session-pins", () => api);

import { readChatPane, resetChatPaneSession, useChatPane, type ChatPane } from "../chat-pane-session";
import { tabRef, type PaneTab } from "../chat-pane-tabs";
import { useChatPanePins, type ChatPanePins } from "../use-chat-pane-pins";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, kind: string, extra: Record<string, unknown>) => ({
  id, kind, refId: null, url: null, text: null, label: null, position: 0,
  addedByUserId: "u-1", addedByAssistantId: null, addedByName: "Ana", createdAt: "2026-10-10T00:00:00Z",
  ...extra,
});

let root: Root;
let pane: ChatPane;
let pins: ChatPanePins | null;
const onChanged = vi.fn();
function Harness({ sessionId, enabled, refreshKey }: { sessionId: string | null; enabled: boolean; refreshKey: number }) {
  pane = useChatPane("ws", sessionId, () => true);
  pins = useChatPanePins({ workspaceId: "ws", sessionId, enabled, refreshKey, onChanged });
  return null;
}
async function render(props: { sessionId: string | null; enabled?: boolean; refreshKey?: number }) {
  await act(async () => {
    root.render(createElement(Harness, { enabled: true, refreshKey: 0, ...props }));
  });
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const tabOf = (predicate: (tab: PaneTab) => boolean) => pane.state.tabs.find(predicate)!;

beforeEach(() => {
  resetChatPaneSession();
  root = createRoot(document.createElement("div"));
  api.listSessionPins.mockReset().mockResolvedValue([]);
  api.addSessionPin.mockReset();
  api.removeSessionPin.mockReset().mockResolvedValue(undefined);
  onChanged.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("[COMP:app-web/chat-pane-pins] pinned tabs are the chat's pins (D7)", () => {
  it("restores page, file and URL pins as pinned tabs first; unavailable and other kinds get none", async () => {
    api.listSessionPins.mockResolvedValue([
      row("pin-page", "page", { refId: "pg-1", label: "Plan" }),
      row("pin-file", "file", { refId: "f-1", label: "deck.pdf" }),
      row("pin-url", "url", { url: "https://a.example/", label: null }),
      row("pin-gone", "page", { refId: "pg-2", label: null }),
      row("pin-task", "task", { refId: "t-1", label: "Ship" }),
    ]);
    await render({ sessionId: "chat-a" });
    await settle();
    const restored = pane.state.tabs.slice(1);
    expect(restored.map((tab) => [tab.pinId, tabRef(tab).kind])).toEqual([
      ["pin-page", "page"], ["pin-file", "file"], ["pin-url", "url"],
    ]);
    expect(tabRef(restored[1]!)).toMatchObject({ fileId: "f-1", name: "deck.pdf", mime: "application/pdf", source: "durable" });
    // Restoring neither focuses a tab nor changes whether the pane is open.
    expect(pane.state.activeKey).toBe("work");
  });

  it("pinning a page tab in a personal chat writes its session_pins row and marks the tab", async () => {
    // The server now lists the row: the reload after the pin keeps it pinned.
    api.addSessionPin.mockImplementation(async () => {
      api.listSessionPins.mockResolvedValue([row("pin-new", "page", { refId: "pg-1", label: "Plan" })]);
      return { id: "pin-new" };
    });
    await render({ sessionId: "chat-a" });
    act(() => pane.open({ kind: "page", pageId: "pg-1", title: "Plan" }));
    const tab = tabOf((entry) => tabRef(entry).kind === "page");
    expect(pins!.pinnable(tab)).toBe(true);
    await act(async () => pins!.toggle(tab));
    await settle();
    expect(api.addSessionPin).toHaveBeenCalledWith("chat-a", { kind: "page", refId: "pg-1" });
    expect(tabOf((entry) => entry.key === tab.key).pinId).toBe("pin-new");
    expect(pane.state.tabs).toHaveLength(2);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("a pinned browser tab saves its current URL as a url pin", async () => {
    api.addSessionPin.mockResolvedValue({ id: "pin-url" });
    await render({ sessionId: "chat-a" });
    act(() => pane.open({ kind: "browser", browserId: "h-1", url: "https://now.example/page" }));
    await act(async () => pins!.toggle(tabOf((entry) => tabRef(entry).kind === "browser")));
    await settle();
    expect(api.addSessionPin).toHaveBeenCalledWith("chat-a", { kind: "url", url: "https://now.example/page" });
  });

  it("unpinning deletes the row and leaves the tab open", async () => {
    api.listSessionPins.mockResolvedValue([row("pin-page", "page", { refId: "pg-1", label: "Plan" })]);
    await render({ sessionId: "chat-a" });
    await settle();
    api.listSessionPins.mockResolvedValue([]);
    const tab = tabOf((entry) => entry.pinId === "pin-page");
    await act(async () => pins!.toggle(tab));
    await settle();
    expect(api.removeSessionPin).toHaveBeenCalledWith("chat-a", "pin-page");
    expect(tabOf((entry) => entry.key === tab.key).pinId).toBeNull();
  });

  it("pins_changed reconciles: a teammate's pin appears, a removed one unpins", async () => {
    api.listSessionPins.mockResolvedValue([row("pin-a", "url", { url: "https://a.example/", label: "A" })]);
    await render({ sessionId: "room-1" });
    await settle();
    api.listSessionPins.mockResolvedValue([row("pin-b", "page", { refId: "pg-9", label: "Their page" })]);
    await render({ sessionId: "room-1", refreshKey: 1 });
    await settle();
    expect(pane.state.tabs.map((tab) => tab.pinId ?? null)).toEqual([null, "pin-b", null]);
  });

  it("a failed pin marks the tab and writes nothing", async () => {
    api.addSessionPin.mockRejectedValue(new Error("Pin failed: 500"));
    await render({ sessionId: "chat-a" });
    act(() => pane.open({ kind: "url", url: "https://a.example/" }));
    const tab = tabOf((entry) => tabRef(entry).kind === "url");
    await act(async () => pins!.toggle(tab));
    await settle();
    expect(pins!.failedKey).toBe(tab.key);
    expect(tabOf((entry) => entry.key === tab.key).pinId ?? null).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("offers nothing before the chat has a session, or where the policy has no pins", async () => {
    await render({ sessionId: null });
    expect(pins).toBeNull();
    await render({ sessionId: "chat-a", enabled: false });
    expect(pins).toBeNull();
    expect(api.listSessionPins).not.toHaveBeenCalled();
    expect(readChatPane("ws", "chat-a")!.tabs).toHaveLength(1);
  });
});
