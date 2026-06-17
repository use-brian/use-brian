/**
 * Pure tab + per-tab browse-history model for the Doc top bar.
 *
 * Notion's top "layer" carries an open-tab strip, and each tab keeps its
 * own back/forward history (the `<` `>` arrows act on the *active* tab).
 * This module is the IO-free state machine behind both — no React, no
 * router, no `localStorage` — so vitest can exercise every transition
 * directly (app-web's vitest has no jsdom; pure modules are the test
 * seam, same as `doc-page-url.ts` / `sidebar-tree.ts`).
 *
 * Shape:
 *  - A `DocTab` is a browse stack: `history` (page ids, oldest → newest)
 *    plus a `cursor` into it. The page a tab currently shows is
 *    `history[cursor]`, or `null` when the stack is empty — a blank "new
 *    tab" (Notion's `+`).
 *  - `TabsState` is the strip: `tabs` (always ≥ 1), the `activeKey`, and a
 *    monotonic `nextKey` counter so tab keys are minted **deterministically**
 *    (no `Date.now()` / `Math.random()` — keeps the reducer pure + testable).
 *
 * The *active tab's current page* is the doc surface's source of truth
 * for which page is shown; `doc-shell.tsx` mirrors it into the
 * `/p/<pageId>` URL via a one-way effect (state → `router.replace`), and the
 * existing pathname-keyed fetch loads the body. So navigation only mutates
 * this state; the URL is an output, never read back except to seed
 * `initTabs` on first mount.
 *
 * Tabs are **session-scoped** (they live on the persisted shell, surviving
 * soft `/p/[pageId]` navigation, and reset on a hard reload) — there is no
 * cross-reload persistence in v1, which sidesteps stale-id pruning and the
 * Home-link ("/p" index) restore conflict. Persisting the strip is a noted
 * follow-up in `docs/architecture/features/doc.md` → "Top bar".
 *
 * [COMP:app-web/doc-tabs]
 */

export type DocTab = {
  /** Stable, deterministic identity for this tab (`t0`, `t1`, …). */
  key: string;
  /** Visited page ids, oldest → newest. Empty = a blank "new tab". */
  history: string[];
  /** Index into `history` of the shown page; `-1` when `history` is empty. */
  cursor: number;
};

export type TabsState = {
  /** The open-tab strip, left → right. Invariant: always length ≥ 1. */
  tabs: DocTab[];
  /** The focused tab's `key`. Invariant: always references a tab in `tabs`. */
  activeKey: string;
  /** Monotonic counter feeding the next minted tab key (keeps keys pure). */
  nextKey: number;
};

/** The page a tab currently shows, or `null` for a blank tab. */
export function tabPageId(tab: DocTab): string | null {
  return tab.cursor >= 0 && tab.cursor < tab.history.length
    ? tab.history[tab.cursor]
    : null;
}

/** The focused tab (falls back to the first to keep the invariant total). */
export function getActiveTab(state: TabsState): DocTab {
  return state.tabs.find((t) => t.key === state.activeKey) ?? state.tabs[0];
}

/** The page the surface should show — the active tab's current page. */
export function activePageId(state: TabsState): string | null {
  return tabPageId(getActiveTab(state));
}

/** Whether the active tab has an older entry to step back to. */
export function canGoBack(state: TabsState): boolean {
  return getActiveTab(state).cursor > 0;
}

/** Whether the active tab has a newer entry to step forward to. */
export function canGoForward(state: TabsState): boolean {
  const t = getActiveTab(state);
  return t.cursor < t.history.length - 1;
}

/** A fresh tab — seeded with `pageId`, or blank when `pageId` is null. */
function makeTab(key: string, pageId: string | null): DocTab {
  return pageId
    ? { key, history: [pageId], cursor: 0 }
    : { key, history: [], cursor: -1 };
}

/** Seed state with a single tab for the URL's page (blank at the `/p` index). */
export function initTabs(pageId: string | null): TabsState {
  const key = "t0";
  return { tabs: [makeTab(key, pageId)], activeKey: key, nextKey: 1 };
}

/** Replace the active tab in the strip with `next` (identity-preserving). */
function withActive(state: TabsState, next: DocTab): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.key === next.key ? next : t)),
  };
}

/**
 * Navigate the active tab to `pageId` (Notion: a page click moves the
 * current tab, it does not spawn a new one). Truncates any forward history
 * — the classic browser model — then pushes. A no-op (same state ref, so
 * React skips the render + the URL replace) when the tab already shows it.
 */
export function openPage(state: TabsState, pageId: string): TabsState {
  const active = getActiveTab(state);
  if (tabPageId(active) === pageId) return state;
  const history = [...active.history.slice(0, active.cursor + 1), pageId];
  return withActive(state, { ...active, history, cursor: history.length - 1 });
}

/**
 * Blank the active tab — clear it to an empty "new tab" (no page). Used by
 * the breadcrumb's workspace-home crumb and when an external navigation
 * lands on the `/p` index (null page). Wipes that tab's history — you're
 * going to a clean home — while keeping the tab (and the strip) in place.
 * A no-op (same ref) when the active tab is already blank.
 */
export function blankActiveTab(state: TabsState): TabsState {
  const active = getActiveTab(state);
  if (tabPageId(active) === null) return state;
  return withActive(state, { ...active, history: [], cursor: -1 });
}

/** Open a fresh blank tab to the right and focus it (the `+` button). */
export function newTab(state: TabsState): TabsState {
  const key = `t${state.nextKey}`;
  return {
    tabs: [...state.tabs, makeTab(key, null)],
    activeKey: key,
    nextKey: state.nextKey + 1,
  };
}

/** Focus an existing tab by key (no-op if it's unknown or already active). */
export function switchTab(state: TabsState, key: string): TabsState {
  if (key === state.activeKey || !state.tabs.some((t) => t.key === key)) {
    return state;
  }
  return { ...state, activeKey: key };
}

/**
 * Close a tab. Closing the *last* tab resets it to a fresh blank tab so the
 * strip is never empty (Notion always keeps ≥ 1 tab). When the closed tab
 * was active, focus shifts to its right neighbour, else the new last tab.
 */
export function closeTab(state: TabsState, key: string): TabsState {
  const idx = state.tabs.findIndex((t) => t.key === key);
  if (idx === -1) return state;
  if (state.tabs.length === 1) {
    const k = `t${state.nextKey}`;
    return { tabs: [makeTab(k, null)], activeKey: k, nextKey: state.nextKey + 1 };
  }
  const tabs = state.tabs.filter((t) => t.key !== key);
  let activeKey = state.activeKey;
  if (key === state.activeKey) {
    // The tab now sitting at `idx` is the old right neighbour; if we closed
    // the last tab, clamp to the new last (the old left neighbour).
    activeKey = tabs[Math.min(idx, tabs.length - 1)].key;
  }
  return { ...state, tabs, activeKey };
}

/** Step the active tab one entry back in its history. */
export function back(state: TabsState): TabsState {
  const active = getActiveTab(state);
  if (active.cursor <= 0) return state;
  return withActive(state, { ...active, cursor: active.cursor - 1 });
}

/** Step the active tab one entry forward in its history. */
export function forward(state: TabsState): TabsState {
  const active = getActiveTab(state);
  if (active.cursor >= active.history.length - 1) return state;
  return withActive(state, { ...active, cursor: active.cursor + 1 });
}

/**
 * Scrub a deleted page from every tab's history (a deleted page must never
 * remain reachable via a tab or a back/forward step). Each tab's cursor is
 * pulled back by however many of its at-or-before-cursor entries were the
 * deleted id, then clamped — so a tab showing the deleted page lands on its
 * previous entry, or becomes blank if that was its only page.
 */
export function dropPage(state: TabsState, pageId: string): TabsState {
  const tabs = state.tabs.map((tab) => {
    if (!tab.history.includes(pageId)) return tab;
    const removedAtOrBefore = tab.history
      .slice(0, tab.cursor + 1)
      .filter((id) => id === pageId).length;
    const history = tab.history.filter((id) => id !== pageId);
    let cursor = tab.cursor - removedAtOrBefore;
    if (history.length === 0) cursor = -1;
    else cursor = Math.max(0, Math.min(cursor, history.length - 1));
    return { ...tab, history, cursor };
  });
  return { ...state, tabs };
}
