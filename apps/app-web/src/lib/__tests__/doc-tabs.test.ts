/**
 * [COMP:app-web/doc-tabs] Tab strip + per-tab browse-history reducer.
 *
 * Pure state-machine tests — no React, no router. Each block exercises one
 * transition (open / new / switch / close / back / forward / drop) plus the
 * derived selectors (`activePageId`, `canGoBack`, `canGoForward`) that drive
 * the top bar's enabled/disabled arrows.
 */

import { describe, expect, it } from "vitest";
import {
  activePageId,
  back,
  blankActiveTab,
  canGoBack,
  canGoForward,
  closeTab,
  dropPage,
  forward,
  getActiveTab,
  initTabs,
  newTab,
  openPage,
  switchTab,
  tabPageId,
} from "../doc-tabs";

describe("[COMP:app-web/doc-tabs] Doc tabs reducer", () => {
  describe("initTabs", () => {
    it("seeds one tab for the URL page", () => {
      const s = initTabs("a");
      expect(s.tabs).toHaveLength(1);
      expect(activePageId(s)).toBe("a");
      expect(s.activeKey).toBe("t0");
    });

    it("seeds one blank tab at the /p index (null page)", () => {
      const s = initTabs(null);
      expect(s.tabs).toHaveLength(1);
      expect(activePageId(s)).toBeNull();
      expect(getActiveTab(s).cursor).toBe(-1);
    });
  });

  describe("openPage", () => {
    it("fills a blank tab", () => {
      const s = openPage(initTabs(null), "a");
      expect(activePageId(s)).toBe("a");
      expect(getActiveTab(s).history).toEqual(["a"]);
    });

    it("pushes onto history and advances the cursor", () => {
      let s = initTabs("a");
      s = openPage(s, "b");
      expect(activePageId(s)).toBe("b");
      expect(getActiveTab(s).history).toEqual(["a", "b"]);
      expect(canGoBack(s)).toBe(true);
      expect(canGoForward(s)).toBe(false);
    });

    it("is a no-op (same ref) when already on the page", () => {
      const s = initTabs("a");
      expect(openPage(s, "a")).toBe(s);
    });

    it("truncates forward history when navigating after going back", () => {
      let s = initTabs("a");
      s = openPage(s, "b");
      s = openPage(s, "c"); // [a,b,c]
      s = back(s); // at b
      s = openPage(s, "d"); // forward (c) dropped → [a,b,d]
      expect(getActiveTab(s).history).toEqual(["a", "b", "d"]);
      expect(canGoForward(s)).toBe(false);
    });

    it("navigates only the active tab, never spawning a new one", () => {
      let s = newTab(initTabs("a")); // two tabs; tab 2 active + blank
      s = openPage(s, "b");
      expect(s.tabs).toHaveLength(2);
      expect(tabPageId(s.tabs[0])).toBe("a"); // first tab untouched
      expect(tabPageId(s.tabs[1])).toBe("b");
    });
  });

  describe("newTab / switchTab", () => {
    it("opens a blank tab to the right and focuses it", () => {
      const s = newTab(initTabs("a"));
      expect(s.tabs).toHaveLength(2);
      expect(s.activeKey).toBe(s.tabs[1].key);
      expect(activePageId(s)).toBeNull();
    });

    it("mints deterministic, unique keys", () => {
      let s = newTab(initTabs("a"));
      s = newTab(s);
      expect(s.tabs.map((t) => t.key)).toEqual(["t0", "t1", "t2"]);
    });

    it("switches focus and the shown page follows the target tab", () => {
      let s = openPage(initTabs("a"), "b"); // tab t0 → b
      const firstKey = s.activeKey;
      s = newTab(s); // tab t1 (blank) active
      s = openPage(s, "c");
      s = switchTab(s, firstKey);
      expect(activePageId(s)).toBe("b");
    });

    it("switchTab is a no-op for an unknown or already-active key", () => {
      const s = initTabs("a");
      expect(switchTab(s, "nope")).toBe(s);
      expect(switchTab(s, s.activeKey)).toBe(s);
    });
  });

  describe("closeTab", () => {
    it("closing the only tab leaves one fresh blank tab", () => {
      const s = closeTab(initTabs("a"), "t0");
      expect(s.tabs).toHaveLength(1);
      expect(activePageId(s)).toBeNull();
      expect(s.tabs[0].key).not.toBe("t0"); // a brand-new key, not the closed one
    });

    it("closing the active tab focuses the right neighbour", () => {
      let s = newTab(initTabs("a")); // [t0:a, t1:blank], t1 active
      s = openPage(s, "b"); // t1 → b
      s = newTab(s); // [t0:a, t1:b, t2:blank], t2 active
      s = openPage(s, "c"); // t2 → c
      s = switchTab(s, "t1"); // focus the middle
      s = closeTab(s, "t1");
      expect(s.tabs.map((t) => t.key)).toEqual(["t0", "t2"]);
      expect(s.activeKey).toBe("t2"); // right neighbour took focus
      expect(activePageId(s)).toBe("c");
    });

    it("closing the active last tab falls back to the left neighbour", () => {
      let s = newTab(initTabs("a"));
      s = openPage(s, "b"); // [t0:a, t1:b], t1 active (last)
      s = closeTab(s, "t1");
      expect(s.tabs.map((t) => t.key)).toEqual(["t0"]);
      expect(s.activeKey).toBe("t0");
      expect(activePageId(s)).toBe("a");
    });

    it("closing an inactive tab keeps focus put", () => {
      let s = newTab(initTabs("a")); // t1 active
      s = openPage(s, "b");
      s = closeTab(s, "t0"); // close the inactive first tab
      expect(s.tabs.map((t) => t.key)).toEqual(["t1"]);
      expect(s.activeKey).toBe("t1");
    });
  });

  describe("blankActiveTab", () => {
    it("clears the active tab to a blank tab and wipes its history", () => {
      let s = openPage(initTabs("a"), "b"); // [a,b] at b
      s = blankActiveTab(s);
      expect(activePageId(s)).toBeNull();
      expect(getActiveTab(s).history).toEqual([]);
      expect(canGoBack(s)).toBe(false);
    });

    it("leaves other tabs untouched", () => {
      let s = openPage(initTabs("a"), "b"); // t0: [a,b]
      s = newTab(s); // t1 blank active
      s = openPage(s, "c"); // t1: [c]
      s = blankActiveTab(s); // blank t1
      expect(tabPageId(s.tabs[0])).toBe("b"); // t0 untouched
      expect(activePageId(s)).toBeNull();
    });

    it("is a no-op (same ref) when the active tab is already blank", () => {
      const s = initTabs(null);
      expect(blankActiveTab(s)).toBe(s);
    });
  });

  describe("back / forward", () => {
    it("steps through history without mutating it", () => {
      let s = openPage(openPage(initTabs("a"), "b"), "c"); // [a,b,c] at c
      s = back(s);
      expect(activePageId(s)).toBe("b");
      expect(canGoForward(s)).toBe(true);
      s = back(s);
      expect(activePageId(s)).toBe("a");
      expect(canGoBack(s)).toBe(false);
      s = forward(s);
      expect(activePageId(s)).toBe("b");
      expect(getActiveTab(s).history).toEqual(["a", "b", "c"]);
    });

    it("back at the start / forward at the end are no-ops (same ref)", () => {
      const s = initTabs("a");
      expect(back(s)).toBe(s);
      expect(forward(s)).toBe(s);
    });
  });

  describe("dropPage", () => {
    it("removes a deleted page and lands the tab on its previous entry", () => {
      let s = openPage(openPage(initTabs("a"), "b"), "c"); // [a,b,c] at c
      s = back(s); // at b
      s = dropPage(s, "b");
      expect(getActiveTab(s).history).toEqual(["a", "c"]);
      expect(activePageId(s)).toBe("a"); // stepped back off the deleted page
    });

    it("blanks a tab whose only page was deleted", () => {
      const s = dropPage(initTabs("a"), "a");
      expect(getActiveTab(s).history).toEqual([]);
      expect(activePageId(s)).toBeNull();
    });

    it("scrubs the page from every tab, not just the active one", () => {
      let s = openPage(initTabs("x"), "shared"); // t0: [x, shared] at shared
      s = newTab(s); // t1 blank, active
      s = openPage(s, "shared"); // t1: [shared]
      s = dropPage(s, "shared");
      expect(tabPageId(s.tabs[0])).toBe("x"); // t0 stepped back to x
      expect(tabPageId(s.tabs[1])).toBeNull(); // t1 blanked
    });

    it("keeps the cursor put when the deleted page was only ahead", () => {
      let s = openPage(openPage(initTabs("a"), "b"), "c"); // [a,b,c] at c
      s = back(s);
      s = back(s); // at a, with b,c ahead
      s = dropPage(s, "c");
      expect(getActiveTab(s).history).toEqual(["a", "b"]);
      expect(activePageId(s)).toBe("a"); // unmoved — deletion was ahead
    });
  });
});
