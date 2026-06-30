/**
 * Authenticated fetch wrapper with transparent JWT refresh. Cloned from
 * apps/web/src/lib/auth-fetch.ts.
 *
 * Two refresh paths:
 *   - Production: redirect the browser to
 *     `${primary}/api/auth/refresh-and-return?next=<current url>` and
 *     let sidan.ai do the cookie write. We never call our own
 *     `/api/auth/refresh` in this mode — sub-apps don't write to the
 *     shared `.sidan.ai` scope.
 *   - Dev: call our local `/api/auth/refresh` route, which writes
 *     host-only cookies. Localhost can't share cookies across origins
 *     anyway, so a local refresh is the only thing that works.
 */

import { getUserInfo, setUserInfoCache } from "@/lib/user";
import { primaryAuthUrl } from "@/lib/primary-auth";
import {
  isDesktopAuth,
  desktopAuthSource,
  classifyRefreshStatus,
  type RefreshOutcome,
} from "@/lib/desktop-auth-source";

const APP_URL = typeof window !== "undefined" ? window.location.origin : "";

export function getAccessToken(): string | null {
  // Bundled desktop app: tokens come from the shell bridge, not cookies.
  // Dormant on web + the thin shell (no token bridge) — see desktop-auth-source.
  if (isDesktopAuth()) return desktopAuthSource.getAccessToken();
  if (typeof document === "undefined") return null;
  return selectFreshestAccessToken(document.cookie);
}

/**
 * Choose the freshest `access_token` from a raw Cookie string — the one whose
 * JWT `exp` is furthest in the future.
 *
 * A browser that signed in before the May-2026 `.sidan.ai` cookie migration can
 * carry two `access_token` cookies (a host-only twin + the domain-scoped one).
 * The old read picked the LAST occurrence, leaning on RFC 6265 §5.4 ordering
 * ("oldest first"). But cookie order isn't reliable across browsers or once a
 * twin is re-set, and reading a stale twin makes every `authFetch` 401 → forces
 * the sub-app's full-page refresh redirect → and since the server keeps
 * re-issuing the live `.sidan.ai` token while the client keeps reading the dead
 * twin, the page just self-refreshes forever and never builds anything.
 * Selecting by `exp` is order-independent: a live token always beats an expired
 * twin. Ties (nothing decodes) fall back to the last occurrence, preserving the
 * old behavior. Pure + exported for tests — the app-web vitest env has no
 * `document`. See docs/architecture/platform/auth.md → "Duplicate cookies after
 * the .sidan.ai migration".
 */
export function selectFreshestAccessToken(cookie: string): string | null {
  const re = /(?:^|;\s*)access_token=([^;]*)/g;
  let best: string | null = null;
  let bestExp = -Infinity;
  for (const m of cookie.matchAll(re)) {
    const exp = jwtExpSeconds(m[1]);
    // `>=` so a later candidate wins ties — keeps the legacy "pick last"
    // behavior when no candidate carries a decodable `exp`.
    if (exp >= bestExp) {
      bestExp = exp;
      best = m[1];
    }
  }
  return best;
}

function clearUserCookie() {
  if (typeof document === "undefined") return;
  document.cookie = "user=; max-age=0; path=/";
  document.cookie = "access_token=; max-age=0; path=/";
  setUserInfoCache(null);
}

let inflightRefresh: Promise<RefreshOutcome> | null = null;

// Flipped the instant we trigger a full-page auth redirect (token refresh or
// login bounce). Sub-apps can't refresh `.sidan.ai` cookies in place — they
// navigate the whole browser to sidan.ai and back — so a caller that mutated
// state before the redirecting `authFetch` (e.g. the doc build's
// `createDraft`) sees its call reject while the page is unloading and must NOT
// treat that as a terminal failure. Surfaces read this to keep stashed intent
// for replay on return. See docs/architecture/platform/auth.md → "A sub-app
// refresh discards in-flight work".
let authRedirectInFlight = false;

/** True once a full-page auth redirect has been triggered this page life. */
export function isAuthRedirectInFlight(): boolean {
  return authRedirectInFlight;
}

/**
 * Refresh the access token, classifying the result so callers can tell a
 * transient network failure (keep the session, retry) from a dead session
 * (sign in). See `RefreshOutcome`.
 *
 * In production this redirects the browser to
 * `${primary}/api/auth/refresh-and-return?next=<current url>` — the primary
 * writes the rotated `.sidan.ai` cookies and the browser comes back with a
 * fresh token (outcome `redirecting`, since the navigation happens before any
 * subsequent code runs). **Offline, that full-page bounce must not fire:** it
 * would fail, and in the desktop shell the shell intercepts it and misreads the
 * failed refresh as a sign-out (the "Mac goes offline → logged out" bug). So we
 * guard on `navigator.onLine` and return `transient` instead of navigating.
 *
 * In dev there's no primary, so we fall back to the local refresh route which
 * writes host-only cookies; only an explicit 401/400 there clears cookies.
 */
async function tryRefreshToken(): Promise<RefreshOutcome> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async (): Promise<RefreshOutcome> => {
    // Bundled desktop app: refresh against the API directly via the shell
    // bridge (no `.sidan.ai` cookie redirect). Dormant on web + thin shell.
    if (isDesktopAuth()) return desktopAuthSource.refresh();
    const primary = primaryAuthUrl();
    if (primary && typeof window !== "undefined") {
      // Offline: do NOT navigate. The bounce would fail and (in the desktop
      // shell) be misread as a sign-out. Treat it as transient — the caller
      // keeps the session and retries when connectivity returns.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return { kind: "transient" };
      }
      const refreshUrl = new URL("/api/auth/refresh-and-return", primary);
      refreshUrl.searchParams.set("next", window.location.href);
      authRedirectInFlight = true;
      window.location.href = refreshUrl.toString();
      return { kind: "redirecting" };
    }
    try {
      const res = await fetch(`${APP_URL}/api/auth/refresh`, {
        method: "POST",
        credentials: "same-origin",
      });
      const verdict = classifyRefreshStatus(res.status);
      if (verdict === "unauthenticated") {
        clearUserCookie();
        return { kind: "unauthenticated" };
      }
      if (verdict === "transient") return { kind: "transient" };
      const data = (await res.json()) as { accessToken?: string };
      return data.accessToken ? { kind: "ok", token: data.accessToken } : { kind: "transient" };
    } catch (err) {
      // A thrown fetch is a network failure (offline, DNS, reset) — transient.
      // Keep cookies; the next attempt retries. Must NOT log the user out.
      console.warn("[authFetch] refresh call failed (transient):", err);
      return { kind: "transient" };
    }
  })();
  try {
    return await inflightRefresh;
  } finally {
    inflightRefresh = null;
  }
}

/** Decode a JWT's `exp` (unix seconds). Returns 0 when unparseable. */
function jwtExpSeconds(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return 0;
    const json = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number };
    return typeof json.exp === "number" ? json.exp : 0;
  } catch {
    return 0;
  }
}

/**
 * Return a currently-valid access token, refreshing if the cookie token is
 * missing or within 60s of expiry. `authFetch` self-heals expiry via its
 * 401→refresh→retry loop, but long-lived non-fetch consumers — the doc
 * collaboration WebSocket (`use-collab-provider.ts`) — can't ride that path:
 * once the 1h access token expires they'd present a dead token on every
 * reconnect and loop forever. They call this before each (re)connect instead.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const token = getAccessToken();
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (token && jwtExpSeconds(token) - 60 > nowSeconds) return token;
  const outcome = await tryRefreshToken();
  if (outcome.kind === "ok") return outcome.token;
  // transient / redirecting / unauthenticated: fall back to the current cookie
  // token (possibly stale). Never trigger a redirect here — the collab
  // WebSocket caller just retries on its next reconnect, and a network blip
  // must not log the user out. Prod online refresh navigates away (resolves
  // `redirecting`), so the page reloads with a fresh cookie regardless.
  return getAccessToken();
}

const CLIENT_TIMEZONE: string | null = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
})();

function withAuthHeader(
  headers: HeadersInit | undefined,
  token: string | null,
): HeadersInit {
  const merged = new Headers(headers);
  if (token) merged.set("Authorization", `Bearer ${token}`);
  if (CLIENT_TIMEZONE && !merged.has("X-Client-Timezone")) {
    merged.set("X-Client-Timezone", CLIENT_TIMEZONE);
  }
  return merged;
}

/**
 * Where do we send the browser when there is no valid session? In
 * production the only authority that can mint cookies is the primary
 * (sidan.ai), so we redirect there with `next=<current url>` so the
 * user lands back on this sub-app after sign-in. In dev there is no
 * primary, so we fall back to the local `/login` page.
 *
 * `tryRefreshToken` already triggers a sidan.ai redirect when there is
 * a refresh token in production; this helper handles the no-cookie
 * case, and the no-refresh-after-401 case.
 */
function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  // Bundled desktop app: "login" is the system-browser PKCE flow, not a
  // same-origin redirect. Dormant on web + thin shell.
  if (isDesktopAuth()) {
    desktopAuthSource.redirectToLogin();
    return;
  }
  if (window.location.pathname.startsWith("/login")) return;
  authRedirectInFlight = true;
  const primary = primaryAuthUrl();
  if (primary) {
    const loginUrl = new URL("/login", primary);
    loginUrl.searchParams.set("next", window.location.href);
    window.location.href = loginUrl.toString();
    return;
  }
  window.location.href = "/login";
}

export async function authFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let token = getAccessToken();
  if (!token) {
    const outcome = await tryRefreshToken();
    if (outcome.kind === "ok") {
      token = outcome.token;
    } else if (outcome.kind === "transient") {
      // Offline / transient: surface a network error like any failed fetch
      // (`fetch(url)` below throws the same way when offline with a live token).
      // The session stays intact and callers degrade + retry — never a logout.
      throw new TypeError("authFetch: network unavailable (offline)");
    } else {
      // `unauthenticated` → send to login; `redirecting` → page is unloading.
      if (outcome.kind === "unauthenticated") redirectToLogin();
      return new Response(null, { status: 401 });
    }
  }
  const headers = withAuthHeader(init.headers, token);
  let response = await fetch(url, { ...init, headers });
  if (response.status !== 401) return response;

  const outcome = await tryRefreshToken();
  if (outcome.kind === "ok") {
    const retryHeaders = withAuthHeader(init.headers, outcome.token);
    response = await fetch(url, { ...init, headers: retryHeaders });
    return response;
  }
  // transient → keep the session and return the 401 we already have (no logout);
  // redirecting → page is unloading; unauthenticated → the session is dead.
  if (outcome.kind === "unauthenticated") redirectToLogin();
  return response;
}

/**
 * Force-refresh the `user` cookie so the cached profile reflects the
 * latest plan/name/email from the backend — useful right after a Stripe
 * webhook (or promo redemption) has changed the plan but the cookie
 * still holds the stale value. Mirror of `apps/web`'s `refreshUserCookie`.
 *
 * Sub-app caveat: only the primary (`sidan.ai`) writes the shared
 * `.sidan.ai` auth cookies, and a silent in-place refresh must not
 * navigate the browser away (callers continue rendering afterwards). So:
 *
 *   - Dev: POST the local `/api/auth/refresh` route, which rotates the
 *     host-only `user` cookie in its `Set-Cookie`. We then re-read it via
 *     `getUserInfo()` to refresh the module-level cache immediately.
 *   - Production: a no-op. The local route returns 410 on sub-apps, and a
 *     primary `refresh-and-return` round-trip is a full-page redirect —
 *     not appropriate for a best-effort cache nudge. The `user` cookie
 *     refreshes on the next `authFetch` 401 → primary redirect cycle.
 *
 * Best-effort: swallows errors since this is a UX enhancement, not a
 * critical path.
 */
export async function refreshUserCookie(): Promise<void> {
  // Production sub-apps can't refresh `.sidan.ai` cookies in place.
  if (primaryAuthUrl()) return;
  try {
    const res = await fetch(`${APP_URL}/api/auth/refresh`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) return;
    // The route's Set-Cookie has updated the `user` cookie by now; pull
    // it back into the module cache so the UI reflects the new plan
    // without waiting for a navigation.
    getUserInfo();
  } catch {
    // Non-critical — the cookie will refresh naturally on next token expiry.
  }
}
