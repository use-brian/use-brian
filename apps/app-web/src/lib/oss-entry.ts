/**
 * Where a signed-out user goes in the open single-player edition.
 *
 * The hosted edition sends them to `/login` for Google OAuth. The open edition
 * has **no login at all** — a local or self-hosted brain is a single-user app
 * whose identity is the machine's owner — so `/login` there renders a Google
 * button with nothing behind it: no client ID, no consent screen, no way
 * forward. Every signed-out surface must instead route to the local-owner
 * session (`/api/auth/local-session`), which mints the owner's tokens and
 * bounces back.
 *
 * This is the single source of truth for that decision. It was previously
 * inlined as a bare `redirect("/login")` in each surface, which is how the
 * self-host root path came to dead-end on an unusable sign-in screen.
 *
 * Callers fall back to their own hosted-edition behaviour when this returns
 * `null`, so the hosted flow is untouched.
 *
 * Component-map tag: [COMP:app-web/oss-entry].
 */

import { isOssEdition } from "@/lib/edition";

/** The web trigger route that mints the local-owner session. */
export const LOCAL_SESSION_PATH = "/api/auth/local-session";

/**
 * Keep only same-origin absolute paths. A protocol-relative `//evil.com` would
 * be resolved by `new URL()` against another origin, and an absolute URL is an
 * open redirect outright — both collapse to the app root.
 */
export function sanitizeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  return raw;
}

/**
 * The path a signed-out visitor should be sent to, or `null` in the hosted
 * edition (caller keeps its existing `/login` behaviour).
 *
 * `next` is where the user was actually headed; it rides along so the
 * round-trip resumes there instead of dumping everyone at the app root. A
 * `next` of `/` is omitted since that's already the route's default.
 */
export function ossSignedOutRedirect(next?: string | null): string | null {
  if (!isOssEdition()) return null;
  const target = sanitizeNext(next);
  if (target === "/") return LOCAL_SESSION_PATH;
  return `${LOCAL_SESSION_PATH}?next=${encodeURIComponent(target)}`;
}
