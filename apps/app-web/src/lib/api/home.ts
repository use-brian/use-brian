/**
 * Minimal home SDK (app-web) — per-user nudge dismissals only.
 *
 * Ported from `apps/web/src/lib/api/home.ts` as part of the brain surface
 * migration (docs/plans/doc-web-app-consolidation.md §5a), trimmed to
 * the two functions the brain page actually needs:
 * `fetchDismissedNudges` + `dismissNudge` back the page-level
 * `brain-unconfirmed` banner. The rest of web's home SDK
 * (`fetchHomeSetupState` / `fetchHomeGlance` / `fetchRecentSessions`)
 * belongs to the chat-home surface, which is not part of the brain port.
 *
 * Identical wire contract — `GET /api/home/dismissed-nudges` +
 * `POST /api/home/dismiss-nudge`. Imports already resolve in app-web.
 */
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Fetch the user's per-user nudge dismissals (no workspace scope). Used by
 * surfaces outside the home — e.g. the Brain page's `brain-unconfirmed`
 * banner — that only need the dismissal map, not the full setup-state.
 * Returns `{}` on error so a missed read just re-shows the nudge.
 */
export async function fetchDismissedNudges(): Promise<Record<string, boolean>> {
  try {
    const res = await authFetch(`${API_URL}/api/home/dismissed-nudges`);
    if (!res.ok) return {};
    const data = (await res.json()) as { dismissed?: Record<string, boolean> };
    return data.dismissed ?? {};
  } catch {
    return {};
  }
}

/** Persist a per-user nudge dismissal. Best-effort (fire-and-forget). */
export async function dismissNudge(key: string): Promise<void> {
  try {
    await authFetch(`${API_URL}/api/home/dismiss-nudge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
  } catch {
    // best-effort; a missed dismissal just re-shows the nudge next load
  }
}
