import { describe, expect, it } from "vitest";
import {
  activatePaneTab,
  activeTab,
  closePaneTab,
  initPane,
  openInPane,
  panePinFor,
  paneRefId,
  paneTabCount,
  refreshPaneRef,
  setPaneOpen,
  setPaneTabPin,
  stepPaneTab,
  syncPinnedTabs,
  tabRef,
  updatePaneTabRef,
  WORK_TAB_KEY,
  type PaneRef,
} from "../chat-pane-tabs";

const doc = (id: string): PaneRef => ({
  kind: "document",
  document: { id, title: `Doc ${id}`, content: "body", format: "text" },
});
const page = (pageId: string): PaneRef => ({ kind: "page", pageId });
const url = (href: string): PaneRef => ({ kind: "url", url: href });

describe("[COMP:app-web/chat-pane-tabs] the side pane's tab model", () => {
  it("D6: starts with the fixed Work tab, focused, which can never close", () => {
    const state = initPane(true);
    expect(state.tabs.map((tab) => tab.key)).toEqual([WORK_TAB_KEY]);
    expect(activeTab(state).key).toBe(WORK_TAB_KEY);
    expect(closePaneTab(state, WORK_TAB_KEY)).toBe(state);
    expect(paneTabCount(state)).toBe(0);
  });

  it("D8: opening a tab expands the pane and focuses the tab", () => {
    const state = openInPane(initPane(false), doc("a"));
    expect(state.open).toBe(true);
    expect(tabRef(activeTab(state))).toEqual(doc("a"));
    // A quiet open (no reveal, no focus) leaves both alone.
    const quiet = openInPane(initPane(false), doc("b"), { focus: false, reveal: false });
    expect(quiet.open).toBe(false);
    expect(quiet.activeKey).toBe(WORK_TAB_KEY);
  });

  it("opening something already open focuses it instead of duplicating it", () => {
    let state = openInPane(initPane(true), url("https://example.com/a#top"));
    state = openInPane(state, doc("x"));
    state = openInPane(state, url("https://example.com/a/"));
    expect(state.tabs).toHaveLength(3);
    expect(paneRefId(tabRef(activeTab(state)))).toBe(paneRefId(url("https://example.com/a")));
  });

  it("keeps Work first, then pinned tabs, then open tabs", () => {
    let state = initPane(true);
    state = openInPane(state, page("p1"));
    state = openInPane(state, page("p2"));
    const second = state.tabs[2]!.key;
    state = setPaneTabPin(state, second, "pin-9");
    expect(state.tabs.map((tab) => tab.key)).toEqual([WORK_TAB_KEY, second, state.tabs[2]!.key]);
    expect(state.tabs[1]!.pinId).toBe("pin-9");
    // Work cannot be pinned (it is already fixed).
    expect(setPaneTabPin(state, WORK_TAB_KEY, "x")).toEqual({ ...state, tabs: state.tabs });
  });

  it("closing the active tab focuses its neighbour", () => {
    let state = initPane(true);
    state = openInPane(state, doc("a"));
    state = openInPane(state, doc("b"));
    state = openInPane(state, doc("c"));
    state = activatePaneTab(state, state.tabs[2]!.key);
    state = closePaneTab(state, state.activeKey);
    expect(tabRef(activeTab(state))).toEqual(doc("c"));
    state = closePaneTab(state, state.activeKey);
    expect(tabRef(activeTab(state))).toEqual(doc("a"));
  });

  it("each tab keeps its own Back / Forward history", () => {
    let state = openInPane(initPane(true), url("https://a.test/1"));
    state = openInPane(state, url("https://a.test/2"), { inPlace: true });
    state = openInPane(state, url("https://a.test/3"), { inPlace: true });
    expect(state.tabs).toHaveLength(2);
    state = stepPaneTab(state, -1);
    expect(tabRef(activeTab(state))).toEqual(url("https://a.test/2"));
    // Navigating from the middle truncates the forward history.
    state = openInPane(state, url("https://a.test/4"), { inPlace: true });
    expect(activeTab(state).history.map((r) => (r as { url: string }).url)).toEqual([
      "https://a.test/1", "https://a.test/2", "https://a.test/4",
    ]);
    expect(stepPaneTab(state, 1)).toBe(state);
  });

  it("only the user collapses: setPaneOpen is the one way, and opening never does", () => {
    const open = openInPane(initPane(true), doc("a"));
    expect(setPaneOpen(open, false).open).toBe(false);
    expect(openInPane(setPaneOpen(open, false), doc("b")).open).toBe(true);
  });

  it("updates a tab's shown reference in place, without a history entry", () => {
    let state = openInPane(initPane(true), { kind: "page", pageId: "p", title: null });
    state = updatePaneTabRef(state, state.activeKey, { kind: "page", pageId: "p", title: "Plan" });
    expect(activeTab(state).history).toEqual([{ kind: "page", pageId: "p", title: "Plan" }]);
  });
});

describe("[COMP:app-web/chat-pane-tabs] pinned tabs are the chat's pins (chat-parity D7)", () => {
  it("maps each tab kind to the pin it writes; Work, raw documents and chat uploads do not pin", () => {
    expect(panePinFor(page("pg"))).toEqual({ kind: "page", refId: "pg" });
    expect(panePinFor(url("https://a.example/x"))).toEqual({ kind: "url", url: "https://a.example/x" });
    expect(panePinFor({ kind: "file", fileId: "f1", name: "a.pdf", mime: "application/pdf", source: "durable" }))
      .toEqual({ kind: "file", refId: "f1" });
    expect(panePinFor({ kind: "file", fileId: "c1", name: "a.pdf", mime: "application/pdf" })).toBeNull();
    // A pinned browser tab saves its current URL as a url pin.
    expect(panePinFor({ kind: "browser", browserId: "h-1", url: "https://now.example/page" }))
      .toEqual({ kind: "url", url: "https://now.example/page" });
    expect(panePinFor({ kind: "browser", browserId: "computer:s", url: null })).toBeNull();
    expect(panePinFor({ kind: "work" })).toBeNull();
    expect(panePinFor(doc("d"))).toBeNull();
  });

  it("restores pins as pinned tabs first, without focusing them or opening the pane", () => {
    const start = openInPane(initPane(false), doc("open"), { reveal: false });
    const state = syncPinnedTabs(start, [
      { id: "pin-1", ref: page("pg") },
      { id: "pin-2", ref: url("https://a.example/") },
    ]);
    expect(state.tabs.map((tab) => tab.pinId ?? null)).toEqual([null, "pin-1", "pin-2", null]);
    expect(state.tabs.map((tab) => tabRef(tab).kind)).toEqual(["work", "page", "url", "document"]);
    expect(state.activeKey).toBe(start.activeKey);
    expect(state.open).toBe(false);
    // Nothing changed: the same object, so the store does not notify.
    expect(syncPinnedTabs(state, [
      { id: "pin-1", ref: page("pg") },
      { id: "pin-2", ref: url("https://a.example/") },
    ])).toBe(state);
  });

  it("adopts the open tab already showing a pin instead of opening a second", () => {
    const start = openInPane(initPane(true), url("https://a.example/doc"));
    const state = syncPinnedTabs(start, [{ id: "pin-1", ref: url("https://a.example/doc#top") }]);
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]).toMatchObject({ key: start.activeKey, pinId: "pin-1" });
  });

  it("an unpin anywhere leaves the tab open, unpinned", () => {
    const pinned = syncPinnedTabs(initPane(true), [{ id: "pin-1", ref: page("pg") }]);
    const state = syncPinnedTabs(pinned, []);
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]!.pinId).toBeNull();
  });

  it("one tab per pin: the copy restored while the pin request was in flight goes", () => {
    let state = openInPane(initPane(true), { kind: "browser", browserId: "h-1", url: "https://now.example/" });
    const browserKey = state.activeKey;
    // The pins_changed echo landed first and restored the new url pin as its own tab.
    state = syncPinnedTabs(state, [{ id: "pin-9", ref: url("https://now.example/") }]);
    expect(state.tabs).toHaveLength(3);
    state = setPaneTabPin(state, browserKey, "pin-9");
    expect(state.tabs.map((tab) => tab.key)).toEqual([WORK_TAB_KEY, browserKey]);
    expect(state.tabs[1]!.pinId).toBe("pin-9");
  });

  it("refreshes where an open browser tab is without opening one that is not", () => {
    const start = openInPane(initPane(true), { kind: "browser", browserId: "h-1", url: "https://a.example/" });
    const moved = refreshPaneRef(start, { kind: "browser", browserId: "h-1", url: "https://a.example/next", title: "Next" });
    expect(tabRef(activeTab(moved))).toEqual({ kind: "browser", browserId: "h-1", url: "https://a.example/next", title: "Next" });
    expect(refreshPaneRef(start, { kind: "browser", browserId: "h-2", url: "https://b.example/" })).toBe(start);
  });
});
