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
