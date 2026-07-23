import { NextResponse } from "next/server";
import {
  accessTokenCookie,
  refreshTokenCookie,
  userCookie,
  applyClearedCookies,
  appendLegacyHostOnlyClears,
  parseLastCookie,
} from "@/lib/auth-cookies";
import { primaryAuthUrl } from "@/lib/primary-auth";

import { INTERNAL_API_URL as API_URL } from "@/lib/internal-api-url";

/**
 * Server-side bridge that reads the httpOnly refresh_token cookie, forwards
 * to the backend /auth/refresh, and rotates all auth cookies on the response.
 * Cloned from apps/web/src/app/api/auth/refresh/route.ts.
 *
 * **Dev-only in production.** The design rule "usebrian.ai → sub-app, not
 * the other way round" means only usebrian.ai writes `.usebrian.ai` cookies.
 * In prod the proxy + `authFetch` redirect the browser to
 * `${primary}/api/auth/refresh-and-return` before they ever call this
 * route, so this code is dead in prod. The guard below is defense in
 * depth — if something does POST here in production, we return 410 Gone
 * instead of writing cookies. Localhost dev still uses this path
 * because cross-origin localhost cookies aren't shared.
 */
export async function POST(request: Request) {
  const primary = primaryAuthUrl();
  if (primary) {
    return NextResponse.json(
      {
        error: "refresh_disabled_on_subapp",
        message: "Refresh happens at the primary. Use /api/auth/refresh-and-return there.",
      },
      { status: 410 },
    );
  }

  // `parseLastCookie` picks the most-recently-set refresh_token so a
  // pre-migration host-only twin can't shadow the post-migration
  // domain-scoped one. See `docs/architecture/platform/auth.md` →
  // "Duplicate cookies after the .usebrian.ai migration".
  const cookieHeader = request.headers.get("cookie") ?? "";
  const refreshToken = parseLastCookie(cookieHeader, "refresh_token");

  if (!refreshToken) {
    const res = NextResponse.json({ error: "no_refresh_token" }, { status: 401 });
    applyClearedCookies(res);
    return res;
  }

  try {
    const backendRes = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!backendRes.ok) {
      const res = NextResponse.json({ error: "refresh_rejected" }, { status: 401 });
      applyClearedCookies(res);
      return res;
    }

    const data = (await backendRes.json()) as {
      accessToken: string;
      refreshToken: string;
      user?: { id: string; email: string; name: string; avatarUrl?: string | null };
    };

    const res = NextResponse.json({ accessToken: data.accessToken });
    res.cookies.set(accessTokenCookie(data.accessToken));
    res.cookies.set(refreshTokenCookie(data.refreshToken));
    if (data.user) {
      res.cookies.set(
        userCookie(
          JSON.stringify({
            id: data.user.id,
            name: data.user.name,
            email: data.user.email,
            ...(data.user.avatarUrl ? { avatarUrl: data.user.avatarUrl } : {}),
          }),
        ),
      );
    }
    // Expire any pre-migration host-only twins so the next request
    // carries only the domain-scoped cookies we just set. Append raw
    // Set-Cookie headers instead of `cookies.set()` so the framework's
    // name-keyed cookie map doesn't clobber the fresh tokens above.
    appendLegacyHostOnlyClears(res);
    return res;
  } catch (err) {
    console.error("[/api/auth/refresh] error:", err);
    return NextResponse.json({ error: "refresh_failed" }, { status: 500 });
  }
}
