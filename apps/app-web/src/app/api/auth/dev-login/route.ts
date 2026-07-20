// Next.js Route Handler — GET /api/auth/dev-login
//
// LOCAL-ONLY dev auth bypass for app-web. Calls the backend
// `/auth/dev-login` (which only exists on a local dev API — see
// packages/api/src/routes/dev-auth.ts), then installs the returned token
// pair as the standard auth cookies and bounces to the app root. From there
// the session is indistinguishable from a real login: `authFetch` carries
// the real Bearer token and every RLS-scoped query works.
//
// app-web is a sub-app that defers all auth state changes to the primary
// (usebrian.ai) in production — only the primary writes the shared `.usebrian.ai`
// cookies. So this route is DOUBLY dead in production: the guard below 404s
// when `NODE_ENV === "production"` OR `primaryAuthUrl()` resolves (the same
// "is this prod / a sub-app deploy" signal the callback + refresh routes
// use), and even if it didn't, the backend `/auth/dev-login` is not mounted
// on Cloud Run (gated on NODE_ENV + K_SERVICE). The login-page button that
// links here is likewise only rendered in dev.
//
// Pass `?as=<slug>` to sign in as a distinct local user (e.g. to exercise
// multi-user UI) — forwarded to the backend verbatim.
//
// Component-map tag: [COMP:app-web/dev-login-route].

import { NextResponse } from "next/server";
import {
  accessTokenCookie,
  refreshTokenCookie,
  userCookie,
  appendLegacyHostOnlyClears,
} from "@/lib/auth-cookies";
import { primaryAuthUrl } from "@/lib/primary-auth";

// Same resolution as the app-web OAuth callback + refresh bridges:
// server-side `API_URL`, defaulting to the local dev API.
const API_URL = process.env.API_URL ?? "http://localhost:4000";

export async function GET(request: Request) {
  // Layer 3 gate (see packages/api/src/routes/dev-auth.ts module docstring).
  // Refuse in any production build AND on any sub-app deploy where the
  // primary owns auth — mirrors the callback/refresh route guards.
  if (process.env.NODE_ENV === "production" || primaryAuthUrl() !== null) {
    return new NextResponse("Not found", { status: 404 });
  }

  const as = new URL(request.url).searchParams.get("as");
  const backendUrl = new URL(`${API_URL}/auth/dev-login`);
  if (as) backendUrl.searchParams.set("as", as);

  try {
    const backendRes = await fetch(backendUrl, { method: "POST" });
    if (!backendRes.ok) {
      console.error("[/api/auth/dev-login] backend rejected:", backendRes.status);
      return NextResponse.redirect(
        new URL("/login?error=dev_login_failed", request.url),
      );
    }

    const data = (await backendRes.json()) as {
      accessToken: string;
      refreshToken: string;
      user: {
        id: string;
        email: string | null;
        name: string | null;
      };
    };

    // Land on the app root, which resolves into the workspace picker or a
    // single-workspace redirect in src/app/page.tsx — the same destination
    // the OAuth callback uses on success.
    const response = NextResponse.redirect(new URL("/", request.url));
    response.cookies.set(accessTokenCookie(data.accessToken));
    response.cookies.set(refreshTokenCookie(data.refreshToken));
    response.cookies.set(
      userCookie(
        JSON.stringify({
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
        }),
      ),
    );
    // Mirror the OAuth callback: clear legacy host-only twins after the
    // sets (no-op in dev where COOKIE_DOMAIN is unset, but keeps this route
    // consistent with the real login path).
    appendLegacyHostOnlyClears(response);

    return response;
  } catch (err) {
    console.error("[/api/auth/dev-login] error:", err);
    return NextResponse.redirect(
      new URL("/login?error=dev_login_failed", request.url),
    );
  }
}
