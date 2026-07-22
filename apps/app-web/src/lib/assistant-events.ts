/**
 * Tiny event bus telling every persistent assistant-list surface to re-fetch
 * its roster. Mirrors `approvals-events.ts` / `deck-events.ts`.
 *
 * Load-bearing because the assistant roster is read by chrome that NEVER
 * unmounts: `WorkspaceChrome` + the `FloatingChat` dock live in the
 * `/w/[workspaceId]` layout, and both fetch on `useEffect(..., [workspaceId])`.
 * `workspaceId` does not change during SPA navigation, so before this bus a
 * newly created assistant stayed invisible in the bottom-right switcher until
 * a full app restart. Worse, the switcher only renders at `length > 1`, so
 * adding a second assistant produced no visible change at all.
 *
 * The shell-level workspace stream (`workspace-events.ts`) dispatches this for
 * `assistant` change signals from ANY tab, device, or teammate — the server
 * emits the primitive at the workspace assistant-roster routes. Payloads are
 * signals, never data: subscribers re-fetch through their own authed loader.
 */

export const ASSISTANT_REFRESH_EVENT = "sidan:assistant-refresh";

export type AssistantRefreshDetail = {
  /** Scopes the refresh to a specific workspace. */
  workspaceId: string | null;
  /** The assistant row that changed, when the server knows it. */
  rowId?: string;
};
