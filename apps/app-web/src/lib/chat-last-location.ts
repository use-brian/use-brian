/**
 * Per-workspace memory of WHERE the user was in the Chat operator app — the
 * Personal/Workspace audience toggle plus the open thread — so re-entering the
 * surface resumes it instead of dumping the user on a fresh Personal pane.
 *
 * **Why this exists.** Both halves of the location live in the URL (`?v=`,
 * `?s=`), which is right: a chat is linkable and the sidebar rail reads the
 * same state. But the Chat app is reached from the nav rail / Home app-bar,
 * and those target the BARE `/w/<id>/chat` — no query at all. Every surface
 * switch therefore reset the audience to Personal and closed the open thread,
 * which is the same complaint the doc tab strip had before
 * `doc-tabs-session.ts`: a surface switcher is not a browser home button.
 *
 * The remembered location is per workspace and persisted in `localStorage`
 * (not a module map like the doc strip) so it matches the sticky operator-app
 * selection it rides behind — `readOperatorApp` already resumes *which app*
 * across reloads, and resuming the app but not the place inside it reads as
 * half a memory. It is a convenience, never load-bearing: every read/write is
 * guarded and degrades to "no memory" in private mode.
 *
 * The seed rule (`seedChatLocation`) is pure and IO-free so vitest exercises
 * it directly, the same seam as `seedDocTabs`.
 *
 * [COMP:app-web/chat-last-location]
 */

export type ChatView = "personal" | "workspace";

/** Where the user was: the audience, and the open thread (`null` = a fresh pane). */
export type ChatLocation = {
  view: ChatView;
  sessionId: string | null;
};

const key = (workspaceId: string) => `sidan:chat-location:${workspaceId}`;

/** The workspace's remembered location, or `null` when there is none. */
export function readChatLocation(workspaceId: string): ChatLocation | null {
  if (typeof window === "undefined" || !workspaceId) return null;
  try {
    const raw = window.localStorage.getItem(key(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { v, s } = parsed as { v?: unknown; s?: unknown };
    return {
      view: v === "workspace" ? "workspace" : "personal",
      sessionId: typeof s === "string" && s.length > 0 ? s : null,
    };
  } catch {
    return null;
  }
}

/** Remember where the user is now (called on every location change). */
export function writeChatLocation(
  workspaceId: string,
  location: ChatLocation,
): void {
  if (typeof window === "undefined" || !workspaceId) return;
  try {
    window.localStorage.setItem(
      key(workspaceId),
      JSON.stringify({ v: location.view, s: location.sessionId }),
    );
  } catch {
    // Quota / privacy mode — re-entry degrades to a fresh Personal pane.
  }
}

/** Forget the workspace's location (a signed-out or reset surface). */
export function clearChatLocation(workspaceId: string): void {
  if (typeof window === "undefined" || !workspaceId) return;
  try {
    window.localStorage.removeItem(key(workspaceId));
  } catch {
    // Non-fatal.
  }
}

/**
 * What the surface should mount with, given the workspace's remembered
 * location and whether the URL already names one.
 *
 * `urlPinsLocation` is true when the entry URL carries `?s=`, `?v=` or the
 * fresh-chat `?assistant=` hint — a deep link, a rail row click, an in-surface
 * navigation, or an installer handoff. Those state a location outright, so the
 * URL always wins and this returns `null` (nothing to restore).
 *
 * A BARE `/w/<id>/chat` states nothing — it is how the nav rail, the Home
 * app-bar and ⌘1 spell "the Chat app" — so the remembered location wins and
 * the surface rewrites the URL to match. Returns `null` when there is nothing
 * worth restoring: no memory, or a memory of the fresh Personal pane, which is
 * already exactly what a bare URL means.
 */
export function seedChatLocation(
  stored: ChatLocation | null,
  urlPinsLocation: boolean,
): ChatLocation | null {
  if (urlPinsLocation || !stored) return null;
  if (stored.view === "personal" && !stored.sessionId) return null;
  return stored;
}
