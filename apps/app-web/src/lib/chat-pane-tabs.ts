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
 *  `browser`, `page`, `file`, `document`, `url`. */
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
  | { kind: "url"; url: string; title?: string | null };

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
};

export const WORK_TAB_KEY = "work";

/** A fresh pane: just the Work tab. `open` is the caller's seed (phones start closed). */
export function initPane(open: boolean): ChatPaneState {
  return {
    tabs: [{ key: WORK_TAB_KEY, history: [{ kind: "work" }], cursor: 0 }],
    activeKey: WORK_TAB_KEY,
    nextKey: 0,
    open,
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
  return state.open === open ? state : { ...state, open };
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
 * keeping the strip's fixed order.
 */
export function setPaneTabPin(state: ChatPaneState, key: string, pinId: string | null): ChatPaneState {
  if (key === WORK_TAB_KEY) return state;
  const tabs = state.tabs.map((tab) => (tab.key === key ? { ...tab, pinId } : tab));
  return { ...state, tabs: ordered(tabs) };
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

/** How many tabs the header badge counts: everything but Work. */
export function paneTabCount(state: ChatPaneState): number {
  return state.tabs.length - 1;
}
