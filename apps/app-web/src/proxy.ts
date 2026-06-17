import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  accessTokenCookie,
  refreshTokenCookie,
  userCookie,
  applyClearedCookies,
  appendLegacyHostOnlyClears,
  parseLastCookie,
} from "@/lib/auth-cookies";
import { primaryAuthUrl } from "@/lib/primary-auth";
import { computeDocRedirect } from "@/lib/doc-redirect";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

type RefreshResult = {
  accessToken: string;
  refreshToken: string;
  user?: {
    id: string;
    name: string;
    email: string;
  };
};

/**
 * Auth guard for protected operator routes (`/w/...`, `/teams`).
 *
 * Branches:
 *  1. Fresh access_token → let the request through (no cookie writes).
 *  2. No access_token, no refresh_token → bounce to login. In
 *     production this means redirecting to `sidan.ai/login?next=...`
 *     because only the primary writes the shared `.sidan.ai` cookies.
 *     In dev (no `primaryAuthUrl()`) we fall back to the local
 *     `/login` page.
 *  3. Access expired (1h) but refresh still valid (30d) → in
 *     production, bounce to `sidan.ai/api/auth/refresh-and-return?
 *     next=...` so the primary writes the rotated cookies and the
 *     browser comes back here with a fresh access token. In dev we
 *     refresh locally and set host-only cookies the same as before.
 *
 * Per the design rule "sidan.ai → sub-app, not the other way round",
 * `feed-web` never writes `.sidan.ai`-scoped cookies in production.
 * The local refresh path is preserved only for the dev case where
 * cookies can't be shared across `localhost:300X` origins anyway.
 */
export async function proxy(request: NextRequest) {
  // Doc v1 URL refactor (§9.3): legacy `/w/<wid>/doc?viewId=<id>`
  // links 301 to `/w/<wid>/p/<id>`, and `/w/<wid>/doc` with no viewId
  // 302s to the `/p` index. This runs *before* the auth guard so the
  // redirect to the canonical path happens in one hop; the canonical
  // `/p/...` request then goes through this same proxy and gets the
  // normal auth treatment. Composing this way (short-circuit first, fall
  // through to auth) keeps a single interception layer — see
  // `src/lib/doc-redirect.ts`.
  const docRedirect = computeDocRedirect(request);
  if (docRedirect) return docRedirect;

  // `NextRequest.cookies.get(name)` returns the first value for `name`,
  // which on browsers carrying pre-migration host-only twins is the
  // *legacy* one — see `docs/architecture/platform/auth.md` → "Duplicate
  // cookies after the .sidan.ai migration". Parse the raw Cookie header
  // ourselves so we can pick the most-recently-set values.
  const cookieHeader = request.headers.get("cookie") ?? "";
  const hasAccess = parseLastCookie(cookieHeader, "access_token");
  const refreshToken = parseLastCookie(cookieHeader, "refresh_token");
  const primary = primaryAuthUrl();

  if (!hasAccess && !refreshToken) {
    if (primary) {
      // Cross-origin to the primary's /login. Carries the original URL
      // so post-OAuth lands the user back here.
      const loginUrl = new URL("/login", primary);
      loginUrl.searchParams.set("next", request.url);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (hasAccess) {
    return NextResponse.next();
  }

  // Access expired but refresh still around. In production, defer to
  // the primary so it rotates and writes the `.sidan.ai` cookies; in
  // dev refresh locally.
  if (primary) {
    const refreshUrl = new URL("/api/auth/refresh-and-return", primary);
    refreshUrl.searchParams.set("next", request.url);
    return NextResponse.redirect(refreshUrl);
  }

  const refreshed = await tryServerRefresh(refreshToken!);
  if (!refreshed) {
    const res = NextResponse.redirect(new URL("/login", request.url));
    applyClearedCookies(res);
    return res;
  }

  // Re-emit the cookie header that downstream Server Components / Route
  // Handlers see, so `cookies().get('access_token')` returns the rotated
  // value within this same request — not the empty pre-refresh state.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    "cookie",
    rebuildCookieHeader(request.headers.get("cookie") ?? "", {
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
    }),
  );

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.cookies.set(accessTokenCookie(refreshed.accessToken));
  response.cookies.set(refreshTokenCookie(refreshed.refreshToken));
  if (refreshed.user) {
    response.cookies.set(
      userCookie(
        JSON.stringify({
          id: refreshed.user.id,
          name: refreshed.user.name,
          email: refreshed.user.email,
        }),
      ),
    );
  }
  // Expire any pre-migration host-only twins so subsequent requests
  // carry one value per cookie name. Append raw Set-Cookie headers
  // instead of `cookies.set()` so the framework's name-keyed cookie map
  // doesn't clobber the fresh domain-scoped tokens we just wrote.
  appendLegacyHostOnlyClears(response);
  return response;
}

async function tryServerRefresh(refreshToken: string): Promise<RefreshResult | null> {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as RefreshResult;
  } catch (err) {
    console.warn("[proxy] refresh failed:", err);
    return null;
  }
}

/**
 * Rewrite the incoming request's Cookie header so the named cookies carry
 * the rotated values. Adds a cookie if missing; preserves anything else
 * untouched (locale, analytics, third-party). Cheap parser — the Cookie
 * header has a single shape and we only need name=value pairs.
 */
function rebuildCookieHeader(
  original: string,
  overrides: Record<string, string>,
): string {
  const seen = new Set<string>();
  const pairs: string[] = [];
  for (const part of original.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const name = eq === -1 ? trimmed : trimmed.slice(0, eq);
    if (overrides[name] !== undefined) {
      pairs.push(`${name}=${overrides[name]}`);
      seen.add(name);
    } else {
      pairs.push(trimmed);
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!seen.has(name)) pairs.push(`${name}=${value}`);
  }
  return pairs.join("; ");
}

export const config = {
  matcher: [
    "/w/:path*",
    "/teams",
    // In-app promo redemption (moved here from marketing `apps/web`). Gating
    // it gives a shareable `?code=` visitor with an expired access token the
    // refresh flow before `app/redeem/page.tsx` resolves the workspace.
    "/redeem",
    // Legacy pre-consolidation bare paths, forwarded here path-preserved by
    // the marketing proxy (MOVED_TO_APP_PREFIXES in apps/web). Guarding them
    // here gives an expired-access visitor (old bookmarks) the refresh flow
    // before `app/[...legacy]/page.tsx` resolves the workspace redirect.
    "/home/:path*",
    "/brain/:path*",
    "/studio/:path*",
    "/workflow/:path*",
    "/chat/:path*",
    "/settings/:path*",
    "/workspaces/:path*",
    "/approvals/:path*",
    "/knowledge-base/:path*",
    "/memories/:path*",
  ],
};
