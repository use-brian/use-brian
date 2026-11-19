/**
 * Shared cookie configuration for auth tokens. Cloned from
 * apps/web/src/lib/auth-cookies.ts so the OAuth callback and refresh
 * routes set consistent cookies.
 *
 * The default cookie domain is a property of the deployment profile, never of
 * the request host (`docs/architecture/platform/auth.md` → "Cross-app SSO via
 * shared cookie domain"). The hosted profile defaults to `.usebrian.ai` in
 * production so cookies are shared across sibling subdomains: a user signed in
 * on usebrian.ai is authenticated on app.usebrian.ai. The open profiles (`oss`,
 * `outpost`) set no default, so a self-hosted or `localhost` build writes
 * host-only cookies without configuration. `COOKIE_DOMAIN` overrides the
 * default in every profile (empty means host-only). Dev is always host-only:
 * browsers reject `Domain=localhost` and would silently drop the cookies.
 */

import type { DeploymentProfile } from "@use-brian/shared/deployment-capabilities";
import { usebrianEdition } from "@/lib/edition";

const isSecure = process.env.NODE_ENV === "production";

/**
 * The production cookie domain each deployment profile uses when
 * `COOKIE_DOMAIN` is unset. Only the hosted composition shares a parent; an
 * open profile on a customer host must never inherit the hosted suffix.
 */
export const PROFILE_DEFAULT_COOKIE_DOMAIN: Readonly<
  Record<DeploymentProfile, string | undefined>
> = {
  hosted: ".usebrian.ai",
  oss: undefined,
  outpost: undefined,
};

/**
 * Resolve the `Domain` attribute for the auth cookies. Precedence, identical in
 * every profile: a non-empty `COOKIE_DOMAIN`, then an empty one (host-only),
 * then the profile's production default, then host-only. `profile` defaults to
 * `hosted`, matching `resolveDeploymentProfile` for an unset edition.
 */
export function resolveCookieDomain(
  configured: string | undefined,
  secure: boolean,
  profile: DeploymentProfile = "hosted",
): string | undefined {
  if (configured !== undefined) return configured.trim() || undefined;
  return secure ? PROFILE_DEFAULT_COOKIE_DOMAIN[profile] : undefined;
}

const COOKIE_DOMAIN = resolveCookieDomain(
  process.env.COOKIE_DOMAIN,
  isSecure,
  usebrianEdition(),
);

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
 * No-op when no cookie domain resolves (dev, or an open profile without
 * `COOKIE_DOMAIN`): the cookies just set are themselves host-only.
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
