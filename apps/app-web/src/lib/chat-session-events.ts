import { settleChatSessionFeedback } from "@/lib/chat-send-feedback";
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
 * Ordinary refreshes are same-tab; cache invalidations also notify other windows.
 * Same-tab only for server activity for now — there is no server-side `session` workspace
 * primitive. If one lands, route it through `workspace-events.ts` to this
 * event, the way `assistant` routes to `ASSISTANT_REFRESH_EVENT`.
 */

export const CHAT_SESSIONS_REFRESH_EVENT = "sidan:chat-sessions-refresh";
export const CHAT_SESSION_ACTIVITY_EVENT = "sidan:chat-session-activity";

export type ChatCacheFenceSignal = { apiOrigin: string; viewerId: string; workspaceId: string; sessionId?: string };
type ChatSessionsRefreshDetail = {
  cacheFence?: ChatCacheFenceSignal;
  /** Scopes the refresh to a specific workspace. */
  workspaceId: string | null;
};

let cacheChannel: BroadcastChannel | null = null;
function ensureCacheChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof window.BroadcastChannel !== "function") return null;
  if (!cacheChannel) {
    cacheChannel = new window.BroadcastChannel(CHAT_SESSIONS_REFRESH_EVENT);
    cacheChannel.onmessage = event => {
      const signal = event.data as ChatCacheFenceSignal | undefined;
      if (!signal || typeof signal.apiOrigin !== "string" || typeof signal.viewerId !== "string" || typeof signal.workspaceId !== "string"
        || signal.sessionId !== undefined && typeof signal.sessionId !== "string") return;
      window.dispatchEvent(new CustomEvent<ChatSessionsRefreshDetail>(CHAT_SESSIONS_REFRESH_EVENT, { detail: { workspaceId: signal.workspaceId, cacheFence: signal } }));
    };
  }
  return cacheChannel;
}
if (typeof window !== "undefined") ensureCacheChannel();

export function dispatchChatSessionsRefresh(workspaceId: string | null, cacheFence?: ChatCacheFenceSignal): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ChatSessionsRefreshDetail>(CHAT_SESSIONS_REFRESH_EVENT, {
      detail: { workspaceId, ...(cacheFence ? { cacheFence } : {}) },
    }),
  );
  if (cacheFence) ensureCacheChannel()?.postMessage(cacheFence);
}

export type ChatSessionActivityDetail = {
  workspaceId: string;
  sessionId: string;
  working: boolean;
  turnId?: string | null;
};

/**
 * Same-tab fast path for the Workspace rail's working indicator. The persisted
 * session `status` returned by `listWorkspaceSessions` remains authoritative
 * across navigation and reload; this signal only closes the visual gap before
 * the next list fetch sees `running` / `idle`.
 */
export function dispatchChatSessionActivity(
  detail: ChatSessionActivityDetail,
): void {
  if (typeof window === "undefined") return;
  if (!detail.working) settleChatSessionFeedback(detail.workspaceId, detail.sessionId, detail.turnId ?? null);
  window.dispatchEvent(
    new CustomEvent<ChatSessionActivityDetail>(CHAT_SESSION_ACTIVITY_EVENT, {
      detail,
    }),
  );
}
