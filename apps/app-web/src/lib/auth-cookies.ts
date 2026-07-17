/**
 * Shared cookie configuration for auth tokens. Cloned from
 * apps/web/src/lib/auth-cookies.ts so the OAuth callback and refresh
 * routes set consistent cookies.
 *
 * In production we default to `.usebrian.ai` so cookies are shared across
 * sibling subdomains — a user signed in on usebrian.ai is automatically
 * authenticated on feed.usebrian.ai (and vice-versa). Set `COOKIE_DOMAIN`
 * to override (e.g. for a staging deployment on a different apex).
 * Always unset in dev so cookies stay host-only on `localhost` —
 * browsers reject `Domain=localhost` and would silently drop them.
 */

const isSecure = process.env.NODE_ENV === "production";
const COOKIE_DOMAIN =
  process.env.COOKIE_DOMAIN || (isSecure ? ".usebrian.ai" : undefined);

export function accessTokenCookie(value: string) {
  return {
    name: "access_token",
    value,
    httpOnly: false,
    secure: isSecure,
    sameSite: "lax" as const,
    maxAge: 60 * 60,
    path: "/",
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  };
}

export function refreshTokenCookie(value: string) {
  return {
    name: "refresh_token",
    value,
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax" as const,
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  };
}

export function userCookie(value: string) {
  return {
    name: "user",
    value,
    httpOnly: false,
    secure: isSecure,
    sameSite: "lax" as const,
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  };
}

/**
 * Canonical list of auth-cookie names this module manages.
 */
const AUTH_COOKIE_NAMES = ["access_token", "refresh_token", "user"] as const;

/**
 * Append clears for all three auth cookies across BOTH the host-only and
 * domain-scoped variants. Mirrors `apps/web/src/lib/auth-cookies.ts →
 * applyClearedCookies()` — see that file for the full explanation of why
 * we hit `response.headers` directly instead of `response.cookies.set()`.
 * Short version: `@edge-runtime/cookies`' `ResponseCookies` map is keyed
 * by cookie name alone, so writing both a host-only and a domain-scoped
 * cookie with the same name only emits the LAST one. We have to bypass
 * the map to express the (name, domain, path) cookie identity RFC 6265
 * actually defines.
 */
export function applyClearedCookies(response: { headers: Headers }) {
  for (const name of AUTH_COOKIE_NAMES) {
    response.headers.append("set-cookie", `${name}=; Path=/; Max-Age=0`);
  }
  if (!COOKIE_DOMAIN) return;
  for (const name of AUTH_COOKIE_NAMES) {
    response.headers.append(
      "set-cookie",
      `${name}=; Path=/; Max-Age=0; Domain=${COOKIE_DOMAIN}`,
    );
  }
}

/**
 * Append clears for the legacy host-only twins only — leaves the
 * domain-scoped (`.usebrian.ai`) cookies in place. Use this on login /
 * successful refresh so browsers carrying pre-migration host-only
 * cookies shed them on the next round-trip. Mirrors
 * `apps/web/src/lib/auth-cookies.ts → appendLegacyHostOnlyClears()`.
 *
 * **Must run AFTER all `response.cookies.set()` calls** — any subsequent
 * `cookies.set()` triggers `replace()` which calls
 * `headers.delete("set-cookie")` and re-emits only the map entries, wiping
 * the headers appended here.
 *
 * No-op when `COOKIE_DOMAIN` is unset (dev / `localhost`).
 */
export function appendLegacyHostOnlyClears(response: { headers: Headers }) {
  if (!COOKIE_DOMAIN) return;
  for (const name of AUTH_COOKIE_NAMES) {
    response.headers.append("set-cookie", `${name}=; Path=/; Max-Age=0`);
  }
}

/**
 * Pick the LAST value for a cookie name from a raw Cookie header.
 * Mirrors `apps/web/src/lib/auth-cookies.ts → parseLastCookie()`. See
 * `docs/architecture/platform/auth.md` → "Duplicate cookies after the
 * .usebrian.ai migration" for why the last (not first) match is correct.
 */
export function parseLastCookie(header: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`, "g");
  let last: string | null = null;
  for (const m of header.matchAll(re)) last = m[1];
  return last;
}
