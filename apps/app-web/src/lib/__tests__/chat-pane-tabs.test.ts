import { describe, expect, it } from "vitest";
import {
  activatePaneTab,
  activeTab,
  closePaneTab,
  initPane,
  openInPane,
  paneRefId,
  paneTabCount,
  setPaneOpen,
  setPaneTabPin,
  stepPaneTab,
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
