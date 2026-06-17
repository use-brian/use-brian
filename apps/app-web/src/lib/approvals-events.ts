/**
 * Tiny event bus telling a chrome ApprovalsPill to re-fetch its pending
 * count. Ported from `apps/web/src/lib/approvals-events.ts` (app
 * consolidation §5a).
 *
 * The approvals page fires this after a successful approve / reject (single
 * or batch); a pill subscribes, bumps a refresh tick, and re-fetches so the
 * badge drops without a reload. Load-bearing because the `/respond` endpoint
 * for non-in-place kinds emits nothing — the badge would otherwise stay
 * stale for the session.
 *
 * (The app-web ApprovalsPill itself is a follow-up; the page already
 * fires this so the pill port is drop-in.)
 */

export const APPROVALS_REFRESH_EVENT = "sidan:approvals-refresh";

export type ApprovalsRefreshDetail = {
  /** Scopes the refresh to a specific workspace. */
  workspaceId: string | null;
};

export function requestApprovalsRefresh(workspaceId: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ApprovalsRefreshDetail>(APPROVALS_REFRESH_EVENT, {
      detail: { workspaceId },
    }),
  );
}
