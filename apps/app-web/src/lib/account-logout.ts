import { notifySessionLogout } from "@/lib/session-events";
/**
 * "Log out" = sign out the **active** account only, keeping every other saved
 * account signed in.
 *
 * The primary drops the active account from the saved-account store and
 * switches into the most-recently-used remaining account
 * (`/api/auth/logout?scope=active`), doing a full sign-out only when it was the
 * last account. The transport mirrors the rest of app-web's auth state changes
 * (the same shape as `desktopSignOut()` / the switch + refresh bounces):
 *
 *   - **Electron shell** — route through the shell bridge (`desktopSignOut()`):
 *     the switch happens in the shell's OWN cookie jar, which the primary can't
 *     reach. Bouncing to the primary would open the system browser and sign out
 *     the *web* session instead. Checked FIRST.
 *   - **Production web** — a top-level redirect to
 *     `${primary}/api/auth/logout?scope=active&next=<origin>/`, since only the
 *     primary may write the shared `.usebrian.ai` cookies. It lands back on the app
 *     root as the switched-into account (or `/login` if it was the last one).
 *   - **Dev** — there is no primary and (single-account) no saved store, so a
 *     plain same-origin `POST /api/auth/logout` full-clear → `/login` is exactly
 *     right: dropping the only account IS a full sign-out.
 *
 * Shared by the workspace switcher's "Log out" and the settings account
 * section so the two buttons can't drift. Account **deletion** (privacy
 * section) is intentionally NOT routed here — that's a full teardown of the
 * active identity, not an account switch.
 *
 * [COMP:app-web/account-logout]
 */

import { desktopSignOut } from "@/lib/desktop-auth-source";
import { clearLocalDocCaches } from "@/lib/offline/idb";
import { resetSurfaceCache } from "@/lib/surface-cache";
import { primaryAuthUrl } from "@/lib/primary-auth";
import { setUserInfoCache } from "@/lib/user";
import { revokeCurrentAccountSession } from "@/lib/api/account";

export function signOutActiveAccount(options: { revokeCurrent?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  void (async () => {
    if (options.revokeCurrent !== false) {
      // Best effort: cookie clearing is still the local source of truth when
      // the API is unreachable, but a healthy sign-out should disappear from
      // the device ledger immediately.
      await revokeCurrentAccountSession();
    }
    // Scrub the offline doc caches BEFORE the session ends: page content
    // persisted for offline editing must not outlive the sign-out on a shared
    // browser. Internally time-bounded, so a hung IndexedDB can't strand the
    // user mid-sign-out.
    notifySessionLogout();
    await clearLocalDocCaches();
    // The in-memory surface cache goes with it: its keys carry the viewer id,
    // so the next account could never READ these rows, but a shared device
    // should not keep them in memory either (instant-navigation contract N2).
    resetSurfaceCache();
    // Electron shell signs out + switches in its own jar (and reloads in place).
    if (desktopSignOut()) return;
    const primary = primaryAuthUrl();
    if (primary) {
      const u = new URL("/api/auth/logout", primary);
      u.searchParams.set("scope", "active");
      // Land on the app root: the switched-into account re-resolves its
      // workspace there, and a full sign-out (last account) falls to `/login`
      // via the guard.
      u.searchParams.set("next", `${window.location.origin}/`);
      window.location.href = u.toString();
      return;
    }
    // Dev: no primary, single-account host-only cookies — full clear → /login.
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Even if the clear fails, scrub the cache + bounce so the user isn't
      // stranded half-signed-out.
    }
    setUserInfoCache(null);
    window.location.href = "/accounts";
  })();
}
