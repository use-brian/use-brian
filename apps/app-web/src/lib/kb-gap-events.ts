/**
 * Tiny event bus telling a chrome KbGapPill to re-fetch its count.
 * Ported from `apps/web/src/lib/kb-gap-events.ts` (consolidation §5a).
 *
 * The KB-gaps page fires this after a successful dismiss or draft; a pill
 * subscribes, bumps a refresh tick, and re-fetches so the badge drops without
 * a reload. Load-bearing because the `/dismiss` + `/draft` endpoints emit
 * nothing — the badge would otherwise stay stale for the session.
 *
 * (The app-web KbGapPill itself is a follow-up; the page already fires this
 * so the pill port is drop-in.)
 */

export const KB_GAP_REFRESH_EVENT = "sidan:kb-gap-refresh";

export type KbGapRefreshDetail = {
  /** Scopes the refresh to a specific workspace. */
  workspaceId: string | null;
};

export function requestKbGapRefresh(workspaceId: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<KbGapRefreshDetail>(KB_GAP_REFRESH_EVENT, {
      detail: { workspaceId },
    }),
  );
}
