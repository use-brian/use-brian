/**
 * Tiny event bus telling the Chat app's session rail to re-fetch. Mirrors
 * `assistant-events.ts` / `approvals-events.ts`.
 *
 * Load-bearing because the rail and the transcript are now two components
 * with no shared parent state: the session list lives in the left sidebar
 * panel (`sidebar-panels/chat-sidebar-panel.tsx`, mounted by the persistent
 * `DocSidebar`) while the actions that CHANGE the list — a fresh session
 * adopted mid-turn, a turn completing (auto-title), a shared chat started,
 * a rename/delete from either side — happen in the surface
 * (`chat-app/chat-surface.tsx`) or in the panel itself. Neither remounts
 * when the other acts, so a mount-effect fetch alone goes stale; both sides
 * dispatch here and both re-fetch on it. Payloads are signals, never data:
 * subscribers re-fetch through their own authed loader.
 *
 * Same-tab only for now — there is no server-side `session` workspace
 * primitive. If one lands, route it through `workspace-events.ts` to this
 * event, the way `assistant` routes to `ASSISTANT_REFRESH_EVENT`.
 */

export const CHAT_SESSIONS_REFRESH_EVENT = "sidan:chat-sessions-refresh";
export const CHAT_SESSION_ACTIVITY_EVENT = "sidan:chat-session-activity";

type ChatSessionsRefreshDetail = {
  /** Scopes the refresh to a specific workspace. */
  workspaceId: string | null;
};

export function dispatchChatSessionsRefresh(workspaceId: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ChatSessionsRefreshDetail>(CHAT_SESSIONS_REFRESH_EVENT, {
      detail: { workspaceId },
    }),
  );
}

export type ChatSessionActivityDetail = {
  workspaceId: string;
  sessionId: string;
  working: boolean;
};

/**
 * A room mirrors every live turn onto its follow stream. Suppress the viewer's
 * own mirror only while this mounted surface still owns the exact room's
 * original POST stream. After navigation, re-entry, or an explicit local
 * abort, that POST is no longer painting this view and the mirror becomes the
 * only live-progress source.
 */
export function shouldAcceptRoomMirror(params: {
  senderUserId: string | null;
  viewerUserId: string | null;
  sessionId: string;
  directTurnSessionId: string | null;
  directStreamInFlight: boolean;
}): boolean {
  // A room serializes turns, so an exact-room live POST is necessarily the
  // turn this mounted surface is already painting. Do not depend on cached
  // viewer identity: when `getUserInfo()` has not hydrated yet both the POST
  // and its bus mirror otherwise render, producing a temporary duplicate.
  const ownsExactRoomPost =
    params.directTurnSessionId === params.sessionId &&
    params.directStreamInFlight;
  if (!ownsExactRoomPost) return true;
  // Human posts may still fan in while the assistant turn is running. When
  // both identities are known, keep a teammate's event; otherwise the exact
  // room ownership is the safer signal for turn-mirror suppression.
  if (
    params.senderUserId !== null &&
    params.viewerUserId !== null &&
    params.senderUserId !== params.viewerUserId
  ) {
    return true;
  }
  return false;
}

/**
 * Same-tab fast path for the Workspace rail's working avatar. The persisted
 * session `status` returned by `listWorkspaceSessions` remains authoritative
 * across navigation and reload; this signal only closes the visual gap before
 * the next list fetch sees `running` / `idle`.
 */
export function dispatchChatSessionActivity(
  detail: ChatSessionActivityDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ChatSessionActivityDetail>(CHAT_SESSION_ACTIVITY_EVENT, {
      detail,
    }),
  );
}

/**
 * Whether the chat surface should hold a `GET /api/sessions/:id/stream`
 * subscription for the open session.
 *
 * A room is followed for its whole lifetime (teammate posts, mirrored turns,
 * presence). A personal session opens the stream only while a re-attach is
 * WANTED: after the direct `POST /api/chat` body closed without a terminal
 * event (the turn is still running server-side, see 2026-08-24), and once on
 * hydrate so a reload mid-turn finds the running turn again. When idle the
 * route answers `status` then `done` and closes; one cheap GET.
 */
export function shouldOpenSessionStream(params: {
  isRoom: boolean;
  reconnectWanted: boolean;
}): boolean {
  return params.isRoom || params.reconnectWanted;
}

/**
 * Whether a closed session stream should be re-opened after a beat.
 *
 * Rooms never close server-side on idle, so any close there is a deploy /
 * restart / network blip and the follow stream comes back. A personal
 * session's reconnect stream ends on purpose: the server sends `done` when
 * the turn is over (or was never running) and never reopens. So a non-room
 * reopens ONLY when the body closed without `done` (the transport gave up on
 * a turn that may still be running); after `done` there is nothing to attach
 * to. A cancelled effect (unmount, session switch) never reopens.
 */
export function shouldReopenSessionStream(params: {
  isRoom: boolean;
  sawDone: boolean;
  cancelled: boolean;
}): boolean {
  if (params.cancelled) return false;
  if (params.isRoom) return true;
  return !params.sawDone;
}
