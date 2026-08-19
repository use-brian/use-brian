/**
 * Tiny event bus telling every persistent Inbox surface to re-fetch.
 * Mirrors `approvals-events.ts` / `assistant-events.ts`.
 *
 * Load-bearing for the same reason as `assistant-events.ts`: `InboxPanel`
 * and the sidebar unread badge (`doc-sidebar.tsx`) are both mounted by
 * `WorkspaceChrome`, rendered by the `/w/[workspaceId]` layout, which NEVER
 * unmounts during SPA navigation — a `useEffect(..., [workspaceId])` fetch
 * there fires once per full page load and can never self-heal. Before this
 * bus, a room `@mention` recorded while the recipient was on another
 * surface (or another tab/device) would not show up in the badge until a
 * hard reload.
 *
 * The shell-level workspace stream (`workspace-events.ts`) dispatches this
 * for `inbox` change signals from ANY tab, device, or teammate — the server
 * emits the primitive from `notifyRoomMentionRecorded`
 * (`packages/api/src/brain-stream/notify.ts`) after a room mention is
 * recorded. Payloads are signals, never data: subscribers re-fetch through
 * their own authed loader (`fetchInbox` / `fetchInboxBadgeCount`).
 *
 * Distinct from `INBOX_CHANGED_EVENT` (`inbox-events.ts`), which is a
 * same-tab echo `InboxPanel` fires after ITS OWN read/dismiss action — that
 * one needs no server round trip because the acting tab already knows what
 * changed. This one is the cross-tab / cross-device / cross-teammate signal.
 * A listener normally wants both.
 *
 * Spec: docs/plans/room-human-mentions.md — T-H8.
 */

export const INBOX_REFRESH_EVENT = "sidan:inbox-refresh";

export type InboxRefreshDetail = {
  /** Scopes the refresh to a specific workspace. */
  workspaceId: string | null;
};
