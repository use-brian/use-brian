/**
 * Pure tab model for the Chat side pane (chat-parity D4-D6, T6).
 *
 * The doc top bar's tab reducer (`doc-tabs.ts`) generalised from page ids to
 * typed references: a tab shows one `PaneRef` (a Brian page, a file, a raw
 * document, a web link, the live browser) and keeps its own browse history,
 * so following a link inside a page or web tab is Back-able without opening a
 * new tab. The **Work** tab (Live work, Stop, worker runs, pins) is fixed:
 * always first, never closed, the default.
 *
 * IO-free and React-free, with deterministic keys (no `Date.now()` /
 * `Math.random()`), so vitest exercises every transition directly. Where the
 * state lives (per chat, outside React) is `chat-pane-session.ts`.
 *
 * Spec: docs/architecture/features/chat-app.md -> "Side pane".
 *
 * [COMP:app-web/chat-pane-tabs]
 */

import type { DocumentAttachment } from "@use-brian/chat-ui";

/** What a tab shows: one variant per kind the pane holds (D5): `work`,
 *  `browser`, `page`, `file`, `document`, `url`, `research`. */
export type PaneRef =
  | { kind: "work" }
  /** A live browser tab: the desktop native view, or the web cloud frame. */
  | { kind: "browser"; browserId: string; url?: string | null; title?: string | null }
  /** A Brian page, editable in place. */
  | { kind: "page"; pageId: string; title?: string | null }
  /**
   * A file preview: a stored workspace file by id, or a just-attached one by
   * its data URL. `mime` and `name` pick the body (PDF / Office / image).
   */
  | {
      kind: "file";
      fileId: string | null;
      name: string;
      mime: string;
      dataUrl?: string | null;
      /** `cache`: a chat upload; `durable`: a stored workspace file. Default cache. */
      source?: "cache" | "durable";
    }
  /** A raw document a turn presented (`document_payload`). */
  | { kind: "document"; document: DocumentAttachment }
  /** A web link. */
  | { kind: "url"; url: string; title?: string | null }
  /** A saved research result's detail (features/research.md -> "UI"). */
  | { kind: "research"; activityId: string };

export type PaneTab = {
  /** `work` for the fixed tab; otherwise deterministic `p0`, `p1`, … */
  key: string;
  /** References shown in this tab, oldest → newest. Never empty. */
  history: PaneRef[];
  /** Index into `history` of the shown reference. */
  cursor: number;
  /**
   * The `session_pins` row this tab is pinned as (D7), when it is. A pinned
   * tab sits before the unpinned ones and is restored when the chat opens.
   */
  pinId?: string | null;
};

export type ChatPaneState = {
  /** Work first, then pinned tabs, then open tabs. Invariant: `tabs[0]` is Work. */
  tabs: PaneTab[];
  /** The focused tab's key. Invariant: references a tab in `tabs`. */
  activeKey: string;
  /** Monotonic counter feeding the next minted key. */
  nextKey: number;
  /** Whether the pane is expanded (D8). Only the user closes it. */
  open: boolean;
  /** Explicit full view; ordinary opens always start beside Chat. */
  fullView: boolean;
};

export const WORK_TAB_KEY = "work";

/** A fresh pane: just the Work tab, closed until opened. */
export function initPane(open = false): ChatPaneState {
  return {
    tabs: [{ key: WORK_TAB_KEY, history: [{ kind: "work" }], cursor: 0 }],
    activeKey: WORK_TAB_KEY,
    nextKey: 0,
    open,
    fullView: false,
  };
}

/** The reference a tab currently shows. */
export function tabRef(tab: PaneTab): PaneRef {
  return tab.history[Math.min(Math.max(tab.cursor, 0), tab.history.length - 1)]!;
}

export function activeTab(state: ChatPaneState): PaneTab {
  return state.tabs.find((tab) => tab.key === state.activeKey) ?? state.tabs[0]!;
}

/**
 * A reference's identity: opening something already open focuses that tab
 * instead of duplicating it. URLs compare without their fragment and with a
 * trailing slash dropped.
 */
export function paneRefId(ref: PaneRef): string {
  switch (ref.kind) {
    case "work":
      return "work";
    case "browser":
      return `browser:${ref.browserId}`;
    case "page":
      return `page:${ref.pageId}`;
    case "file":
      return `file:${ref.fileId ?? `${ref.name}:${ref.dataUrl?.length ?? 0}`}`;
    case "document":
      return `document:${ref.document.id}`;
    case "url":
      return `url:${normalizePaneUrl(ref.url)}`;
    case "research":
      return `research:${ref.activityId}`;
  }
}

function normalizePaneUrl(url: string): string {
  const withoutHash = url.split("#")[0] ?? url;
  try {
    const parsed = new URL(withoutHash);
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return withoutHash;
  }
}

/** Keep the strip in its fixed order: Work, then pinned, then open tabs. */
function ordered(tabs: PaneTab[]): PaneTab[] {
  const work = tabs.filter((tab) => tab.key === WORK_TAB_KEY);
  const pinned = tabs.filter((tab) => tab.key !== WORK_TAB_KEY && tab.pinId);
  const open = tabs.filter((tab) => tab.key !== WORK_TAB_KEY && !tab.pinId);
  return [...work, ...pinned, ...open];
}

export type OpenOptions = {
  /** Focus the tab (default true). Brian opening a tab focuses it too (D8). */
  focus?: boolean;
  /** Expand the pane (default true): opening something shows it (D8). */
  reveal?: boolean;
  /** Navigate the active non-Work tab instead of opening a new one. */
  inPlace?: boolean;
};

/**
 * Open a reference. Already open → focus that tab (and refresh its shown
 * reference, which may carry a newer title or URL). Otherwise a new tab is
 * minted at the end of the open tabs, or, with `inPlace`, the active tab
 * navigates (its forward history is truncated, as in a browser).
 */
export function openInPane(
  state: ChatPaneState,
  ref: PaneRef,
  options: OpenOptions = {},
): ChatPaneState {
  const focus = options.focus ?? true;
  const reveal = options.reveal ?? true;
  if (ref.kind === "work") {
    return { ...state, activeKey: focus ? WORK_TAB_KEY : state.activeKey, open: reveal ? true : state.open };
  }
  const id = paneRefId(ref);
  const existing = state.tabs.find((tab) => tab.key !== WORK_TAB_KEY && paneRefId(tabRef(tab)) === id);
  if (existing) {
    const tabs = state.tabs.map((tab) =>
      tab === existing
        ? { ...tab, history: tab.history.map((entry, i) => (i === tab.cursor ? ref : entry)) }
        : tab,
    );
    return {
      ...state,
      tabs,
      activeKey: focus ? existing.key : state.activeKey,
      open: reveal ? true : state.open,
    };
  }
  const active = activeTab(state);
  if (options.inPlace && active.key !== WORK_TAB_KEY && !active.pinId) {
    const history = [...active.history.slice(0, active.cursor + 1), ref];
    const tabs = state.tabs.map((tab) =>
      tab.key === active.key ? { ...tab, history, cursor: history.length - 1 } : tab,
    );
    return { ...state, tabs, open: reveal ? true : state.open };
  }
  const key = `p${state.nextKey}`;
  const tab: PaneTab = { key, history: [ref], cursor: 0 };
  return {
    ...state,
    tabs: ordered([...state.tabs, tab]),
    activeKey: focus ? key : state.activeKey,
    nextKey: state.nextKey + 1,
    open: reveal ? true : state.open,
  };
}

/** Focus a tab. Unknown keys are ignored. */
export function activatePaneTab(state: ChatPaneState, key: string): ChatPaneState {
  if (!state.tabs.some((tab) => tab.key === key)) return state;
  return { ...state, activeKey: key };
}

/**
 * Close a tab. The Work tab cannot be closed (D6). Closing the active tab
 * focuses its right neighbour, else its left one.
 */
export function closePaneTab(state: ChatPaneState, key: string): ChatPaneState {
  if (key === WORK_TAB_KEY) return state;
  const index = state.tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.key !== key);
  if (state.activeKey !== key) return { ...state, tabs };
  const next = tabs[index] ?? tabs[index - 1] ?? tabs[0]!;
  return { ...state, tabs, activeKey: next.key };
}

/** Expand or collapse the pane. Only a user action calls this with `false` (D8). */
export function setPaneOpen(state: ChatPaneState, open: boolean): ChatPaneState {
  return state.open === open ? state : { ...state, open, fullView: open ? state.fullView : false };
}

/** Full view changes layout only; tabs and their bodies stay mounted. */
export function setPaneFullView(state: ChatPaneState, fullView: boolean): ChatPaneState {
  if (!state.open || state.fullView === fullView) return state;
  return { ...state, fullView };
}

export function canGoBackInTab(tab: PaneTab): boolean {
  return tab.cursor > 0;
}

export function canGoForwardInTab(tab: PaneTab): boolean {
  return tab.cursor < tab.history.length - 1;
}

/** Back / forward inside the active tab's own history. */
export function stepPaneTab(state: ChatPaneState, delta: -1 | 1): ChatPaneState {
  const active = activeTab(state);
  const cursor = active.cursor + delta;
  if (cursor < 0 || cursor >= active.history.length) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.key === active.key ? { ...tab, cursor } : tab)),
  };
}

/**
 * Mark a tab pinned (with its `session_pins` row id) or unpinned (`null`),
 * keeping the strip's fixed order. One tab per pin: a copy of the same pin
 * that `syncPinnedTabs` restored while the pin request was in flight goes.
 */
export function setPaneTabPin(state: ChatPaneState, key: string, pinId: string | null): ChatPaneState {
  if (key === WORK_TAB_KEY || !state.tabs.some((tab) => tab.key === key)) return state;
  const tabs = state.tabs
    .filter((tab) => tab.key === key || !pinId || tab.pinId !== pinId)
    .map((tab) => (tab.key === key ? { ...tab, pinId } : tab));
  const activeKey = tabs.some((tab) => tab.key === state.activeKey) ? state.activeKey : key;
  return { ...state, tabs: ordered(tabs), activeKey };
}

/** The `session_pins` row a tab pins as (D7). */
export type PanePin = { kind: "page" | "file"; refId: string } | { kind: "url"; url: string };

function webUrl(url: string | null | undefined): url is string {
  try {
    const protocol = new URL(url ?? "").protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * What pinning a reference writes (D7), or null when it cannot be pinned: a
 * page by id; a stored workspace file by id (a chat upload is no durable
 * reference); a web link; a browser tab as its current URL. Work and raw
 * documents do not pin.
 */
export function panePinFor(ref: PaneRef): PanePin | null {
  switch (ref.kind) {
    case "page":
      return { kind: "page", refId: ref.pageId };
    case "file":
      return ref.source === "durable" && ref.fileId ? { kind: "file", refId: ref.fileId } : null;
    case "url":
      return webUrl(ref.url) ? { kind: "url", url: ref.url } : null;
    case "browser":
      return webUrl(ref.url) ? { kind: "url", url: ref.url } : null;
    default:
      return null;
  }
}

/**
 * Reconcile the strip with the chat's pins (D7): each pin is one pinned tab.
 * A pin no tab carries adopts the open tab already showing it, or is
 * restored as a new pinned tab, unfocused and without expanding the pane. A
 * tab whose pin is gone (unpinned here or on another device) stays open,
 * unpinned. A second pin of something a pinned tab already shows gets no
 * tab of its own. Returns `state` itself when nothing changes.
 */
export function syncPinnedTabs(
  state: ChatPaneState,
  pins: ReadonlyArray<{ id: string; ref: PaneRef }>,
): ChatPaneState {
  const ids = new Set(pins.map((pin) => pin.id));
  let changed = false;
  let tabs = state.tabs.map((tab) => {
    if (!tab.pinId || ids.has(tab.pinId)) return tab;
    changed = true;
    return { ...tab, pinId: null };
  });
  let nextKey = state.nextKey;
  for (const pin of pins) {
    if (tabs.some((tab) => tab.pinId === pin.id)) continue;
    const id = paneRefId(pin.ref);
    const showing = tabs.filter((tab) => tab.key !== WORK_TAB_KEY && paneRefId(tabRef(tab)) === id);
    if (showing.some((tab) => tab.pinId)) continue;
    changed = true;
    const open = showing[0];
    if (open) {
      tabs = tabs.map((tab) => (tab === open ? { ...tab, pinId: pin.id } : tab));
    } else {
      tabs = [...tabs, { key: `p${nextKey}`, history: [pin.ref], cursor: 0, pinId: pin.id }];
      nextKey += 1;
    }
  }
  return changed ? { ...state, tabs: ordered(tabs), nextKey } : state;
}

/**
 * Replace a tab's shown reference in place (no history entry): a page's
 * title resolving, a browser tab moving to another URL on its own.
 */
export function updatePaneTabRef(state: ChatPaneState, key: string, ref: PaneRef): ChatPaneState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.key === key
        ? { ...tab, history: tab.history.map((entry, i) => (i === tab.cursor ? ref : entry)) }
        : tab,
    ),
  };
}

/**
 * Refresh the reference an open tab shows (same identity: a browser tab's
 * new URL or title) without focusing it or opening the pane. Nothing open
 * shows it: no change.
 */
export function refreshPaneRef(state: ChatPaneState, ref: PaneRef): ChatPaneState {
  const id = paneRefId(ref);
  const tab = state.tabs.find((entry) => entry.key !== WORK_TAB_KEY && paneRefId(tabRef(entry)) === id);
  return tab ? updatePaneTabRef(state, tab.key, ref) : state;
}

/** How many tabs the header badge counts: everything but Work. */
export function paneTabCount(state: ChatPaneState): number {
  return state.tabs.length - 1;
}
